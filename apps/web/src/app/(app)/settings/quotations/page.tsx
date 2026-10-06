import { describeError } from '@/lib/api';
import { readAccessToken, requireCurrentUser, can } from '@/lib/session';
import { Card, ErrorNotice, PageHeader } from '@/components/ui';
import { loadNumberSeries } from '@/lib/quotations';
import { NumberSeriesForm } from '../../quotations/_components/quotation-forms';

/**
 * Quotation numbering.
 *
 * Its own settings screen because the counter is the one piece of quotation configuration that is
 * dangerous: moving it back would re-issue a number that is already in somebody's inbox, which is
 * why the API refuses it rather than warning about it.
 */
export const dynamic = 'force-dynamic';

export default async function QuotationSettingsPage() {
  const user = await requireCurrentUser();
  const token = await readAccessToken();

  if (!can(user, 'settings:manage')) {
    return (
      <>
        <PageHeader title="Quotation numbering" />
        <ErrorNotice>You do not have permission to change this workspace’s settings.</ErrorNotice>
      </>
    );
  }

  let series: Awaited<ReturnType<typeof loadNumberSeries>>;
  try {
    series = await loadNumberSeries(token);
  } catch (error) {
    return (
      <>
        <PageHeader title="Quotation numbering" />
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Quotation numbering"
        description="The number a customer reads back to you on the phone."
      />
      <Card
        title="The series"
        description="Every quotation takes the next number. A revision keeps the number it already has."
      >
        <NumberSeriesForm
          prefix={series.prefix}
          padding={series.padding}
          nextValue={series.nextValue}
          nextNumber={series.nextNumber}
        />
      </Card>
    </>
  );
}
