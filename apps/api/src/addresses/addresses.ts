import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Injectable, Logger,
  NotFoundException, Param, ParseUUIDPipe, Post, ServiceUnavailableException, UseGuards,
} from '@nestjs/common';
import { HttpException, HttpStatus } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import { AppConfig } from '../config/config';
import { CryptoService } from '../common/crypto.service';
import { DbService } from '../db/db.service';
import { AccessClaims } from '../auth/tokens.service';
import { CurrentAuth, SessionGuard } from '../auth/auth.guard';
import { PricingService } from '../pricing/pricing.service';
import { BandCode } from '../pricing/pricing';
import { DistanceProvider } from '../geo/distance.service';
import { inServiceArea, LatLng, nearestByAir } from '../geo/geo';

export const ADDRESS_LABELS = ['Home', 'Work', 'Site', 'Parents', 'Other'] as const;

export class CreateAddressDto {
  @IsIn(ADDRESS_LABELS as unknown as string[], { message: 'Choose a label: Home, Work, Site, Parents or Other.' })
  label!: string;

  @IsString()
  @Length(5, 120, { message: 'Enter the house or flat number and street (5 to 120 characters).' })
  line1!: string;

  @IsOptional()
  @IsString()
  @Length(0, 80)
  landmark?: string;

  @Type(() => Number)
  @IsInt({ message: 'Choose your area.' })
  localityId!: number;

  @Matches(/^6\d{5}$/, { message: 'Enter a 6-digit pincode.' })
  pincode!: string;

  /** Exact position from the phone's location. Optional; the area's centre is used otherwise. */
  @IsOptional() @IsNumber() @Min(-90) @Max(90)
  lat?: number;

  @IsOptional() @IsNumber() @Min(-180) @Max(180)
  lng?: number;
}

interface AddressRow {
  id: string;
  user_id: string;
  label: string;
  address_enc: string;
  road_km: string | null;
  band: BandCode | null;
  hill_road: boolean;
  distance_source: 'google' | 'estimate' | null;
  locality_name: string | null;
  zone_name: string | null;
  filling_point_name: string | null;
  band_label: string | null;
}

export interface SavedAddress {
  id: string;
  userId: string;
  band: BandCode | null;
  hillRoad: boolean;
}

@Injectable()
export class AddressesService {
  private readonly logger = new Logger(AddressesService.name);

  constructor(
    private readonly db: DbService,
    private readonly crypto: CryptoService,
    private readonly pricing: PricingService,
    private readonly distance: DistanceProvider,
    private readonly config: AppConfig,
    private readonly redis: RedisService,
  ) {}

  async localities() {
    const { rows } = await this.db.query<{ id: number; name: string; pincode: string; zone: string }>(
      `SELECT l.id, l.name, l.pincode, z.name AS zone FROM localities l JOIN zones z ON z.id = l.zone_id ORDER BY l.name`,
    );
    return rows;
  }

  private toPublic(r: AddressRow) {
    const a = JSON.parse(this.crypto.decrypt(r.address_enc)) as { line1: string; landmark?: string; pincode: string };
    return {
      id: r.id,
      label: r.label,
      line1: a.line1,
      landmark: a.landmark ?? null,
      locality: r.locality_name,
      pincode: a.pincode,
      zone: r.zone_name,
      band: r.band,
      bandLabel: r.band_label,
      roadKm: r.road_km === null ? null : Number(r.road_km),
      fillingPoint: r.filling_point_name,
      hillRoad: r.hill_road,
      serviceable: r.band !== null,
      distanceEstimated: r.distance_source === 'estimate',
    };
  }

  private readonly SELECT = `
    SELECT a.id, a.user_id, a.label, a.address_enc, a.road_km, a.band, a.hill_road, a.distance_source,
           l.name AS locality_name, z.name AS zone_name, f.name AS filling_point_name, b.label AS band_label
    FROM customer_addresses a
    LEFT JOIN localities l ON l.id = a.locality_id
    LEFT JOIN zones z ON z.id = a.zone_id
    LEFT JOIN filling_points f ON f.id = a.filling_point_id
    LEFT JOIN price_bands b ON b.code = a.band`;

  async list(userId: string) {
    const { rows } = await this.db.query<AddressRow>(
      `${this.SELECT} WHERE a.user_id = $1 AND a.deleted_at IS NULL ORDER BY a.created_at`,
      [userId],
    );
    return rows.map((r) => this.toPublic(r));
  }

  /** Loads one of the user's own addresses; anyone else's address is reported as not found. */
  async getOwn(userId: string, id: string, includeDeleted = false): Promise<SavedAddress & { public: ReturnType<AddressesService['toPublic']> }> {
    const { rows } = await this.db.query<AddressRow>(
      `${this.SELECT} WHERE a.id = $1 AND a.user_id = $2 ${includeDeleted ? '' : 'AND a.deleted_at IS NULL'}`,
      [id, userId],
    );
    const r = rows[0];
    if (!r) throw new NotFoundException('Address not found.');
    return { id: r.id, userId, band: r.band, hillRoad: r.hill_road, public: this.toPublic(r) };
  }

