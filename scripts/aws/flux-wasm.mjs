// Flux's tracking wasm goes to S3 brotli-encoded (docs/areas/flux D63): CloudFront compresses nothing over
// 10 MB, so the 13 MB file would otherwise cross the wire as-is on every device's first Start. The publish
// compresses it here and uploads with Content-Encoding: br plus the decoded size as x-amz-meta-raw-length,
// which the worker's progress bar counts to (modules/flux/engine/assets.ts). The health check asserts the
// edge serves exactly that. One module for both so scripts/src/flux-wasm.test.ts can pin the contract.
import { brotliCompressSync, constants } from 'node:zlib';

export const RAW_LENGTH_META = 'raw-length'; // S3 serves it as x-amz-meta-raw-length

// Quality 11 is the slow end (about 18 s for the wasm) and 20.6% of the size; it runs once per deploy.
export function brotliWasm(bytes) {
  const body = brotliCompressSync(bytes, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
    },
  });
  return { body, rawLength: bytes.byteLength };
}

// Throws unless the headers are the published wasm's: brotli-encoded, typed for Safari's streaming compile,
// and carrying a decoded size the progress bar can trust. `get` is a Headers-like lookup.
export function assertBrWasmHeaders(get) {
  const encoding = get('content-encoding') ?? '';
  if (encoding !== 'br') throw new Error(`content-encoding was "${encoding}", expected "br"`);
  const type = get('content-type') ?? '';
  if (!type.startsWith('application/wasm')) throw new Error(`content-type was "${type}"`);
  const raw = get(`x-amz-meta-${RAW_LENGTH_META}`) ?? '';
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`x-amz-meta-raw-length was "${raw}"`);
  return Number(raw);
}
