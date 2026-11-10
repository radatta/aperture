import { describe, expect, it } from 'vitest';
import { lib } from './load';

const { reduce, initial } = lib('overlay-state');
type S = ReturnType<typeof initial>;
const run = (actions: object[], s: S = initial()) => {
  let effects: unknown[] = [];
  for (const a of actions) ({ state: s, effects } = reduce(s, a));
  return { state: s, effects };
};
const prompt = [{ type: 'nav', slug: 'two-sum', binding: null, dismissed: false }];

describe('overlay state', () => {
  it('opens the sitting first, then walks reset, confirm and the timer, then goes active', () => {
    let r = run([...prompt, { type: 'start' }]);
    expect(r.state).toMatchObject({ phase: 'starting', step: 'send', open: false });
    expect(r.effects).toEqual([{ do: 'step', step: 'send' }]);
    r = run([{ type: 'stepOk', step: 'send' }], r.state);
    expect(r.state).toMatchObject({ step: 'reset', open: true });
    expect(r.effects).toEqual([{ do: 'step', step: 'reset' }]);
    r = run([{ type: 'stepOk', step: 'reset' }], r.state);
    expect(r.effects).toEqual([{ do: 'step', step: 'confirm' }]);
    r = run(
      [
        { type: 'stepOk', step: 'confirm' },
        { type: 'stepOk', step: 'timer' },
      ],
      r.state,
    );
    expect(r.state).toMatchObject({ phase: 'active', step: null, open: true });
    expect(r.effects).toEqual([]);
  });

  it('retries only the send after a refusal, which clicked nothing, and lets Just looking out', () => {
    const r = run([
      ...prompt,
      { type: 'start' },
      { type: 'stepFail', step: 'send', reason: 'Another sitting is still open' },
    ]);
    expect(r.state).toMatchObject({ phase: 'failed', step: 'send', open: false });
    expect(run([{ type: 'retry' }], r.state)).toMatchObject({
      state: { phase: 'starting', step: 'send' },
      effects: [{ do: 'step', step: 'send' }],
    });
    expect(run([{ type: 'continue' }], r.state).state).toEqual(r.state);
    expect(run([{ type: 'dismiss' }], r.state).state.phase).toBe('hidden');
  });

  it('says the reset button was not found once the sitting is open: Retry repeats that click, Continue goes active', () => {
    const r = run([
      ...prompt,
      { type: 'start' },
      { type: 'stepOk', step: 'send' },
      { type: 'stepFail', step: 'reset', reason: 'Couldn’t find LeetCode’s reset button.' },
    ]);
    expect(r.state).toMatchObject({
      phase: 'failed',
      step: 'reset',
      open: true,
      reason: 'Couldn’t find LeetCode’s reset button.',
    });
    expect(run([{ type: 'retry' }], r.state)).toMatchObject({
      state: { phase: 'starting', step: 'reset' },
      effects: [{ do: 'step', step: 'reset' }],
    });
    expect(run([{ type: 'continue' }], r.state)).toMatchObject({
      state: { phase: 'active', step: null, reason: null },
      effects: [],
    });
    expect(run([{ type: 'dismiss' }], r.state).state).toEqual(r.state); // the sitting is open
    // LeetCode's dialog closed after the reset: Retry steps back to the reset, never to the send.
    const confirmFailed = run(
      [
        { type: 'retry' },
        { type: 'stepOk', step: 'reset' },
        { type: 'stepFail', step: 'confirm', reason: 'Couldn’t find the reset’s confirm button.' },
      ],
      r.state,
    ).state;
    expect(run([{ type: 'retry', from: 'reset' }], confirmFailed).state.step).toBe('reset');
    expect(run([{ type: 'retry', from: 'send' }], confirmFailed).state.step).toBe('confirm');
    expect(run([{ type: 'retry', from: 'timer' }], confirmFailed).state.step).toBe('confirm');
    // Ended in Aperture while it waits on Retry: no click for a closed sitting.
    expect(run([{ type: 'ended' }], r.state)).toMatchObject({
      state: { phase: 'ended' },
      effects: [{ do: 'clearBinding' }],
    });
  });

  it('resumes an open sitting on load with no overlay and no clicks', () => {
    const r = run([
      { type: 'nav', slug: 'two-sum', binding: { status: 'active' }, dismissed: false },
    ]);
    expect(r.state.phase).toBe('resuming');
    expect(r.effects).toEqual([{ do: 'resume' }]);
    expect(run([{ type: 'resumed', active: true }], r.state).state.phase).toBe('active');
    const gone = run([{ type: 'resumed', active: false }], r.state);
    expect(gone.state.phase).toBe('prompt');
    expect(gone.effects).toEqual([{ do: 'clearBinding' }]);
  });

  it('remembers Just looking, and stays hidden for a dismissed problem', () => {
    const r = run([...prompt, { type: 'dismiss' }]);
    expect(r.state.phase).toBe('hidden');
    expect(r.effects).toEqual([{ do: 'rememberDismiss' }]);
    expect(
      run([{ type: 'nav', slug: 'two-sum', binding: null, dismissed: true }]).state.phase,
    ).toBe('hidden');
    expect(run([{ type: 'nav', slug: null }]).state.phase).toBe('hidden');
  });

  it('ignores actions that don’t fit the phase', () => {
    const s = run(prompt).state;
    expect(run([{ type: 'stepOk', step: 'timer' }], s).state).toEqual(s);
    expect(run([{ type: 'continue' }], s).state).toEqual(s);
    expect(run([{ type: 'retry' }], s).state).toEqual(s);
    const active = run(
      [
        { type: 'start' },
        { type: 'stepOk', step: 'send' },
        { type: 'stepFail', step: 'reset', reason: 'x' },
        { type: 'continue' },
      ],
      s,
    );
    expect(active.state.phase).toBe('active');
    expect(run([{ type: 'start' }], active.state).state).toEqual(active.state);
    expect(run([{ type: 'ended' }], active.state)).toMatchObject({
      state: { phase: 'ended' },
      effects: [{ do: 'clearBinding' }],
    });
  });
});
