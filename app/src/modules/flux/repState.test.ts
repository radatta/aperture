import { describe, expect, it } from 'vitest';
import type { Roll, Task } from '@aperture/shared';
import { prefillMinutes, repTie } from './repState';

const roll = { id: 'r1', name: 'Neck', active: true } as Roll;
const task = (over: Partial<Task>) =>
  ({ id: 't', rollId: 'r1', status: 'planned', completedAt: null, ...over }) as Task;
const NOON = new Date(2026, 9, 8, 12).getTime();
const TODAY = '2026-10-08';

describe('repTie', () => {
  it('is unlinked with no roll id, an unknown roll, or an archived one', () => {
    expect(repTie(null, [roll], [], TODAY, 4).kind).toBe('unlinked');
    expect(repTie('nope', [roll], [], TODAY, 4).kind).toBe('unlinked');
    expect(repTie('r1', [{ ...roll, active: false }], [], TODAY, 4).kind).toBe('unlinked');
  });

  it('reads the open rep: backlog/planned are ready, in_progress is in progress', () => {
    expect(repTie('r1', [roll], [task({ status: 'backlog' })], TODAY, 4).kind).toBe('ready');
    expect(repTie('r1', [roll], [task({ status: 'planned' })], TODAY, 4).kind).toBe('ready');
    expect(repTie('r1', [roll], [task({ status: 'in_progress' })], TODAY, 4).kind).toBe(
      'in_progress',
    );
  });

  it('is done when a rep finished today, none when the last one was another day', () => {
    const done = task({ status: 'done', completedAt: NOON });
    expect(repTie('r1', [roll], [done], TODAY, 4).kind).toBe('done');
    expect(repTie('r1', [roll], [done], '2026-10-09', 4).kind).toBe('none');
    expect(repTie('r1', [roll], [task({ rollId: 'other' })], TODAY, 4).kind).toBe('none');
  });
});

describe('prefillMinutes', () => {
  it('takes the larger of the session and the rep’s live elapsed', () => {
    expect(prefillMinutes(12 * 60_000, 3)).toBe(12);
    expect(prefillMinutes(5 * 60_000, 17.4)).toBe(17);
    expect(prefillMinutes(20_000, 0)).toBe(0);
  });
});
