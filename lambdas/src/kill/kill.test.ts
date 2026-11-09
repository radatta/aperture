import { describe, expect, it } from 'vitest';
import {
  isAlreadyAttached,
  isRestore,
  kill,
  killConfigFrom,
  reservationsFrom,
  restore,
  runKillSwitch,
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
const reservations = {
  'aperture-bff-dev': 18,
  'aperture-mcp-dev': 10,
  'aperture-finance-sync-dev': 1,
};
const notFound = () =>
  Object.assign(new Error('Function not found'), { name: 'ResourceNotFoundException' });

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
          'ApertureCicdDev-CustomAWSCDKOpenIdConnectProv-AbC123',
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
      'concurrency ApertureCicdDev-CustomAWSCDKOpenIdConnectProv-AbC123 0',
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
  it('puts each function’s own reservation back, unlocks the URLs and the distributions — never the SCP', async () => {
    const { gw, calls } = fakeGateways(
      {},
      { functions: ['aperture-bff-dev', 'aperture-finance-sync-dev'] },
    );
    await restore(cfg, reservations, gw, () => {});
    expect(calls).toEqual([
      'list',
      'concurrency aperture-bff-dev 18',
      'concurrency aperture-mcp-dev 10',
      'concurrency aperture-finance-sync-dev 1',
      'url aperture-bff-dev NONE',
      'url aperture-mcp-dev NONE',
      'distributions true',
    ]);
  });

  // The dev account holds CDK provider functions no template reserves (ApertureCicdDev's OIDC provider); a kill sets
  // them to 0 like everything else, and a restore must hand them back, not fail on them.
  it('gives a CDK provider function back its unreserved state, and succeeds', async () => {
    const { gw, calls } = fakeGateways(
      {},
      { functions: ['aperture-bff-dev', 'ApertureCicdDev-AWSCDKOpenIdConnectProvider'] },
    );
    const lines: string[] = [];
    await restore(cfg, reservations, gw, (l) => lines.push(l));
    expect(calls).toContain('concurrency ApertureCicdDev-AWSCDKOpenIdConnectProvider null');
    expect(calls).toContain('concurrency aperture-bff-dev 18');
    expect(lines).toContain(
      'ApertureCicdDev-AWSCDKOpenIdConnectProvider → reservation removed (a CDK provider)',
    );
  });
});

describe('restore with an app function off the record', () => {
  it('leaves it at 0 and names it, and still restores everything else', async () => {
    const { gw, calls } = fakeGateways({}, { functions: ['aperture-bff-dev', 'aperture-new-dev'] });
    await expect(restore(cfg, reservations, gw, () => {})).rejects.toThrow(
      /unthrottle aperture-new-dev: .*no reservation on record, left at 0/,
    );
    expect(calls.filter((c) => c.startsWith('concurrency aperture-new-dev'))).toEqual([]);
    expect(calls).toContain('concurrency aperture-bff-dev 18');
    expect(calls).toContain('concurrency aperture-mcp-dev 10');
    expect(calls).toContain('url aperture-mcp-dev NONE');
    expect(calls).toContain('distributions true');
  });

  // Only CloudFormation's own provider names (`Aperture…` stacks) go back unreserved: anything else a branch might
  // have created while the freeze was open stays at 0 rather than coming back uncapped.
  it('leaves any other unlisted function at 0 too, named', async () => {
    const others = ['evil', 'ApertureApp-dev-Sneaky-ABC123'];
    const { gw, calls } = fakeGateways({}, { functions: ['aperture-bff-dev', ...others] });
    const err = await restore(cfg, reservations, gw, () => {}).catch((e: Error) => e);
    for (const fn of others) {
      expect(String(err)).toMatch(new RegExp(`unthrottle ${fn}: .*left at 0`));
      expect(calls.filter((c) => c.startsWith(`concurrency ${fn}`))).toEqual([]);
    }
  });

  it('never removes an app function’s reservation', async () => {
    const { gw, calls } = fakeGateways({}, { functions: ['aperture-bff-dev', 'aperture-new-dev'] });
    await restore(cfg, reservations, gw, () => {}).catch(() => {});
    for (const c of calls.filter((c) => c.startsWith('concurrency aperture-')))
      expect(c).toMatch(/ \d+$/);
  });
});

