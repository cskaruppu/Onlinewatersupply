import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import type { QueryResult, QueryResultRow } from 'pg';
import { AppConfig } from '../config/config';
import { CryptoService } from '../common/crypto.service';
import { DbService } from '../db/db.service';
import { AuditService, RequestMeta } from '../audit/audit.service';
import { Role, UserRow } from '../users/users.service';

export interface AccessClaims {
  sub: string;
  role: Role;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

/** A pool, a transaction client, or DbService: anything that can run a parameterised query. */
interface Queryable {
  query<T extends QueryResultRow>(text: string, params: unknown[]): Promise<QueryResult<T>>;
}

const JWT_ISSUER = 'neernow-api';
const JWT_AUDIENCE = 'neernow';

/**
 * Short-lived access tokens (JWT, 15 min by default) plus long-lived refresh tokens.
 * Refresh tokens are random strings stored only as SHA-256 hashes and rotated on every use.
 */
@Injectable()
export class TokensService {
  constructor(
    private readonly config: AppConfig,
    private readonly jwt: JwtService,
    private readonly db: DbService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  private signAccess(user: Pick<UserRow, 'id' | 'role'>) {
    return this.jwt.sign(
      { sub: user.id, role: user.role } satisfies AccessClaims,
      { expiresIn: this.config.accessTtlSeconds, issuer: JWT_ISSUER, audience: JWT_AUDIENCE, algorithm: 'HS256' },
    );
  }

  verifyAccess(token: string): AccessClaims {
    try {
      return this.jwt.verify<AccessClaims>(token, { issuer: JWT_ISSUER, audience: JWT_AUDIENCE, algorithms: ['HS256'] });
    } catch {
      throw new UnauthorizedException('Your session has expired. Please sign in again.');
    }
  }

  private async insertRefresh(client: Queryable, userId: string, familyId: string, meta: RequestMeta) {
    const token = this.crypto.randomToken(32);
    const expires = new Date(Date.now() + this.config.refreshTtlDays * 86_400_000);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent, ip_hash)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [userId, familyId, this.crypto.sha256(token), expires, meta.userAgent?.slice(0, 300) ?? null, this.audit.ipHash(meta.ip)],
    );
    return { token, id: rows[0].id };
  }

  async startSession(user: UserRow, meta: RequestMeta): Promise<SessionTokens> {
    const { token } = await this.insertRefresh(this.db, user.id, randomUUID(), meta);
    return { accessToken: this.signAccess(user), refreshToken: token };
  }

  /** Swaps a valid refresh token for a new pair. Reuse of an old token revokes the whole session family. */
  async rotate(refreshToken: string, meta: RequestMeta): Promise<SessionTokens> {
    const hash = this.crypto.sha256(refreshToken);
    const result = await this.db.transaction(async (client) => {
      const { rows } = await client.query<{
        id: string; user_id: string; family_id: string; expires_at: Date; revoked_at: Date | null;
      }>('SELECT id, user_id, family_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE', [hash]);
      const row = rows[0];
      if (!row) return { error: 'unknown' as const };
      if (row.revoked_at) {
        await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [row.family_id]);
        return { error: 'reuse' as const, userId: row.user_id };
      }
      if (row.expires_at.getTime() <= Date.now()) return { error: 'expired' as const };

      const user = (await client.query<UserRow>('SELECT * FROM users WHERE id = $1', [row.user_id])).rows[0];
      if (!user || user.status !== 'active') {
        await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [row.family_id]);
        return { error: 'inactive' as const };
      }
      const next = await this.insertRefresh(client, user.id, row.family_id, meta);
      await client.query('UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1', [row.id, next.id]);
      return { tokens: { accessToken: this.signAccess(user), refreshToken: next.token } };
    });

    if ('tokens' in result && result.tokens) return result.tokens;
    if (result.error === 'reuse') {
      await this.audit.log('refresh_reuse_detected', meta, { userId: result.userId });
    }
    throw new UnauthorizedException('Your session has ended. Please sign in again.');
  }

  /** Ends the session this refresh token belongs to (all tokens in its family). */
  async revoke(refreshToken: string): Promise<string | null> {
    const { rows } = await this.db.query<{ user_id: string }>(
      `UPDATE refresh_tokens SET revoked_at = now()
       WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1) AND revoked_at IS NULL
       RETURNING user_id`,
      [this.crypto.sha256(refreshToken)],
    );
    return rows[0]?.user_id ?? null;
  }
}
