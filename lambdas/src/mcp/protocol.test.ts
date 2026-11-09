import { describe, expect, it } from 'vitest';
import { InMemoryDoc } from '../ddb/DocClient';
import { handleRpc } from '../handler';
import type { ApiMethod } from '@aperture/shared';
import { handleMcpMessage } from './protocol';
import type { ToolContext } from './types';

// A real dispatch over an in-memory table, so tool calls exercise the actual backend.
function makeCtx(): ToolContext {
  const doc = new InMemoryDoc();
  return {
    dispatch: (method: ApiMethod, args: unknown[]) =>
      handleRpc(doc, { userId: 'local', method, args, now: () => 1_700_000_000_000 }),
    upload: async () => {},
  };
}

const req = (method: string, params?: unknown, id: string | number | null = 1) => ({
  jsonrpc: '2.0' as const,
  id,
  method,
  ...(params !== undefined ? { params } : {}),
});

describe('handleMcpMessage', () => {
  it('initialize echoes a supported protocol version and advertises tools', async () => {
    const res = await handleMcpMessage(
      req('initialize', { protocolVersion: '2025-03-26' }),
      makeCtx(),
    );
    expect(res?.result).toMatchObject({
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'aperture' },
    });
  });

  it('initialize falls back to our version for an unknown one', async () => {
    const res = await handleMcpMessage(
      req('initialize', { protocolVersion: '1999-01-01' }),
      makeCtx(),
    );
    expect((res?.result as { protocolVersion: string }).protocolVersion).toBe('2025-06-18');
  });

  it('a notification (no id) yields no response', async () => {
    const res = await handleMcpMessage(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      makeCtx(),
    );
    expect(res).toBeNull();
  });

  it('ping returns an empty result', async () => {
    const res = await handleMcpMessage(req('ping'), makeCtx());
    expect(res).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  });

  it('rejects a batch (array) as an invalid request', async () => {
    const res = await handleMcpMessage([req('ping')], makeCtx());
    expect(res?.error?.code).toBe(-32600);
  });

  it('rejects a parsed non-object as invalid request (the edge handles unparseable JSON as -32700)', async () => {
    expect((await handleMcpMessage('nope', makeCtx()))?.error?.code).toBe(-32600);
    expect((await handleMcpMessage(5, makeCtx()))?.error?.code).toBe(-32600);
  });

  it('rejects a missing method / wrong jsonrpc as invalid request', async () => {
    expect((await handleMcpMessage({ jsonrpc: '2.0', id: 1 }, makeCtx()))?.error?.code).toBe(
      -32600,
    );
    expect(
      (await handleMcpMessage({ jsonrpc: '1.0', id: 1, method: 'ping' }, makeCtx()))?.error?.code,
    ).toBe(-32600);
  });

  it('unknown method → -32601', async () => {
    expect((await handleMcpMessage(req('does/not/exist'), makeCtx()))?.error?.code).toBe(-32601);
  });

  it('tools/list returns every tool as an object schema', async () => {
    const res = await handleMcpMessage(req('tools/list'), makeCtx());
    const tools = (res?.result as { tools: { name: string; inputSchema: { type: string } }[] })
      .tools;
    expect(tools.length).toBeGreaterThan(10);
    expect(tools.every((t) => t.inputSchema.type === 'object')).toBe(true);
    expect(tools.map((t) => t.name)).toContain('create_task');
  });

  it('tools/call runs a tool and returns text content', async () => {
    const res = await handleMcpMessage(
      req('tools/call', { name: 'create_task', arguments: { title: 'from mcp' } }),
      makeCtx(),
    );
    const result = res?.result as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text).title).toBe('from mcp');
  });

  it('tools/call with an unknown tool or bad args → -32602 (protocol error)', async () => {
    expect(
      (await handleMcpMessage(req('tools/call', { name: 'no_such_tool' }), makeCtx()))?.error?.code,
    ).toBe(-32602);
    expect(
      (await handleMcpMessage(req('tools/call', { name: 'create_task', arguments: {} }), makeCtx()))
        ?.error?.code,
    ).toBe(-32602); // title missing
  });

  it('a backend execution error surfaces as an isError result, not a protocol error', async () => {
    const res = await handleMcpMessage(
      req('tools/call', { name: 'complete_task', arguments: { id: 'nope', actualMin: 5 } }),
      makeCtx(),
    );
    const result = res?.result as { content: { text: string }[]; isError?: boolean };
    expect(res?.error).toBeUndefined();
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Not found/);
  });
});
