import { describe, expect, it } from 'vitest';
import { parseAmountMinor, parseLineItems, rupees } from './line-items-form';

function form(rows: Record<string, string>[]): FormData {
  const data = new FormData();
  for (const row of rows) {
    data.append('line-productId', row['productId'] ?? '');
    data.append('line-name', row['name'] ?? '');
    data.append('line-quantity', row['quantity'] ?? '');
    data.append('line-price', row['price'] ?? '');
    data.append('line-discount', row['discount'] ?? '');
    data.append('line-tax', row['tax'] ?? '');
  }
  return data;
}

describe('parseAmountMinor', () => {
  it('reads money the way people write it', () => {
    expect(parseAmountMinor('2,50,000')).toBe(25_000_000);
    expect(parseAmountMinor('₹ 1 250.50')).toBe(125_050);
  });

  it('tells "not given" apart from "unreadable"', () => {
    // An absent price means "take the catalogue's"; an unreadable one must refuse the form.
    expect(parseAmountMinor('')).toBeNull();
    expect(parseAmountMinor(undefined)).toBeNull();
    expect(parseAmountMinor('12,5O,000')).toBeNaN();
    expect(parseAmountMinor('-500')).toBeNaN();
  });

  it('round-trips through rupees()', () => {
    expect(rupees(parseAmountMinor('1,999.99') as number)).toBe('1999.99');
    expect(rupees(500_000)).toBe('5000');
  });
});

describe('parseLineItems', () => {
  it('skips the empty row the editor always offers', () => {
    const parsed = parseLineItems(form([{ name: 'Design', quantity: '1', price: '80000' }, {}]));
    expect(parsed.items).toHaveLength(1);
    expect(parsed.fieldErrors).toEqual({});
  });

  it('sends a product on its own, so the catalogue can price the line', () => {
    const parsed = parseLineItems(form([{ productId: 'p1', quantity: '2' }]));
    expect(parsed.items[0]).toEqual({ productId: 'p1', quantity: 2, discountMinor: 0 });
  });

  it('keeps a fractional quantity', () => {
    const parsed = parseLineItems(form([{ name: 'Build', quantity: '2.5', price: '40000' }]));
    expect(parsed.items[0]?.['quantity']).toBe(2.5);
  });

  it('reports a bad quantity against its own row', () => {
    const parsed = parseLineItems(
      form([
        { name: 'Fine', quantity: '1', price: '100' },
        { name: 'Broken', quantity: '0', price: '100' },
      ]),
    );
    expect(parsed.fieldErrors['line-quantity-1']).toMatch(/greater than zero/);
  });

  it('reports an unreadable price against its own row', () => {
    const parsed = parseLineItems(form([{ name: 'Odd', quantity: '1', price: 'a lot' }]));
    expect(parsed.fieldErrors['line-price-0']).toMatch(/Enter an amount/);
  });

  it('omits the tax rate when nobody typed one, rather than sending zero', () => {
    // Zero is a real rate; absent means "take the product's".
    const parsed = parseLineItems(form([{ productId: 'p1', quantity: '1' }]));
    expect(parsed.items[0]).not.toHaveProperty('taxPercent');
    const explicit = parseLineItems(form([{ productId: 'p1', quantity: '1', tax: '0' }]));
    expect(explicit.items[0]?.['taxPercent']).toBe(0);
  });
});
