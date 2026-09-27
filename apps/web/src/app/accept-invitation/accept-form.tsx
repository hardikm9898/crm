'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button, ErrorNotice, Field, controlClassName } from '@/components/ui';

/**
 * Accepting an invitation.
 *
 * Whether a name and password are needed depends on something this page cannot see: whether the
 * invited email already has a Lead OS account. Rather than leak that ("this email already exists"
 * is an account-enumeration answer), both fields are offered as optional and the API decides — it
 * returns a field error naming `password` when they are actually required.
 */
export function AcceptForm({ token }: { token: string }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const response = await fetch('/api/session/accept-invitation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token,
          ...(name.trim() === '' ? {} : { name: name.trim() }),
          ...(password === '' ? {} : { password }),
        }),
      });
      const payload = (await response.json()) as {
        success: boolean;
        error?: { message: string };
      };
      if (!response.ok || !payload.success) {
        setError(payload.error?.message ?? 'This invitation could not be accepted.');
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

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      {error && <ErrorNotice>{error}</ErrorNotice>}

      <p className="text-sm text-[var(--color-text-muted)]">
        If this is your first Lead OS account, choose a name and password. If you already have one,
        leave them blank — accepting adds the new workspace to your existing account.
      </p>

      <Field label="Your name">
        <input
          name="name"
          autoComplete="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className={controlClassName}
        />
      </Field>

      <Field label="Password" hint="At least 10 characters.">
        <input
          type="password"
          name="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={controlClassName}
        />
      </Field>

      <Button type="submit" pending={pending}>
        {pending ? 'Accepting…' : 'Accept invitation'}
      </Button>

      <Link href="/login" className="text-sm text-[var(--color-text-muted)]">
        Sign in instead
      </Link>
    </form>
  );
}
