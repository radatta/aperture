import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { setFluxEngineFactory } from './engine/engine';
import { createFakeEngine, type FakeControls } from './engine/fakeEngine';
import { useFluxEngine, type FluxEngineOptions } from './useFluxEngine';
import type { VoiceControl } from './useVoice';

function voice(): VoiceControl {
  return {
    on: true,
    name: null,
    voices: [],
    prime: vi.fn(),
    speak: vi.fn(),
    cancel: vi.fn(),
    toggle: vi.fn(),
    change: vi.fn(),
  };
}

function setup(over: Partial<FluxEngineOptions> = {}) {
  let fake: FakeControls | undefined;
  setFluxEngineFactory(() => {
    const f = createFakeEngine();
    fake = f.fake;
    return f.engine;
  });
  const v = voice();
  const onSetCompleted = vi.fn();
  const onNextSet = vi.fn();
  const onSessionEnd = vi.fn();
  const hook = renderHook((p: FluxEngineOptions) => useFluxEngine(p), {
    initialProps: {
      exerciseId: 'chin-tuck',
      kind: 'holdAtTarget',
      side: null,
      condition: null,
      acknowledged: true,
      voice: v,
      onSetCompleted,
      onNextSet,
      onSessionEnd,
      ...over,
    },
  });
  return { hook, v, onSetCompleted, onNextSet, onSessionEnd, fake: () => fake as FakeControls };
}

// Every phrase spoken so far, in order.
const spoken = (v: VoiceControl) =>
  (v.speak as ReturnType<typeof vi.fn>).mock.calls.map(([u]) => (u as { text: string }).text);

const els = { video: document.createElement('video'), canvas: document.createElement('canvas') };

// A controllable performance.now() for the session clock and set durations.
function clockAt(ms: number) {
  const now = vi.spyOn(performance, 'now').mockReturnValue(ms);
  return (next: number) => now.mockReturnValue(next);
}

