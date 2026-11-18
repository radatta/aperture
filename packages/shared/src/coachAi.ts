// The LeetCode coach's AI pick (docs/areas/recruiting/coach.md → The AI pick): Opus picks the day's problems from the
// rules' own candidates, and these pure folds keep it honest — the candidates and the context it reads, the
// guardrails its answer must pass (never trusted, always checked here), the stand-in the stub uses, and the day
// row's claim → start → settle steps, shared by the stub and the Lambda so the two can't drift.

import {
  AI_PICK_STALE_MS,
  COACH_PARAMS,
  coachPools,
  coachScope,
  coachStats,
  pickable,
  planDay,
} from './coach';
import { catalogProblem } from './catalogs';
import type { CoachInput, CoachParams, CoachToday } from './coach';
import { addDays } from './dates';
import { NEETCODE_150, PATTERN_NAMES } from './neetcode150';
import type { Difficulty, PatternId } from './neetcode150';
import { sittingElapsedMs } from './sittings';
import type {
  AttemptOutcome,
  CauseTag,
  CoachAiPick,
  CoachAiReason,
  CoachDay,
  CoachDayAi,
  Settings,
  SlotKind,
} from './types';

export const AI_PICK_MAX = 4;
export const AI_WHY_MAX = 140;
export const AI_NOTE_MAX = 240;
// The worker gives up without calling when its event waited longer than this (a queue behind a throttle).
export const AI_PICK_QUEUE_MS = 20_000;
const CAPS = { due: 15, fresh: 5, stretch: 3, ifFocus: 3 };
const RECENT_DAYS = 14;
const NOTE_MAX = 160; // each attempt's notes sent
const CLAUDE_NOTES_SENT_MAX = 300; // each attempt's Claude's notes sent

// A slot change while the pick is still landing (the slots are about to be replaced).
export const AI_PICK_BUSY_ERROR = 'Today’s problems are still being picked — try again in a moment';

export const coachAiPickOn = (s: Pick<Settings, 'coachAiPick'>): boolean => s.coachAiPick !== false;

// --- What the model sees ---
export interface CoachAiCandidate {
  slug: string;
  title: string;
  pattern: PatternId;
  difficulty: Difficulty | null;
  kind: SlotKind;
  ifFocus: PatternId | null; // only with a focus change to this pattern
  rule: string; // the rules' own reason for it
  history: {
    tries: number;
    lastDay: string;
    lastOutcome: AttemptOutcome;
    cause: CauseTag | null;
    peeked: boolean;
  } | null;
}
export interface CoachAiRecent {
  day: string;
  slug: string;
  pattern: PatternId;
  difficulty: Difficulty | null;
  outcome: AttemptOutcome;
  help: string;
  cause: CauseTag | null;
  lastError: string | null;
  minutes: number | null;
  capMin: number;
  notes: string | null;
  claudeNotes: string | null; // Claude's own notes on the day's sittings (set_claude_notes), cut
}
export interface CoachPickContext {
  today: string;
  candidates: CoachAiCandidate[];
  rules: string[]; // the rules' own pick, in order — the baseline the model improves on
  focus: { pattern: PatternId; day: number; of: number; locked: boolean };
  top3: PatternId[]; // the focus ranking's top three now; a focus change goes only there
  mustInclude: string | null; // the oldest due re-solve the last AI day skipped
  oldestDue: string | null;
  momentum: CoachToday['momentum'];
  rates: {
    pattern: PatternId;
    firstTry: string; // "hit/of" clean
    resolve: string;
    peeked: number;
    rank: number | null;
  }[];
  recent: CoachAiRecent[]; // the last RECENT_DAYS days, oldest first
  // The plan mode as the rules read it today: a catch-up pick keeps the mix (validateCoachPick → 'mix').
  planMode: { mode: 'balanced' | 'catch-up'; due: number };
}

