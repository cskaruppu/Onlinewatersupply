import * as path from 'path';

export type SmsProvider = 'console' | 'msg91';

/**
 * All runtime settings, read once from environment variables at startup.
 * The app refuses to start when a required secret is missing or too weak.
 */
export class AppConfig {
  nodeEnv!: string;
  port!: number;
  databaseUrl!: string;
  databaseSsl!: boolean;
  redisUrl!: string;
  migrationsDir!: string;

  jwtSecret!: string;
  hashKey!: string;
  dataEncryptionKey!: Buffer;

  appOrigins!: string[];
  cookieSecure!: boolean;
  trustProxy!: number;

  smsProvider!: SmsProvider;
  msg91AuthKey?: string;
  msg91TemplateId?: string;
  msg91OtpVar!: string;

  otpTtlSeconds!: number;
  otpMaxAttempts!: number;
  otpLockSeconds!: number;
  otpResendSeconds!: number;
  otpPerPhoneLimit!: number;
  otpPerPhoneWindowSeconds!: number;
  otpPerIpLimit!: number;
  otpPerIpWindowSeconds!: number;

  accessTtlSeconds!: number;
  refreshTtlDays!: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v || !v.trim()) throw new Error(`Missing required environment variable ${name}`);
  return v.trim();
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes'].includes(raw.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const c = new AppConfig();
  c.nodeEnv = env.NODE_ENV ?? 'development';
  const prod = c.nodeEnv === 'production';

  c.port = int(env, 'PORT', 3001);
  c.databaseUrl = required(env, 'DATABASE_URL');
  c.databaseSsl = bool(env, 'DATABASE_SSL', false);
  c.redisUrl = required(env, 'REDIS_URL');
  c.migrationsDir = env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), 'migrations');

  c.jwtSecret = required(env, 'JWT_SECRET');
  if (c.jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  c.hashKey = required(env, 'HASH_KEY');
  if (c.hashKey.length < 32) throw new Error('HASH_KEY must be at least 32 characters');
  if (c.hashKey === c.jwtSecret) throw new Error('HASH_KEY and JWT_SECRET must be different');
  c.dataEncryptionKey = Buffer.from(required(env, 'DATA_ENCRYPTION_KEY'), 'base64');
  if (c.dataEncryptionKey.length !== 32) {
    throw new Error('DATA_ENCRYPTION_KEY must be 32 random bytes, base64-encoded (openssl rand -base64 32)');
  }

  c.appOrigins = (env.APP_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  c.cookieSecure = bool(env, 'COOKIE_SECURE', prod);
  c.trustProxy = int(env, 'TRUST_PROXY', 1);

  const provider = (env.SMS_PROVIDER ?? 'console') as SmsProvider;
  if (!['console', 'msg91'].includes(provider)) throw new Error('SMS_PROVIDER must be console or msg91');
  c.smsProvider = provider;
  if (provider === 'console' && prod && !bool(env, 'ALLOW_CONSOLE_SMS', false)) {
    throw new Error(
      'SMS_PROVIDER=console prints OTPs to logs and is blocked in production. ' +
        'Configure msg91, or set ALLOW_CONSOLE_SMS=true for a test environment only.',
    );
  }
  if (provider === 'msg91') {
    c.msg91AuthKey = required(env, 'MSG91_AUTH_KEY');
    c.msg91TemplateId = required(env, 'MSG91_TEMPLATE_ID');
  }
  c.msg91OtpVar = env.MSG91_OTP_VAR ?? 'otp';

  c.otpTtlSeconds = int(env, 'OTP_TTL_SECONDS', 300);
  c.otpMaxAttempts = int(env, 'OTP_MAX_ATTEMPTS', 5);
  c.otpLockSeconds = int(env, 'OTP_LOCK_SECONDS', 900);
  c.otpResendSeconds = int(env, 'OTP_RESEND_SECONDS', 30);
  c.otpPerPhoneLimit = int(env, 'OTP_PER_PHONE_LIMIT', 3);
  c.otpPerPhoneWindowSeconds = int(env, 'OTP_PER_PHONE_WINDOW_SECONDS', 600);
  c.otpPerIpLimit = int(env, 'OTP_PER_IP_LIMIT', 10);
  c.otpPerIpWindowSeconds = int(env, 'OTP_PER_IP_WINDOW_SECONDS', 3600);

  c.accessTtlSeconds = int(env, 'ACCESS_TOKEN_TTL_SECONDS', 900);
  c.refreshTtlDays = int(env, 'REFRESH_TOKEN_TTL_DAYS', 30);
  return c;
}