describe('useFluxEngine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('primes speech inside Start (the gesture) and walks idle → loading → running → idle', async () => {
    const { hook, v, fake } = setup();
    expect(hook.result.current.status).toBe('idle');
    await act(() => hook.result.current.start(els));
    expect(v.prime).toHaveBeenCalledTimes(1);
    expect(hook.result.current.status).toBe('loading');
    act(() => fake().ready('CPU'));
    expect(hook.result.current.status).toBe('running');
    expect(hook.result.current.delegate).toBe('CPU');
    let summary;
    act(() => {
      summary = hook.result.current.stop();
    });
    expect(summary).toMatchObject({ sets: 0 });
    expect(hook.result.current.status).toBe('idle');
    expect(v.cancel).toHaveBeenCalled();
  });

  it('counts only active time: from ready, excluding paused stretches, frozen by Stop', async () => {
    const at = clockAt(0);
    const { hook, fake } = setup();
    await act(() => hook.result.current.start(els));
    at(5_000); // model download — not session time
    act(() => fake().ready('GPU'));
    at(65_000);
    act(() => fake().pause());
    expect(hook.result.current.status).toBe('paused');
    at(665_000); // ten minutes backgrounded
    expect(hook.result.current.activeMs()).toBe(60_000);
    await act(() => hook.result.current.resume());
    expect(hook.result.current.status).toBe('running');
    at(725_000);
    let summary;
    act(() => {
      summary = hook.result.current.stop();
    });
    expect(summary).toEqual({ activeMs: 120_000, sets: 0 });
  });

  it('a worker that becomes ready while paused stays paused; Resume then runs', async () => {
    const { hook, fake } = setup();
    await act(() => hook.result.current.start(els));
    act(() => fake().pause());
    act(() => fake().ready('GPU'));
    expect(hook.result.current.status).toBe('paused');
    await act(() => hook.result.current.resume());
    expect(hook.result.current.status).toBe('running');
  });

  it('Resume before the model is ready goes back to loading, then runs on ready', async () => {
    const { hook, fake } = setup();
    await act(() => hook.result.current.start(els));
    act(() => fake().pause());
    await act(() => hook.result.current.resume());
    expect(hook.result.current.status).toBe('loading');
    act(() => fake().ready('GPU'));
    expect(hook.result.current.status).toBe('running');
  });

  it('a new Start begins a new session: no sets or time carried over', async () => {
    const at = clockAt(0);
    const { hook, onSetCompleted, fake } = setup();
    await act(() => hook.result.current.start(els));
    act(() => fake().ready('GPU'));
    act(() => fake().event({ type: 'setCompleted', summary: { count: 10 } }));
    at(30_000);
    act(() => void hook.result.current.stop());
    expect(hook.result.current.sessionSets).toHaveLength(1); // kept for the summary until a new Start
    await act(() => hook.result.current.start(els));
    expect(hook.result.current.sessionSets).toHaveLength(0);
    act(() => fake().ready('GPU'));
    act(() => fake().event({ type: 'setCompleted', summary: { count: 8 } }));
    expect(onSetCompleted).toHaveBeenLastCalledWith(expect.anything(), 0);
    at(40_000);
    let summary;
    act(() => {
      summary = hook.result.current.stop();
    });
    expect(summary).toEqual({ activeMs: 10_000, sets: 1 });
  });

  it('records the condition chip and the set duration on each set', async () => {
    const at = clockAt(1_000);
    const { hook, onSetCompleted, fake } = setup({ condition: 'herniatedDisc' });
    await act(() => hook.result.current.start(els));
    act(() => fake().ready('GPU'));
    at(46_000);
    act(() => fake().event({ type: 'setCompleted', summary: { count: 10 } }));
    expect(onSetCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ condition: 'herniatedDisc', durationSec: 45 }),
      0,
    );
  });

  it('flags a CPU start caused by a crashed GPU boot, but not a chosen or fallback CPU', async () => {
    localStorage.setItem('aperture.flux.gpuBoot', '1');
    const { hook, fake } = setup();
    await act(() => hook.result.current.start(els));
    act(() => fake().ready('CPU'));
    expect(hook.result.current.cpuAfterCrash).toBe(true);
    act(() => fake().ready('CPU', true));
    expect(hook.result.current.cpuAfterCrash).toBe(false);
    localStorage.setItem('aperture.flux.delegate', 'CPU');
    act(() => fake().ready('CPU'));
    expect(hook.result.current.cpuAfterCrash).toBe(false);
  });

  it('throttles samples for display to one per 60 ms', () => {
    const now = vi.spyOn(performance, 'now');
    const { hook, fake } = setup();
    now.mockReturnValue(1000);
    act(() => fake().sample({ fps: 10 }));
    now.mockReturnValue(1030);
    act(() => fake().sample({ fps: 20 }));
    expect(hook.result.current.sample.fps).toBe(10);
    now.mockReturnValue(1070);
    act(() => fake().sample({ fps: 30 }));
    expect(hook.result.current.sample.fps).toBe(30);
  });

  it('speaks a count at hold-reached without mirroring it; mirrors a short and a broken hold', async () => {
    const at = clockAt(1_000);
    const { hook, v, fake } = setup();
    await act(() => hook.result.current.start(els));
    act(() => fake().ready('GPU'));
    act(() => fake().event({ type: 'holdReached', count: 3 }));
    expect(v.speak).toHaveBeenCalledWith({ text: 'Three', priority: 'always' });
    expect(hook.result.current.lastCue).toBeNull(); // the overlay shows the number
    at(1_100);
    act(() => fake().event({ type: 'holdShort', heldSec: 2 }));
    expect(v.speak).toHaveBeenCalledWith({ text: 'Hold longer', priority: 'always' });
    expect(hook.result.current.lastCue).toBe('Hold longer');
    at(5_000); // past the 600 ms gap that gates "Back into position"
    act(() => fake().event({ type: 'holdBroken', heldSec: 2 }));
    expect(hook.result.current.lastCue).toBe('Back into position');
  });

  it('speaks cues through the reducer and records each finished set', async () => {
    const { hook, v, onSetCompleted, fake } = setup();
    await act(() => hook.result.current.start(els));
    act(() => fake().ready('GPU'));
    act(() => fake().calibrated(true));
    act(() => fake().event({ type: 'setCompleted', summary: { count: 10 } }));
    expect(v.speak).toHaveBeenCalledWith({ text: 'Set complete. Well done.', priority: 'always' });
    expect(hook.result.current.lastCue).toBe('Set complete. Well done.');
    expect(onSetCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        exerciseId: 'chin-tuck',
        count: 10,
        calibrated: true,
        delegate: 'GPU',
      }),
      0,
    );
    expect(hook.result.current.sessionSets).toHaveLength(1);
  });

  it('runs with no exercise until the contraindication is acknowledged', () => {
    const { hook, fake } = setup({ acknowledged: false });
    expect(fake().lastSelect).toEqual({ id: null, side: 'a' });
    hook.rerender({
      exerciseId: 'chin-tuck',
      kind: 'holdAtTarget',
      side: null,
      condition: null,
      acknowledged: true,
      voice: voice(),
    });
    expect(fake().lastSelect).toEqual({ id: 'chin-tuck', side: 'a' });
  });

  it('stops the engine on an error, and on unmount', async () => {
    const { hook, fake } = setup();
    await act(() => hook.result.current.start(els));
    act(() => fake().fail('init', 'no webgl'));
    expect(hook.result.current.status).toBe('error');
    expect(hook.result.current.error).toEqual({ stage: 'init', message: 'no webgl' });
    expect(fake().calls).toContain('stop');
    const before = fake().calls.length;
    hook.unmount();
    expect(fake().calls.length).toBe(before + 1);
  });
});