const cut = (s: string, max: number) => {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

// The newest earlier day whose AI pick landed.
const prevAiDay = (input: CoachInput) =>
  [...input.days]
    .filter((d) => d.day < input.today && d.ai?.status === 'ok')
    .sort((a, b) => b.day.localeCompare(a.day))[0] ?? null;

// The candidates (one kind each, first appearance wins) and the context, cut from the rules' pools.
export function coachPickContext(
  input: CoachInput,
  params: CoachParams = COACH_PARAMS,
): CoachPickContext {
  const { today } = input;
  const pools = coachPools(input, params);
  // The rules' plan before any of today's changes: its picks lead the candidates, with the rules' kinds.
  const rulePlan = planDay(
    { ...input, aiPick: false, days: input.days.filter((d) => d.day !== today) },
    params,
  );
  const { focus, records, seen, ranks } = pools;
  const locked = focus.source !== 'engine'; // a held pick (the user's or the AI's) runs its block out
  const top3 = ranks.slice(0, 3).map((r) => r.pattern);
  const ruleOf = (kind: SlotKind, slug: string) =>
    pools.cands[kind].find((c) => c.slug === slug)?.reason ?? '';
  const out = new Map<string, CoachAiCandidate>();
  const add = (slug: string, kind: SlotKind, ifFocus: PatternId | null, rule: string) => {
    if (out.has(slug)) return;
    const cat = catalogProblem(slug);
    const rec = records.find((r) => r.slug === slug);
    out.set(slug, {
      slug,
      title: cat?.title ?? rec?.title ?? slug,
      pattern: cat?.pattern ?? rec?.pattern ?? 'other',
      difficulty: cat?.difficulty ?? rec?.difficulty ?? null,
      kind,
      ifFocus,
      rule,
      history: rec
        ? {
            tries: rec.attempts,
            lastDay: rec.lastDay,
            lastOutcome: rec.lastOutcome,
            cause: rec.cause,
            peeked: rec.peeked,
          }
        : null,
    });
  };
  for (const s of rulePlan.slots) add(s.slug, s.kind, null, s.reason);
  for (const c of pools.cands['carry-over']) add(c.slug, 'carry-over', null, c.reason);
  for (const r of pools.due.slice(0, CAPS.due))
    add(r.slug, 're-solve', null, ruleOf('re-solve', r.slug));
  for (const c of pools.fresh.slice(0, CAPS.fresh)) add(c.slug, 'new', null, ruleOf('new', c.slug));
  // Catch-up takes no stretch (coach.ts → Plan mode), so none is offered.
  if (pools.planMode.mode !== 'catch-up')
    for (const c of pools.stretch.slice(0, CAPS.stretch))
      add(c.slug, 'stretch', null, ruleOf('stretch', c.slug));
  if (!locked)
    for (const p of top3.filter((p) => p !== focus.pattern))
      for (const c of NEETCODE_150.filter(
        (c) => c.pattern === p && pickable(c, seen, input.premium === true),
      ).slice(0, CAPS.ifFocus))
        add(c.slug, 'new', p, `New in ${PATTERN_NAMES[p]}, only with the focus moved there`);

  const prev = prevAiDay(input);
  const oldestDue = pools.due[0]?.slug ?? null;
  const skipped = prev?.ai?.oldestDue ?? null;
  const mustInclude =
    skipped && skipped === oldestDue && !prev!.ai!.picks.some((p) => p.slug === skipped)
      ? skipped
      : null;

  const sittingsById = new Map(input.sittings.map((s) => [s.id, s]));
  const attemptsById = new Map(input.attempts.map((a) => [a.id, a]));
  const from = addDays(today, -RECENT_DAYS);
  const recent = pools.before
    .filter((a) => a.day >= from)
    .map((a): CoachAiRecent => {
      const sits = a.sittingIds.flatMap((id) => sittingsById.get(id) ?? []);
      const logged = a.attemptIds.flatMap((id) => attemptsById.get(id) ?? []);
      const ms = sits.reduce((n, s) => n + sittingElapsedMs(s, input.now), 0);
      const manual = logged.reduce((n, m) => n + (m.minutes ?? 0), 0);
      const minutes =
        sits.length || logged.some((m) => m.minutes !== null)
          ? Math.round(ms / 60_000) + manual
          : null;
      const words = [
        ...logged.flatMap((m) => m.note ?? []),
        ...sits.flatMap((s) =>
          [s.review?.insight ?? [], ...(s.review?.mistakes ?? []).slice(0, 3)].flat(),
        ),
      ].filter(Boolean);
      const claude = sits.flatMap((s) => s.claudeNotes?.text ?? []);
      return {
        day: a.day,
        slug: a.slug,
        pattern: a.pattern,
        difficulty: a.difficulty,
        outcome: a.outcome,
        help: a.help,
        cause: a.cause,
        lastError: a.lastError ? (a.lastError.statusMsg ?? a.lastError.verdict) : null,
        minutes,
        capMin: params.capMin,
        notes: words.length ? cut(words.join(' · '), NOTE_MAX) : null,
        claudeNotes: claude.length ? cut(claude.join(' · '), CLAUDE_NOTES_SENT_MAX) : null,
      };
    });
  const stats = coachStats(pools.all, today, {}, coachScope(input));
  return {
    today,
    candidates: [...out.values()],
    focus: { pattern: focus.pattern, day: focus.day, of: focus.of, locked },
    top3,
    mustInclude,
    oldestDue,
    rules: rulePlan.slots.map((s) => s.slug),
    momentum: rulePlan.momentum,
    rates: stats.patterns.map((p) => ({
      pattern: p.pattern,
      firstTry: `${p.firstTry.hit}/${p.firstTry.of}`,
      resolve: `${p.resolve.hit}/${p.resolve.of}`,
      peeked: p.peeked,
      rank: p.rank,
    })),
    recent,
    planMode: { mode: pools.planMode.mode, due: pools.planMode.due },
  };
}

// --- The guardrails: the model's answer → the day's pick, or the code it failed on ---
export type CoachPickAnswer =
  | {
      ok: true;
      picks: CoachAiPick[];
      note: string | null;
      focus: { from: PatternId; to: PatternId; why: string } | null;
      filled: number; // slots the rules filled after a short answer (fillToFull)
    }
  | { ok: false; code: string };

// Any structural break rejects the whole answer (→ the rules, with the notice); only text is repaired. The floor
// is never the model's: it stays the rules'.
export function validateCoachPick(raw: unknown, ctx: CoachPickContext): CoachPickAnswer {
  const fail = (code: string): CoachPickAnswer => ({ ok: false, code });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('shape');
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.picks)) return fail('shape');
  if (r.picks.length < 1 || r.picks.length > AI_PICK_MAX) return fail('count');
  const byslug = new Map(ctx.candidates.map((c) => [c.slug, c]));
  const picks: CoachAiPick[] = [];
  for (const p of r.picks as unknown[]) {
    if (!p || typeof p !== 'object') return fail('shape');
    const { slug, why } = p as Record<string, unknown>;
    if (typeof slug !== 'string' || (why !== undefined && why !== null && typeof why !== 'string'))
      return fail('shape');
    const c = byslug.get(slug);
    if (!c) return fail('not-candidate');
    if (picks.some((x) => x.slug === slug)) return fail('duplicate');
    picks.push({
      slug,
      kind: c.kind,
      why: cut(typeof why === 'string' && why.trim() ? why : c.rule, AI_WHY_MAX),
    });
  }
  if (ctx.mustInclude && !picks.some((p) => p.slug === ctx.mustInclude))
    return fail('skipped-oldest-due');
  let focus: { from: PatternId; to: PatternId; why: string } | null = null;
  if (r.focus !== undefined && r.focus !== null) {
    if (typeof r.focus !== 'object' || Array.isArray(r.focus)) return fail('shape');
    const { to, why } = r.focus as Record<string, unknown>;
    if (typeof to !== 'string' || !ctx.top3.includes(to as PatternId))
      return fail('focus-not-top3');
    if (to === ctx.focus.pattern || ctx.focus.locked) return fail('focus-held');
    focus = {
      from: ctx.focus.pattern,
      to: to as PatternId,
      why: cut(typeof why === 'string' ? why : '', AI_WHY_MAX),
    };
  }
  for (const p of picks) {
    const want = byslug.get(p.slug)!.ifFocus;
    if (want && focus?.to !== want) return fail('if-focus');
  }
  const note = typeof r.note === 'string' && r.note.trim() ? cut(r.note, AI_NOTE_MAX) : null;
  if (r.note !== undefined && r.note !== null && typeof r.note !== 'string') return fail('shape');
  const full = fillToFull(picks, ctx, focus);
  // Catch-up's mix, on the day as filled: at most one new, no stretch, and no fewer re-solves than the rules' plan.
  if (ctx.planMode.mode === 'catch-up') {
    const n = (k: SlotKind, list: readonly { kind: SlotKind }[]) =>
      list.filter((x) => x.kind === k).length;
    const ruleKinds = ctx.rules.flatMap((slug) => byslug.get(slug) ?? []);
    if (
      n('new', full) > 1 ||
      n('stretch', full) > 0 ||
      n('re-solve', full) < n('re-solve', ruleKinds)
    )
      return fail('mix');
  }
  return { ok: true, picks: full, note, focus, filled: full.length - picks.length };
}

