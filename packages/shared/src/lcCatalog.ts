// The full LeetCode catalog (docs/areas/recruiting/coach.md → The catalog): metadata only — never a problem
// statement — built from a public dataset pinned by commit, classified into the roadmap's patterns once, and
// stored in the stage's own table, never in this repo. Pure: the Lambda fetches, gzips and stores; this trims,
// classifies, packs and unpacks.

import { patternOfTags } from './coach';
import { NEETCODE_150, PATTERNS, isPatternId } from './neetcode150';
import type { CatalogProblem, Difficulty, PatternId } from './neetcode150';

// The pinned source: the dataset's own repo is MIT; the data is LeetCode's public problem metadata.
export const LC_CATALOG_SOURCE = {
  repo: 'noworneverev/leetcode-api',
  sha: 'd4f29be09711d30db57e4660498d74efd5593516',
  path: 'data/leetcode_questions_mini.json',
} as const;
export const lcCatalogSourceUrl = (s = LC_CATALOG_SOURCE) =>
  `https://raw.githubusercontent.com/${s.repo}/${s.sha}/${s.path}`;

// Who set a row's pattern: NeetCode's hand-kept list, the non-algorithm rule, a model pass, or its tags.
export type LcClassifiedBy = 'neetcode' | 'rule' | 'model' | 'tags';
export const LC_CLASSIFIED_BY: readonly LcClassifiedBy[] = ['neetcode', 'rule', 'model', 'tags'];
export interface LcCatalogRow extends CatalogProblem {
  id: number; // LeetCode's frontend number
  tags: string[];
  acRate: number | null; // percent
  similar: string[]; // ≤ 2 slugs, same technique, about the same difficulty
  harder: string[]; // ≤ 2 slugs, same technique, a step up
  by: LcClassifiedBy;
}
// One dataset row, trimmed to what the catalog keeps. `algorithms` is false for LeetCode's Database, Shell,
// Concurrency, JavaScript and pandas sets, which fit no roadmap pattern.
export interface LcSourceRow {
  id: number;
  slug: string;
  title: string;
  difficulty: Difficulty;
  premium: boolean;
  acRate: number | null;
  tags: string[];
  algorithms: boolean;
}
// A model's call on one problem, by frontend id.
export interface LcClass {
  pattern: PatternId;
  similar: number[];
  harder: number[];
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIFFS: readonly Difficulty[] = ['Easy', 'Medium', 'Hard'];
const isDifficulty = (v: unknown): v is Difficulty => DIFFS.includes(v as Difficulty);
const MAX_RELATED = 2;

function acRateOf(stats: unknown): number | null {
  if (typeof stats !== 'string') return null;
  try {
    const s = JSON.parse(stats) as { acRate?: unknown };
    const m = typeof s.acRate === 'string' ? /^(\d{1,3}(?:\.\d+)?)%$/.exec(s.acRate) : null;
    const n = m ? Number(m[1]) : NaN;
    return n >= 0 && n <= 100 ? Math.round(n * 10) / 10 : null;
  } catch {
    return null;
  }
}
function sourceRow(r: unknown): LcSourceRow | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  const id = typeof o.questionFrontendId === 'string' ? Number(o.questionFrontendId) : NaN;
  const slug =
    typeof o.url === 'string'
      ? /^https:\/\/leetcode\.com\/problems\/([^/]+)\/$/.exec(o.url)?.[1]
      : null;
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  if (!Number.isInteger(id) || id < 1 || !slug || !SLUG_RE.test(slug)) return null;
  if (
    !title ||
    title.length > 200 ||
    !isDifficulty(o.difficulty) ||
    typeof o.isPaidOnly !== 'boolean'
  )
    return null;
  const tags = Array.isArray(o.topicTags)
    ? o.topicTags.flatMap((t) =>
        t && typeof (t as { name?: unknown }).name === 'string'
          ? [(t as { name: string }).name]
          : [],
      )
    : [];
  return {
    id,
    slug,
    title,
    difficulty: o.difficulty,
    premium: o.isPaidOnly,
    acRate: acRateOf(o.stats),
    tags,
    algorithms: o.categoryTitle === 'Algorithms',
  };
}
// The dataset's rows, trimmed and in id order; a malformed or repeated row is dropped and counted.
export function trimSourceRows(raw: unknown): { rows: LcSourceRow[]; dropped: number } {
  if (!Array.isArray(raw)) return { rows: [], dropped: 0 };
  const ids = new Set<number>();
  const slugs = new Set<string>();
  const rows: LcSourceRow[] = [];
  for (const r of raw) {
    const s = sourceRow(r);
    if (!s || ids.has(s.id) || slugs.has(s.slug)) continue;
    ids.add(s.id);
    slugs.add(s.slug);
    rows.push(s);
  }
  rows.sort((a, b) => a.id - b.id);
  return { rows, dropped: raw.length - rows.length };
}

