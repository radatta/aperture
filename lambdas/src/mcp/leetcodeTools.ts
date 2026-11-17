import {
  hasReviewWords,
  isDayKey,
  msToMin,
  isUlid,
  problemCompanies,
  problemStatementText,
  timelineOf,
  judgeDetail,
  lcLangName,
  sittingMetrics,
  sittingMinutes,
  sittingProblemUrl,
  verdictOf,
  isSittingOpen,
  SITTING_INGEST_WINDOW_MS,
} from '@aperture/shared';
import type {
  LiveSittingPull,
  Sitting,
  SittingDetail,
  SittingEvent,
  SittingVerdict,
} from '@aperture/shared';
import { slotOfSitting, todayOrNull } from './coachTools';
import { RpcParamError } from './types';
import type { Tool } from './types';

// LeetCode sittings for Claude (docs/areas/recruiting → Claude watches live, Reading a sitting back; docs/areas/mcp
// → Tools). live_sitting is not read-only: each pull of an open sitting writes its own count ("Claude watched live"
// on the sitting) — nothing else. get_sitting and list_sittings only read.

// How fresh the capture is — the extension's pacing (PR A2: extension/src/lib/batch.js), in the description and
// on every answer, so the model never reads a 30-second-old snapshot as the whole truth.
const FRESHNESS =
  'Code arrives as snapshots at most once per 30 s (the latest code) and right before each Run or Submit, so it can be up to ~30 s behind what is on screen. A Run or Submit judged after they leave the page still lands in its sitting.';

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const agoSec = (ms: number | null, now: number) =>
  ms === null ? null : Math.max(0, Math.round((now - ms) / 1000));
const minutes = (ms: number | null) => (ms === null ? null : msToMin(ms));

const problemOf = (s: Sitting) => ({
  title: s.problemTitle,
  slug: s.problemSlug,
  url: sittingProblemUrl(s.problemSlug),
  difficulty: s.difficulty,
  tags: s.topicTags ?? [],
});

const outcomeOf = (s: Sitting) => {
  const m = sittingMetrics(s);
  return {
    firstSubmitAccepted: m.firstSubmitAccepted,
    submitsBeforeAccepted: m.submitsBeforeAccepted,
    timeToFirstSubmitMin: minutes(m.timeToFirstSubmitMs),
  };
};

// A judged Run or Submit: its verdict and what its payload says beyond it — failing case, expected vs output,
// the error head. The verdict is read from the payload when it's in hand, so a summary folded under an older
// rule is never shown over it; else the summary the pull folded from the same head rows that named this event
// as newest. A payload that never landed leaves `detail` null rather than borrowing an older one's.
function judged(
  v: SittingVerdict | null,
  e: SittingEvent | null,
  type: 'run' | 'submit',
  now: number,
) {
  const verdict = (e ? verdictOf(e.payload, e.at, type) : null) ?? v;
  if (!verdict && !e) return null;
  const at = verdict?.at ?? e?.at ?? null;
  return {
    verdict: verdict?.verdict ?? null,
    statusMsg: verdict?.statusMsg ?? null,
    passed: verdict?.passed ?? null,
    total: verdict?.total ?? null,
    at: iso(at),
    agoSec: agoSec(at, now),
    detail: e ? judgeDetail(e.payload) : null,
  };
}

