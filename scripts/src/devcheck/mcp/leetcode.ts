// The dev check’s MCP client (mcp.ts), leetcode: the LeetCode coach: sittings, problems, the catalog, slots,
// focus, voids and attempts.
// Its internals come from core.ts under the names the bodies use.
import {
  COACH_ATTEMPT_VIA,
  COACH_FOCUS_VIA,
  COACH_SLOT_VIA,
  MOCK_VIA,
  type DevCoachToday,
  type DevMock,
  coachFocusId,
  coachSlotId,
} from '../api';
import { DevcheckError } from '../errors';
import { pendingIds } from '../ledger';
import {
  type Core,
  type DevCoachStats,
  type DevFocusSet,
  type DevLiveSitting,
  type DevLoggedAttempt,
  type DevLoggedMock,
  type DevMcpCatalogStatus,
  type DevNotesSaved,
  type DevPeeked,
  type DevProblemRead,
  type DevProblemRow,
  type DevSittingRead,
  type DevSittingRow,
  type DevVoided,
  McpRpcError,
  PARAM_ERROR,
  type ToolResult,
} from './core';

export function leetcodeReads(c: Core) {
  const { data } = c;
  const reads = {
    // live_sitting (lambdas/src/mcp/leetcodeTools.ts): the one read that counts itself — on the open sitting
    // only, which in the dev check is always the scenario's own; its cleanup tombstones that count with it.
    liveSitting: (args: Record<string, unknown> = {}) => data<DevLiveSitting>('live_sitting', args),
    // get_sitting / list_sittings (PR C): pure reads.
    getSitting: (args: Record<string, unknown> = {}) => data<DevSittingRead>('get_sitting', args),
    listSittings: (args: Record<string, unknown> = {}) =>
      data<{ sittings: DevSittingRow[]; more: boolean }>('list_sittings', args),
    leetcodeToday: (args: Record<string, unknown> = {}) =>
      data<DevCoachToday>('leetcode_today', args),
    // The coach's history, stats and story reads: pure reads, args as given.
    listProblems: (args: Record<string, unknown> = {}) =>
      data<{ today?: string; problems: DevProblemRow[]; more: boolean; note?: string }>(
        'list_problems',
        args,
      ),
    getProblem: (args: Record<string, unknown>) => data<DevProblemRead>('get_problem', args),
    catalogStatus: () => data<DevMcpCatalogStatus>('catalog_status', {}),
    listMocks: (args: Record<string, unknown> = {}) =>
      data<{
        mocks: DevMock[];
        total: number;
        doneCount: number;
        trend: { day: string; code: number; solve: number }[];
      }>('list_mocks', args),
    coachStats: (args: Record<string, unknown> = {}) => data<DevCoachStats>('coach_stats', args),
  };
  return reads;
}

