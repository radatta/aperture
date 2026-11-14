import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEVB_ORIGIN,
  DEV_ORIGIN,
  SLOTS,
  assertDevCognitoUrl,
  assertDevOrigin,
  assertPresignedDevUrl,
  currentSlot,
  envPath,
  ledgerFile,
  mcpScopes,
  runLockFile,
  slotOrigin,
  statePath,
  targetOrigin,
  useSlot,
} from './config';

// Module state: each test starts on slot A and goes back to it.
afterEach(() => useSlot('dev'));

const signed = 'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc123';
const devFiles = 'aperturedata-dev-files8e6940b8-1a2b3c4d5e6f.s3.us-west-1.amazonaws.com';
const devbFiles = 'aperturedata-devb-files8e6940b8-1a2b3c4d5e6f.s3.us-west-1.amazonaws.com';
const devPool = 'aperture-dev-618015769091.auth.us-west-1.amazoncognito.com';
const devbPool = 'aperture-devb-618015769091.auth.us-west-1.amazoncognito.com';

describe('dev slots', () => {
  it('keeps its slot list in step with the shared one', () => {
    const src = readFileSync(
      new URL('../../../packages/shared/src/stage.ts', import.meta.url),
      'utf8',
    );
    expect([...SLOTS]).toEqual(
      JSON.parse((/DEV_SLOTS = (\[[^\]]*\])/.exec(src)?.[1] ?? '[]').replace(/'/g, '"')),
    );
  });

  it('starts on slot A with its v1 file names', () => {
    expect(currentSlot()).toBe('dev');
    expect(targetOrigin()).toBe(DEV_ORIGIN);
    expect(envPath('/m')).toBe('/m/.secrets/devcheck.dev.env');
    expect(statePath('/m')).toBe('/m/.secrets/devcheck.dev.state.json');
    expect(ledgerFile()).toBe('ledger.dev.jsonl');
    expect(runLockFile()).toBe('run.lock');
  });

  it("on devb, every guard moves to devb's addresses and refuses slot A's", () => {
    useSlot('devb');
    expect(slotOrigin()).toBe(DEVB_ORIGIN);
    expect(() => assertDevOrigin(`${DEVB_ORIGIN}/api/listTasks`)).not.toThrow();
    expect(() => assertDevOrigin(`${DEV_ORIGIN}/api/listTasks`)).toThrow(/refusing/);
    expect(() => assertPresignedDevUrl(`https://${devbFiles}/u/s/t/a?${signed}`)).not.toThrow();
    expect(() => assertPresignedDevUrl(`https://${devFiles}/u/s/t/a?${signed}`)).toThrow(
      /not the devb Files bucket/,
    );
    expect(() =>
      assertDevCognitoUrl(`https://${devbPool}/oauth2/token`, devbPool, '/oauth2/token'),
    ).not.toThrow();
    expect(() =>
      assertDevCognitoUrl(`https://${devPool}/oauth2/token`, devPool, '/oauth2/token'),
    ).toThrow(/not the devb pool/);
    expect(mcpScopes()).toEqual(['openid', 'email', `${DEVB_ORIGIN}/mcp/access`]);
  });

  it('on slot A, refuses devb', () => {
    expect(() => assertDevOrigin(`${DEVB_ORIGIN}/api/x`)).toThrow(/refusing/);
    expect(() => assertPresignedDevUrl(`https://${devbFiles}/u/s/t/a?${signed}`)).toThrow();
    expect(() =>
      assertDevCognitoUrl(`https://${devbPool}/oauth2/token`, devbPool, '/oauth2/token'),
    ).toThrow();
    expect(mcpScopes()).toEqual(['openid', 'email', `${DEV_ORIGIN}/mcp/access`]);
  });

  it('keeps per-slot files apart, the run lock included, so the two slots’ runs may overlap', () => {
    useSlot('devb');
    expect(envPath('/m')).toBe('/m/.secrets/devcheck.devb.env');
    expect(statePath('/m')).toBe('/m/.secrets/devcheck.devb.state.json');
    expect(ledgerFile()).toBe('ledger.devb.jsonl');
    expect(runLockFile()).toBe('run.devb.lock');
    expect(runLockFile('dev')).toBe('run.lock');
  });

  it('accepts only a known slot', () => {
    expect(() => useSlot('prod' as never)).toThrow(/refusing slot prod/);
    expect(currentSlot()).toBe('dev');
  });
});
