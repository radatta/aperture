import { describe, expect, it } from 'vitest';
import { bffOp, indexKind, metered, record, skKind, unitsLine, wrapIfDev } from './meter';
import type { UnitsLine } from './meter';
import { gsi1, pushSk, sk } from './keys';

const run = (lines: string[], clock = { t: 1000 }) =>
  metered(
    'bff',
    () => 'listTasks',
    async (e: { units: number[]; wait?: number; boom?: boolean }) => {
      for (const u of e.units) {
        if (e.wait) await new Promise((r) => setTimeout(r, e.wait));
        record({ verb: 'q', kind: 'task', units: u, consistent: true, items: 2, dead: 1 });
      }
      if (e.boom) throw new Error('boom');
      return { statusCode: 200 };
    },
    { log: (l) => lines.push(l), now: () => (clock.t += 5) },
  );
const parse = (l: string) => JSON.parse(l) as UnitsLine;

describe('metered', () => {
  it('keeps interleaved requests apart: each line carries only its own units', async () => {
    const lines: string[] = [];
    const h = run(lines);
    await Promise.all([
      h({ units: [1, 2], wait: 3 }),
      h({ units: [10, 20, 30], wait: 1 }),
      h({ units: [100], wait: 2 }),
    ]);
    expect(lines).toHaveLength(3);
    expect(
      lines
        .map(parse)
        .map((l) => l.ru)
        .sort((a, b) => a - b),
    ).toEqual([3, 60, 100]);
    expect(
      lines
        .map(parse)
        .map((l) => l.n)
        .sort(),
    ).toEqual([1, 2, 3]);
  });

  it('a record outside any request is a no-op', async () => {
    record({ verb: 'q', kind: 'task', units: 999 });
    const lines: string[] = [];
    await run(lines)({ units: [1] });
    expect(parse(lines[0]!).ru).toBe(1);
  });

  it('logs the line on a throw too, and the error still propagates', async () => {
    const lines: string[] = [];
    await expect(run(lines)({ units: [4], boom: true })).rejects.toThrow('boom');
    expect(parse(lines[0]!)).toMatchObject({ status: 'threw', ru: 4, op: 'listTasks' });
  });

  it('writes exactly the allowed keys, with the op, timing and per-access entries', async () => {
    const lines: string[] = [];
    await run(lines)({ units: [0.5, 1.5] });
    expect(lines).toHaveLength(1);
    expect(parse(lines[0]!)).toEqual({
      event: 'ddb_units',
      v: 1,
      edge: 'bff',
      op: 'listTasks',
      status: 200,
      at: 1005,
      ms: 5,
      ru: 2,
      wu: 0,
      n: 2,
      by: [['qc:task', 2, 2, 4, 2]],
    });
  });

  it('logs a zero-unit request too, and a label that throws reads unknown', async () => {
    const lines: string[] = [];
    const h = metered(
      'mcp',
      () => {
        throw new Error('bad body');
      },
      async () => ({ statusCode: 202 }),
      { log: (l) => lines.push(l) },
    );
    await h({});
    expect(parse(lines[0]!)).toMatchObject({
      edge: 'mcp',
      op: 'unknown',
      status: 202,
      ru: 0,
      n: 0,
      by: [],
    });
  });
});

describe('unitsLine', () => {
  it('keeps the top 8 accesses by units and sums the rest as other', () => {
    const by = new Map<string, [number, number, number, number]>();
    for (let i = 0; i < 11; i++) by.set(`q:k${String.fromCharCode(97 + i)}`, [1, i + 1, i, 0]);
    const l = unitsLine('bff', 'getDay', 200, 0, 1, { ru: 66, wu: 0, n: 11, by });
    expect(l.by).toHaveLength(9);
    expect(l.by[0]).toEqual(['q:kk', 1, 11, 10, 0]);
    expect(l.by[8]).toEqual(['other', 3, 1 + 2 + 3, 0 + 1 + 2, 0]);
  });

  it('splits read and write units by verb', async () => {
    const lines: string[] = [];
    await metered(
      'bff',
      () => 'x',
      async () => {
        record({ verb: 'g', kind: 'settings', units: 0.5 });
        record({ verb: 'p', kind: 'task', units: 2 });
        record({ verb: 'x', kind: 'done', units: 1 });
        record({ verb: 'b', kind: 'log', units: 3 });
        return { statusCode: 200 };
      },
      { log: (l) => lines.push(l) },
    )({});
    expect(parse(lines[0]!)).toMatchObject({ ru: 1.5, wu: 5, n: 4 });
  });
});

describe('wrapIfDev', () => {
  const h = async (_e: object) => ({ statusCode: 200 });
  it('returns the same function off the dev slots: prod, unset, unknown', () => {
    for (const stage of ['prod', undefined, '', 'devc', 'DEV'])
      expect(wrapIfDev(stage, 'bff', () => 'x', h)).toBe(h);
  });
  it('wraps dev and devb, one line per request', async () => {
    for (const stage of ['dev', 'devb']) {
      const lines: string[] = [];
      const w = wrapIfDev(stage, 'bff', () => 'x', h, { log: (l) => lines.push(l) });
      expect(w).not.toBe(h);
      await w({});
      await w({});
      expect(lines).toHaveLength(2);
    }
  });
});

describe('kinds never carry an id', () => {
  // Letters only, so an id-first builder WOULD read as a kind — the case this pins against.
  const ID = 'zqsentinelzq';
  it('skKind over every sort-key builder', () => {
    const kinds = new Set<string>();
    for (const [name, fn] of [...Object.entries(sk), ...Object.entries(pushSk)]) {
      const f = fn as (...a: unknown[]) => string;
      const kind = skKind(f(...Array.from({ length: f.length }, () => ID)));
      expect(kind, name).not.toContain(ID);
      expect(kind, name).toMatch(/^[a-z]{2,16}$/);
      kinds.add(kind);
    }
    // Pinned, so a new key shape is a deliberate change here (and an id-first one reads `other` or fails above).
    expect([...kinds].sort()).toMatchSnapshot();
  });
  it('an id-first or odd key reads other', () => {
    expect(skKind('3f2a-11')).toBe('other');
    expect(skKind('a#x')).toBe('other');
    expect(skKind('Task#x')).toBe('other');
    expect(skKind('')).toBe('other');
  });
  it('indexKind over the GSI builders', () => {
    const pks = [gsi1.donePk, gsi1.remindPk, gsi1.finTxnPk];
    expect(pks.map((f) => indexKind(f(ID)))).toEqual(['done', 'remind', 'fintxn']);
    expect(indexKind(`u#${ID}`)).toBe(ID);
    expect(indexKind('u#3f2a-11')).toBe('other');
  });
});

describe('bffOp', () => {
  const ev = (path: string, method = 'POST') => ({
    rawPath: path,
    requestContext: { http: { method, path } },
  });
  it('labels an API method, the fixed routes, and nothing else', () => {
    expect(bffOp(ev('/api/listTasks'))).toBe('listTasks');
    expect(bffOp(ev('/api/health', 'GET'))).toBe('health');
    expect(bffOp(ev('/api/google/callback', 'GET'))).toBe('google');
    expect(bffOp(ev('/api/places/my-slug/tasks', 'GET'))).toBe('places');
    expect(bffOp(ev('/api/capture'))).toBe('capture');
    expect(bffOp(ev('/api/listTasks', 'OPTIONS'))).toBe('options');
    expect(bffOp(ev('/api/secret-text-here'))).toBe('unknown');
    expect(bffOp(ev('/elsewhere'))).toBe('unknown');
    expect(bffOp({})).toBe('unknown');
  });
});
