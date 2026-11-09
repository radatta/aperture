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
  it('walks Start through reset, confirm and the timer to the server, then goes active', () => {
    let r = run([...prompt, { type: 'start' }]);
    expect(r.state).toMatchObject({ phase: 'starting', step: 'reset' });
    expect(r.effects).toEqual([{ do: 'step', step: 'reset' }]);
    r = run([{ type: 'stepOk', step: 'reset' }], r.state);
    expect(r.effects).toEqual([{ do: 'step', step: 'confirm' }]);
    r = run([{ type: 'stepOk', step: 'confirm' }, { type: 'stepOk', step: 'timer' }], r.state);
    expect(r.state.step).toBe('send');
    expect(r.effects).toEqual([{ do: 'step', step: 'send' }]);
    expect(run([{ type: 'started' }], r.state).state.phase).toBe('active');
  });

  it('says the reset button was not found, and Start anyway goes straight to the server start', () => {
    let r = run([...prompt, { type: 'start' }, { type: 'stepFail', step: 'reset', reason: 'Couldn’t find LeetCode’s reset button.' }]);
    expect(r.state).toMatchObject({ phase: 'failed', step: 'reset', reason: 'Couldn’t find LeetCode’s reset button.' });
    r = run([{ type: 'startAnyway' }], r.state);
    expect(r.state).toMatchObject({ phase: 'starting', step: 'send', reason: null });
    expect(r.effects).toEqual([{ do: 'step', step: 'send' }]);
    r = run([{ type: 'stepFail', step: 'send', reason: 'Another sitting is still open' }], r.state);
    expect(run([{ type: 'retry' }], r.state).state).toMatchObject({ phase: 'starting', step: 'reset' });
  });

  it('resumes an open sitting on load with no overlay and no clicks', () => {
    const r = run([{ type: 'nav', slug: 'two-sum', binding: { status: 'active' }, dismissed: false }]);
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
    expect(run([{ type: 'nav', slug: 'two-sum', binding: null, dismissed: true }]).state.phase).toBe('hidden');
    expect(run([{ type: 'nav', slug: null }]).state.phase).toBe('hidden');
  });

  it('ignores actions that don’t fit the phase', () => {
    const s = run(prompt).state;
    expect(run([{ type: 'started' }], s).state).toEqual(s);
    expect(run([{ type: 'stepOk', step: 'timer' }], s).state).toEqual(s);
    expect(run([{ type: 'startAnyway' }], s).state).toEqual(s);
    const active = run([{ type: 'start' }, { type: 'stepFail', step: 'reset', reason: 'x' }, { type: 'startAnyway' }, { type: 'started' }], s);
    expect(run([{ type: 'ended' }], active.state)).toMatchObject({ state: { phase: 'ended' }, effects: [{ do: 'clearBinding' }] });
  });
});
