import type { NextFunction, Request, Response } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Blocks cross-site form posts and scripted requests from other origins.
 * Works together with SameSite=Strict cookies:
 * - a request carrying an Origin header must come from one of our own origins;
 * - state-changing requests must send JSON, which browsers cannot do cross-site without CORS,
 *   and this API does not enable CORS.
 */
export function csrfProtection(allowedOrigins: string[]) {
  const allowed = new Set(allowedOrigins);
  return (req: Request, res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.headers.origin;
    if (origin && !allowed.has(origin)) {
      return res.status(403).json({ statusCode: 403, message: 'Request blocked: unknown origin.' });
    }
    const ct = req.headers['content-type'] ?? '';
    if (!ct.toLowerCase().startsWith('application/json')) {
      return res.status(415).json({ statusCode: 415, message: 'Send the request body as application/json.' });
    }
    return next();
  };
}
