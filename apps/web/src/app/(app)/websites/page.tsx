import Link from 'next/link';
import { Badge, Card, DataTable, EmptyState, PageHeader } from '@/components/ui';
import { readAccessToken } from '@/lib/session';
import { loadWebsites, siteUrl } from '@/lib/websites';
import { NewWebsiteForm } from './_components/site-forms';

/**
 * The sites a workspace has (`FR-WEB-1`).
 *
 * A server component with no cache: this is one tenant's data read with one person's token, which
 * is why `request()` defaults to `no-store` and why the published-site renderer is the only caller
 * in this app that opts out of it.
 */
export default async function WebsitesPage() {
  const token = await readAccessToken();
  const sites = await loadWebsites(token);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Websites"
        description="Build a site, publish it, and roll it back if you need to."
      />

      {sites.length === 0 ? (
        <EmptyState
          title="No sites yet"
          description="A site starts as a draft with one page. Nothing is public until you publish it."
        />
      ) : (
        <Card title="Your sites">
          <DataTable columns={['Name', 'Address', 'Status', 'Pages']}>
            {sites.map((site) => (
              <tr key={site.id} data-site-row={site.subdomain}>
                <td className="py-2.5 pr-4">
                  <Link
                    href={`/websites/${site.id}`}
                    className="font-medium text-[var(--color-primary)]"
                  >
                    {site.name}
                  </Link>
                </td>
                <td className="py-2.5 pr-4">
                  {/*
                    The address a published site is served at today. Host-based routing, so that
                    `acme.leados.app` resolves, is step 6's — and a draft's address is not a link,
                    because following it would answer 404 and read as the product being broken.
                  */}
                  {site.status === 'published' ? (
                    <Link href={siteUrl(site.subdomain)} className="underline">
                      /s/{site.subdomain}
                    </Link>
                  ) : (
                    <span className="text-[var(--color-text-muted)]">/s/{site.subdomain}</span>
                  )}
                </td>
                <td className="py-2.5 pr-4">
                  <Badge tone={site.status === 'published' ? 'success' : 'neutral'}>
                    {site.status === 'published' ? 'Live' : 'Draft'}
                  </Badge>
                </td>
                <td className="py-2.5 pr-4 text-[var(--color-text-muted)]">
                  {site.status === 'published' ? 'Published' : 'Not published'}
                </td>
              </tr>
            ))}
          </DataTable>
        </Card>
      )}

      <Card title="Add a site" description="The address can be changed later.">
        <NewWebsiteForm />
      </Card>
    </div>
  );
}
