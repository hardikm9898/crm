import type { ReactNode } from 'react';

/**
 * The small shared vocabulary this app is built from (docs/frontend-architecture.md §4).
 *
 * Deliberately few components, each with designed empty and loading states, rather than a large
 * component library used shallowly. They move to `packages/ui` when the second app needs them.
 */

export function Card({
  title,
  description,
  action,
  children,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface-raised)]">
      {(title || action) && (
        <header className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] px-5 py-4">
          <div>
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {description && (
              <p className="mt-0.5 text-sm text-[var(--color-text-muted)]">{description}</p>
            )}
          </div>
          {action}
        </header>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div
      className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-4 py-3"
      data-stat={label}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
        {label}
      </p>
      {/*
        `data-stat-value` is a stable hook for the browser checks. The label above is uppercased by
        CSS, so reading it back gives "TOTAL" rather than "Total" — which is how three assertions
        about a figure quietly matched nothing at all and passed.
      */}
      <p className="numeric mt-1 text-2xl font-semibold" data-stat-value={label}>
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{hint}</p>}
    </div>
  );
}

/**
 * Empty states carry a next action, not just an apology: a blank screen with nothing to do is how a
 * new user gets stuck (NFR-UX-3).
 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      {description && (
        <p className="max-w-sm text-sm text-[var(--color-text-muted)]">{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
}) {
  const tones: Record<string, string> = {
    neutral: 'border-[var(--color-border)] text-[var(--color-text-muted)]',
    success: 'border-transparent bg-[var(--color-success)]/12 text-[var(--color-success)]',
    warning: 'border-transparent bg-[var(--color-warning)]/15 text-[var(--color-warning)]',
    danger: 'border-transparent bg-[var(--color-danger)]/12 text-[var(--color-danger)]',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function ErrorNotice({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/8 px-3 py-2 text-sm text-[var(--color-danger)]"
    >
      {children}
    </p>
  );
}

/** Table shell used by the member and role lists. */
export function DataTable({
  columns,
  children,
}: {
  columns: readonly string[];
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-[var(--color-border)]">
            {columns.map((column) => (
              <th
                key={column}
                scope="col"
                className="py-2 pr-4 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">{children}</tbody>
      </table>
    </div>
  );
}

/**
 * Buttons and fields exist as components so that focus, disabled and busy states are designed once.
 * `pending` is a first-class prop rather than something each form reinvents: a form that looks idle
 * while it is submitting invites a double submit.
 */
export function Button({
  children,
  variant = 'primary',
  pending = false,
  type = 'button',
  onClick,
  disabled,
}: {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger' | 'quiet';
  pending?: boolean;
  type?: 'button' | 'submit';
  onClick?: () => void;
  disabled?: boolean;
}) {
  const variants: Record<string, string> = {
    primary:
      'bg-[var(--color-primary)] text-[var(--color-primary-contrast)] hover:bg-[var(--color-primary-hover)]',
    secondary:
      'border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-muted)]',
    danger:
      'border border-[var(--color-danger)]/40 text-[var(--color-danger)] hover:bg-[var(--color-danger)]/8',
    quiet: 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled === true || pending}
      aria-busy={pending || undefined}
      className={`inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${variants[variant]}`}
    >
      {children}
    </button>
  );
}

const CONTROL_CLASS =
  'rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm';

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  /**
   * The message for this one input.
   *
   * Optional and additive: the older forms render their own span after the control, which is the
   * same markup by hand. When it is set it replaces the hint, because showing "enter an amount like
   * 50,000" underneath "that is not an amount" is two sentences competing for one line.
   */
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {error ? (
        <span className="text-xs text-[var(--color-danger)]">{error}</span>
      ) : (
        hint && <span className="text-xs text-[var(--color-text-muted)]">{hint}</span>
      )}
    </label>
  );
}

export const controlClassName = CONTROL_CLASS;

/** A read-only key/value row, used by the settings screens. */
export function DefinitionRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
      <dt className="text-sm text-[var(--color-text-muted)]">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-0.5 max-w-2xl text-sm text-[var(--color-text-muted)]">{description}</p>
        )}
      </div>
      {action}
    </header>
  );
}
