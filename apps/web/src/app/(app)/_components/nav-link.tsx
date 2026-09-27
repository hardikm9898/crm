'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * A navigation row that knows whether it is the current page.
 *
 * Items whose module lands in a later phase render as inert text with the phase named, rather than
 * a link that 404s — an honest "not yet" beats a dead end.
 */
export function NavLink({
  href,
  phase,
  children,
}: {
  href: string;
  phase?: number;
  children: ReactNode;
}) {
  const pathname = usePathname();

  if (phase !== undefined) {
    return (
      <span
        aria-disabled="true"
        title={`Arrives in phase ${phase}`}
        className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm text-[var(--color-text-muted)]/70"
      >
        {children}
        <span className="text-[0.625rem] uppercase tracking-wide">P{phase}</span>
      </span>
    );
  }

  // `/settings` must not light up while `/settings/members` is open, so the match is exact except
  // for genuinely nested detail routes, which are not introduced until phase 2.
  const current = pathname === href;

  return (
    <Link
      href={href}
      aria-current={current ? 'page' : undefined}
      className={`block rounded-md px-2 py-1.5 text-sm transition-colors ${
        current
          ? 'bg-[var(--color-primary)]/10 font-medium text-[var(--color-primary)]'
          : 'text-[var(--color-text)] hover:bg-[var(--color-surface-muted)]'
      }`}
    >
      {children}
    </Link>
  );
}