function active(pull: LiveSittingPull & { sitting: Sitting }, now: number, since: number | null) {
  const { sitting: s, live } = pull;
  const t = s.summary.lcTimer;
  const f = live?.facts ?? null;
  const version = live?.version ?? 0;
  return {
    active: true,
    sitting: {
      id: s.id,
      problem: problemOf(s),
      lang: s.lang,
      startedAt: iso(s.startedAt),
      elapsedMin: sittingMinutes(s, now),
      status: s.status,
      prepTarget: s.prepTarget,
      liveReads: pull.liveReads,
    },
    code: {
      version,
      text: live?.code ?? null,
      lang: lcLangName(live?.lang) ?? s.lang,
      at: iso(live?.codeAt ?? null),
      ageSec: agoSec(live?.codeAt ?? null, now),
    },
    ...(since !== null ? { unchangedSinceVersion: version === since } : {}),
    runCount: s.summary.runs,
    submitCount: s.summary.submits,
    outcome: outcomeOf(s),
    // The trace before the first Run or Submit (summary.coach): a trace comment in their code reads traced (by
    // `comment`); otherwise the card's state on older sittings; none once judged with neither; null until then.
    trace: s.summary.coach?.trace ?? null,
    traceBy: s.summary.coach?.traceBy ?? null,
    lastRun: judged(s.summary.lastRun, pull.lastRun, 'run', now),
    lastSubmit: judged(s.summary.lastSubmit, pull.lastSubmit, 'submit', now),
    lcTimer: t
      ? {
          mode: t.mode,
          status: t.status,
          elapsedMin: minutes(t.elapsedMs),
          readAgoSec: agoSec(t.at, now),
        }
      : null,
    editing:
      f && f.edits > 0
        ? {
            edits: f.edits,
            lastEditAgoSec: agoSec(f.lastEditAt, now),
            longestStallMin: minutes(f.longestStallMs),
            rewrites: f.rewrites,
          }
        : null,
    extensionSeenAgoSec: agoSec(live?.receivedAt ?? null, now),
    note: FRESHNESS,
  };
}

function inactive(pull: LiveSittingPull, now: number) {
  const s = pull.lastSitting;
  // Left active past its window: closed for capture, ended only by the next Start. Said outright, and its
  // minutes stop at the window instead of growing.
  const expired = !!s && s.status === 'active' && !isSittingOpen(s, now);
  return {
    active: false,
    lastSitting: s
      ? {
          id: s.id,
          problem: problemOf(s),
          status: s.status,
          closedBy: s.closedBy ?? null,
          startedAt: iso(s.startedAt),
          expired,
          endedAt: iso(s.endedAt),
          minutes: sittingMinutes(s, expired ? s.startedAt + SITTING_INGEST_WINDOW_MS : now),
          submitCount: s.summary.submits,
          outcome: outcomeOf(s),
          liveReads: pull.liveReads,
        }
      : null,
    note: 'No sitting is open: they start one with Start on a LeetCode problem page.',
  };
}

// --- Reading a sitting back (get_sitting, list_sittings) ---
const TIMELINE_MAX = 30; // the newest judged entries a get_sitting carries
const CASE_TEXT_MAX = 300; // each case field there
const cap = (s: string | null) =>
  s === null ? null : s.length > CASE_TEXT_MAX ? `${s.slice(0, CASE_TEXT_MAX - 1)}…` : s;
const expiredAt = (s: Sitting, now: number) => s.status === 'active' && !isSittingOpen(s, now);
const minutesOf = (s: Sitting, now: number) =>
  sittingMinutes(s, expiredAt(s, now) ? s.startedAt + SITTING_INGEST_WINDOW_MS : now);

function sittingRow(s: Sitting, now: number) {
  return {
    id: s.id,
    day: s.day,
    problem: { title: s.problemTitle, slug: s.problemSlug, difficulty: s.difficulty },
    status: s.status,
    closedBy: s.closedBy ?? null,
    expired: expiredAt(s, now),
    minutes: minutesOf(s, now),
    submitCount: s.summary.submits,
    outcome: outcomeOf(s),
    prepTarget: s.prepTarget,
    reviewed: hasReviewWords(s.review),
    tags: s.review?.tags ?? [],
  };
}

