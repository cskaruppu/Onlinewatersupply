import { Injectable } from '@nestjs/common';
import { CryptoService } from '../common/crypto.service';
import { maskPhone } from '../common/phone';
import { DbService } from '../db/db.service';

export type Role = 'customer' | 'owner' | 'driver' | 'admin';

export interface UserRow {
  id: string;
  phone_enc: string;
  phone_idx: string;
  phone_last4: string;
  role: Role;
  status: 'active' | 'suspended';
  created_at: Date;
  last_login_at: Date | null;
}

export interface PublicUser {
  id: string;
  role: Role;
  phoneMasked: string;
  memberSince: string;
  lastLoginAt: string | null;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly db: DbService,
    private readonly crypto: CryptoService,
  ) {}

  /** Finds the user for this phone number, creating a customer account on first sign-in. */
  async signIn(phone: string, phoneIdx: string): Promise<UserRow> {
    const { rows } = await this.db.query<UserRow>(
      `INSERT INTO users (phone_enc, phone_idx, phone_last4, last_login_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (phone_idx) DO UPDATE SET last_login_at = now()
       RETURNING *`,
      [this.crypto.encrypt(phone), phoneIdx, phone.slice(-4)],
    );
    return rows[0];
  }

  async findById(id: string): Promise<UserRow | null> {
    const { rows } = await this.db.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  toPublic(user: UserRow): PublicUser {
    return {
      id: user.id,
      role: user.role,
      phoneMasked: maskPhone(this.crypto.decrypt(user.phone_enc)),
      memberSince: user.created_at.toISOString(),
      lastLoginAt: user.last_login_at ? user.last_login_at.toISOString() : null,
    };
  }
}
