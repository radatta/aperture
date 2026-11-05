// ctx.ios: a devcheck step's handle on the iOS Simulator on the user's Mac, through the mailroom's `sim` job.
// A step hands it a plan (data: IosOp[]); the Mac runs it and answers. Pass → the step passes; an assertion that
// didn't hold → the step fails; a sim that couldn't run (Mac asleep, Device Hub down, no password, no soft
// keyboard…) → needsYou(reason): its rows say "needs you", the run stays green. After the first unreachable Mac
// the run's later iOS steps don't wait again. docs/ops/IOS-CHECK.md.
import { basename, join } from 'node:path';
import type { Clock } from '../bot/dispatch.ts';
import {
  IosAssert,
  IosUnavailable,
  makeSimJob,
  runSimJob,
  validateSimParams,
} from '../mailroom/sim.ts';
import type { IosOp, SimResult } from '../mailroom/sim.ts';
import type { Fs } from '../mailroom/submit.ts';
import { needsYou } from './scenario';

export const IOS_NOTE = 'iOS this run';
export const DEFAULT_TIMEOUT_SEC = 480;

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
}

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
  let out: string | null = null;
  let ran = false;
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
        let r: SimResult;
        try {
          r = await runSimJob({ fs: d.fs, clock: d.clock, dir: d.dir, log: d.log }, job);
        } catch (err) {
          if (err instanceof IosAssert) {
            keepShots(scenarioId, name, err.result);
            jobs.push(summarize(name, err.result));
            throw new Error(`iOS: ${err.message}`, { cause: err });
          }
          if (err instanceof IosUnavailable) {
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
