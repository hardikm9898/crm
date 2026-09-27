'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { controlClassName } from '@/components/ui';

/**
 * Switching organization.
 *
 * The switch is a server round-trip, not a client-side filter: the access token carries the active
 * organization, so a new token has to be minted and the cookie replaced. That is exactly why there
 * is no "all organizations" option — one request belongs to one tenant, by construction
 * (docs/security.md §3).
 */
export function OrgSwitcher({
  organizations,
  activeOrganizationId,
}: {
  organizations: { id: string; name: string; status: string }[];
  activeOrganizationId: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One organization is the common case; a static label beats a select with a single option.
  if (organizations.length < 2) {
    const only = organizations[0];
    return (
      <p className="truncate rounded-md border border-[var(--color-border)] px-2 py-1.5 text-sm font-medium">
        {only?.name ?? 'No workspace'}
      </p>
    );
  }

  async function onChange(organizationId: string): Promise<void> {
    if (organizationId === activeOrganizationId) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/session/switch-org', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId }),
      });
      const payload = (await response.json()) as {
        success: boolean;
        error?: { message: string };
      };
      if (!response.ok || !payload.success) {
        setError(payload.error?.message ?? 'Could not switch workspace');
        return;
      }
      // Everything on screen belongs to the previous tenant, so the whole tree is refetched.
      router.replace('/dashboard');
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="sr-only" htmlFor="org-switcher">
        Workspace
      </label>
      <select
        id="org-switcher"
        value={activeOrganizationId}
        disabled={pending}
        onChange={(event) => void onChange(event.target.value)}
        className={`${controlClassName} py-1.5 disabled:opacity-60`}
      >
        {organizations.map((organization) => (
          <option key={organization.id} value={organization.id}>
            {organization.name}
            {organization.status === 'active' ? '' : ` (${organization.status})`}
          </option>
        ))}
      </select>
      {error && (
        <p role="alert" className="text-xs text-[var(--color-danger)]">
          {error}
        </p>
      )}
    </div>
  );
}
