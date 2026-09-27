import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { AppConfig } from '../config/config';

const MIGRATION_LOCK_ID = 727_001;

@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  readonly pool: Pool;

  constructor(private readonly config: AppConfig) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseSsl ? { rejectUnauthorized: true } : undefined,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
    });
    this.pool.on('error', (err) => this.logger.error(`Idle database client error: ${err.message}`));
  }

  async onModuleInit() {
    await this.migrate();
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) {
    return this.pool.query<T>(text, params);
  }

  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Applies SQL files from the migrations folder in name order, once each.
   * An advisory lock makes this safe when several API pods start at the same time.
   */
  async migrate() {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
      await client.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      const applied = new Set(
        (await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version),
      );
      const files = (await fs.readdir(this.config.migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
      for (const file of files) {
        if (applied.has(file)) continue;
        const sql = await fs.readFile(path.join(this.config.migrationsDir, file), 'utf8');
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
          await client.query('COMMIT');
          this.logger.log(`Applied migration ${file}`);
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
      client.release();
    }
  }
}
