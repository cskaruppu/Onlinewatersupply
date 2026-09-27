import { BadRequestException, Body, Controller, Get, HttpCode, HttpException, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { CookieOptions, Request, Response } from 'express';
import { AppConfig } from '../config/config';
import { maskPhone, normalizeIndianMobile } from '../common/phone';
import { AuditService, RequestMeta } from '../audit/audit.service';
import { UsersService } from '../users/users.service';
import { OtpService } from './otp.service';
import { AccessClaims, SessionTokens, TokensService } from './tokens.service';
import { ACCESS_COOKIE, CurrentAuth, REFRESH_COOKIE, SessionGuard } from './auth.guard';
import { RequestOtpDto, VerifyOtpDto } from './auth.dto';

function meta(req: Request): RequestMeta {
  return { ip: req.ip ?? 'unknown', userAgent: req.headers['user-agent'] };
}

function phoneOr400(raw: string): string {
  const phone = normalizeIndianMobile(raw);
  if (!phone) throw new BadRequestException('Enter a valid 10-digit Indian mobile number.');
  return phone;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly config: AppConfig,
    private readonly otp: OtpService,
    private readonly users: UsersService,
    private readonly tokens: TokensService,
    private readonly audit: AuditService,
  ) {}

  private cookieBase(): CookieOptions {
    return { httpOnly: true, secure: this.config.cookieSecure, sameSite: 'strict' };
  }

  private setSessionCookies(res: Response, t: SessionTokens) {
    res.cookie(ACCESS_COOKIE, t.accessToken, { ...this.cookieBase(), path: '/', maxAge: this.config.accessTtlSeconds * 1000 });
    res.cookie(REFRESH_COOKIE, t.refreshToken, {
      ...this.cookieBase(),
      path: '/api/v1/auth',
      maxAge: this.config.refreshTtlDays * 86_400_000,
    });
  }

  private clearSessionCookies(res: Response) {
    res.clearCookie(ACCESS_COOKIE, { ...this.cookieBase(), path: '/' });
    res.clearCookie(REFRESH_COOKIE, { ...this.cookieBase(), path: '/api/v1/auth' });
  }

  @Post('otp/request')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async requestOtp(@Body() body: RequestOtpDto, @Req() req: Request) {
    const phone = phoneOr400(body.phone);
    const m = meta(req);
    const phoneIdx = this.otp.phoneIndex(phone);
    try {
      const result = await this.otp.request(phone, m.ip);
      await this.audit.log('otp_requested', m, { phoneIdx });
      return { message: 'OTP sent', phoneMasked: maskPhone(phone), ...result };
    } catch (err) {
      if (err instanceof HttpException && err.getStatus() === 429) {
        await this.audit.log('otp_request_blocked', m, { phoneIdx, detail: { reason: err.message } });
      }
      throw err;
    }
  }

  @Post('otp/verify')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async verifyOtp(@Body() body: VerifyOtpDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const phone = phoneOr400(body.phone);
    const m = meta(req);
    const phoneIdx = this.otp.phoneIndex(phone);
    try {
      await this.otp.verify(phone, body.otp);
    } catch (err) {
      if (err instanceof HttpException) {
        const locked = err.getStatus() === 429;
        await this.audit.log(locked ? 'otp_locked' : 'otp_verify_failed', m, { phoneIdx });
      }
      throw err;
    }

    const user = await this.users.signIn(phone, phoneIdx);
    if (user.status !== 'active') {
      throw new UnauthorizedException('This account is suspended. Please contact NeerNow support.');
    }
    this.setSessionCookies(res, await this.tokens.startSession(user, m));
    await this.audit.log('login_success', m, { userId: user.id, phoneIdx });
    return { user: this.users.toPublic(user) };
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) throw new UnauthorizedException('Please sign in.');
    try {
      this.setSessionCookies(res, await this.tokens.rotate(token, meta(req)));
    } catch (err) {
      this.clearSessionCookies(res);
      throw err;
    }
    return { ok: true };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (token) {
      const userId = await this.tokens.revoke(token);
      if (userId) await this.audit.log('logout', meta(req), { userId });
    }
    this.clearSessionCookies(res);
  }
}

@Controller('me')
export class MeController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @UseGuards(SessionGuard)
  async me(@CurrentAuth() auth: AccessClaims) {
    const user = await this.users.findById(auth.sub);
    if (!user || user.status !== 'active') throw new UnauthorizedException('Please sign in.');
    return { user: this.users.toPublic(user) };
  }
}