// The day is four problems (fewer only when fewer may be picked): a short answer keeps the model's picks in its order
// and takes the rest from the rules' own pick, then the other candidates — each with its rule reason as its why. After a
// focus change, the new focus's problems come before the rest, and the old focus's new ones are out (the day follows
// the move). Never a slot dropped; never anything but a candidate the answer may take. In catch-up the fill keeps the
// mix: no stretch, and a new only while the day has none.
export function fillToFull(
  picks: readonly CoachAiPick[],
  ctx: CoachPickContext,
  focus: { to: PatternId } | null,
): CoachAiPick[] {
  const allowed = ctx.candidates.filter((c) => !c.ifFocus || c.ifFocus === focus?.to);
  const want = Math.min(AI_PICK_MAX, allowed.length);
  const left = (c: CoachAiCandidate) =>
    !(focus && c.kind === 'new' && !c.ifFocus && c.pattern === ctx.focus.pattern);
  const byslug = new Map(allowed.map((c) => [c.slug, c]));
  const pool = [
    ...allowed.filter((c) => focus && c.ifFocus === focus.to),
    ...ctx.rules.flatMap((s) => byslug.get(s) ?? []),
    ...allowed,
  ].filter(left);
  const taken = new Set(picks.map((p) => p.slug));
  const out = [...picks];
  const catchUp = ctx.planMode.mode === 'catch-up';
  for (const c of pool) {
    if (out.length >= want) break;
    if (taken.has(c.slug)) continue;
    if (
      catchUp &&
      (c.kind === 'stretch' || (c.kind === 'new' && out.some((p) => p.kind === 'new')))
    )
      continue;
    taken.add(c.slug);
    out.push({ slug: c.slug, kind: c.kind, why: cut(c.rule || c.kind, AI_WHY_MAX) });
  }
  return out;
}

