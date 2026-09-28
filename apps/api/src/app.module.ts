import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppConfig, loadConfig } from './config/config';
import { CryptoService } from './common/crypto.service';
import { DbService } from './db/db.service';
import { RedisService } from './redis/redis.service';
import { smsSenderProvider } from './sms/sms.service';
import { AuditService } from './audit/audit.service';
import { UsersService } from './users/users.service';
import { OtpService } from './auth/otp.service';
import { TokensService } from './auth/tokens.service';
import { SessionGuard } from './auth/auth.guard';
import { AuthController, MeController } from './auth/auth.controller';
import { HealthController } from './health/health.controller';
import { PricingController, PricingService } from './pricing/pricing.service';

const configProvider = { provide: AppConfig, useFactory: () => loadConfig(process.env) };

@Module({
  imports: [
    JwtModule.registerAsync({
      extraProviders: [configProvider],
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({ secret: config.jwtSecret }),
    }),
    // General per-IP limit for every endpoint; OTP endpoints add stricter limits of their own.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
  ],
  controllers: [AuthController, MeController, HealthController, PricingController],
  providers: [
    configProvider,
    CryptoService,
    DbService,
    RedisService,
    smsSenderProvider,
    AuditService,
    UsersService,
    OtpService,
    TokensService,
    SessionGuard,
    PricingService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
