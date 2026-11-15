// tools/mailroom/testdata/jobs.jsonl, read the way run-fixtures.sh reads it, so the container's checks run the
// same cases as the Mac runner's.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isoSeconds, sha256 } from './job.ts';

export const TOOLS_DIR = fileURLToPath(new URL('../../../tools/mailroom/', import.meta.url));

export interface Case {
  name: string;
  patch?: Record<string, unknown>;
  unset?: string[][];
  submittedAgoMin?: number;
  bodyRepeat?: { s: string; n: number };
  raw?: string;
  file?: string;
  setup?: string;
  kind?: 'sim' | 'clip' | 'edit-pr' | 'fixtures';
  lane?: 'slow' | 'fast'; // runner.sh's third argument; none = both lanes
  ts?: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
// jq's `*`: objects merge recursively, anything else is replaced.
export function deepMerge(a: unknown, b: unknown): unknown {
  if (!isObj(a) || !isObj(b)) return b;
  const out: Obj = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = deepMerge(a[k], v);
  return out;
}

export interface Bases {
  base: Obj;
  simBase: Obj;
  clipBase: Obj;
  editBase: Obj;
  fixturesBase: Obj;
}
export function loadCases(): Bases & { cases: Case[] } {
  const lines = readFileSync(`${TOOLS_DIR}testdata/jobs.jsonl`, 'utf8').trim().split('\n');
  const bases = JSON.parse(lines[0] ?? '{}') as Bases;
  return { ...bases, cases: lines.slice(2).map((l) => JSON.parse(l) as Case) };
}
// The base a case patches, as run-fixtures.sh picks it.
export const baseFor = (b: Bases, c: Case): Obj =>
  c.kind === 'sim'
    ? b.simBase
    : c.kind === 'clip'
      ? b.clipBase
      : c.kind === 'edit-pr'
        ? b.editBase
        : c.kind === 'fixtures'
          ? b.fixturesBase
          : b.base;

// The case's job and the inbox file stem it would be dropped under.
export function buildJob(base: Obj, c: Case, nowMs: number): { job: unknown; stem: string } {
  const job = deepMerge(structuredClone(base), c.patch ?? {}) as Obj;
  for (const path of c.unset ?? []) {
    let o: unknown = job;
    for (const k of path.slice(0, -1)) o = isObj(o) ? o[k] : undefined;
    if (isObj(o)) delete o[path[path.length - 1] ?? ''];
  }
  const params = job.params as Obj | undefined;
  if (c.bodyRepeat && params) params.body = c.bodyRepeat.s.repeat(c.bodyRepeat.n);
  if (job.submittedAt === 'now')
    job.submittedAt = isoSeconds(nowMs - 60_000 * (c.submittedAgoMin ?? 0));
  if (params?.bodySha256 === 'auto' && typeof params.body === 'string')
    params.bodySha256 = sha256(params.body);
  const id = typeof job.id === 'string' ? job.id : '20261101T204512Z-mac-mailroom-3kx9';
  return { job, stem: (c.file ?? `${id}.json`).replace(/\.json$/, '') };
}
