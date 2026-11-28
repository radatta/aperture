// The dev check’s BFF client (api.ts), leetcode: the LeetCode coach: rolls, sittings, the coach’s day,
// attempts, floor and focus.
// Its internals come from core.ts under the names the bodies use.
import { AUTH_HEADER, assertDevOrigin, targetOrigin } from '../config';
import { pendingIds } from '../ledger';
import type { Reads } from '../api';
import {
  COACH_ATTEMPT_VIA,
  COACH_FLOOR_VIA,
  COACH_FOCUS_VIA,
  type Core,
  type DevCatalogStatus,
  type DevCoachAttempt,
  type DevCoachAttemptInput,
  type DevCoachDay,
  type DevCoachStats,
  type DevCoachToday,
  type DevCoachVoid,
  type DevMock,
  type DevProblemRecord,
  type DevReviewDraft,
  type DevRoll,
  type DevSettings,
  type DevSitting,
  type DevSittingDetail,
  type DevSittingEvent,
  type DevSittingReview,
  type DevSittingStart,
  LC_ROLL_LINK_VIA,
  ROLL_VIA,
  SITTING_REP_VIA,
  SITTING_VIA,
  coachFloorId,
  coachFocusId,
  coachSlotOf,
  lcRollLinkId,
  ledgerKind,
  rollInput,
} from './core';

export function leetcodeReads(c: Core) {
  const { fetch, token, backoff, call } = c;
  const reads = {
    listRolls: () => call<DevRoll[]>('listRolls', []),
    listSittings: () => call<DevSitting[]>('listSittings', []),
    getCoachToday: () => call<DevCoachToday>('getCoachToday', []),
    listProblemRecords: () => call<DevProblemRecord[]>('listProblemRecords', []),
    getCatalogStatus: () => call<DevCatalogStatus>('getCatalogStatus', []),
    getCoachStats: () => call<DevCoachStats>('getCoachStats', []),
    listMocks: () => call<DevMock[]>('listMocks', []),
    // The coach's stored attempts, alive (the export's; the test user's are a handful). A whole-partition export:
    // cleanup asks it once per pass, never once per id (pipeline.ts exists, F319).
    listCoachAttempts: async () =>
      (await call<{ coachAttempts: DevCoachAttempt[] }>('exportData', [])).coachAttempts,
    // The stored focus override row, held or not (the plan's `focus.source` says only whether it still holds).
    getCoachFocusRow: async () =>
      (
        await call<{
          coachFocus: { pattern: string; sinceDay: string; source?: 'override' | 'ai' } | null;
        }>('exportData', [])
      ).coachFocus,
    // The legacy groups' stored void states (coach-fixes) — the export's. Dev has no legacy rows (nothing writes
    // lc# since PR 147), so set_void on a legacy day is refused there and this stays empty.
    listCoachVoids: async () =>
      (await call<{ coachVoids?: DevCoachVoid[] }>('exportData', [])).coachVoids ?? [],
    // One day's stored coach row (the floor, the slot changes, the AI pick) — the export's; null when none.
    getCoachDay: async (day: string) =>
      (await call<{ coachDays: DevCoachDay[] }>('exportData', [])).coachDays.find(
        (d) => d.day === day,
      ) ?? null,
    getSitting: (id: string) => call<DevSittingDetail>('getSitting', [id]),
    // The Haiku draft (PR C): a model call that writes nothing — a read here, one real call per use.
    draftSittingReview: (id: string) => call<DevReviewDraft>('draftSittingReview', [id]),
    listSittingReplay: (id: string) =>
      call<{ id: string; events: string }[]>('listSittingReplay', [id]),
    // PR D's probe: the removed legacy write, posted with no input — a server that still had the method fails
    // on the missing input instead of writing a row. Returns the raw answer (call() throws on a non-200).
    legacyWriteProbe: (bearer: 'jwt' | 'bogus-device') => {
      const url = `${targetOrigin()}/api/recordLeetcodeAttempt`;
      assertDevOrigin(url);
      return backoff(() =>
        fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [AUTH_HEADER]: `Bearer ${bearer === 'jwt' ? token() : 'devcheck-not-a-device-token'}`,
          },
          body: JSON.stringify({ args: [] }),
        }),
      );
    },
  };
  return reads;
}