describe('useFluxEngine — the session runs itself (D40–D43)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  // Fake timers for the lead-in and rest; a controlled performance.now() for the cue gates.
  async function running(over: Partial<FluxEngineOptions> = {}) {
    vi.useFakeTimers();
    const at = clockAt(1_000);
    const t = setup(over);
    await act(() => t.hook.result.current.start(els));
    act(() => t.fake().ready('GPU'));
    // Advance both clocks together, in ms.
    let now = 1_000;
    const advance = (ms: number) =>
      act(() => {
        now += ms;
        at(now);
        vi.advanceTimersByTime(ms);
      });
    return { ...t, advance };
  }
  const starts = (calls: readonly string[]) => calls.filter((c) => c === 'control:start').length;
  const DONE = { type: 'setCompleted', summary: { count: 10 } } as const;

  it('an automatic neutral is said out loud; a self-paced kind needs nothing else', async () => {
    const { v, fake, advance } = await running();
    act(() => fake().calibrated(true, true));
    expect(spoken(v)).toEqual(['Neutral set']);
    expect(v.speak).toHaveBeenCalledWith({ text: 'Neutral set', priority: 'always' });
    advance(5_000);
    expect(starts(fake().calls)).toBe(0);
  });

  it('a timed kind says Get ready and starts itself 3 s after the neutral', async () => {
    const { v, fake, advance } = await running({
      exerciseId: 'deep-neck-flexor',
      kind: 'guidedHold',
    });
    act(() => fake().calibrated(true, true));
    expect(spoken(v)).toEqual(['Neutral set', 'Get ready']);
    advance(2_900);
    expect(starts(fake().calls)).toBe(0);
    advance(100);
    expect(starts(fake().calls)).toBe(1);
  });

  it('a tap overrides the pending start; Start now before a neutral starts once one is set', async () => {
    const { hook, v, fake, advance } = await running({
      exerciseId: 'deep-neck-flexor',
      kind: 'guidedHold',
    });
    act(() => hook.result.current.control({ type: 'start' }));
    expect(fake().calls.at(-1)).toBe('calibrate'); // no neutral yet: ask for one
    expect(starts(fake().calls)).toBe(0);
    act(() => fake().calibrated(true));
    expect(starts(fake().calls)).toBe(1); // at once, no lead-in
    expect(spoken(v)).toEqual(['Neutral set']);
    // A manual Calibrate later leads in again; a tap during the lead-in cancels it.
    act(() => fake().calibrated(true));
    act(() => hook.result.current.control({ type: 'start' }));
    advance(5_000);
    expect(starts(fake().calls)).toBe(2);
  });

  it("says Can't see you after a second without a face, and Tracking once it's back", async () => {
    const { v, fake, advance } = await running();
    act(() => fake().sample({ faceVisible: false, tSec: 0 }));
    act(() => fake().sample({ faceVisible: false, tSec: 2 }));
    expect(spoken(v)).toEqual([]); // never seen a face yet: nothing to lose
    act(() => fake().calibrated(true));
    act(() => fake().sample({ faceVisible: true, tSec: 3 }));
    act(() => fake().sample({ faceVisible: false, tSec: 3.5 }));
    act(() => fake().sample({ faceVisible: false, tSec: 4.4 }));
    expect(spoken(v)).toEqual(['Neutral set']);
    act(() => fake().sample({ faceVisible: false, tSec: 4.5 }));
    act(() => fake().sample({ faceVisible: false, tSec: 6 })); // said once per loss
    expect(spoken(v)).toEqual(['Neutral set', "Can't see you"]);
    advance(1_000);
    act(() => fake().sample({ faceVisible: true, tSec: 6.5 }));
    act(() => fake().sample({ faceVisible: true, tSec: 7 }));
    expect(spoken(v).at(-1)).toBe('Tracking');
    expect(spoken(v).filter((t) => t === 'Tracking')).toHaveLength(1);
  });

  it('hints Hold still to set neutral after 20 s of a face with no neutral', async () => {
    const { v, fake } = await running();
    act(() => fake().sample({ faceVisible: true, tSec: 0 }));
    act(() => fake().sample({ faceVisible: true, tSec: 19.9 }));
    expect(spoken(v)).toEqual([]);
    act(() => fake().sample({ faceVisible: true, tSec: 20 }));
    expect(spoken(v)).toEqual(['Hold still to set neutral']);
    expect(v.speak).toHaveBeenCalledWith({ text: 'Hold still to set neutral', priority: 'normal' });
  });

  it('rests 30 s between sets, then says the next set and starts it', async () => {
    const { v, fake, onNextSet, advance } = await running();
    act(() => fake().event(DONE));
    expect(spoken(v)).toEqual(['Set complete. Well done.']);
    advance(29_900);
    expect(starts(fake().calls)).toBe(0);
    advance(100);
    expect(onNextSet).toHaveBeenCalledWith(1);
    expect(spoken(v).at(-1)).toBe('Set two');
    expect(starts(fake().calls)).toBe(1); // self-paced: straight away
  });

  it('a timed kind gets its lead-in after the rest', async () => {
    const { v, fake, advance } = await running({
      exerciseId: 'joint-position-sense',
      kind: 'reposition',
    });
    act(() => fake().event(DONE));
    advance(30_000);
    expect(spoken(v).at(-1)).toBe('Set two');
    expect(starts(fake().calls)).toBe(0);
    advance(3_000);
    expect(starts(fake().calls)).toBe(1);
  });

  it('a sided stretch says Other side', async () => {
    const { v, fake, onNextSet, advance } = await running({
      exerciseId: 'upper-trap-stretch',
      side: 'a',
    });
    act(() => fake().event(DONE));
    advance(30_000);
    expect(onNextSet).toHaveBeenCalledWith(1);
    expect(spoken(v).at(-1)).toBe('Other side');
  });

  it('ends itself after the last set: Session complete, camera off, voice not cut', async () => {
    const { hook, v, fake, onSessionEnd, advance } = await running();
    act(() => fake().event(DONE));
    advance(30_000);
    act(() => fake().event(DONE));
    expect(spoken(v).at(-1)).toBe('Session complete.');
    // The last set says "Session complete." in place of "Set complete".
    expect(spoken(v).filter((t) => t === 'Set complete. Well done.')).toHaveLength(1);
    expect(fake().calls.at(-1)).toBe('stop');
    expect(v.cancel).not.toHaveBeenCalled();
    expect(onSessionEnd).toHaveBeenCalledWith(expect.objectContaining({ sets: 2 }));
    expect(hook.result.current.status).toBe('idle');
  });

  it('honours the sets chosen before Start', async () => {
    const { v, fake, onSessionEnd } = await running({ sets: 1 });
    act(() => fake().event(DONE));
    expect(spoken(v)).toEqual(['Session complete.']);
    expect(onSessionEnd).toHaveBeenCalledWith(expect.objectContaining({ sets: 1 }));
  });

  it('a pause holds the rest; Resume re-arms it', async () => {
    const { hook, fake, advance } = await running();
    act(() => fake().event(DONE));
    advance(10_000);
    act(() => fake().pause());
    advance(60_000);
    expect(starts(fake().calls)).toBe(0);
    await act(() => hook.result.current.resume());
    advance(29_900);
    expect(starts(fake().calls)).toBe(0);
    advance(100);
    expect(starts(fake().calls)).toBe(1);
  });

  it('a manual Stop cancels the pending rest', async () => {
    const { hook, v, fake, onSessionEnd, advance } = await running();
    act(() => fake().event(DONE));
    act(() => void hook.result.current.stop());
    advance(60_000);
    expect(starts(fake().calls)).toBe(0);
    expect(v.cancel).toHaveBeenCalled();
    expect(onSessionEnd).not.toHaveBeenCalled();
  });
});
