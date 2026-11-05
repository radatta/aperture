import { brotliDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { assertBrWasmHeaders, brotliWasm } from '../aws/flux-wasm.mjs';

// The publish's brotli step and the health check's assertion, pinned together: what goes up is what the
// edge must answer (docs/areas/flux D63).
describe('brotliWasm', () => {
  it('round-trips, and reports the decoded size for x-amz-meta-raw-length', () => {
    const wasm = new Uint8Array(50_000);
    for (let i = 0; i < wasm.length; i++) wasm[i] = (i * 7) % 13; // compressible, not constant
    const { body, rawLength } = brotliWasm(wasm);
    expect(rawLength).toBe(50_000);
    expect(body.byteLength).toBeLessThan(wasm.byteLength / 4);
    expect(new Uint8Array(brotliDecompressSync(body))).toEqual(wasm);
  });
});

describe('assertBrWasmHeaders', () => {
  const headers = (over: Record<string, string | undefined> = {}) => {
    const h: Record<string, string | undefined> = {
      'content-encoding': 'br',
      'content-type': 'application/wasm',
      'x-amz-meta-raw-length': '12997272',
      ...over,
    };
    return (name: string) => h[name] ?? null;
  };

  it('accepts the published wasm and returns its decoded size', () => {
    expect(assertBrWasmHeaders(headers())).toBe(12_997_272);
  });

  it('refuses an uncompressed body (an edge still holding an old copy, or a publish that skipped the step)', () => {
    expect(() => assertBrWasmHeaders(headers({ 'content-encoding': undefined }))).toThrow(
      /content-encoding was ""/,
    );
    expect(() => assertBrWasmHeaders(headers({ 'content-encoding': 'gzip' }))).toThrow(/"gzip"/);
  });

  it('refuses a guessed type (Safari refuses to compile it) and a missing or non-numeric raw length', () => {
    expect(() =>
      assertBrWasmHeaders(headers({ 'content-type': 'application/octet-stream' })),
    ).toThrow(/content-type/);
    expect(() => assertBrWasmHeaders(headers({ 'x-amz-meta-raw-length': undefined }))).toThrow(
      /raw-length was ""/,
    );
    expect(() => assertBrWasmHeaders(headers({ 'x-amz-meta-raw-length': '0' }))).toThrow(
      /raw-length/,
    );
    expect(() => assertBrWasmHeaders(headers({ 'x-amz-meta-raw-length': '12e6' }))).toThrow(
      /raw-length/,
    );
  });
});
