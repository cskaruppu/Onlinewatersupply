'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Address, api, ApiError, newAttemptKey, Quote, RateCard, rupees, Slot } from '@/lib/api';
import { useRequireUser } from '@/lib/session';
import { AppHeader } from '../app-header';
import { BandNote } from '../band-note';

const GOOD_FOR: Record<number, string> = {
  3: 'Small sump or overhead tank',
  6: 'Independent house',
  9: '2–3 houses or a small shop',
  12: 'Small apartment block',
  24: 'Apartment complex or construction site',
};

const SLOTS: { value: Slot; label: string; hint: string }[] = [
  { value: 'asap', label: 'As soon as possible', hint: 'Usually within the hour' },
  { value: 'evening', label: 'Today, 5–7 PM', hint: '' },
  { value: 'early_morning', label: 'Tomorrow, 6–8 AM', hint: 'Early-morning charge applies' },
];

export default function BookPage() {
  const router = useRouter();
  const { user, error: sessionError } = useRequireUser();
  const [addresses, setAddresses] = useState<Address[] | null>(null);
  const [card, setCard] = useState<RateCard | null>(null);
  const [addressId, setAddressId] = useState('');
  const [capacityKl, setCapacityKl] = useState(12);
  const [slot, setSlot] = useState<Slot>('asap');
  const [addOns, setAddOns] = useState<string[]>([]);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [booking, setBooking] = useState(false);
  const [error, setError] = useState('');
  // One key per booking attempt: a double tap or network retry returns the same order.
  const attemptKey = useRef('');

  useEffect(() => {
    if (!user) return;
    Promise.all([api.addresses(), api.rateCard()])
      .then(([list, rc]) => {
        setAddresses(list);
        setCard(rc);
        const wanted = new URLSearchParams(window.location.search).get('address');
        const first = list.find((a) => a.id === wanted && a.serviceable) ?? list.find((a) => a.serviceable);
        if (first) setAddressId(first.id);
      })
      .catch(() => setError('Could not load booking details. Please refresh.'));
  }, [user]);

  const address = addresses?.find((a) => a.id === addressId) ?? null;
  const extras = useMemo(() => card?.addOns.filter((a) => a.customerSelectable) ?? [], [card]);

  // Live price from the server for the current choices.
  useEffect(() => {
    attemptKey.current = '';
    if (!address?.serviceable) return setQuote(null);
    let stale = false;
    setQuoting(true);
    const t = setTimeout(() => {
      api
        .quote({ addressId: address.id, capacityKl, slot, addOns })
        .then((q) => !stale && (setQuote(q), setError('')))
        .catch((err) => !stale && setError(err instanceof ApiError ? err.message : 'Could not get a price. Please try again.'))
        .finally(() => !stale && setQuoting(false));
    }, 150);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [address, capacityKl, slot, addOns]);

  function toggleAddOn(code: string) {
    setAddOns((cur) => (cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code]));
  }

  async function book() {
    if (!address || !quote || booking) return;
    setBooking(true);
    setError('');
    attemptKey.current ||= newAttemptKey();
    try {
      const order = await api.book({ addressId: address.id, capacityKl, slot, addOns, paymentMethod: 'cash' }, attemptKey.current);
      router.push(`/orders/${order.id}?new=1`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not place the order. Check your connection and try again.');
      setBooking(false);
    }
  }

  const loading = !addresses || !card;
  const noAddress = addresses && !addresses.some((a) => a.serviceable);

  return (
    <main className="page">
      <AppHeader />
      <div className="page-head">
        <h1>Book a water tanker</h1>
        <p className="lead">One fixed price for your address. Traffic or detours never change it.</p>
      </div>
      {(sessionError || error) && <p className="msg error" role="alert">{sessionError || error}</p>}
      {loading && !sessionError && <p className="lead">Loading…</p>}

      {noAddress && (
        <section className="card stack">
          <h2>Where should we deliver?</h2>
          <p className="lead">Add your delivery address first. We check which price band it falls in.</p>
          <Link className="btn primary" href="/addresses?next=/book">Add delivery address</Link>
        </section>
      )}

      {!loading && !noAddress && card && (
        <div className="book-grid">
          <div className="stack">
            <section className="card stack" aria-labelledby="s-address">
              <div className="section-head">
                <h2 id="s-address">1. Deliver to</h2>
                <Link className="link" href="/addresses?next=/book">Add address</Link>
              </div>
              <div className="options">
                {addresses!.map((a) => (
                  <label key={a.id} className={`option${a.serviceable ? '' : ' disabled'}`}>
                    <input type="radio" name="address" value={a.id} checked={addressId === a.id} disabled={!a.serviceable} onChange={() => setAddressId(a.id)} />
                    <span className="stack-sm">
                      <strong>{a.label}</strong>
                      <span className="small">{a.line1}, {a.locality}</span>
                      <BandNote a={a} />
                    </span>
                  </label>
                ))}
              </div>
            </section>

            <section className="card stack" aria-labelledby="s-size">
              <h2 id="s-size">2. Tanker size</h2>
              <div className="sizes">
                {card.capacities.map((c) => (
                  <label key={c.capacityKl} className="size">
                    <input type="radio" name="size" value={c.capacityKl} checked={capacityKl === c.capacityKl} onChange={() => setCapacityKl(c.capacityKl)} />
                    <span className="size-kl">{c.capacityKl} KL</span>
                    <span className="size-l small">{(c.capacityKl * 1000).toLocaleString('en-IN')} litres</span>
                    <span className="size-price">{address?.band ? rupees(c.prices[address.band]) : '—'}</span>
                    <span className="small lead">{GOOD_FOR[c.capacityKl] ?? ''}</span>
                  </label>
                ))}
              </div>
            </section>

            <section className="card stack" aria-labelledby="s-when">
              <h2 id="s-when">3. When</h2>
              <div className="options">
                {SLOTS.map((s) => (
                  <label key={s.value} className="option">
                    <input type="radio" name="slot" value={s.value} checked={slot === s.value} onChange={() => setSlot(s.value)} />
                    <span className="stack-sm"><strong>{s.label}</strong>{s.hint && <span className="small lead">{s.hint}</span>}</span>
                  </label>
                ))}
              </div>
            </section>

            <section className="card stack" aria-labelledby="s-extras">
              <h2 id="s-extras">4. Extras</h2>
              <div className="options">
                {extras.map((x) => (
                  <label key={x.code} className="option">
                    <input type="checkbox" checked={addOns.includes(x.code)} onChange={() => toggleAddOn(x.code)} />
                    <span className="row-between"><span>{x.label}</span><span className="num">+{rupees(x.pricePaise)}</span></span>
                  </label>
                ))}
              </div>
            </section>

            <section className="card stack" aria-labelledby="s-pay">
              <h2 id="s-pay">5. Payment</h2>
              <div className="options">
                <label className="option">
                  <input type="radio" name="pay" checked readOnly />
                  <span className="stack-sm"><strong>Cash on delivery</strong><span className="small lead">Pay the driver after the water is in your tank</span></span>
                </label>
                <label className="option disabled">
                  <input type="radio" name="pay" disabled />
                  <span className="stack-sm"><strong>UPI</strong><span className="small lead">Coming soon</span></span>
                </label>
              </div>
            </section>
          </div>

          <aside className="card stack summary" aria-live="polite" aria-busy={quoting}>
            <h2>Your order</h2>
            {address && (
              <p className="small lead">
                {capacityKl} KL to {address.label}, {address.locality}. {SLOTS.find((s) => s.value === slot)?.label}.
              </p>
            )}
            {quote ? (
              <dl className="lines">
                {quote.lines.map((l) => (
                  <div key={l.code}><dt>{l.label}</dt><dd>{rupees(l.amountPaise)}</dd></div>
                ))}
                <div className="total"><dt>Total, fixed</dt><dd>{rupees(quote.totalPaise)}</dd></div>
              </dl>
            ) : (
              <p className="lead">{quoting ? 'Getting your price…' : 'Choose an address to see the price.'}</p>
            )}
            <button className="btn primary" type="button" onClick={book} disabled={!quote || quoting || booking}>
              {booking ? 'Placing order…' : quote ? `Book ${capacityKl} KL tanker · ${rupees(quote.totalPaise)}` : 'Book tanker'}
            </button>
            <p className="small lead">Free cancellation until a tanker owner accepts your order.</p>
          </aside>
        </div>
      )}
    </main>
  );
}