describe('a function that doesn’t exist', () => {
  // A URL function a slot hasn't deployed yet, or one deleted since the listing: it can't run or be reached.
  it('is logged and skipped by the kill and the restore, never a failure', async () => {
    const fail = {
      concurrency: { 'aperture-mcp-dev': notFound() },
      url: { 'aperture-mcp-dev': notFound() },
    };
    const lines: string[] = [];
    await kill(cfg, fakeGateways(fail).gw, (l) => lines.push(l));
    await restore(cfg, reservations, fakeGateways(fail).gw, (l) => lines.push(l));
    expect(lines).toContain('throttle aperture-mcp-dev: no such function, skipped');
    expect(lines).toContain('lock aperture-mcp-dev: no such function, skipped');
    expect(lines).toContain('unlock aperture-mcp-dev: no such function, skipped');
  });

  // Every URL function missing means a region or a name drifted: a kill that reached nothing must fail loudly.
  it('fails the kill and the restore when none of the URL functions exists', async () => {
    const fail = {
      concurrency: { 'aperture-bff-dev': notFound(), 'aperture-mcp-dev': notFound() },
      url: { 'aperture-bff-dev': notFound(), 'aperture-mcp-dev': notFound() },
    };
    const opts = { functions: [] };
    await expect(kill(cfg, fakeGateways(fail, opts).gw, () => {})).rejects.toThrow(
      /lock: none of aperture-bff-dev, aperture-mcp-dev has a function or URL in us-west-1/,
    );
    await expect(restore(cfg, reservations, fakeGateways(fail, opts).gw, () => {})).rejects.toThrow(
      /unlock: none of/,
    );
  });

  it('still fails on any other error', async () => {
    const { gw } = fakeGateways({
      concurrency: {
        'aperture-mcp-dev': Object.assign(new Error('x'), { name: 'AccessDeniedException' }),
      },
    });
    await expect(kill(cfg, gw, () => {})).rejects.toThrow(
      /throttle aperture-mcp-dev: AccessDeniedException/,
    );
  });
});

describe('runKillSwitch', () => {
  const env = {
    KILL_POLICY_ID: 'p-kill',
    DEV_ACCOUNT_ID: '222222222222',
    DEV_REGION: 'us-west-1',
    BREAK_GLASS_ROLE_ARN: 'arn:aws:iam::222222222222:role/OrganizationAccountAccessRole',
    URL_FUNCTIONS: 'aperture-bff-dev,aperture-mcp-dev',
    RESERVED_CONCURRENCY: 'garbage',
  };
  const alarm = { source: 'aws.cloudwatch', 'detail-type': 'CloudWatch Alarm State Change' };

  it('kills on a trigger even when the restore’s table is unreadable', async () => {
    const { gw, calls } = fakeGateways();
    await runKillSwitch(
      alarm,
      env,
      () => gw,
      () => {},
    );
    expect(calls).toContain('attach p-kill 222222222222');
    expect(calls).toContain('concurrency aperture-bff-dev 0');
  });

  it('refuses a restore with an unreadable table before touching anything', async () => {
    const { gw, calls } = fakeGateways();
    await expect(
      runKillSwitch(
        { action: 'restore' },
        env,
        () => gw,
        () => {},
      ),
    ).rejects.toThrow(/RESERVED_CONCURRENCY entry "garbage"/);
    expect(calls).toEqual([]);
  });

  it('fails closed on a missing variable before building any gateway', async () => {
    let built = false;
    const partial: Record<string, string | undefined> = { ...env, KILL_POLICY_ID: undefined };
    await expect(
      runKillSwitch(
        alarm,
        partial,
        () => ((built = true), fakeGateways().gw),
        () => {},
      ),
    ).rejects.toThrow(/KILL_POLICY_ID/);
    expect(built).toBe(false);
  });

  it('restores with a good table', async () => {
    const { gw, calls } = fakeGateways({}, { functions: [] });
    const good = { ...env, RESERVED_CONCURRENCY: 'aperture-bff-dev=18,aperture-mcp-dev=10' };
    await runKillSwitch(
      { action: 'restore' },
      good,
      () => gw,
      () => {},
    );
    expect(calls).toContain('concurrency aperture-bff-dev 18');
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

  it('never needs the restore’s table, so a bad one can’t stop a kill', () => {
    expect(() => killConfigFrom({ ...env, RESERVED_CONCURRENCY: 'garbage' })).not.toThrow();
  });
});

describe('reservationsFrom', () => {
  const urls = ['a-dev', 'b-dev'];
  it('reads each function’s reservation', () => {
    expect(reservationsFrom({ RESERVED_CONCURRENCY: 'a-dev=18, b-dev=10,c-dev=1,' }, urls)).toEqual(
      { 'a-dev': 18, 'b-dev': 10, 'c-dev': 1 },
    );
  });

  it('fails closed on a missing table, a bad entry, a repeat, or a URL function without one', () => {
    expect(() => reservationsFrom({ RESERVED_CONCURRENCY: ' ' }, urls)).toThrow(/is not set/);
    for (const bad of [
      'a-dev=18,b-dev=0',
      'a-dev=18,b-dev=1.5',
      'a-dev=18,b-dev=',
      'a-dev=18,=3',
      'a-dev=18,b-dev',
      'a-dev=18,b-dev=1=2',
    ])
      expect(() => reservationsFrom({ RESERVED_CONCURRENCY: bad }, urls)).toThrow(
        /RESERVED_CONCURRENCY entry/,
      );
    expect(() =>
      reservationsFrom({ RESERVED_CONCURRENCY: 'a-dev=18,b-dev=10,a-dev=2' }, urls),
    ).toThrow(/names a-dev twice/);
    expect(() => reservationsFrom({ RESERVED_CONCURRENCY: 'a-dev=18' }, urls)).toThrow(
      /no entry for b-dev/,
    );
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
