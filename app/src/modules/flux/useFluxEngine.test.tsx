import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { setFluxEngineFactory } from './engine/engine';
import { createFakeEngine, type FakeControls } from './engine/fakeEngine';
import { initialState } from './engine/evaluate';
import { getExercise, type ExerciseState } from '@aperture/shared/flux';
import { useFluxEngine, type FluxEngineOptions } from './useFluxEngine';
import type { VoiceControl } from './useVoice';

function voice(): VoiceControl {
  return {
    on: true,
    id: null,
    voices: [],
    missing: false,
    prime: vi.fn(),
    speak: vi.fn(),
    cancel: vi.fn(),
    toggle: vi.fn(),
    change: vi.fn(),
    preview: vi.fn(),
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
  const props: FluxEngineOptions = {
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
  };
  const hook = renderHook((p: FluxEngineOptions) => useFluxEngine(p), { initialProps: props });
  return {
    hook,
    props,
    v,
    onSetCompleted,
    onNextSet,
    onSessionEnd,
    fake: () => fake as FakeControls,
  };
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
    expect(spoken(v)).toEqual([]); // never seen a face: it waits 3 s, not 1 (D43)
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

  it("mid-turn, a lost face is the end of the turn: Can't see you only after 10 s (D57)", async () => {
    const rotation = initialState(getExercise('cervical-rotation'));
    const turned = async (zone: 'positive' | 'neutral') => {
      const t = await running({ exerciseId: 'cervical-rotation', kind: 'romReps' });
      act(() => t.fake().calibrated(true));
      act(() => t.fake().sample({ faceVisible: true, tSec: 0 }));
      act(() => t.fake().state({ ...rotation, zone } as ExerciseState));
      return t;
    };
    const out = await turned('positive');
    for (const tSec of [0.1, 2, 9.9]) act(() => out.fake().sample({ faceVisible: false, tSec }));
    expect(spoken(out.v)).toEqual(['Neutral set']);
    act(() => out.fake().sample({ faceVisible: false, tSec: 10.2 }));
    expect(spoken(out.v)).toEqual(['Neutral set', "Can't see you"]);
    out.hook.unmount();

    const centred = await turned('neutral');
    act(() => centred.fake().sample({ faceVisible: false, tSec: 0.1 }));
    act(() => centred.fake().sample({ faceVisible: false, tSec: 1.2 }));
    expect(spoken(centred.v)).toEqual(['Neutral set', "Can't see you"]);
  });

  it('hints Face the camera and hold still after 20 s of a face with no neutral', async () => {
    const { v, fake } = await running();
    act(() => fake().sample({ faceVisible: true, tSec: 0 }));
    act(() => fake().sample({ faceVisible: true, tSec: 19.9 }));
    expect(spoken(v)).toEqual([]);
    act(() => fake().sample({ faceVisible: true, tSec: 20 }));
    expect(spoken(v)).toEqual(['Face the camera and hold still']);
    expect(v.speak).toHaveBeenCalledWith({
      text: 'Face the camera and hold still',
      priority: 'normal',
    });
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

  it('set two’s duration is from its own start: the rest before it isn’t counted', async () => {
    const { fake, onSetCompleted, advance } = await running();
    advance(20_000);
    act(() => fake().event(DONE));
    expect(onSetCompleted).toHaveBeenLastCalledWith(
      expect.objectContaining({ durationSec: 20 }),
      0,
    );
    advance(30_000); // the rest, then set two starts
    advance(15_000);
    act(() => fake().event(DONE));
    expect(onSetCompleted).toHaveBeenLastCalledWith(
      expect.objectContaining({ durationSec: 15 }),
      1,
    );
  });

  it('nor its lead-in, for a timed kind', async () => {
    const { fake, onSetCompleted, advance } = await running({
      exerciseId: 'joint-position-sense',
      kind: 'reposition',
    });
    act(() => fake().event(DONE));
    advance(33_000); // the rest and the lead-in
    advance(12_000);
    act(() => fake().event(DONE));
    expect(onSetCompleted).toHaveBeenLastCalledWith(
      expect.objectContaining({ durationSec: 12 }),
      1,
    );
  });

  it('set one leaves out the wait before it: a Start tap, or Start now once the neutral is set', async () => {
    const timed = { exerciseId: 'joint-position-sense', kind: 'reposition' } as const;
    const tap = await running(timed);
    act(() => tap.fake().calibrated(true, true));
    tap.advance(3_000); // the lead-in starts the set…
    tap.advance(7_000); // …and Start is tapped later (a restart once the set is done, say)
    act(() => tap.hook.result.current.control({ type: 'start' }));
    tap.advance(12_000);
    act(() => tap.fake().event(DONE));
    expect(tap.onSetCompleted).toHaveBeenLastCalledWith(
      expect.objectContaining({ durationSec: 12 }),
      0,
    );
    tap.hook.unmount();

    const now = await running(timed);
    act(() => now.hook.result.current.control({ type: 'start' })); // no neutral yet
    now.advance(10_000);
    act(() => now.fake().calibrated(true, true));
    now.advance(12_000);
    act(() => now.fake().event(DONE));
    expect(now.onSetCompleted).toHaveBeenLastCalledWith(
      expect.objectContaining({ durationSec: 12 }),
      0,
    );
  });

  it('a self-paced set one counts from the first neutral, not from getting into position', async () => {
    const { fake, onSetCompleted, advance } = await running();
    advance(60_000);
    act(() => fake().calibrated(true, true));
    advance(20_000);
    act(() => fake().event(DONE));
    expect(onSetCompleted).toHaveBeenLastCalledWith(
      expect.objectContaining({ durationSec: 20 }),
      0,
    );
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

  it('a second loss inside the 5 s cooldown is said once the cooldown allows, not dropped', async () => {
    const { v, fake, advance } = await running();
    act(() => fake().sample({ faceVisible: true, tSec: 0 }));
    act(() => fake().sample({ faceVisible: false, tSec: 0.1 }));
    act(() => fake().sample({ faceVisible: false, tSec: 1.2 })); // "Can't see you" at clock 1 s
    act(() => fake().sample({ faceVisible: true, tSec: 1.3 }));
    advance(700);
    act(() => fake().sample({ faceVisible: true, tSec: 2 })); // "Tracking"
    act(() => fake().sample({ faceVisible: false, tSec: 2.1 }));
    advance(1_500);
    act(() => fake().sample({ faceVisible: false, tSec: 3.3 })); // lost again — inside the cooldown
    expect(spoken(v).filter((t) => t === "Can't see you")).toHaveLength(1);
    advance(3_000);
    act(() => fake().sample({ faceVisible: false, tSec: 6.3 }));
    expect(spoken(v)).toEqual(["Can't see you", 'Tracking', "Can't see you"]);
  });

  it('Again during the rest is the next set now: its cue, its side flip, a clean start', async () => {
    const { hook, v, fake, onNextSet, advance } = await running({
      exerciseId: 'upper-trap-stretch',
      side: 'a',
    });
    act(() => fake().event(DONE));
    advance(5_000);
    act(() => hook.result.current.control({ type: 'start' }));
    expect(onNextSet).toHaveBeenCalledWith(1);
    expect(spoken(v).at(-1)).toBe('Other side');
    expect(fake().calls.slice(-2)).toEqual(['control:stop', 'control:start']);
    advance(30_000); // the rest is spent: nothing fires again
    expect(onNextSet).toHaveBeenCalledTimes(1);
  });

  it('a Re-calibrate during the rest keeps the rest and its next-set cue', async () => {
    const { v, fake, onNextSet, advance } = await running({
      exerciseId: 'deep-neck-flexor',
      kind: 'guidedHold',
    });
    act(() => fake().calibrated(true, true));
    advance(3_000);
    act(() => fake().event(DONE));
    advance(10_000);
    act(() => fake().calibrated(true));
    advance(5_000);
    expect(starts(fake().calls)).toBe(1); // no 3 s lead-in cut the rest short
    advance(15_000);
    expect(onNextSet).toHaveBeenCalledWith(1);
    expect(spoken(v).at(-1)).toBe('Set two');
    advance(3_000);
    expect(starts(fake().calls)).toBe(2);
  });

  it('a timed exercise acknowledged after the neutral still starts itself', async () => {
    const { hook, v, fake, advance } = await running({
      exerciseId: 'deep-neck-flexor',
      kind: 'guidedHold',
      acknowledged: false,
    });
    act(() => fake().calibrated(true, true));
    expect(spoken(v)).toEqual(['Neutral set']);
    hook.rerender({
      exerciseId: 'deep-neck-flexor',
      kind: 'guidedHold',
      side: null,
      condition: null,
      acknowledged: true,
      voice: v,
    });
    expect(spoken(v).at(-1)).toBe('Get ready');
    advance(3_000);
    expect(starts(fake().calls)).toBe(1);
  });

  it('says when the camera pauses, tracking stops, or a fallback restarts a self-paced set', async () => {
    const { v, fake } = await running();
    act(() => fake().calibrated(true));
    act(() => fake().ready('CPU', true));
    expect(spoken(v).at(-1)).toBe('Set restarted');
    act(() => fake().pause());
    expect(spoken(v).at(-1)).toBe('Camera paused');
    act(() => fake().fail('detect', 'boom'));
    expect(spoken(v).at(-1)).toBe('Tracking stopped');
  });

  it('the idle stage knows a session ended itself, until the next Start', async () => {
    const { hook, fake } = await running({ sets: 1 });
    act(() => fake().event(DONE));
    expect(hook.result.current.sessionDone).toBe(true);
    await act(() => hook.result.current.start(els));
    expect(hook.result.current.sessionDone).toBe(false);
  });

  it("says Can't see you when no face is ever found, after 3 s", async () => {
    const { v, fake } = await running();
    act(() => fake().sample({ faceVisible: false, tSec: 0 }));
    act(() => fake().sample({ faceVisible: false, tSec: 2.9 }));
    expect(spoken(v)).toEqual([]);
    act(() => fake().sample({ faceVisible: false, tSec: 3 }));
    expect(spoken(v)).toEqual(["Can't see you"]);
    act(() => fake().sample({ faceVisible: true, tSec: 3.2 }));
    act(() => fake().sample({ faceVisible: true, tSec: 3.7 }));
    expect(spoken(v).at(-1)).toBe('Tracking');
  });

  it('a neutral re-set during the rest is shown, not said, and starts nothing', async () => {
    const { hook, v, fake, advance } = await running({
      exerciseId: 'deep-neck-flexor',
      kind: 'guidedHold',
    });
    act(() => fake().calibrated(true, true));
    advance(3_000);
    act(() => fake().event(DONE));
    advance(5_000);
    act(() => fake().calibrated(true, true));
    expect(spoken(v).filter((t) => t === 'Neutral set')).toHaveLength(1);
    expect(spoken(v).filter((t) => t === 'Get ready')).toHaveLength(1);
    expect(hook.result.current.notice).toBe('Neutral reset');
    advance(10_000);
    expect(starts(fake().calls)).toBe(1); // the rest runs on
  });
});

// A set ended before its prescription is saved if it has anything in it (docs/areas/flux D55).
describe('useFluxEngine stopped sets (D55)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  const tuck = initialState(getExercise('chin-tuck'));
  const holds = (n: number, phase: ExerciseState['phase'] = 'active') =>
    ({ ...tuck, phase, holdsDone: n }) as ExerciseState;

  async function running(over: Parameters<typeof setup>[0] = {}) {
    const s = setup(over);
    await act(() => s.hook.result.current.start(els));
    act(() => s.fake().ready('GPU'));
    return s;
  }

  it('Stop after three holds saves them, marked, with the planned count; nothing is said', async () => {
    const { hook, v, onSetCompleted, fake } = await running();
    act(() => fake().state(holds(3)));
    const before = spoken(v).length;
    let summary;
    act(() => {
      summary = hook.result.current.stop();
    });
    expect(onSetCompleted).toHaveBeenCalledTimes(1);
    expect(onSetCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        exerciseId: 'chin-tuck',
        count: 3,
        stoppedEarly: true,
        planned: 6,
      }),
      0,
    );
    expect(summary).toMatchObject({ sets: 1 });
    expect(spoken(v)).toHaveLength(before);
    expect(v.cancel).toHaveBeenCalled();
  });

  it('Stop before the first hold saves nothing', async () => {
    const { hook, onSetCompleted, fake } = await running();
    act(() => fake().state(holds(0)));
    let summary;
    act(() => {
      summary = hook.result.current.stop();
    });
    expect(onSetCompleted).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ sets: 0 });
  });

  it('a finished set is saved once — not again by a Stop during the rest', async () => {
    const { hook, onSetCompleted, fake } = await running();
    act(() => fake().state(holds(5)));
    act(() => fake().event({ type: 'setCompleted', summary: { count: 6 } }));
    act(() => hook.result.current.stop()); // before the worker's next (complete) state post
    expect(onSetCompleted).toHaveBeenCalledTimes(1);
    expect(onSetCompleted.mock.calls[0]?.[0]).toMatchObject({ count: 6, stoppedEarly: false });
  });

  it('nor by a Stop once the finished state has been posted', async () => {
    const { hook, onSetCompleted, fake } = await running();
    act(() => fake().event({ type: 'setCompleted', summary: { count: 6 } }));
    act(() => fake().state(holds(6, 'complete')));
    act(() => hook.result.current.stop());
    expect(onSetCompleted).toHaveBeenCalledTimes(1);
  });

  it('Stop then leaving the page saves the set once', async () => {
    const { hook, onSetCompleted, fake } = await running();
    act(() => fake().state(holds(2)));
    act(() => hook.result.current.stop());
    hook.unmount();
    expect(onSetCompleted).toHaveBeenCalledTimes(1);
  });

  it('leaving the page mid-set saves it', async () => {
    const { hook, onSetCompleted, fake } = await running();
    act(() => fake().state(holds(2)));
    hook.unmount();
    expect(onSetCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ count: 2, stoppedEarly: true }),
      0,
    );
  });

  it('a tracker error mid-set saves it, then says tracking stopped', async () => {
    const { v, onSetCompleted, fake } = await running();
    act(() => fake().state(holds(4)));
    act(() => fake().fail('detect', 'boom'));
    expect(onSetCompleted).toHaveBeenCalledWith(expect.objectContaining({ count: 4 }), 0);
    expect(spoken(v).at(-1)).toMatch(/[Tt]racking/);
  });

  it('a set saved by an error isn’t saved again when the page is left', async () => {
    const { hook, onSetCompleted, fake } = await running();
    act(() => fake().state(holds(4)));
    act(() => fake().fail('detect', 'boom'));
    hook.unmount();
    expect(onSetCompleted).toHaveBeenCalledTimes(1);
  });

  it('a camera pause is not an end; a pause then Stop saves once', async () => {
    const { hook, onSetCompleted, fake } = await running();
    act(() => fake().state(holds(2)));
    act(() => fake().pause());
    expect(onSetCompleted).not.toHaveBeenCalled();
    act(() => hook.result.current.stop());
    expect(onSetCompleted).toHaveBeenCalledTimes(1);
  });

  it('a GPU→CPU fallback restarts the set (D26): the new worker’s fresh state is what Stop sees', async () => {
    const { hook, onSetCompleted, fake } = await running();
    act(() => fake().state(holds(2)));
    act(() => fake().ready('CPU', true));
    expect(onSetCompleted).not.toHaveBeenCalled();
    act(() => fake().state(holds(0))); // the new worker's first post
    act(() => hook.result.current.stop());
    expect(onSetCompleted).not.toHaveBeenCalled();
  });

  it('a Stop right after a fallback, before the new worker posts, saves nothing either', async () => {
    const { hook, onSetCompleted, fake } = await running();
    act(() => fake().state(holds(2)));
    act(() => fake().ready('CPU', true));
    act(() => hook.result.current.stop());
    expect(onSetCompleted).not.toHaveBeenCalled();
  });

  it('a reload or a closed tab mid-set saves it; a page kept for back/forward doesn’t', async () => {
    const { onSetCompleted, fake } = await running();
    act(() => fake().state(holds(2)));
    const hide = (persisted: boolean) =>
      act(() => {
        const e = new Event('pagehide') as PageTransitionEvent;
        Object.defineProperty(e, 'persisted', { value: persisted });
        window.dispatchEvent(e);
      });
    hide(true);
    expect(onSetCompleted).not.toHaveBeenCalled();
    hide(false);
    expect(onSetCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ count: 2, stoppedEarly: true }),
      0,
    );
  });

  it('a Re-calibrate mid-set carries on — nothing saved, the set not restarted', async () => {
    const { v, onSetCompleted, fake } = await running({
      exerciseId: 'deep-neck-flexor',
      kind: 'guidedHold',
    });
    const dnf = initialState(getExercise('deep-neck-flexor'));
    act(() => fake().calibrated(true));
    act(() => fake().state({ ...dnf, phase: 'active', holdsDone: 2 } as ExerciseState));
    const said = spoken(v).length;
    act(() => fake().calibrated(true));
    expect(onSetCompleted).not.toHaveBeenCalled();
    // "Neutral set", and no "Get ready" — the set isn't being started again.
    expect(spoken(v).slice(said).join(' ')).not.toMatch(/Get ready/i);
  });

  it('switching sides mid-set saves what was done as the old side’s set', async () => {
    const { hook, props, onSetCompleted, fake } = await running({
      exerciseId: 'upper-trap-stretch',
      kind: 'holdAtTarget',
      side: 'a',
    });
    const trap = initialState(getExercise('upper-trap-stretch'));
    act(() => fake().state({ ...trap, phase: 'active', holdsDone: 1 } as ExerciseState));
    hook.rerender({ ...props, side: 'b' });
    expect(onSetCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'a', count: 1, stoppedEarly: true, planned: 2 }),
      0,
    );
  });
});
