import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { AppConfig } from '../config/config';

/**
 * Encryption and hashing helpers.
 *
 * - encrypt/decrypt: AES-256-GCM for personal data stored in the database (phone numbers).
 * - keyedHash: HMAC-SHA256 with a purpose label, used for OTP hashes and lookup indexes,
 *   so the same value hashed for two purposes never produces the same output.
 */
@Injectable()
export class CryptoService {
  constructor(private readonly config: AppConfig) {}

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.config.dataEncryptionKey, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return 'v1:' + Buffer.concat([iv, tag, ct]).toString('base64');
  }

  decrypt(payload: string): string {
    if (!payload.startsWith('v1:')) throw new Error('Unknown ciphertext version');
    const buf = Buffer.from(payload.slice(3), 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.config.dataEncryptionKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }

  keyedHash(purpose: string, value: string): string {
    return createHmac('sha256', this.config.hashKey).update(`${purpose}\0${value}`).digest('hex');
  }

  sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  /** Constant-time comparison of two hex strings. */
  safeEqualHex(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
  }

  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  /** Numeric one-time code from a cryptographically secure source. */
  otp(digits = 6): string {
    return randomInt(0, 10 ** digits).toString().padStart(digits, '0');
  }
}
