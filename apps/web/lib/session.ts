'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, PublicUser } from './api';

/** Loads the signed-in user; sends signed-out visitors to the login page and back here afterwards. */
export function useRequireUser() {
  const router = useRouter();
  const path = usePathname();
  const [user, setUser] = useState<PublicUser | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .me()
      .then((u) => (u ? setUser(u) : router.replace(`/login?next=${encodeURIComponent(path)}`)))
      .catch(() => setError('Could not reach NeerNow. Check your connection and refresh the page.'));
  }, [router, path]);

  return { user, error };
}
