import { describe, expect, it } from 'vitest';
import { signState, verifyState } from './state';

const SECRET = 'origin-secret';

describe('OAuth state sign/verify', () => {
  it('round-trips the userId', () => {
    const state = signState('cognito-sub-123', SECRET, 1_000_000);
    expect(verifyState(state, SECRET, 1_000_000).userId).toBe('cognito-sub-123');
  });

  it('rejects a tampered payload', () => {
    const state = signState('u', SECRET, 1_000_000);
    const [, mac] = state.split('.');
    const forged = `${Buffer.from('attacker:1000000', 'utf8').toString('base64url')}.${mac}`;
    expect(() => verifyState(forged, SECRET, 1_000_000)).toThrow();
  });

  it('rejects a wrong secret', () => {
    const state = signState('u', SECRET, 1_000_000);
    expect(() => verifyState(state, 'other-secret', 1_000_000)).toThrow();
  });

  it('rejects an expired state', () => {
    const state = signState('u', SECRET, 1_000_000);
    expect(() => verifyState(state, SECRET, 1_000_000 + 11 * 60_000)).toThrow(/expired/i);
  });

  it('rejects a malformed state', () => {
    expect(() => verifyState('garbage', SECRET)).toThrow();
  });
});
