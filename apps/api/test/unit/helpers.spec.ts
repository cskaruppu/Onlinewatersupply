import { randomBytes } from 'crypto';
import { CryptoService } from '../../src/common/crypto.service';
import { maskPhone, normalizeIndianMobile } from '../../src/common/phone';
import { loadConfig } from '../../src/config/config';

const baseEnv = {
  DATABASE_URL: 'postgres://x',
  REDIS_URL: 'redis://x',
  JWT_SECRET: 'j'.repeat(40),
  HASH_KEY: 'h'.repeat(40),
  DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
};

describe('normalizeIndianMobile', () => {
  it.each([
    ['9876543210', '+919876543210'],
    ['98765 43210', '+919876543210'],
    ['+91-98765-43210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['6000000000', '+916000000000'],
  ])('accepts %s', (input, expected) => {
    expect(normalizeIndianMobile(input)).toBe(expected);
  });

  it.each(['5876543210', '987654321', '98765432101', '+14155550100', 'abcdefghij', ''])('rejects %s', (input) => {
    expect(normalizeIndianMobile(input)).toBeNull();
  });
});

describe('maskPhone', () => {
  it('hides the middle digits', () => {
    expect(maskPhone('+919876543210')).toBe('+91 98••• ••210');
  });
});

describe('CryptoService', () => {
  const crypto = new CryptoService(loadConfig(baseEnv));

  it('encrypts and decrypts, with a new IV every time', () => {
    const a = crypto.encrypt('+919876543210');
    const b = crypto.encrypt('+919876543210');
    expect(a).not.toBe(b);
    expect(a).not.toContain('9876543210');
    expect(crypto.decrypt(a)).toBe('+919876543210');
  });

  it('rejects tampered ciphertext', () => {
    const enc = crypto.encrypt('+919876543210');
    const buf = Buffer.from(enc.slice(3), 'base64');
    buf[buf.length - 1] ^= 1;
    expect(() => crypto.decrypt('v1:' + buf.toString('base64'))).toThrow();
  });

  it('keyed hashes differ by purpose', () => {
    expect(crypto.keyedHash('phone', 'x')).not.toBe(crypto.keyedHash('otp', 'x'));
    expect(crypto.keyedHash('phone', 'x')).toBe(crypto.keyedHash('phone', 'x'));
  });

  it('compares hashes safely', () => {
    const h = crypto.sha256('a');
    expect(crypto.safeEqualHex(h, crypto.sha256('a'))).toBe(true);
    expect(crypto.safeEqualHex(h, crypto.sha256('b'))).toBe(false);
    expect(crypto.safeEqualHex(h, 'abcd')).toBe(false);
  });

  it('generates 6-digit codes', () => {
    for (let i = 0; i < 200; i++) expect(crypto.otp()).toMatch(/^\d{6}$/);
  });
});

describe('loadConfig', () => {
  it('refuses weak or missing secrets', () => {
    expect(() => loadConfig({ ...baseEnv, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...baseEnv, HASH_KEY: baseEnv.JWT_SECRET })).toThrow(/different/);
    expect(() => loadConfig({ ...baseEnv, DATA_ENCRYPTION_KEY: 'abc' })).toThrow(/DATA_ENCRYPTION_KEY/);
    const { DATABASE_URL, ...noDb } = baseEnv;
    expect(() => loadConfig(noDb)).toThrow(/DATABASE_URL/);
  });

  it('blocks console SMS in production unless explicitly allowed', () => {
    expect(() => loadConfig({ ...baseEnv, NODE_ENV: 'production' })).toThrow(/blocked in production/);
    expect(loadConfig({ ...baseEnv, NODE_ENV: 'production', ALLOW_CONSOLE_SMS: 'true' }).smsProvider).toBe('console');
  });

  it('requires MSG91 credentials when MSG91 is selected', () => {
    expect(() => loadConfig({ ...baseEnv, SMS_PROVIDER: 'msg91' })).toThrow(/MSG91_AUTH_KEY/);
  });

  it('uses secure cookies in production by default', () => {
    expect(loadConfig({ ...baseEnv, NODE_ENV: 'production', ALLOW_CONSOLE_SMS: 'true' }).cookieSecure).toBe(true);
    expect(loadConfig(baseEnv).cookieSecure).toBe(false);
  });
});