// The classification file (one line per problem, `id⇥pattern⇥similar ids⇥harder ids`, `-` for none; `#` lines
// and blanks skipped). A malformed line is counted, never guessed.
export function parseClasses(tsv: string): { classes: Map<number, LcClass>; bad: number } {
  const classes = new Map<number, LcClass>();
  let bad = 0;
  const ids = (f: string | undefined): number[] | null => {
    if (f === undefined) return null;
    if (f.trim() === '-' || f.trim() === '') return [];
    const out = f.split(',').map((x) => Number(x.trim()));
    return out.every((n) => Number.isInteger(n) && n > 0) ? out : null;
  };
  for (const line of tsv.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [idF, pattern, simF, hardF, ...rest] = line.replace(/\r$/, '').split('\t');
    const id = Number(idF);
    const similar = ids(simF);
    const harder = ids(hardF);
    if (
      rest.length ||
      !Number.isInteger(id) ||
      id < 1 ||
      !isPatternId(pattern) ||
      !similar ||
      !harder
    ) {
      bad++;
      continue;
    }
    classes.set(id, { pattern, similar, harder });
  }
  return { classes, bad };
}
// A catalog's model-set rows back to classes, so a re-import keeps them.
export function classesOf(rows: readonly LcCatalogRow[]): Map<number, LcClass> {
  const idOf = new Map(rows.map((r) => [r.slug, r.id]));
  const ids = (slugs: string[]) => slugs.flatMap((s) => (idOf.has(s) ? [idOf.get(s)!] : []));
  return new Map(
    rows
      .filter((r) => r.by === 'model')
      .map((r) => [r.id, { pattern: r.pattern, similar: ids(r.similar), harder: ids(r.harder) }]),
  );
}

