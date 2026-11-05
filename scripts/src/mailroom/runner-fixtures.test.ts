// The Mac runner's own suite (bash + jq, curl/security/axe/simctl stubbed) as part of `pnpm test`, plus static
// checks on what the runner may touch: each secret's one source, the five fixed GitHub calls, and a sim job that
// makes no network call and runs nothing a job names. docs/ops/MAILROOM.md, docs/ops/IOS-CHECK.md.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOLS_DIR } from './fixtures.ts';
import { SIM_H, SIM_W } from './sim.ts';

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
  it('passes its fixture suite', { timeout: 400_000 }, () => {
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

  it('reads each secret only from its Keychain item, never a file or the environment', () => {
    const src = code();
    expect(src).toContain('MR_KEYCHAIN="aperture-mailroom-gh"');
    expect(src).toContain('SIM_KEYCHAIN="aperture-devcheck-dev"');
    expect(src.match(/\bsecurity\b[^\n]*/g)).toEqual([
      'security find-generic-password -s "$MR_KEYCHAIN" -w 2>/dev/null || true)"',
      'security find-generic-password -s "$SIM_KEYCHAIN" -a "$SIM_EMAIL" >/dev/null 2>&1 \\',
      `security find-generic-password -s "$SIM_KEYCHAIN" -a "$SIM_EMAIL" -w 2>/dev/null | tr -d '\\n' | ax type --stdin >/dev/null 2>&1; then`,
    ]);
    for (const banned of ['GH_TOKEN', 'GITHUB_TOKEN', '.hostjobs/', 'localNotes', 'eval ', 'sh -c'])
      expect(src).not.toContain(banned);
    expect(src).not.toMatch(/(^|[\s;(|&])(gh|git)\s/m);
  });

  it('the sim job: pinned constants, no network, nothing a job names is ever run', () => {
    const sim = readFileSync(`${TOOLS_DIR}jobs/sim.sh`, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    for (const pin of [
      'SIM_NAME="aperture-devcheck"',
      'SIM_AXE_VERSION="1.8.0"',
      'SIM_TERMINATE_ID="com.apple.webapp"',
      'SIM_EMAIL="rahul3datta+devcheck@gmail.com"',
      "SIM_COGNITO_RE='^aperture-dev-618015769091\\.auth\\.us-west-1\\.amazoncognito\\.com$'",
      `SIM_W=${SIM_W}`, // the validators' bounds (sim.ts) follow the device profile
      `SIM_H=${SIM_H}`,
    ])
      expect(sim).toContain(pin);
    const secretsDir = ['.sec', 'rets'].join(''); // spelled apart: the repo's hooks guard the literal
    for (const banned of [
      'curl',
      'openurl',
      'osascript',
      'eval ',
      'sh -c',
      secretsDir,
      'localNotes',
      'bash -',
    ])
      expect(sim).not.toContain(banned);
    // The host is read from the native address bar (id URL), checked before the email and again just before
    // the password; the password reaches axe only on stdin.
    expect(sim).toContain(`'.role == "AXGenericElement" and .id == "URL" and .label == "Address"`);
    expect(sim).toContain('and $app != null and .pid != null and .pid != $app');
    expect(sim).toContain('[[ "$v" =~ $SIM_COGNITO_RE ]]');
    expect(sim).toContain(
      'and ($bar == null or .pid == $bar) and ($form == null or .pid != $form)',
    );
    // No read carries a value between the first form tap and Home, but the two that prove focus before the password.
    expect(sim).toContain('| if $sens then del(.value) else . end');
    expect(sim).toContain('SIM_SENSITIVE=true');
    const checks = [...sim.matchAll(/\bsim_on_cognito "\$app"/g)].map((m) => m.index);
    const email = sim.indexOf('ax type "$SIM_EMAIL"');
    const password = sim.indexOf('ax type --stdin');
    expect(checks).toHaveLength(2);
    expect(checks[0]).toBeLessThan(email);
    expect(checks[1]).toBeGreaterThan(email);
    expect(checks[1]).toBeLessThan(password);
    // The focus is proven with a harmless key before the password, and the host checked after that.
    const focused = sim.indexOf('sim_pw_focused "$pf" "$ef" ||');
    expect(sim).toContain('ax key 27');
    expect(focused).toBeGreaterThan(email);
    expect(focused).toBeLessThan(checks[1] ?? -1);
    expect(sim.match(/\bax type\b[^\n]*/g)?.map((l) => l.slice(0, 30))).toEqual([
      'ax type "$SIM_EMAIL" >/dev/nul',
      'ax type --stdin >/dev/null 2>&',
    ]);
    // Tools by name only (no path a job could steer); axe only through the capped `ax`/`sim_cap` wrappers.
    expect(sim).not.toMatch(/(^|[\s;(|&])\/[a-z/]+\/(axe|xcrun|security|open)\b/m);
    expect(sim.match(/(?<!--arg |want |")\baxe\s[^\n]*/g)).toEqual([
      'axe "$@" --udid "$SIM_U"',
      'axe --version 2>/dev/null | tr -d \'[:space:]\')" || v=""',
    ]);
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