function sittingRead(d: SittingDetail, now: number) {
  const { sitting: s, live } = d;
  const f = live?.facts ?? null;
  const entries = timelineOf(s, d.events);
  // The newest TIMELINE_MAX judged entries and the markers between them.
  let judgedLeft = TIMELINE_MAX;
  const kept: typeof entries = [];
  for (let i = entries.length - 1; i >= 0 && judgedLeft > 0; i--) {
    const e = entries[i]!;
    if (e.kind === 'judged') judgedLeft--;
    kept.unshift(e);
  }
  return {
    sitting: {
      id: s.id,
      problem: problemOf(s),
      lang: s.lang,
      status: s.status,
      closedBy: s.closedBy ?? null,
      expired: expiredAt(s, now),
      day: s.day,
      startedAt: iso(s.startedAt),
      endedAt: iso(s.endedAt),
      minutes: minutesOf(s, now),
      prepTarget: s.prepTarget,
      liveReads: d.liveReads,
      runCount: s.summary.runs,
      submitCount: s.summary.submits,
      outcome: outcomeOf(s),
    },
    problem: { statement: problemStatementText(d.problem), companies: problemCompanies(d.problem) },
    timeline: kept.map((e) =>
      e.kind === 'codeChanged'
        ? e
        : {
            kind: e.kind,
            type: e.type,
            n: e.n,
            minute: msToMin(e.offsetMs),
            verdict: e.verdict.verdict,
            statusMsg: e.verdict.statusMsg,
            passed: e.verdict.passed,
            total: e.verdict.total,
            detail: {
              input: cap(e.detail.input),
              expected: cap(e.detail.expected),
              output: cap(e.detail.output),
              error: cap(e.detail.error),
            },
          },
    ),
    code: {
      final: live?.code ?? null,
      version: live?.version ?? 0,
      lang: lcLangName(live?.lang) ?? s.lang,
    },
    editing:
      f && f.edits > 0
        ? {
            edits: f.edits,
            longestStallMin: minutes(f.longestStallMs),
            rewrites: f.rewrites,
          }
        : null,
    review: s.review ? { ...s.review, updatedAt: iso(s.review.updatedAt) } : null,
    trace: s.summary.coach?.trace ?? null,
    traceBy: s.summary.coach?.traceBy ?? null,
    claudeNotes: s.claudeNotes
      ? { text: s.claudeNotes.text, updatedAt: iso(s.claudeNotes.updatedAt) }
      : null,
    note: 'Snapshots between submits are kept 14 days, so an older sitting may have no "codeChanged" markers. `review` is their own words; `claudeNotes` are yours (set_claude_notes), kept apart.',
  };
}

