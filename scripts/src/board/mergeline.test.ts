import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mergeLine, mergeLineText, withSuffix } from './mergeline.ts';
import type { LaneRow, SourceRow } from './tower/derive.ts';
import type { Pr } from './tower/prs.ts';

const sha = (c: string) => c.repeat(40);
const row = (branch: string, n: number, state = 'MERGE ME', hold: string | null = null) =>
  ({ branch, state, pr: { number: n, title: `t${n}`, url: null }, hold }) as unknown as LaneRow;
const pr = (n: number, s: string | null) => ({ number: n, sha: s }) as unknown as Pr;
const ok: SourceRow = { name: 'gh PRs', state: 'ok', at: 0, detail: null };
const ROOT = '/repo/aperture';
const HAS_ZSH = existsSync('/usr/bin/zsh') || existsSync('/bin/zsh'); // CI's runner may have none: skipped there

describe('mergeLine', () => {
  it('MERGE ME only, in mergeOrder then PR number, each pinned to its head; HOLD left out and said', () => {
    const m = mergeLine(
      [
        row('zulu', 9),
        row('alpha', 12),
        row('bravo', 7),
        row('hold-me', 5, 'HOLD', 'dev: x is testing'),
      ],
      ['alpha', 'zulu'],
      [pr(9, sha('a')), pr(12, sha('b')), pr(7, sha('c')), pr(5, sha('d'))],
      ROOT,
      ok,
    );
    expect(m.head).toBe('MERGE 3 · landing order: PR 12 alpha, PR 9 zulu, PR 7 bravo');
    const flags = '--squash --admin --body ""';
    expect(m.line).toBe(
      `cd ${ROOT} && GH_PAGER=cat gh pr merge 12 ${flags} --match-head-commit ${sha('b')} && ` +
        `GH_PAGER=cat gh pr merge 9 ${flags} --match-head-commit ${sha('a')} && ` +
        `GH_PAGER=cat gh pr merge 7 ${flags} --match-head-commit ${sha('c')}`,
    );
    expect(m.notes).toEqual(['left out, on hold: PR 5 hold-me (dev: x is testing)']);
  });
  it('a PR whose head the list lacks (or a bad sha) is left out, never merged unpinned', () => {
    const m = mergeLine(
      [row('a', 1), row('b', 2)],
      [],
      [pr(1, null), pr(2, 'not-a-sha')],
      ROOT,
      ok,
    );
    expect(m).toEqual({
      head: 'MERGE none',
      line: null,
      notes: ['left out, head unknown: PR 1 a', 'left out, head unknown: PR 2 b'],
    });
  });
  it('gh PRs not ok: unknown, no line, whatever the rows say', () => {
    const m = mergeLine([row('a', 1)], [], [pr(1, sha('a'))], ROOT, {
      ...ok,
      state: 'stale',
      detail: 'HTTP 502\u001b[2J',
    });
    expect(m).toEqual({
      head: 'MERGE unknown (gh PRs stale: HTTP 502 [2J)',
      line: null,
      notes: [],
    });
    expect(mergeLine([], [], [], ROOT, ok)).toEqual({ head: 'MERGE none', line: null, notes: [] });
  });
  it('no branch or title reaches the line: only numbers and hex', () => {
    const m = mergeLine([row('evil;rm', 3)], [], [pr(3, sha('e'))], ROOT, ok);
    expect(m.line).not.toContain('evil');
    expect(m.head).toContain('evil;rm'); // the head is text for the hub, never run
  });
  const suffix = `; (r=$?; set -C; echo $r > ${ROOT}/localNotes/board/ran/merge-0abc)`;
  const one = mergeLine(
    [row('a', 1), row('b', 2)],
    [],
    [pr(1, sha('f')), pr(2, sha('0'))],
    ROOT,
    ok,
  );
  it('the file, and the marker on its command line only', () => {
    const text = mergeLineText(one);
    expect(text.split('\n')).toEqual([one.head, one.line, '']);
    expect(withSuffix(text, suffix).split('\n')).toEqual([one.head, `${one.line}${suffix}`]);
  });
  it.skipIf(!HAS_ZSH)('the printed line parses under zsh -f (the Mac shell)', () => {
    const zsh = spawnSync('zsh', ['-f', '-n', '-c', `${one.line}${suffix}`], { encoding: 'utf8' });
    expect([zsh.status, zsh.stderr]).toEqual([0, '']);
  });
});
