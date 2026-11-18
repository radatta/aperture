import { describe, expect, it } from 'vitest';
import { mergedFromLog, mergedNumbers, parseMainLog } from './mergelog.ts';
import type { Pr } from './prs.ts';

const sha = (c: string) => c.repeat(40);
const T = 1_763_400_000;

describe('mergelog', () => {
  it('reads squash subjects ending (#N); anything else is skipped', () => {
    const text = [
      `${sha('a')}\t${T}\tReview: one parallel round (#203)`,
      `${sha('b')}\t${T - 60}\ta direct commit`,
      `${sha('c')}\t${T - 120}\tmentions (#9) mid-subject only`,
      'garbage',
      '',
    ].join('\n');
    expect(parseMainLog(text)).toEqual([{ number: 203, sha: sha('a'), mergedAt: T * 1000 }]);
  });
  it('stands in a MERGED PR only for a named number gh lacks and the log holds', () => {
    const gh = [{ number: 5, branch: 'x', state: 'OPEN' } as Pr];
    const log = [
      { number: 5, sha: sha('a'), mergedAt: 1 },
      { number: 7, sha: sha('b'), mergedAt: 2 },
    ];
    const out = mergedFromLog(
      [
        { branch: 'x', pr: 5 },
        { branch: 'y', pr: 7 },
        { branch: 'y2', pr: 7 },
        { branch: 'z', pr: 8 },
        { branch: 'w', pr: null },
      ],
      gh,
      log,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      number: 7,
      branch: 'y',
      state: 'MERGED',
      mergedAt: 2,
      mergeSha: sha('b'),
    });
  });
  it("merged numbers: the log, with gh's merge time over it", () => {
    const m = mergedNumbers(
      [
        { number: 7, state: 'MERGED', mergedAt: 9 } as Pr,
        { number: 8, state: 'OPEN', mergedAt: null } as Pr,
      ],
      [
        { number: 7, sha: sha('a'), mergedAt: 2 },
        { number: 6, sha: sha('b'), mergedAt: 1 },
      ],
    );
    expect([...m]).toEqual([
      [7, 9],
      [6, 1],
    ]);
  });
});
