// The dev check’s BFF client (api.ts), log: the log, stories and Flux sets.
// Its internals come from core.ts under the names the bodies use.
import { DevcheckError } from '../errors';
import { pendingIds } from '../ledger';
import {
  type Core,
  type DevFluxSet,
  type DevFluxSetInput,
  type DevLogEntry,
  type DevStory,
  FLUX_SET_VIA,
  LOG_VIA,
  STORY_VIA,
} from './core';

export function logReads(c: Core) {
  const { call } = c;
  const reads = {
    listFluxSets: () => call<DevFluxSet[]>('listFluxSets', [{}]),
    listLogEntries: (day: string) => call<DevLogEntry[]>('listLogEntries', [day]),
    listStories: () => call<DevStory[]>('listStories', []),
    // The user's own download (Settings → Export) — read only for its log entries.
    exportLogEntries: async () =>
      (await call<{ logEntries: DevLogEntry[] }>('exportData', [])).logEntries,
    // Alive entries, oldest first; {} is the whole log (the test user's is small).
    listLogRange: (range: { from?: string; to?: string }) =>
      call<DevLogEntry[]>('listLogRange', [range]),
    // The weekly note (D62): a read that may write the cached row — the app's own read, not a scenario write.
    getFluxWeekNote: () =>
      call<{ weekStart: string; text: string; generatedAt: number } | null>('getFluxWeekNote', []),
    // Alive only — a deleted set reads as gone, like getTask.
    getFluxSet: async (id: string) =>
      (await call<DevFluxSet[]>('listFluxSets', [{}])).find((f) => f.id === id) ?? null,
  };
  return reads;
}

export function logWrites(c: Core) {
  const { ledger, run, call, assertLedger } = c;
  const writes = {
    // The id is known before the call (the client mints it), so `created` is recorded first: a crash
    // mid-call still leaves the id for the next run's sweep.
    async recordFluxSet(input: DevFluxSetInput): Promise<DevFluxSet> {
      const title = `flux ${input.exerciseId}`;
      if (!pendingIds(ledger.read()).includes(input.id))
        ledger.append({ run, op: 'created', id: input.id, via: FLUX_SET_VIA, title });
      return call<DevFluxSet>('recordFluxSet', [input]);
    },
    async createLogEntry(
      text: string,
      day: string,
      opts?: { private?: boolean },
    ): Promise<DevLogEntry> {
      ledger.append({ run, op: 'intent', via: LOG_VIA, title: text });
      const entry = await call<DevLogEntry>(
        'createLogEntry',
        opts ? [text, day, opts] : [text, day],
      );
      ledger.append({ run, op: 'created', id: entry.id, via: LOG_VIA, title: text });
      return entry;
    },
    async createStory(title: string): Promise<DevStory> {
      ledger.append({ run, op: 'intent', via: STORY_VIA, title });
      const story = await call<DevStory>('createStory', [{ title }]);
      ledger.append({ run, op: 'created', id: story.id, via: STORY_VIA, title });
      return story;
    },
    async updateStory(
      id: string,
      patch: {
        title?: string;
        situation?: string;
        action?: string;
        result?: string;
        competencyTags?: string[];
      },
    ): Promise<DevStory> {
      assertLedger(id, 'story');
      return call<DevStory>('updateStory', [id, patch]);
    },
    async deleteStory(id: string): Promise<void> {
      assertLedger(id, 'story');
      await call<null>('deleteStory', [id]);
    },
    async deleteLogEntry(id: string): Promise<void> {
      assertLedger(id, 'log');
      await call<null>('deleteLogEntry', [id]);
    },
    // Raw args: the private-log scenario sends a non-boolean on purpose to prove it's refused.
    async setLogEntryPrivate(id: string, isPrivate: unknown): Promise<DevLogEntry> {
      assertLedger(id, 'log');
      return call<DevLogEntry>('setLogEntryPrivate', [id, isPrivate]);
    },
    async updateLogEntry(id: string, text: string): Promise<DevLogEntry> {
      assertLedger(id, 'log');
      return call<DevLogEntry>('updateLogEntry', [id, text]);
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
  };
  return writes;
}
