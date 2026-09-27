import { redirect } from 'next/navigation';
import { readAccessToken } from '@/lib/session';

/**
 * The landing route resolves by session rather than rendering a marketing page: this app is the
 * product, and the marketing site is separate (docs/frontend-architecture.md §2).
 */
export default async function IndexPage() {
  const token = await readAccessToken();
  redirect(token ? '/dashboard' : '/login');
}
