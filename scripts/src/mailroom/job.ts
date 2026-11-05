// The mailroom's job contract, container side: build an `open-pr` job and check any job with the same rules, in
// the same order, as the Mac runner (tools/mailroom/runner.sh + jobs/open-pr.sh; a `sim` job's plan: sim.ts). The runner is the authority; this is
// the early, fixable copy, and tools/mailroom/testdata/jobs.jsonl drives both (job.test.ts). docs/ops/MAILROOM.md.
import { createHash } from 'node:crypto';
import { isoSeconds, makeId } from './ids.ts';
import { SIM_REASON_HINT, validateSimParams } from './sim.ts';
import type { SimReason } from './sim.ts';

export const JOBS = ['open-pr', 'sim'] as const;
export const EXPIRES_IN_MIN = 20;
export const MAX_BODY_BYTES = 65536;
const ENVELOPE_KEYS = ['v', 'id', 'job', 'submittedAt', 'expiresInMin', 'params'];
const PARAM_KEYS = ['body', 'bodySha256', 'branch', 'sha', 'title'];
const PROTECTED = ['main', 'master', 'dev'];

export const ID_RE = /^[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{1,48}$/;
export const BRANCH_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const TITLE_RE = /^[A-Za-z0-9][A-Za-z0-9 .,:;()/+_&'-]{3,99}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
// Text GitHub renders as code (fenced blocks, then exact-run backtick spans) can't mention or autolink.
const FENCE_RE = /(^|\n)(?<f>`{3,})[^`\n]*\n[\s\S]*?\n\k<f>`*[ \t]*(?=\n|$)/g;
const SPAN_RE = /(?<![`\\])(?<t>`+)[^`\n]+\k<t>(?!`)/g;
const MENTION_RE = /(^|[^A-Za-z0-9_])@[A-Za-z0-9]/;
const HASH_REF_RE = /#[0-9]|(^|[^A-Za-z0-9_])GH-[0-9]/;
const XREF_RE =
  /[Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm]\/(?!radatta\/aperture\/)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(issues|pull|discussions)\/[0-9]/;

export type Reason =
  | 'BAD_JSON'
  | 'BAD_ID'
  | 'UNKNOWN_JOB'
  | 'BAD_PARAM'
  | 'EXPIRED'
  | 'BAD_TEXT'
  | 'MENTION'
  | 'HASH_REF'
  | 'XREF'
  | SimReason;

export interface OpenPrParams {
  branch: string;
  sha: string;
  title: string;
  body: string;
  bodySha256: string;
}
export interface Job {
  v: 1;
  id: string;
  job: 'open-pr';
  submittedAt: string;
  expiresInMin: number;
  params: OpenPrParams;
}

export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
export { isoSeconds, makeId } from './ids.ts';

export function makeOpenPrJob(
  p: Omit<OpenPrParams, 'bodySha256'>,
  nowMs: number,
  id = makeId(p.branch, nowMs),
): Job {
  return {
    v: 1,
    id,
    job: 'open-pr',
    submittedAt: isoSeconds(nowMs),
    expiresInMin: EXPIRES_IN_MIN,
    params: { ...p, bodySha256: sha256(p.body) },
  };
}

export const visible = (body: string) => body.replace(FENCE_RE, '\n').replace(SPAN_RE, ' ');

// Any hidden or control character: C0 except tab/newline, DEL + C1, soft hyphen, zero-width, line/paragraph
// separators, invisible operators, bidi (incl. U+061C), BOM, U+FFFD, tag characters, variation selectors, Hangul
// and Mongolian fillers — and any HTML entity (`&#x40;` renders as @).
const ENTITY_RE = /&#|&[A-Za-z][A-Za-z0-9]*;/;
const FILLERS = [0xad, 0x61c, 0x115f, 0x1160, 0x180e, 0x3164, 0xffa0];
function hiddenChar(s: string): boolean {
  if (ENTITY_RE.test(s)) return true;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c < 32 && c !== 9 && c !== 10) || (c >= 127 && c <= 159) || FILLERS.includes(c))
      return true;
    if (
      (c >= 0xfe00 && c <= 0xfe0f) ||
      (c >= 0x180b && c <= 0x180f) ||
      (c >= 0xe0100 && c <= 0xe01ef)
    )
      return true;
    if (
      (c >= 0x200b && c <= 0x200f) ||
      (c >= 0x2028 && c <= 0x202e) ||
      (c >= 0x2060 && c <= 0x2064) ||
      (c >= 0x2066 && c <= 0x2069) ||
      (c >= 0xe0000 && c <= 0xe007f)
    )
      return true;
    if (c === 0xfeff || c === 0xfffd || (c >= 0xd800 && c <= 0xdfff)) return true; // jq reads a lone surrogate as U+FFFD
  }
  return false;
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x: unknown): x is string => typeof x === 'string';
const sameKeys = (o: Record<string, unknown>, want: string[]) =>
  JSON.stringify(Object.keys(o).sort()) === JSON.stringify([...want].sort());

