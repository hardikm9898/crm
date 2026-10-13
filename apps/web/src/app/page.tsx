import { redirect } from 'next/navigation';
import { readAccessToken, requireCurrentUser } from '@/lib/session';

/**
 * The landing route resolves by session rather than rendering a marketing page: this app is the
 * product, and the marketing site is separate (docs/frontend-architecture.md §2).
 *
 * **`/today` for anybody with a follow-up queue, `/dashboard` otherwise** — resolved by
 * *permission*, never by role name (rule 4: roles are rows a tenant edits, so code that branches
 * on "executive" is code that breaks the moment somebody renames one). `task:read` is the honest
 * test of "does this person have work owed to them", and the dashboard is one tap away for the
 * manager who wants the whole picture first.
 */
export default async function IndexPage() {
  const token = await readAccessToken();
  if (!token) redirect('/login');
  const user = await requireCurrentUser();
  redirect(user.permissions.includes('task:read') ? '/today' : '/dashboard');
}
