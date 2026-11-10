import type { ReactNode } from 'react';
import { isKnownBlockType, safeUrl, type BlockType } from '@/lib/websites';

/**
 * The render half of the block registry (`FR-WEB-2`).
 *
 * Phase 6's registry argument applies here and **its conclusion does not**, which is worth stating
 * rather than discovering: an automation action costs no frontend release because the editor draws
 * its parameters from a schema, while a block type costs a *renderer*, because a block is a layout
 * and a schema cannot describe one. So the honest boundary is one renderer per type and zero editor
 * code — the editor half arrives in step 3 and reads `BLOCK_TYPES` from here.
 *
 * **An unknown type renders nothing and does not fail.** A published site must not go blank
 * because somebody rolled back to a snapshot containing a block this release has never heard of,
 * and a visitor must not be shown our diagnostics either. So the block is skipped, the rest of the
 * page renders, and a zero-size marker is left for a browser check and the server log.
 *
 * **Everything tenant-authored is escaped by being passed as children.** The two exceptions are
 * URLs, which React will happily put in `href`/`src` including `javascript:` ones, so they go
 * through `safeUrl` — a tenant's own editor is not a trust boundary we get to skip, because the
 * person who pastes a link is not always the person who owns the workspace.
 */

interface RawBlock {
  readonly type?: unknown;
  readonly params?: unknown;
}

function params(block: RawBlock): Record<string, unknown> {
  return typeof block.params === 'object' && block.params !== null
    ? (block.params as Record<string, unknown>)
    : {};
}

function str(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function Heading({ p }: { p: Record<string, unknown> }): ReactNode {
  const text = str(p, 'text');
  if (text === null) return null;
  const level = p['level'] === 3 ? 3 : p['level'] === 1 ? 1 : 2;
  const className = 'text-balance font-semibold tracking-tight';
  if (level === 1) return <h1 className={`${className} text-3xl sm:text-4xl`}>{text}</h1>;
  if (level === 3) return <h3 className={`${className} text-lg`}>{text}</h3>;
  return <h2 className={`${className} text-2xl`}>{text}</h2>;
}

function Text({ p }: { p: Record<string, unknown> }): ReactNode {
  const body = str(p, 'body');
  if (body === null) return null;
  // Split on blank lines so a tenant's paragraphs survive, without accepting markup. A rich-text
  // block is a different block type and a different decision.
  const paragraphs = body.split(/\n{2,}/).filter((paragraph) => paragraph.trim().length > 0);
  return (
    <div className="flex flex-col gap-3 text-[color:var(--site-muted)]">
      {paragraphs.map((paragraph, index) => (
        <p key={index} className="text-base leading-relaxed">
          {paragraph}
        </p>
      ))}
    </div>
  );
}

function Hero({ p }: { p: Record<string, unknown> }): ReactNode {
  const heading = str(p, 'heading');
  const subheading = str(p, 'subheading');
  const ctaLabel = str(p, 'ctaLabel');
  const ctaHref = safeUrl(str(p, 'ctaHref'));
  if (heading === null && subheading === null) return null;
  return (
    <section className="flex flex-col items-start gap-4 py-6">
      {heading !== null && (
        <h1 className="text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
          {heading}
        </h1>
      )}
      {subheading !== null && (
        <p className="max-w-prose text-lg text-[color:var(--site-muted)]">{subheading}</p>
      )}
      {ctaLabel !== null && ctaHref !== null && (
        <a
          href={ctaHref}
          className="inline-flex min-h-11 items-center rounded-md bg-[color:var(--site-accent)] px-5 text-sm font-medium text-[color:var(--site-accent-contrast)]"
        >
          {ctaLabel}
        </a>
      )}
    </section>
  );
}

function Image({ p }: { p: Record<string, unknown> }): ReactNode {
  const src = safeUrl(str(p, 'src'));
  if (src === null) return null;
  // `alt` defaults to empty rather than to the filename: a decorative image with a filename for
  // alt text is worse for a screen reader than one correctly marked decorative.
  const alt = str(p, 'alt') ?? '';
  // A plain <img>, deliberately, not next/image: these are a tenant's own URLs on a tenant's own
  // domain, and the optimizer would need every one of them allowlisted in next.config. Width and height are
  // unknown here, so the box is fluid and `max-w-full` keeps it from widening the page — the
  // defect a browser check found at 375 px once already.
  return <img src={src} alt={alt} className="h-auto w-full max-w-full rounded-lg" loading="lazy" />;
}

function List({ p }: { p: Record<string, unknown> }): ReactNode {
  const raw = p['items'];
  if (!Array.isArray(raw)) return null;
  const items = raw.filter((item): item is string => typeof item === 'string' && item.length > 0);
  if (items.length === 0) return null;
  return (
    <ul className="flex list-disc flex-col gap-2 pl-5 text-[color:var(--site-muted)]">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

function WhatsAppCta({ p }: { p: Record<string, unknown> }): ReactNode {
  const phone = str(p, 'phone');
  const label = str(p, 'label') ?? 'Message us on WhatsApp';
  if (phone === null) return null;
  // E.164 without the plus is what wa.me takes. A number that is not digits produces no link
  // rather than a link to nothing — the same reasoning as `telHref` returning null in
  // `lib/lead-format.ts`, which already exists and is not re-implemented here.
  const digits = phone.replace(/[^0-9]/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return (
    <a
      href={`https://wa.me/${digits}`}
      className="inline-flex min-h-11 items-center rounded-md border border-[color:var(--site-accent)] px-5 text-sm font-medium text-[color:var(--site-accent)]"
    >
      {label}
    </a>
  );
}

const RENDERERS: Record<BlockType, (args: { p: Record<string, unknown> }) => ReactNode> = {
  heading: Heading,
  text: Text,
  hero: Hero,
  image: Image,
  list: List,
  whatsapp_cta: WhatsAppCta,
};

export function Blocks({ blocks }: { blocks: readonly unknown[] }): ReactNode {
  return (
    <>
      {blocks.map((raw, index) => {
        const block = (typeof raw === 'object' && raw !== null ? raw : {}) as RawBlock;
        if (!isKnownBlockType(block.type)) {
          // The rest of the page still renders. The marker is for a browser check and is invisible
          // and unfocusable, because a visitor must not be shown our diagnostics.
          return (
            <span
              key={index}
              hidden
              data-unknown-block={typeof block.type === 'string' ? block.type : 'malformed'}
            />
          );
        }
        const Renderer = RENDERERS[block.type];
        return <Renderer key={index} p={params(block)} />;
      })}
    </>
  );
}
