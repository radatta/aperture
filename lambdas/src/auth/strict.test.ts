import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEV_STATE_SECRET,
  logMissingAuthEnv,
  missingAuthEnv,
  originPasses,
  resetOriginLogForTest,
  stateKey,
  strictAuth,
} from './strict';

describe('strictAuth', () => {
  it('is on in a Lambda (the reserved runtime var) or with a stage set, off otherwise', () => {
    expect(strictAuth({ AWS_LAMBDA_FUNCTION_NAME: 'aperture-bff-dev' })).toBe(true);
    expect(strictAuth({ STAGE: 'dev' })).toBe(true);
    expect(strictAuth({})).toBe(false);
    expect(strictAuth({ STAGE: '' })).toBe(false);
  });
});

describe('missingAuthEnv', () => {
  it('names the unset vars on a stage, and nothing off one', () => {
    const names = ['ORIGIN_SECRET', 'AGENT_TOKEN'];
    expect(missingAuthEnv(names, { STAGE: 'dev', ORIGIN_SECRET: 's' })).toEqual(['AGENT_TOKEN']);
    expect(missingAuthEnv(names, {})).toEqual([]);
  });
});

describe('logMissingAuthEnv', () => {
  afterEach(() => {
    delete process.env.STAGE;
    vi.restoreAllMocks();
  });
  it('logs the missing names once on a stage — never a value', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.STAGE = 'dev';
    logMissingAuthEnv('mcp', ['STRICT_TEST_UNSET']);
    expect(err).toHaveBeenCalledWith(
      JSON.stringify({ event: 'auth_misconfigured', fn: 'mcp', missing: ['STRICT_TEST_UNSET'] }),
    );
  });
  it('an unset optional name (DEVICE_USER_ID) is an info line, not a misconfiguration', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.STAGE = 'dev';
    logMissingAuthEnv('mcp', [], ['STRICT_TEST_UNSET']);
    expect(err).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ event: 'auth_unbound', fn: 'mcp', unset: ['STRICT_TEST_UNSET'] }),
    );
  });
  it('is silent off a stage', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    logMissingAuthEnv('mcp', ['STRICT_TEST_UNSET']);
    expect(err).not.toHaveBeenCalled();
  });
});

describe('originPasses', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetOriginLogForTest();
  });
  it('a set secret must match, on a stage or off one', () => {
    for (const strict of [true, false]) {
      expect(originPasses('s', 's', 'bff', strict)).toBe(true);
      expect(originPasses('x', 's', 'bff', strict)).toBe(false);
      expect(originPasses(undefined, 's', 'bff', strict)).toBe(false);
    }
  });
  it('an unset secret skips the gate off a stage and refuses on one, logged', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(originPasses(undefined, undefined, 'bff', false)).toBe(true);
    expect(err).not.toHaveBeenCalled();
    expect(originPasses('anything', undefined, 'bff', true)).toBe(false);
    expect(err).toHaveBeenCalledWith(JSON.stringify({ event: 'origin_secret_unset', fn: 'bff' }));
  });
  it('logs the unset secret once per container, however many calls it refuses', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < 3; i++) expect(originPasses('x', undefined, 'bff', true)).toBe(false);
    expect(err).toHaveBeenCalledTimes(1);
  });
});

describe('stateKey', () => {
  it('is the secret when set, the dev key off a stage, and refused on a stage', () => {
    expect(stateKey('s', true)).toBe('s');
    expect(stateKey('s', false)).toBe('s');
    expect(stateKey(undefined, false)).toBe(DEV_STATE_SECRET);
    expect(() => stateKey(undefined, true)).toThrow(/not configured on this stage/);
  });
});
