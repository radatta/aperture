import {
  AI_PICK_QUEUE_MS,
  coachPickContext,
  pickResultOf,
  settleAiRow,
  startAiRow,
} from '@aperture/shared';
import type { CoachDay, CoachFocus, CoachInput, CoachPickResult } from '@aperture/shared';
import type { AnthropicGateway } from '../anthropic/gateway';
import { COACH_PICK_TIMEOUT_MS } from '../anthropic/coachPickPrompt';
import type { Repo } from '../ddb/repo';
import type { CoachPickEvent } from './invoker';

// The coach worker's one job (docs/areas/recruiting/coach.md → The AI pick): for the claim that invoked it — start
// it (once: a redelivered event finds it started), build the context from the rules' pools, make the one call, run
// the answer through the guardrails, settle the day row, and apply a focus change. Every write is a conditional put
// through the repo; the Anthropic gateway writes nothing. AWS-free, so the tests run it inline.

export interface CoachPickDeps {
  repo: Repo;
  anthropic: AnthropicGateway;
  now: () => number;
  log?: (line: string) => void;
}

// What the plan reads, for `day`, strongly consistent (the claim was written a moment ago).
export async function readCoachInput(repo: Repo, day: string, now: number): Promise<CoachInput> {
  const opts = { consistent: true };
  const [settings, sittings, attempts, days, focus] = await Promise.all([
    repo.getSettingsRow(opts),
    repo.listSittings(opts),
    repo.listCoachAttempts(opts),
    repo.listCoachDays(opts),
    repo.getCoachFocus(opts),
  ]);
  return {
    today: day,
    now,
    dayStartHour: settings?.dayStartHour ?? 4,
    sittings,
    attempts,
    days,
    focus,
    aiPick: true,
    aiCanStart: false,
  };
}

export type CoachPickRun = 'not-ours' | 'ok' | 'fallback' | 'lost';

export async function runCoachPick(d: CoachPickDeps, e: CoachPickEvent): Promise<CoachPickRun> {
  const { repo } = d;
  const log = d.log ?? ((line: string) => console.log(line));
  const shape = repo.coachDayShape(e.day);
  const settle = async (res: CoachPickResult): Promise<CoachDay> =>
    repo.casUpdate(shape, e.day, (cur) => settleAiRow(cur, e.claimId, res, d.now()), d.now(), {
      consistent: true,
    });
  const t0 = d.now();
  // Decided inside the CAS step (re-run on a lost race), so the last attempt's verdict is the one that stuck.
  let queued = false;
  let mine = false;
  await repo.casUpdate(
    shape,
    e.day,
    (cur) => {
      // A claim that waited too long (a throttle) is given up without a call: readers are near the stale mark.
      queued =
        cur.ai?.status === 'pending' &&
        cur.ai.claimId === e.claimId &&
        cur.ai.startedAt === null &&
        t0 - cur.ai.claimedAt > AI_PICK_QUEUE_MS;
      const next = queued ? null : startAiRow(cur, e.claimId, t0);
      mine = next !== null;
      return next;
    },
    t0,
    { consistent: true },
  );
  const fail = (reason: 'unavailable', detail: string): CoachPickResult => ({
    ok: false,
    reason,
    detail,
    oldestDue: null,
    model: null,
    usage: null,
    ms: null,
  });
  if (queued) {
    await settle(fail('unavailable', 'queued'));
    log(JSON.stringify({ event: 'coach_pick_skipped', why: 'queued' }));
    return 'fallback';
  }
  // Not this claim's start (another claim, already started, or settled): the day's one call isn't this event's.
  if (!mine) return 'not-ours';

  // From here the day is started: any throw settles it now (with the cause), never a silent 120 s timeout.
  let res: CoachPickResult;
  let focusRead: CoachFocus | null = null;
  try {
    const ci = await readCoachInput(repo, e.day, d.now());
    focusRead = ci.focus;
    const ctx = coachPickContext(ci);
    if (ctx.candidates.length < 2)
      res = { ...fail('unavailable', 'no-candidates'), oldestDue: ctx.oldestDue };
    else {
      const out = await d.anthropic.coachPick({ ctx, timeoutMs: COACH_PICK_TIMEOUT_MS });
      const meta = { model: out.model, usage: out.usage, ms: out.ms };
      res = out.ok
        ? pickResultOf(out.fields, ctx, meta)
        : {
            ok: false,
            reason: out.reason,
            detail: out.detail ?? null,
            oldestDue: ctx.oldestDue,
            ...meta,
          };
      if (!res.ok && res.reason === 'invalid')
        log(JSON.stringify({ event: 'coach_pick_rejected', code: res.detail }));
    }
  } catch (err) {
    log(JSON.stringify({ event: 'coach_pick_error', name: (err as Error).name }));
    res = fail('unavailable', 'error');
  }
  const settled = await settle(res);
  if (settled.ai?.claimId !== e.claimId || settled.ai.settledAt === null) return 'lost';
  if (settled.ai.status === 'ok' && settled.ai.focus)
    await applyFocus(d, e, settled.ai.focus.to, focusRead);
  return settled.ai.status === 'ok' ? 'ok' : 'fallback';
}

// The focus change, after the day row: if this write fails the view shows no change (focusChange needs the row).
// Never over the user's own change: a focus row written since the context read it (a pick on the card during the
// call) wins, and the view then shows no change.
async function applyFocus(
  d: CoachPickDeps,
  e: CoachPickEvent,
  pattern: CoachFocus['pattern'],
  read: CoachFocus | null,
) {
  const now = d.now();
  const fresh: CoachFocus = {
    id: 'focus',
    userId: e.userId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    pattern,
    sinceDay: e.day,
    source: 'ai',
  };
  await d.repo.casUpdate(
    d.repo.coachFocusShape(),
    'focus',
    (cur) => {
      const unchanged = read ? cur.updatedAt === read.updatedAt : cur.deletedAt !== null;
      return unchanged ? { ...fresh, createdAt: cur.createdAt } : null;
    },
    now,
    { allowDeleted: true, create: () => fresh },
  );
}
