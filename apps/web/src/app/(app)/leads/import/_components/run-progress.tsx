'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Keeps a running import's numbers moving.
 *
 * The page is a server component, so "refresh" means re-reading the job from the API — which is
 * exactly what should happen, and is why this is a three-line client component rather than a
 * client-side copy of the job. It stops as soon as the run is no longer in flight, so a finished
 * import does not poll the API all afternoon from a forgotten tab.
 */
export function RunProgress({ active }: { active: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), 2_000);
    return () => clearInterval(timer);
  }, [active, router]);

  return null;
}
