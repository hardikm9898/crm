import type { Metadata } from 'next';
import { loadPublicForm, type PublicFormDefinition } from '@/lib/forms';
import { PublicForm } from './public-form';

/**
 * The page a stranger fills in (`FR-CAP-2`).
 *
 * Outside the `(app)` route group on purpose: no navigation, no session, no workspace switcher —
 * nothing that would make sense to somebody who has never seen this product, and nothing that
 * would look wrong inside an `<iframe>` on a business's own website.
 *
 * The key in the URL is the whole identity of the form (ADR-0029). A key that names nothing, or a
 * form switched off, renders the same "no longer taking enquiries" page: a 404 that said which of
 * the two it was would turn the key into an oracle.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ key: string }>;
}): Promise<Metadata> {
  const { key } = await params;
  try {
    const form = await loadPublicForm(key);
    // The business's name, not ours: this page is theirs as far as the visitor is concerned.
    return { title: `${form.name} · ${form.organizationName}`, robots: { index: false } };
  } catch {
    return { title: 'Form', robots: { index: false } };
  }
}

export default async function PublicFormPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;

  let definition: PublicFormDefinition;
  try {
    definition = await loadPublicForm(key);
  } catch {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-3 px-4 py-10 text-center">
        <h1 className="text-lg font-semibold">This form is no longer taking enquiries</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          The link may have changed. If you were sent here by a business, please get in touch with
          them directly.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-xl px-4 py-8">
      <header className="mb-5">
        <p className="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
          {definition.organizationName}
        </p>
        <h1 className="mt-1 text-lg font-semibold tracking-tight">{definition.name}</h1>
        {definition.settings.introText && (
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            {definition.settings.introText}
          </p>
        )}
      </header>
      <PublicForm publicKey={key} definition={definition} />
      <p className="mt-6 text-xs text-[var(--color-text-muted)]">
        Your details go to {definition.organizationName}, who will contact you about this enquiry.
      </p>
    </main>
  );
}
