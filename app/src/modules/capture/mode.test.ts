import { describe, it, expect } from 'vitest';
import { cycleMode, placeholderFor } from './mode';

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