// The catalog: NeetCode's facts win for its problems, the non-algorithm sets are `other`, then a model's class,
// else the tags' guess. Related problems keep only ids on the catalog, never the row itself, harder ones at least
// as hard. `limit` keeps the first n other problems (dev's capped import); NeetCode's always stay.
export function buildCatalog(
  source: readonly LcSourceRow[],
  classes: ReadonlyMap<number, LcClass>,
  limit?: number,
): LcCatalogRow[] {
  const nc = new Map(NEETCODE_150.map((p) => [p.slug, p]));
  let rest = 0;
  const kept = source.filter((s) => nc.has(s.slug) || limit === undefined || rest++ < limit);
  const byId = new Map(kept.map((s) => [s.id, s]));
  const rank = (d: Difficulty) => DIFFS.indexOf(d);
  return kept.map((s): LcCatalogRow => {
    const n = nc.get(s.slug);
    const cls = n || !s.algorithms ? undefined : classes.get(s.id);
    const related = (ids: number[] | undefined, harder: boolean) =>
      [
        ...new Set(
          (ids ?? []).flatMap((id) => {
            const t = byId.get(id);
            return t && t.id !== s.id && (!harder || rank(t.difficulty) >= rank(s.difficulty))
              ? [t.slug]
              : [];
          }),
        ),
      ].slice(0, MAX_RELATED);
    const premium = n ? n.premium === true : s.premium;
    return {
      slug: s.slug,
      title: n?.title ?? s.title,
      pattern: n?.pattern ?? (!s.algorithms ? 'other' : (cls?.pattern ?? patternOfTags(s.tags))),
      difficulty: n?.difficulty ?? s.difficulty,
      ...(premium ? { premium: true as const } : {}),
      id: s.id,
      tags: s.tags,
      acRate: s.acRate,
      similar: related(cls?.similar, false),
      harder: related(cls?.harder, true),
      by: n ? 'neetcode' : !s.algorithms ? 'rule' : cls ? 'model' : 'tags',
    };
  });
}
export function catalogCounts(rows: readonly LcCatalogRow[]) {
  const by = Object.fromEntries(LC_CLASSIFIED_BY.map((k) => [k, 0])) as Record<
    LcClassifiedBy,
    number
  >;
  for (const r of rows) by[r.by]++;
  return { count: rows.length, premium: rows.filter((r) => r.premium).length, by };
}

// --- Packed form, for the store: a tag table and one tuple per row, related problems by id ---
// [id, slug, title, difficulty 0–2, pattern index (-1 = other), premium 0|1, acRate, tag indexes, similar ids,
//  harder ids, classifier index]
export type LcPackedRow = [
  number,
  string,
  string,
  number,
  number,
  0 | 1,
  number | null,
  number[],
  number[],
  number[],
  number,
];
export interface LcPackedCatalog {
  v: 1;
  tags: string[];
  rows: LcPackedRow[];
}
export function packCatalog(rows: readonly LcCatalogRow[]): LcPackedCatalog {
  const tags: string[] = [];
  const tagIdx = new Map<string, number>();
  const idOf = new Map(rows.map((r) => [r.slug, r.id]));
  const ti = (t: string) => {
    if (!tagIdx.has(t)) tagIdx.set(t, tags.push(t) - 1);
    return tagIdx.get(t)!;
  };
  const ids = (slugs: string[]) => slugs.flatMap((s) => (idOf.has(s) ? [idOf.get(s)!] : []));
  return {
    v: 1,
    tags,
    rows: rows.map((r) => [
      r.id,
      r.slug,
      r.title,
      DIFFS.indexOf(r.difficulty),
      r.pattern === 'other' ? -1 : PATTERNS.indexOf(r.pattern),
      r.premium ? 1 : 0,
      r.acRate,
      r.tags.map(ti),
      ids(r.similar),
      ids(r.harder),
      LC_CLASSIFIED_BY.indexOf(r.by),
    ]),
  };
}
// The store's packed catalog back to rows; a malformed tuple is skipped, a malformed whole is null.
export function unpackCatalog(raw: unknown): LcCatalogRow[] | null {
  const p = raw as LcPackedCatalog | null;
  if (!p || p.v !== 1 || !Array.isArray(p.tags) || !Array.isArray(p.rows)) return null;
  const tuples = p.rows.filter(
    (t): t is LcPackedRow =>
      Array.isArray(t) &&
      t.length === 11 &&
      Number.isInteger(t[0]) &&
      typeof t[1] === 'string' &&
      SLUG_RE.test(t[1]) &&
      typeof t[2] === 'string' &&
      DIFFS[t[3]] !== undefined &&
      (t[4] === -1 || PATTERNS[t[4]] !== undefined) &&
      (t[6] === null || typeof t[6] === 'number') &&
      [t[7], t[8], t[9]].every((a) => Array.isArray(a) && a.every((n) => Number.isInteger(n))) &&
      LC_CLASSIFIED_BY[t[10]] !== undefined,
  );
  const slugOf = new Map(tuples.map((t) => [t[0], t[1]]));
  const slugs = (ids: number[]) => ids.flatMap((id) => (slugOf.has(id) ? [slugOf.get(id)!] : []));
  return tuples.map((t) => ({
    slug: t[1],
    title: t[2],
    pattern: t[4] === -1 ? 'other' : PATTERNS[t[4]]!,
    difficulty: DIFFS[t[3]]!,
    ...(t[5] === 1 ? { premium: true as const } : {}),
    id: t[0],
    tags: t[7].flatMap((i) => (typeof p.tags[i] === 'string' ? [p.tags[i]] : [])),
    acRate: t[6],
    similar: slugs(t[8]),
    harder: slugs(t[9]),
    by: LC_CLASSIFIED_BY[t[10]]!,
  }));
}

