import { describe, it, expect } from 'vitest';
import { cycleMode, placeholderFor, receiptFor } from './mode';

describe('cycleMode', () => {
  it('cycles forward with wrap-around', () => {
    expect(cycleMode('log', 1)).toBe('task');
    expect(cycleMode('task', 1)).toBe('idea');
    expect(cycleMode('idea', 1)).toBe('log');
  });
  it('cycles backward with wrap-around', () => {
    expect(cycleMode('log', -1)).toBe('idea');
    expect(cycleMode('idea', -1)).toBe('task');
  });
});

describe('placeholderFor', () => {
  it('never asks for structure — just an invitation to type', () => {
    expect(placeholderFor('log')).toBe('What happened?');
    expect(placeholderFor('task')).toBe('New task…');
    expect(placeholderFor('idea')).toBe('Capture an idea…');
  });
});

describe('→ today', () => {
  it('changes the task placeholder only', () => {
    expect(placeholderFor('task', true)).toBe('New task for today…');
    expect(placeholderFor('log', true)).toBe('What happened?');
  });
  it('says where the task landed, including when planning failed', () => {
    expect(receiptFor('task')).toEqual({ text: 'Task added', label: 'backlog' });
    expect(receiptFor('task', { today: true, planned: true }).label).toBe('today');
    expect(receiptFor('task', { today: true, planned: false }).label).toBe(
      'backlog (couldn’t plan it)',
    );
    // An errand waits on its store's list, not the backlog.
    expect(receiptFor('task', { today: false, planned: false, placeName: 'Safeway' }).label).toBe(
      'Safeway',
    );
    expect(receiptFor('task', { today: true, planned: false, placeName: 'Safeway' }).label).toBe(
      'Safeway (couldn’t plan it)',
    );
    expect(
      receiptFor('task', {
        today: false,
        planned: false,
        placeName: 'Safeway',
        timedOn: 'due Fri 4pm',
      }).label,
    ).toBe('due Fri 4pm, by its time');
  });
});
