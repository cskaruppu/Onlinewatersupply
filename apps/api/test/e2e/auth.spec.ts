import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'crypto';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { DbService } from '../../src/db/db.service';
import { RedisService } from '../../src/redis/redis.service';
import { SmsSender } from '../../src/sms/sms.service';
import { OtpService } from '../../src/auth/otp.service';

/**
 * End-to-end tests against real PostgreSQL and Redis.
 * Set TEST_DATABASE_URL and TEST_REDIS_URL (see README), otherwise these tests are skipped.
 */
const DB = process.env.TEST_DATABASE_URL;
const REDIS = process.env.TEST_REDIS_URL;
const run = DB && REDIS ? describe : describe.skip;
const ORIGIN = 'http://localhost:3000';

class CapturingSms extends SmsSender {
  sent = new Map<string, string>();
  fail = false;
  async sendOtp(phone: string, otp: string) {
    if (this.fail) throw new Error('provider down');
    this.sent.set(phone, otp);
  }
}

/** Parses Set-Cookie headers into a name -> full cookie string map. */
function cookies(res: request.Response): Record<string, string> {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const out: Record<string, string> = {};
  for (const c of raw ?? []) out[c.split('=')[0]] = c;
  return out;
}
const value = (cookie: string) => cookie.split(';')[0];