// The stub's (and the local check's) deterministic stand-in for the model: the rules' own pick, with the rules'
// reasons as its whys and no note — so a stub day reads like the rules' (filled to four when the rules had fewer) —
// plus the skipped oldest due re-solve up front when one is owed. Never a focus change.
export function standInCoachPick(ctx: CoachPickContext): Record<string, unknown> {
  const order = [...new Set([...(ctx.mustInclude ? [ctx.mustInclude] : []), ...ctx.rules])];
  const byslug = new Map(ctx.candidates.map((c) => [c.slug, c]));
  return {
    picks: order.slice(0, AI_PICK_MAX).map((slug) => ({ slug, why: byslug.get(slug)?.rule ?? '' })),
    note: null,
    focus: null,
  };
}

// --- The day row's AI steps (each returns the new row, or null for "nothing to write") ---
const blankAi = (claimId: string, now: number): CoachDayAi => ({
  status: 'pending',
  claimId,
  claimedAt: now,
  startedAt: null,
  settledAt: null,
  model: null,
  picks: [],
  note: null,
  focus: null,
  oldestDue: null,
  reason: null,
  detail: null,
  usage: null,
  ms: null,
});
// One claim a day, ever: a day that has any `ai` is never claimed again (a fallback stays a fallback). Nor one a
// slot change reached first (a change between the plan read and the claim): it's under way on the rules.
export const claimAiRow = (cur: CoachDay, claimId: string, now: number): CoachDay | null =>
  cur.ai || cur.changes.length > 0 ? null : { ...cur, ai: blankAi(claimId, now) };
