import { describe, expect, it } from 'vitest';
import { isUlid as sharedIsUlid, lcTimerState } from '@aperture/shared';
import { ISOLATED_JS, MAIN_JS, lib, src } from './load';
import { TIMER_PAUSED } from './fixtures/traffic';

const ulid = lib('ulid');
const timer = lib('timer');
const selectors = lib('selectors');

describe('ulid', () => {
  it('mints ids the server accepts, in order within a millisecond', () => {
    const mint = ulid.createUlid(() => 1_800_000_000_000);
    const ids = Array.from({ length: 50 }, () => mint());
    expect(ids.every((id: string) => sharedIsUlid(id) && ulid.isUlid(id))).toBe(true);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
  });
});

describe('timer', () => {
  it('reads the captured QD_TIMER_STATE the way A1 does', () => {
    const now = 1_800_000_000_000;
    const t = timer.parseTimerState(TIMER_PAUSED, now);
    expect(t).toMatchObject({
      mode: 'reverse',
      status: 'pause',
      running: false,
      elapsedMs: 2453619,
    });
    expect(t.elapsedMs).toBe(lcTimerState(JSON.parse(TIMER_PAUSED), now)!.elapsedMs);
    const running = JSON.stringify({
      mode: 'stopwatch',
      startTimestamp: now - 3000,
      pauseMs: 0,
      status: 'running',
    });
    expect(timer.parseTimerState(running, now)).toMatchObject({
      running: true,
      elapsedMs: 3000,
      mode: 'stopwatch',
    });
    expect(timer.startedFresh(timer.parseTimerState(running, now))).toBe(true);
    expect(timer.startedFresh(timer.parseTimerState(TIMER_PAUSED, now))).toBe(false);
    expect(timer.parseTimerState('nope', now)).toBeNull();
  });
});

describe('selectors', () => {
  it('ships the unknown controls unconfigured, and takes overrides without breaking on a bad paste', () => {
    expect(selectors.DEFAULTS.editorReset).toBeNull();
    expect(selectors.DEFAULTS.timerClicks).toEqual([]);
    const m = selectors.merge({
      editorReset: '#r',
      timerClicks: ['#a', '#b'],
      bogus: 'x',
      dialog: 7,
    });
    expect(m).toMatchObject({
      editorReset: '#r',
      timerClicks: ['#a', '#b'],
      dialog: selectors.DEFAULTS.dialog,
    });
    expect(m).not.toHaveProperty('bogus');
    expect(selectors.merge('{bad json')).toEqual({ ...selectors.DEFAULTS });
  });
});

// Chrome runs a file listed in both worlds once, in the first (seen 2026-11-08): the isolated world then had
// no tag or wire, and every handshake threw. So the page world loads its own copies.
describe('the manifest', () => {
  it('lists no file in both worlds, and the page world’s copies match lib/', () => {
    expect(MAIN_JS.filter((f) => ISOLATED_JS.includes(f))).toEqual([]);
    for (const f of MAIN_JS.filter((f) => f.startsWith('src/page/')))
      expect(src(f), `${f} drifted — pnpm -F @aperture/extension sync-page`).toBe(
        src(f.replace('src/page/', 'src/lib/')),
      );
  });
});
