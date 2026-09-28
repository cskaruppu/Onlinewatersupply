import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes, randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { DbService } from '../../src/db/db.service';
import { RedisService } from '../../src/redis/redis.service';
import { SmsSender } from '../../src/sms/sms.service';

const DB = process.env.TEST_DATABASE_URL;
const REDIS = process.env.TEST_REDIS_URL;
const run = DB && REDIS ? describe : describe.skip;
const ORIGIN = 'http://localhost:3000';

class CapturingSms extends SmsSender {
  sent = new Map<string, string>();
  async sendOtp(phone: string, otp: string) {
    this.sent.set(phone, otp);
  }
}

run('Addresses and booking (e2e)', () => {
  let app: NestExpressApplication;
  let sms: CapturingSms;
  let localities: { id: number; name: string; pincode: string }[];
  let n = 0;

  const loc = (name: string) => localities.find((l) => l.name === name)!;

  /** Signs in a fresh customer and returns a request helper carrying their session cookie. */
  async function customer() {
    const phone = `8${String(Date.now()).slice(-8)}${n++ % 10}`;
    const server = app.getHttpServer();
    await request(server).post('/api/v1/auth/otp/request').set('Origin', ORIGIN).send({ phone }).expect(200);
    const res = await request(server).post('/api/v1/auth/otp/verify').set('Origin', ORIGIN)
      .send({ phone, otp: sms.sent.get(`+91${phone}`) }).expect(200);
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('nn_at='))!.split(';')[0];
    return {
      get: (path: string) => request(server).get(path).set('Cookie', cookie),
      post: (path: string, body: object = {}) => request(server).post(path).set('Cookie', cookie).set('Origin', ORIGIN).send(body),
      del: (path: string) => request(server).delete(path).set('Cookie', cookie).set('Origin', ORIGIN).set('Content-Type', 'application/json'),
    };
  }

  const addressFor = (name: string, extra: object = {}) => ({
    label: 'Home', line1: '22, Kurinji Nagar, 3rd Street', localityId: loc(name).id, pincode: loc(name).pincode, ...extra,
  });

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: DB,
      REDIS_URL: REDIS,
      JWT_SECRET: randomBytes(32).toString('hex'),
      HASH_KEY: randomBytes(32).toString('hex'),
      DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      APP_ORIGINS: ORIGIN,
      SMS_PROVIDER: 'console',
      DISTANCE_PROVIDER: 'estimate',
      SEED_DEMO_DATA: 'true',
      OTP_PER_IP_LIMIT: '1000',
    });
    sms = new CapturingSms();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(SmsSender).useValue(sms).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    await app.get(RedisService).client.flushdb();
    localities = (await request(app.getHttpServer()).get('/api/v1/localities').expect(200)).body;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('lists Coimbatore localities publicly', () => {
    expect(localities.length).toBe(20);
    expect(loc('Saravanampatti')).toMatchObject({ pincode: '641035' });
  });

  it('requires sign-in for addresses and orders', async () => {
    await request(app.getHttpServer()).get('/api/v1/addresses').expect(401);
    await request(app.getHttpServer()).get('/api/v1/orders').expect(401);
  });

  it('saves an address with its zone, nearest filling point, distance and band', async () => {
    const c = await customer();
    const home = (await c.post('/api/v1/addresses', addressFor('Saravanampatti')).expect(201)).body.address;
    expect(home).toMatchObject({ band: 'A', zone: 'North-East', fillingPoint: 'Sample RO plant, Saravanampatti', serviceable: true, distanceEstimated: true, locality: 'Saravanampatti' });
    expect(home.roadKm).toBeLessThanOrEqual(5);

    const madukkarai = (await c.post('/api/v1/addresses', addressFor('Madukkarai', { label: 'Site' })).expect(201)).body.address;
    expect(madukkarai).toMatchObject({ band: 'B', zone: 'South' });

    const thondamuthur = (await c.post('/api/v1/addresses', addressFor('Thondamuthur', { label: 'Parents' })).expect(201)).body.address;
    expect(thondamuthur).toMatchObject({ band: 'C', zone: 'West' });

    const list = (await c.get('/api/v1/addresses').expect(200)).body.addresses;
    expect(list.map((a: { band: string }) => a.band)).toEqual(['A', 'B', 'C']);
  });

  it('uses the exact phone location when given, and refuses places outside Coimbatore', async () => {
    const c = await customer();
    const far = (await c.post('/api/v1/addresses', addressFor('Thondamuthur', { lat: 11.24, lng: 76.76 })).expect(201)).body.address;
    expect(far).toMatchObject({ band: null, serviceable: false });
    await c.post('/api/v1/addresses', addressFor('Gandhipuram', { lat: 13.0827, lng: 80.2707 })).expect(400);
    await c.post('/api/v1/addresses', addressFor('Gandhipuram', { lat: 11.0 })).expect(400);
    await c.post('/api/v1/addresses', { ...addressFor('Gandhipuram'), label: 'Palace' }).expect(400);
    await c.post('/api/v1/addresses', { ...addressFor('Gandhipuram'), localityId: 99999 }).expect(400);
  });

  it('stores the street address encrypted', async () => {
    const c = await customer();
    await c.post('/api/v1/addresses', addressFor('Peelamedu', { line1: 'Flat 4B, Unique Residency Street' })).expect(201);
    const { rows } = await app.get(DbService).query(`SELECT address_enc FROM customer_addresses`);
    expect(JSON.stringify(rows)).not.toContain('Unique Residency');
  });

  it('keeps addresses private to their owner', async () => {
    const alice = await customer();
    const bob = await customer();
    const a = (await alice.post('/api/v1/addresses', addressFor('Gandhipuram')).expect(201)).body.address;
    expect((await bob.get('/api/v1/addresses').expect(200)).body.addresses).toEqual([]);
    await bob.post('/api/v1/orders/quote', { addressId: a.id, capacityKl: 12, slot: 'asap' }).expect(404);
    await bob.post('/api/v1/orders', { addressId: a.id, capacityKl: 12, slot: 'asap', paymentMethod: 'cash' }).expect(404);
    await bob.del(`/api/v1/addresses/${a.id}`).expect(404);
    await alice.del(`/api/v1/addresses/${a.id}`).expect(204);
    expect((await alice.get('/api/v1/addresses').expect(200)).body.addresses).toEqual([]);
  });

  it('limits saved addresses per customer', async () => {
    const c = await customer();
    for (let i = 0; i < 5; i++) await c.post('/api/v1/addresses', addressFor('Ganapathy')).expect(201);
    await c.post('/api/v1/addresses', addressFor('Ganapathy')).expect(409);
  });

  it('quotes from the saved address band, with server-set extras', async () => {
    const c = await customer();
    const a = (await c.post('/api/v1/addresses', addressFor('Madukkarai')).expect(201)).body.address; // band B
    const base = (await c.post('/api/v1/orders/quote', { addressId: a.id, capacityKl: 12, slot: 'asap' }).expect(200)).body.quote;
    expect(base.totalPaise).toBe(155000 + 2900);

    const early = (await c.post('/api/v1/orders/quote', { addressId: a.id, capacityKl: 12, slot: 'early_morning', addOns: ['overhead_pumping'] }).expect(200)).body.quote;
    expect(early.lines.map((l: { code: string }) => l.code)).toEqual(['water', 'night_slot', 'overhead_pumping', 'platform_fee']);
    expect(early.totalPaise).toBe(155000 + 15000 + 15000 + 2900);

    await c.post('/api/v1/orders/quote', { addressId: a.id, capacityKl: 12, slot: 'asap', addOns: ['hill_road'] }).expect(400);
    await c.post('/api/v1/orders/quote', { addressId: a.id, capacityKl: 12, slot: 'asap', addOns: ['night_slot'] }).expect(400);
    await c.post('/api/v1/orders/quote', { addressId: a.id, capacityKl: 7, slot: 'asap' }).expect(400);
    await c.post('/api/v1/orders/quote', { addressId: a.id, capacityKl: 12, slot: 'asap', band: 'A' }).expect(400); // band can't be sent
  });

  it('refuses to price an address outside the delivery area', async () => {
    const c = await customer();
    const far = (await c.post('/api/v1/addresses', addressFor('Thondamuthur', { lat: 11.24, lng: 76.76 })).expect(201)).body.address;
    await c.post('/api/v1/orders/quote', { addressId: far.id, capacityKl: 12, slot: 'asap' }).expect(422);
  });

  it('books a tanker at the quoted price and freezes that price', async () => {
    const c = await customer();
    const a = (await c.post('/api/v1/addresses', addressFor('Saravanampatti')).expect(201)).body.address;
    const quote = (await c.post('/api/v1/orders/quote', { addressId: a.id, capacityKl: 6, slot: 'evening' }).expect(200)).body.quote;
    const order = (await c.post('/api/v1/orders', { addressId: a.id, capacityKl: 6, slot: 'evening', paymentMethod: 'cash' }).expect(201)).body.order;
    expect(order).toMatchObject({ status: 'requested', statusLabel: 'Finding a tanker', capacityKl: 6, band: 'A', slotLabel: 'Today, 5–7 PM', totalPaise: quote.totalPaise, cancellable: true });
    expect(order.reference).toMatch(/^NN-[2-9A-HJ-NP-Z]{6}$/);
    expect(order.address).toMatchObject({ label: 'Home', locality: 'Saravanampatti' });

    const db = app.get(DbService);
    await db.query(`UPDATE rate_card SET price_paise = price_paise + 10000 WHERE capacity_kl = 6 AND band = 'A'`);
    try {
      expect((await c.get(`/api/v1/orders/${order.id}`).expect(200)).body.order.totalPaise).toBe(quote.totalPaise);
    } finally {
      await db.query(`UPDATE rate_card SET price_paise = price_paise - 10000 WHERE capacity_kl = 6 AND band = 'A'`);
    }

    // Deleting the address later still shows it on the order.
    await c.del(`/api/v1/addresses/${a.id}`).expect(204);
    expect((await c.get(`/api/v1/orders/${order.id}`).expect(200)).body.order.address.locality).toBe('Saravanampatti');
  });

  it('accepts cash only until UPI is added', async () => {
    const c = await customer();
    const a = (await c.post('/api/v1/addresses', addressFor('Saravanampatti')).expect(201)).body.address;
    const res = await c.post('/api/v1/orders', { addressId: a.id, capacityKl: 12, slot: 'asap', paymentMethod: 'upi' }).expect(400);
    expect(res.body.message).toMatch(/UPI payment is coming soon/);
  });

  it('never books twice for a double tap (same Idempotency-Key), even in parallel', async () => {
    const c = await customer();
    const a = (await c.post('/api/v1/addresses', addressFor('Saravanampatti')).expect(201)).body.address;
    const key = randomUUID();
    const body = { addressId: a.id, capacityKl: 12, slot: 'asap', paymentMethod: 'cash' };
    const results = await Promise.all([1, 2, 3].map(() => c.post('/api/v1/orders', body).set('Idempotency-Key', key)));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(new Set(results.map((r) => r.body.order.id)).size).toBe(1);
    expect((await c.get('/api/v1/orders').expect(200)).body.orders).toHaveLength(1);
  });

  it('limits open orders and lets the customer cancel before a tanker is assigned', async () => {
    const c = await customer();
    const a = (await c.post('/api/v1/addresses', addressFor('Saravanampatti')).expect(201)).body.address;
    const body = { addressId: a.id, capacityKl: 3, slot: 'asap', paymentMethod: 'cash' };
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await c.post('/api/v1/orders', body).expect(201)).body.order.id);
    await c.post('/api/v1/orders', body).expect(409);

    const cancelled = (await c.post(`/api/v1/orders/${ids[0]}/cancel`).expect(200)).body.order;
    expect(cancelled).toMatchObject({ status: 'cancelled', cancellable: false });
    await c.post(`/api/v1/orders/${ids[0]}/cancel`).expect(409);
    await c.post('/api/v1/orders', body).expect(201);

    const other = await customer();
    await other.post(`/api/v1/orders/${ids[1]}/cancel`).expect(404);
    await other.get(`/api/v1/orders/${ids[1]}`).expect(404);
  });
});
