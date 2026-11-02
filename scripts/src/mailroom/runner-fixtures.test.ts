// The Mac runner's own suite (bash + jq, curl/security stubbed) as part of `pnpm test`, plus static checks on
// what the runner may touch: the token's one source and the four fixed GitHub calls. docs/ops/MAILROOM.md.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOOLS_DIR } from './fixtures.ts';

const runnerText = () =>
  [
    readFileSync(`${TOOLS_DIR}runner.sh`, 'utf8'),
    ...readdirSync(`${TOOLS_DIR}jobs`)
      .filter((n) => n.endsWith('.sh'))
      .map((n) => readFileSync(`${TOOLS_DIR}jobs/${n}`, 'utf8')),
  ].join('\n');
// Code only: drop comment lines so a sentence about a forbidden thing doesn't count as doing it.
const code = () =>
  runnerText()
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

describe('mailroom runner', () => {
  it('passes its fixture suite', { timeout: 180_000 }, () => {
    let out: string;
    try {
      out = execFileSync('bash', [`${TOOLS_DIR}run-fixtures.sh`], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      throw new Error(`run-fixtures.sh failed:\n${e.stdout ?? ''}${e.stderr ?? ''}`, {
        cause: err,
      });
    }
    expect(out).toMatch(/# \d+ passed, 0 failed/);
  });

  it('reads the token only from its Keychain item, never a file or the environment', () => {
    const src = code();
    expect(src).toContain('MR_KEYCHAIN="aperture-mailroom-gh"');
    expect(src.match(/\bsecurity\b[^\n]*/g)).toEqual([
      'security find-generic-password -s "$MR_KEYCHAIN" -w 2>/dev/null || true)"',
    ]);
    for (const banned of ['GH_TOKEN', 'GITHUB_TOKEN', '.hostjobs/', 'localNotes', 'eval ', 'sh -c'])
      expect(src).not.toContain(banned);
    expect(src).not.toMatch(/(^|[\s;(|&])(gh|git)\s/m);
  });

  it('calls GitHub only at api.github.com, with four fixed method + path pairs', () => {
    const src = code();
    expect(src).toContain('MR_API="https://api.github.com"');
    expect(
      [...src.matchAll(/\bmr_call (\S+) ("[^"]+"|\S+)/g)].map((m) => `${m[1]} ${m[2]}`),
    ).toEqual([
      'GET /user',
      'GET "/repos/$MR_REPO/git/ref/heads/$branch"',
      'GET "/repos/$MR_REPO/pulls?head=$MR_OWNER:$branch&state=open"',
      'POST "/repos/$MR_REPO/pulls"',
    ]);
    expect(src).toContain('MR_REPO="radatta/aperture"');
    expect(src.match(/\bcurl\b/g)).toHaveLength(1);
  });
});
