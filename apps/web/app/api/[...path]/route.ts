import type { NextRequest } from 'next/server';

/**
 * Same-origin proxy: the browser talks only to this web app, which forwards /api/* to the
 * internal API service. The API is never exposed on the internet, and session cookies stay
 * first-party (SameSite=Strict).
 */
export const dynamic = 'force-dynamic';

const API = process.env.API_INTERNAL_URL ?? 'http://localhost:3001';
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const FORWARD_REQUEST_HEADERS = ['content-type', 'cookie', 'user-agent', 'origin', 'authorization', 'accept', 'x-forwarded-for'];
const FORWARD_RESPONSE_HEADERS = ['content-type', 'retry-after', 'cache-control'];

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  if (!path.length || path.some((s) => !SEGMENT.test(s) || s === '..' || s === '.')) {
    return Response.json({ statusCode: 404, message: 'Not found' }, { status: 404 });
  }
  const target = new URL(`/api/${path.join('/')}`, API);
  target.search = req.nextUrl.search;

  const headers = new Headers();
  for (const h of FORWARD_REQUEST_HEADERS) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.text(),
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return Response.json({ statusCode: 502, message: 'The service is not reachable. Please try again shortly.' }, { status: 502 });
  }

  const out = new Headers();
  for (const h of FORWARD_RESPONSE_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  for (const c of upstream.headers.getSetCookie()) out.append('set-cookie', c);
  out.set('cache-control', 'no-store');
  return new Response(upstream.status === 204 ? null : await upstream.arrayBuffer(), { status: upstream.status, headers: out });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
