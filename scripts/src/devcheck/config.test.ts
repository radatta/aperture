import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEV_ORIGIN, TEST_USER_EMAIL, assertDevOrigin, loadEnv, parseEnv } from './config';

const GOOD = [
  `DEVCHECK_EMAIL=${TEST_USER_EMAIL}`,
  'DEVCHECK_PASSWORD=pa=ss',
  'DEVCHECK_SUB=sub-1',
  'DEVCHECK_COGNITO_HOST=host.example',
  'DEVCHECK_CLIENT_ID=client',
  'DEVCHECK_POOL_ID=us-west-1_X',
].join('\n');

describe('assertDevOrigin', () => {
  it('allows the dev origin, any path', () => {
    expect(() => assertDevOrigin(`${DEV_ORIGIN}/api/listTasks`)).not.toThrow();
  });
  it.each([
    'http://dev.aperture.rahuldatta.dev/api/x', // wrong scheme
    'https://aperture.rahuldatta.dev/api/x', // prod
    'https://dev.aperture.rahuldatta.dev.evil.com/api/x',
    'https://dev.aperture.rahuldatta.dev:8443/api/x',
    'not a url',
  ])('refuses %s', (url) => {
    expect(() => assertDevOrigin(url)).toThrow(/refusing/);
  });
});

describe('parseEnv', () => {
  it('reads every key, keeps "=" inside a value, skips comments', () => {
    const env = parseEnv(`# test user\n\n${GOOD}\n`);
    expect(env.DEVCHECK_PASSWORD).toBe('pa=ss');
    expect(env.DEVCHECK_POOL_ID).toBe('us-west-1_X');
  });
  it('names the missing keys', () => {
    expect(() => parseEnv(GOOD.replace(/DEVCHECK_SUB=.*\n/, ''))).toThrow(
      /ENV_MISSING: missing DEVCHECK_SUB/,
    );
  });
  it('refuses an env file for another user', () => {
    expect(() => parseEnv(GOOD.replace(TEST_USER_EMAIL, 'someone@example.com'))).toThrow(
      /WRONG_USER/,
    );
  });
});

describe('loadEnv', () => {
  it('fails ENV_MISSING when the file is absent', () => {
    expect(() => loadEnv('/nonexistent/devcheck.dev.env')).toThrow(/ENV_MISSING/);
  });
  it('warns when the file is readable by others', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'devcheck-')), 'env');
    writeFileSync(path, GOOD, { mode: 0o644 });
    const warn = vi.fn();
    loadEnv(path, warn);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/chmod 600/));
  });
});
