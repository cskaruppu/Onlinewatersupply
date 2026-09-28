import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'crypto';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { DbService } from '../../src/db/db.service';
import { PricingService } from '../../src/pricing/pricing.service';

const DB = process.env.TEST_DATABASE_URL;
const REDIS = process.env.TEST_REDIS_URL;
const run = DB && REDIS ? describe : describe.skip;

run('Pricing (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: DB,
      REDIS_URL: REDIS,
      JWT_SECRET: randomBytes(32).toString('hex'),
      HASH_KEY: randomBytes(32).toString('hex'),
      DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      SMS_PROVIDER: 'console',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('publishes the band rate card without any per-km charge', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/pricing/rate-card').expect(200);
    const card = res.body;
    expect(card.bands.map((b: { code: string }) => b.code)).toEqual(['A', 'B', 'C']);
    expect(card.capacities.map((c: { capacityKl: number }) => c.capacityKl)).toEqual([3, 6, 9, 12, 24]);
    expect(card.capacities.find((c: { capacityKl: number }) => c.capacityKl === 12).prices).toEqual({ A: 140000, B: 155000, C: 175000 });
    expect(card.platformFeePaise).toBe(2900);
    expect(JSON.stringify(card)).not.toMatch(/perKm|per_km/i);
  });

  it('seeds a sensible rate card: every capacity has all bands, and farther bands cost more', async () => {
    const rates = await app.get(PricingService).rates();
    for (const kl of [3, 6, 9, 12, 24]) {
      const [a, b, c] = ['A', 'B', 'C'].map((band) => rates.find((r) => r.capacityKl === kl && r.band === band)!);
      expect(a.pricePaise).toBeLessThan(b.pricePaise);
      expect(b.pricePaise).toBeLessThan(c.pricePaise);
      for (const r of [a, b, c]) expect(r.pricePaise).toBeLessThanOrEqual(r.capPaise);
    }
  });

  it('finds the band for a saved address distance', async () => {
    const pricing = app.get(PricingService);
    expect(await pricing.bandFor(3.4)).toBe('A');
    expect(await pricing.bandFor(7.2)).toBe('B');
    expect(await pricing.bandFor(11.8)).toBe('C');
    expect(await pricing.bandFor(22)).toBeNull();
  });

  it('quotes an order from the database rate card', async () => {
    const q = await app.get(PricingService).quote({ capacityKl: 12, band: 'C', hillRoad: true, addOns: ['overhead_pumping'] });
    expect(q.totalPaise).toBe(175000 + 20000 + 15000 + 2900);
    await expect(app.get(PricingService).quote({ capacityKl: 12, band: 'A', hillRoad: false, addOns: ['hill_road'] })).rejects.toThrow(/set by NeerNow/);
  });

  it('the database refuses a price above its cap or an unknown band', async () => {
    const db = app.get(DbService);
    await expect(db.query(`UPDATE rate_card SET price_paise = cap_paise + 1 WHERE capacity_kl = 12 AND band = 'A'`)).rejects.toThrow(/check constraint/);
    await expect(db.query(`INSERT INTO rate_card (capacity_kl, band, price_paise, cap_paise) VALUES (15, 'Z', 1, 1)`)).rejects.toThrow(/foreign key/);
  });
});
