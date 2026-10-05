import { afterEach, describe, expect, it, vi } from 'vitest';
import { chime, unlockAudio } from './chime';

// jsdom has no Web Audio; a fake records what the chime asks of the context.
const made: FakeContext[] = [];
class FakeContext {
  state = 'suspended';
  currentTime = 0;
  destination = {};
  oscillators = 0;
  resume = vi.fn(() => {
    this.state = 'running';
    return Promise.resolve();
  });
  constructor() {
    made.push(this);
  }
  createGain() {
    return { connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } };
  }
  createOscillator() {
    this.oscillators++;
    return { connect() {}, start() {}, stop() {}, frequency: { value: 0 } };
  }
}

describe('chime', () => {
  afterEach(() => {
    made.length = 0;
    vi.unstubAllGlobals();
  });

  it('is a no-op without Web Audio', () => {
    expect(() => {
      unlockAudio();
      chime();
    }).not.toThrow();
  });

  it('stays silent until a gesture unlocks it', () => {
    vi.stubGlobal('AudioContext', FakeContext);
    chime();
    expect(made).toHaveLength(0);
  });

  it('reuses the one context the gesture started', () => {
    vi.stubGlobal('AudioContext', FakeContext);
    unlockAudio();
    unlockAudio();
    chime();
    chime();
    expect(made).toHaveLength(1);
    expect(made[0]!.resume).toHaveBeenCalledTimes(1);
    expect(made[0]!.oscillators).toBe(2);
  });

  it('drops the chime while interrupted, and the next gesture restarts it', () => {
    vi.stubGlobal('AudioContext', FakeContext);
    unlockAudio();
    const ac = made[0]!;
    ac.state = 'interrupted';
    chime();
    expect(ac.oscillators).toBe(0);
    unlockAudio();
    chime();
    expect(ac.resume).toHaveBeenCalledTimes(2);
    expect(ac.oscillators).toBe(1);
  });
});
