import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/config';
import { haversineKm, LatLng } from './geo';

/** Measures road distance in km from several origins to one destination. null = no road route. */
export abstract class DistanceProvider {
  abstract readonly source: 'google' | 'estimate';
  abstract roadKm(origins: LatLng[], destination: LatLng): Promise<(number | null)[]>;
}

/** City roads are rarely straight: straight-line distance times this factor approximates road distance. */
export const ROAD_FACTOR = 1.35;

/**
 * Development/test only: estimates road distance from the straight-line distance.
 * Blocked in production unless ALLOW_ESTIMATED_DISTANCE=true (see config.ts).
 */
@Injectable()
export class EstimateDistanceProvider extends DistanceProvider {
  readonly source = 'estimate' as const;
  async roadKm(origins: LatLng[], destination: LatLng) {
    return origins.map((o) => Math.round(haversineKm(o, destination) * ROAD_FACTOR * 10) / 10);
  }
}

interface RouteMatrixElement {
  originIndex?: number;
  destinationIndex?: number;
  distanceMeters?: number;
  condition?: string;
}

/** Google Maps Routes API (computeRouteMatrix), driving distance. */
@Injectable()
export class GoogleDistanceProvider extends DistanceProvider {
  readonly source = 'google' as const;
  private readonly logger = new Logger('GoogleRoutes');
  constructor(private readonly config: AppConfig) {
    super();
  }

  async roadKm(origins: LatLng[], destination: LatLng) {
    const waypoint = (p: LatLng) => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });
    const res = await fetch('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Goog-Api-Key': this.config.googleMapsApiKey!,
        'X-Goog-FieldMask': 'originIndex,destinationIndex,distanceMeters,condition',
      },
      body: JSON.stringify({ origins: origins.map(waypoint), destinations: [waypoint(destination)], travelMode: 'DRIVE' }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      this.logger.error(`Routes API returned HTTP ${res.status}`);
      throw new Error('Distance service unavailable');
    }
    const elements = (await res.json()) as RouteMatrixElement[];
    const out: (number | null)[] = origins.map(() => null);
    for (const e of elements) {
      // Zero-valued fields are omitted from the JSON, so a missing index means 0.
      const i = e.originIndex ?? 0;
      if (e.condition === 'ROUTE_EXISTS' && typeof e.distanceMeters === 'number') {
        out[i] = Math.round(e.distanceMeters / 100) / 10;
      }
    }
    return out;
  }
}

export const distanceProvider = {
  provide: DistanceProvider,
  inject: [AppConfig],
  useFactory: (config: AppConfig): DistanceProvider =>
    config.distanceProvider === 'google' ? new GoogleDistanceProvider(config) : new EstimateDistanceProvider(),
};
