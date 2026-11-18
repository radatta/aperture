// The dev check’s own BFF client — signed in as the test user, so it sees exactly the partition the browser
// wrote to (the MCP agent token is pinned to the user’s partition and can’t). Same discipline as the BFF:
// every write is declared in a `writes` object and nowhere else, and the only reads are the `reads` objects.
// Every request asserts the dev origin; a delete must name a ledger id. The one exception to the origin is a
// presigned URL the dev BFF minted for an attachment, under assertPresignedDevUrl.
// One file an area under api/ (core.ts: the types, the ledger kinds, the transport); this composes them. A new
// method goes in its area’s file — or a new area file, added below — so lanes don’t all edit one file.
export * from './api/core';
import { makeCore, type ApiDeps } from './api/core';
import { tasksReads, tasksWrites } from './api/tasks';
import { leetcodeReads, leetcodeWrites } from './api/leetcode';
import { logReads, logWrites } from './api/log';
import { attachmentsReads, attachmentsWrites } from './api/attachments';
import { placesReads, placesWrites } from './api/places';
import { financeReads, financeWrites } from './api/finance';
import { pushReads, pushWrites } from './api/push';

export function createApiClient(deps: ApiDeps) {
  const c = makeCore(deps);
  const reads = {
    ...tasksReads(c),
    ...leetcodeReads(c),
    ...logReads(c),
    ...attachmentsReads(c),
    ...placesReads(c),
    ...financeReads(c),
    ...pushReads(c),
  };
  const writes = {
    ...tasksWrites(c, reads),
    ...leetcodeWrites(c, reads),
    ...logWrites(c),
    ...attachmentsWrites(c),
    ...placesWrites(c),
    ...financeWrites(c),
    ...pushWrites(c),
  };
  return { reads, writes, throttles: c.throttles };
}

export type Reads = ReturnType<typeof tasksReads> &
  ReturnType<typeof leetcodeReads> &
  ReturnType<typeof logReads> &
  ReturnType<typeof attachmentsReads> &
  ReturnType<typeof placesReads> &
  ReturnType<typeof financeReads> &
  ReturnType<typeof pushReads>;

export type ApiClient = ReturnType<typeof createApiClient>;
