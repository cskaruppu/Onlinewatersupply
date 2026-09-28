'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, Order, rupees } from '@/lib/api';
import { useRequireUser } from '@/lib/session';
import { AppHeader } from '../app-header';
import { StatusPill } from './status-pill';

export default function OrdersPage() {
  const { user, error: sessionError } = useRequireUser();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (user) api.orders().then(setOrders).catch(() => setError('Could not load your orders. Please refresh.'));
  }, [user]);

  return (
    <main className="page">
      <AppHeader />
      <div className="page-head row-between">
        <h1>Your orders</h1>
        <Link className="btn primary" href="/book">Book a tanker</Link>
      </div>
      {(sessionError || error) && <p className="msg error" role="alert">{sessionError || error}</p>}
      {orders && orders.length === 0 && <p className="card lead">No orders yet. Your bookings will appear here.</p>}
      {orders && orders.length > 0 && (
        <ul className="list">
          {orders.map((o) => (
            <li key={o.id}>
              <Link href={`/orders/${o.id}`} className="card list-item order-link">
                <span className="stack-sm">
                  <strong>{o.capacityKl} KL tanker <span className="mono small">{o.reference}</span></strong>
                  <span className="small lead">
                    {o.address ? `${o.address.label}, ${o.address.locality}` : 'Address removed'} · {o.slotLabel} ·{' '}
                    {new Date(o.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}
                  </span>
                </span>
                <span className="stack-sm right">
                  <strong className="num">{rupees(o.totalPaise)}</strong>
                  <StatusPill order={o} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