export function leetcodeWrites(c: Core, reads: Reads) {
  const { ledger, run, call, assertLedger } = c;
  const writes = {
    // The lc-sittings scenario's roll, recorded from the create response.
    async upsertRoll(input: { name: string; estimateMin: number }): Promise<DevRoll> {
      ledger.append({ run, op: 'intent', via: ROLL_VIA, title: input.name });
      const roll = await call<DevRoll>('upsertRoll', [{ ...input, categoryId: null }]);
      ledger.append({ run, op: 'created', id: roll.id, via: ROLL_VIA, title: input.name });
      return roll;
    },
    // Cleanup's "delete": the API has no roll delete, so the recorded roll is archived (ROLL_VIA).
    async archiveRoll(id: string): Promise<void> {
      assertLedger(id, 'roll');
      const roll = (await reads.listRolls()).find((r) => r.id === id);
      if (!roll || !roll.active) return;
      await call<DevRoll>('upsertRoll', [rollInput(roll, false)]);
    },
    // Link one of this run's rolls as the LeetCode roll, or unlink (null). Recorded before the first link.
    async linkLeetcodeRoll(rollId: string | null): Promise<DevSettings> {
      if (rollId) assertLedger(rollId, 'roll');
      const id = lcRollLinkId(run);
      if (!pendingIds(ledger.read()).includes(id))
        ledger.append({
          run,
          op: 'created',
          id,
          via: LC_ROLL_LINK_VIA,
          title: 'leetcode roll link',
        });
      return call<DevSettings>('updateSettings', [{ leetcodeRollId: rollId }]);
    },
    // A Start as the extension sends it — through the JWT (the device token writes into another user's
    // partition: DEV-CHECK.md). The sitting's id IS the input's clientSittingId, so it's recorded before the
    // call (a crash mid-call still leaves it for the sweep); the rep it spawned is recorded from the answer —
    // or, when the answer is lost, from reading the sitting back.
    async lcSittingStart(
      input: DevSittingStart,
    ): Promise<{ sitting: DevSitting; resumed: boolean }> {
      const id = input.clientSittingId;
      if (!ledger.has(id))
        ledger.append({ run, op: 'created', id, via: SITTING_VIA, title: input.problemSlug });
      const recordRep = (s: DevSitting) => {
        if (!ledger.has(s.repTaskId))
          ledger.append({
            run,
            op: 'created',
            id: s.repTaskId,
            via: SITTING_REP_VIA,
            title: `rep ${input.problemSlug}`,
          });
      };
      try {
        const res = await call<{ sitting: DevSitting; resumed: boolean }>('lcSittingStart', [
          input,
        ]);
        if (res.sitting.id === id) recordRep(res.sitting); // a resume of another sitting isn't this run's
        return res;
      } catch (err) {
        const made = (await reads.listSittings().catch(() => [])).find((x) => x.id === id);
        if (made) recordRep(made);
        throw err;
      }
    },
    async setSittingPrepTarget(id: string, prepTarget: string): Promise<DevSitting> {
      assertLedger(id, 'sitting');
      return call<DevSitting>('setSittingPrepTarget', [id, prepTarget]);
    },
    async setSittingReview(id: string, review: DevSittingReview): Promise<DevSitting> {
      assertLedger(id, 'sitting');
      return call<DevSitting>('setSittingReview', [id, review]);
    },
    async lcSittingEvents(sittingId: string, events: DevSittingEvent[]) {
      assertLedger(sittingId, 'sitting');
      return call<{
        accepted: number;
        duplicates: number;
        skipped: number;
        version: number;
        status: string;
      }>('lcSittingEvents', [{ sittingId, events }]);
    },
    // Events for an id no sitting has (a ULID minted by the caller) — the server must refuse them. No row
    // can exist under it, so the ledger guard has nothing to protect.
    lcSittingEventsToUnknown: (unknownId: string, events: DevSittingEvent[]) =>
      call<unknown>('lcSittingEvents', [{ sittingId: unknownId, events }]),
    // The same for a review: aimed at an id that isn't the user's, so it must be refused (rev-ownership).
    setSittingReviewToUnknown: (unknownId: string, review: DevSittingReview) =>
      call<unknown>('setSittingReview', [unknownId, review]),
    // Today's floor choice: recorded before turning it on (coachFloorId), resolved when turned off.
    async setCoachFloor(day: string, on: boolean): Promise<DevCoachToday> {
      const id = coachFloorId(run, day);
      if (on && !pendingIds(ledger.read()).includes(id))
        ledger.append({ run, op: 'created', id, via: COACH_FLOOR_VIA, title: 'floor' });
      const t = await call<DevCoachToday>('setCoachFloor', [on]);
      if (!on && ledger.has(id)) ledger.append({ run, op: 'deleted', id });
      return t;
    },
    // The focus override: recorded before setting it (coachFocusId), resolved when cleared.
    async setCoachFocus(
      pattern: string | null,
    ): Promise<{ pattern: string; sinceDay: string } | null> {
      const id = coachFocusId(run);
      if (pattern !== null && !pendingIds(ledger.read()).includes(id))
        ledger.append({ run, op: 'created', id, via: COACH_FOCUS_VIA, title: pattern });
      const f = await call<{ pattern: string; sinceDay: string } | null>('setCoachFocus', [
        pattern,
      ]);
      if (pattern === null && ledger.has(id)) ledger.append({ run, op: 'deleted', id });
      return f;
    },
    // Today's AI pick (lc-coach-ai). It claims the day row's `ai` once, ever, and the worker settles it: the day row
    // has no delete and the pick can't be undone, so that is not ledgered — nothing cleanup could remove (the
    // setting it needs is put back by its step's `finally`, and by every run after the sweep). What it can leave
    // that cleanup can undo is the focus: an `ok` pick may move it (source 'ai'), so `coach-focus:<run>` is recorded
    // before the call, as setCoachFocus does — removing it clears the override; with no focus moved it reads gone.
    // A pick the app starts itself (the Today card's first read) is recorded the same way, by the step, before the
    // page opens: recordCoachPickFocus.
    recordCoachPickFocus(): void {
      const id = coachFocusId(run);
      if (!pendingIds(ledger.read()).includes(id))
        ledger.append({ run, op: 'created', id, via: COACH_FOCUS_VIA, title: 'ai pick focus' });
    },
    // `off`: the setting is off, so nothing can move the focus — no ledger line (cleanup would otherwise clear a
    // focus row this run never wrote).
    async startCoachPick(opts: { off?: boolean } = {}): Promise<DevCoachToday> {
      if (!opts.off) writes.recordCoachPickFocus();
      return call<DevCoachToday>('startCoachPick', []);
    },
    // The full catalog's import (lc-catalog): stage-wide public metadata, not the test user's data, so not ledgered —
    // nothing to clean, and the next run's import reuses it (DEV-CHECK.md → Ledgers).
    startCatalogImport: (input: {
      classes?: string;
      part?: number;
      parts?: number;
      limit?: number;
    }) => call<DevCatalogStatus>('startCatalogImport', [input]),
    // Attempts logged through the API, as the app's and log_attempt's path: an intent, then each id from the
    // answer (`coach:attempt`, deleted by deleteCoachAttempt at cleanup); a 4xx is a refusal before any write.
    async logCoachAttempts(inputs: DevCoachAttemptInput[]): Promise<DevCoachAttempt[]> {
      const title = `log ${inputs.map((a) => a.slug).join(',')}`;
      ledger.append({ run, op: 'intent', via: COACH_ATTEMPT_VIA, title });
      let out: DevCoachAttempt[];
      try {
        out = await call<DevCoachAttempt[]>('logCoachAttempts', [inputs]);
      } catch (err) {
        if (/→ HTTP 4\d\d/.test(String(err)))
          ledger.append({ run, op: 'refused', via: COACH_ATTEMPT_VIA, title });
        throw err;
      }
      for (const a of out)
        ledger.append({ run, op: 'created', id: a.id, via: COACH_ATTEMPT_VIA, title });
      return out;
    },
    // The Reopen button's write, on an idle-closed sitting this run started.
    async reopenSitting(id: string): Promise<DevSitting> {
      assertLedger(id, 'sitting');
      return call<DevSitting>('reopenSitting', [id]);
    },
    // The coach's partial review write (cause, help, test) on a sitting this run started.
    async patchSittingReview(
      id: string,
      patch: { cause?: string | null; help?: string; test?: boolean },
    ): Promise<DevSitting> {
      assertLedger(id, 'sitting');
      return call<DevSitting>('patchSittingReview', [id, patch]);
    },
    // Cleanup's removal of an attempt the ledger recorded (from log_attempt's or mark_peeked's answer).
    async deleteCoachAttempt(id: string): Promise<void> {
      assertLedger(id, 'coachAttempt');
      await call<null>('deleteCoachAttempt', [id]);
    },
    // Cleanup's removal of a mock the ledger recorded (log_mock's answer, or the app's create).
    async deleteMock(id: string): Promise<void> {
      assertLedger(id, 'mock');
      await call<null>('deleteMock', [id]);
    },
    // Cleanup's removal of a slot change: restore it, today only (coachSlotId).
    async clearCoachFloor(id: string): Promise<void> {
      assertLedger(id, 'coachFloor');
      await call<DevCoachToday>('setCoachFloor', [false]);
    },
    async clearCoachFocus(id: string): Promise<void> {
      assertLedger(id, 'coachFocus');
      await call<null>('setCoachFocus', [null]);
    },
    async restoreCoachSlot(id: string): Promise<void> {
      assertLedger(id, 'coachSlot');
      const { slug } = coachSlotOf(id);
      await call<DevCoachToday>('setCoachSlot', [{ slug, action: 'restore' }]);
    },
    async deleteSitting(id: string): Promise<void> {
      assertLedger(id, 'sitting');
      await call<null>('deleteSitting', [id]);
    },
    // Cleanup's removal: the sitting AND its rep when the rep is on a roll this harness made — a rep the Start
    // spawned but the ledger never heard of (a lost answer, a killed run) is still this run's to remove.
    async removeSitting(id: string): Promise<void> {
      assertLedger(id, 'sitting');
      const s = (await reads.listSittings()).find((x) => x.id === id);
      if (s && ledger.has(s.rollId) && ledgerKind(ledger.read(), s.rollId) === 'roll') {
        if ((await reads.getTask(s.repTaskId)) !== null)
          await call<null>('deleteTask', [s.repTaskId]);
      }
      await call<null>('deleteSitting', [id]);
    },
    async setRollActive(id: string, active: boolean): Promise<DevRoll> {
      assertLedger(id, 'roll');
      const roll = (await reads.listRolls()).find((r) => r.id === id);
      if (!roll) throw new Error(`roll ${id} isn’t listed`);
      return call<DevRoll>('upsertRoll', [rollInput(roll, active)]);
    },
  };
  return writes;
}
