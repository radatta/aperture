// The dev check's own BFF client — signed in as the test user, so it sees exactly the partition the browser
// wrote to (the MCP agent token is pinned to the user's partition and can't). Same discipline as the BFF:
// every write is declared in the one `writes` object below and nowhere else, and the only reads are the
// `reads` object. Every request asserts the dev origin; a delete must name a ledger id.
import { AUTH_HEADER, DEV_ORIGIN, assertDevOrigin } from './config';
import { DevcheckError } from './errors';
import type { Ledger } from './ledger';

// The slice of @aperture/shared's Task the check reads (scripts doesn't depend on shared; the contract
// tests on both sides own the full shape).
export interface DevTask {
  id: string;
  title: string;
  estimateMin?: number | null;
  status?: string;
  parentId?: string | null;
}

export interface CreateTaskInput {
  title: string;
  estimateMin?: number | null;
  dueDay?: string | null;
  dueTime?: string | null; // HH:MM on dueDay (the option-3 scenario; the test user has no Google account)
  notes?: string | null;
  parentId?: string | null; // a part of that task (the parts scenario)
}

// The slice of a saved Flux set the check writes and reads (docs/areas/flux D47). Its id is minted here,
// like the app's — the server keys the idempotent write on it — and recorded before the call.
export interface DevFluxSetInput {
  id: string;
  day: string;
  exerciseId: string;
  kind: string;
  side: 'a' | 'b' | null;
  condition: null;
  count: number;
  avgPeakDeg: number | null;
  avgErrorDeg: number | null;
  rom: { pitch: number; yaw: number; roll: number };
  calibrated: boolean;
  delegate: 'GPU' | 'CPU' | null;
  durationSec: number;
  completedAt: number;
  repTaskId: null;
  stoppedEarly: boolean;
  planned: number | null;
}
export interface DevFluxSet {
  id: string;
  day: string;
  exerciseId: string;
  count: number;
}

// The ledger's `via` for a Flux set — cleanup reads it to delete the right kind of row.
export const FLUX_SET_VIA = 'api:recordFluxSet';

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export interface ApiDeps {
  fetch: FetchLike;
  token: () => string; // read per call — the browser session may have renewed it
  ledger: Ledger;
  run: string;
  sleep?: (ms: number) => Promise<void>;
}

// A 429 is Lambda refusing to start the function (the account's concurrency limit — the app's own page load
// fires many requests at once), so the call never ran: retrying is safe for every method, createTask too.
const THROTTLE_BACKOFF_MS = [500, 1000, 2000, 4000, 8000];

export function createApiClient({
  fetch,
  token,
  ledger,
  run,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}: ApiDeps) {
  async function call<T>(method: string, args: unknown[]): Promise<T> {
    const url = `${DEV_ORIGIN}/api/${method}`;
    assertDevOrigin(url);
    const send = () =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [AUTH_HEADER]: `Bearer ${token()}` },
        body: JSON.stringify({ args }),
      });
    let res = await send();
    for (const wait of THROTTLE_BACKOFF_MS) {
      if (res.status !== 429) break;
      await sleep(wait);
      res = await send();
    }
    const text = await res.text();
    if (res.status !== 200)
      throw new Error(`${method} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as T;
  }

  const reads = {
    listTasks: () => call<DevTask[]>('listTasks', []),
    listBacklog: () => call<DevTask[]>('listBacklog', []),
    getTask: (id: string) => call<DevTask | null>('getTask', [id]),
    listCategories: () => call<{ id: string; label: string }[]>('listCategories', []),
    // The day boundary the app files a set under (a Flux set's `day` is the app's day, not the calendar's).
    getSettings: () => call<{ dayStartHour: number }>('getSettings', []),
    listFluxSets: () => call<DevFluxSet[]>('listFluxSets', [{}]),
    // Alive only — a deleted set reads as gone, like getTask.
    getFluxSet: async (id: string) =>
      (await call<DevFluxSet[]>('listFluxSets', [{}])).find((f) => f.id === id) ?? null,
  };

  const writes = {
    async createTask(input: CreateTaskInput): Promise<DevTask> {
      ledger.append({ run, op: 'intent', via: 'api:createTask', title: input.title });
      const task = await call<DevTask>('createTask', [input]);
      ledger.append({ run, op: 'created', id: task.id, via: 'api:createTask', title: input.title });
      return task;
    },
    // The id is known before the call (the client mints it), so `created` is recorded first: a crash
    // mid-call still leaves the id for the next run's sweep.
    async recordFluxSet(input: DevFluxSetInput): Promise<DevFluxSet> {
      const title = `flux ${input.exerciseId}`;
      ledger.append({ run, op: 'created', id: input.id, via: FLUX_SET_VIA, title });
      return call<DevFluxSet>('recordFluxSet', [input]);
    },
    async deleteFluxSet(id: string): Promise<void> {
      const recorded = ledger
        .read()
        .some((e) => e.op === 'created' && e.id === id && e.via === FLUX_SET_VIA);
      if (!recorded)
        throw new DevcheckError(
          'LEDGER_GUARD',
          `refusing to delete Flux set ${id} — the ledger never recorded it`,
        );
      await call<null>('deleteFluxSet', [id]);
    },
    async deleteTask(id: string): Promise<void> {
      const isFlux = ledger.read().some((e) => e.id === id && e.via === FLUX_SET_VIA);
      if (!ledger.has(id) || isFlux)
        throw new DevcheckError(
          'LEDGER_GUARD',
          `refusing to delete ${id} — the ledger never recorded it`,
        );
      await call<null>('deleteTask', [id]);
    },
  };

  return { reads, writes };
}

export type ApiClient = ReturnType<typeof createApiClient>;
