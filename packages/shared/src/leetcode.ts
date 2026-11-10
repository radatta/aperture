import type { LeetcodeVerdict } from './types';

// Normalize LeetCode's raw submission result into our verdict enum. status_code is the primary signal;
// status_msg text is the fallback. The enum is authoritative server-side so the dep-free extension can
// stay dumb and just forward the raw signals it observes on the wire.
const BY_CODE: Record<number, LeetcodeVerdict> = {
  10: 'accepted',
  11: 'wrong_answer',
  12: 'memory_limit',
  14: 'time_limit',
  15: 'runtime_error',
  20: 'compile_error',
};

const BY_MSG: Record<string, LeetcodeVerdict> = {
  accepted: 'accepted',
  'wrong answer': 'wrong_answer',
  'memory limit exceeded': 'memory_limit',
  'time limit exceeded': 'time_limit',
  'runtime error': 'runtime_error',
  'compile error': 'compile_error',
};

export function normalizeVerdict(
  statusCode?: number | null,
  statusMsg?: string | null,
): LeetcodeVerdict {
  if (statusCode != null && BY_CODE[statusCode]) return BY_CODE[statusCode]!;
  if (statusMsg) {
    const hit = BY_MSG[statusMsg.trim().toLowerCase()];
    if (hit) return hit;
  }
  return 'other';
}

// LeetCode's language ids → their display names, from its submittableLanguageList (captured 2026-11-08). A
// snapshot's lang is updateSyncedCode's numeric id — that it's this id space is an inference, seen for 11
// (Python3) only. Text that isn't an id passes through; an unknown id is null, so the caller falls back to the
// sitting's own lang.
const LANG_BY_ID: Record<number, string> = {
  0: 'C++',
  1: 'Java',
  2: 'Python',
  3: 'MySQL',
  4: 'C',
  5: 'C#',
  6: 'JavaScript',
  7: 'Ruby',
  8: 'Bash',
  9: 'Swift',
  10: 'Go',
  11: 'Python3',
  12: 'Scala',
  13: 'Kotlin',
  14: 'MS SQL Server',
  15: 'Oracle',
  18: 'Rust',
  19: 'PHP',
  20: 'TypeScript',
  21: 'Racket',
  22: 'Erlang',
  23: 'Elixir',
  24: 'Dart',
  25: 'Pandas',
  26: 'React',
  27: 'Vanilla JS',
  28: 'PostgreSQL',
  29: 'Cangjie',
};
export function lcLangName(v: string | null | undefined): string | null {
  if (v == null || v === '') return null;
  return /^\d+$/.test(v) ? (LANG_BY_ID[Number(v)] ?? null) : v;
}

// The methods the browser extension calls. The handler accepts the device token for exactly these (and the
// user's JWT too); every other method takes the JWT alone.
export const LC_INGEST_METHODS = ['lcSittingStart', 'lcSittingEvents'] as const;
export const isLcIngestMethod = (m: string): boolean =>
  (LC_INGEST_METHODS as readonly string[]).includes(m);
