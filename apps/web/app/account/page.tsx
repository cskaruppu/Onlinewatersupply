'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, PublicUser } from '@/lib/api';
import { useRequireUser } from '@/lib/session';
import { AppHeader } from '../app-header';

const ROLE_LABEL: Record<PublicUser['role'], string> = {
  customer: 'Customer',
  owner: 'Tanker owner',
  driver: 'Driver',
  admin: 'Admin',
};

function formatDate(iso: string | null, withTime = true) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    ...(withTime ? { timeStyle: 'short' } : {}),
    timeZone: 'Asia/Kolkata',
  }).format(new Date(iso));
}

export default function AccountPage() {
  const router = useRouter();
  const { user, error } = useRequireUser();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    try {
      await api.logout();
    } finally {
      router.replace('/login');
    }
  }

  return (
    <main className="page narrow">
      <AppHeader />
      <section className="card" aria-labelledby="title" aria-busy={!user && !error}>
        {error && <p className="msg error" role="alert">{error}</p>}
        {!user && !error && <p className="lead">Loading your account…</p>}
        {user && (
          <>
            <div style={{ display: 'grid', gap: 6 }}>
              <span className="pill">Signed in securely</span>
              <h1 id="title">Vanakkam! You&apos;re signed in.</h1>
              <Link className="btn primary" href="/book">Book a water tanker</Link>
            </div>
            <dl className="facts">
              <div><dt>Mobile</dt><dd>{user.phoneMasked}</dd></div>
              <div><dt>Account type</dt><dd>{ROLE_LABEL[user.role]}</dd></div>
              <div><dt>Member since</dt><dd>{formatDate(user.memberSince, false)}</dd></div>
              <div><dt>This sign-in</dt><dd>{formatDate(user.lastLoginAt)}</dd></div>
            </dl>
            <button className="btn ghost" type="button" onClick={signOut} disabled={signingOut}>
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </>
        )}
      </section>
      <p className="foot">Your session renews automatically and ends after 30 days, or when you sign out.</p>
    </main>
  );
}
