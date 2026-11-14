'use client';

import { useActionState } from 'react';
import { Badge, Button, ErrorNotice, Field, controlClassName } from '@/components/ui';
import { IDLE, type ActionState } from '@/lib/action-state';
import type { RedirectRow, WebsiteDetail, WebsitePageRow } from '@/lib/websites';
import { addRedirect, removeRedirect, savePageSeo, saveSiteSeo } from '../actions';

/**
 * The SEO screens (`FR-WEB-3`).
 *
 * Nothing here validates. Every rule — the title ceiling, "a canonical must be absolute", which
 * kinds of business exist — lives in `@leados/shared` and is enforced by the API, and this file
 * prints what comes back against the control it names. A second copy of those rules in a client
 * component is the `ERROR_COPY` shape in a field: two answers to one question, and the one that is
 * wrong is the one nothing runs.
 *
 * The `maxLength` attributes are the exception and are not validation: they stop somebody typing
 * four hundred characters into a box that will refuse them, which is a courtesy rather than a rule.
 */

function errorAt(state: ActionState, field: string): string | undefined {
  return state.status === 'error' ? state.fieldErrors?.[field] : undefined;
}

function echoed(state: ActionState, field: string): string | undefined {
  return state.status === 'error' ? state.values?.[field] : undefined;
}

function Result({ state }: { state: ActionState }) {
  if (state.status === 'error' && state.message !== undefined) {
    return <ErrorNotice>{state.message}</ErrorNotice>;
  }
  if (state.status === 'success' && state.message !== undefined) {
    return (
      <p className="text-sm text-[var(--color-success)]" role="status">
        {state.message}
      </p>
    );
  }
  return null;
}

