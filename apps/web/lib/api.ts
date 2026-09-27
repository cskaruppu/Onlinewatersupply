export interface PublicUser {
  id: string;
  role: 'customer' | 'owner' | 'driver' | 'admin';
  phoneMasked: string;
  memberSince: string;
  lastLoginAt: string | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(init.headers ?? {}) },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = Array.isArray(body.message) ? body.message[0] : body.message;
    throw new ApiError(res.status, msg || 'Something went wrong. Please try again.', body);
  }
  return body as T;
}

const post = <T>(path: string, data: unknown = {}) => call<T>(path, { method: 'POST', body: JSON.stringify(data) });

export const api = {
  requestOtp: (phone: string) =>
    post<{ phoneMasked: string; expiresIn: number; resendAfter: number }>('/auth/otp/request', { phone }),
  verifyOtp: (phone: string, otp: string) => post<{ user: PublicUser }>('/auth/otp/verify', { phone, otp }),
  logout: () => post<void>('/auth/logout'),

  /** Loads the signed-in user, refreshing the session once if the short-lived token has expired. */
  async me(): Promise<PublicUser | null> {
    try {
      return (await call<{ user: PublicUser }>('/me')).user;
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) throw e;
    }
    try {
      await post('/auth/refresh');
      return (await call<{ user: PublicUser }>('/me')).user;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null;
      throw e;
    }
  },
};
