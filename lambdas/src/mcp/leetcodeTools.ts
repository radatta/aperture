import { judgeDetail, sittingMetrics, sittingMinutes, sittingProblemUrl } from '@aperture/shared';
import type { LiveSittingPull, Sitting, SittingEvent, SittingVerdict } from '@aperture/shared';
import { RpcParamError } from './types';
import type { Tool } from './types';

// LeetCode sittings for Claude (docs/areas/recruiting → Claude watches live; docs/areas/mcp → Tools). Read-only:
// the one write is pullLiveSitting's own count of the pull ("Claude watched live" on the sitting).

// How fresh the capture is — the extension's pacing (extension/src/lib/batch.js), said once so the model never
// reads a 30-second-old snapshot as the whole truth.
const FRESHNESS =
  'Code arrives as snapshots at most once per 30 s (the latest code) and right before each Run or Submit, so it can be up to ~30 s behind what is on screen. A Run or Submit judged after he leaves the page still lands in its sitting.';

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const agoSec = (ms: number | null, now: number) =>
  ms === null ? null : Math.max(0, Math.round((now - ms) / 1000));
const minutes = (ms: number | null) => (ms === null ? null : Math.round(ms / 60_000));

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

// A judged Run or Submit: the summary's verdict, plus what its payload says beyond it (failing case, expected
// vs output, the error head). The verdict comes from the head (the event may still await its check).
function judged(v: SittingVerdict | null, e: SittingEvent | null, now: number) {
  if (!v && !e) return null;
  return {
    verdict: v?.verdict ?? null,
    statusMsg: v?.statusMsg ?? null,
    passed: v?.passed ?? null,
    total: v?.total ?? null,
    at: iso(v?.at ?? e?.at ?? null),
    agoSec: agoSec(v?.at ?? e?.at ?? null, now),
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
      lang: live?.lang ?? s.lang,
      at: iso(live?.codeAt ?? null),
      ageSec: agoSec(live?.codeAt ?? null, now),
    },
    ...(since !== null ? { unchangedSinceVersion: version === since } : {}),
    runCount: s.summary.runs,
    submitCount: s.summary.submits,
    outcome: outcomeOf(s),
    lastRun: judged(s.summary.lastRun, pull.lastRun, now),
    lastSubmit: judged(s.summary.lastSubmit, pull.lastSubmit, now),
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
  return {
    active: false,
    lastSitting: s
      ? {
          id: s.id,
          problem: problemOf(s),
          status: s.status,
          startedAt: iso(s.startedAt),
          endedAt: iso(s.endedAt),
          minutes: sittingMinutes(s, now),
          submitCount: s.summary.submits,
          outcome: outcomeOf(s),
          liveReads: pull.liveReads,
        }
      : null,
    note: 'No sitting is open: he starts one with Start on a LeetCode problem page.',
  };
}

export const LEETCODE_TOOLS: Tool[] = [
  {
    name: 'live_sitting',
    description: [
      "The LeetCode sitting Rahul has open right now, captured by Aperture's Safari extension: the problem, minutes since Start, his current code in full, the newest Run and Submit with verdict, failing input, expected vs output and the error head, run/submit counts, LeetCode's own timer, and editing facts.",
      'Code arrives as snapshots at most once per 30 s (the latest code) and right before each Run or Submit, so `code.ageSec` can read up to about 30; `extensionSeenAgoSec` says when the extension last reached the server. A Run or Submit judged after he leaves the page still lands in its sitting, so a pull a minute later may show more.',
      'Pass `sinceVersion` (the last `code.version` you saw) to get `unchangedSinceVersion`. Pull at most once per turn, and never paste his code back at him — point at a line, a name or a case.',
      '`active: false` carries `lastSitting`, the most recent one.',
      'Read-only, except that each pull of an open sitting is counted on it as "Claude watched live".',
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
      const pull = (await ctx.dispatch('pullLiveSitting', [])) as LiveSittingPull;
      return pull.sitting
        ? active(
            { ...pull, sitting: pull.sitting },
            now,
            (sinceVersion as number | undefined) ?? null,
          )
        : inactive(pull, now);
    },
  },
];
