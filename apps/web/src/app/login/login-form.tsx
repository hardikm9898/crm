'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorNotice } from '@/components/ui';

/**
 * Sign-in.
 *
 * Credentials are posted to this app's own route, which exchanges them with the API and sets an
 * httpOnly cookie — so no token is ever handled by JavaScript. The form surfaces the API's own
 * message, because those are already written for a person (rate limiting, for instance, says how
 * long to wait).
 */
export function LoginForm({ expired }: { expired: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(
    expired ? 'Your session expired. Please sign in again.' : null,
  );
  const [pending, setPending] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const response = await fetch('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const payload = (await response.json()) as {
        success: boolean;
        data?: { mfaRequired?: boolean };
        error?: { message: string };
      };

      if (!response.ok || !payload.success) {
        setError(payload.error?.message ?? 'Sign-in failed');
        return;
      }
      if (payload.data?.mfaRequired === true) {
        // Two-factor sign-in is completed on a dedicated screen; this keeps the form honest about
        // what happened rather than silently doing nothing.
        setMfaRequired(true);
        return;
      }

      router.replace('/dashboard');
      router.refresh();
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setPending(false);
    }
  }

  if (mfaRequired) {
    return (
      <ErrorNotice>
        This account uses two-factor authentication. Completing that step in the browser is not
        built yet — use the API directly for now.
      </ErrorNotice>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      {error && <ErrorNotice>{error}</ErrorNotice>}

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Email</span>
        <input
          type="email"
          name="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
        />
      </label>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Password</span>
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
        />
      </label>

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-[var(--color-primary-contrast)] hover:bg-[var(--color-primary-hover)] disabled:opacity-60"
      >
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
