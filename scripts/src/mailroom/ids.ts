// Job ids, shared by every job type (job.ts, sim.ts) without an import cycle between them.
import { randomBytes } from 'node:crypto';

export const isoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// `<UTC stamp>-<branch or name, cut>-<4 random>`: unique per submit, and the result directory's name.
export function makeId(name: string, nowMs: number, rand = randomBytes(2).toString('hex')): string {
  const stamp = isoSeconds(nowMs).replace(/[-:]/g, '');
  return `${stamp}-${name.slice(0, 43)}-${rand}`;
}
