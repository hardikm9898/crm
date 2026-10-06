import { describeError } from '@/lib/api';
import { can, readAccessToken, requireCurrentUser } from '@/lib/session';
import { Card, ErrorNotice, PageHeader } from '@/components/ui';
import { loadPaymentMethodsOrThrow } from '@/lib/payments';
import { NewPaymentMethodForm, PaymentMethodRow } from '../../payments/_components/payment-forms';

/**
 * How money arrives, as the workspace's own list.
 *
 * Reads through the **throwing** loader: on a screen whose whole job is to list the methods, an
 * empty list and a failed request look identical and must not — the mistake the product catalogue
 * shipped with, where a swallowed 400 told every workspace it had no products.
 */
export const dynamic = 'force-dynamic';

export default async function PaymentMethodsPage() {
  const user = await requireCurrentUser();
  const token = await readAccessToken();

  if (!can(user, 'settings:manage')) {
    return (
      <>
        <PageHeader title="Payment methods" />
        <ErrorNotice>You do not have permission to change this workspace’s settings.</ErrorNotice>
      </>
    );
  }

  let methods: Awaited<ReturnType<typeof loadPaymentMethodsOrThrow>>;
  try {
    methods = await loadPaymentMethodsOrThrow(token, '?includeInactive=true');
  } catch (error) {
    return (
      <>
        <PageHeader title="Payment methods" />
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Payment methods"
        description="Cash, UPI, cheque — whatever this business actually takes."
      />

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <Card
          title="The list"
          description="Deactivate a method to stop offering it without losing the record of money that arrived by it."
        >
          {methods.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">
              No methods yet. Add the first one on the right.
            </p>
          ) : (
            <div className="flex flex-col">
              {methods.map((method) => (
                <PaymentMethodRow key={method.id} method={method} />
              ))}
            </div>
          )}
        </Card>

        <Card title="Add a method">
          <NewPaymentMethodForm />
        </Card>
      </div>
    </>
  );
}
