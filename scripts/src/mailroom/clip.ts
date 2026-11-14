// The `clip` job, container side: the Mac's clipboard image for a Ctrl+V in a container Claude Code. The everyday
// path is tools/coi/xclip (bash, no node start); this is the job's contract mirrored for validateJob, and
// `pnpm mailroom clip-probe`, the same round trip by hand. Mac side: tools/mailroom/jobs/clip.sh. docs/ops/MAILROOM.md
// → The clip job.
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Clock } from '../bot/dispatch.ts';
import { isoSeconds, makeId } from './ids.ts';
import { NotInstalled, submit, waitForResult, withdraw } from './submit.ts';
import type { Fs } from './submit.ts';

export const CLIP_EXPIRES_MIN = 1; // the Mac refuses more than 2: a queued paste is worthless a minute later
export const CLIP_MAX_EXPIRES_MIN = 2;
export const CLIP_WAIT_MS = 15_000; // the shim's caps too (tools/coi/xclip)
export const CLIP_GRACE_MS = 17_000; // once the Mac took it: its read (≤ 10 s) + banner (≤ 5 s)

export interface ClipJob {
  v: 1;
  id: string;
  job: 'clip';
  submittedAt: string;
  expiresInMin: number;
  params: Record<string, never>;
}

export function makeClipJob(nowMs: number, rand?: string): ClipJob {
  return {
    v: 1,
    id: makeId('clip', nowMs, rand),
    job: 'clip',
    submittedAt: isoSeconds(nowMs),
    expiresInMin: CLIP_EXPIRES_MIN,
    params: {},
  };
}

// jobs/clip.sh → CLIP_JQ: params are {} exactly, and the job lives at most 2 min.
export function validateClipParams(params: unknown, expiresInMin: number): 'BAD_PARAM' | null {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return 'BAD_PARAM';
  if (Object.keys(params).length) return 'BAD_PARAM';
  return expiresInMin > CLIP_MAX_EXPIRES_MIN ? 'BAD_PARAM' : null;
}

export const CLIP_REASON_HINT = {
  NO_IMAGE: 'no image on the Mac clipboard (text is never served)',
  MIXED_TEXT:
    'the copy carries text as well as an image (an Excel range, a Word selection) — refused, so text never crosses as a picture; copy just the image, or take a screenshot',
  NOT_FRONTMOST: 'a terminal (iTerm2 or Terminal) must be the frontmost app on the Mac',
  REPEAT: 'this copy was already served 3 times — copy it again',
  RATE_LIMITED: '6 serves in the last minute already — wait a minute',
  TOO_LARGE: 'the image is over 16 MiB as PNG',
  PASTEBOARD_DENIED:
    'macOS listed an image but would not hand it over — allow osascript under System Settings → Privacy & Security',
  CLIP_FAILED: 'the Mac could not read or write the image',
  TIMEOUT:
    'the pasteboard read took over 10 s — likely a macOS paste-permission prompt on the Mac: answer it, then press Ctrl+V again',
} as const;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_BYTES = 16 * 1024 * 1024; // jobs/clip.sh → CLIP_MAX_BYTES
// As the shim checks: one open that refuses a link, then a regular file within the cap with PNG magic — and the bytes
// written are the ones checked. The out dir is made if missing.
function copyPng(from: string, to: string): void {
  let fd: number;
  try {
    fd = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if ((err as { code?: string }).code === 'ELOOP')
      throw new Error(`${from} is not a regular file`, { cause: err });
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${from} is not a regular file`);
    if (st.size > MAX_BYTES) throw new Error(`${from} is over 16 MiB`);
    const buf = Buffer.alloc(st.size);
    const n = readSync(fd, buf, 0, st.size, 0);
    if (!buf.subarray(0, Math.min(n, 8)).equals(PNG_MAGIC)) throw new Error(`${from} is not a PNG`);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, buf.subarray(0, n), { mode: 0o600 });
  } finally {
    closeSync(fd);
  }
}

export interface ClipDeps {
  fs: Fs;
  clock: Clock;
  dir: string;
  out: string;
  log: (s: string) => void;
  copy?: (from: string, to: string) => void; // defaults: checked as a regular PNG file, then copied
  remove?: (p: string) => void;
}

// `pnpm mailroom clip-probe`: one clip job by hand; the served PNG goes to `out`, and its copy in the shared folder is
// deleted (a screenshot shouldn't sit in .hostjobs). Exit 0 served, 1 refused, 3 no answer (withdrawn).
export async function clipProbe(d: ClipDeps, waitMs = CLIP_WAIT_MS): Promise<number> {
  const job = makeClipJob(d.clock.now());
  try {
    submit(d.fs, d.dir, job);
  } catch (err) {
    if (err instanceof NotInstalled) {
      d.log(`clip: ${err.message}`);
      return 3;
    }
    throw err;
  }
  let r = await waitForResult(d.fs, d.clock, d.dir, job.id, waitMs, 200);
  if (!r) {
    if (withdraw(d.fs, d.dir, job.id)) {
      d.log(
        `clip: no answer in ${waitMs / 1000} s — withdrawn; the Mac is asleep, the mailroom is not installed, or an old single-lane mailroom is busy (reinstall from main)`,
      );
      return 3;
    }
    // The Mac took it: wait out its read, so a late image is collected rather than left in the shared folder.
    r = await waitForResult(d.fs, d.clock, d.dir, job.id, CLIP_GRACE_MS, 200);
    if (!r) {
      d.log(
        `clip: the Mac took the job but gave no answer in ${(waitMs + CLIP_GRACE_MS) / 1000} s`,
      );
      return 3;
    }
  }
  if (r.status !== 'served') {
    const hint = CLIP_REASON_HINT[r.reason as keyof typeof CLIP_REASON_HINT] ?? '';
    d.log(`clip: ${r.status} ${r.reason ?? ''}${hint ? ` — ${hint}` : ''}`);
    return 1;
  }
  const png = join(d.dir, 'results', job.id, 'clip.png');
  try {
    (d.copy ?? copyPng)(png, d.out);
  } finally {
    (d.remove ?? ((p) => rmSync(p, { force: true })))(png);
  }
  const c = r.clip;
  d.log(
    `clip: served ${c?.bytes ?? '?'} bytes (${c?.source ?? '?'}, ${c?.frontmost ?? '?'} in front) in ${r.durationMs} ms → ${d.out}`,
  );
  return 0;
}
