import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stageSecret } from './ciSecrets';

// Every call gets its own env and dir: the cdk vitest config shares one worker (isolate: false), so process.env and
// the real cdk/.secrets/ are never touched.
const dirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'aperture-ci-secrets-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('stageSecret', () => {
  it('uses the CI env var, trimmed', () => {
    const env = { APERTURE_AGENT_TOKEN: '  abc123\n', GITHUB_ACTIONS: 'true' };
    expect(stageSecret('AGENT_TOKEN', 'prod', { env, dir: tmp() })).toBe('abc123');
  });

  it('in CI, an empty secret fails the synth naming the GitHub secret to set, never a fresh token', () => {
    const dir = tmp();
    expect(() => stageSecret('AGENT_TOKEN', 'prod', { env: { GITHUB_ACTIONS: 'true' }, dir })).toThrow(
      'APERTURE_AGENT_TOKEN is empty in CI — set AGENT_TOKEN_PROD (a secret in the prod GitHub environment)',
    );
    expect(() =>
      stageSecret('DEVICE_TOKEN', 'dev', { env: { GITHUB_ACTIONS: 'true', APERTURE_DEVICE_TOKEN: '   ' }, dir }),
    ).toThrow('APERTURE_DEVICE_TOKEN is empty in CI — set DEVICE_TOKEN_DEV (a repository secret)');
    expect(readdirSync(dir)).toEqual([]); // nothing minted on the way out
  });

  it('outside CI, generates a file once per stage and kind, and reuses it', () => {
    const dir = tmp();
    const first = stageSecret('ORIGIN_SECRET', 'dev', { env: {}, dir });
    expect(first).toMatch(/^[0-9a-f]{48}$/);
    expect(stageSecret('ORIGIN_SECRET', 'dev', { env: {}, dir })).toBe(first);
    expect(readFileSync(join(dir, 'origin-secret.dev'), 'utf8')).toBe(`${first}\n`);
    expect(stageSecret('ORIGIN_SECRET', 'prod', { env: {}, dir })).not.toBe(first);
    expect(stageSecret('DEVICE_TOKEN', 'dev', { env: {}, dir })).not.toBe(first);
    expect(readdirSync(dir).sort()).toEqual(['device-token.dev', 'origin-secret.dev', 'origin-secret.prod']);
  });

  it('outside CI, an existing file wins over nothing, trimmed; the env var wins over the file', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'device-token.prod'), 'fromfile\n');
    expect(stageSecret('DEVICE_TOKEN', 'prod', { env: {}, dir })).toBe('fromfile');
    expect(stageSecret('DEVICE_TOKEN', 'prod', { env: { APERTURE_DEVICE_TOKEN: 'fromenv' }, dir })).toBe('fromenv');
  });
});
