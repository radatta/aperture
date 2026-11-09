import { describe, expect, it } from 'vitest';
import {
  computeDayShape,
  mergeBusyIntervals,
  FRAGMENT_GAP_MIN,
  type BusyInterval,
} from './calendar';

// A fixed reference midnight (UTC) so tests read in clean minute offsets. The pure fn never touches
// timezones — bounds are ms in, ms out — so the choice of base is arbitrary.
const BASE = 1_700_000_000_000;
const at = (min: number) => BASE + min * 60_000;
const iv = (startMin: number, endMin: number): BusyInterval => ({
  startMs: at(startMin),
  endMs: at(endMin),
});

// Window: minute 480 (08:00) → 1320 (22:00) = 840 min, the default focus window.
const WIN_START = at(480);
const WIN_END = at(1320);
const shape = (intervals: BusyInterval[], allDayCount = 0, start = WIN_START, end = WIN_END) =>
  computeDayShape({ intervals, allDayCount }, start, end);

describe('computeDayShape', () => {
  it('empty window → all zero', () => {
    const s = shape([], 0, WIN_START, WIN_START);
    expect(s).toEqual({
      windowMin: 0,
      committedMin: 0,
      freeMin: 0,
      longestFreeStretchMin: 0,
      fragmentCount: 0,
      allDayCount: 0,
    });
  });

  it('no events → whole window is one free stretch', () => {
    const s = shape([]);
    expect(s.windowMin).toBe(840);
    expect(s.committedMin).toBe(0);
    expect(s.freeMin).toBe(840);
    expect(s.longestFreeStretchMin).toBe(840);
    expect(s.fragmentCount).toBe(0);
  });

  it('one midday event splits the window; longest stretch is the bigger side', () => {
    const s = shape([iv(720, 780)]); // 12:00–13:00
    expect(s.committedMin).toBe(60);
    expect(s.freeMin).toBe(780);
    // gaps: 08:00–12:00 = 240, 13:00–22:00 = 540 → longest 540
    expect(s.longestFreeStretchMin).toBe(540);
    expect(s.fragmentCount).toBe(0);
  });

  it('back-to-back events produce no zero-length gap fragment', () => {
    const s = shape([iv(540, 600), iv(600, 660)]); // 09–10, 10–11 (touching)
    expect(s.committedMin).toBe(120); // merged, not double-counted
    expect(s.fragmentCount).toBe(0); // the 0-min seam between them is not a gap
  });

  it('daytime mode: an event straddling `now` counts only the part still ahead', () => {
    // now = 12:30 (min 750); event 12:00–13:00 → only 12:30–13:00 = 30 min is still committed
    const now = at(750);
    const s = shape([iv(720, 780)], 0, now, WIN_END);
    expect(s.committedMin).toBe(30);
    expect(s.windowMin).toBe(570); // 12:30 → 22:00
    expect(s.longestFreeStretchMin).toBe(540); // 13:00 → 22:00
  });

  it('the same lecture on two accounts is merged, not double-counted', () => {
    const s = shape([iv(600, 660), iv(600, 660)]); // identical block from two accounts
    expect(s.committedMin).toBe(60);
  });

  it('overlapping (not identical) intervals merge into one committed block', () => {
    const s = shape([iv(600, 690), iv(660, 720)]); // 10:00–11:30 and 11:00–12:00 overlap
    expect(s.committedMin).toBe(120); // 10:00–12:00
  });

  it('counts free gaps shorter than the fragment threshold', () => {
    // 09:00–09:30, 10:00–10:20, 11:00–13:00 → free gaps between them are 30 and 40 min (both < 45)
    const s = shape([iv(540, 570), iv(600, 620), iv(660, 780)]);
    // gaps: 08:00–09:00 = 60 (not a fragment), 09:30–10:00 = 30 (fragment),
    //       10:20–11:00 = 40 (fragment), 13:00–22:00 = 540 (longest)
    expect(s.fragmentCount).toBe(2);
    expect(s.longestFreeStretchMin).toBe(540);
    expect(FRAGMENT_GAP_MIN).toBe(45);
  });

  it('intervals outside the window are clipped away', () => {
    const s = shape([iv(0, 480), iv(1320, 1440)]); // entirely before 08:00 and after 22:00
    expect(s.committedMin).toBe(0);
    expect(s.freeMin).toBe(840);
  });

  it('passes allDayCount through untouched', () => {
    expect(shape([], 3).allDayCount).toBe(3);
  });
});

describe('mergeBusyIntervals', () => {
  it('sorts, drops empties, and merges touching + overlapping runs', () => {
    const merged = mergeBusyIntervals([iv(600, 660), iv(540, 600), iv(700, 700), iv(650, 680)]);
    expect(merged).toEqual([{ startMs: at(540), endMs: at(680) }]);
  });
});
