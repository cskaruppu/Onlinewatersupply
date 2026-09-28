export interface PublicUser {
  id: string;
  role: 'customer' | 'owner' | 'driver' | 'admin';
  phoneMasked: string;
  memberSince: string;
  lastLoginAt: string | null;
}

export type Band = 'A' | 'B' | 'C';
export type Slot = 'asap' | 'evening' | 'early_morning';

export interface Locality {
  id: number;
  name: string;
  pincode: string;
  zone: string;
}

export interface Address {
  id: string;
  label: string;
  line1: string;
  landmark: string | null;
  locality: string | null;
  pincode: string;
  zone: string | null;
  band: Band | null;
  bandLabel: string | null;
  roadKm: number | null;
  fillingPoint: string | null;
  hillRoad: boolean;
  serviceable: boolean;
  distanceEstimated: boolean;
}

export interface NewAddress {
  label: string;
  line1: string;
  landmark?: string;
  localityId: number;
  pincode: string;
  lat?: number;
  lng?: number;
}

export interface RateCard {
  bands: { code: Band; label: string; minKm: number; maxKm: number }[];
  capacities: { capacityKl: number; prices: Record<Band, number> }[];
  addOns: { code: string; label: string; pricePaise: number; unit: string; customerSelectable: boolean }[];
  platformFeePaise: number;
}

export interface QuoteLine {
  code: string;
  label: string;
  amountPaise: number;
}

export interface Quote {
  capacityKl: number;
  band: Band;
  lines: QuoteLine[];
  totalPaise: number;
}

export interface OrderRequest {
  addressId: string;
  capacityKl: number;
  slot: Slot;
  addOns: string[];
}

export interface Order {
  id: string;
  reference: string;
  status: 'requested' | 'accepted' | 'on_the_way' | 'delivered' | 'cancelled';
  statusLabel: string;
  capacityKl: number;
  band: Band;
  slot: Slot;
  slotLabel: string;
  paymentMethod: 'cash' | 'upi';
  address: { label: string; line1: string; locality: string | null } | null;
  lines: QuoteLine[];
  totalPaise: number;
  createdAt: string;
  cancellable: boolean;
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

let refreshing: Promise<boolean> | null = null;

/** Renews the session once, even if several requests hit an expired token at the same time. */
function refreshSession(): Promise<boolean> {
  refreshing ??= fetch('/api/v1/auth/refresh', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

async function call<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(init.headers ?? {}) },
  });
  // The 15-minute access token expired: renew it and try once more.
  if (res.status === 401 && !retried && !path.startsWith('/auth/') && (await refreshSession())) {
    return call<T>(path, init, true);
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = Array.isArray(body.message) ? body.message[0] : body.message;
    throw new ApiError(res.status, msg || 'Something went wrong. Please try again.', body);
  }
  return body as T;
}

const post = <T>(path: string, data: unknown = {}, headers: Record<string, string> = {}) =>
  call<T>(path, { method: 'POST', body: JSON.stringify(data), headers });

export const api = {
  requestOtp: (phone: string) =>
    post<{ phoneMasked: string; expiresIn: number; resendAfter: number }>('/auth/otp/request', { phone }),
  verifyOtp: (phone: string, otp: string) => post<{ user: PublicUser }>('/auth/otp/verify', { phone, otp }),
  logout: () => post<void>('/auth/logout'),

  /** The signed-in user, or null when signed out. */
  async me(): Promise<PublicUser | null> {
    try {
      return (await call<{ user: PublicUser }>('/me')).user;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null;
      throw e;
    }
  },

  localities: () => call<Locality[]>('/localities'),
  rateCard: () => call<RateCard>('/pricing/rate-card'),

  addresses: async () => (await call<{ addresses: Address[] }>('/addresses')).addresses,
  saveAddress: async (a: NewAddress) => (await post<{ address: Address }>('/addresses', a)).address,
  deleteAddress: (id: string) => call<void>(`/addresses/${id}`, { method: 'DELETE' }),

  quote: async (r: OrderRequest) => (await post<{ quote: Quote }>('/orders/quote', r)).quote,
  /** The idempotency key makes a retried or double-tapped booking return the same order. */
  book: async (r: OrderRequest & { paymentMethod: 'cash' }, idempotencyKey: string) =>
    (await post<{ order: Order }>('/orders', r, { 'idempotency-key': idempotencyKey })).order,
  orders: async () => (await call<{ orders: Order[] }>('/orders')).orders,
  order: async (id: string) => (await call<{ order: Order }>(`/orders/${id}`)).order,
  cancelOrder: async (id: string) => (await post<{ order: Order }>(`/orders/${id}/cancel`)).order,
};

export function rupees(paise: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: paise % 100 ? 2 : 0,
  }).format(paise / 100);
}

/** Random key for one booking attempt. randomUUID needs HTTPS or localhost, so fall back to getRandomValues. */
export function newAttemptKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Only same-site paths are allowed as a post-login destination. */
export function safeNext(next: string | null): string | null {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : null;
}
