// Types for flux-wasm.mjs, so scripts/src/flux-wasm.test.ts imports it under `tsc -b` (scripts has no allowJs).
export const RAW_LENGTH_META: 'raw-length';
export function brotliWasm(bytes: Uint8Array): { body: Buffer; rawLength: number };
export function assertBrWasmHeaders(get: (name: string) => string | null | undefined): number;
