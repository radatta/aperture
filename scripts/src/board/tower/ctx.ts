// Each session's context use (F240): dispatch's context-watch.sh writes localNotes/board/ctx.json every minute,
// [{name, ts, tokens, pct}] with pct = tokens / 1M. The tower shows it on each session's row and counts the ones over
// the line; the phone alert stays dispatch's. Its `ts` is a clock time only, so freshness is the file's mtime.
export type CtxEntry = { name: string; pct: number };
export type CtxFile = { at: number; list: CtxEntry[] };
export const CTX_WARN = 40;
export const CTX_BAD = 50;
export const CTX_STALE_MS = 5 * 60e3;

export function parseCtx(text: string | null, mtime: number | null): CtxFile | null {
  if (text === null || mtime === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const list = raw.flatMap((x) => {
    const e = x as { name?: unknown; pct?: unknown };
    return typeof e?.name === 'string' &&
      e.name &&
      typeof e.pct === 'number' &&
      Number.isFinite(e.pct)
      ? [{ name: e.name, pct: e.pct }]
      : [];
  });
  return { at: mtime, list };
}

export type CtxView = {
  at: number;
  stale: boolean;
  warn: CtxEntry[]; // ≥ 40 and < 50
  bad: CtxEntry[]; // ≥ 50
};
// A stale file counts nothing (an old 76 % is no alert); null when there is none.
export function ctxView(c: CtxFile | null, now: number): CtxView | null {
  if (!c) return null;
  const stale = now - c.at > CTX_STALE_MS;
  const by = (lo: number, hi: number) =>
    stale ? [] : c.list.filter((e) => e.pct >= lo && e.pct < hi).sort((a, b) => b.pct - a.pct);
  return { at: c.at, stale, warn: by(CTX_WARN, CTX_BAD), bad: by(CTX_BAD, Infinity) };
}
// A session's own percent, while the file is fresh.
export const ctxOf = (c: CtxFile | null, name: string | null, now: number) =>
  !c || !name || now - c.at > CTX_STALE_MS
    ? null
    : (c.list.find((e) => e.name === name)?.pct ?? null);
