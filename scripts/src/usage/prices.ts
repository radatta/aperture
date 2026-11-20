// Quota units (QU): a call's tokens priced at API list prices, 1 QU = $1 — the same scale as the status line's
// `cost.total_cost_usd`, so the two cross-check. Prices per million tokens from platform.claude.com/docs pricing
// (checked 2026-11-17). docs/ops/USAGE-METER.md → Units.

export interface Price {
  in: number;
  cw5: number; // 5-minute cache write
  cw1: number; // 1-hour cache write
  cr: number; // cache read / refresh
  out: number;
}
export interface Tokens {
  i: number;
  cw5: number;
  cw1: number;
  cr: number;
  o: number;
}
export type PriceFlag = 'unknown-model' | 'fast' | 'cw-unsplit';

const p = (inp: number, cw5: number, cw1: number, cr: number, out: number): Price => ({
  in: inp,
  cw5,
  cw1,
  cr,
  out,
});

// Normalised id (no `claude-` prefix, no date suffix, no `[1m]`) → price. Mythos prices as the matching Fable.
export const PRICES: Record<string, Price> = {
  'fable-5-2': p(8, 10, 16, 0.2, 40),
  'fable-5-1': p(10, 12.5, 20, 0.25, 50),
  'fable-5': p(10, 12.5, 20, 1, 50),
  'opus-5-5': p(4, 5, 8, 0.2, 20),
  'opus-5': p(5, 6.25, 10, 0.5, 25),
  'opus-4-8': p(5, 6.25, 10, 0.5, 25),
  'opus-4-7': p(5, 6.25, 10, 0.5, 25),
  'opus-4-6': p(5, 6.25, 10, 0.5, 25),
  'opus-4-5': p(5, 6.25, 10, 0.5, 25),
  'opus-4-1': p(15, 18.75, 30, 1.5, 75),
  'opus-4': p(15, 18.75, 30, 1.5, 75),
  'sonnet-5-5': p(2, 2.5, 4, 0.1, 10),
  'sonnet-5': p(2, 2.5, 4, 0.2, 10),
  'sonnet-4-6': p(3, 3.75, 6, 0.3, 15),
  'sonnet-4-5': p(3, 3.75, 6, 0.3, 15),
  'sonnet-4': p(3, 3.75, 6, 0.3, 15),
  'haiku-5-5': p(0.1, 0.125, 0.2, 0.01, 0.5),
  'haiku-5-5-long': p(0.5, 0.625, 1, 0.05, 2.5), // prompts over 100k tokens
  'haiku-4-5': p(1, 1.25, 2, 0.1, 5),
};
export const FALLBACK = 'opus-5-5';
const HAIKU_LONG_OVER = 100_000;

export function normalizeModel(id: string): string {
  return id
    .toLowerCase()
    .replace(/\[.*?\]$/, '')
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/^mythos-/, 'fable-')
    .replace(/\./g, '-');
}

// A call's QU in three parts: re-reading the cached context, ingesting new tokens (input and cache writes), and
// output. They sum to priceCall's qu.
export interface Parts {
  reread: number;
  ingest: number;
  output: number;
}

export function priceParts(
  model: string,
  t: Tokens,
  opts: { fast?: boolean; unsplit?: boolean } = {},
): { qu: number; parts: Parts; flags: PriceFlag[] } {
  const flags: PriceFlag[] = [];
  let key = normalizeModel(model);
  if (key === 'haiku-5-5' && t.i + t.cw5 + t.cw1 + t.cr > HAIKU_LONG_OVER) key = 'haiku-5-5-long';
  const known = PRICES[key];
  if (!known) flags.push('unknown-model');
  const price = known ?? PRICES[FALLBACK]!;
  const fast = opts.fast ? 2 : 1;
  if (opts.fast) flags.push('fast');
  if (opts.unsplit) flags.push('cw-unsplit');
  const parts = {
    reread: (t.cr * price.cr * fast) / 1e6,
    ingest: ((t.i * price.in + t.cw5 * price.cw5 + t.cw1 * price.cw1) * fast) / 1e6,
    output: (t.o * price.out * fast) / 1e6,
  };
  return { qu: parts.reread + parts.ingest + parts.output, parts, flags };
}

export function priceCall(
  model: string,
  t: Tokens,
  opts: { fast?: boolean; unsplit?: boolean } = {},
): { qu: number; flags: PriceFlag[] } {
  const { qu, flags } = priceParts(model, t, opts);
  return { qu, flags };
}
