import { describe, expect, it } from 'vitest';
import {
  isAlreadyAttached,
  isRestore,
  kill,
  killConfigFrom,
  restore,
  setDistributionsEnabled,
} from './kill';
import type { CloudFrontLike, KillGateways } from './kill';

const cfg = {
  policyId: 'p-kill',
  devAccountId: '222222222222',
  devRegion: 'us-west-1',
  breakGlassRoleArn: 'arn:aws:iam::222222222222:role/OrganizationAccountAccessRole',
  urlFunctions: ['aperture-bff-dev', 'aperture-mcp-dev'],
};

interface Fail {
  attach?: Error;
  list?: Error;
  concurrency?: Record<string, Error>;
  url?: Record<string, Error>;
  distributions?: Error;
}

function fakeGateways(fail: Fail = {}, opts: { already?: boolean; functions?: string[] } = {}) {
  const calls: string[] = [];
  const gw: KillGateways = {
    async attachPolicy(policyId, targetId) {
      calls.push(`attach ${policyId} ${targetId}`);
      if (fail.attach) throw fail.attach;
      return opts.already ? 'already' : 'attached';
    },
    async listFunctions() {
      calls.push('list');
      if (fail.list) throw fail.list;
      return (
        opts.functions ?? [
          'aperture-bff-dev',
          'aperture-mcp-dev',
          'aperture-finance-sync-dev',
          'ApertureApp-dev-LogRetention',
        ]
      );
    },
    async setConcurrency(fn, value) {
      calls.push(`concurrency ${fn} ${value}`);
      const e = fail.concurrency?.[fn];
      if (e) throw e;
    },
    async setUrlAuth(fn, auth) {
      calls.push(`url ${fn} ${auth}`);
      const e = fail.url?.[fn];
      if (e) throw e;
    },
    async setDistributionsEnabled(enabled) {
      calls.push(`distributions ${enabled}`);
      if (fail.distributions) throw fail.distributions;
      return ['E123'];
    },
  };
  return { gw, calls };
}

describe('kill', () => {
  it('attaches the kill SCP, throttles every dev function to 0, locks the URLs and disables the distributions', async () => {
    const { gw, calls } = fakeGateways();
    const log: string[] = [];
    await kill(cfg, gw, (l) => log.push(l));
    expect(calls).toEqual([
      'attach p-kill 222222222222',
      'list',
      'concurrency aperture-bff-dev 0',
      'concurrency aperture-mcp-dev 0',
      'concurrency aperture-finance-sync-dev 0',
      'concurrency ApertureApp-dev-LogRetention 0',
      'url aperture-bff-dev AWS_IAM',
      'url aperture-mcp-dev AWS_IAM',
      'distributions false',
    ]);
    expect(log[0]).toBe('kill SCP attached to 222222222222');
    expect(log.at(-1)).toBe('distributions disabled: E123');
  });

  it('treats an existing attachment as done (a second trigger or a retry)', async () => {
    const { gw } = fakeGateways({}, { already: true });
    const log: string[] = [];
    await kill(cfg, gw, (l) => log.push(l));
    expect(log[0]).toBe('kill SCP already on 222222222222');
  });

  it('still runs every other move when the attach fails, then throws so Lambda retries', async () => {
    const { gw, calls } = fakeGateways({
      attach: Object.assign(new Error('denied'), { name: 'AccessDeniedException' }),
    });
    await expect(kill(cfg, gw, () => {})).rejects.toThrow(
      /attach p-kill: AccessDeniedException: denied/,
    );
    expect(calls).toContain('concurrency aperture-finance-sync-dev 0');
    expect(calls).toContain('url aperture-mcp-dev AWS_IAM');
    expect(calls).toContain('distributions false');
  });

  it('throttles the URL functions even when the listing fails', async () => {
    const { gw, calls } = fakeGateways({ list: new Error('throttled') });
    await expect(kill(cfg, gw, () => {})).rejects.toThrow(/list functions: Error: throttled/);
    expect(calls.filter((c) => c.startsWith('concurrency'))).toEqual([
      'concurrency aperture-bff-dev 0',
      'concurrency aperture-mcp-dev 0',
    ]);
  });

  it('carries on past one failed function and names every failure', async () => {
    const { gw, calls } = fakeGateways({
      concurrency: { 'aperture-bff-dev': new Error('a') },
      url: { 'aperture-mcp-dev': new Error('b') },
      distributions: new Error('c'),
    });
    const err = await kill(cfg, gw, () => {}).catch((e: Error) => e);
    expect(String(err)).toMatch(
      /throttle aperture-bff-dev: Error: a; lock aperture-mcp-dev: Error: b; disable distributions: Error: c/,
    );
    expect(calls).toContain('concurrency aperture-mcp-dev 0');
    expect(calls).toContain('url aperture-bff-dev AWS_IAM');
  });
});

