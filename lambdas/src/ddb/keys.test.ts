import { describe, expect, it } from 'vitest';
import { gsi1, pk, sk } from './keys';

describe('single-table keys', () => {
  it('partitions per user', () => {
    expect(pk('user-1')).toBe('u#user-1');
  });

  it('builds type-prefixed range keys that a prefix query can slice', () => {
    expect(sk.task('abc')).toBe('task#abc');
    expect(sk.task('abc').startsWith(sk.taskPrefix())).toBe(true);
    expect(sk.log('2026-08-04', 'x').startsWith(sk.logPrefix('2026-08-04'))).toBe(true);
    expect(sk.session('2026-08-04', 'x').startsWith(sk.sessionDayPrefix('2026-08-04'))).toBe(true);
    expect(sk.session('2026-08-04', 'x').startsWith(sk.sessionPrefix())).toBe(true);
    expect(sk.lc('2026-08-04', 'x').startsWith(sk.lcPrefix('2026-08-04'))).toBe(true);
    expect(sk.lc('2026-08-04', 'x').startsWith(sk.lcAllPrefix())).toBe(true);
  });

  it('pads plan order so lexical SK order matches numeric order', () => {
    const two = sk.plan('2026-08-04', 2, 'a');
    const ten = sk.plan('2026-08-04', 10, 'b');
    expect(two < ten).toBe(true); // 000002 < 000010, not "10" < "2"
    expect(two.startsWith(sk.planPrefix('2026-08-04'))).toBe(true);
  });

  it('scopes a day-check per habit and a day singleton by direct key', () => {
    expect(sk.hcheck('2026-08-04', 'h1')).toBe('hcheck#2026-08-04#h1');
    expect(sk.hcheck('2026-08-04', 'h1').startsWith(sk.hcheckPrefix('2026-08-04'))).toBe(true);
    expect(sk.day('2026-08-04')).toBe('day#2026-08-04');
    expect(sk.settings()).toBe('settings');
  });

  it('keys the calibration GSI on done + raw completion time', () => {
    expect(gsi1.donePk('user-1')).toBe('u#user-1#done');
    expect(gsi1.doneSk(1700)).toBe(1700);
  });
});
