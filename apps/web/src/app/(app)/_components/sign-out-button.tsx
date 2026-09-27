'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Signing out clears this app's access cookie *and* asks the API to revoke the refresh token —
 * dropping only the cookie would leave a session alive that someone else could still renew.
 */
export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onClick(): Promise<void> {
    setPending(true);
    try {
      await fetch('/api/session', { method: 'DELETE' });
    } finally {
      router.replace('/login');
      router.refresh();
    }
  }

  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={pending}
      className="mt-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-60"
    >
      {pending ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
