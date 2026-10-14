import Link from 'next/link';
import { apiBaseUrl, describeError, request } from '@/lib/api';
import { can, readAccessToken, requireCurrentUser } from '@/lib/session';
import { Card, ErrorNotice, PageHeader } from '@/components/ui';
import { curlSnippet, loadApiKeys, type ApiKeyRecord } from '@/lib/ingestion';
import { ApiKeyRow, NewApiKeyForm } from './_components/api-key-forms';

/**
 * The keys somebody else's program uses to post leads in here (`FR-CAP-7`, `FR-API-2`).
 *
 * Behind `api_key:manage`, which has been in the catalogue since Phase 1 with nothing reading it.
 * There is no read-only view: the list is prefixes, usage and limits, which is exactly what
 * somebody holding this permission needs and nobody else does.
 *
 * Read through the **throwing** loader. On a screen whose job is to list credentials, a swallowed
 * failure would say "no keys yet" to a workspace whose integration is live — and the obvious next
 * action from that screen is to create a second key and wonder why neither works.
 */
export const dynamic = 'force-dynamic';

interface OrganizationSummary {
  name: string;
  publicKey: string;
}

export default async function ApiKeysPage() {
  const user = await requireCurrentUser();
  const token = await readAccessToken();

  if (!can(user, 'api_key:manage')) {
    return (
      <>
        <PageHeader title="Lead API keys" />
        <ErrorNotice>Your role does not include this workspace’s API keys.</ErrorNotice>
      </>
    );
  }

  let keys: ApiKeyRecord[];
  let organization: OrganizationSummary;
  try {
    [keys, organization] = await Promise.all([
      loadApiKeys(token),
      request<OrganizationSummary>('/organization', { token }).then((page) => page.data),
    ]);
  } catch (error) {
    return (
      <>
        <PageHeader title="Lead API keys" />
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </>
    );
  }

  const live = keys.filter((key) => key.isLive);

  return (
    <>
      <PageHeader
        title="Lead API keys"
        description="For a website’s server, a Zapier step or an agency’s integration — anything that posts leads in without a person filling a form."
      />

      <p className="mb-4 text-sm text-[var(--color-text-muted)]" data-keys-summary>
        {keys.length === 0
          ? 'No keys yet. Create one to let an integration post leads into this workspace.'
          : `${keys.length} ${keys.length === 1 ? 'key' : 'keys'}, ${live.length} of them live.`}
      </p>

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <div className="flex flex-col gap-5">
          <Card
            title="The keys"
            description="Rotating gives the same integration a new secret. Revoking stops it, and keeps the record of what it sent."
          >
            {keys.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">
                Nothing yet — the form on the right makes the first one.
              </p>
            ) : (
              <div className="flex flex-col">
                {keys.map((key) => (
                  <ApiKeyRow key={key.id} apiKey={key} />
                ))}
              </div>
            )}
          </Card>

          <Card
            title="Sending a lead"
            description="Each request is signed: an HMAC-SHA256 of the timestamp and the exact bytes of the body, valid for five minutes either way."
          >
            <pre
              className="overflow-x-auto rounded-md bg-[var(--color-surface-muted)] p-3 text-xs"
              data-curl-snippet
            >
              {curlSnippet({
                baseUrl: apiBaseUrl(),
                organizationPublicKey: organization.publicKey,
              })}
            </pre>
            <p className="mt-3 text-sm text-[var(--color-text-muted)]">
              Unknown fields are kept rather than refused — they arrive on{' '}
              <Link href="/ingestion" className="underline">
                the integration log
              </Link>
              , where one click turns one into a field of its own.
            </p>
          </Card>
        </div>

        <Card title="Create a key" description="The secret is shown once, here, and never again.">
          <NewApiKeyForm />
        </Card>
      </div>
    </>
  );
}
