// Map with at most `limit` promises in flight, results in input order. Hand-rolled (a dozen lines) —
// the finance repo fans out per-row reads and conditional writes, and DynamoDB throttles an unbounded
// burst. The first rejection rejects the whole call; in-flight work is left to settle.
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
