// ctx.ios: a devcheck step's handle on the iOS Simulator on the user's Mac, through the mailroom's `sim` job.
// A step hands it a plan (data: IosOp[]); the Mac runs it and answers. Pass → the step passes; an assertion that
// didn't hold → the step fails; a sim that couldn't run (Mac asleep, Device Hub down, no password, no soft
// keyboard…) → needsYou(reason): its rows say "needs you", the run stays green. After the first unreachable Mac
// the run's later iOS steps don't wait again. docs/ops/IOS-CHECK.md.
import { basename, join } from 'node:path';
import type { Clock } from '../bot/dispatch.ts';
import {
  IosAssert,
  IosRejected,
  IosUnavailable,
  makeSimJob,
  runSimJob,
  validateSimParams,
} from '../mailroom/sim.ts';
import { INSTALL_LINE } from '../mailroom/open-pr.ts';
import type { IosOp, SimResult } from '../mailroom/sim.ts';
import type { Fs } from '../mailroom/submit.ts';
import { needsYou } from './scenario';

export const IOS_NOTE = 'iOS this run';
export const DEFAULT_TIMEOUT_SEC = 480;
// A scan down the band the keyboard-up dock settles in, wherever that is: dock probes are scans, never a `near`
// (IOS-CHECK.md → Probe check). From 390: the mode row stays below it with the dock ~30 pt high, and a scan from
// higher reads more page content (a habit row is a toggle too). The mode row's toggles are 28 pt tall: MODE_ROW's
// points (…435, 465, 495, 525) land 7–15 pt inside them settled (y 450), settling (~−30) and low (~+56).
export const DOCK = (x: number, from = 390) => ({ x, from, to: 650 });
export const MODE_ROW = 405;

export interface IosClient {
  run(name: string, steps: IosOp[], opts?: { timeoutSec?: number }): Promise<SimResult>;
}

export interface IosJobSummary {
  id: string;
  step: string;
  status: SimResult['status'] | 'unavailable';
  reason: string | null;
  booted?: string;
  signedIn?: string;
  buildsSeen: string[];
  device?: SimResult['device'];
  runnerVersion?: string;
}

export interface IosDeps {
  fs: Fs;
  clock: Clock;
  dir: string; // .hostjobs
  expectedSha: string;
  outDir: string; // the run's artifact dir
  copy: (from: string, to: string) => void;
  log: (s: string) => void;
  repoVersion?: () => string; // the runner this checkout would install; an older one on the Mac gets a line once
  slot?: 'dev' | 'devb'; // the run's dev slot: the Simulator is slot A's
}

// The sim's Home Screen app, Keychain item and sign-in host (tools/mailroom/jobs/sim.sh) are slot A's, so a devb run's
// iOS rows read "needs you" with this reason before any job is queued — never a failure (docs/ops/IOS-CHECK.md).
export const SIM_SLOT_A_ONLY =
  'SIM_SLOT_A_ONLY — the Simulator is set up for dev (slot A) only; this run is on devb';

export interface Ios {
  forScenario(scenarioId: string): IosClient;
  finish(): Promise<void>; // shut the sim down after the run's last job (best effort)
  jobs: IosJobSummary[];
  shots: string[]; // artifact files, relative to outDir
  unavailable(): string | null; // the reason a later step won't even try, once the Mac is out
}

// A step-level problem (this plan's keyboard) leaves the next plan free to try; anything else means the Mac is out.
const runWide = (reason: string) => !reason.endsWith('/KEYBOARD_SETUP');

