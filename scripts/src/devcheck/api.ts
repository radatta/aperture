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
  notes?: string | null;
}

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
}

export function createApiClient({ fetch, token, ledger, run }: ApiDeps) {
  async function call<T>(method: string, args: unknown[]): Promise<T> {
    const url = `${DEV_ORIGIN}/api/${method}`;
    assertDevOrigin(url);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [AUTH_HEADER]: `Bearer ${token()}` },
      body: JSON.stringify({ args }),
    });
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
  };

  const writes = {
    async createTask(input: CreateTaskInput): Promise<DevTask> {
      ledger.append({ run, op: 'intent', via: 'api:createTask', title: input.title });
      const task = await call<DevTask>('createTask', [input]);
      ledger.append({ run, op: 'created', id: task.id, via: 'api:createTask', title: input.title });
      return task;
    },
    async deleteTask(id: string): Promise<void> {
      if (!ledger.has(id))
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
