'use client';

import { useRouter } from 'next/navigation';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { api, ApiError, safeNext } from '@/lib/api';
import { Brand } from '../brand';

type Step = 'phone' | 'code';

export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [masked, setMasked] = useState('');
  const [resendIn, setResendIn] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const otpRef = useRef<HTMLInputElement>(null);

  // Where to go after signing in: the page that sent the visitor here, or booking.
  const destination = () => safeNext(new URLSearchParams(window.location.search).get('next')) ?? '/book';

  // Already signed in? Go straight on.
  useEffect(() => {
    api.me().then((u) => u && router.replace(destination())).catch(() => undefined);
  }, [router]);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  useEffect(() => {
    if (step === 'code') otpRef.current?.focus();
  }, [step]);

  const digits = phone.replace(/\D/g, '');
  const phoneValid = /^[6-9]\d{9}$/.test(digits);

  async function sendCode(e?: FormEvent) {
    e?.preventDefault();
    if (!phoneValid || busy) return;
    setBusy(true);
    setError('');
    setInfo('');
    try {
      const res = await api.requestOtp(digits);
      setMasked(res.phoneMasked);
      setResendIn(res.resendAfter);
      setOtp('');
      setStep('code');
      setInfo(`Code sent to ${res.phoneMasked}. It is valid for ${Math.round(res.expiresIn / 60)} minutes.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach NeerNow. Check your connection and try again.');
      if (err instanceof ApiError && typeof err.body.retryAfter === 'number' && step === 'code') {
        setResendIn(Math.min(err.body.retryAfter, 3600));
      }
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (otp.length !== 6 || busy) return;
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await api.verifyOtp(digits, otp);
      router.replace(destination());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach NeerNow. Check your connection and try again.');
      setOtp('');
      otpRef.current?.focus();
      setBusy(false);
    }
  }

  const mmss = `${Math.floor(resendIn / 60)}:${String(resendIn % 60).padStart(2, '0')}`;

  return (
    <main className="shell">
      <Brand />
      <section className="card" aria-labelledby="title">
        {step === 'phone' ? (
          <form onSubmit={sendCode} className="stack" noValidate>
            <div style={{ display: 'grid', gap: 6 }}>
              <h1 id="title">Sign in with your mobile number</h1>
              <p className="lead">We will send a 6-digit code by SMS. No password needed.</p>
            </div>
            <div className="field">
              <label className="label" htmlFor="phone">Mobile number</label>
              <div className="phone">
                <span aria-hidden="true">+91</span>
                <input
                  id="phone"
                  name="phone"
                  type="tel"
                  inputMode="numeric"
                  autoComplete="tel-national"
                  placeholder="98765 43210"
                  maxLength={11}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/[^\d ]/g, ''))}
                  aria-describedby="phone-hint"
                  required
                />
              </div>
              <span id="phone-hint" className="lead" style={{ fontSize: 13 }}>
                Indian mobile numbers only, starting with 6, 7, 8 or 9.
              </span>
            </div>
            {error && <p className="msg error" role="alert">{error}</p>}
            <button className="btn primary" type="submit" disabled={!phoneValid || busy}>
              {busy ? 'Sending code…' : 'Send OTP'}
            </button>
          </form>
        ) : (
          <form onSubmit={verify} className="stack" noValidate>
            <div style={{ display: 'grid', gap: 6 }}>
              <h1 id="title">Enter the 6-digit code</h1>
              <p className="lead">Sent by SMS to {masked}.</p>
            </div>
            <div className="field">
              <label className="label" htmlFor="otp">One-time code</label>
              <input
                ref={otpRef}
                id="otp"
                name="otp"
                className="otp-input"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                required
              />
            </div>
            {error && <p className="msg error" role="alert">{error}</p>}
            {!error && info && <p className="msg ok" role="status">{info}</p>}
            <button className="btn primary" type="submit" disabled={otp.length !== 6 || busy}>
              {busy ? 'Checking…' : 'Verify and sign in'}
            </button>
            <div className="links">
              <button type="button" className="link" onClick={() => { setStep('phone'); setError(''); setInfo(''); }}>
                Change number
              </button>
              <button type="button" className="link" onClick={() => sendCode()} disabled={resendIn > 0 || busy}>
                {resendIn > 0 ? `Resend code in ${mmss}` : 'Resend code'}
              </button>
            </div>
          </form>
        )}
      </section>
      <ul className="trust" aria-label="How we protect your sign-in">
        <li>Codes expire in 5 minutes and work only once</li>
        <li>5 wrong codes lock the number for 15 minutes</li>
        <li>Your number is stored encrypted and never shown to drivers</li>
      </ul>
      <p className="foot">By signing in you agree to NeerNow&apos;s terms and privacy policy.</p>
    </main>
  );
}
