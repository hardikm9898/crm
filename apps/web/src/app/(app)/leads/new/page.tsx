import Link from 'next/link';
import { readAccessToken, requireCurrentUser, can } from '@/lib/session';
import { Card, PageHeader } from '@/components/ui';
import { loadOptions } from '@/lib/leads';
import { NewLeadForm } from './new-lead-form';
import { redirect } from 'next/navigation';

/**
 * Capturing a lead by hand.
 *
 * Its own route rather than a modal on the list: it is linkable, it survives a reload, and on a
 * phone a full screen is the right shape for eight fields (`NFR-UX-1`).
 */
export default async function NewLeadPage() {
  const user = await requireCurrentUser();
  // The API would refuse anyway; redirecting keeps someone from filling in a form that cannot be
  // submitted. This is not the authorization — that is server-side, on every write.
  if (!can(user, 'lead:create')) redirect('/leads');

  const token = await readAccessToken();
  const sources = await loadOptions('/crm/sources', token);

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
      <PageHeader
        title="New lead"
        description="Only a name and one way to reach them is required. Everything else can follow."
        action={
          <Link
            href="/leads"
            className="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            Cancel
          </Link>
        }
      />
      <Card>
        <NewLeadForm sources={sources.map((source) => ({ id: source.id, name: source.name }))} />
      </Card>
      <p className="text-sm text-[var(--color-text-muted)]">
        If this person is already in your workspace, the capture is added to their existing lead
        rather than making a second one — you will land on the record that already has their
        history.
      </p>
    </div>
  );
}
