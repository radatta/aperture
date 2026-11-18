// Voice capture — "Hey Siri, Aperture" / the Action Button → a task. An iPhone Shortcut (or Raycast) POSTs the
// spoken line to /api/capture with a scoped token; the server parses it (Haiku, with a deadline), creates the
// task and answers a sentence to speak. Pure rules shared by the stub, the Lambda and the dev check: the
// scoped-token shapes, the caps, the wire shapes and the spoken texts. Design record:
// docs/areas/tasks/capture.md.

import { fmtClockSpoken, fmtSpokenDay } from './dates';

// --- Scoped tokens ---------------------------------------------------------
// A single-purpose device credential: one scope, one route. Only `capture` exists; later ones (a Health
// ingest, an error beacon) add a scope + a prefix + their own route, never an RPC method. Unlike the place
// token (one per user, rotated), these are named and several per scope, so the phone and the Mac can be
// revoked separately.
export const TOKEN_SCOPES = ['capture'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
export const isTokenScope = (s: unknown): s is TokenScope =>
  typeof s === 'string' && (TOKEN_SCOPES as readonly string[]).includes(s);
export const SCOPED_TOKEN_PREFIX: Record<TokenScope, string> = { capture: 'apc_' };
export const SCOPED_TOKENS_MAX = 5; // live tokens per scope
export const SCOPED_TOKEN_NAME_MAX = 40;

// What Settings lists. Never the token or its hash — `hint` is its last 4.
export interface ScopedTokenInfo {
  id: string;
  scope: TokenScope;
  name: string;
  hint: string;
  createdAt: number;
  lastUsedAt: number | null;
  usedToday: number; // requests counted on the cap's (UTC) day
}

// Why a token can't be minted with this name, or null. `others` = the scope's live tokens.
export function scopedTokenNameError(
  name: string,
  others: readonly Pick<ScopedTokenInfo, 'name'>[],
): string | null {
  const n = name.trim();
  if (others.length >= SCOPED_TOKENS_MAX)
    return `At most ${SCOPED_TOKENS_MAX} tokens — revoke one first`;
  if (!n) return 'A token needs a name';
  if (n.length > SCOPED_TOKEN_NAME_MAX)
    return `A token name is at most ${SCOPED_TOKEN_NAME_MAX} characters`;
  const clash = others.find((o) => o.name.toLowerCase() === n.toLowerCase());
  if (clash) return `Another token is already called “${clash.name}”`;
  return null;
}

// --- The capture route -----------------------------------------------------
// Hidden guards per UTC day (capture.md → Caps): past CAPTURE_DAILY_CAP (per token) the route answers 429 and
// writes nothing; past CAPTURE_PARSE_DAILY_CAP (per user, across all their capture tokens — the maintainer,
// 2026-11-17) it still captures but saves without the model, so however many tokens leak, the model spend stays
// flat (~40 × $0.003–0.006 a day, inside the API credit). The app's own parse (Cognito) isn't counted.
export const CAPTURE_DAILY_CAP = 200;
export const CAPTURE_PARSE_DAILY_CAP = 40;
// The same line again within this window is the first capture answered again, not a second task.
export const CAPTURE_DUPLICATE_MS = 60_000;
// A first capture still unsaved after this long died (the Lambda's 15 s timeout, plus margin): the same line
// again is a new capture, not "already got that".
export const CAPTURE_IN_FLIGHT_MS = 20_000;
// The parse's deadline inside the route: Siri waits on it, so past this the line is saved as typed.
export const CAPTURE_PARSE_DEADLINE_MS = 5_000;
// The route's bound on one model call's spend (Sonnet, 2026-11-17): a longer line never reaches the model —
// it saves as typed, like a failed parse — and the answer is capped. A spoken line is a sentence or two.
export const CAPTURE_PARSE_TEXT_MAX = 600;
export const CAPTURE_PARSE_MAX_TOKENS = 512;
export const CAPTURE_TEXT_MAX = 2_500;
export const CAPTURE_BODY_MAX = 16_384;

export interface CaptureRequest {
  text: string;
  // Spoken: the voice time rules apply ("at 5" = the next 5 o'clock, "tonight", "in 20 minutes"). Absent
  // (Raycast) = the typed rules, exactly as the capture bar. Both roll a past clock with no day forward.
  voice?: boolean;
}

export interface CaptureResult {
  id: string | null; // null only for a duplicate whose first capture is still in flight
  say: string; // the sentence to speak
  detail: string; // the typed receipt: title · when · category · estimate
  raw: boolean; // saved as typed (no parse, or it failed)
  duplicate: boolean; // the same line within CAPTURE_DUPLICATE_MS: the first capture, answered again
  due: { day: string; time: string | null } | null;
}

// Any non-200 answer: `error` for logs/tools, `say` for Siri. CloudFront turns an origin 403/404 into the
// app's index.html, so the route never answers 404.
export interface CaptureError {
  error: string;
  say: string;
}

export const CAPTURE_SAY = {
  unauthorized: "Aperture: this capture token isn't valid. Make a new one in Settings.",
  method: 'Aperture capture needs a POST.',
  path: "Aperture: the Shortcut's URL isn't the capture address. Check it in Settings.",
  empty: "Aperture didn't get any text.",
  tooLong: 'That was too long for Aperture. Nothing was added.',
  cap: 'Daily capture limit reached. Nothing was added.',
  inFlight: "Got that a moment ago. If it isn't in the app in a minute, say it again.",
  // Several captures through one token at once, and this one lost every retry of the token row's write
  // (F224): nothing was added, so saying it again is safe.
  busy: 'Aperture was busy and nothing was added. Say it again.',
  error: 'Aperture hit an error. Check the app before retrying.',
  // The Shortcut's own fallback when the answer has no `say` (a CloudFront error has no body).
  noAnswer: "Aperture didn't confirm. Check the app.",
} as const;

// --- The spoken answer -----------------------------------------------------
export const CAPTURE_SAY_TITLE_MAX = 80;

// The title as spoken: at most CAPTURE_SAY_TITLE_MAX, cut at a word, without trailing punctuation (the
// sentence adds its own full stop).
function spokenTitle(title: string): string {
  const t = title.replace(/\s+/g, ' ').trim();
  const cut =
    t.length <= CAPTURE_SAY_TITLE_MAX
      ? t
      : `${t.slice(0, CAPTURE_SAY_TITLE_MAX).replace(/\s+\S*$/, '') || t.slice(0, CAPTURE_SAY_TITLE_MAX)}…`;
  return cut.replace(/[\s.,;:!?]+$/, '');
}

// When it's due, said aloud: a timed task against the calendar date ("today 5 AM" at 1 AM is unambiguous),
// a day-only one against the app's today (dayStartHour), as everywhere else in the app. Null: no due day.
export function captureWhen(
  due: { day: string; time: string | null } | null,
  calendarToday: string,
  appToday: string,
): string | null {
  if (!due) return null;
  if (!due.time) return fmtSpokenDay(due.day, appToday);
  return `${fmtSpokenDay(due.day, calendarToday)} ${fmtClockSpoken(due.time)}`;
}

export interface CaptureSayInput {
  title: string;
  due: { day: string; time: string | null } | null;
  placeName: string | null;
  calendarToday: string;
  appToday: string;
  raw: boolean;
  duplicate: boolean;
}

// "Added: call mum, today 5 PM." · "Added to Grocer: milk." · "Already added: call mum, today 5 PM." ·
// "Added without AI, as typed: call mum at 5, today 5 PM." (the model failed; the words' own time, a spoken
// line) · "Added as typed, with no date or time: call mum at five." Category and estimate aren't spoken — the
// receipt (`detail`) has them.
export function captureSay(x: CaptureSayInput): string {
  const title = spokenTitle(x.title);
  const when = captureWhen(x.due, x.calendarToday, x.appToday);
  if (x.raw && !x.duplicate)
    return when
      ? `Added without AI, as typed: ${title}, ${when}.`
      : `Added as typed, with no date or time: ${title}.`;
  const lead = x.duplicate ? 'Already added' : x.placeName ? `Added to ${x.placeName}` : 'Added';
  return `${lead}: ${title}${when ? `, ${when}` : ''}.`;
}