describe('restore', () => {
  it('reverses the throttle, the URL lock and the distributions — but never touches the SCP', async () => {
    const { gw, calls } = fakeGateways(
      {},
      { functions: ['aperture-bff-dev', 'aperture-finance-sync-dev'] },
    );
    await restore(cfg, gw, () => {});
    expect(calls).toEqual([
      'list',
      'concurrency aperture-bff-dev null',
      'concurrency aperture-mcp-dev null',
      'concurrency aperture-finance-sync-dev null',
      'url aperture-bff-dev NONE',
      'url aperture-mcp-dev NONE',
      'distributions true',
    ]);
  });
});

describe('isRestore', () => {
  it('is true only for a direct restore invoke, never for a trigger', () => {
    expect(isRestore({ action: 'restore' })).toBe(true);
    expect(isRestore({ action: 'restore', source: 'aws.cloudwatch' })).toBe(false); // EventBridge shape
    expect(isRestore({ action: 'restore', Records: [] })).toBe(false); // SNS shape
    expect(
      isRestore({ source: 'aws.cloudwatch', 'detail-type': 'CloudWatch Alarm State Change' }),
    ).toBe(false);
    expect(isRestore({ action: 'kill' })).toBe(false);
    expect(isRestore(null)).toBe(false);
    expect(isRestore('restore')).toBe(false);
  });
});

describe('isAlreadyAttached', () => {
  it('recognises only the duplicate-attachment error', () => {
    expect(
      isAlreadyAttached(
        Object.assign(new Error('x'), { name: 'DuplicatePolicyAttachmentException' }),
      ),
    ).toBe(true);
    expect(
      isAlreadyAttached(Object.assign(new Error('x'), { name: 'AccessDeniedException' })),
    ).toBe(false);
    expect(isAlreadyAttached('DuplicatePolicyAttachmentException')).toBe(false);
  });
});

describe('killConfigFrom', () => {
  const env = {
    KILL_POLICY_ID: 'p-1',
    DEV_ACCOUNT_ID: '222222222222',
    DEV_REGION: 'us-west-1',
    BREAK_GLASS_ROLE_ARN: 'arn:aws:iam::222222222222:role/OrganizationAccountAccessRole',
    URL_FUNCTIONS: 'a-dev, b-dev,',
  };

  it('reads the policy, the account, the region, the break-glass role and the URL functions', () => {
    expect(killConfigFrom(env)).toEqual({
      policyId: 'p-1',
      devAccountId: '222222222222',
      devRegion: 'us-west-1',
      breakGlassRoleArn: 'arn:aws:iam::222222222222:role/OrganizationAccountAccessRole',
      urlFunctions: ['a-dev', 'b-dev'],
    });
  });

  it('fails closed on any missing variable', () => {
    for (const k of Object.keys(env))
      expect(() => killConfigFrom({ ...env, [k]: ' ' })).toThrow(new RegExp(k));
    expect(() => killConfigFrom({ ...env, URL_FUNCTIONS: ',' })).toThrow(/URL_FUNCTIONS/);
  });
});

describe('setDistributionsEnabled', () => {
  function fakeCloudFront(
    pages: { id: string; enabled: boolean }[][],
    fail: Record<string, 'get' | 'none' | 'update'> = {},
  ) {
    const updates: { id: string; etag?: string; config: Record<string, unknown> }[] = [];
    const cf: CloudFrontLike = {
      async list(marker) {
        const i = marker ? Number(marker) : 0;
        return { items: pages[i] ?? [], ...(i + 1 < pages.length ? { next: String(i + 1) } : {}) };
      },
      async getConfig(id) {
        if (fail[id] === 'get') throw new Error('get failed');
        if (fail[id] === 'none') return { etag: 'e' };
        return { config: { Enabled: !updates.length, Comment: id }, etag: `etag-${id}` };
      },
      async update(id, etag, config) {
        if (fail[id] === 'update') throw new Error('PreconditionFailed');
        updates.push({ id, etag, config });
      },
    };
    return { cf, updates };
  }

  it('flips every distribution on every page that differs, with its own ETag and the rest of its config kept', async () => {
    const { cf, updates } = fakeCloudFront([
      [
        { id: 'A', enabled: true },
        { id: 'B', enabled: false },
      ],
      [{ id: 'C', enabled: true }],
    ]);
    expect(await setDistributionsEnabled(cf, false)).toEqual(['A', 'C']);
    expect(updates).toEqual([
      { id: 'A', etag: 'etag-A', config: { Enabled: false, Comment: 'A' } },
      { id: 'C', etag: 'etag-C', config: { Enabled: false, Comment: 'C' } },
    ]);
  });

  it('tries every distribution, then names each failure — a missing config is a failure, not a skip', async () => {
    const { cf, updates } = fakeCloudFront(
      [
        [
          { id: 'A', enabled: true },
          { id: 'B', enabled: true },
          { id: 'C', enabled: true },
          { id: 'D', enabled: true },
        ],
      ],
      {
        A: 'get',
        B: 'none',
        C: 'update',
      },
    );
    await expect(setDistributionsEnabled(cf, false)).rejects.toThrow(
      /A: Error: get failed; B: Error: no distribution config returned; C: Error: PreconditionFailed/,
    );
    expect(updates.map((u) => u.id)).toEqual(['D']);
  });
});
