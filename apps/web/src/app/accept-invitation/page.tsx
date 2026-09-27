import type { Metadata } from 'next';
import Link from 'next/link';
import { ErrorNotice } from '@/components/ui';
import { AcceptForm } from './accept-form';

export const metadata: Metadata = { title: 'Accept your invitation · Lead OS' };

/**
 * The page an invitation email links to.
 *
 * It exists because the API's invitation mail points at `WEB_ORIGIN/accept-invitation?token=…` —
 * a link with nothing behind it is the same as not having sent the invitation at all.
 *
 * The token is never rendered into a link or a `GET` that a proxy or browser history would keep: it
 * goes into a hidden field and is spent by a POST.
 */
export default async function AcceptInvitationPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-4 py-10">
      <div>
        <h1 className="text-lg font-semibold">Accept your invitation</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          You have been invited to a Lead OS workspace.
        </p>
      </div>

      {token ? (
        <AcceptForm token={token} />
      ) : (
        <>
          <ErrorNotice>
            This link is missing its invitation code. Open the link from your invitation email
            again, or ask whoever invited you to send a new one.
          </ErrorNotice>
          <Link href="/login" className="text-sm text-[var(--color-primary)]">
            Sign in instead
          </Link>
        </>
      )}
    </main>
  );
}
