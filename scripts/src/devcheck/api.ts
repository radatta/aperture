// The dev check's own BFF client — signed in as the test user, so it sees exactly the partition the browser
// wrote to (the MCP agent token is pinned to the user's partition and can't). Same discipline as the BFF:
// every write is declared in the one `writes` object below and nowhere else, and the only reads are the
// `reads` object. Every request asserts the dev origin; a delete must name a ledger id. The one exception to
// the origin is a presigned URL the dev BFF minted for an attachment, under assertPresignedDevUrl.
import { AUTH_HEADER, DEV_ORIGIN, assertDevOrigin, assertPresignedDevUrl } from './config';
import { DevcheckError } from './errors';
import { pendingIds, type Ledger, type LedgerEntry } from './ledger';

// After a delete S3 answers a presigned GET with 403, not 404: the roles have no s3:ListBucket, so S3 hides
// NoSuchKey behind AccessDenied. 404 still counts as gone.
export const isGone = (status: number): boolean => status === 403 || status === 404;

// The slice of @aperture/shared's Task the check reads (scripts doesn't depend on shared; the contract
// tests on both sides own the full shape).
export interface DevTask {
  id: string;
  title: string;
  estimateMin?: number | null;
  status?: string;
  parentId?: string | null;
  place?: string | null; // a place slug — an errand (the places scenario)
  estimateLockedMin?: number | null;
  actualAccruedMin?: number;
  reflection?: string | null; // the reflection scenario
}

export interface CreateTaskInput {
  title: string;
  estimateMin?: number | null;
  dueDay?: string | null;
  dueTime?: string | null; // HH:MM on dueDay (the option-3 scenario; the test user has no Google account)
  notes?: string | null;
  parentId?: string | null; // a part of that task (the parts scenario)
  place?: string | null; // a place slug (the places scenario)
}