// --- The import, over the API (startCatalogImport / getCatalogStatus) ---
// absent: never imported. staging: a classification upload has some of its parts. running: a job holds the claim.
// ready: every algorithm problem has a pattern from NeetCode or a model. partial: some still have only their tags'
// guess (rows the dataset added since the last classification; each kick classifies a few). failed: the newest
// job failed and no catalog was ever built (a failure after one keeps the live catalog and sets lastError).
export type CatalogImportState = 'absent' | 'staging' | 'running' | 'ready' | 'partial' | 'failed';
export interface CatalogStatus {
  state: CatalogImportState;
  sha: string | null; // the source commit the live catalog was built from
  count: number;
  premium: number;
  by: Record<LcClassifiedBy, number> | null;
  importedAt: number | null;
  staged: { have: number; of: number } | null; // the classification upload's parts so far
  costUsd: number; // the server-side model path's spend, cumulative; it stops at LC_CATALOG_COST_STOP_USD
  lastError: string | null;
}
// One call per part of the classification file (parts in any order; a part 1 starts a new upload); the last part
// in, or a call with no classes, kicks the import. `limit` caps the non-NeetCode problems (dev's import).
export interface CatalogImportInput {
  classes?: string;
  part?: number;
  parts?: number;
  limit?: number;
}
export const LC_CATALOG_PART_MAX_CHARS = 64_000;
export const LC_CATALOG_PARTS_MAX = 8;
export const LC_CATALOG_COST_STOP_USD = 0.25;
export const LC_CATALOG_MODEL_ROWS_PER_KICK = 50;

// Validates and normalizes the import's input; throws with the reason.
export function normalizeCatalogImport(raw: unknown): CatalogImportInput {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Import input must be an object');
  const o = raw as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !['classes', 'part', 'parts', 'limit'].includes(k));
  if (extra.length) throw new Error(`Unknown import field: ${extra[0]}`);
  const int = (v: unknown, lo: number, hi: number) =>
    Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  const out: CatalogImportInput = {};
  if (o.limit !== undefined) {
    if (!int(o.limit, 1, 10_000)) throw new Error('limit must be a whole number from 1 to 10000');
    out.limit = o.limit as number;
  }
  if (o.classes === undefined) {
    if (o.part !== undefined || o.parts !== undefined)
      throw new Error('part and parts go with classes');
    return out;
  }
  if (typeof o.classes !== 'string' || !o.classes.trim())
    throw new Error('classes must be non-empty text');
  if (o.classes.length > LC_CATALOG_PART_MAX_CHARS)
    throw new Error(
      `A classes part is at most ${LC_CATALOG_PART_MAX_CHARS} characters; split it into parts`,
    );
  const parts = o.parts ?? 1;
  const part = o.part ?? 1;
  if (!int(parts, 1, LC_CATALOG_PARTS_MAX))
    throw new Error(`parts must be 1 to ${LC_CATALOG_PARTS_MAX}`);
  if (!int(part, 1, parts as number)) throw new Error('part must be 1 to parts');
  return { ...out, classes: o.classes, part: part as number, parts: parts as number };
}
