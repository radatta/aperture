// `score --check` and estimateGaps() must never load the transcript cache (seconds cold) or fetch: they run on every
// queue write. loadCache throws here, so a check that reached it would fail.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { estimateGaps, main } from './cli.ts';

vi.mock('./store.ts', async (orig) => ({
  ...(await orig<typeof import('./store.ts')>()),
  loadCache: () => {
    throw new Error('loaded the transcript cache');
  },
}));

let tmp: string;
const lines: string[] = [];
const out = (s: string) => void lines.push(s);
const noGh = async (): Promise<string> => {
  throw new Error('fetched');
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'usage-check-'));
  mkdirSync(join(tmp, 'usage', 'cache'), { recursive: true });
  mkdirSync(join(tmp, 'board', 'lanes'), { recursive: true });
  writeFileSync(
    join(tmp, 'board', 'lanes', 'lane-a.json'),
    JSON.stringify({ v: 1, branch: 'lane-a', phase: 'build', updatedAt: '2026-01-05T10:00:00Z' }),
  );
  writeFileSync(
    join(tmp, 'usage', 'cache', 'prs.json'),
    JSON.stringify({ fetchedAt: 0, since: '2026-01-01', prs: [] }),
  );
  lines.length = 0;
  vi.stubEnv('APERTURE_USAGE_DIR', join(tmp, 'usage'));
  vi.stubEnv('APERTURE_USAGE_PROJECTS', join(tmp, 'projects'));
  vi.stubEnv('APERTURE_BOARD_DIR', join(tmp, 'board'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

it('checks from the ledger, lane files and PR cache alone', async () => {
  expect(await main(['score', '--check'], out, { gh: noGh })).toBe(1);
  expect(lines).toEqual([
    'gap: lane-a: no usage estimate (phase build) → pnpm usage estimate --lane lane-a --lines <n> [--ui] --lenses <…>',
  ]);
  expect(estimateGaps()).toHaveLength(1);
  // the mock is live: the full score does load the cache
  await expect(main(['score', '--no-scan'], out, { gh: noGh })).rejects.toThrow(
    'loaded the transcript cache',
  );
});
