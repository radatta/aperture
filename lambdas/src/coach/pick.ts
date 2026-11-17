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
  let queued = false;
  const row = await repo.casUpdate(
    shape,
    e.day,
    (cur) => {
      // A claim that waited too long (a throttle) is given up without a call: readers are near the stale mark.
      queued =
        cur.ai?.status === 'pending' &&
        cur.ai.claimId === e.claimId &&
        cur.ai.startedAt === null &&
        t0 - cur.ai.claimedAt > AI_PICK_QUEUE_MS;
      return queued ? null : startAiRow(cur, e.claimId, t0);
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
  // Not this claim's start (another claim, already started, or stale): someone else owns the day's one call.
  if (row.ai?.claimId !== e.claimId || row.ai.startedAt !== t0) return 'not-ours';

  const ci = await readCoachInput(repo, e.day, d.now());
  const ctx = coachPickContext(ci);
  let res: CoachPickResult;
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
  const settled = await settle(res);
  if (settled.ai?.claimId !== e.claimId || settled.ai.settledAt === null) return 'lost';
  if (settled.ai.status === 'ok' && settled.ai.focus) await applyFocus(d, e, settled.ai.focus.to);
  return settled.ai.status === 'ok' ? 'ok' : 'fallback';
}

// The focus change, after the day row: if this write fails the view shows no change (focusChange needs the row).
async function applyFocus(d: CoachPickDeps, e: CoachPickEvent, pattern: CoachFocus['pattern']) {
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
    (cur) => ({ ...fresh, createdAt: cur.createdAt }),
    now,
    { allowDeleted: true, create: () => fresh },
  );
}
