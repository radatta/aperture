import { afterEach, describe, expect, it, vi } from 'vitest';
import { mcpOp } from './mcp/protocol';

// The edges' meter wiring (ddb/meter.ts): each module reads STAGE at import, so each case re-imports it. Dev slots
// get a metered doc and one `ddb_units` line per request; prod and an unset STAGE get neither.
const made = vi.hoisted(() => [] as unknown[]);
vi.mock('./ddb/LiveDoc', async () => {
  const { InMemoryDoc } = await import('./ddb/DocClient');
  return { createLiveDoc: (_t: string, opts?: unknown) => (made.push(opts), new InMemoryDoc()) };
});

const unitsLines = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"ddb_units"'));

afterEach(() => {
  delete process.env.STAGE;
  made.length = 0;
  vi.restoreAllMocks();
  vi.resetModules();
});

// A stage with no auth env logs why at import and refuses HTTP (auth/strict.ts): expected here, so spied and checked.
const stageNoise = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);
const onlyAuthNoise = (spy: { mock: { calls: unknown[][] } }) => {
  for (const c of spy.mock.calls)
    expect(String(c[0])).toMatch(/"event":"(auth_misconfigured|origin_secret_unset)"/);
};

const health = { requestContext: { http: { method: 'GET', path: '/api/health' } } };
const mcpGet = { requestContext: { http: { method: 'GET', path: '/mcp' } } };

describe.each([
  ['devb', true],
  ['dev', true],
  ['prod', false],
  [undefined, false],
])('STAGE %s', (stage, on) => {
  it(`BFF: ${on ? 'metered, one line' : 'unmetered, no line'}`, async () => {
    if (stage) process.env.STAGE = stage;
    const log = vi.spyOn(console, 'log');
    const err = stageNoise();
    const { handler } = await import('./index');
    expect(made).toEqual([{ meter: on }]);
    const res = await handler(health);
    const lines = unitsLines(log);
    expect(lines).toHaveLength(on ? 1 : 0);
    onlyAuthNoise(err);
    if (on)
      expect(JSON.parse(lines[0]!)).toMatchObject({
        edge: 'bff',
        op: 'health',
        status: res.statusCode,
      });
  });

  it(`MCP: ${on ? 'metered, one line' : 'unmetered, no line'}`, async () => {
    if (stage) process.env.STAGE = stage;
    const log = vi.spyOn(console, 'log');
    const err = stageNoise();
    const { handler } = await import('./mcp/index');
    expect(made).toEqual([{ meter: on }]);
    const res = await handler(mcpGet);
    const lines = unitsLines(log);
    expect(lines).toHaveLength(on ? 1 : 0);
    onlyAuthNoise(err);
    if (on)
      expect(JSON.parse(lines[0]!)).toMatchObject({
        edge: 'mcp',
        op: 'get',
        status: res.statusCode,
      });
  });
});

describe('mcpOp', () => {
  const post = (body: unknown, b64 = false) => {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      requestContext: { http: { method: 'POST' } },
      body: b64 ? Buffer.from(raw).toString('base64') : raw,
      isBase64Encoded: b64,
    };
  };
  it('labels known methods and known tools only', () => {
    expect(mcpOp(post({ jsonrpc: '2.0', id: 1, method: 'initialize' }))).toBe('initialize');
    expect(mcpOp(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).toBe('tools/list');
    expect(
      mcpOp(
        post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tasks' } }, true),
      ),
    ).toBe('tools/call:list_tasks');
    expect(
      mcpOp(post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'secret text' } })),
    ).toBe('tools/call:unknown');
    expect(mcpOp(post({ jsonrpc: '2.0', id: 1, method: 'my secret method' }))).toBe('unknown');
    expect(mcpOp(post([{ method: 'ping' }]))).toBe('unknown');
    expect(mcpOp(post('{nope'))).toBe('unparsed');
    expect(mcpOp({ requestContext: { http: { method: 'DELETE' } } })).toBe('unknown');
    expect(mcpOp({ requestContext: { http: { method: 'HEAD' } } })).toBe('head');
  });
});
