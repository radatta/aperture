import { describe, expect, it, vi } from 'vitest';
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
      acknowledged: true,
      voice: v,
      onSetCompleted,
      ...over,
    },
  });
  return { hook, v, onSetCompleted, fake: () => fake as FakeControls };
}

const els = { video: document.createElement('video'), canvas: document.createElement('canvas') };

describe('useFluxEngine', () => {
  it('primes speech inside Start (the gesture) and walks idle → loading → running → idle', async () => {
    const { hook, v, fake } = setup();
    expect(hook.result.current.status).toBe('idle');
    await act(() => hook.result.current.start(els));
    expect(v.prime).toHaveBeenCalledTimes(1);
    expect(hook.result.current.status).toBe('loading');
    act(() => fake().ready('CPU'));
    expect(hook.result.current.status).toBe('running');
    expect(hook.result.current.delegate).toBe('CPU');
    act(() => hook.result.current.stop());
    expect(hook.result.current.status).toBe('idle');
    expect(v.cancel).toHaveBeenCalled();
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

  it('speaks cues through the reducer and records each finished set', async () => {
    const { hook, v, onSetCompleted, fake } = setup();
    await act(() => hook.result.current.start(els));
    act(() => fake().ready('GPU'));
    act(() => fake().calibrated(true));
    act(() => fake().event({ type: 'setCompleted', summary: { count: 10 } }));
    expect(v.speak).toHaveBeenCalledWith({ text: 'Set complete. Well done.', priority: 'high' });
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
