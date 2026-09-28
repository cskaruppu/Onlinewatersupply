'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, ApiError, Order, rupees } from '@/lib/api';
import { useRequireUser } from '@/lib/session';
import { AppHeader } from '../../app-header';
import { StatusPill } from '../status-pill';

export default function OrderPage() {
  const { id } = useParams<{ id: string }>();
  const { user, error: sessionError } = useRequireUser();
  const [order, setOrder] = useState<Order | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setIsNew(new URLSearchParams(window.location.search).get('new') === '1');
    if (user) {
      api.order(id).then(setOrder).catch((err) =>
        setError(err instanceof ApiError && err.status === 404 ? 'Order not found.' : 'Could not load this order. Please refresh.'));
    }
  }, [user, id]);

  async function cancel() {
    setBusy(true);
    setError('');
    try {
      setOrder(await api.cancelOrder(id));
      setConfirming(false);
      setIsNew(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page narrow">
      <AppHeader />
      {(sessionError || error) && <p className="msg error" role="alert">{sessionError || error}</p>}
      {order && (
        <section className="card stack" aria-labelledby="title">
          {isNew && order.status === 'requested' && (
            <p className="msg ok" role="status">Order placed. We are finding the nearest verified tanker for you.</p>
          )}
          <div className="row-between">
            <span className="label">Order <span className="mono">{order.reference}</span></span>
            <StatusPill order={order} />
          </div>
          <h1 id="title">{order.capacityKl} KL tanker</h1>
          <p className="lead">{order.slotLabel}</p>
          <dl className="facts">
            <div><dt>Deliver to</dt><dd>{order.address ? `${order.address.label}: ${order.address.line1}, ${order.address.locality}` : 'Address removed'}</dd></div>
            <div><dt>Price band</dt><dd>Band {order.band}</dd></div>
            <div><dt>Payment</dt><dd>{order.paymentMethod === 'cash' ? 'Cash on delivery' : 'UPI'}</dd></div>
            <div><dt>Placed</dt><dd>{new Date(order.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })}</dd></div>
          </dl>
          <dl className="lines">
            {order.lines.map((l) => (
              <div key={l.code}><dt>{l.label}</dt><dd>{rupees(l.amountPaise)}</dd></div>
            ))}
            <div className="total"><dt>Total, fixed</dt><dd>{rupees(order.totalPaise)}</dd></div>
          </dl>
          {order.cancellable && !confirming && (
            <button className="btn ghost" type="button" onClick={() => setConfirming(true)}>Cancel order</button>
          )}
          {confirming && (
            <div className="confirm-row">
              <span>Cancel this order? It&apos;s free until an owner accepts it.</span>
              <button className="btn ghost danger" type="button" onClick={cancel} disabled={busy}>{busy ? 'Cancelling…' : 'Yes, cancel'}</button>
              <button className="btn ghost" type="button" onClick={() => setConfirming(false)}>Keep order</button>
            </div>
          )}
          <Link className="link" href="/orders">All orders</Link>
        </section>
      )}
    </main>
  );
}