// The runner's checks in its order; null when the job would be run. `stem` is the inbox file name minus .json.
export function validateJob(job: unknown, stem: string, nowMs: number): Reason | null {
  if (!isObj(job)) return 'BAD_JSON';
  if (Object.keys(job).some((k) => !ENVELOPE_KEYS.includes(k)) || job.v !== 1) return 'BAD_JSON';
  if (job.id !== stem) return 'BAD_ID';
  if (!str(job.job) || !(JOBS as readonly string[]).includes(job.job)) return 'UNKNOWN_JOB';
  const exp = job.expiresInMin;
  if (!str(job.submittedAt) || !ISO_RE.test(job.submittedAt)) return 'BAD_PARAM';
  if (typeof exp !== 'number' || !Number.isInteger(exp) || exp < 1 || exp > 60) return 'BAD_PARAM';
  const at = Date.parse(job.submittedAt);
  if (Number.isNaN(at)) return 'BAD_PARAM';
  if (at > nowMs + 300_000 || at + exp * 60_000 < nowMs) return 'EXPIRED';
  if (job.job === 'sim') return validateSimParams(job.params);

  const p = job.params;
  if (!isObj(p) || !sameKeys(p, PARAM_KEYS)) return 'BAD_PARAM';
  if (!str(p.branch) || !BRANCH_RE.test(p.branch) || PROTECTED.includes(p.branch))
    return 'BAD_PARAM';
  if (!str(p.sha) || !SHA_RE.test(p.sha)) return 'BAD_PARAM';
  if (!str(p.title) || !TITLE_RE.test(p.title)) return 'BAD_PARAM';
  if (XREF_RE.test(p.title)) return 'XREF';
  if (!str(p.body)) return 'BAD_PARAM';
  const bytes = Buffer.byteLength(p.body, 'utf8');
  if (bytes < 1 || bytes > MAX_BODY_BYTES) return 'BAD_PARAM';
  if (!str(p.bodySha256) || !SHA256_RE.test(p.bodySha256)) return 'BAD_PARAM';
  if (hiddenChar(p.body)) return 'BAD_TEXT';
  const v = visible(p.body);
  if (MENTION_RE.test(v)) return 'MENTION';
  if (HASH_REF_RE.test(v)) return 'HASH_REF';
  if (XREF_RE.test(v)) return 'XREF';
  return null;
}

// What to fix, for the container's own refusal (the Mac result carries only the code).
export const REASON_HINT: Record<Reason, string> = {
  ...SIM_REASON_HINT,
  BAD_JSON: 'malformed job',
  BAD_ID: 'job id does not match its file name',
  UNKNOWN_JOB: 'job not on the allowlist',
  BAD_PARAM: `branch must match ${BRANCH_RE.source} (not main/master/dev); title must match ${TITLE_RE.source}; body 1–64 KiB — or, for a sim job, ${SIM_REASON_HINT.BAD_PARAM}`,
  EXPIRED: 'job expired',
  BAD_TEXT: 'the body holds a control, zero-width or bidi character',
  MENTION:
    'an @mention outside backticks — GitHub would notify that login; wrap it in backticks or drop the @',
  HASH_REF:
    'a #<number> or GH-<number> outside backticks — GitHub would autolink it; say "PR 33" instead',
  XREF: 'a link to another repo’s issue/PR — GitHub would post a cross-reference there; wrap it in backticks',
};
