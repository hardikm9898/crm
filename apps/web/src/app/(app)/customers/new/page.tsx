import Link from 'next/link';
import { redirect } from 'next/navigation';
import { can, requireCurrentUser } from '@/lib/session';
import { Card, PageHeader } from '@/components/ui';
import { NewCustomerForm } from '../_components/customer-forms';

/**
 * Adding a customer who was never a lead.
 *
 * Deliberately a separate screen from conversion: most customers arrive by converting a won lead,
 * and this is the exception — a walk-in who paid, or an existing book of business. Hiding the link
 * is presentation; the API refuses the call either way.
 */
export const dynamic = 'force-dynamic';

export default async function NewCustomerPage() {
  const user = await requireCurrentUser();
  if (!can(user, 'customer:manage')) redirect('/customers');

  return (
    <>
      <PageHeader
        title="New customer"
        description="For somebody who was never a lead. A won lead becomes a customer from the lead itself, so its history comes with it."
        action={
          <Link href="/customers" className="text-sm underline">
            Back to customers
          </Link>
        }
      />
      <Card>
        <NewCustomerForm />
      </Card>
    </>
  );
}