run('OTP login (e2e)', () => {
  let app: NestExpressApplication;
  let sms: CapturingSms;
  let counter = 0;
  // A fresh valid number per test keeps rate limits independent.
  const newPhone = () => `9${String(Date.now() % 1e8).padStart(8, '0')}${counter++ % 10}`;
  const e164 = (p: string) => `+91${p}`;
  const post = (path: string) => request(app.getHttpServer()).post(path).set('Origin', ORIGIN).set('Content-Type', 'application/json');

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
      OTP_PER_IP_LIMIT: '1000',
    });
    sms = new CapturingSms();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SmsSender)
      .useValue(sms)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    await app.get(RedisService).client.flushdb();
  });

  afterAll(async () => {
    await app?.close();
  });

  async function login(phone: string) {
    await post('/api/v1/auth/otp/request').send({ phone }).expect(200);
    const res = await post('/api/v1/auth/otp/verify').send({ phone, otp: sms.sent.get(e164(phone)) }).expect(200);
    return cookies(res);
  }

  it('health endpoints respond', async () => {
    await request(app.getHttpServer()).get('/healthz').expect(200, { status: 'ok' });
    await request(app.getHttpServer()).get('/readyz').expect(200, { status: 'ready' });
  });

  it('signs in with the correct code and returns the masked profile', async () => {
    const phone = newPhone();
    const req = await post('/api/v1/auth/otp/request').send({ phone }).expect(200);
    expect(req.body).toMatchObject({ message: 'OTP sent', expiresIn: 300, resendAfter: 30 });
    expect(req.body.phoneMasked).toMatch(/^\+91 \d{2}••• ••\d{3}$/);

    const res = await post('/api/v1/auth/otp/verify').send({ phone, otp: sms.sent.get(e164(phone)) }).expect(200);
    expect(res.body.user).toMatchObject({ role: 'customer', phoneMasked: req.body.phoneMasked });

    const c = cookies(res);
    expect(c.nn_at).toMatch(/HttpOnly/);
    expect(c.nn_at).toMatch(/SameSite=Strict/);
    expect(c.nn_rt).toMatch(/Path=\/api\/v1\/auth/);

    const me = await request(app.getHttpServer()).get('/api/v1/me').set('Cookie', value(c.nn_at)).expect(200);
    expect(me.body.user.id).toBe(res.body.user.id);
  });

  it('stores the phone number encrypted and the OTP only as a hash', async () => {
    const phone = newPhone();
    await post('/api/v1/auth/otp/request').send({ phone }).expect(200);
    const redisDump = JSON.stringify(await app.get(RedisService).client.keys('*'));
    expect(redisDump).not.toContain(phone);
    const keys = await app.get(RedisService).client.keys('otp:*');
    for (const k of keys.filter((k) => !k.includes(':lock:') && !k.includes(':cd:'))) {
      const h = await app.get(RedisService).client.hgetall(k);
      expect(Object.values(h)).not.toContain(sms.sent.get(e164(phone)));
    }
    await post('/api/v1/auth/otp/verify').send({ phone, otp: sms.sent.get(e164(phone)) }).expect(200);
    const { rows } = await app.get(DbService).query(`SELECT * FROM users WHERE phone_last4 = $1`, [phone.slice(-4)]);
    expect(JSON.stringify(rows)).not.toContain(phone);
  });

  it('rejects invalid phone numbers and malformed codes', async () => {
    await post('/api/v1/auth/otp/request').send({ phone: '12345' }).expect(400);
    await post('/api/v1/auth/otp/request').send({ phone: '5876543210' }).expect(400);
    await post('/api/v1/auth/otp/verify').send({ phone: newPhone(), otp: '12ab' }).expect(400);
    await post('/api/v1/auth/otp/request').send({ phone: newPhone(), admin: true }).expect(400);
  });

  it('counts wrong codes and locks the number after 5', async () => {
    const phone = newPhone();
    await post('/api/v1/auth/otp/request').send({ phone }).expect(200);
    const right = sms.sent.get(e164(phone))!;
    const wrong = right === '000000' ? '111111' : '000000';
    for (let left = 4; left >= 1; left--) {
      const r = await post('/api/v1/auth/otp/verify').send({ phone, otp: wrong }).expect(400);
      expect(r.body.attemptsLeft).toBe(left);
    }
    await post('/api/v1/auth/otp/verify').send({ phone, otp: wrong }).expect(429);
    // Even the right code is refused while locked, and so are new requests.
    await post('/api/v1/auth/otp/verify').send({ phone, otp: right }).expect(429);
    await post('/api/v1/auth/otp/request').send({ phone }).expect(429);
  });

  it('accepts a code only once', async () => {
    const phone = newPhone();
    await post('/api/v1/auth/otp/request').send({ phone }).expect(200);
    const otp = sms.sent.get(e164(phone));
    await post('/api/v1/auth/otp/verify').send({ phone, otp }).expect(200);
    await post('/api/v1/auth/otp/verify').send({ phone, otp }).expect(400);
  });

  it('enforces the resend wait and the per-number limit', async () => {
    const phone = newPhone();
    await post('/api/v1/auth/otp/request').send({ phone }).expect(200);
    const tooSoon = await post('/api/v1/auth/otp/request').send({ phone }).expect(429);
    expect(tooSoon.body.message).toMatch(/wait/);

    const redis = app.get(RedisService).client;
    const idx = app.get(OtpService).phoneIndex(e164(phone));
    // Skip the 30 s wait twice to reach the 3-per-10-minutes limit.
    for (let i = 0; i < 2; i++) {
      await redis.del(`otp:cd:${idx}`);
      await post('/api/v1/auth/otp/request').send({ phone }).expect(200);
    }
    await redis.del(`otp:cd:${idx}`);
    const limited = await post('/api/v1/auth/otp/request').send({ phone }).expect(429);
    expect(limited.body.message).toMatch(/Too many codes requested for this number/);
    await redis.flushdb();
  });

  it('does not keep a code when the SMS could not be sent', async () => {
    const phone = newPhone();
    sms.fail = true;
    await post('/api/v1/auth/otp/request').send({ phone }).expect(503);
    sms.fail = false;
    await post('/api/v1/auth/otp/request').send({ phone }).expect(200);
  });

  it('rotates refresh tokens and ends the session when an old token is reused', async () => {
    const c = await login(newPhone());
    const first = value(c.nn_rt);

    const r1 = await post('/api/v1/auth/refresh').set('Cookie', first).send({}).expect(200);
    const second = value(cookies(r1).nn_rt);
    expect(second).not.toBe(first);

    // Replaying the first token is treated as theft: the whole session is revoked.
    await post('/api/v1/auth/refresh').set('Cookie', first).send({}).expect(401);
    await post('/api/v1/auth/refresh').set('Cookie', second).send({}).expect(401);

    const { rows } = await app.get(DbService).query(`SELECT count(*)::int AS n FROM auth_events WHERE event = 'refresh_reuse_detected'`);
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it('logs out and refuses the old refresh token', async () => {
    const c = await login(newPhone());
    const res = await post('/api/v1/auth/logout').set('Cookie', value(c.nn_rt)).send({}).expect(204);
    expect(cookies(res).nn_at).toMatch(/Expires=Thu, 01 Jan 1970/);
    await post('/api/v1/auth/refresh').set('Cookie', value(c.nn_rt)).send({}).expect(401);
  });

  it('requires a valid session for /me', async () => {
    await request(app.getHttpServer()).get('/api/v1/me').expect(401);
    await request(app.getHttpServer()).get('/api/v1/me').set('Cookie', 'nn_at=forged.token.value').expect(401);
    await request(app.getHttpServer()).get('/api/v1/me').set('Authorization', 'Bearer nope').expect(401);
  });

  it('blocks cross-site and non-JSON requests', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/otp/request')
      .set('Origin', 'https://evil.example')
      .set('Content-Type', 'application/json')
      .send({ phone: newPhone() })
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/auth/otp/request')
      .set('Origin', ORIGIN)
      .type('form')
      .send('phone=9876543210')
      .expect(415);
  });

  it('writes an audit trail without raw phone numbers', async () => {
    const phone = newPhone();
    await login(phone);
    const { rows } = await app.get(DbService).query(`SELECT * FROM auth_events ORDER BY id DESC LIMIT 20`);
    const events = rows.map((r) => r.event);
    expect(events).toEqual(expect.arrayContaining(['otp_requested', 'login_success']));
    expect(JSON.stringify(rows)).not.toContain(phone);
  });

  it('sends security headers', async () => {
    const res = await request(app.getHttpServer()).get('/healthz');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
