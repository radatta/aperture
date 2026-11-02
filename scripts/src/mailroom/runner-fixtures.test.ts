// The Mac runner's own suite (bash + jq, curl/security stubbed) as part of `pnpm test`, plus static checks on
// what the runner may touch: the token's one source and the five fixed GitHub calls. docs/ops/MAILROOM.md.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('jobs.jsonl is exactly what gen-jobs.py generates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mailroom-gen-'));
    try {
      execFileSync('python3', [`${TOOLS_DIR}testdata/gen-jobs.py`, join(dir, 'jobs.jsonl')], {
        stdio: 'pipe',
      });
      expect(readFileSync(join(dir, 'jobs.jsonl'), 'utf8')).toBe(
        readFileSync(`${TOOLS_DIR}testdata/jobs.jsonl`, 'utf8'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('calls GitHub only at api.github.com, with five fixed method + path pairs, one write', () => {
    const src = code();
    expect(src).toContain('MR_API="https://api.github.com"');
    expect(
      [...src.matchAll(/\bmr_call (\S+) ("[^"]+"|\S+)/g)].map((m) => `${m[1]} ${m[2]}`),
    ).toEqual([
      'GET /user',
      'GET "/repos/$MR_REPO/git/ref/heads/$branch"',
      'GET "/repos/$MR_REPO/pulls?head=$MR_OWNER:$branch&state=open"',
      'POST /markdown',
      'POST "/repos/$MR_REPO/pulls"',
    ]);
    expect(src).toContain('MR_REPO="radatta/aperture"');
    expect(src.match(/\bcurl\b/g)).toHaveLength(1);
  });

  it('installs only what GitHub holds at a commit, reading nothing from the shared folder', () => {
    const src = readFileSync(`${TOOLS_DIR}install.sh`, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    // No path back to this folder's own files: every install source is a GitHub read at $ref.
    for (const banned of [
      'dirname "$0"',
      'BASH_SOURCE',
      '$SRC',
      'tools/mailroom/runner.sh"',
      ' -X ',
    ])
      expect(src).not.toContain(banned);
    // Every copy comes from the staged GitHub fetch.
    for (const l of src.split('\n').filter((x) => /^\s*cp\s/.test(x)))
      expect(l).toMatch(/^\s*cp "\$stage/);
    const calls = src.split('\n').filter((l) => /^\s*curl\s/.test(l));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('-H @<(printf \'Authorization: Bearer %s\\n\' "$TOKEN")');
    expect(src).toContain('"https://api.github.com/repos/$REPO_SLUG/$1"');
    expect(src.match(/\bget "[^"]+"/g)).toEqual([
      'get "contents/tools/mailroom/jobs?ref=$ref"',
      'get "contents/tools/mailroom/runner.sh?ref=$ref"',
      'get "contents/tools/mailroom/jobs/$j?ref=$ref"',
      'get "contents/tools/mailroom/$LABEL.plist.tmpl?ref=$ref"',
    ]);
    expect(src).toContain('TOKEN="$(security find-generic-password -s "$KEYCHAIN" -w');
  });
});
