import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEV_CAP_BAND, DEV_SLOT_CAPS, inCapBand, slotCapMin } from './lc-coach';

// The devcheck's copy of the per-slot caps matches packages/shared/src/coach.ts (scripts can't import it).
describe('the devcheck’s cap table', () => {
  const src = readFileSync(
    new URL('../../../../packages/shared/src/coach.ts', import.meta.url),
    'utf8',
  );
  it('pins slotCaps, the unknown-difficulty row and the AI band to COACH_PARAMS', () => {
    const block = /slotCaps: \{\n([\s\S]*?)\n {2}\},/.exec(src)?.[1] ?? '';
    const rows = Object.fromEntries(
      [
        ...block.matchAll(/^ {4}'?([\w-]+)'?: \{ Easy: (\d+), Medium: (\d+), Hard: (\d+) \},$/gm),
      ].map((m) => [m[1], { Easy: Number(m[2]), Medium: Number(m[3]), Hard: Number(m[4]) }]),
    );
    expect(rows).toEqual(DEV_SLOT_CAPS);
    expect(src).toMatch(/capUnknownDifficulty: 'Medium',/);
    expect(src).toContain(
      `capAi: { minFactor: ${DEV_CAP_BAND[0]}, maxFactor: ${DEV_CAP_BAND[1]} },`,
    );
  });
  it('reads a cap and its band', () => {
    expect(slotCapMin('re-solve', 'Easy')).toBe(10);
    expect(slotCapMin('new', null)).toBe(45);
    expect([22, 23, 67, 68].map((v) => inCapBand(v, 'new', null))).toEqual([
      false,
      true,
      true,
      false,
    ]);
    expect(inCapBand(30.5, 'new', null)).toBe(false);
  });
});