  async create(userId: string, dto: CreateAddressDto) {
    const { rows: countRows } = await this.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM customer_addresses WHERE user_id = $1 AND deleted_at IS NULL',
      [userId],
    );
    if (countRows[0].n >= this.config.maxAddressesPerUser) {
      throw new ConflictException(`You can save up to ${this.config.maxAddressesPerUser} addresses. Remove one to add another.`);
    }

    const { rows: locRows } = await this.db.query<{ id: number; name: string; lat: string; lng: string }>(
      'SELECT id, name, lat, lng FROM localities WHERE id = $1',
      [dto.localityId],
    );
    const locality = locRows[0];
    if (!locality) throw new BadRequestException('Choose your area from the list.');
    // Every check calls the paid maps service, so limit checks per customer (not per IP: flats share networks).
    const key = `rl:addr:${userId}`;
    const used = await this.redis.client.incr(key);
    if (used === 1) await this.redis.client.expire(key, 3600);
    if (used > this.config.addressChecksPerHour) {
      throw new HttpException({ statusCode: 429, message: 'Too many address checks. Please try again in an hour.' }, HttpStatus.TOO_MANY_REQUESTS);
    }

    if ((dto.lat === undefined) !== (dto.lng === undefined)) throw new BadRequestException('Send both latitude and longitude, or neither.');
    const point: LatLng = dto.lat !== undefined ? { lat: dto.lat, lng: dto.lng! } : { lat: Number(locality.lat), lng: Number(locality.lng) };
    if (!inServiceArea(point)) {
      throw new BadRequestException('This location is outside Coimbatore. NeerNow delivers only within the city for now.');
    }

    // Nearest filling point by road: shortlist 3 by straight line, then ask for road distances in one call.
    const { rows: points } = await this.db.query<{ id: number; zone_id: number; lat: string; lng: string }>(
      'SELECT id, zone_id, lat, lng FROM filling_points WHERE is_active',
    );
    if (!points.length) {
      this.logger.error('No active filling points configured; cannot price addresses.');
      throw new ServiceUnavailableException('We cannot check addresses right now. Please try again later.');
    }
    const shortlist = nearestByAir(point, points.map((p) => ({ ...p, lat: Number(p.lat), lng: Number(p.lng) })), 3);
    let distances: (number | null)[];
    try {
      distances = await this.distance.roadKm(shortlist, point);
    } catch (err) {
      this.logger.error(`Distance lookup failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException('We could not check the distance to this address. Please try again in a minute.');
    }
    let best = -1;
    distances.forEach((km, i) => {
      if (km !== null && (best < 0 || km < distances[best]!)) best = i;
    });
    const roadKm = best >= 0 ? distances[best]! : null;
    const band = roadKm === null ? null : await this.pricing.bandFor(roadKm);
    const nearest = best >= 0 ? shortlist[best] : null;

    const addressEnc = this.crypto.encrypt(
      JSON.stringify({ line1: dto.line1.trim(), landmark: dto.landmark?.trim() || undefined, pincode: dto.pincode }),
    );
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO customer_addresses
         (user_id, label, address_enc, lat, lng, locality_id, zone_id, filling_point_id, road_km, band, distance_source, distance_checked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now()) RETURNING id`,
      [userId, dto.label, addressEnc, point.lat, point.lng, locality.id, nearest?.zone_id ?? null, nearest?.id ?? null, roadKm, band, this.distance.source],
    );
    return (await this.getOwn(userId, rows[0].id)).public;
  }

  async remove(userId: string, id: string) {
    const { rowCount } = await this.db.query(
      'UPDATE customer_addresses SET deleted_at = now() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
      [id, userId],
    );
    if (!rowCount) throw new NotFoundException('Address not found.');
  }
}

@Controller('localities')
export class LocalitiesController {
  constructor(private readonly addresses: AddressesService) {}

  @Get()
  list() {
    return this.addresses.localities();
  }
}

@Controller('addresses')
@UseGuards(SessionGuard)
export class AddressesController {
  constructor(private readonly addresses: AddressesService) {}

  @Get()
  async list(@CurrentAuth() auth: AccessClaims) {
    return { addresses: await this.addresses.list(auth.sub) };
  }

  @Post()
  async create(@CurrentAuth() auth: AccessClaims, @Body() dto: CreateAddressDto) {
    return { address: await this.addresses.create(auth.sub, dto) };
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentAuth() auth: AccessClaims, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.addresses.remove(auth.sub, id);
  }
}