/** A string out of a tenant-authored JSON blob, or `''`. */
function str(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

function flag(source: Record<string, unknown>, key: string): boolean {
  return source[key] === true;
}

export function PageSeoForm({
  websiteId,
  page,
  products,
}: {
  websiteId: string;
  page: WebsitePageRow;
  products: { items: { id: string; name: string }[] } | { unavailable: true };
}) {
  const [state, action, pending] = useActionState(savePageSeo, IDLE);
  const seo = page.seo ?? {};
  // The echo wins over the stored value, so a refusal does not mean retyping eight fields. A
  // server action re-renders the server tree and remounts the form, which empties every
  // uncontrolled input.
  const value = (field: string, key: string): string => echoed(state, field) ?? str(seo, key);

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="websiteId" value={websiteId} />
      <input type="hidden" name="pageId" value={page.id} />

      <Field
        label="Title for search results"
        hint={`Leave empty to use “${page.title} · your site name”.`}
        error={errorAt(state, 'seo.title')}
      >
        <input
          name="seoTitle"
          maxLength={70}
          defaultValue={value('seoTitle', 'title')}
          className={controlClassName}
          data-seo-field="title"
        />
      </Field>

      <Field
        label="Description"
        hint="The sentence under the title in a search result. Left empty, the first words of the page are used."
        error={errorAt(state, 'seo.description')}
      >
        <textarea
          name="seoDescription"
          rows={2}
          maxLength={320}
          defaultValue={value('seoDescription', 'description')}
          className={controlClassName}
          data-seo-field="description"
        />
      </Field>

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex-1">
          <Field
            label="Sharing image"
            hint="Shown when the page is shared. Needs the full address, starting with https://."
            error={errorAt(state, 'seo.ogImageUrl')}
          >
            <input
              name="seoOgImageUrl"
              maxLength={500}
              defaultValue={value('seoOgImageUrl', 'ogImageUrl')}
              className={`${controlClassName} w-full min-w-0`}
              data-seo-field="ogImageUrl"
            />
          </Field>
        </div>
        <div className="flex-1">
          <Field
            label="Canonical address"
            hint="Only if this page also exists somewhere else and that copy is the original."
            error={errorAt(state, 'seo.canonicalUrl')}
          >
            <input
              name="seoCanonicalUrl"
              maxLength={500}
              defaultValue={value('seoCanonicalUrl', 'canonicalUrl')}
              className={`${controlClassName} w-full min-w-0`}
              data-seo-field="canonicalUrl"
            />
          </Field>
        </div>
      </div>

      {'unavailable' in products ? (
        // Not an empty picker. "There are no products" and "you cannot see the products" are
        // different answers, and rendering the first when the second is true is a lie about the
        // workspace — the defect `loadProducts`' catch produced on the settings screen.
        <p className="text-xs text-[var(--color-text-muted)]">
          Linking a product needs access to the product catalogue, which this account does not have.
        </p>
      ) : (
        <Field
          label="Product this page is about"
          hint="Adds price and availability for search engines. The price is read from your catalogue when the page is served, so it never goes stale."
          error={errorAt(state, 'seo.productId')}
        >
          <select
            name="seoProductId"
            // `key` + `defaultValue`, not `value`. Fourth time in this codebase: a controlled
            // select loses what somebody picked when a refusal remounts the form, and React
            // re-creating the options in the same commit leaves the DOM at `selectedIndex: 0`
            // while the component believes otherwise. Remounting exactly when the echo changes is
            // what works. This select reveals nothing, so the reactive shape the guardrails form
            // needs is wrong here.
            key={`product-${value('seoProductId', 'productId')}`}
            defaultValue={value('seoProductId', 'productId')}
            className={controlClassName}
            data-seo-field="productId"
          >
            <option value="">Not about one product</option>
            {products.items.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="seoNoindex"
          defaultChecked={echoed(state, 'seoNoindex') === 'on' || flag(seo, 'noindex')}
          data-seo-field="noindex"
        />
        <span>Ask search engines not to list this page</span>
      </label>

      <Result state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save search settings'}
        </Button>
      </div>
    </form>
  );
}

export function SiteSeoForm({
  site,
  businessKinds,
}: {
  site: WebsiteDetail;
  businessKinds: readonly string[];
}) {
  const [state, action, pending] = useActionState(saveSiteSeo, IDLE);
  const defaults = site.seoDefaults ?? {};
  const businessRaw = defaults.business;
  const business = (
    typeof businessRaw === 'object' && businessRaw !== null ? businessRaw : {}
  ) as Record<string, unknown>;
  const value = (field: string, key: string): string => echoed(state, field) ?? str(defaults, key);
  const businessValue = (field: string): string => echoed(state, field) ?? str(business, field);

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="websiteId" value={site.id} />

      <Field
        label="Site description"
        hint="Used for any page that has none of its own."
        error={errorAt(state, 'seoDefaults.description')}
      >
        <textarea
          name="description"
          rows={2}
          maxLength={320}
          defaultValue={value('description', 'description')}
          className={controlClassName}
          data-seo-field="siteDescription"
        />
      </Field>

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex-1">
          <Field
            label="Default sharing image"
            error={errorAt(state, 'seoDefaults.ogImageUrl')}
            hint="Full address, starting with https://."
          >
            <input
              name="ogImageUrl"
              maxLength={500}
              defaultValue={value('ogImageUrl', 'ogImageUrl')}
              className={`${controlClassName} w-full min-w-0`}
              data-seo-field="siteOgImageUrl"
            />
          </Field>
        </div>
        <div className="flex-1">
          <Field
            label="X (Twitter) name"
            hint="Your business's handle, or paste its profile address."
            error={errorAt(state, 'seoDefaults.twitterSite')}
          >
            <input
              name="twitterSite"
              maxLength={200}
              defaultValue={value('twitterSite', 'twitterSite')}
              className={`${controlClassName} w-full min-w-0`}
              data-seo-field="twitterSite"
            />
          </Field>
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="noindex"
          defaultChecked={echoed(state, 'noindex') === 'on' || flag(defaults, 'noindex')}
          data-seo-field="siteNoindex"
        />
        <span>Ask search engines not to list this site at all</span>
      </label>

      <fieldset className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-4">
        <legend className="text-sm font-medium">Your business, for search engines</legend>
        <p className="text-xs text-[var(--color-text-muted)]">
          Your name, logo and opening hours are already taken from your workspace settings — there
          is nothing to retype here. These are the details nothing else in the product knows.
        </p>

        <Field label="Kind of business" error={errorAt(state, 'seoDefaults.business.kind')}>
          <select
            name="businessKind"
            key={`kind-${businessValue('businessKind') || str(business, 'kind')}`}
            defaultValue={businessValue('businessKind') || str(business, 'kind')}
            className={controlClassName}
            data-seo-field="businessKind"
          >
            {businessKinds.map((kind) => (
              <option key={kind} value={kind}>
                {kind.replace(/([a-z])([A-Z])/g, '$1 $2')}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Street address" error={errorAt(state, 'seoDefaults.business.streetAddress')}>
          <input
            name="streetAddress"
            maxLength={200}
            defaultValue={businessValue('streetAddress')}
            className={controlClassName}
            data-seo-field="streetAddress"
          />
        </Field>

        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="flex-1">
            <Field label="Town or city" error={errorAt(state, 'seoDefaults.business.locality')}>
              <input
                name="locality"
                maxLength={100}
                defaultValue={businessValue('locality')}
                className={`${controlClassName} w-full min-w-0`}
                data-seo-field="locality"
              />
            </Field>
          </div>
          <div className="flex-1">
            <Field label="State or region" error={errorAt(state, 'seoDefaults.business.region')}>
              <input
                name="region"
                maxLength={100}
                defaultValue={businessValue('region')}
                className={`${controlClassName} w-full min-w-0`}
                data-seo-field="region"
              />
            </Field>
          </div>
          <div className="flex-1">
            <Field label="Postcode" error={errorAt(state, 'seoDefaults.business.postalCode')}>
              <input
                name="postalCode"
                maxLength={24}
                defaultValue={businessValue('postalCode')}
                className={`${controlClassName} w-full min-w-0`}
                data-seo-field="postalCode"
              />
            </Field>
          </div>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="flex-1">
            <Field
              label="Phone number"
              hint="As you would print it. It is shown to people, not dialled by us."
              error={errorAt(state, 'seoDefaults.business.phone')}
            >
              <input
                name="phone"
                maxLength={32}
                defaultValue={businessValue('phone')}
                className={`${controlClassName} w-full min-w-0`}
                data-seo-field="businessPhone"
              />
            </Field>
          </div>
          <div className="flex-1">
            <Field
              label="Price range"
              hint="Something short, like ₹₹ or “from ₹50,000”."
              error={errorAt(state, 'seoDefaults.business.priceRange')}
            >
              <input
                name="priceRange"
                maxLength={24}
                defaultValue={businessValue('priceRange')}
                className={`${controlClassName} w-full min-w-0`}
                data-seo-field="priceRange"
              />
            </Field>
          </div>
        </div>
      </fieldset>

      <Result state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save search settings'}
        </Button>
      </div>
    </form>
  );
}

/**
 * The redirects for one site.
 *
 * A separate `<form>` per removal, and the field names are scoped by the form they are in rather
 * than by being unique on the page — adding a form to a screen makes other forms' field selectors
 * ambiguous, which a deal browser check paid for by waiting forever on a hidden input.
 */
export function RedirectsPanel({
  websiteId,
  redirects,
}: {
  websiteId: string;
  redirects: readonly RedirectRow[];
}) {
  const [state, action, pending] = useActionState(addRedirect, IDLE);

  return (
    <div className="flex flex-col gap-4">
      {redirects.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">
          No redirects. Add one when you rename a page, so the old address keeps working for anybody
          who bookmarked it or linked to it.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {redirects.map((row) => (
            <li
              key={row.id}
              className="flex flex-col gap-1 border-b border-[var(--color-border)] pb-2 last:border-0 sm:flex-row sm:items-center sm:justify-between"
              data-redirect-row={row.fromPath}
            >
              <div className="min-w-0 text-sm">
                <p className="break-all">
                  {/* Printed as text, not only held in inputs: a list whose values live only in
                      form controls is unreadable and unassertable, which seven identical "Name"
                      labels on the payment-methods screen demonstrated. */}
                  <code data-redirect-from>{row.fromPath}</code>
                  <span aria-hidden> → </span>
                  <code data-redirect-to>{row.toPath}</code>
                </p>
                <p className="text-xs text-[var(--color-text-muted)]">
                  {row.kind === 'permanent' ? 'Moved for good' : 'Moved for now'}
                  {row.note === null ? '' : ` · ${row.note}`}
                </p>
                {row.shadowed ? (
                  <p className="text-xs text-[var(--color-warning)]" data-redirect-shadowed>
                    There is a page at this address now, and a page always wins — so this redirect
                    is doing nothing.
                  </p>
                ) : null}
              </div>
              <RemoveRedirect websiteId={websiteId} redirect={row} />
            </li>
          ))}
        </ul>
      )}

      <form
        action={action}
        className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-4"
      >
        <input type="hidden" name="websiteId" value={websiteId} />
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="flex-1">
            <Field
              label="Old address"
              hint="A path on this site, like /old-prices."
              error={errorAt(state, 'fromPath')}
            >
              <input
                name="fromPath"
                required
                maxLength={512}
                defaultValue={echoed(state, 'fromPath') ?? ''}
                className={`${controlClassName} w-full min-w-0`}
                data-redirect-field="fromPath"
              />
            </Field>
          </div>
          <div className="flex-1">
            <Field
              label="Goes to"
              hint="A path like /pricing, or a full address elsewhere."
              error={errorAt(state, 'toPath')}
            >
              <input
                name="toPath"
                required
                maxLength={1024}
                defaultValue={echoed(state, 'toPath') ?? ''}
                className={`${controlClassName} w-full min-w-0`}
                data-redirect-field="toPath"
              />
            </Field>
          </div>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="flex-1">
            <Field label="Kind" error={errorAt(state, 'kind')}>
              <select
                name="kind"
                key={`kind-${echoed(state, 'kind') ?? 'permanent'}`}
                defaultValue={echoed(state, 'kind') ?? 'permanent'}
                className={controlClassName}
                data-redirect-field="kind"
              >
                <option value="permanent">Moved for good</option>
                <option value="temporary">Moved for now</option>
              </select>
            </Field>
          </div>
          <div className="flex-[2]">
            <Field
              label="Note"
              hint="Why this exists, for whoever reads the list in a year."
              error={errorAt(state, 'note')}
            >
              <input
                name="note"
                maxLength={500}
                defaultValue={echoed(state, 'note') ?? ''}
                className={`${controlClassName} w-full min-w-0`}
                data-redirect-field="note"
              />
            </Field>
          </div>
        </div>
        <Result state={state} />
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? 'Adding…' : 'Add redirect'}
          </Button>
        </div>
      </form>
    </div>
  );
}

function RemoveRedirect({ websiteId, redirect }: { websiteId: string; redirect: RedirectRow }) {
  const [state, action, pending] = useActionState(removeRedirect, IDLE);
  return (
    <form action={action} className="shrink-0">
      <input type="hidden" name="websiteId" value={websiteId} />
      <input type="hidden" name="redirectId" value={redirect.id} />
      <Button type="submit" variant="quiet" disabled={pending}>
        {pending ? 'Removing…' : 'Remove'}
      </Button>
      {state.status === 'error' && state.message !== undefined ? (
        <ErrorNotice>{state.message}</ErrorNotice>
      ) : null}
    </form>
  );
}

/** Marks a page that has told search engines to stay away, so the list does not look identical. */
export function SeoBadges({ page }: { page: WebsitePageRow }) {
  const seo = page.seo ?? {};
  if (!flag(seo, 'noindex')) return null;
  return <Badge tone="neutral">Hidden from search</Badge>;
}
