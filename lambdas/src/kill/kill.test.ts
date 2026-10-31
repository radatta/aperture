import { describe, expect, it } from 'vitest';
import { kill, killConfigFrom } from './kill';
import type { KillGateways } from './kill';

const cfg = {
  policyId: 'p-kill',
  devAccountId: '222222222222',
  urlFunctions: ['aperture-bff-dev', 'aperture-mcp-dev'],
};

function fakeGateways(
  fail: { attach?: Error; lock?: Record<string, Error> } = {},
  already = false,
) {
  const calls: string[] = [];
  const gw: KillGateways = {
    async attachPolicy(policyId, targetId) {
      calls.push(`attach ${policyId} ${targetId}`);
      if (fail.attach) throw fail.attach;
      return already ? 'already' : 'attached';
    },
    async lockFunctionUrl(fn) {
      calls.push(`lock ${fn}`);
      const e = fail.lock?.[fn];
      if (e) throw e;
    },
  };
  return { gw, calls };
}

describe('kill', () => {
  it('attaches the kill SCP to the dev account, then locks every URL function', async () => {
    const { gw, calls } = fakeGateways();
    const log: string[] = [];
    await kill(cfg, gw, (l) => log.push(l));
    expect(calls).toEqual([
      'attach p-kill 222222222222',
      'lock aperture-bff-dev',
      'lock aperture-mcp-dev',
    ]);
    expect(log[0]).toBe('kill SCP attached to 222222222222');
  });

  it('treats an existing attachment as done (a second trigger or a retry)', async () => {
    const { gw } = fakeGateways({}, true);
    const log: string[] = [];
    await kill(cfg, gw, (l) => log.push(l));
    expect(log[0]).toBe('kill SCP already on 222222222222');
  });

  it('still locks the URLs when the attach fails, then throws so Lambda retries', async () => {
    const { gw, calls } = fakeGateways({
      attach: Object.assign(new Error('denied'), { name: 'AccessDeniedException' }),
    });
    await expect(kill(cfg, gw, () => {})).rejects.toThrow(
      /attach p-kill: AccessDeniedException: denied/,
    );
    expect(calls).toContain('lock aperture-bff-dev');
    expect(calls).toContain('lock aperture-mcp-dev');
  });

  it('locks the remaining URLs when one fails, and names the failure', async () => {
    const { gw, calls } = fakeGateways({ lock: { 'aperture-bff-dev': new Error('throttled') } });
    await expect(kill(cfg, gw, () => {})).rejects.toThrow(
      /lock aperture-bff-dev: Error: throttled/,
    );
    expect(calls).toContain('lock aperture-mcp-dev');
  });
});

describe('killConfigFrom', () => {
  it('reads the policy, the account and the URL functions', () => {
    expect(
      killConfigFrom({
        KILL_POLICY_ID: 'p-1',
        DEV_ACCOUNT_ID: '222222222222',
        URL_FUNCTIONS: 'a-dev, b-dev,',
      }),
    ).toEqual({ policyId: 'p-1', devAccountId: '222222222222', urlFunctions: ['a-dev', 'b-dev'] });
  });

  it('fails closed on any missing variable', () => {
    expect(() => killConfigFrom({ DEV_ACCOUNT_ID: '2', URL_FUNCTIONS: 'a' })).toThrow(
      /KILL_POLICY_ID/,
    );
    expect(() => killConfigFrom({ KILL_POLICY_ID: 'p', URL_FUNCTIONS: 'a' })).toThrow(
      /DEV_ACCOUNT_ID/,
    );
    expect(() =>
      killConfigFrom({ KILL_POLICY_ID: 'p', DEV_ACCOUNT_ID: '2', URL_FUNCTIONS: ' ' }),
    ).toThrow(/URL_FUNCTIONS/);
    expect(() =>
      killConfigFrom({ KILL_POLICY_ID: 'p', DEV_ACCOUNT_ID: '2', URL_FUNCTIONS: ',' }),
    ).toThrow(/URL_FUNCTIONS/);
  });
});
