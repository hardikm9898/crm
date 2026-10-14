import Link from 'next/link';
import { can, requireCurrentUser } from '@/lib/session';
import { Card, ErrorNotice, PageHeader } from '@/components/ui';
import { NewFormForm } from '../_components/form-panels';

/**
 * Creating a form: two questions on this screen, the rest on the next one.
 *
 * Name and thank-you message only, because everything else — the questions, the link, where
 * captures land — is better decided with the form in front of you. A create screen that asked for
 * all of it would be a screen somebody abandons halfway.
 */
export const dynamic = 'force-dynamic';

export default async function NewFormPage() {
  const user = await requireCurrentUser();
  if (!can(user, 'form:manage')) {
    return (
      <>
        <PageHeader title="New form" />
        <ErrorNotice>You do not have permission to build capture forms.</ErrorNotice>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="New form"
        description="It arrives with the four questions most forms ask. You can change them on the next screen."
        action={
          <Link href="/forms" className="text-sm underline">
            Back to forms
          </Link>
        }
      />
      <Card>
        <NewFormForm />
      </Card>
    </>
  );
}
