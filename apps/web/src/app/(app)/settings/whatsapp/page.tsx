import Link from 'next/link';
import { apiBaseUrl, describeError } from '@/lib/api';
import { can, readAccessToken, requireCurrentUser } from '@/lib/session';
import { Badge, Card, EmptyState, ErrorNotice, PageHeader, StatCard } from '@/components/ui';
import { loadMembers } from '@/lib/leads';
import { loadConnections, type ConnectionRecord } from '@/lib/integrations';
import { loadWhatsAppAccountsOrThrow, type WhatsAppAccount } from '@/lib/whatsapp';
import { ConnectWabaForm, DefaultAgentForm } from './_components/whatsapp-forms';

/**
 * WhatsApp: the account, its numbers, and who answers them (`FR-WA-2`).
 *
 * The credential is **not** on this screen. It belongs to the integration framework, which already
 * stores it, rotates it, probes it and prints the callback URL Meta posts to — a second form for
 * the same secret would be a second answer to one question. What is here is the part that is about
 * WhatsApp: which numbers the token can see, and which of this workspace's people answers each.
 *
 * Read through the **throwing** loader. On a screen whose whole job is to list the numbers a
 * workspace has connected, "none" is information somebody acts on, and a swallowed failure would
 * tell a business with a live number to go and connect one.
 */
export const dynamic = 'force-dynamic';

export default async function WhatsAppSettingsPage() {
  const user = await requireCurrentUser();
  const token = await readAccessToken();

  if (!can(user, 'whatsapp:manage')) {
    return (
      <>
        <PageHeader title="WhatsApp" />
        <ErrorNotice>Your role does not include this workspace’s WhatsApp setup.</ErrorNotice>
      </>
    );
  }

  let accounts: { items: WhatsAppAccount[]; numbers: number };
  let connections: ConnectionRecord[];
  try {
    [accounts, connections] = await Promise.all([
      loadWhatsAppAccountsOrThrow(token),
      loadConnections(token, '?provider=whatsapp_cloud'),
    ]);
  } catch (error) {
    return (
      <>
        <PageHeader title="WhatsApp" />
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </>
    );
  }

  // The members list only fills a dropdown, so it is swallowed: a screen that will not open
  // because a vocabulary request failed is worse than one whose select has nothing to offer.
  const members = await loadMembers(token);
  const live = connections.filter((connection) => connection.disconnectedAt === null);
  const base = apiBaseUrl().replace(/\/$/, '');

  return (
    <>
      <PageHeader
        title="WhatsApp"
        description="The business numbers people message, and who picks them up."
      />

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard
          label="Accounts"
          value={String(accounts.items.length)}
          hint="WhatsApp Business Accounts."
        />
        <StatCard label="Numbers" value={String(accounts.numbers)} hint="Across every account." />
        <StatCard
          label="Connections"
          value={String(live.length)}
          hint="Credentials this workspace holds."
        />
      </div>

      {live.length === 0 ? (
        <Card title="Start with the credential">
          <EmptyState
            title="No WhatsApp connection yet"
            description="WhatsApp Cloud needs an app secret and an access token, which live with the other integrations — along with the callback URL you paste into Meta and the verify phrase it checks."
            action={
              <Link href="/settings/integrations" className="text-sm text-[var(--color-primary)]">
                Connect WhatsApp Cloud →
              </Link>
            }
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {live.map((connection) => {
            const account = accounts.items.find((row) => row.connectionId === connection.id);
            return (
              <Card
                key={connection.id}
                title={connection.name}
                description={
                  account
                    ? `${account.businessName ?? 'WhatsApp Business Account'} · ${account.wabaId}`
                    : 'Connected, but its numbers have not been read from WhatsApp yet.'
                }
                action={
                  <ConnectWabaForm
                    connectionId={connection.id}
                    connectionName={connection.name}
                    alreadyConnected={account !== undefined}
                  />
                }
              >
                {/* The URL Meta posts to, printed where somebody setting this up is looking. It is
                    the integration's own door — one address, not a second one for WhatsApp. */}
                <p className="mb-3 break-all text-xs text-[var(--color-text-muted)]">
                  Callback URL: <code>{`${base}/api/v1/wh/whatsapp_cloud/${connection.id}`}</code>
                </p>

                {account === undefined ? (
                  <p className="text-sm text-[var(--color-text-muted)]">
                    Press connect and we will ask WhatsApp which numbers this token can see. Nothing
                    is stored until it answers — a token that cannot read the account is a
                    connection that would receive nothing.
                  </p>
                ) : account.numbers.length === 0 ? (
                  <p className="text-sm text-[var(--color-text-muted)]">
                    WhatsApp reported no numbers on this account. Add one in Meta’s dashboard, then
                    refresh.
                  </p>
                ) : (
                  <ul className="flex flex-col divide-y divide-[var(--color-border)]/60">
                    {account.numbers.map((number) => (
                      <li
                        key={number.id}
                        className="flex flex-col gap-2 py-3"
                        data-number={number.id}
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <div>
                            {/* Printed as text, not only inside the editor below it: a settings
                                list whose values live only in inputs is unreadable at a glance and
                                unassertable by a browser check. */}
                            <p className="text-sm font-medium" data-number-phone={number.id}>
                              {number.displayPhoneE164}
                            </p>
                            <p className="text-xs text-[var(--color-text-muted)]">
                              {number.verifiedName ?? 'No verified name'} · quality{' '}
                              {number.qualityRating ?? 'unknown'} · tier{' '}
                              {number.messagingLimitTier ?? 'unknown'}
                            </p>
                          </div>
                          {number.isActive ? (
                            <Badge tone="success">Active</Badge>
                          ) : (
                            // Kept rather than deleted: a conversation references it, and what
                            // arrived at a number the business no longer has is still the history.
                            <Badge tone="warning">No longer on this account</Badge>
                          )}
                        </div>
                        <DefaultAgentForm number={number} members={members} />
                      </li>
                    ))}
                  </ul>
                )}

                {account?.lastError && (
                  <p
                    className="mt-3 text-xs text-[var(--color-danger)]"
                    data-account-error={account.id}
                  >
                    {account.lastError}
                  </p>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