export function createIos(d: IosDeps): Ios {
  let out: string | null = d.slot && d.slot !== 'dev' ? SIM_SLOT_A_ONLY : null;
  let ran = false;
  let lastBooted: string | undefined;
  let warned = false;
  // This checkout's runner when the Mac's is another version, else null (unknown counts as the same).
  const staleAgainst = (r: { runnerVersion?: string | undefined }): string | null => {
    if (!d.repoVersion || !r.runnerVersion) return null;
    try {
      const want = d.repoVersion();
      return r.runnerVersion === want ? null : want;
    } catch {
      return null;
    }
  };
  // A line only: nothing here may fail a row.
  const warnStaleRunner = (r: { runnerVersion?: string | undefined }) => {
    const want = staleAgainst(r);
    if (warned || !want || !r.runnerVersion) return;
    warned = true;
    d.log(
      `  the Mac runs runner ${r.runnerVersion.slice(0, 12)}, the repo has ${want.slice(0, 12)} — reinstall (from merged main; a branch that changes the runner: its sha in ?ref= and --ref, MAILROOM.md → Install): ${INSTALL_LINE}`,
    );
  };
  const jobs: IosJobSummary[] = [];
  const shots: string[] = [];

  const keepShots = (scenarioId: string, step: string, r: SimResult) => {
    for (const s of r.shots ?? []) {
      const file = `ios-${scenarioId}-${step}-${basename(s)}`;
      try {
        d.copy(join(d.dir, 'results', r.id, s), join(d.outDir, file));
        shots.push(file);
      } catch (err) {
        d.log(
          `  could not copy the sim's ${s}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };
  const summarize = (step: string, r: SimResult): IosJobSummary => ({
    id: r.id,
    step,
    status: r.status,
    reason: r.reason ? `${r.reason}${r.detail ? `/${r.detail}` : ''}` : null,
    booted: r.booted,
    signedIn: r.signedIn,
    buildsSeen: r.buildsSeen ?? [],
    device: r.device,
    runnerVersion: r.runnerVersion,
  });

  return {
    jobs,
    shots,
    unavailable: () => out,
    forScenario: (scenarioId) => ({
      async run(name, steps, opts = {}) {
        if (out) needsYou(`${IOS_NOTE}: ${out}`);
        const job = makeSimJob(
          `${scenarioId}-${name}`,
          {
            sha: d.expectedSha,
            timeoutSec: opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
            shutdown: false,
            steps,
          },
          d.clock.now(),
        );
        const bad = validateSimParams(job.params);
        if (bad)
          throw new Error(
            `the iOS plan for ${name} is invalid: ${bad} (IOS-CHECK.md → The op language)`,
          );
        ran = true;
        d.log(`  ios ${name}: ${steps.length} ops`);
        lastBooted = undefined; // this job may boot it, whatever the last one left
        let r: SimResult;
        try {
          r = await runSimJob({ fs: d.fs, clock: d.clock, dir: d.dir, log: d.log }, job);
        } catch (err) {
          if (err instanceof IosRejected || err instanceof IosUnavailable) warnStaleRunner(err);
          if (err instanceof IosAssert) {
            keepShots(scenarioId, name, err.result);
            jobs.push(summarize(name, err.result));
            lastBooted = err.result.booted;
            warnStaleRunner(err.result);
            throw new Error(`iOS: ${err.message}`, { cause: err });
          }
          // A plan this checkout writes that an older runner can't read: the Mac needs a reinstall, not a fix here.
          if (err instanceof IosRejected && staleAgainst(err)) {
            out = 'RUNNER_STALE';
            jobs.push({
              id: job.id,
              step: name,
              status: 'rejected',
              reason: out,
              buildsSeen: [],
              runnerVersion: err.runnerVersion,
            });
            needsYou(
              `${IOS_NOTE}: RUNNER_STALE — the Mac's runner refused a plan from a newer one; reinstall it`,
            );
          }
          if (err instanceof IosUnavailable) {
            if (err.result) keepShots(scenarioId, name, err.result);
            if (runWide(err.reason)) out = err.reason;
            jobs.push({
              id: job.id,
              step: name,
              status: 'unavailable',
              reason: err.reason,
              buildsSeen: [],
            });
            needsYou(`${IOS_NOTE}: ${err.reason}`, { stepOnly: !runWide(err.reason) });
          }
          throw err;
        }
        keepShots(scenarioId, name, r);
        jobs.push(summarize(name, r));
        lastBooted = r.booted;
        warnStaleRunner(r);
        // Credited to the build the app actually ran; a pass on another build is no pass for this one.
        const want = d.expectedSha.slice(0, 7);
        const seen = r.buildsSeen?.at(-1);
        if (seen && seen !== want)
          throw new Error(`iOS ran build ${seen}, expected ${want} — rerun`);
        return r;
      },
    }),
    async finish() {
      // No shutdown job to a Mac that isn't answering; any other unavailability (NOT_LAUNCHED…) left it booted.
      if (!ran || (out && /^MAC_(UNREACHABLE|STALLED)/.test(out))) return;
      if (lastBooted === 'off') return; // the plan's own last op shut it down
      const job = makeSimJob(
        'shutdown',
        { sha: d.expectedSha, timeoutSec: 60, shutdown: false, steps: [{ op: 'shutdown' }] },
        d.clock.now(),
      );
      await runSimJob({ fs: d.fs, clock: d.clock, dir: d.dir, log: d.log }, job).catch(
        (err: unknown) =>
          d.log(
            `  the sim stays booted (${err instanceof Error ? err.message : String(err)}) — pnpm mailroom sim-shutdown`,
          ),
      );
    },
  };
}
