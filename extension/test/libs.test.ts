import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
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

  // The states the 2026-11-10 debug log recorded, verbatim but for the clock.
  it('reads every state the debug log recorded, and knows which need a reset before Start', () => {
    const now = 1_794_329_436_000;
    const at = (o: Record<string, unknown>) =>
      JSON.stringify({ lastUsedEndMs: 3600000, alertMinute: 10, isUserPaused: false, ...o });
    const idle = at({
      mode: 'forward',
      startTimestamp: null,
      pauseMs: null,
      endMs: null,
      status: 'idle',
    });
    const running = at({
      mode: 'reverse',
      startTimestamp: now - 2000,
      pauseMs: null,
      endMs: 3600000,
      status: 'running',
    });
    const paused = at({
      mode: 'forward',
      startTimestamp: null,
      pauseMs: 5758,
      endMs: null,
      status: 'pause',
      isUserPaused: true,
    });
    const resumed = at({
      mode: 'forward',
      startTimestamp: now - 5400,
      pauseMs: null,
      endMs: null,
      status: 'running',
    });
    const read = (j: string) => timer.parseTimerState(j, now);
    expect(timer.needsReset(read(idle))).toBe(false);
    expect(timer.needsReset(null)).toBe(false); // a timer never used
    expect(timer.needsReset(read(running))).toBe(true);
    expect(timer.needsReset(read(paused))).toBe(true);
    expect(timer.needsReset(read(at({ status: 'finished' })))).toBe(true); // a state never seen: reset first
    expect(timer.startedFresh(read(running))).toBe(true);
    expect(timer.startedFresh(read(idle))).toBe(false);
    expect(read(paused)).toMatchObject({ running: false, elapsedMs: 5758 });
    // A resume backdates the start by the paused time: elapsed reads on, as A1's reader agrees.
    for (const j of [running, paused, resumed])
      expect(read(j)!.elapsedMs).toBe(lcTimerState(JSON.parse(j), now)!.elapsedMs);
    expect(read(resumed)!.elapsedMs).toBe(5400);
    // Debug log 10a (2026-11-13): a countdown paused in an earlier page load, restored on this one.
    const restored = JSON.stringify({
      mode: 'reverse',
      startTimestamp: null,
      pauseMs: 174953,
      endMs: 2700000,
      lastUsedEndMs: 2700000,
      status: 'pause',
      isUserPaused: true,
      alertMinute: 10,
    });
    expect(timer.needsReset(read(restored))).toBe(true);
    expect(read(restored)).toMatchObject({ running: false, elapsedMs: 174953 });
  });
});

describe('selectors', () => {
  it('ships LeetCode’s controls from the debug log; null turns a step off; a bad paste and the retired timerClicks fall back', () => {
    const doc = new JSDOM('<!doctype html><body></body>').window.document;
    for (const k of selectors.KEYS) {
      const v = selectors.DEFAULTS[k];
      expect(typeof v, k).toBe('string');
      expect(() => doc.querySelector(v), k).not.toThrow(); // valid CSS, every one
    }
    for (const gone of ['timerClicks', 'run']) expect(selectors.KEYS).not.toContain(gone);
    const m = selectors.merge({
      editorReset: '#r',
      timerStart: null,
      timerClicks: ['#a'],
      bogus: 'x',
      dialog: 7,
      lang: null, // not a step: a null is ignored
      submit: null, // the trace card's hold, off
    });
    expect(m).toMatchObject({
      editorReset: '#r',
      timerStart: null,
      dialog: selectors.DEFAULTS.dialog,
      lang: selectors.DEFAULTS.lang,
      submit: null,
    });
    expect(m).not.toHaveProperty('bogus');
    expect(m).not.toHaveProperty('timerClicks');
    expect(selectors.merge('{bad json')).toEqual({ ...selectors.DEFAULTS });
    // Both of LeetCode's timer toolbars: the 2026-11-10 one (debug logs 2–5) and the 2026-11-13/14 one (10a, 11).
    const bar = new JSDOM(
      '<!doctype html><body>' +
        '<div id="old"><div role="button" aria-label="Reset">r</div></div>' +
        '<div id="new"><button type="button" aria-label="Reset">r</button>' +
        '<div role="button" aria-label="Start">00:45:00</div></div>' +
        '<button aria-label="Restart">debugger</button></body>',
    ).window.document;
    const resets = [...bar.querySelectorAll(selectors.DEFAULTS.timerReset)].map((e) => e.tagName);
    expect(resets).toEqual(['DIV', 'BUTTON']); // never the debugger's Restart
    expect(bar.querySelector(selectors.DEFAULTS.timerStart)?.textContent).toBe('00:45:00');
    const popup = new JSDOM(
      '<!doctype html><body><div role="dialog" id="radix-_r_c_" data-state="open">' +
        '<button class="relative font-medium bg-sd-primary">Start Timer</button></div></body>',
    ).window.document;
    expect(popup.querySelector(selectors.DEFAULTS.timerStart)?.textContent).toBe('Start Timer');
    expect(selectors.merge([])).toEqual({ ...selectors.DEFAULTS });
  });
});

// Chrome runs a file listed in both worlds once, in the first (seen 2026-11-08): the isolated world then had
// no tag or wire, and every handshake threw. So the page world loads its own copies.
describe('the manifest', () => {
  it('lists no file in both worlds, and the page world’s copies match lib/', () => {
    expect(MAIN_JS).toEqual(['src/page/tag.js', 'src/inject-main.js']); // the page world parses nothing
    expect(MAIN_JS.filter((f) => ISOLATED_JS.includes(f))).toEqual([]);
    for (const f of MAIN_JS.filter((f) => f.startsWith('src/page/')))
      expect(src(f), `${f} drifted — pnpm -F @aperture/extension sync-page`).toBe(
        src(f.replace('src/page/', 'src/lib/')),
      );
  });

  // Just looking's way back is the in-page pill, not a toolbar click (Safari tucks extension icons away).
  it('has no toolbar action', () => {
    const manifest = JSON.parse(src('manifest.json')) as Record<string, unknown>;
    for (const k of ['action', 'browser_action', 'page_action'])
      expect(manifest).not.toHaveProperty(k);
  });
});
