'use client';

import { useEffect, useState } from 'react';
import { apiBaseUrl } from '@/lib/api';
import type { PublicFormDefinition } from '@/lib/forms';
import { PublicForm } from '@/app/f/[key]/public-form';

/**
 * A form placed on a published page (`FR-WEB-6`).
 *
 * **It fetches its own definition in the browser rather than being rendered from the page's
 * cache**, and that is the one deliberate exception to this route being static. A page is versioned
 * because its content is something somebody publishes; a form is a live object whose questions
 * change. Baking the questions into the published page would mean editing a form left every page
 * that carries it asking the old ones — and the page's cache tag is dropped by publishing a *site*,
 * so nothing would invalidate it.
 *
 * The component it renders is `PublicForm`, unchanged, which is what makes this "an existing form in
 * a new place" rather than a second capture engine: one honeypot, one validation path, one
 * submission contract, and the context (`pageUrl`, `referrer`, `device`, UTM) comes from the same
 * code on both doors.
 */
export function SiteForm({ publicKey, heading }: { publicKey: string; heading?: string | null }) {
  const [definition, setDefinition] = useState<PublicFormDefinition | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`${apiBaseUrl()}/api/v1/public/forms/${publicKey}`);
        if (!response.ok) throw new Error(String(response.status));
        const payload = (await response.json()) as { data?: PublicFormDefinition };
        if (!cancelled && payload.data) setDefinition(payload.data);
        else if (!cancelled) setFailed(true);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicKey]);

  if (failed) {
    // A sentence, not a blank space and not our diagnostics. A form switched off between the
    // publish and the visit is the ordinary case, and the visitor needs a way to get in touch —
    // the same reasoning as the standalone page's "no longer taking enquiries".
    return (
      <section className="flex flex-col gap-2">
        {heading ? <h2 className="text-2xl font-semibold tracking-tight">{heading}</h2> : null}
        <p className="text-[color:var(--site-muted)]">
          This form is not taking enquiries at the moment. Please get in touch with us directly.
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3" data-site-form={publicKey}>
      {heading ? <h2 className="text-2xl font-semibold tracking-tight">{heading}</h2> : null}
      {definition === null ? (
        // Reserved space rather than nothing, so the page does not jump when the form arrives.
        <p className="text-[color:var(--site-muted)]">Loading the form…</p>
      ) : (
        <PublicForm publicKey={publicKey} definition={definition} />
      )}
    </section>
  );
}
