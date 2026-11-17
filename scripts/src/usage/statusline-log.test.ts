// The tracked status-line logger (scripts/usage/statusline-log.sh), sourced the way the status line sources it.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '../../usage/statusline-log.sh');
// Source it with $input set, then report what leaked: its exit code and any _ul_ variable left behind.
const HARNESS = 'input=$(cat); . "$1"; echo "rc=$?"; set | grep -c "^_ul_" || true';

let dir: string;
let stamps: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-log-'));
  stamps = mkdtempSync(join(tmpdir(), 'usage-stamp-'));
});
afterEach(() => {
  chmodSync(dir, 0o755);
  rmSync(dir, { recursive: true, force: true });
  rmSync(stamps, { recursive: true, force: true });
});

const status = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    session_id: 'sess-fixture-1',
    session_name: 'lane-x',
    workspace: { current_dir: '/workspace/.claude/worktrees/lane-x' },
    model: { id: 'claude-opus-5-5' },
    cost: { total_cost_usd: 1.25 },
    rate_limits: { seven_day: { used_percentage: 40, resets_at: 1_900_000_000 } },
    context_window: { current_usage: { input_tokens: 3 } },
    transcript_path: '/tmp/fixture.jsonl',
    version: '9.9.9',
    ...over,
  });

const run = (input: string, env: Record<string, string> = {}) =>
  execFileSync('bash', ['-c', HARNESS, '_', SCRIPT], {
    input,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      TZ: 'UTC',
      APERTURE_USAGE_DIR: dir,
      APERTURE_USAGE_STAMP_DIR: stamps,
      ...env,
    },
  });
const day = () => new Date().toISOString().slice(0, 10);
const rows = () => {
  const files = readdirSync(dir);
  return files.flatMap((f) =>
    readFileSync(join(dir, f), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l)),
  );
};
// Age the stamp past the throttle window without sleeping.
const age = () => {
  const s = join(stamps, 'aperture-usage-stamp-sess-fixture-1');
  const past = new Date(Date.now() - 120_000);
  utimesSync(s, past, past);
};

describe('statusline-log.sh', () => {
  it('appends one row with the meter fields to meter-<day>.jsonl, printing nothing but the harness lines', () => {
    expect(run(status())).toBe('rc=0\n0\n');
    expect(readdirSync(dir)).toEqual([`meter-${day()}.jsonl`]);
    const [r] = rows();
    expect(r).toMatchObject({
      sid: 'sess-fixture-1',
      name: 'lane-x',
      cwd: '/workspace/.claude/worktrees/lane-x',
      branch: null,
      pr: null,
      model: 'claude-opus-5-5',
      cost: 1.25,
      rl: { seven_day: { used_percentage: 40, resets_at: 1_900_000_000 } },
      ctx: { input_tokens: 3 },
      tp: '/tmp/fixture.jsonl',
      v: '9.9.9',
      lv: 1,
    });
    expect(Number.isNaN(Date.parse(r.ts))).toBe(false);
  });

  it('throttles a session to one row per window, but writes at once when the weekly % moved', () => {
    run(status());
    run(status({ cost: { total_cost_usd: 2 } }));
    expect(rows()).toHaveLength(1);
    run(status({ rate_limits: { seven_day: { used_percentage: 41, resets_at: 1_900_000_000 } } }));
    expect(rows().map((r) => r.rl.seven_day.used_percentage)).toEqual([40, 41]);
    age();
    run(status({ rate_limits: { seven_day: { used_percentage: 41, resets_at: 1_900_000_000 } } }));
    expect(rows()).toHaveLength(3);
  });

  it("keeps a new session's null rate_limits and cost as null (the meter skips them later)", () => {
    run(status({ rate_limits: null, cost: null }));
    expect(rows()[0]).toMatchObject({ rl: null, cost: null });
  });

  it('writes nothing without a session id, or for malformed stdin, and still exits 0', () => {
    expect(run(status({ session_id: null }))).toBe('rc=0\n0\n');
    expect(run('{not json')).toBe('rc=0\n0\n');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('stays silent when the log dir is unwritable', () => {
    chmodSync(dir, 0o555);
    expect(run(status(), { APERTURE_USAGE_DIR: join(dir, 'sub') })).toBe('rc=0\n0\n');
  });
});
