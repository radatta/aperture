import { describe, expect, it } from 'vitest';
import { findIdentifiers } from '../identifiers.ts';
import { MAC_PLACEHOLDER } from '../mac-root.ts';
import { macLine, parseAdmission } from './mac-line.ts';

const ROOT = '/mac/repo';
const P = 'repos/o/r/environments/dev/deployment-branch-policies';

// Outside single quotes, no zsh glob or history character may appear.
const unquoted = (line: string) => line.replace(/'[^']*'/g, "''");

describe('macLine', () => {
  it('not admitted: the branch delete only', () => {
    expect(macLine(ROOT, 'b', true, { kind: 'none' }, 'o/r')).toBe(`cd ${ROOT} && git branch -D b`);
  });

  it('admitted: the admission DELETE by id and the listing first, the branch delete last', () => {
    expect(macLine(ROOT, 'b', true, { kind: 'id', id: 31 }, 'o/r')).toBe(
      `cd ${ROOT} && GH_PAGER=cat gh api -X DELETE '${P}/31' && GH_PAGER=cat gh api '${P}' --jq '.branch_policies[].name' && git branch -D b`,
    );
  });

  it('a branch already gone: no delete; nothing at all when no admission is left either', () => {
    expect(macLine(ROOT, 'b', false, { kind: 'id', id: 31 }, 'o/r')).not.toContain('branch -D');
    expect(macLine(ROOT, 'b', false, { kind: 'id', id: 31 }, 'o/r')).toMatch(/^cd .* DELETE /);
    expect(macLine(ROOT, 'b', false, { kind: 'none' }, 'o/r')).toBe('');
  });

  it('unknown: the by-name removal', () => {
    const l = macLine(ROOT, 'b', true, { kind: 'unknown' }, 'o/r');
    expect(l).toContain(
      `--jq '.branch_policies[] | select(.name=="b") | .id' | GH_PAGER=cat xargs -I'{}' gh api -X DELETE '${P}/{}'`,
    );
  });

  it.each(['none', 'id', 'unknown'] as const)('%s: one line, starts with cd, zsh-safe', (kind) => {
    const l = macLine(ROOT, 'some-lane', true, kind === 'id' ? { kind, id: 1 } : { kind }, 'o/r');
    expect(l).not.toMatch(/\n/);
    expect(l.startsWith(`cd ${ROOT} && `)).toBe(true);
    expect(unquoted(l)).not.toMatch(/[?*[\]<!{}]/);
  });

  it('the placeholder root carries no identifier', () => {
    const l = macLine(MAC_PLACEHOLDER, 'b', true, { kind: 'none' }, 'o/r');
    expect(l).toBe(`cd ${MAC_PLACEHOLDER} && git branch -D b`);
    expect(findIdentifiers(l)).toEqual([]);
  });
});

describe('parseAdmission', () => {
  it('finds the id by exact name; none when absent; unknown when unreadable', () => {
    const t =
      '{"branch_policies":[{"id":5,"name":"main"},{"id":9,"name":"b"},{"id":10,"name":"bb"}]}';
    expect(parseAdmission(t, 'b')).toEqual({ kind: 'id', id: 9 });
    expect(parseAdmission(t, 'c')).toEqual({ kind: 'none' });
    expect(parseAdmission(null, 'b')).toEqual({ kind: 'unknown' });
    expect(parseAdmission('not json', 'b')).toEqual({ kind: 'unknown' });
    expect(parseAdmission('{}', 'b')).toEqual({ kind: 'unknown' });
    // past the first page: not seen is unknown, never "not admitted"
    const paged = '{"total_count":131,"branch_policies":[{"id":5,"name":"main"}]}';
    expect(parseAdmission(paged, 'b')).toEqual({ kind: 'unknown' });
    expect(
      parseAdmission('{"total_count":1,"branch_policies":[{"id":5,"name":"main"}]}', 'b'),
    ).toEqual({ kind: 'none' });
  });
});