export const LEETCODE_TOOLS: Tool[] = [
  {
    name: 'live_sitting',
    description: [
      "The LeetCode sitting the user has open right now, captured by Aperture's Safari extension: the problem, minutes since Start, their current code in full, the newest Run and Submit with verdict, failing input, expected vs output and the error head, run/submit counts, LeetCode's own timer, and editing facts.",
      FRESHNESS,
      'So `code.ageSec` can read up to about 30, and a pull a minute later may show more; `extensionSeenAgoSec` says when the extension last reached the server. Code, Run and Submit times are their Mac’s clock, so their ages can be off by its skew.',
      'Pass `sinceVersion` (the last `code.version` you saw for this `sitting.id`) to get `unchangedSinceVersion`. Pull at most once per turn, and never paste their code back at them — point at a line, a name or a case.',
      '`slot` says where the open sitting sits in today’s plan (leetcode_today): its kind (re-solve, carry-over, new, stretch, or off-plan), reason, the 30-minute cap and whether it is past it, and the coaching `rules` for that kind — follow them.',
      '`trace` is whether they traced before the first Run or Submit: `traced` when their code held a trace comment (a multi-line comment or docstring that names an input and walks it — `traceBy: "comment"`), else the extension card’s state on an older sitting (partial, skipped), `none` once judged with no trace; null until then. Don’t ask for a trace already written — read the comment in the code.',
      'A sitting with no activity for 45 minutes (no extension event, no live pull) is closed automatically by the next read, at its last activity + 5 minutes (`closedBy: "idle"`, its rep left in progress) — here it reads closed, and the app writes the close; coming back to the problem the same day reopens it, and so does the Reopen button in the app. Each pull counts as activity, so talking it through keeps it open.',
      '`active: false` carries `lastSitting`, the most recent one.',
      '`expired: true` marks a last sitting left open past its 24 h window (no longer capturing; the next Start ends it).',
      'Not read-only: each pull of an open sitting writes one count on it ("Claude watched live") — nothing else; one that finds it idle reads it closed and writes nothing.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        sinceVersion: {
          type: 'integer',
          minimum: 0,
          description: 'The last code.version you saw',
        },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const { sinceVersion } = args;
      if (
        sinceVersion !== undefined &&
        (typeof sinceVersion !== 'number' ||
          !Number.isSafeInteger(sinceVersion) ||
          sinceVersion < 0)
      )
        throw new RpcParamError('"sinceVersion" must be a whole number ≥ 0');
      const now = ctx.now?.() ?? Date.now();
      // Today's plan beside the pull (coachTools), for the open sitting's slot; it never fails the pull.
      const [pull, today] = await Promise.all([
        ctx.dispatch('pullLiveSitting', []) as Promise<LiveSittingPull>,
        todayOrNull(ctx),
      ]);
      if (!pull.sitting) return inactive(pull, now);
      return {
        ...active(
          { ...pull, sitting: pull.sitting },
          now,
          (sinceVersion as number | undefined) ?? null,
        ),
        slot: slotOfSitting(today, pull.sitting, now),
      };
    },
  },
  {
    name: 'get_sitting',
    description: [
      'One LeetCode sitting, read back whole — for talking it through afterwards ("how did that sitting go?"). With no `id`, the most recent sitting.',
      'Returns the problem (and its statement as text, plus the companies that asked it lately), minutes, run/submit counts and the outcome, the timeline of every Run and Submit in order with verdict, passed/total and its failing input, expected vs output or error (each capped), "codeChanged" markers counting the snapshots between them, their final code in full, editing facts, the trace before the first judged event (`trace`, `traceBy`), their review (their own words — never rewrite them back to them as yours), and your own notes on it (`claudeNotes`, set_claude_notes).',
      'Talk from this data, not from memory, and never paste their code back at them — point at a line, a name or a case.',
      '`closedBy: "idle"` means Aperture closed it after 45 minutes with no activity, at the last activity + 5 minutes (its rep left in progress).',
      'Read-only.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'A sitting id (from list_sittings); omit for the latest',
        },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const { id } = args;
      if (id !== undefined && (typeof id !== 'string' || !isUlid(id)))
        throw new RpcParamError('"id" must be a sitting id — list_sittings gives them');
      const now = ctx.now?.() ?? Date.now();
      let target = id as string | undefined;
      if (target === undefined) {
        const all = (await ctx.dispatch('listSittings', [])) as Sitting[];
        if (!all.length) return { sitting: null, note: 'No sittings yet.' };
        target = all[0]!.id; // startedAt desc
      }
      return sittingRead((await ctx.dispatch('getSitting', [target])) as SittingDetail, now);
    },
  },
  {
    name: 'list_sittings',
    description: [
      'LeetCode sittings, newest first — for planning prep ("what have I done this week?", "which problems took a hint?"). Each row: day, problem, status, minutes, submit count, the outcome (first submit accepted, submits before accepted, time to first submit), prep target, and whether they reviewed it with their own pattern tags.',
      'Optional from/to day keys (pass BOTH or NEITHER) and `limit` (1–100, default 30). `get_sitting` with a row’s id reads one in full.',
      '`closedBy: "idle"` marks one Aperture closed after 45 minutes with no activity.',
      'Read-only.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        to: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const { from, to, limit = 30 } = args;
      if ((from === undefined) !== (to === undefined))
        throw new RpcParamError('pass both "from" and "to", or neither');
      for (const [k, v] of [
        ['from', from],
        ['to', to],
      ] as const)
        if (v !== undefined && (typeof v !== 'string' || !isDayKey(v)))
          throw new RpcParamError(`"${k}" must be an ISO date (YYYY-MM-DD)`);
      if (typeof from === 'string' && typeof to === 'string' && from > to)
        throw new RpcParamError('"from" must not be after "to"');
      if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new RpcParamError('"limit" must be a whole number from 1 to 100');
      const now = ctx.now?.() ?? Date.now();
      const range = from !== undefined ? [{ from, to }] : [];
      const all = (await ctx.dispatch('listSittings', range)) as Sitting[];
      return {
        sittings: all.slice(0, limit).map((s) => sittingRow(s, now)),
        more: all.length > limit,
      };
    },
  },
];
