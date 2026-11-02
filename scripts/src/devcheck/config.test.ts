import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_CALLBACK,
  DEV_ORIGIN,
  TEST_USER_EMAIL,
  ENV_KEYS,
  assertDevCognitoUrl,
  assertDevOrigin,
  assertPresignedDevUrl,
  isClaudeHost,
  loadEnv,
  parseEnv,
} from './config';

const GOOD = [
  `DEVCHECK_EMAIL=${TEST_USER_EMAIL}`,
  'DEVCHECK_PASSWORD=pa=ss',
  'DEVCHECK_SUB=sub-1',
  'DEVCHECK_COGNITO_HOST=host.example',
  'DEVCHECK_CLIENT_ID=client',
  'DEVCHECK_POOL_ID=us-west-1_X',
  'DEVCHECK_CLAUDE_CLIENT_ID=claude-client',
].join('\n');

describe('assertPresignedDevUrl', () => {
  const host = 'aperturedata-dev-files8e6940b8-1a2b3c4d5e6f.s3.us-west-1.amazonaws.com';
  const signed = 'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc123';
  it('allows a signed URL on the dev Files bucket under u/', () => {
    expect(() => assertPresignedDevUrl(`https://${host}/u/sub-1/t1/a1?${signed}`)).not.toThrow();
  });
  it.each([
    `https://aperturedata-prod-files8e6940b8-1a2b3c4d5e6f.s3.us-west-1.amazonaws.com/u/s/t/a?${signed}`, // prod
    `https://apertureapp-dev-site1234.s3.us-west-1.amazonaws.com/u/s/t/a?${signed}`, // another dev bucket
    `https://${host}.evil.com/u/s/t/a?${signed}`,
    `https://${host.replace('us-west-1', 'us-east-1')}/u/s/t/a?${signed}`,
    `http://${host}/u/s/t/a?${signed}`, // wrong scheme
    `https://${host}:8443/u/s/t/a?${signed}`,
    `https://${host}/index.html?${signed}`, // outside u/
    `https://${host}/u/s/t/a?X-Amz-Algorithm=AWS4-HMAC-SHA256`, // unsigned
    'not a url',
  ])('refuses %s', (url) => {
    expect(() => assertPresignedDevUrl(url)).toThrow(/refusing/);
  });
});

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

describe('MCP sign-in guards', () => {
  const HOST = 'aperture-dev-618015769091.auth.us-west-1.amazoncognito.com';

  it('parseEnv names DEVCHECK_CLAUDE_CLIENT_ID among the missing keys', () => {
    expect(ENV_KEYS).toContain('DEVCHECK_CLAUDE_CLIENT_ID');
    expect(() => parseEnv(GOOD.replace(/^DEVCHECK_CLAUDE_CLIENT_ID=.*$/m, ''))).toThrow(
      /ENV_MISSING: missing DEVCHECK_CLAUDE_CLIENT_ID/,
    );
  });

  it('assertDevCognitoUrl allows only the env host on the dev pool’s Hosted UI, at the named path', () => {
    expect(() =>
      assertDevCognitoUrl(`https://${HOST}/oauth2/token`, HOST, '/oauth2/token'),
    ).not.toThrow();
    const prod = 'aperture-prod-123456789012.auth.us-west-1.amazoncognito.com';
    for (const [url, host] of [
      [`https://${prod}/oauth2/token`, prod], // a prod-shaped pool, even when the env names it
      [`http://${HOST}/oauth2/token`, HOST],
      [`https://${HOST}/oauth2/authorize`, HOST], // another path
      [`https://${HOST}:8443/oauth2/token`, HOST],
      [`https://${HOST}/oauth2/token`, 'other.example'], // not the env's host
    ])
      expect(() => assertDevCognitoUrl(url!, host!, '/oauth2/token')).toThrow(/refusing/);
  });

  it('the callback is one cdk registers on the claude client', () => {
    const cdk = readFileSync(
      new URL('../../../cdk/src/config/claudeConnector.ts', import.meta.url),
      'utf8',
    );
    expect(cdk).toContain(`'${CLAUDE_CALLBACK}'`);
  });

  it('isClaudeHost covers both hosts and their subdomains, not look-alikes', () => {
    for (const h of ['claude.ai', 'CLAUDE.AI', 'www.claude.ai', 'claude.com', 'api.claude.com'])
      expect(isClaudeHost(h)).toBe(true);
    for (const h of ['notclaude.ai', 'claude.ai.evil.com', 'claude.app', DEV_ORIGIN.slice(8)])
      expect(isClaudeHost(h)).toBe(false);
  });
});
