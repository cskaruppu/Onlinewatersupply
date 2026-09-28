import type { Order } from '@/lib/api';

const TONE: Record<Order['status'], string> = {
  requested: 'warn',
  accepted: 'info',
  on_the_way: 'info',
  delivered: 'good',
  cancelled: 'muted',
};

export function StatusPill({ order }: { order: Order }) {
  return <span className={`pill ${TONE[order.status]}`}>{order.statusLabel}</span>;
}
