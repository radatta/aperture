// Money display. Amounts live as integer cents everywhere; this is the one place they become text.
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usdWhole = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

export const fmtMoney = (cents: number): string => usd.format(cents / 100);

// Headline figures ("$412 left"): whole dollars, rounded toward zero so "left" never overstates.
export const fmtMoneyWhole = (cents: number): string => usdWhole.format(Math.trunc(cents / 100));

// Dollars typed into a field → cents. null for anything that isn't a non-negative amount.
export function parseDollars(text: string): number | null {
  const t = text.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}