// The slices of @aperture/shared's places contract the check reads (packages/shared/src/places.ts).
export interface DevPlace {
  id: string;
  name: string;
  slug: string;
  lastReadAt: number | null;
}
export interface DevPlaceDigest {
  place: string;
  slug: string;
  count: number;
  titles: string[];
  text: string;
}
export interface DevPlaceTokenStatus {
  active: boolean;
  createdAt: number | null;
  lastUsedAt: number | null;
  hint: string | null;
  readsToday: number;
}
export interface DevCalibrationPoint {
  taskId: string;
  day: string;
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

// The slice of an attachment the check reads. Attachments are never ledgered: each lives on a ledgered
// task, and that task's delete cascade removes it (and its bytes).
export interface DevAttachment {
  id: string;
  taskId: string;
  s3Key: string;
  contentType: string;
  status: string;
}

// The slice of a Pomodoro session the check reads. Sessions are never written by the harness's API client.
export interface DevSession {
  id: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
  activeMinutes: number;
}

// The ledger's `via` for a Flux set — cleanup reads it to delete the right kind of row.
export const FLUX_SET_VIA = 'api:recordFluxSet';
// A place this harness created (through the API, or the browser's upsertPlace create — recorder.ts).
export const PLACE_VIA = 'api:upsertPlace';
export const UI_PLACE_VIA = 'ui:upsertPlace';
// The test user's Shortcut token. It has no id, so a rotate records `place-token:<run>` — before the call, like
// a Flux set: a crash mid-call still leaves a token for the next run's sweep to revoke.
export const PLACE_TOKEN_VIA = 'api:rotatePlaceToken';
export const placeTokenId = (run: string): string => `place-token:${run}`;

// What a ledger id names, by the `via` it was created with — each kind is read and deleted its own way.
export type LedgerKind = 'task' | 'flux' | 'place' | 'placeToken';
export function ledgerKind(entries: LedgerEntry[], id: string): LedgerKind {
  const via = entries.find((e) => e.op === 'created' && e.id === id)?.via;
  if (via === FLUX_SET_VIA) return 'flux';
  if (via === PLACE_VIA || via === UI_PLACE_VIA) return 'place';
  return via === PLACE_TOKEN_VIA ? 'placeToken' : 'task';
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string | Uint8Array;
    redirect?: 'error'; // presigned requests and the place route: a 3xx must never leave the checked host
  },
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

// The BFF's own refusal body, `{error: '…'}` — as against Lambda's throttle, which the function never wrote.
function bffError(text: string): boolean {
  try {
    const v = JSON.parse(text) as unknown;
    return !!v && typeof v === 'object' && typeof (v as { error?: unknown }).error === 'string';
  } catch {
    return false;
  }
}

export function createApiClient({
  fetch,
  token,
  ledger,
  run,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}: ApiDeps) {
  // `retry(status, text)` says whether this answer is a throttle to back off from.
  async function backoff(
    send: () => ReturnType<FetchLike>,
    retry: (status: number, text: string) => boolean = (status) => status === 429,
  ): Promise<{ status: number; text: string }> {
    let res = await send();
    let text = await res.text();
    for (const wait of THROTTLE_BACKOFF_MS) {
      if (!retry(res.status, text)) break;
      await sleep(wait);
      res = await send();
      text = await res.text();
    }
    return { status: res.status, text };
  }

  async function call<T>(method: string, args: unknown[]): Promise<T> {
    const url = `${DEV_ORIGIN}/api/${method}`;
    assertDevOrigin(url);
    const { status, text } = await backoff(() =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [AUTH_HEADER]: `Bearer ${token()}` },
        body: JSON.stringify({ args }),
      }),
    );
    if (status !== 200) throw new Error(`${method} → HTTP ${status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as T;
  }

  // A write may only touch a row this harness created, through its own kind's methods.
  function assertLedger(id: string, kind: LedgerKind): void {
    if (!ledger.has(id) || ledgerKind(ledger.read(), id) !== kind)
      throw new DevcheckError(
        'LEDGER_GUARD',
        `refusing to touch ${id} — the ledger never recorded it as a ${kind}`,
      );
  }
  const assertLedgerTask = (id: string) => assertLedger(id, 'task');
  // `place-token:<run>`, once a run, before any mint (API or browser): a crash mid-call still leaves it
  // for the next run's sweep to revoke.
  function recordTokenMint(): void {
    const id = placeTokenId(run);
    if (!pendingIds(ledger.read()).includes(id))
      ledger.append({ run, op: 'created', id, via: PLACE_TOKEN_VIA, title: 'place token' });
  }
  // Attachments this client created; deleteAttachment refuses any other id.
  const attachmentIds = new Set<string>();

  const reads = {
    listTasks: () => call<DevTask[]>('listTasks', []),
    listBacklog: () => call<DevTask[]>('listBacklog', []),
    getTask: (id: string) => call<DevTask | null>('getTask', [id]),
    listCategories: () => call<{ id: string; label: string }[]>('listCategories', []),
    // The day boundary the app files a set under (a Flux set's `day` is the app's day, not the calendar's).
    getSettings: () => call<{ dayStartHour: number; fluxRollId: string | null }>('getSettings', []),
    listRunningSessions: () => call<{ id: string }[]>('listRunningSessions', []),
    listSessionsForDay: (day: string) => call<DevSession[]>('listSessionsForDay', [day]),
    listFluxSets: () => call<DevFluxSet[]>('listFluxSets', [{}]),
    // Alive only — a deleted set reads as gone, like getTask.
    getFluxSet: async (id: string) =>
      (await call<DevFluxSet[]>('listFluxSets', [{}])).find((f) => f.id === id) ?? null,
    listAttachments: (taskId: string) => call<DevAttachment[]>('listAttachments', [taskId]),
    getAttachmentDownloadUrl: (id: string) => call<string>('getAttachmentDownloadUrl', [id]),
    // GET a BFF-minted presigned URL and return only its status (200 while the bytes exist, 403/404 after).
    // Gone is 403 or 404 — see isGone.
    async probePresigned(url: string): Promise<number> {
      assertPresignedDevUrl(url);
      const res = await fetch(url, { method: 'GET', headers: {}, redirect: 'error' });
      await res.text(); // drain
      return res.status;
    },
    listPlaces: () => call<DevPlace[]>('listPlaces', []),
    // The digest as an RPC read — no heartbeat, no count (the Shortcut route below is the one that counts).
    listPlaceTasks: (slug: string) => call<DevPlaceDigest>('listPlaceTasks', [slug]),
    getPlaceTokenStatus: () => call<DevPlaceTokenStatus>('getPlaceTokenStatus', []),
    getCalibration: (range: { from: string; to: string }) =>
      call<DevCalibrationPoint[]>('getCalibration', [range]),
    // The iPhone Shortcut's route, raw: GET /api/places/<slug>/tasks with the place token (never the session
    // JWT) in the BFF header, or none — the status and parsed body, whatever they are, so a step can assert a
    // refusal. A 200 bumps the token's count and the place's lastReadAt server-side, as the Shortcut does;
    // every other answer writes nothing (lambdas/src/index.ts) and carries `{error, text}` — never a 404,
    // which CloudFront would rewrite to the app shell. `method` is GET but for proving the 405. A 429
    // carrying the BFF's own `{error}` is the daily cap, returned as is; any other 429 is Lambda throttling
    // and is backed off like call()'s.
    async placeDigestRaw(
      slug: string,
      placeToken: string | null,
      method: 'GET' | 'POST' = 'GET',
    ): Promise<{ status: number; body: unknown }> {
      const url = `${DEV_ORIGIN}/api/places/${encodeURIComponent(slug)}/tasks`;
      assertDevOrigin(url);
      const headers: Record<string, string> = placeToken
        ? { [AUTH_HEADER]: `Bearer ${placeToken}` }
        : {};
      const { status, text } = await backoff(
        () => fetch(url, { method, headers, redirect: 'error' }),
        (s, t) => s === 429 && !bffError(t),
      );
      try {
        return { status, body: JSON.parse(text) as unknown };
      } catch {
        return { status, body: text.slice(0, 200) };
      }
    },
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
    // The reflection scenario's direct BFF call (its over-cap refusal), on a task this harness created.
    async setTaskActual(
      id: string,
      actualMin: number,
      reflection?: string | null,
    ): Promise<DevTask> {
      assertLedgerTask(id);
      return call<DevTask>(
        'setTaskActual',
        reflection === undefined ? [id, actualMin] : [id, actualMin, reflection],
      );
    },
    async deleteTask(id: string): Promise<void> {
      assertLedgerTask(id);
      await call<null>('deleteTask', [id]);
    },
    // Mint an upload URL, PUT the bytes to S3 as the app does, then confirm — or leave it pending
    // (confirm: false), as an abandoned upload would.
    async createAttachment(
      taskId: string,
      file: { filename: string; contentType: string; text: string; confirm?: boolean },
    ): Promise<DevAttachment> {
      assertLedgerTask(taskId);
      const bytes = new TextEncoder().encode(file.text);
      const { attachment, uploadUrl } = await call<{
        attachment: DevAttachment;
        uploadUrl: string;
      }>('createAttachmentUploadUrl', [
        { taskId, filename: file.filename, contentType: file.contentType, size: bytes.byteLength },
      ]);
      attachmentIds.add(attachment.id);
      assertPresignedDevUrl(uploadUrl);
      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': attachment.contentType }, // the server-normalised type
        body: bytes,
        redirect: 'error',
      });
      if (res.status !== 200) throw new Error(`attachment PUT → HTTP ${res.status}`);
      if (file.confirm === false) return attachment;
      return call<DevAttachment>('confirmAttachment', [attachment.id]);
    },
    async deleteAttachment(taskId: string, id: string): Promise<void> {
      assertLedgerTask(taskId);
      if (!attachmentIds.has(id))
        throw new DevcheckError(
          'LEDGER_GUARD',
          `refusing to delete attachment ${id} — not this run's`,
        );
      await call<null>('deleteAttachment', [id]);
    },
    // Create (no id) is ledgered like createTask — intent, then the server's id; an update must name a place
    // the ledger recorded.
    async upsertPlace(input: { id?: string; name: string; slug?: string }): Promise<DevPlace> {
      if (input.id) {
        assertLedger(input.id, 'place');
        return call<DevPlace>('upsertPlace', [input]);
      }
      ledger.append({ run, op: 'intent', via: PLACE_VIA, title: input.name });
      const place = await call<DevPlace>('upsertPlace', [input]);
      ledger.append({ run, op: 'created', id: place.id, via: PLACE_VIA, title: input.name });
      return place;
    },
    // Its alive tasks move to `reassignToSlug`, or off any list (null) — cleanup passes null.
    async deletePlace(id: string, reassignToSlug: string | null): Promise<void> {
      assertLedger(id, 'place');
      await call<null>('deletePlace', [id, reassignToSlug]);
    },
    // The plaintext comes back once; it lives in the step's memory only — never logged, never ledgered.
    async rotatePlaceToken(): Promise<{ token: string; status: DevPlaceTokenStatus }> {
      recordTokenMint();
      return call<{ token: string; status: DevPlaceTokenStatus }>('rotatePlaceToken', []);
    },
    // The ledger half alone, for Settings' Generate / Rotate: called before the click, so a token the
    // browser mints is recorded like one rotated here. Writes nothing to dev.
    recordPlaceTokenMint: (): void => recordTokenMint(),
    // Only while the ledger holds a token a run minted and nothing has resolved yet: the test user's token
    // is the harness's to revoke only when the harness made it.
    async revokePlaceToken(): Promise<void> {
      const entries = ledger.read();
      if (!pendingIds(entries).some((id) => ledgerKind(entries, id) === 'placeToken'))
        throw new DevcheckError(
          'LEDGER_GUARD',
          'refusing to revoke the place token — no run recorded minting it',
        );
      await call<null>('revokePlaceToken', []);
    },
  };

  return { reads, writes };
}

export type ApiClient = ReturnType<typeof createApiClient>;
