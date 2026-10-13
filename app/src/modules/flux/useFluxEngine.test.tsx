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
  const hook = renderHook((p: FluxEngineOptions) => useFluxEngine(p), {
    initialProps: {
      exerciseId: 'chin-tuck',
      kind: 'holdAtTarget',
      side: null,
      condition: null,
      acknowledged: true,
      voice: v,
      onSetCompleted,
      ...over,
    },
  });
  return { hook, v, onSetCompleted, fake: () => fake as FakeControls };
}

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
