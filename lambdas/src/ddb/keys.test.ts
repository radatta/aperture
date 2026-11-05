import { describe, expect, it } from 'vitest';
import { SK_END } from './DocClient';
import { gsi1, pk, placeTokenPk, PLACE_TOKEN_SK, sk } from './keys';

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
    expect(sk.flux('2026-10-20', 'x')).toBe('flux#2026-10-20#x');
    expect(sk.flux('2026-10-20', 'x').startsWith(sk.fluxAllPrefix())).toBe(true);
    expect(sk.story('abc')).toBe('story#abc');
    expect(sk.story('abc').startsWith(sk.storyPrefix())).toBe(true);
    expect(sk.roll('abc')).toBe('roll#abc');
    expect(sk.roll('abc').startsWith(sk.rollPrefix())).toBe(true);
    expect(sk.attach('t1', 'a1')).toBe('attach#t1#a1');
    expect(sk.attach('t1', 'a1').startsWith(sk.attachTaskPrefix('t1'))).toBe(true);
    expect(sk.attach('t1', 'a1').startsWith(sk.attachAllPrefix())).toBe(true);
    // Task-scoped prefix isolates one task's files from another's under the shared attach# space.
    expect(sk.attach('t2', 'a1').startsWith(sk.attachTaskPrefix('t1'))).toBe(false);
  });

  it('pads plan order so lexical SK order matches numeric order', () => {
    const two = sk.plan('2026-08-04', 2, 'a');
    const ten = sk.plan('2026-08-04', 10, 'b');
    expect(two < ten).toBe(true); // 000002 < 000010, not "10" < "2"
    expect(two.startsWith(sk.planPrefix('2026-08-04'))).toBe(true);
    // A day's prefix sorts at the start of its rows and before any later day's; the range end sorts
    // after every plan key — the stale sweep's `SK BETWEEN plan#<today># AND plan#\uffff`.
    expect(sk.planPrefix('2026-08-04') <= two && two < sk.planPrefix('2026-08-05')).toBe(true);
    expect(sk.plan('2026-08-03', 999_999, 'z') < sk.planPrefix('2026-08-04')).toBe(true);
    expect(ten < sk.planAllPrefix() + SK_END).toBe(true);
  });

  it('scopes a day-check per habit and a day singleton by direct key', () => {
    expect(sk.hcheck('2026-08-04', 'h1')).toBe('hcheck#2026-08-04#h1');
    expect(sk.hcheck('2026-08-04', 'h1').startsWith(sk.hcheckPrefix('2026-08-04'))).toBe(true);
    expect(sk.day('2026-08-04')).toBe('day#2026-08-04');
    expect(sk.settings()).toBe('settings');
  });

  it('keys places per user and the token lookup outside every user partition', () => {
    expect(sk.place('p1')).toBe('place#p1');
    expect(sk.place('p1').startsWith(sk.placePrefix())).toBe(true);
    expect(sk.ptoken()).toBe('ptoken');
    // `place#` and `plan#` share three letters — neither prefix may pull the other's rows.
    expect(sk.place('p1').startsWith(sk.planAllPrefix())).toBe(false);
    expect(sk.plan('2026-08-04', 0, 'x').startsWith(sk.placePrefix())).toBe(false);
    expect(placeTokenPk('ab12')).toBe('placetoken#ab12');
    expect(placeTokenPk('ab12').startsWith(pk(''))).toBe(false);
    expect(PLACE_TOKEN_SK).toBe('placetoken');
  });

  it('keys the calibration GSI on done + raw completion time', () => {
    expect(gsi1.donePk('user-1')).toBe('u#user-1#done');
    expect(gsi1.doneSk(1700)).toBe(1700);
  });
});
