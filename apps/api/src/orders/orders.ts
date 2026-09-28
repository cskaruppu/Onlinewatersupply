import {
  BadRequestException, Body, ConflictException, Controller, Get, Headers, HttpCode, Injectable, NotFoundException,
  Param, ParseUUIDPipe, Post, UnprocessableEntityException, UseGuards,
} from '@nestjs/common';
import { randomInt } from 'crypto';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID } from 'class-validator';
import { AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { AccessClaims } from '../auth/tokens.service';
import { CurrentAuth, SessionGuard } from '../auth/auth.guard';
import { PricingService } from '../pricing/pricing.service';
import { Quote, QuoteLine } from '../pricing/pricing';
import { AddressesService } from '../addresses/addresses';

export const SLOTS = {
  asap: 'As soon as possible',
  evening: 'Today, 5–7 PM',
  early_morning: 'Tomorrow, 6–8 AM',
} as const;
export type Slot = keyof typeof SLOTS;

const ACTIVE = ['requested', 'accepted', 'on_the_way'];
const STATUS_LABEL: Record<string, string> = {
  requested: 'Finding a tanker',
  accepted: 'Tanker assigned',
  on_the_way: 'On the way',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

export class QuoteDto {
  @IsUUID()
  addressId!: string;

  @IsInt()
  capacityKl!: number;

  @IsIn(Object.keys(SLOTS))
  slot!: Slot;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  addOns?: string[];
}

export class CreateOrderDto extends QuoteDto {
  @IsIn(['cash', 'upi'])
  paymentMethod!: 'cash' | 'upi';
}

interface OrderRow {
  id: string;
  reference: string;
  capacity_kl: number;
  band: string;
  slot: Slot;
  payment_method: string;
  add_ons: string[];
  price_lines: QuoteLine[];
  total_paise: number;
  status: string;
  created_at: Date;
  address_id: string;
}

/** Reference customers can read out on the phone, e.g. NN-7K4Q2P (no 0/O or 1/I). */
function newReference() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = 'NN-';
  for (let i = 0; i < 6; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly db: DbService,
    private readonly pricing: PricingService,
    private readonly addresses: AddressesService,
    private readonly config: AppConfig,
  ) {}

  /** Prices an order from the customer's saved address. Band and hill road come from the database only. */
  async quote(userId: string, dto: QuoteDto): Promise<Quote> {
    const address = await this.addresses.getOwn(userId, dto.addressId);
    if (!address.band) {
      throw new UnprocessableEntityException('This address is outside our delivery area for now. Our team can quote it: call support.');
    }
    return this.pricing.quote({
      capacityKl: dto.capacityKl,
      band: address.band,
      hillRoad: address.hillRoad,
      earlyMorning: dto.slot === 'early_morning',
      addOns: dto.addOns ?? [],
    });
  }

  async create(userId: string, dto: CreateOrderDto, idempotencyKey?: string) {
    if (dto.paymentMethod === 'upi') {
      throw new BadRequestException('UPI payment is coming soon. Please choose cash on delivery for now.');
    }
    if (idempotencyKey !== undefined && !/^[A-Za-z0-9-]{8,64}$/.test(idempotencyKey)) {
      throw new BadRequestException('Invalid Idempotency-Key header.');
    }
    const quote = await this.quote(userId, dto);

    const id = await this.db.transaction(async (client) => {
      // One booking at a time per customer, so double taps and parallel requests can't slip past the limits.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`orders:${userId}`]);
      if (idempotencyKey) {
        const existing = await client.query<{ id: string }>('SELECT id FROM orders WHERE user_id = $1 AND idempotency_key = $2', [userId, idempotencyKey]);
        if (existing.rows[0]) return existing.rows[0].id;
      }
      const active = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM orders WHERE user_id = $1 AND status = ANY($2)',
        [userId, ACTIVE],
      );
      if (active.rows[0].n >= this.config.maxActiveOrdersPerUser) {
        throw new ConflictException(`You already have ${active.rows[0].n} open orders. Wait for one to be delivered or cancel one first.`);
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        const res = await client.query<{ id: string }>(
          `INSERT INTO orders (reference, user_id, address_id, capacity_kl, band, slot, payment_method, add_ons, price_lines, total_paise, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (reference) DO NOTHING RETURNING id`,
          [newReference(), userId, dto.addressId, dto.capacityKl, quote.band, dto.slot, dto.paymentMethod,
            [...new Set(dto.addOns ?? [])], JSON.stringify(quote.lines), quote.totalPaise, idempotencyKey ?? null],
        );
        if (res.rows[0]) return res.rows[0].id;
      }
      throw new Error('Could not allocate an order reference');
    });
    return this.getOwn(userId, id);
  }

  private async toPublic(userId: string, r: OrderRow) {
    const address = await this.addresses.getOwn(userId, r.address_id, true).then((a) => a.public).catch(() => null);
    return {
      id: r.id,
      reference: r.reference,
      status: r.status,
      statusLabel: STATUS_LABEL[r.status],
      capacityKl: r.capacity_kl,
      band: r.band,
      slot: r.slot,
      slotLabel: SLOTS[r.slot],
      paymentMethod: r.payment_method,
      address: address && { label: address.label, line1: address.line1, locality: address.locality },
      lines: r.price_lines,
      totalPaise: r.total_paise,
      createdAt: r.created_at.toISOString(),
      cancellable: r.status === 'requested',
    };
  }

  async getOwn(userId: string, id: string) {
    const { rows } = await this.db.query<OrderRow>('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!rows[0]) throw new NotFoundException('Order not found.');
    return this.toPublic(userId, rows[0]);
  }

  async list(userId: string) {
    const { rows } = await this.db.query<OrderRow>(
      'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
      [userId],
    );
    return Promise.all(rows.map((r) => this.toPublic(userId, r)));
  }

  /** Customers can cancel free of charge until an owner accepts the order. */
  async cancel(userId: string, id: string) {
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE orders SET status = 'cancelled', cancelled_at = now()
       WHERE id = $1 AND user_id = $2 AND status = 'requested' RETURNING id`,
      [id, userId],
    );
    if (!rows[0]) {
      await this.getOwn(userId, id); // 404 if it isn't theirs
      throw new ConflictException('This order can no longer be cancelled here. Please call support.');
    }
    return this.getOwn(userId, id);
  }
}

@Controller('orders')
@UseGuards(SessionGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post('quote')
  @HttpCode(200)
  async quote(@CurrentAuth() auth: AccessClaims, @Body() dto: QuoteDto) {
    return { quote: await this.orders.quote(auth.sub, dto) };
  }

  @Post()
  async create(
    @CurrentAuth() auth: AccessClaims,
    @Body() dto: CreateOrderDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return { order: await this.orders.create(auth.sub, dto, idempotencyKey) };
  }

  @Get()
  async list(@CurrentAuth() auth: AccessClaims) {
    return { orders: await this.orders.list(auth.sub) };
  }

  @Get(':id')
  async get(@CurrentAuth() auth: AccessClaims, @Param('id', new ParseUUIDPipe()) id: string) {
    return { order: await this.orders.getOwn(auth.sub, id) };
  }

  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(@CurrentAuth() auth: AccessClaims, @Param('id', new ParseUUIDPipe()) id: string) {
    return { order: await this.orders.cancel(auth.sub, id) };
  }
}
