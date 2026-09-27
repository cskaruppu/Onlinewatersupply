import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import { AccessClaims, TokensService } from './tokens.service';

export const ACCESS_COOKIE = 'nn_at';
export const REFRESH_COOKIE = 'nn_rt';

type AuthedRequest = Request & { auth?: AccessClaims };

/**
 * Accepts the access token from the HttpOnly cookie (web) or an
 * "Authorization: Bearer" header (future mobile apps).
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly tokens: TokensService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : req.cookies?.[ACCESS_COOKIE];
    if (!token) throw new UnauthorizedException('Please sign in.');
    req.auth = this.tokens.verifyAccess(token);
    return true;
  }
}

export const CurrentAuth = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AccessClaims => ctx.switchToHttp().getRequest<AuthedRequest>().auth!,
);
