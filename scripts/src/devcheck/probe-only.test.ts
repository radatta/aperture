import { describe, expect, it } from 'vitest';
import type { IosOp } from '../mailroom/sim';
import { probeJobs, probeOnly } from './probe-only';

const ops = (steps: IosOp[]) => steps.map((s) => s.op);

describe('probeOnly', () => {
  it('drops a typed window: keys through the erase that empties the same field', () => {
    const steps: IosOp[] = [
      { op: 'find', label: 'Capture log', near: { x: 200, y: 480 }, as: 'bar' },
      { op: 'keys', text: 'zzqx', in: 'bar' },
      { op: 'find', label: 'Save log', near: { x: 395, y: 480 }, as: 'send' },
      { op: 'expect', as: 'send', enabled: true },
      { op: 'erase', n: 6, in: 'bar' },
      { op: 'expect', as: 'bar', valueIs: 'What happened?' },
      { op: 'expect', as: 'send', enabled: false },
    ];
    expect(probeOnly(steps, { first: false })).toEqual([
      steps[0],
      { op: 'expect', as: 'bar', valueIs: 'What happened?' },
    ]);
  });

  it('ends a window at an erase with no field, and skips an erase for another field', () => {
    const steps: IosOp[] = [
      { op: 'find', label: 'A', near: { x: 1, y: 1 }, as: 'a' },
      { op: 'find', label: 'B', near: { x: 1, y: 1 }, as: 'b' },
      { op: 'keys', text: 'vacuum', in: 'a' },
      { op: 'erase', n: 2, in: 'b' },
      { op: 'tap', label: 'Review before saving', near: { x: 1, y: 1 } },
      { op: 'erase', n: 8 },
      { op: 'tap', label: 'Log', near: { x: 1, y: 1 } },
    ];
    expect(ops(probeOnly(steps, { first: false }))).toEqual(['find', 'find', 'tap']);
    expect(probeOnly(steps, { first: false }).at(-1)).toEqual(steps[6]);
  });

  it('drops a keys no erase empties alone, and any read of its text', () => {
    const steps: IosOp[] = [
      { op: 'tap', label: 'Search tasks', near: { x: 1, y: 1 }, as: 'search' },
      { op: 'keys', text: 'abcdef', in: 'search' },
      { op: 'blur' },
      { op: 'find', label: 'abcdef', near: { x: 1, y: 1 }, as: 'hit' },
      { op: 'tap', label: 'Done', near: { x: 1, y: 1 } },
    ];
    expect(ops(probeOnly(steps, { first: false }))).toEqual(['tap', 'blur', 'tap']);
  });

  it('opens the first job with a launch and keeps its build guard; drops sign-in, kills and relaunches', () => {
    const steps: IosOp[] = [
      { op: 'launch' },
      { op: 'signIn' },
      { op: 'expect', signedIn: true },
      { op: 'kill', method: 'terminate' },
      { op: 'launch' },
      { op: 'readBuild' },
      { op: 'expectBuild' },
      { op: 'shot', name: 'home' },
    ];
    expect(probeOnly(steps, { first: true })).toEqual([
      { op: 'launch' },
      { op: 'expect', signedIn: true },
      { op: 'readBuild' },
      { op: 'expectBuild' },
      { op: 'shot', name: 'home' },
    ]);
    expect(probeOnly(steps, { first: false })).toEqual([{ op: 'shot', name: 'home' }]);
  });

  it('drops an expect whose element, or the one it compares widths with, was dropped', () => {
    const steps: IosOp[] = [
      { op: 'keys', text: 'zz' },
      { op: 'find', label: 'X', near: { x: 1, y: 1 }, as: 'x0' },
      { op: 'erase', n: 2 },
      { op: 'find', label: 'X', near: { x: 1, y: 1 }, as: 'x' },
      { op: 'expect', as: 'x', sameWidthAs: 'x0' },
      { op: 'expect', as: 'x', aboveKeyboard: true },
    ];
    expect(probeOnly(steps, { first: false })).toEqual([steps[3], steps[5]]);
  });

  it('keeps nav, absent, tap with closes and hint, scroll, wait and shots as sent', () => {
    const steps: IosOp[] = [
      { op: 'nav', tab: 'Tasks' },
      { op: 'scroll', dir: 'down', pt: 400 },
      { op: 'wait', s: 2 },
      { op: 'absent', label: 'Capture log', near: { x: 200, y: 480 }, radius: 40 },
      {
        op: 'tap',
        label: 'Cancel',
        scan: { x: 190, from: 150, to: 720 },
        hint: { x: 187, y: 378 },
        role: 'AXButton',
        closes: true,
      },
      { op: 'shot', name: 'closed' },
    ];
    expect(probeOnly(steps, { first: false })).toEqual(steps);
  });
});

describe('probeJobs', () => {
  const plans = [
    { name: 'launch', steps: [{ op: 'launch' }, { op: 'signIn' }, { op: 'readBuild' }] },
    { name: 'capture', steps: [{ op: 'nav', tab: 'Home' }] },
    {
      name: 'relaunch',
      steps: [
        { op: 'kill', method: 'terminate' },
        { op: 'launch' },
        { op: 'expect', signedIn: true },
        { op: 'readBuild', stay: true },
        { op: 'shutdown' },
      ],
    },
  ] satisfies { name: string; steps: IosOp[] }[];

  it('drops a job left with nothing to probe and shuts the sim down after the last', () => {
    expect(probeJobs(plans)).toEqual([
      { name: 'launch', steps: [{ op: 'launch' }, { op: 'readBuild' }] },
      { name: 'capture', steps: [{ op: 'nav', tab: 'Home' }, { op: 'shutdown' }] },
    ]);
  });
});
