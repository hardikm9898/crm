import Link from 'next/link';
import type { ReactNode } from 'react';
import { request } from '@/lib/api';
import { readAccessToken, requireCurrentUser } from '@/lib/session';
import { visibleSections } from '@/lib/nav';
import { NavLink } from './_components/nav-link';
import { OrgSwitcher } from './_components/org-switcher';
import { SignOutButton } from './_components/sign-out-button';

/**
 * The authenticated shell.
 *
 * A server component: it resolves the session, the navigation and the notification badge before any
 * HTML is sent, so there is no authenticated-looking skeleton that then bounces to sign-in. The
 * only client components below are the ones that genuinely need interactivity — the organization
 * switcher, the sign-out button and the active-link highlight.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireCurrentUser();
  const sections = visibleSections(user);
  const unread = await unreadCount();

  const active = user.organizations.find(
    (organization) => organization.id === user.activeOrganizationId,
  );

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <aside className="flex shrink-0 flex-col gap-4 border-b border-[var(--color-border)] bg-[var(--color-surface-raised)] px-4 py-4 lg:w-64 lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between gap-2">
          <Link href="/dashboard" className="text-sm font-semibold tracking-tight">
            Lead OS
          </Link>
          {unread > 0 && (
            <Link
              href="/notifications"
              aria-label={`${unread} unread notifications`}
              className="inline-flex min-w-5 items-center justify-center rounded-full bg-[var(--color-primary)] px-1.5 py-0.5 text-xs font-semibold text-[var(--color-primary-contrast)]"
            >
              {unread > 99 ? '99+' : unread}
            </Link>
          )}
        </div>

        <OrgSwitcher
          organizations={user.organizations}
          activeOrganizationId={user.activeOrganizationId}
        />

        <nav aria-label="Main" className="flex flex-1 flex-col gap-4">
          {sections.map((section) => (
            <div key={section.heading}>
              <p className="px-2 pb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                {section.heading}
              </p>
              <ul className="flex flex-col gap-0.5">
                {section.items.map((item) => (
                  <li key={item.href}>
                    <NavLink href={item.href} phase={item.phase}>
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-[var(--color-border)] pt-3">
          <p className="truncate text-sm font-medium">{user.user.name}</p>
          <p className="truncate text-xs text-[var(--color-text-muted)]">{user.user.email}</p>
          {active && (
            <p className="mt-0.5 truncate text-xs text-[var(--color-text-muted)]">{active.name}</p>
          )}
          <SignOutButton />
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-4 py-6 lg:px-8">{children}</main>
    </div>
  );
}

/**
 * The badge must never break the shell: a notification table that is unreachable is a reason to
 * show no badge, not to fail the page the person asked for.
 */
async function unreadCount(): Promise<number> {
  const token = await readAccessToken();
  if (!token) return 0;
  try {
    const response = await request<{ unreadCount: number }>('/notifications/unread-count', {
      token,
    });
    return response.data.unreadCount;
  } catch {
    return 0;
  }
}
