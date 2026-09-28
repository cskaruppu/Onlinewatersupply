import { randomBytes } from 'crypto';
import { loadConfig } from '../../src/config/config';
import { EstimateDistanceProvider, GoogleDistanceProvider, ROAD_FACTOR } from '../../src/geo/distance.service';
import { haversineKm, inServiceArea, nearestByAir } from '../../src/geo/geo';
import { computeQuote } from '../../src/pricing/pricing';

const SARAVANAMPATTI = { lat: 11.0773, lng: 76.9993 };
const GANDHIPURAM = { lat: 11.018, lng: 76.966 };

describe('geo helpers', () => {
  it('measures straight-line distance', () => {
    const km = haversineKm(SARAVANAMPATTI, GANDHIPURAM);
    expect(km).toBeGreaterThan(7);
    expect(km).toBeLessThan(8);
  });

  it('accepts Coimbatore and refuses other cities', () => {
    expect(inServiceArea(SARAVANAMPATTI)).toBe(true);
    expect(inServiceArea({ lat: 13.0827, lng: 80.2707 })).toBe(false); // Chennai
    expect(inServiceArea({ lat: 11.0168, lng: 76.9558 + 1 })).toBe(false);
  });

  it('shortlists the nearest points first', () => {
    const pts = [{ id: 'far', lat: 10.9, lng: 76.96 }, { id: 'near', lat: 11.08, lng: 77.0 }, { id: 'mid', lat: 11.02, lng: 76.97 }];
    expect(nearestByAir(SARAVANAMPATTI, pts, 2).map((p) => p.id)).toEqual(['near', 'mid']);
  });
});

describe('distance providers', () => {
  it('estimate = straight line x road factor, rounded to 0.1 km', async () => {
    const [km] = await new EstimateDistanceProvider().roadKm([GANDHIPURAM], SARAVANAMPATTI);
    expect(km).toBeCloseTo(haversineKm(GANDHIPURAM, SARAVANAMPATTI) * ROAD_FACTOR, 1);
  });

  describe('Google Routes', () => {
    const config = loadConfig({
      DATABASE_URL: 'x', REDIS_URL: 'x', JWT_SECRET: 'j'.repeat(40), HASH_KEY: 'h'.repeat(40),
      DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'), DISTANCE_PROVIDER: 'google', GOOGLE_MAPS_API_KEY: 'test-key',
    });
    const realFetch = global.fetch;
    afterEach(() => { global.fetch = realFetch; });

    it('sends a driving matrix request and reads distances, treating a missing originIndex as 0', async () => {
      let sent: { url: string; init: RequestInit } | undefined;
      global.fetch = jest.fn(async (url: string, init: RequestInit) => {
        sent = { url, init };
        return new Response(JSON.stringify([
          { destinationIndex: 0, distanceMeters: 4260, condition: 'ROUTE_EXISTS' },
          { originIndex: 1, distanceMeters: 9810, condition: 'ROUTE_EXISTS' },
          { originIndex: 2, condition: 'ROUTE_NOT_FOUND' },
        ]), { status: 200 });
      }) as unknown as typeof fetch;
      const km = await new GoogleDistanceProvider(config).roadKm([GANDHIPURAM, GANDHIPURAM, GANDHIPURAM], SARAVANAMPATTI);
      expect(km).toEqual([4.3, 9.8, null]);
      expect(sent!.url).toContain('computeRouteMatrix');
      const headers = sent!.init.headers as Record<string, string>;
      expect(headers['X-Goog-Api-Key']).toBe('test-key');
      expect(JSON.parse(sent!.init.body as string).travelMode).toBe('DRIVE');
    });

    it('fails loudly when Google refuses the request', async () => {
      global.fetch = jest.fn(async () => new Response('denied', { status: 403 })) as unknown as typeof fetch;
      await expect(new GoogleDistanceProvider(config).roadKm([GANDHIPURAM], SARAVANAMPATTI)).rejects.toThrow(/unavailable/);
    });
  });

  it('blocks estimated distances in production unless allowed', () => {
    const env = { DATABASE_URL: 'x', REDIS_URL: 'x', JWT_SECRET: 'j'.repeat(40), HASH_KEY: 'h'.repeat(40), DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'), NODE_ENV: 'production', ALLOW_CONSOLE_SMS: 'true' };
    expect(() => loadConfig(env)).toThrow(/ALLOW_ESTIMATED_DISTANCE/);
    expect(loadConfig({ ...env, ALLOW_ESTIMATED_DISTANCE: 'true' }).distanceProvider).toBe('estimate');
    expect(() => loadConfig({ ...env, DISTANCE_PROVIDER: 'google' })).toThrow(/GOOGLE_MAPS_API_KEY/);
  });
});

describe('early-morning slot', () => {
  it('adds the night charge set by the server', () => {
    const q = computeQuote(
      { capacityKl: 12, band: 'A', hillRoad: false, addOns: [], earlyMorning: true },
      [{ capacityKl: 12, band: 'A', pricePaise: 140000, capPaise: 170000 }],
      [{ code: 'night_slot', label: 'Night or early-morning delivery', pricePaise: 15000, unit: 'per_order', customerSelectable: false }],
      2900,
    );
    expect(q.totalPaise).toBe(140000 + 15000 + 2900);
  });
});