// The worker's start: only its own live claim, only once (a redelivered event finds `startedAt` set).
export const startAiRow = (cur: CoachDay, claimId: string, now: number): CoachDay | null =>
  cur.ai?.status === 'pending' &&
  cur.ai.claimId === claimId &&
  cur.ai.startedAt === null &&
  now - cur.ai.claimedAt <= AI_PICK_STALE_MS
    ? { ...cur, ai: { ...cur.ai, startedAt: now } }
    : null;

export type CoachPickResult =
  | {
      ok: true;
      picks: CoachAiPick[];
      note: string | null;
      focus: CoachDayAi['focus'];
      filled?: number; // slots the rules filled (logged, not stored)
      mode?: CoachPickContext['planMode']['mode']; // the mix it kept, stored on the day
      oldestDue: string | null;
      model: string | null;
      usage: CoachDayAi['usage'];
      ms: number | null;
    }
  | {
      ok: false;
      reason: CoachAiReason;
      detail: string | null;
      oldestDue: string | null;
      model: string | null;
      usage: CoachDayAi['usage'];
      ms: number | null;
    };
// The result lands only on the claim that asked for it, still pending. One that comes back after readers saw the
// claim go stale is kept as that timeout (with its tokens), so a day never flips from the rules to a pick.
export function settleAiRow(
  cur: CoachDay,
  claimId: string,
  res: CoachPickResult,
  now: number,
): CoachDay | null {
  if (cur.ai?.status !== 'pending' || cur.ai.claimId !== claimId) return null;
  const late = now - cur.ai.claimedAt > AI_PICK_STALE_MS;
  const common = {
    settledAt: now,
    model: res.model,
    oldestDue: res.oldestDue,
    usage: res.usage,
    ms: res.ms,
  };
  return {
    ...cur,
    ai:
      res.ok && !late
        ? {
            ...cur.ai,
            ...common,
            status: 'ok',
            picks: res.picks,
            note: res.note,
            focus: res.focus,
            ...(res.mode ? { mode: res.mode } : {}),
          }
        : {
            ...cur.ai,
            ...common,
            status: 'fallback',
            reason: late ? 'timeout' : (res as Extract<CoachPickResult, { ok: false }>).reason,
            detail: late ? 'late' : (res as Extract<CoachPickResult, { ok: false }>).detail,
          },
  };
}

// The guardrail-checked result of an answer (the model's or the stand-in's).
export function pickResultOf(
  raw: unknown,
  ctx: CoachPickContext,
  meta: { model: string | null; usage: CoachDayAi['usage']; ms: number | null },
): CoachPickResult {
  const v = validateCoachPick(raw, ctx);
  return v.ok
    ? {
        ok: true,
        picks: v.picks,
        note: v.note,
        focus: v.focus,
        filled: v.filled,
        mode: ctx.planMode.mode,
        ...meta,
        oldestDue: ctx.oldestDue,
      }
    : { ok: false, reason: 'invalid', detail: v.code, oldestDue: ctx.oldestDue, ...meta };
}
