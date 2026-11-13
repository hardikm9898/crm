import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, Card, PageHeader } from '@/components/ui';
import { readAccessToken } from '@/lib/session';
import { loadBlockCatalogue } from '@/lib/website-blocks';
import { loadVersions, loadWebsite, siteUrl } from '@/lib/websites';
import { BlockEditor } from '../_components/block-editor';
import { NewPageForm, PageActions, PublishControls, ThemeForm } from '../_components/site-forms';

/**
 * One site: its theme, its pages, and the blocks on each (`FR-WEB-2`, `FR-WEB-5`).
 *
 * The block catalogue is **fetched**, not imported. That is what makes "adding a block type needs
 * no editor change" a claim about a running deployment rather than about a rebuild: a type declared
 * in `packages/shared/src/website-blocks.ts` reaches this screen's controls through
 * `GET /websites/block-catalogue`, and the only other thing it needs is a renderer in the published
 * site's route.
 */
export default async function WebsitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = await readAccessToken();

  let site;
  try {
    site = await loadWebsite(token, id);
  } catch {
    // A malformed id, another tenant's id and a deleted one are indistinguishable by design — the
    // API answers 404 to all three so the shape of an id is not an oracle.
    notFound();
  }

  const [catalogue, versions] = await Promise.all([
    loadBlockCatalogue(token),
    loadVersions(token, id),
  ]);
  const pages = [...site.pages].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.path.localeCompare(b.path),
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={site.name}
        description={
          site.status === 'published'
            ? 'Live. Editing a page changes nothing a visitor sees until you publish.'
            : 'A draft. Nothing is public until you publish.'
        }
      />

      <Card
        title="Publishing"
        description={`Served at /s/${site.subdomain}`}
        action={
          site.status === 'published' ? (
            <Link href={siteUrl(site.subdomain)} className="text-sm underline">
              View the live site
            </Link>
          ) : (
            <Badge tone="neutral">Draft</Badge>
          )
        }
      >
        <PublishControls site={site} versions={versions} />
      </Card>

      <Card title="Theme" description="Colours and type for this site only.">
        <ThemeForm site={site} />
      </Card>

      <Card title="Add a page">
        <NewPageForm websiteId={site.id} />
      </Card>

      {pages.map((page) => (
        <Card
          key={page.id}
          title={`${page.title} · ${page.path}`}
          description={page.isHome ? 'The home page.' : undefined}
          action={
            <Badge tone={page.status === 'published' ? 'success' : 'neutral'}>
              {page.status === 'published' ? 'Published' : 'Draft'}
            </Badge>
          }
        >
          <div className="flex flex-col gap-4">
            <BlockEditor websiteId={site.id} page={page} catalogue={catalogue} />
            <PageActions websiteId={site.id} page={page} />
          </div>
        </Card>
      ))}
    </div>
  );
}
