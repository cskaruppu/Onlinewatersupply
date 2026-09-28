'use client';

import { useRouter } from 'next/navigation';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Address, api, ApiError, Locality, safeNext } from '@/lib/api';
import { useRequireUser } from '@/lib/session';
import { AppHeader } from '../app-header';
import { BandNote } from '../band-note';

const LABELS = ['Home', 'Work', 'Site', 'Parents', 'Other'];

export default function AddressesPage() {
  const router = useRouter();
  const { user, error: sessionError } = useRequireUser();
  const [addresses, setAddresses] = useState<Address[] | null>(null);
  const [localities, setLocalities] = useState<Locality[]>([]);
  const [adding, setAdding] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [label, setLabel] = useState('Home');
  const [line1, setLine1] = useState('');
  const [landmark, setLandmark] = useState('');
  const [localityId, setLocalityId] = useState<number | ''>('');
  const [pincode, setPincode] = useState('');
  const [coords, setCoords] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const list = await api.addresses();
    setAddresses(list);
    setAdding((a) => a || list.length === 0);
  }, []);

  useEffect(() => {
    if (!user) return;
    Promise.all([load(), api.localities().then(setLocalities)]).catch(() => setError('Could not load your addresses. Please refresh.'));
  }, [user, load]);

  function chooseLocality(id: string) {
    const loc = localities.find((l) => l.id === Number(id));
    setLocalityId(loc ? loc.id : '');
    if (loc) setPincode(loc.pincode);
  }

  function useMyLocation() {
    if (!navigator.geolocation) {
      setError('This browser cannot share your location. Choose your area instead.');
      return;
    }
    setLocating(true);
    setError('');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy) });
        setLocating(false);
      },
      () => {
        setError('Location was not shared. We will use the centre of your area instead.');
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (localityId === '') return setError('Choose your area.');
    setSaving(true);
    setError('');
    try {
      const saved = await api.saveAddress({
        label, line1, landmark: landmark || undefined, localityId, pincode,
        ...(coords ? { lat: coords.lat, lng: coords.lng } : {}),
      });
      setLine1(''); setLandmark(''); setLocalityId(''); setPincode(''); setCoords(null);
      setAdding(false);
      await load();
      const next = safeNext(new URLSearchParams(window.location.search).get('next'));
      if (next && saved.serviceable) return router.push(`${next}?address=${saved.id}`);
      setNotice(saved.serviceable
        ? `Saved. ${saved.label} is in band ${saved.band} (${saved.bandLabel?.toLowerCase()}).`
        : `Saved, but ${saved.label} is outside our delivery area for now. Call support for a quote.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the address. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    setError('');
    try {
      await api.deleteAddress(id);
      setConfirmId(null);
      setNotice('Address removed.');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove the address.');
    }
  }

  return (
    <main className="page">
      <AppHeader />
      <div className="page-head">
        <h1>Delivery addresses</h1>
        <p className="lead">Your price depends on your address, not the lorry&apos;s route. We check the road distance from the nearest filling point once, when you save.</p>
      </div>
      {(sessionError || error) && <p className="msg error" role="alert">{sessionError || error}</p>}
      {notice && !error && <p className="msg ok" role="status">{notice}</p>}

      {addresses && addresses.length > 0 && (
        <ul className="list" aria-label="Saved addresses">
          {addresses.map((a) => (
            <li key={a.id} className="card list-item">
              <div className="stack-sm">
                <strong>{a.label}</strong>
                <span>{a.line1}{a.landmark ? `, near ${a.landmark}` : ''}</span>
                <span className="lead small">{a.locality}, Coimbatore {a.pincode}</span>
                <BandNote a={a} />
              </div>
              {confirmId === a.id ? (
                <div className="confirm-row">
                  <span className="small">Remove {a.label}?</span>
                  <button className="btn ghost danger" type="button" onClick={() => remove(a.id)}>Remove</button>
                  <button className="btn ghost" type="button" onClick={() => setConfirmId(null)}>Keep</button>
                </div>
              ) : (
                <button className="link" type="button" onClick={() => setConfirmId(a.id)}>Remove</button>
              )}
            </li>
          ))}
        </ul>
      )}

      {addresses && !adding && (
        <button className="btn ghost" type="button" onClick={() => { setAdding(true); setNotice(''); }}>+ Add an address</button>
      )}

      {adding && (
        <form className="card stack" onSubmit={save} noValidate>
          <h2>Add an address</h2>
          <fieldset className="field">
            <legend className="label">Label</legend>
            <div className="chips">
              {LABELS.map((l) => (
                <label key={l} className="chip">
                  <input type="radio" name="label" value={l} checked={label === l} onChange={() => setLabel(l)} />
                  <span>{l}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="field">
            <label className="label" htmlFor="line1">House / flat number and street</label>
            <input id="line1" className="input" value={line1} onChange={(e) => setLine1(e.target.value)} maxLength={120} autoComplete="address-line1" placeholder="22, Kurinji Nagar, 3rd Street" required />
          </div>
          <div className="field">
            <label className="label" htmlFor="landmark">Landmark (optional)</label>
            <input id="landmark" className="input" value={landmark} onChange={(e) => setLandmark(e.target.value)} maxLength={80} placeholder="Opposite the temple" />
          </div>
          <div className="grid2">
            <div className="field">
              <label className="label" htmlFor="locality">Area</label>
              <select id="locality" className="input" value={localityId} onChange={(e) => chooseLocality(e.target.value)} required>
                <option value="">Choose your area</option>
                {localities.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor="pincode">Pincode</label>
              <input id="pincode" className="input" value={pincode} onChange={(e) => setPincode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="postal-code" placeholder="641035" required />
            </div>
          </div>
          <div className="locate">
            <button className="btn ghost" type="button" onClick={useMyLocation} disabled={locating}>
              {locating ? 'Finding you…' : coords ? 'Update my location' : 'Use my current location'}
            </button>
            <span className="small lead">
              {coords ? `Location captured (±${coords.accuracy} m). Stand at the gate for the most accurate pin.` : 'Optional. Gives the driver your exact gate instead of the area centre.'}
            </span>
          </div>
          <div className="actions">
            <button className="btn primary" type="submit" disabled={saving || line1.trim().length < 5 || localityId === '' || pincode.length !== 6}>
              {saving ? 'Checking distance…' : 'Save address'}
            </button>
            {addresses && addresses.length > 0 && (
              <button className="btn ghost" type="button" onClick={() => setAdding(false)}>Cancel</button>
            )}
          </div>
        </form>
      )}
    </main>
  );
}
