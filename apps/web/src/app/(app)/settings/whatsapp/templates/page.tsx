import Link from 'next/link';
import { describeError } from '@/lib/api';
import { can, readAccessToken, requireCurrentUser } from '@/lib/session';
import { Card, EmptyState, ErrorNotice, PageHeader, StatCard } from '@/components/ui';
import {
  loadTemplates,
  loadWhatsAppAccountsOrThrow,
  type WhatsAppAccount,
  type WhatsAppTemplate,
} from '@/lib/whatsapp';
import { NewTemplateForm, SyncTemplatesForm, TemplateRow } from './_components/template-forms';

/**
 * WhatsApp templates (`FR-WA-5`).
 *
 * The screen for the one thing that can reach somebody outside the 24-hour window. Three decisions
 * are visible on it:
 *
 *  * **Only an approved template can be sent, and the screen says why not.** Each row carries
 *    WhatsApp's standing and, when it is anything other than approved, the sentence that explains
 *    it — "WhatsApp is still reviewing this", "WhatsApp rejected it: too promotional". A greyed
 *    button with no explanation is how somebody concludes the product is broken.
 *  * **A draft is editable and a submitted template is not.** Meta has no edit, so the honest
 *    options are "submit a new one" or "a local copy that disagrees with what is sent"; the second
 *    is the kind of quiet divergence this codebase keeps paying for.
 *  * **Meta's word is reconciled, not remembered.** The sweep runs every six hours and this screen
 *    has the button for somebody who has just been approved and does not want to wait.
 *
 * Read through the **throwing** loader: on a screen whose whole job is to list templates, "none" is
 * information somebody acts on, and a swallowed failure would tell a workspace with ten approved
 * templates to go and write their first.
 */
export const dynamic = 'force-dynamic';

export default async function WhatsAppTemplatesPage() {
  const user = await requireCurrentUser();
  const token = await readAccessToken();

  if (!can(user, 'whatsapp:manage')) {
    return (
      <>
        <PageHeader title="WhatsApp templates" />
        <ErrorNotice>Your role does not include this workspace’s WhatsApp setup.</ErrorNotice>
      </>
    );
  }

  let accounts: { items: WhatsAppAccount[]; numbers: number };
  let templates: { items: WhatsAppTemplate[]; approved: number };
  try {
    [accounts, templates] = await Promise.all([
      loadWhatsAppAccountsOrThrow(token),
      loadTemplates(token, '?limit=100'),
    ]);
  } catch (error) {
    return (
      <>
        <PageHeader title="WhatsApp templates" />
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </>
    );
  }

  const account = accounts.items[0] ?? null;

  return (
    <>
      <PageHeader
        title="WhatsApp templates"
        description="The messages you can send somebody outside the 24-hour reply window. WhatsApp approves each one before it can be used."
      />

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard
          label="Templates"
          value={String(templates.items.length)}
          hint="Including drafts."
        />
        <StatCard
          label="Approved"
          value={String(templates.approved)}
          hint="The ones an agent can actually send."
        />
        <StatCard
          label="Waiting"
          value={String(templates.items.filter((template) => template.status === 'pending').length)}
          hint="With WhatsApp for review."
        />
      </div>

      {account === null ? (
        <Card title="Connect a number first">
          <EmptyState
            title="No WhatsApp account yet"
            description="A template belongs to a WhatsApp Business Account, so there is nothing to write one against until a number is connected."
            action={
              <Link href="/settings/whatsapp" className="text-sm text-[var(--color-primary)]">
                Set up WhatsApp →
              </Link>
            }
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <Card
            title="Your templates"
            description="WhatsApp decides which of these can be sent. We ask it every six hours."
            action={<SyncTemplatesForm accountId={account.id} />}
          >
            {templates.items.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">
                None yet. Write one below — a short, specific message about something the customer
                asked for is the kind WhatsApp approves quickest.
              </p>
            ) : (
              <div className="flex flex-col">
                {templates.items.map((template) => (
                  <TemplateRow key={template.id} template={template} />
                ))}
              </div>
            )}
          </Card>

          <Card
            title="Write a template"
            description="Saved as a draft first. Nothing is sent to WhatsApp until you submit it, and nothing can be edited after that — WhatsApp has no edit, so a new version is a new template."
          >
            <NewTemplateForm accountId={account.id} />
          </Card>
        </div>
      )}
    </>
  );
}
