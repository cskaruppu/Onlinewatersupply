import { Injectable, Logger } from '@nestjs/common';
import { CryptoService } from '../common/crypto.service';
import { DbService } from '../db/db.service';

export type AuthEvent =
  | 'otp_requested'
  | 'otp_request_blocked'
  | 'otp_verify_failed'
  | 'otp_locked'
  | 'login_success'
  | 'refresh_reuse_detected'
  | 'logout';

export interface RequestMeta {
  ip: string;
  userAgent?: string;
}

/** Writes sign-in activity to the auth_events table. Never stores raw phone numbers or IPs. */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  constructor(
    private readonly db: DbService,
    private readonly crypto: CryptoService,
  ) {}

  ipHash(ip: string) {
    return this.crypto.keyedHash('ip', ip);
  }

  async log(
    event: AuthEvent,
    meta: RequestMeta,
    extra: { userId?: string; phoneIdx?: string; detail?: Record<string, unknown> } = {},
  ) {
    try {
      await this.db.query(
        `INSERT INTO auth_events (event, user_id, phone_idx, ip_hash, user_agent, detail)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          event,
          extra.userId ?? null,
          extra.phoneIdx ?? null,
          this.ipHash(meta.ip),
          meta.userAgent?.slice(0, 300) ?? null,
          extra.detail ? JSON.stringify(extra.detail) : null,
        ],
      );
    } catch (err) {
      // Auditing must never break sign-in, but a failure has to be visible.
      this.logger.error(`Could not write audit event ${event}: ${(err as Error).message}`);
    }
  }
}
