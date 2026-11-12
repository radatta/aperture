// The iOS plans a scenario sends, read by driving its steps against a recording ctx: every `ctx.ios.run` is
// recorded and stopped there (a sentinel), so a reader replays exactly the jobs a devcheck sends — never a
// hand-copied op list. The sim bench (sim-bench-plans.ts) and the probe check (ios-probe/) both read plans here.
// With every step run, those that drive the browser (`ctx.page`, `ctx.ui`) have none in this ctx and throw; that's
// swallowed — only an `ios` step that fails to send its job is an error.
import type { IosOp } from '../mailroom/sim';
import type { Ctx, Scenario } from './scenario';

export interface RecordedJob {
  scenario: string;
  step: string; // the scenario step that sends it
  name: string;
  steps: IosOp[];
  setupWrites: string[]; // API/MCP writes the step makes before the job, in call order
}

export interface Recording {
  count: (what: string) => void; // a setup write the step made
  fakeId: () => string;
}
// The fake `api` and `mcp` a step sees; default: every write is counted and answers `{ id }`, every read `[]`.
export type Fakes = (rec: Recording) => { api: unknown; mcp: unknown };

class Recorded extends Error {}

export async function recordIosPlans(
  s: Scenario,
  // 'ios' (default): only the steps that send jobs — other steps poll the browser or reads the fakes never satisfy.
  // 'all': every step in order, for a reader that needs a setup step's writes (the bench's seed).
  o: { nonce: string; fakes?: Fakes; steps?: 'ios' | 'all' },
): Promise<RecordedJob[]> {
  const jobs: RecordedJob[] = [];
  let writes: string[] = [];
  let sent = 0;
  let ids = 0;
  const rec: Recording = {
    count: (what) => (writes = [...writes, what]),
    fakeId: () => `plan-fake-${++ids}`,
  };
  const ctx = {
    nonce: o.nonce,
    log: () => {},
    ios: {
      run: async (name: string, steps: IosOp[]) => {
        sent++;
        jobs.push({ scenario: s.id, step: '', name, steps, setupWrites: writes });
        throw new Recorded(name);
      },
    },
    ...(o.fakes ?? defaultFakes)(rec),
  } as unknown as Ctx;

  for (const step of s.steps) {
    if (o.steps !== 'all' && step.entry !== 'ios') continue;
    writes = [];
    const before = sent;
    try {
      await step.run(ctx);
    } catch (err) {
      if (!(err instanceof Recorded) && step.entry === 'ios') throw err;
    }
    if (step.entry === 'ios' && sent !== before + 1)
      throw new Error(`${s.id}: step ${step.id} sent ${sent - before} sim jobs, expected one`);
    if (sent > before) jobs.at(-1)!.step = step.id;
  }
  return jobs;
}

// Writes count and answer an id; reads answer an empty list, or what the ios steps need (as the bench's fakes). Enough for a step to reach its `ios.run`.
export const defaultFakes: Fakes = (rec) => {
  const writes = (prefix: string) =>
    new Proxy(
      {},
      { get: (_, k) => async () => (rec.count(`${prefix}${String(k)}`), { id: rec.fakeId() }) },
    );
  const known: Record<string, unknown> = {
    getSettings: { dayStartHour: 4 },
    getTask: { status: 'in_progress' },
  };
  const reads = new Proxy({}, { get: (_, k) => async () => known[String(k)] ?? [] });
  return { api: { reads, writes: writes('') }, mcp: { reads, writes: writes('mcp ') } };
};
