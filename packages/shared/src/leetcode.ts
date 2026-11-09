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

// The methods the browser extension calls. The handler accepts the device token for exactly these (and the
// user's JWT too); every other method takes the JWT alone. recordLeetcodeAttempt leaves in PR D.
export const LC_INGEST_METHODS = [
  'recordLeetcodeAttempt',
  'lcSittingStart',
  'lcSittingEvents',
] as const;
export const isLcIngestMethod = (m: string): boolean =>
  (LC_INGEST_METHODS as readonly string[]).includes(m);
