import Link from 'next/link';
import { apiBaseUrl, describeError } from '@/lib/api';
import { can, readAccessToken, requireCurrentUser } from '@/lib/session';
import { Card, EmptyState, ErrorNotice, PageHeader, StatCard } from '@/components/ui';
import { relativeWhen } from '@/lib/forms';
import {
  OUTCOME_LABELS,
  describeIntegrations,
  loadConnections,
  loadHealthChecks,
  loadProviders,
  needsReconnect,
  type ConnectionRecord,
  type HealthCheckRow,
  type ProviderOption,
} from '@/lib/integrations';
import { ConnectForm, ConnectionRow, ProviderCard } from './_components/integration-forms';

/**
 * The providers this workspace has connected (Phase 4's integration framework).
 *
 * Behind `integration:manage`, which has been in the catalogue since Phase 1 with nothing reading
 * it. There is no read-only view: a connection holds a credential, and its field mapping decides
 * where every lead it brings in lands — somebody who may read those may change them.
 *
 * The order is the order somebody uses it: what is connected and how it is doing, then what else
 * there is, then the form that connects one. The health history is last because it is the thing
 * read when something is wrong rather than every time.
 *
 * Read through the **throwing** loaders: on a screen whose job is to list connections, a swallowed
 * failure would say "nothing connected" to a workspace whose integration is live, and the obvious
 * next action from that screen is to connect a second one.
 */
export const dynamic = 'force-dynamic';

export default async function IntegrationsPage() {
  const user = await requireCurrentUser();
  const token = await readAccessToken();

  if (!can(user, 'integration:manage')) {
    return (
      <>
        <PageHeader title="Integrations" />
        <ErrorNotice>Your role does not include this workspace’s integrations.</ErrorNotice>
      </>
    );
  }

  let providers: ProviderOption[];
  let connections: ConnectionRecord[];
  let checks: (HealthCheckRow & { connection: { id: string; provider: string; name: string } })[];
  try {
    [providers, connections, checks] = await Promise.all([
      loadProviders(token),
      loadConnections(token),
      loadHealthChecks(token),
    ]);
  } catch (error) {
    return (
      <>
        <PageHeader title="Integrations" />
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </>
    );
  }

  const apiBase = apiBaseUrl();
  const attention = connections.filter(
    (connection) => needsReconnect(connection.status) || connection.status === 'error',
  );
  const available = providers.filter((provider) => provider.connection === null);
  const providerOf = (key: string) => providers.find((provider) => provider.key === key);

  return (
    <>
      <PageHeader
        title="Integrations"
        description="The services this workspace is connected to — the credential each one holds, whether it is working, and how their field names become yours."
        action={
          <Link href="/settings/webhooks" className="text-sm underline">
            Sending events out instead?
          </Link>
        }
      />

      <p className="mb-4 text-sm text-[var(--color-text-muted)]" data-integrations-summary>
        {describeIntegrations({
          connected: connections.length,
          needsAttention: attention.length,
          available: available.length,
        })}
      </p>

      {connections.length > 0 && (
        <div className="mb-5 grid gap-3 sm:grid-cols-3">
          <StatCard
            label="Connected"
            value={connections.length}
            hint={`${available.length} more available.`}
          />
          <StatCard
            label="Need attention"
            value={attention.length}
            hint="A refused credential stops everything it carries."
          />
          <StatCard
            label="Checks kept"
            value={checks.length}
            hint="So “failing since Tuesday” has an answer."
          />
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
        <div className="flex flex-col gap-5">
          <Card
            title="What is connected"
            description="A credential is stored encrypted and never shown again. Disconnecting keeps everything it brought in."
          >
            {connections.length === 0 ? (
              <EmptyState
                title="Nothing connected yet"
                description="Connect a provider on the right. A provider that sends us leads gets a signing secret and an address; one we send to gets checked every ten minutes."
              />
            ) : (
              <div className="flex flex-col">
                {connections.map((connection) => (
                  <ConnectionRow
                    key={connection.id}
                    connection={connection}
                    provider={providerOf(connection.provider)}
                    apiBase={apiBase}
                  />
                ))}
              </div>
            )}
          </Card>

          <Card
            title="Every check we have made"
            description="A provider that answers is timed; one that refuses the credential needs somebody to reconnect it."
          >
            {checks.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">
                Nothing checked yet. Only a provider we send to can be checked — one that posts to
                us is working when something arrives.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-[var(--color-border)]/60">
                {checks.map((check, index) => (
                  <li
                    key={`${check.connection.id}-${check.checkedAt}-${index}`}
                    className="py-2 text-sm"
                    data-health-check={check.connection.id}
                  >
                    {check.connection.name} · {OUTCOME_LABELS[check.outcome]} ·{' '}
                    {check.latencyMs === null ? 'no answer' : `${check.latencyMs} ms`} ·{' '}
                    {relativeWhen(check.checkedAt)}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-5">
          <Card
            title="Connect a provider"
            description="The form asks for whatever that provider needs. If we generate the secret, it is shown once, here."
          >
            <ConnectForm providers={providers} apiBase={apiBase} />
          </Card>

          <Card
            title="What we can connect"
            description="Each one arrives with its own credential, its own checks and, where it brings leads in, its own field mapping."
          >
            <div className="flex flex-col divide-y divide-[var(--color-border)]/60">
              {providers.map((provider) => (
                <ProviderCard key={provider.key} provider={provider} />
              ))}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
