// The sim bench (tools/mailroom/bench/, docs/ops/SIM-BENCH.md): its bash fixture suite as part of `pnpm test`, the
// committed plans.json against what the scenario sends today, and static checks on what the Mac-side scripts may do.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { iosStandalone } from '../devcheck/scenarios/ios-standalone';
import { TOOLS_DIR } from './fixtures.ts';
import { BENCH_NONCE, exportPlans, PLANS_PATH, PRELUDE, render } from './sim-bench-plans.ts';
import { validateSimParams } from './sim.ts';

const BENCH = `${TOOLS_DIR}bench/`;
const SCRIPTS = ['sim-bench.sh', 'sampler.sh', 'summarize.sh'];
// Code only: a comment about a forbidden thing isn't doing it.
const code = (name: string) =>
  readFileSync(`${BENCH}${name}`, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

describe('sim bench', () => {
  it('passes its fixture suite', { timeout: 120_000 }, () => {
    let out: string;
    try {
      out = execFileSync('bash', [`${BENCH}run-fixtures.sh`], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      throw new Error(`bench/run-fixtures.sh failed:\n${e.stdout ?? ''}${e.stderr ?? ''}`, {
        cause: err,
      });
    }
    expect(out).toMatch(/# (\d+) passed, 0 failed, of \1 cases/);
  });

  it('plans.json is exactly what `pnpm sim-bench:plans` exports from ios-standalone today', async () => {
    const committed = JSON.parse(readFileSync(PLANS_PATH, 'utf8')) as unknown;
    // parsed, so prettier's layout can't fail it; a mismatch means: run `pnpm sim-bench:plans` and commit the file
    expect(committed, 'run `pnpm sim-bench:plans`').toEqual(
      JSON.parse(render(await exportPlans())),
    );
  });

  it('replays every sim job the scenario sends, in its order, each a valid sim job', async () => {
    const p = await exportPlans();
    const iosSteps = iosStandalone.steps.filter((s) => s.entry === 'ios').map((s) => s.id);
    expect(p.jobs.map((j) => j.step)).toEqual(iosSteps);
    for (const plan of [p.prelude.steps, ...p.jobs.map((j) => j.steps)]) {
      const params = {
        sha: 'a'.repeat(40),
        timeoutSec: p.timeoutSec,
        shutdown: false,
        steps: plan,
      };
      expect(validateSimParams(params)).toBeNull();
    }
    expect(
      validateSimParams({
        sha: 'a'.repeat(40),
        timeoutSec: p.prelude.timeoutSec,
        shutdown: false,
        steps: PRELUDE,
      }),
    ).toBeNull();
    // the prelude signs in and leaves the sim off, so run 1 boots cold as a devcheck's first job does
    expect(PRELUDE.at(-1)).toEqual({ op: 'shutdown' });
  });

  it('the seed is the task the Done form job searches for, in progress', async () => {
    const p = await exportPlans();
    const done = p.jobs.find((j) => j.name === 'done-form')!;
    const typed = done.steps.find((o) => o.op === 'keys' && o.in === 'search') as { text: string };
    expect(p.nonce).toBe(BENCH_NONCE);
    expect(p.seed.status).toBe('in_progress');
    expect(p.seed.title.toLowerCase()).toContain(typed.text);
    expect(done.steps.some((o) => o.op === 'tap' && o.label === 'Done')).toBe(true);
  });

  it('the Mac-side scripts are bash 3.2 + jq, pin the mailroom PATH, and kill only by PID', () => {
    for (const name of SCRIPTS) {
      const src = readFileSync(`${BENCH}${name}`, 'utf8');
      const c = code(name);
      expect(src.startsWith('#!/bin/bash\n'), name).toBe(true);
      expect(c, name).not.toMatch(
        /\beval\b|\bsh -c\b|declare -A|mapfile|readarray|\$\{[a-zA-Z_]+,,\}|\$EPOCH/,
      );
      expect(c, name).not.toMatch(/pkill (?!-P )|killall/); // by parent PID only
      expect(c, name).not.toMatch(/\.secrets/);
    }
    // the plist's PATH: native Homebrew, never Intel /usr/local (the M1 has both)
    expect(code('sim-bench.sh')).toContain(
      'export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin\n',
    );
    expect(
      readFileSync(`${TOOLS_DIR}dev.rahuldatta.aperture.mailroom.plist.tmpl`, 'utf8'),
    ).toContain('/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin');
  });

  it('wraps the mailroom runner as a black box: sources nothing of it, writes nothing into it', () => {
    const c = code('sim-bench.sh');
    expect(c).not.toMatch(/^\s*(\.|source) /m);
    expect(c).toContain('bash "$RUNNER" "$HJ" "$ST"');
    expect(c).toContain('RUNNER="$MR/runner.sh"');
    // the benched sim.sh is recorded by its hash in every result (machine.json → summary.json)
    expect(c).toMatch(/SIM_SH_SHA="\$\(sha256 <"\$MR\/jobs\/sim\.sh"\)"/);
  });
});
