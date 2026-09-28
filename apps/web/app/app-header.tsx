'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Brand } from './brand';

const LINKS = [
  { href: '/book', label: 'Book' },
  { href: '/orders', label: 'Orders' },
  { href: '/addresses', label: 'Addresses' },
  { href: '/account', label: 'Account' },
];

export function AppHeader() {
  const path = usePathname();
  return (
    <header className="app-header">
      <Link href="/book" className="brand-link" aria-label="NeerNow home">
        <Brand />
      </Link>
      <nav aria-label="Main">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} aria-current={path.startsWith(l.href) ? 'page' : undefined}>
            {l.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
