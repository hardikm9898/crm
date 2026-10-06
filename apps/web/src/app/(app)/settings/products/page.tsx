import Link from 'next/link';
import { redirect } from 'next/navigation';
import { can, readAccessToken, requireCurrentUser } from '@/lib/session';
import { Badge, Card, EmptyState, ErrorNotice, PageHeader } from '@/components/ui';
import { formatMoney } from '@/lib/lead-format';
import { describeError } from '@/lib/api';
import { loadProductsOrThrow, type Product } from '@/lib/deals';
import { NewProductForm, ToggleProductButton } from './_components/product-forms';

/**
 * The product catalogue.
 *
 * In settings, not under deals, because a price list is a workspace decision: reading it is
 * `deal:read` so an executive can quote from it, and changing it is `settings:manage`.
 *
 * **Deactivate rather than delete.** A product that has been sold cannot be deleted — the record of
 * selling it would lose its name — so the list is sorted active-first and a deactivated product
 * stops appearing when somebody adds a line.
 */
export const dynamic = 'force-dynamic';

export default async function ProductsPage() {
  const user = await requireCurrentUser();
  if (!can(user, 'deal:read')) redirect('/dashboard');
  const token = await readAccessToken();
  // No `active` filter at all: this screen lists the whole catalogue, active and not. Sending an
  // empty `active=` is what the API refuses, and the refusal used to be invisible here.
  let products: Product[] = [];
  let error: string | null = null;
  try {
    products = await loadProductsOrThrow(token, '?limit=200');
  } catch (caught) {
    error = describeError(caught);
  }
  const editable = can(user, 'settings:manage');

  return (
    <>
      <PageHeader
        title="Products"
        description="What you sell, and what it costs by default. A line item copies the price when it is written, so changing it here never rewrites a quotation."
        action={
          <Link href="/settings" className="text-sm underline">
            Settings
          </Link>
        }
      />

      <div className="flex flex-col gap-5">
        {error && <ErrorNotice>{error}</ErrorNotice>}
        {editable && (
          <Card title="Add a product">
            <NewProductForm />
          </Card>
        )}

        <Card>
          {products.length === 0 ? (
            <EmptyState
              title="No products yet"
              description="You do not need any — a line on a deal can be typed by hand. A catalogue saves typing when you sell the same thing twice."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left">
                    <th className="py-2 pr-4 font-medium">Product</th>
                    <th className="py-2 pr-4 font-medium">Code</th>
                    <th className="py-2 pr-4 font-medium">Price</th>
                    <th className="py-2 pr-4 font-medium">Tax</th>
                    <th className="py-2 pr-4 font-medium">Unit</th>
                    <th className="py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {products.map((product) => (
                    <tr key={product.id} className="border-b border-[var(--color-border)]/60">
                      <td className="py-2 pr-4">
                        {product.name}
                        {!product.isActive && (
                          <span className="ml-2">
                            <Badge>Inactive</Badge>
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-[var(--color-text-muted)]">
                        {product.sku ?? '—'}
                      </td>
                      <td className="numeric py-2 pr-4">
                        {formatMoney(product.priceMinor, product.currency ?? 'INR')}
                      </td>
                      <td className="numeric py-2 pr-4">{product.taxPercent}%</td>
                      <td className="py-2 pr-4 text-[var(--color-text-muted)]">
                        {product.unit ?? '—'}
                      </td>
                      <td className="py-2">
                        {editable && (
                          <ToggleProductButton id={product.id} isActive={product.isActive} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