export function leetcodeWrites(c: Core) {
  const {
    ledger,
    run,
    tool,
    data,
    refusedBeforeWrite,
    assertLedger,
    assertMineOrUnknown,
    sittingIdsOf,
  } = c;
  const writes = {
    // import_catalog (lc-catalog): the stage's full problem catalog — public metadata, not the test user's data, so
    // not ledgered (DEV-CHECK.md → Ledgers); the next run reuses it. Returns the status the tool reads back.
    importCatalog: (args: Record<string, unknown> = {}) =>
      data<DevMcpCatalogStatus>('import_catalog', args),
    async markPeeked(args: Record<string, unknown>): Promise<DevPeeked> {
      if (typeof args.sittingId === 'string') assertLedger(args.sittingId, 'sitting');
      const title = `peek ${String(args.slug ?? args.sittingId)}`;
      ledger.append({ run, op: 'intent', via: COACH_ATTEMPT_VIA, title });
      let out: DevPeeked;
      try {
        out = await data<DevPeeked>('mark_peeked', args);
      } catch (err) {
        if (refusedBeforeWrite(err))
          ledger.append({ run, op: 'refused', via: COACH_ATTEMPT_VIA, title });
        throw err; // anything else may have written: the intent stays open, reported as an orphan
      }
      // On a sitting there is no attempt: the intent resolves as a refusal (nothing of its kind was made).
      if (out.attemptId)
        ledger.append({ run, op: 'created', id: out.attemptId, via: COACH_ATTEMPT_VIA, title });
      else ledger.append({ run, op: 'refused', via: COACH_ATTEMPT_VIA, title });
      return out;
    },
    // mark_peeked on an id that isn't the user's: must be refused, so nothing can be written (lc-coach ownership).
    markPeekedUnknown: (unknownId: string) =>
      data<DevPeeked>('mark_peeked', { sittingId: unknownId }),
    setCauseTagUnknown: (unknownId: string) =>
      data<unknown>('set_cause_tag', { sittingId: unknownId, cause: 'boundary' }),
    async setCauseTag(
      args: Record<string, unknown>,
    ): Promise<{ sittingId: string; review: unknown }> {
      if (typeof args.sittingId !== 'string')
        throw new DevcheckError('LEDGER_GUARD', 'set_cause_tag needs a recorded sittingId here');
      assertLedger(args.sittingId, 'sitting');
      return data('set_cause_tag', args);
    },
    // swap or skip on today's slot `origin` (the engine's pick); a restore resolves the recorded change.
    async swapSlot(
      day: string,
      origin: string,
      args: Record<string, unknown>,
    ): Promise<DevCoachToday> {
      const id = coachSlotId(run, day, origin);
      if (args.action === 'restore') {
        assertLedger(id, 'coachSlot');
        const t = await data<DevCoachToday>('swap_slot', args);
        ledger.append({ run, op: 'deleted', id });
        return t;
      }
      if (!pendingIds(ledger.read()).includes(id))
        ledger.append({ run, op: 'created', id, via: COACH_SLOT_VIA, title: origin });
      return data<DevCoachToday>('swap_slot', args);
    },
    // The focus override, as api.ts's setCoachFocus: recorded before setting it, resolved when cleared.
    async setFocusPattern(pattern: unknown): Promise<DevFocusSet> {
      const id = coachFocusId(run);
      const fresh = typeof pattern === 'string' && !pendingIds(ledger.read()).includes(id);
      if (fresh) ledger.append({ run, op: 'created', id, via: COACH_FOCUS_VIA, title: pattern });
      let out: DevFocusSet;
      try {
        out = await data<DevFocusSet>('set_focus_pattern', { pattern });
      } catch (err) {
        // Refused at the param check: nothing was set, so the record this call made resolves now.
        if (fresh && err instanceof McpRpcError && err.code === PARAM_ERROR)
          ledger.append({ run, op: 'deleted', id });
        throw err;
      }
      if (pattern === null && ledger.has(id)) ledger.append({ run, op: 'deleted', id });
      return out;
    },
    // set_void on sittings this run started (coach-fixes): the void is the review's test flag on the head, so it
    // goes with the sitting at cleanup — nothing new to record.
    async setVoid(targets: { sittingId: string; void: boolean }[]): Promise<DevVoided> {
      for (const t of targets) assertLedger(t.sittingId, 'sitting');
      return data<DevVoided>('set_void', { targets });
    },
    // A set_void the server must refuse — targets as given: an id no row has, a legacy day (dev has no legacy rows:
    // nothing writes lc#), a malformed target, beside this run's own sittings to prove all-or-nothing. Answers the
    // tool's result; a param error throws McpRpcError. Only a regression could write, and only on this run's rows.
    async setVoidRefused(targets: Record<string, unknown>[]): Promise<ToolResult> {
      await assertMineOrUnknown(sittingIdsOf(targets));
      return tool('set_void', { targets });
    },
    // set_claude_notes on sittings this run started: the notes live on the sitting's head and go with it.
    async setClaudeNotes(
      notes: { sittingId: string; text: string | null }[],
    ): Promise<DevNotesSaved> {
      for (const n of notes) assertLedger(n.sittingId, 'sitting');
      return data<DevNotesSaved>('set_claude_notes', { notes });
    },
    // A set_claude_notes the server must refuse (over the cap, an open sitting, an id no row has), as setVoidRefused.
    async setClaudeNotesRefused(notes: Record<string, unknown>[]): Promise<ToolResult> {
      await assertMineOrUnknown(sittingIdsOf(notes));
      return tool('set_claude_notes', { notes });
    },
    // delete_attempt on an attempt this run logged; the ledger resolves when the tool says it went.
    async deleteAttempt(
      id: string,
    ): Promise<{ id: string; deleted: boolean; slug?: string; nextDue?: unknown }> {
      assertLedger(id, 'coachAttempt');
      const out = await data<{ id: string; deleted: boolean; slug?: string }>('delete_attempt', {
        id,
      });
      if (out.deleted) ledger.append({ run, op: 'deleted', id });
      return out;
    },
    // delete_attempt on an id this run never logged: must write nothing (lc-coach mcp-b-bad-args).
    deleteAttemptUnknown: (unknownId: unknown) =>
      data<{ id: string; deleted: boolean }>('delete_attempt', { id: unknownId }),
    // log_mock: a new mock is recorded from its answer (an intent first, a refusal before any write resolves it);
    // one naming an id must name a mock this run recorded.
    async logMock(input: Record<string, unknown>): Promise<DevLoggedMock> {
      if (input.id !== undefined) {
        assertLedger(String(input.id), 'mock');
        return data<DevLoggedMock>('log_mock', input);
      }
      const title = `mock ${String(input.status ?? 'done')} ${String(input.day ?? 'today')}`;
      ledger.append({ run, op: 'intent', via: MOCK_VIA, title });
      let out: DevLoggedMock;
      try {
        out = await data<DevLoggedMock>('log_mock', input);
      } catch (err) {
        if (refusedBeforeWrite(err)) ledger.append({ run, op: 'refused', via: MOCK_VIA, title });
        throw err;
      }
      ledger.append({ run, op: 'created', id: out.mock.id, via: MOCK_VIA, title });
      return out;
    },
    async logAttempt(
      attempts: Record<string, unknown>[],
    ): Promise<{ attempts: DevLoggedAttempt[] }> {
      const title = `log ${attempts.map((a) => String(a.slug)).join(',')}`;
      ledger.append({ run, op: 'intent', via: COACH_ATTEMPT_VIA, title });
      let out: { attempts: DevLoggedAttempt[] };
      try {
        out = await data<{ attempts: DevLoggedAttempt[] }>('log_attempt', { attempts });
      } catch (err) {
        if (refusedBeforeWrite(err))
          ledger.append({ run, op: 'refused', via: COACH_ATTEMPT_VIA, title });
        throw err;
      }
      for (const a of out.attempts)
        ledger.append({ run, op: 'created', id: a.id, via: COACH_ATTEMPT_VIA, title });
      return out;
    },
  };
  return writes;
}
