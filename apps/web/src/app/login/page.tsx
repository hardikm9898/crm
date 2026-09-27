import type { Metadata } from 'next';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in · Lead OS' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ expired?: string }>;
}) {
  const params = await searchParams;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-4 py-10">
      <div>
        <h1 className="text-lg font-semibold">Sign in to Lead OS</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Your leads, follow-ups and conversations in one place.
        </p>
      </div>
      <LoginForm expired={params.expired === '1'} />
    </main>
  );
}
