import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { DbService } from '../db/db.service';
import { RedisService } from '../redis/redis.service';

@SkipThrottle()
@Controller()
export class HealthController {
  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
  ) {}

  /** Liveness: the process is up. Used by the OpenShift liveness probe. */
  @Get('healthz')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: database and Redis are reachable. Used by the OpenShift readiness probe. */
  @Get('readyz')
  async ready() {
    try {
      await Promise.all([this.db.query('SELECT 1'), this.redis.client.ping()]);
      return { status: 'ready' };
    } catch {
      throw new ServiceUnavailableException({ status: 'not_ready' });
    }
  }
}
