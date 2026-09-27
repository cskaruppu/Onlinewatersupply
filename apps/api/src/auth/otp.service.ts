import { BadRequestException, HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { AppConfig } from '../config/config';
import { CryptoService } from '../common/crypto.service';
import { RedisService } from '../redis/redis.service';
import { SmsSender } from '../sms/sms.service';

/** Deletes the OTP only if it still holds the hash we matched, so a code can be used once. */
const COMPARE_AND_DELETE = `
if redis.call('HGET', KEYS[1], 'h') == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

/** Counts a wrong attempt without recreating an OTP that has already expired. */
const INCR_ATTEMPTS_IF_EXISTS = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return redis.call('HINCRBY', KEYS[1], 'a', 1)
end
return -1`;

export class TooManyRequests extends HttpException {
  constructor(message: string, retryAfterSeconds: number) {
    super({ statusCode: 429, message, retryAfter: retryAfterSeconds }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

/**
 * Issues and checks one-time login codes.
 *
 * Stored in Redis (never in plain text):
 *   otp:{phoneIdx}         hash { h: HMAC(phone:code), a: wrong attempts }, expires after OTP_TTL_SECONDS
 *   otp:lock:{phoneIdx}    set after too many wrong codes
 *   otp:cd:{phoneIdx}      resend cooldown
 *   rl:otp:p:{phoneIdx}    requests per phone per window
 *   rl:otp:ip:{ipHash}     requests per IP per window
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly config: AppConfig,
    private readonly crypto: CryptoService,
    private readonly redis: RedisService,
    private readonly sms: SmsSender,
  ) {}

  phoneIndex(phone: string) {
    return this.crypto.keyedHash('phone', phone);
  }

  private otpHash(phone: string, code: string) {
    return this.crypto.keyedHash('otp', `${phone}:${code}`);
  }

  /** Fixed-window counter. Returns seconds until reset when over the limit, else null. */
  private async overLimit(key: string, limit: number, windowSeconds: number): Promise<number | null> {
    const res = await this.redis.client.multi().incr(key).ttl(key).exec();
    const count = Number(res?.[0]?.[1] ?? 0);
    const ttl = Number(res?.[1]?.[1] ?? -1);
    if (ttl < 0) await this.redis.client.expire(key, windowSeconds);
    return count > limit ? (ttl > 0 ? ttl : windowSeconds) : null;
  }

  private async assertNotLocked(idx: string) {
    const ttl = await this.redis.client.ttl(`otp:lock:${idx}`);
    if (ttl > 0) {
      throw new TooManyRequests(
        `Too many wrong codes. Try again in ${Math.ceil(ttl / 60)} minutes.`,
        ttl,
      );
    }
  }

  async request(phone: string, ip: string): Promise<{ expiresIn: number; resendAfter: number }> {
    const r = this.redis.client;
    const idx = this.phoneIndex(phone);
    const ipKey = this.crypto.keyedHash('ip', ip);

    await this.assertNotLocked(idx);

    const cooldownSet = await r.set(`otp:cd:${idx}`, '1', 'EX', this.config.otpResendSeconds, 'NX');
    if (cooldownSet !== 'OK') {
      const ttl = Math.max(await r.ttl(`otp:cd:${idx}`), 1);
      throw new TooManyRequests(`Please wait ${ttl} seconds before asking for another code.`, ttl);
    }

    const phoneWait = await this.overLimit(`rl:otp:p:${idx}`, this.config.otpPerPhoneLimit, this.config.otpPerPhoneWindowSeconds);
    if (phoneWait !== null) {
      throw new TooManyRequests(`Too many codes requested for this number. Try again in ${Math.ceil(phoneWait / 60)} minutes.`, phoneWait);
    }
    const ipWait = await this.overLimit(`rl:otp:ip:${ipKey}`, this.config.otpPerIpLimit, this.config.otpPerIpWindowSeconds);
    if (ipWait !== null) {
      throw new TooManyRequests(`Too many codes requested from this network. Try again in ${Math.ceil(ipWait / 60)} minutes.`, ipWait);
    }

    const code = this.crypto.otp(6);
    const key = `otp:${idx}`;
    await r.multi().del(key).hset(key, { h: this.otpHash(phone, code), a: 0 }).expire(key, this.config.otpTtlSeconds).exec();

    try {
      await this.sms.sendOtp(phone, code);
    } catch (err) {
      this.logger.error(`SMS send failed: ${(err as Error).message}`);
      await r.del(key, `otp:cd:${idx}`);
      throw new ServiceUnavailableException('We could not send the SMS right now. Please try again in a minute.');
    }
    return { expiresIn: this.config.otpTtlSeconds, resendAfter: this.config.otpResendSeconds };
  }

  /**
   * Returns normally when the code is correct (and consumes it).
   * Throws 400 for a wrong or expired code and 429 when the number gets locked.
   */
  async verify(phone: string, code: string): Promise<void> {
    const r = this.redis.client;
    const idx = this.phoneIndex(phone);
    const key = `otp:${idx}`;
    await this.assertNotLocked(idx);

    const stored = await r.hget(key, 'h');
    if (!stored) {
      throw new BadRequestException({ statusCode: 400, message: 'This code has expired. Request a new code.', reason: 'expired' });
    }

    if (this.crypto.safeEqualHex(this.otpHash(phone, code), stored)) {
      const deleted = Number(await r.eval(COMPARE_AND_DELETE, 1, key, stored));
      if (deleted !== 1) {
        throw new BadRequestException({ statusCode: 400, message: 'This code was already used. Request a new code.', reason: 'expired' });
      }
      await r.del(`otp:cd:${idx}`);
      return;
    }

    const attempts = Number(await r.eval(INCR_ATTEMPTS_IF_EXISTS, 1, key));
    if (attempts < 0) {
      throw new BadRequestException({ statusCode: 400, message: 'This code has expired. Request a new code.', reason: 'expired' });
    }
    if (attempts >= this.config.otpMaxAttempts) {
      await r.multi().del(key).set(`otp:lock:${idx}`, '1', 'EX', this.config.otpLockSeconds).exec();
      throw new TooManyRequests(
        `Too many wrong codes. This number is locked for ${Math.ceil(this.config.otpLockSeconds / 60)} minutes.`,
        this.config.otpLockSeconds,
      );
    }
    const left = this.config.otpMaxAttempts - attempts;
    throw new BadRequestException({
      statusCode: 400,
      message: `That code is not correct. ${left} ${left === 1 ? 'try' : 'tries'} left.`,
      reason: 'wrong_code',
      attemptsLeft: left,
    });
  }
}
