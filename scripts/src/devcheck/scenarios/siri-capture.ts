// Voice capture — "Hey Siri, Aperture" / the Action Button / Raycast → a task (docs/areas/tasks/capture.md). A
// capture token is made, kept through a cancelled revoke and a reload, and revoked in Settings › Capture; the
// section's failed reads and writes are injected by the harness (ctx.intercept); the route itself (POST
// /api/capture) is driven raw (api.ts captureRaw) with tokens minted through the guarded API. Tokens are
// ledgered by the id the mint answered with (the browser's mintScopedToken response, recorder.ts, or the API's),
// every task the route made by the 200's `id`; cleanup revokes and deletes by those records, and the scenario's
// last step does it early so the scenarios after it see none of this. A token's plaintext lives in this
// module's memory only — never in a log, an error, a screenshot or the ledger. Names and titles carry the run's
// nonce. The time rows compute what the server should answer with the shared rules themselves
// (packages/shared/src/spokenTime.ts, due.ts) at the moment of the call: the rules are the unit tests' (the
// off-dev rows); these prove the route applies them, with the model's day and the server's clock, end to end.
import { randomBytes } from 'node:crypto';
import type { DevCaptureResult, DevScopedToken } from '../api';
import { targetOrigin } from '../config';
import type { PwRequest } from '../pw-types';
import { methodOf } from '../recorder';
import { hidingSecret, laDay, noConsoleErrors, type Ctx, type Scenario } from '../scenario';

// The slice of @aperture/shared the scenario reads. scripts doesn't depend on shared, so its source is loaded at
// run time (tsx transpiles it) — the same rules and texts the Lambda runs, never a copy that could drift.
// siri-capture.test.ts checks every name below is really there.
export const SAY_KEYS = [
  'unauthorized',
  'method',
  'path',
  'empty',
  'tooLong',
  'cap',
  'busy',
] as const;
export interface Shared {
  CAPTURE_SAY: Record<(typeof SAY_KEYS)[number], string>;
  CAPTURE_DAILY_CAP: number;
  CAPTURE_PARSE_DAILY_CAP: number;
  CAPTURE_PARSE_TEXT_MAX: number;
  CAPTURE_DUPLICATE_MS: number;
  CAPTURE_TEXT_MAX: number;
  CAPTURE_BODY_MAX: number;
  SCOPED_TOKENS_MAX: number;
  SCOPED_TOKEN_NAME_MAX: number;
  USER_TIME_ZONE: string;
  captureWhen(
    due: { day: string; time: string | null } | null,
    calendarToday: string,
    appToday: string,
  ): string | null;
  spokenTimeIn(line: string): object | null;
  resolveSpoken(
    spoken: object,
    modelDay: string | null,
    ctx: { now: number; today: string },
  ): { day: string; time: string };
  zonedEpoch(day: string, hhmm: string, timeZone: string): number;
  addDays(day: string, n: number): string;
  fmtWeekday(day: string): string;
  dayKeyInZone(epochMs: number, timeZone: string, dayStartHour: number): string;
  nightDueDay(dueDay: string, dueTime: string, today: string, dayStartHour: number): string;
}
export const SHARED_NUMBERS = [
  'CAPTURE_DAILY_CAP',
  'CAPTURE_PARSE_DAILY_CAP',
  'CAPTURE_PARSE_TEXT_MAX',
  'CAPTURE_DUPLICATE_MS',
  'CAPTURE_TEXT_MAX',
  'CAPTURE_BODY_MAX',
  'SCOPED_TOKENS_MAX',
  'SCOPED_TOKEN_NAME_MAX',
] as const;
export const SHARED_FUNCTIONS = [
  'captureWhen',
  'spokenTimeIn',
  'resolveSpoken',
  'zonedEpoch',
  'addDays',
  'fmtWeekday',
  'dayKeyInZone',
  'nightDueDay',
] as const;
const SHARED_SRC = new URL('../../../../packages/shared/src/', import.meta.url);
let sharedP: Promise<Shared> | undefined;
export const loadShared = (): Promise<Shared> =>
  (sharedP ??= Promise.all(
    ['dates.ts', 'due.ts', 'spokenTime.ts', 'capture.ts'].map(
      (f) => import(new URL(f, SHARED_SRC).href) as Promise<object>,
    ),
  ).then((mods) => Object.assign({}, ...mods) as Shared));

const TOKEN_RE = /^apc_[A-Za-z0-9_-]{43}$/;
const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
// A clock or a stated time left in a title: the voice rules strip it (capture.md → Time rules).
const TIME_WORDS =
  /\bat\s+\d|\b\d{1,2}(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)(?=\s|$)|o['’]?\s?clock|\bin\s+\d+\s*min/i;

// A capture line's marker: the nonce with its digits spelled as letters. The nonce comes from the run's
// start time ("035227full" = 03:52:27), and the voice prompt strips spoken times from a title — a dev run
// (2026-11-16) had the model drop "devcheck 035227full" as one. Siri never dictates such a token.
export const marker = (nonce: string): string =>
  nonce.replace(/\d/g, (d) => 'abcdefghij'[Number(d)]!);
const line = (ctx: Ctx, what: string) => `devcheck ${marker(ctx.nonce)} ${what}`;
const nameA = (ctx: Ctx) => `devcheck ${ctx.nonce} phone`; // made and revoked in Settings
const nameB = (ctx: Ctx) => `devcheck ${ctx.nonce} mac`; // the neighbour, minted through the API
const nameC = (ctx: Ctx) => `devcheck ${ctx.nonce} cap`; // the capture cap's own
const nameD = (ctx: Ctx) => `devcheck ${ctx.nonce} parse`; // the parse cap's own
const fillName = (ctx: Ctx, i: number) => `devcheck ${ctx.nonce} fill ${i}`;

// Steps share what earlier ones made; a failed step skips the rest, so these are set when read.
let tokenA: string; // plaintexts — never logged
let tokenB: string;
const parsedB: string[] = [];
let infoA: DevScopedToken;
let infoB: DevScopedToken;
let taskIds: string[] = []; // every task the route made this run, torn down by the last step

// The LA wall clock (the hour 0–23 and the minute).
export function laClock(
  ms: number,
  zone = 'America/Los_Angeles',
): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { hour: get('hour') % 24, minute: get('minute') };
}
// How long until the next midnight — LA's (the app's dates) or UTC's (the caps' day). LA's offset is whole
// minutes, so the seconds are the epoch's.
export const untilLaMidnight = (ms: number): number => {
  const { hour, minute } = laClock(ms);
  return (24 * 60 - hour * 60 - minute) * MIN - (ms % MIN);
};
export const untilUtcMidnight = (ms: number): number => 24 * HOUR - (ms % (24 * HOUR));
// How long until the app's day start (dayStartHour:00 LA) — a Review across it drops its preview (CaptureBar).
export const untilDayStart =
  (dayStartHour: number) =>
  (ms: number): number =>
    (untilLaMidnight(ms) + dayStartHour * HOUR) % (24 * HOUR) || 24 * HOUR;
// A row whose answer names a day (or counts toward a UTC day) never starts within 2 min of that midnight:
// it waits it out.
// Waits out a midnight closer than `need` (how long the step runs, with margin) — a counter reset mid-step
// would read as a bug.
async function clearOfMidnight(
  ctx: Ctx,
  until: (ms: number) => number,
  which: string,
  need = 2 * MIN,
) {
  const left = until(Date.now());
  if (left >= need) return;
  ctx.log(`waiting ${Math.ceil(left / SEC) + 5} s for ${which} to pass`);
  await sleep(left + 5 * SEC);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

const h12 = (h: number) => h % 12 || 12;
const ampm = (h: number) => `${h12(h)} ${h < 12 ? 'am' : 'pm'}`;
// A bare "at N" for an hour already past today in its AM reading — the hour before now (near the hour's end,
// ≥ :55, the current one, so the answer can't move while the call is in flight). The next N o'clock is then
// its PM today, or tomorrow's AM: always 10–12 h on.
export const wrapHour = (hour: number, minute: number): number =>
  h12(minute >= 55 ? hour : (hour + 23) % 24);
// A stated clock one hour ago ("at 5 pm" at 6:xx PM). At midnight's hour the hour before is yesterday's 11
// PM, which is still ahead today, so it says this hour's "12 am" instead.
export const rollClock = (hour: number): string => (hour === 0 ? '12 am' : ampm(hour - 1));
// A stated clock three hours ahead — never near now, so it can't roll while the call is in flight.
export const aheadClock = (hour: number): string => ampm((hour + 3) % 24);

const fieldsOf = (body: unknown): Record<string, unknown> =>
  (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
// The route answered 200 with a capture result.
function ok(got: { status: number; body: unknown }, what: string): DevCaptureResult {
  if (got.status !== 200)
    throw new Error(`${what} → HTTP ${got.status}: ${JSON.stringify(got.body)}`);
  const r = got.body as DevCaptureResult;
  if (typeof r?.say !== 'string' || !r.say)
    throw new Error(`${what}: no say in ${JSON.stringify(r)}`);
  return r;
}
// The route refused with `status`, an `error` and a spoken `say` — `say` itself when given. A Lambda throttle's
// 429 carries neither, so it can't pass for the cap.
function refused(
  got: { status: number; body: unknown },
  status: number,
  what: string,
  say?: string,
) {
  const { error, say: said } = fieldsOf(got.body);
  if (got.status !== status || typeof error !== 'string' || !error)
    throw new Error(
      `${what}: expected HTTP ${status} with an error, got ${got.status}: ${JSON.stringify(got.body)}`,
    );
  if (typeof said !== 'string' || !said.trim() || (say !== undefined && said !== say))
    throw new Error(
      `${what}: say is ${JSON.stringify(said)}${say ? `, not ${JSON.stringify(say)}` : ''}`,
    );
}
// One capture with `token` — spoken (the Shortcut) unless `voice` is false (Raycast's body: no flag at all); a
// new task's id is kept for the teardown (the ledger has it already). `tag` tells same-text calls apart in the
// ledger's titles.
async function capture(
  ctx: Ctx,
  token: string,
  text: string,
  what: string,
  opts: { voice?: boolean; tag?: string } = {},
) {
  const body = opts.voice === false ? { text } : { text, voice: true };
  const day = new Date().toISOString().slice(0, 10); // the claim's UTC day: before the call, not after
  const got = await ctx.api.writes.captureRaw(token, body, opts.tag ? { tag: opts.tag } : {});
  const r = ok(got, what);
  if (r.id && !r.duplicate && !taskIds.includes(r.id)) taskIds.push(r.id);
  // A parsed, non-grammar line through tokenB spent one of the user's model calls (its UTC day kept): the
  // parse-cap row needs the refusal to come that much sooner, or the cap is per token, not per user.
  if (token === tokenB && !r.raw && !r.duplicate && !text.includes('|')) parsedB.push(day);
  return r;
}
const tokenById = async (ctx: Ctx, id: string) =>
  (await ctx.api.reads.listScopedTokens()).find((t) => t.id === id);
async function until<T>(what: string, read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  const end = Date.now() + 15_000;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > end) throw new Error(`${what}: the server still has ${JSON.stringify(v)}`);
    await sleep(500);
  }
}
const getTask = async (ctx: Ctx, id: string) => {
  const t = await ctx.api.reads.getTask(id);
  if (!t) throw new Error(`task ${id} is gone`);
  return t;
};
// A just-minted token's row: its hint is the token's last 4, unused — without echoing the hint into an error.
function expectFresh(
  token: string,
  info: DevScopedToken | undefined,
  what: string,
): DevScopedToken {
  if (!TOKEN_RE.test(token))
    throw new Error(`${what}: the token isn't apc_ + 43 base64url characters`);
  if (!info || info.hint !== token.slice(-4) || info.usedToday !== 0 || info.lastUsedAt !== null)
    throw new Error(
      `${what}: the row reads ${JSON.stringify(info ? { ...info, hint: '…' } : null)}`,
    );
  return info;
}
// A token of this run's own, minted through the API, used, and revoked whatever happens.
async function withToken(
  ctx: Ctx,
  name: string,
  use: (token: string, info: DevScopedToken) => Promise<void>,
) {
  const minted = await ctx.api.writes.mintScopedToken(name);
  try {
    await use(minted.token, expectFresh(minted.token, minted.info, name));
  } finally {
    await ctx.api.writes.revokeScopedToken(minted.info.id).catch(() => undefined); // cleanup retries it
  }
}

// The show-once reveal, from the click that mints: read it, then close it at once. Any throw on the way blanks
// the page before it leaves (scenario.ts hidingSecret, which also scrubs a token out of the error's text), so
// no shot, a failure's included, ever holds the token.
async function takeRevealedToken(ctx: Ctx, mint: () => Promise<void>): Promise<string> {
  return hidingSecret(ctx.page, async () => {
    await mint();
    const field = ctx.page.getByRole('textbox', { name: 'Capture token', exact: true });
    await field.waitFor({ state: 'visible', timeout: 15_000 });
    const token = await field.inputValue();
    await field
      .locator('xpath=..')
      .getByRole('button', { name: 'Done', exact: true })
      .click({ timeout: 5_000 });
    await field.waitFor({ state: 'hidden', timeout: 5_000 });
    return token;
  });
}
// Whether the plaintext is anywhere on the page — its text or a field's value. A failed read says so without
// the expression (which carries the token).
async function onPage(ctx: Ctx, token: string): Promise<boolean> {
  const t = JSON.stringify(token);
  return ctx.page
    .evaluate<boolean>(
      `document.body.innerText.includes(${t}) || [...document.querySelectorAll('input, textarea')].some((e) => e.value.includes(${t}))`,
    )
    .catch(() => {
      throw new Error('couldn’t read the page to check the token is gone');
    });
}
const rowButton = (ctx: Ctx, name: string) =>
  ctx.page.getByRole('button', { name: `Revoke ${name}`, exact: true });
const confirmText = (ctx: Ctx, name: string) =>
  ctx.page.getByText(`${name} stops adding tasks at once.`, { exact: true });
const nameField = (ctx: Ctx) => ctx.page.getByLabel('New token for', { exact: true });
const makeButton = (ctx: Ctx) =>
  ctx.page.getByRole('button', { name: 'Make capture token', exact: true });

// The model rows: `due` equals one of `want` (the answer computed at the call's start or its end — the server's
// clock is somewhere between), the task holds it, the title keeps the nonce and lost the spoken time — or is
// exactly `title`, a typed line's every word but its due phrase (capture-titles) — and `say` speaks it as of either end.
async function expectDue(
  ctx: Ctx,
  S: Shared,
  r: DevCaptureResult,
  want: { day: string; time: string }[],
  t0: number,
  t1: number,
  title?: string,
): Promise<{ day: string; time: string; at: number }> {
  if (r.raw)
    throw new Error(
      `saved as typed (raw: true) — the parse failed or missed its deadline; if this repeats, raise CAPTURE_PARSE_DEADLINE_MS: ${r.say}`,
    );
  const due = r.due;
  if (!due?.time || !want.some((w) => w.day === due.day && w.time === due.time))
    throw new Error(
      `due ${JSON.stringify(due)}, expected ${JSON.stringify(want[0])} — receipt: ${r.detail}`,
    );
  const task = await getTask(ctx, r.id!);
  if (task.dueDay !== due.day || task.dueTime !== due.time)
    throw new Error(
      `the answer says ${JSON.stringify(due)}, the task holds ${task.dueDay} ${task.dueTime}`,
    );
  if (
    title !== undefined
      ? task.title !== title
      : !task.title.includes(marker(ctx.nonce)) || TIME_WORDS.test(task.title)
  )
    throw new Error(
      `the title is “${task.title}” — ${title !== undefined ? `want “${title}”` : 'the nonce kept, the spoken time taken out'}`,
    );
  const whens = [t0, t1].map((t) => S.captureWhen(due, laDay(new Date(t)), laDay(new Date(t))));
  if (!r.say.startsWith('Added: ') || !whens.some((w) => w && r.say.endsWith(`, ${w}.`)))
    throw new Error(`say is “${r.say}”, expected it to end “, ${whens[0]}.”`);
  return { ...due, time: due.time, at: S.zonedEpoch(due.day, due.time, S.USER_TIME_ZONE) };
}
// What the time rules give for `text` with no named day, at each end of the call — typed and spoken alike since
// 2026-11-17.
const spokenWant = (S: Shared, text: string, t0: number, t1: number) => {
  const spoken = S.spokenTimeIn(text);
  if (!spoken) throw new Error(`the scenario's line has no spoken time: ${text}`);
  return [t0, t1].map((now) => S.resolveSpoken(spoken, null, { now, today: laDay(new Date(now)) }));
};
async function expectSpokenDue(
  ctx: Ctx,
  S: Shared,
  text: string,
  r: DevCaptureResult,
  t0: number,
  t1: number,
  title?: string,
) {
  return expectDue(ctx, S, r, spokenWant(S, text, t0, t1), t0, t1, title);
}

export const siriCapture: Scenario = {
  id: 'siri-capture',
  title: 'Voice capture: Settings › Capture tokens and the capture route',
  tiers: ['full'],
  slowPaths: [
    'lambdas/src/auth/scopedToken.ts',
    'lambdas/src/ddb/scopedTokens.ts',
    'packages/shared/src/capture.ts',
  ],
  rows: [
    {
      id: 'mint',
      entry: 'ui',
      kind: 'nominal',
      what: 'Settings › Capture: name a token, Make token → it shows once (apc_ + 43), then lists by name, “ends …<last 4>”',
    },
    {
      id: 'mint-refused',
      entry: 'ui',
      kind: 'edge',
      what: 'An empty, 41-character or clashing name is refused before anything is sent: Make token disabled, the reason shown',
    },
    {
      id: 'mint-failed',
      entry: 'ui',
      kind: 'edge',
      what: 'A mint the server fails says why, keeps the typed name and shows no token',
    },
    {
      id: 'list-failed',
      entry: 'ui',
      kind: 'edge',
      what: 'The token list failing says “Couldn’t load capture tokens.” and offers no mint; Retry brings the list back',
    },
    {
      id: 'recipe',
      entry: 'ui',
      kind: 'nominal',
      what: 'Set up the Siri Shortcut: the URL is this origin’s /api/capture, the header key x-aperture-authorization',
    },
    {
      id: 'limit',
      entry: 'api',
      kind: 'edge',
      what: 'A 6th live token is refused: “At most 5 tokens”',
    },
    {
      id: 'revoke-failed',
      entry: 'ui',
      kind: 'edge',
      what: 'A revoke the server fails says “Couldn’t revoke — try again.” and the token stays listed and working',
    },
    {
      id: 'revoke-cancel',
      entry: 'ui',
      kind: 'edge',
      what: 'Revoke… then Cancel keeps the token: it still captures',
    },
    {
      id: 'reload',
      entry: 'ui',
      kind: 'edge',
      what: 'After a reload the token is still listed and its plaintext is nowhere on the page',
    },
    {
      id: 'revoke',
      entry: 'ui',
      kind: 'nominal',
      what: 'Revoke… → Revoke: that token 401s with the spoken refusal; the other device’s still captures',
    },
    {
      id: 'grammar',
      entry: 'api',
      kind: 'nominal',
      what: 'A grammar line (“… | ~15”) by voice: added as written, the estimate kept, no model',
    },
    {
      id: 'voice-parse',
      entry: 'api',
      kind: 'nominal',
      what: 'A natural spoken line with a clock: parsed in time, the time out of the title, due where the voice rules put it, said back',
    },
    {
      id: 'typed',
      entry: 'api',
      kind: 'nominal',
      what: 'A typed line (no voice flag — Raycast’s body) gets the spoken answer: a clock an hour ago rolls to tomorrow, said “tomorrow”, at any hour',
    },
    {
      id: 'typed-ahead',
      entry: 'api',
      kind: 'nominal',
      what: 'A typed clock three hours ahead lands on its next occurrence, not a day late',
    },
    {
      id: 'typed-named-day',
      entry: 'api',
      kind: 'edge',
      what: 'A typed “tomorrow at <clock>” keeps the day it names',
    },
    {
      id: 'typed-today',
      entry: 'api',
      kind: 'edge',
      what: 'A typed “today at <a clock an hour ago>” stays on the app’s day (its small hours that day’s night) — overdue, not rolled to tomorrow',
    },
    {
      id: 'typed-bar',
      entry: 'ui',
      kind: 'nominal',
      what: 'The capture bar’s Review (a real parse, the app’s own route): a clock an hour ago previews on its next occurrence, the clock out of the title; nothing saved',
    },
    {
      id: 'typed-small-hours',
      entry: 'api',
      kind: 'edge',
      what: 'Typed and spoken at 00:30, 01:35, 02:01, 03:59, 04:00 and 23:30: “1 am”, “12 am” and “9am” land on their next occurrence, whatever day the model read',
      offDev: {
        file: 'packages/shared/src/quickParse.test.ts',
        test: 'typed and spoken agree at every small-hours clock',
        why: 'needs an injected clock — each small-hours minute can’t be waited for on dev',
      },
    },
    {
      id: 'kept-clock',
      entry: 'api',
      kind: 'edge',
      what: 'An “at 1 am” the model left in its title still sets the time and leaves the title, typed or spoken',
      offDev: {
        file: 'packages/shared/src/quickParse.test.ts',
        test: 'an at/by clock the model kept in its title fills and leaves the title',
        why: 'the model decides whether it keeps the words (1 in 10 on dev, 2026-11-17) — it can’t be made to',
      },
    },
    {
      id: 'not-due-clock',
      entry: 'api',
      kind: 'edge',
      what: '“watch 9pm show”, “the 3pm meeting”, “move the 3pm to 5pm”, “look at one of the leases” and a second clock (“move standup at 3pm to 5pm”) kept in the title get no time',
      offDev: {
        file: 'packages/shared/src/quickParse.test.ts',
        test: 'a clock not phrased as a due gets no time when the model kept it',
        why: 'whether the model keeps those words is its call — dev can’t produce the case on demand',
      },
    },
    {
      id: 'relative',
      entry: 'api',
      kind: 'nominal',
      what: '“in 20 minutes” is now + 20 from the server clock, never an estimate, and the answer names the day',
    },
    {
      id: 'wrap',
      entry: 'api',
      kind: 'edge',
      what: 'A bare hour already past today is the next N o’clock, ~11 h on',
    },
    {
      id: 'half-stated',
      entry: 'api',
      kind: 'edge',
      what: 'A clock with its half of the day said (“at 5 in the morning”) lands as said — not the bare hour’s nearer reading (the model’s dueTimeHalf, 2026-11-17)',
    },
    {
      id: 'half-noun',
      entry: 'api',
      kind: 'edge',
      what: 'A day-part word that belongs to the task (“…send the morning report”) says nothing: the bare hour wraps, and the words stay in the title',
    },
    {
      id: 'half-night',
      entry: 'api',
      kind: 'edge',
      what: '“at 1 <weekday> night” is the small hours after that day, as “at 1 tonight” is',
    },
    {
      id: 'roll',
      entry: 'api',
      kind: 'edge',
      what: 'A stated clock an hour ago rolls to tomorrow, and the answer says “tomorrow”',
    },
    {
      id: 'duplicate',
      entry: 'api',
      kind: 'edge',
      what: 'The same line twice within a minute: the first task answered again (“Already added”), one task',
    },
    {
      id: 'dup-window',
      entry: 'api',
      kind: 'edge',
      what: 'The same line again past the minute’s window is a new task',
    },
    {
      id: 'unauth',
      entry: 'api',
      kind: 'edge',
      what: 'No header, a malformed or unknown apc_ token, the app session’s JWT, a revoked token → 401, each with the spoken refusal',
    },
    {
      id: 'isolation',
      entry: 'api',
      kind: 'edge',
      what: 'A capture token opens nothing else: an RPC with it → 401',
    },
    {
      id: 'bad-input',
      entry: 'api',
      kind: 'edge',
      what: 'Empty or 2,501-character text, bad JSON, another /api/capture path → 422; GET → 405; a 16 KiB body → 413; each spoken, none counted',
    },
    {
      id: 'cap',
      entry: 'api',
      kind: 'edge',
      what: 'A token’s 201st capture in a UTC day is refused 429 with the spoken limit',
    },
    {
      id: 'parse-cap',
      entry: 'api',
      kind: 'edge',
      what: 'Past 40 model parses in a UTC day, across all the user’s capture tokens, a spoken line saves without AI — keeping its own words’ time — and says so',
    },
    {
      id: 'long-line',
      entry: 'api',
      kind: 'edge',
      what: 'A spoken line past 600 characters never reaches the model: saved as typed with its words’ time, said “without AI”',
    },
    {
      id: 'busy',
      entry: 'api',
      kind: 'edge',
      what: 'Eight captures at once through one token (four model lines): each answers 200 with its task, or 409 with the spoken “say it again” — never a 5xx (F224)',
    },
    {
      id: 'busy-exhausted',
      entry: 'api',
      kind: 'edge',
      what: 'Every retry of the token row lost its race: 409 with the spoken “say it again”, and nothing written (F224)',
      offDev: {
        file: 'lambdas/src/index.test.ts',
        test: '409s with a spoken "say it again" when every retry of the token row lost a race (F224)',
        why: 'eight lost races in a row can’t be forced on dev — the concurrent burst proves the retry lands; scopedToken.test.ts proves the give-up writes nothing',
      },
    },
    {
      id: 'latency',
      entry: 'api',
      kind: 'nominal',
      what: 'Spoken lines through the Sonnet parse, one at a time: each answers under 8 s and parsed (Siri’s wait); p50, p95 and max logged',
    },
    {
      id: 'grammar-table',
      entry: 'api',
      kind: 'edge',
      what: 'Every spoken phrase against every clock: DST, the minute edge, the day-parts, a named day',
      offDev: {
        file: 'packages/shared/src/spokenTime.test.ts',
        test: 'a bare hour is the next N o’clock, wrapping (decision 1)',
        why: 'needs an injected clock — DST, the minute edge and every phrase at every hour can’t be waited for on dev',
      },
    },
    {
      id: 'utc-reset',
      entry: 'api',
      kind: 'edge',
      what: 'The counters start over on a new UTC day',
      offDev: {
        file: 'lambdas/src/backend.capture.test.ts',
        test: 'the counters start over on a new UTC day',
        why: 'needs a clock across UTC midnight',
      },
    },
    {
      id: 'timeout',
      entry: 'api',
      kind: 'edge',
      what: 'A failed or timed-out parse saves the line as typed and says so',
      offDev: {
        file: 'lambdas/src/backend.capture.test.ts',
        test: "a failed or timed-out parse saves the line as typed, with its own words' time, and says so",
        why: 'dev’s model can’t be made to fail or time out on demand',
      },
    },
    {
      id: 'ownership',
      entry: 'api',
      kind: 'edge',
      what: 'A token answers only for its own user',
      offDev: {
        file: 'lambdas/src/backend.capture.test.ts',
        test: 'a token answers only for its own user',
        why: 'dev has one test user',
      },
    },
    {
      id: 'iphone',
      entry: 'ios',
      kind: 'nominal',
      what: '“Hey Siri, Aperture”, the Action Button and a locked phone run the Shortcut, and Speak Text says the answer',
      needsYou: 'the real Siri and Action Button run on the maintainer’s iPhone',
    },
    {
      id: 'raycast',
      entry: 'raycast',
      kind: 'nominal',
      what: 'Raycast quick-add posts to the capture route with its own token',
      needsYou: 'Raycast runs on the Mac: swap in a capture token',
    },
  ],
  steps: [
    {
      id: 'ui-mint',
      entry: 'ui',
      proves: ['mint'],
      title: 'Settings › Capture: name it, Make token → shown once, then listed “ends …<last 4>”',
      async run(ctx) {
        taskIds = [];
        parsedB.length = 0;
        const S = await loadShared();
        // A token a crashed run minted is swept first; one nothing recorded (the pipeline reports those) can
        // still crowd the run out of the room it needs: this one and the neighbour at once, then one more.
        const live = await ctx.api.reads.listScopedTokens();
        if (live.length > S.SCOPED_TOKENS_MAX - 3)
          throw new Error(
            `the test user already holds ${live.length} capture tokens (${live.map((t) => t.name).join(', ')}) — revoke the strays`,
          );
        await ctx.ui.goto('/settings');
        await nameField(ctx).fill(nameA(ctx));
        tokenA = await takeRevealedToken(ctx, () => makeButton(ctx).click());
        const listed = await until(
          'the new token listed',
          async () => (await ctx.api.reads.listScopedTokens()).find((t) => t.name === nameA(ctx)),
          (t) => !!t,
        );
        infoA = expectFresh(tokenA, listed, 'Make token');
        await rowButton(ctx, nameA(ctx)).waitFor({ state: 'visible', timeout: 15_000 });
        await ctx.ui.expectText(`ends …${infoA.hint}`, 15_000);
        if (await onPage(ctx, tokenA)) throw new Error('the token is still on the page after Done');
        await ctx.shot('token-made');
      },
    },
    {
      id: 'ui-mint-refused',
      entry: 'ui',
      proves: ['mint-refused'],
      title:
        'An empty, 41-character or clashing name: Make token disabled, the reason shown, nothing sent',
      async run(ctx) {
        const S = await loadShared();
        const before = (await ctx.api.reads.listScopedTokens()).length;
        const sent: string[] = [];
        const watch = (req: PwRequest) => {
          if (req.method() === 'POST' && methodOf(req.url()) === 'mintScopedToken')
            sent.push(req.url());
        };
        ctx.page.on('request', watch);
        try {
          await ctx.ui.goto('/settings');
          const field = nameField(ctx);
          const refusedWith = async (name: string, why: string | null, shot: string) => {
            await field.fill(name);
            if (why) await ctx.ui.expectText(why);
            if (!(await makeButton(ctx).isDisabled()))
              throw new Error(`Make token is enabled for “${name.slice(0, 50)}”`);
            await field.press('Enter'); // the field's own Enter is refused too
            if (shot) await ctx.shot(shot);
          };
          await refusedWith('', null, '');
          await refusedWith('   ', null, '');
          await refusedWith(
            'x'.repeat(S.SCOPED_TOKEN_NAME_MAX + 1),
            `A token name is at most ${S.SCOPED_TOKEN_NAME_MAX} characters`,
            'name-too-long',
          );
          // Another case of the same name: the message names the existing token as it's written.
          await refusedWith(
            nameA(ctx).toUpperCase(),
            `Another token is already called “${nameA(ctx)}”`,
            'name-clash',
          );
          await field.fill('');
          await sleep(500); // a stray mint would be on the wire by now
        } finally {
          ctx.page.off('request', watch);
        }
        if (sent.length) throw new Error(`a refused name still sent ${sent.length} mint(s)`);
        const after = (await ctx.api.reads.listScopedTokens()).length;
        if (after !== before) throw new Error(`the token count moved ${before} → ${after}`);
      },
    },
    {
      id: 'ui-mint-failed',
      entry: 'ui',
      proves: ['mint-failed'],
      title: 'A mint the server fails (injected 503): the reason shown, the name kept, no token',
      async run(ctx) {
        const before = (await ctx.api.reads.listScopedTokens()).length;
        await ctx.ui.goto('/settings');
        const name = line(ctx, 'unminted');
        await nameField(ctx).fill(name);
        const failing = await ctx.intercept('mintScopedToken', { status: 503, times: 1 });
        try {
          await makeButton(ctx).click();
          await ctx.ui.expectText('mintScopedToken failed (503)', 15_000);
          if (failing.hits() !== 1)
            throw new Error(`the injected failure answered ${failing.hits()}×`);
          if ((await nameField(ctx).inputValue()) !== name)
            throw new Error('the typed name was lost');
          if (
            await ctx.page.getByRole('textbox', { name: 'Capture token', exact: true }).isVisible()
          )
            throw new Error('a token was shown for a failed mint');
          await ctx.shot('mint-failed');
        } finally {
          await failing.release();
        }
        await nameField(ctx).fill('');
        const after = (await ctx.api.reads.listScopedTokens()).length;
        if (after !== before) throw new Error(`the token count moved ${before} → ${after}`);
      },
    },
    {
      id: 'ui-list-failed',
      entry: 'ui',
      proves: ['list-failed'],
      title:
        'The token list failing (injected 500s): “Couldn’t load capture tokens.”, no mint; Retry brings it back',
      async run(ctx) {
        const failing = await ctx.intercept('listScopedTokens', { status: 500 });
        try {
          await ctx.ui.goto('/settings');
          const failed = ctx.page.getByText('Couldn’t load capture tokens.', { exact: true });
          await failed.waitFor({ state: 'visible', timeout: 20_000 }); // after the query layer's retries
          if (await ctx.page.getByText(/No capture tokens yet/).isVisible())
            throw new Error('a failed list reads as an empty one');
          await nameField(ctx).fill(line(ctx, 'blind'));
          if (!(await makeButton(ctx).isDisabled()))
            throw new Error('Make token is enabled with no list to check the name against');
          await ctx.shot('list-failed');
          await failing.release();
          await failed
            .locator('xpath=..')
            .getByRole('button', { name: 'Retry', exact: true })
            .click({ timeout: 5_000 });
          await rowButton(ctx, nameA(ctx)).waitFor({ state: 'visible', timeout: 15_000 });
          await failed.waitFor({ state: 'hidden', timeout: 5_000 });
          await nameField(ctx).fill('');
        } finally {
          await failing.release();
        }
      },
    },
    {
      id: 'ui-recipe',
      entry: 'ui',
      proves: ['recipe'],
      title: 'Set up the Siri Shortcut: this origin’s /api/capture and the header key',
      async run(ctx) {
        await ctx.ui.goto('/settings');
        await ctx.page
          .getByRole('button', { name: 'Set up the Siri Shortcut', exact: true })
          .click({ timeout: 15_000 });
        const field = async (label: string) =>
          (await ctx.page.getByLabel(label, { exact: true }).textContent())?.trim();
        const url = await field('URL');
        if (url !== `${targetOrigin()}/api/capture`) throw new Error(`the recipe’s URL is ${url}`);
        const key = await field('Header key');
        if (key !== 'x-aperture-authorization') throw new Error(`the header key is ${key}`);
        await ctx.shot('recipe');
      },
    },
    {
      id: 'api-mint-neighbour',
      entry: 'api',
      title: 'The other device’s token, minted through the API',
      async run(ctx) {
        const minted = await ctx.api.writes.mintScopedToken(nameB(ctx));
        tokenB = minted.token;
        infoB = expectFresh(tokenB, minted.info, 'API mint');
      },
    },
    {
      id: 'ui-revoke-failed',
      entry: 'ui',
      proves: ['revoke-failed'],
      title:
        'A revoke the server fails (injected 500): “Couldn’t revoke”, the token kept and working',
      async run(ctx) {
        await ctx.ui.goto('/settings');
        await rowButton(ctx, nameB(ctx)).click({ timeout: 15_000 });
        const confirm = confirmText(ctx, nameB(ctx));
        await confirm.waitFor({ state: 'visible', timeout: 5_000 });
        const failing = await ctx.intercept('revokeScopedToken', { status: 500, times: 1 });
        try {
          await confirm
            .locator('xpath=..')
            .getByRole('button', { name: 'Revoke', exact: true })
            .click({ timeout: 5_000 });
          await ctx.ui.expectText('Couldn’t revoke — try again.', 15_000);
          await ctx.ui.expectText(nameB(ctx));
          await ctx.shot('revoke-failed');
        } finally {
          await failing.release();
        }
        await confirm
          .locator('xpath=..')
          .getByRole('button', { name: 'Cancel', exact: true })
          .click({ timeout: 5_000 });
        if (!(await tokenById(ctx, infoB.id))) throw new Error('the failed revoke revoked it');
        const r = await capture(ctx, tokenB, `${line(ctx, 'still')} | ~5`, 'after a failed revoke');
        if (r.duplicate || !r.id) throw new Error(`after a failed revoke: ${JSON.stringify(r)}`);
      },
    },
    {
      id: 'ui-revoke-cancel',
      entry: 'ui',
      proves: ['revoke-cancel'],
      title: 'Revoke… then Cancel: the token stays, and still captures',
      async run(ctx) {
        await ctx.ui.goto('/settings');
        await rowButton(ctx, nameA(ctx)).click({ timeout: 15_000 });
        const confirm = confirmText(ctx, nameA(ctx));
        await confirm.waitFor({ state: 'visible', timeout: 5_000 });
        await ctx.shot('revoke-confirm');
        await confirm
          .locator('xpath=..')
          .getByRole('button', { name: 'Cancel', exact: true })
          .click({ timeout: 5_000 });
        await confirm.waitFor({ state: 'hidden', timeout: 5_000 });
        await rowButton(ctx, nameA(ctx)).waitFor({ state: 'visible', timeout: 5_000 });
        if (!(await tokenById(ctx, infoA.id))) throw new Error('Cancel revoked it anyway');
        const r = await capture(ctx, tokenA, `${line(ctx, 'kept')} | ~5`, 'a capture after Cancel');
        if (r.duplicate || r.raw || !r.id) throw new Error(`after Cancel: ${JSON.stringify(r)}`);
      },
    },
    {
      id: 'ui-reload',
      entry: 'ui',
      proves: ['reload'],
      title: 'After a reload: still listed, the plaintext nowhere on the page',
      async run(ctx) {
        await ctx.page.reload({ waitUntil: 'domcontentloaded' });
        await rowButton(ctx, nameA(ctx)).waitFor({ state: 'visible', timeout: 30_000 });
        await ctx.ui.expectText(`ends …${infoA.hint}`, 15_000);
        if (await ctx.page.getByRole('textbox', { name: 'Capture token', exact: true }).isVisible())
          throw new Error('the show-once reveal came back after a reload');
        if (await onPage(ctx, tokenA)) throw new Error('the token is on the page after a reload');
        await ctx.shot('after-reload');
      },
    },
    {
      id: 'ui-revoke',
      entry: 'ui',
      proves: ['revoke'],
      title: 'Revoke… → Revoke: gone from the list, its token 401s, the neighbour still captures',
      async run(ctx) {
        const S = await loadShared();
        await ctx.ui.goto('/settings');
        await rowButton(ctx, nameA(ctx)).click({ timeout: 15_000 });
        const confirm = confirmText(ctx, nameA(ctx));
        await confirm.waitFor({ state: 'visible', timeout: 5_000 });
        await confirm
          .locator('xpath=..')
          .getByRole('button', { name: 'Revoke', exact: true })
          .click({ timeout: 5_000 });
        await rowButton(ctx, nameA(ctx)).waitFor({ state: 'hidden', timeout: 15_000 });
        await confirm.waitFor({ state: 'hidden', timeout: 5_000 });
        await ctx.shot('revoked');
        await until(
          'the revoke',
          () => tokenById(ctx, infoA.id),
          (t) => t === undefined,
        );
        refused(
          await ctx.api.writes.captureRaw(tokenA, { text: line(ctx, 'after revoke'), voice: true }),
          401,
          'the revoked token',
          S.CAPTURE_SAY.unauthorized,
        );
        if (!(await tokenById(ctx, infoB.id))) throw new Error('the neighbour’s token went too');
        const r = await capture(ctx, tokenB, `${line(ctx, 'neighbour')} | ~5`, 'the neighbour');
        if (r.duplicate || !r.id) throw new Error(`the neighbour: ${JSON.stringify(r)}`);
      },
    },
    {
      id: 'api-grammar',
      entry: 'api',
      proves: ['grammar'],
      title: 'A grammar line by voice: added as written, ~15 kept',
      async run(ctx) {
        const title = line(ctx, 'a');
        const r = await capture(ctx, tokenB, `${title} | ~15`, 'the grammar line');
        if (r.raw || r.duplicate || r.due !== null || !r.id || r.say !== `Added: ${title}.`)
          throw new Error(`answered ${JSON.stringify(r)}`);
        const t = await getTask(ctx, r.id);
        if (t.title !== title || t.estimateMin !== 15)
          throw new Error(
            `the task is ${JSON.stringify({ title: t.title, estimateMin: t.estimateMin })}`,
          );
      },
    },
    {
      id: 'api-voice-parse',
      entry: 'api',
      proves: ['voice-parse'],
      title:
        'A natural line with a clock three hours ahead: parsed in time, due as the voice rules say',
      async run(ctx) {
        const S = await loadShared();
        await clearOfMidnight(ctx, untilLaMidnight, 'LA midnight');
        const t0 = Date.now();
        const text = `${line(ctx, 'call the plumber')} at ${aheadClock(laClock(t0).hour)}`;
        const r = await capture(ctx, tokenB, text, 'the spoken line');
        await expectSpokenDue(ctx, S, text, r, t0, Date.now());
      },
    },
    {
      id: 'api-typed',
      entry: 'api',
      proves: ['typed'],
      title:
        'A typed line (no voice flag): a clock an hour ago rolls to tomorrow, as a spoken one does',
      async run(ctx) {
        const S = await loadShared();
        await clearOfMidnight(ctx, untilLaMidnight, 'LA midnight');
        const t0 = Date.now();
        const text = `${line(ctx, 'call the bank typed')} at ${rollClock(laClock(t0).hour)}`;
        const r = await capture(ctx, tokenB, text, 'the typed line', { voice: false });
        const due = await expectSpokenDue(
          ctx,
          S,
          text,
          r,
          t0,
          Date.now(),
          line(ctx, 'call the bank typed'),
        );
        if (due.day !== S.addDays(laDay(new Date(t0)), 1))
          throw new Error(`landed ${due.day}, not tomorrow`);
        if (!/\btomorrow\b/.test(r.say)) throw new Error(`say doesn’t say tomorrow: ${r.say}`);
      },
    },
    {
      id: 'api-typed-ahead',
      entry: 'api',
      proves: ['typed-ahead'],
      title: 'A typed clock three hours ahead lands on its next occurrence',
      async run(ctx) {
        const S = await loadShared();
        await clearOfMidnight(ctx, untilLaMidnight, 'LA midnight');
        const t0 = Date.now();
        const text = `${line(ctx, 'call the plumber typed')} at ${aheadClock(laClock(t0).hour)}`;
        const r = await capture(ctx, tokenB, text, 'the typed line ahead', { voice: false });
        await expectSpokenDue(ctx, S, text, r, t0, Date.now(), line(ctx, 'call the plumber typed'));
      },
    },
    {
      id: 'api-typed-named-day',
      entry: 'api',
      proves: ['typed-named-day'],
      title: 'A typed “tomorrow at <clock>” keeps the day it names',
      async run(ctx) {
        const S = await loadShared();
        await clearOfMidnight(ctx, untilLaMidnight, 'LA midnight');
        const { dayStartHour } = await ctx.api.reads.getSettings();
        const t0 = Date.now();
        // A daytime clock: "tomorrow at 1 am" said at 22:00 could be read as the night after tomorrow.
        const text = `${line(ctx, 'call the dentist typed')} tomorrow at 5 pm`;
        const r = await capture(ctx, tokenB, text, 'the typed named day', { voice: false });
        // A named day stays as written (2026-11-17): "tomorrow" is the app's today + 1 (dayStartHour).
        const t1 = Date.now();
        const want = [t0, t1].map((now) => ({
          day: S.addDays(S.dayKeyInZone(now, S.USER_TIME_ZONE, dayStartHour), 1),
          time: '17:00',
        }));
        await expectDue(ctx, S, r, want, t0, t1, line(ctx, 'call the dentist typed'));
      },
    },
    {
      id: 'api-typed-today',
      entry: 'api',
      proves: ['typed-today'],
      title: 'A typed “today at <a clock an hour ago>” stays on the app’s day, not rolled',
      async run(ctx) {
        const S = await loadShared();
        await clearOfMidnight(ctx, untilLaMidnight, 'LA midnight');
        const { dayStartHour } = await ctx.api.reads.getSettings();
        await clearOfMidnight(ctx, untilDayStart(dayStartHour), 'the day start');
        const t0 = Date.now();
        const clock = rollClock(laClock(t0).hour);
        const hhmm = (S.spokenTimeIn(`at ${clock}`) as { hhmm?: string } | null)?.hhmm;
        if (!hhmm) throw new Error(`“at ${clock}” isn’t a stated clock`);
        const text = `${line(ctx, 'pay the gas bill typed')} today at ${clock}`;
        const r = await capture(ctx, tokenB, text, 'the typed today', { voice: false });
        const t1 = Date.now();
        // The app's today, its small hours on that day's night (due.ts nightDueDay) — never rolled forward.
        const want = [t0, t1].map((now) => {
          const app = S.dayKeyInZone(now, S.USER_TIME_ZONE, dayStartHour);
          return { day: S.nightDueDay(app, hhmm, app, dayStartHour), time: hhmm };
        });
        // Kept and rolled differ in every hour but the day start's (a start after midnight): there tonight's 3 am
        // is both, so the row proves nothing that hour.
        await expectDue(ctx, S, r, want, t0, t1, line(ctx, 'pay the gas bill typed'));
      },
    },
    {
      id: 'ui-typed-bar',
      entry: 'ui',
      proves: ['typed-bar'],
      title:
        'Capture bar › Review, a real parse: a clock an hour ago previews on its next occurrence',
      async run(ctx) {
        const S = await loadShared();
        await clearOfMidnight(ctx, untilLaMidnight, 'LA midnight');
        const { dayStartHour } = await ctx.api.reads.getSettings();
        await clearOfMidnight(ctx, untilDayStart(dayStartHour), 'the day start');
        await ctx.ui.goto('/tasks');
        await ctx.page.getByRole('button', { name: 'Task', exact: true }).click();
        const field = ctx.page.locator('textarea[aria-label="Capture task"]');
        const created = ctx.createdIds().length;
        const t0 = Date.now();
        const text = `${line(ctx, 'call the bank bar')} at ${rollClock(laClock(t0).hour)}`;
        await field.fill(text);
        // The app's parse route (JWT parseTask), not /api/capture: armed before the press.
        const parsed = ctx.page.waitForResponse((r) => r.url().endsWith('/api/parseTask'), {
          timeout: 15_000,
        });
        await ctx.page.getByRole('button', { name: 'Review before saving' }).click();
        const res = await parsed;
        const t1 = Date.now();
        if (res.status() !== 200) throw new Error(`parseTask answered ${res.status()}`);
        const r = (await res.json()) as {
          ok?: boolean;
          input?: { title?: string; dueDay?: string; dueTime?: string };
        };
        if (!r.ok || !r.input) throw new Error(`the parse failed: ${JSON.stringify(r)}`);
        const { title = '', dueDay, dueTime } = r.input;
        const want = spokenWant(S, text, t0, t1);
        if (!want.some((w) => w.day === dueDay && w.time === dueTime))
          throw new Error(`previewed ${dueDay} ${dueTime}, expected ${JSON.stringify(want[0])}`);
        if (title !== line(ctx, 'call the bank bar'))
          throw new Error(`the title is “${title}”, want “${line(ctx, 'call the bank bar')}”`);
        await ctx.page
          .getByRole('button', { name: 'Save reviewed task' })
          .waitFor({ timeout: 10_000 });
        await ctx.shot('review');
        await field.fill(''); // the line goes unsaved
        await sleep(2 * SEC); // a create in flight reaches the ledger only with its response
        if (ctx.createdIds().length !== created) throw new Error('the Review saved a task');
      },
    },
    {
      id: 'api-relative',
      entry: 'api',
      proves: ['relative'],
      title: '“in 20 minutes”: now + 20 (to the minute), no estimate, the day named',
      async run(ctx) {
        const S = await loadShared();
        const text = `${line(ctx, 'stretch')} in 20 minutes`;
        const t0 = Date.now();
        const r = await capture(ctx, tokenB, text, 'the relative line');
        const t1 = Date.now();
        const due = await expectSpokenDue(ctx, S, text, r, t0, t1);
        // Rounded up to the minute from the server's now, which lies between t0 and t1 (a minute's slack for
        // the two clocks).
        if (due.at < t0 + 19 * MIN || due.at > t1 + 21 * MIN)
          throw new Error(`due ${Math.round((due.at - t0) / SEC)} s after the call, not 20–21 min`);
        if (!/\b(today|tomorrow)\b/.test(r.say)) throw new Error(`say names no day: ${r.say}`);
        const t = await getTask(ctx, r.id!);
        if (t.estimateMin != null)
          throw new Error(`the delay became an estimate: ${t.estimateMin}`);
      },
    },
    {
      id: 'api-wrap',
      entry: 'api',
      proves: ['wrap'],
      title: 'A bare “at N” already past today is the next N o’clock, ~11 h on',
      async run(ctx) {
        const S = await loadShared();
        const t0 = Date.now();
        const { hour, minute } = laClock(t0);
        const text = `${line(ctx, 'water the plants')} at ${wrapHour(hour, minute)}`;
        const r = await capture(ctx, tokenB, text, 'the bare hour');
        const due = await expectSpokenDue(ctx, S, text, r, t0, Date.now());
        if (due.at <= t0 + 10 * HOUR)
          throw new Error(`due ${Math.round((due.at - t0) / MIN)} min on — it didn’t wrap`);
      },
    },
    {
      id: 'api-half',
      entry: 'api',
      cost: 'slow',
      proves: ['half-stated', 'half-noun', 'half-night'],
      title:
        'The model’s half of the day, four real parses: a stated half, a day-part noun, a weekday night (bare and 1 am)',
      async run(ctx) {
        const S = await loadShared();
        await clearOfMidnight(ctx, untilLaMidnight, 'LA midnight', 3 * MIN);
        const parsed = async (text: string, what: string) => {
          const r = await capture(ctx, tokenB, text, what);
          if (r.raw) throw new Error(`${what}: saved without the model — ${r.detail}`);
          return r;
        };
        const lands = (r: DevCaptureResult, want: { day: string; time: string }, what: string) => {
          if (r.due?.day !== want.day || r.due?.time !== want.time)
            throw new Error(`${what}: due ${JSON.stringify(r.due)}, want ${JSON.stringify(want)}`);
        };
        // 1. The half said for the hour 15 h on: its bare reading (3 h on) would come first.
        {
          const t0 = Date.now();
          const { hour } = laClock(t0);
          const h = h12((hour + 15) % 24) === 12 ? (hour + 16) % 24 : (hour + 15) % 24;
          const half = h < 12 ? 'in the morning' : h < 17 ? 'in the afternoon' : 'in the evening';
          // "o'clock": the prompt's "the hour as said" must not win over a half said in words.
          const text = `${line(ctx, 'feed the cat')} at ${h12(h)} o'clock ${half}`;
          const r = await parsed(text, 'the stated half');
          const want = S.resolveSpoken(
            { said: '', kind: 'clock', hhmm: `${String(h).padStart(2, '0')}:00` },
            null,
            { now: t0, today: laDay(new Date(t0)) },
          );
          lands(r, want, 'the stated half');
        }
        // 2. "tomorrow at 1 … the morning report": a bare hour on a named day is the daytime one, 13:00 — "morning"
        // belongs to the task. Read as a stated half it would be 01:00. Any hour of the run.
        {
          const r = await parsed(
            `remind me tomorrow at 1 to ${marker(ctx.nonce)} send the morning report`,
            'the day-part noun',
          );
          if (r.due?.time !== '13:00')
            throw new Error(`the day-part noun: due ${JSON.stringify(r.due)}, want 13:00`);
          const title = (await getTask(ctx, r.id!)).title;
          if (!/morning report/.test(title))
            throw new Error(`the title lost its words: “${title}”`);
        }
        // 3. "at 1 <weekday three days on> night": that night's small hours, the day after.
        {
          const day = S.addDays(laDay(new Date()), 3);
          const weekday = S.fmtWeekday(day).toLowerCase();
          // Both the bare and the stated "1 am" are that night's (a `stated` reading would land the night before).
          for (const [said, what] of [
            ['at 1', 'the weekday night'],
            ['at 1 am', 'the weekday night, 1 am'],
          ] as const) {
            const r = await parsed(`${line(ctx, 'call the vet')} ${said} ${weekday} night`, what);
            lands(r, { day: S.addDays(day, 1), time: '01:00' }, what);
          }
        }
      },
    },
    {
      id: 'api-roll',
      entry: 'api',
      proves: ['roll'],
      title: 'A stated clock an hour ago rolls to tomorrow, said “tomorrow”',
      async run(ctx) {
        const S = await loadShared();
        await clearOfMidnight(ctx, untilLaMidnight, 'LA midnight');
        const t0 = Date.now();
        const text = `${line(ctx, 'call the bank')} at ${rollClock(laClock(t0).hour)}`;
        const r = await capture(ctx, tokenB, text, 'the past clock');
        const due = await expectSpokenDue(ctx, S, text, r, t0, Date.now());
        if (due.day !== S.addDays(laDay(new Date(t0)), 1))
          throw new Error(`landed ${due.day}, not tomorrow`);
        if (!/\btomorrow\b/.test(r.say)) throw new Error(`say doesn’t say tomorrow: ${r.say}`);
      },
    },
    {
      id: 'api-duplicate',
      entry: 'api',
      proves: ['duplicate'],
      title: 'The same line twice in a minute: the first answered again, one task',
      async run(ctx) {
        const title = line(ctx, 'dup');
        const first = await capture(ctx, tokenB, `${title} | ~5`, 'the first');
        const again = await capture(ctx, tokenB, `${title} | ~5`, 'the repeat');
        if (
          first.duplicate ||
          !again.duplicate ||
          again.id !== first.id ||
          !again.say.startsWith('Already added')
        )
          throw new Error(`first ${JSON.stringify(first)}, then ${JSON.stringify(again)}`);
        const n = (await ctx.api.reads.listTasks()).filter((t) => t.title === title).length;
        if (n !== 1) throw new Error(`${n} tasks titled “${title}”`);
      },
    },
    {
      id: 'api-unauth',
      entry: 'api',
      proves: ['unauth'],
      title:
        'No header, malformed, unknown, the session JWT, revoked → 401 with the spoken refusal',
      async run(ctx) {
        const S = await loadShared();
        const unknown = `apc_${randomBytes(32).toString('base64url')}`; // the right shape, never minted
        const cases: [string, string | null][] = [
          ['no header', null],
          ['a malformed token', 'apc_short'],
          ['an unknown token', unknown],
          ['the session JWT', 'jwt'],
          ['the revoked token', tokenA],
        ];
        for (const [what, bearer] of cases)
          refused(
            await ctx.api.writes.captureRaw(bearer, { text: line(ctx, 'unauth'), voice: true }),
            401,
            what,
            S.CAPTURE_SAY.unauthorized,
          );
      },
    },
    {
      id: 'api-isolation',
      entry: 'api',
      proves: ['isolation'],
      title: 'A capture token on an RPC → 401',
      async run(ctx) {
        const got = await ctx.api.writes.captureRaw(
          tokenB,
          { args: [] },
          { path: '/api/listTasks' },
        );
        if (got.status !== 401)
          throw new Error(`/api/listTasks with a capture token → ${got.status}`);
      },
    },
    {
      id: 'api-bad-input',
      entry: 'api',
      proves: ['bad-input'],
      title: 'Empty, too long, bad JSON, another path → 422; GET → 405; 16 KiB → 413; none counted',
      async run(ctx) {
        const S = await loadShared();
        const used = async () => (await tokenById(ctx, infoB.id))?.usedToday;
        const before = await used();
        const w = ctx.api.writes;
        refused(
          await w.captureRaw(tokenB, { text: '   ', voice: true }),
          422,
          'empty text',
          S.CAPTURE_SAY.empty,
        );
        refused(
          await w.captureRaw(tokenB, { text: 'x'.repeat(S.CAPTURE_TEXT_MAX + 1), voice: true }),
          422,
          `${S.CAPTURE_TEXT_MAX + 1} characters`,
          S.CAPTURE_SAY.tooLong,
        );
        refused(await w.captureRaw(tokenB, '{"text": '), 422, 'bad JSON', S.CAPTURE_SAY.empty);
        refused(
          await w.captureRaw(tokenB, { text: line(ctx, 'path') }, { path: '/api/capture/x' }),
          422,
          'another capture path',
          S.CAPTURE_SAY.path,
        );
        refused(
          await w.captureRaw(tokenB, {}, { method: 'GET' }),
          405,
          'a GET',
          S.CAPTURE_SAY.method,
        );
        refused(
          await w.captureRaw(tokenB, { text: 'x'.repeat(S.CAPTURE_BODY_MAX) }),
          413,
          'a body over 16 KiB',
          S.CAPTURE_SAY.tooLong,
        );
        const after = await used();
        if (after !== before) throw new Error(`a refusal was counted: ${before} → ${after} today`);
      },
    },
    {
      id: 'api-limit',
      entry: 'api',
      proves: ['limit'],
      title: 'Up to 5 live tokens, then the 6th is refused',
      async run(ctx) {
        const S = await loadShared();
        const room = S.SCOPED_TOKENS_MAX - (await ctx.api.reads.listScopedTokens()).length;
        const fillers: string[] = [];
        try {
          for (let i = 1; i <= room; i++)
            fillers.push((await ctx.api.writes.mintScopedToken(fillName(ctx, i))).info.id);
          const err = await ctx.api.writes.mintScopedToken(fillName(ctx, room + 1)).then(
            (m) => {
              fillers.push(m.info.id); // ledgered, and revoked below
              return null;
            },
            (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
          );
          if (!err) throw new Error(`a ${S.SCOPED_TOKENS_MAX + 1}th live token was minted`);
          if (!err.message.includes(`At most ${S.SCOPED_TOKENS_MAX} tokens`))
            throw new Error(`the 6th was refused for another reason: ${err.message}`);
          const n = (await ctx.api.reads.listScopedTokens()).length;
          if (n !== S.SCOPED_TOKENS_MAX) throw new Error(`${n} tokens listed`);
        } finally {
          for (const id of fillers)
            await ctx.api.writes.revokeScopedToken(id).catch(() => undefined);
        }
      },
    },
    {
      id: 'api-dup-window',
      entry: 'api',
      proves: ['dup-window'],
      cost: 'slow',
      title: 'The same line again a minute after the first: a new task (a 61 s wait)',
      async run(ctx) {
        const S = await loadShared();
        const title = line(ctx, 'window');
        const first = await capture(ctx, tokenB, `${title} | ~5`, 'the first', { tag: '#1' });
        await sleep(S.CAPTURE_DUPLICATE_MS + SEC); // past the window from the first's answer, so from its count
        const again = await capture(ctx, tokenB, `${title} | ~5`, 'past the window', { tag: '#2' });
        if (first.duplicate || again.duplicate || !again.id || again.id === first.id)
          throw new Error(`first ${JSON.stringify(first)}, then ${JSON.stringify(again)}`);
        if (again.say !== `Added: ${title}.`) throw new Error(`say is “${again.say}”`);
        await getTask(ctx, first.id!);
        await getTask(ctx, again.id);
      },
    },
    {
      id: 'api-busy',
      entry: 'api',
      cost: 'slow',
      proves: ['busy'],
      title: 'Eight captures at once through one token: 200 or a spoken 409, never a 5xx',
      async run(ctx) {
        const S = await loadShared();
        await clearOfMidnight(ctx, untilLaMidnight, 'LA midnight');
        await withToken(ctx, `devcheck ${ctx.nonce} busy`, async (token) => {
          const at = aheadClock(laClock(Date.now()).hour);
          const texts = Array.from({ length: 8 }, (_, i) =>
            i % 2
              ? `${line(ctx, `busy ${i}`)} | ~5`
              : `${line(ctx, `busy ${i} call the vet`)} at ${at}`,
          );
          const answers = await Promise.all(
            texts.map((text, i) =>
              ctx.api.writes.captureRaw(token, { text, voice: true }, { tag: `busy #${i}` }),
            ),
          );
          let busy = 0;
          for (const [i, got] of answers.entries()) {
            if (got.status === 409) {
              refused(got, 409, `busy #${i}`, S.CAPTURE_SAY.busy);
              busy++;
              continue;
            }
            const r = ok(got, `busy #${i}`);
            if (!r.id) throw new Error(`busy #${i}: answered with no task`);
            if (!taskIds.includes(r.id)) taskIds.push(r.id);
            await getTask(ctx, r.id);
          }
          ctx.log(`8 at once: ${8 - busy} added, ${busy} answered busy`);
          // Eight tries with backoff each: more than one of eight giving up means the retry isn't working.
          // Provisional until a dev run measures the spread (logged above) — then set from it.
          if (busy > 1)
            throw new Error(`${busy} of 8 answered busy — the lost-race retry isn't landing`);
        });
      },
    },
    {
      id: 'api-latency',
      entry: 'api',
      cost: 'slow',
      proves: ['latency'],
      title: 'Six spoken lines through the real parse, one at a time: each under 8 s and parsed',
      async run(ctx) {
        await clearOfMidnight(ctx, untilLaMidnight, 'LA midnight');
        const at = aheadClock(laClock(Date.now()).hour);
        const ms: number[] = [];
        for (let i = 1; i <= 6; i++) {
          const t0 = Date.now();
          const r = await capture(
            ctx,
            tokenB,
            `${line(ctx, `quick ${i} call the vet`)} at ${at}`,
            `latency ${i}`,
          );
          ms.push(Date.now() - t0);
          if (r.raw)
            throw new Error(`latency ${i}: saved as typed after ${ms.at(-1)} ms — ${r.detail}`);
        }
        const sorted = [...ms].sort((a, b) => a - b);
        const pct = (p: number) =>
          sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
        ctx.log(
          `capture latency (ms, from the container): n ${ms.length}, p50 ${pct(0.5)}, p95 ${pct(0.95)}, max ${sorted.at(-1)} — ${ms.join(', ')}`,
        );
        if (sorted.at(-1)! > 8_000)
          throw new Error(`a capture took ${sorted.at(-1)} ms (Siri's budget is 8 s)`);
      },
    },
    {
      id: 'api-cap',
      entry: 'api',
      proves: ['cap'],
      cost: 'slow',
      title:
        'A fresh token: 200 captures of one grammar line, then the 201st → 429 with the spoken limit',
      async run(ctx) {
        const S = await loadShared();
        await clearOfMidnight(ctx, untilUtcMidnight, 'UTC midnight', 3 * MIN); // the cap's day is UTC
        await withToken(ctx, nameC(ctx), async (token, info) => {
          const text = `${line(ctx, 'cap')} | ~5`;
          const day = new Date().toISOString().slice(0, 10);
          const rolled = () =>
            new Date().toISOString().slice(0, 10) !== day ? ' (the UTC day rolled)' : '';
          // The first alone (it makes the task), then the rest two at a time — the counter's conditional write
          // gives up after a few lost races (a 500), and dev's concurrency reservation is shared. A duplicate
          // counts toward the cap and costs no model call; past the minute's window the same line makes one
          // more task, recorded like the first. Each call's ledger title carries its number, so a 5xx's open
          // intent can't hide behind a sibling's answer. The first failure stops both workers.
          await capture(ctx, token, text, 'capture 1', { tag: '#1' });
          let next = 2;
          const stopped: { err?: Error } = {};
          const worker = async () => {
            while (!stopped.err && next <= S.CAPTURE_DAILY_CAP) {
              const i = next++;
              try {
                await capture(
                  ctx,
                  token,
                  text,
                  `capture ${i} of ${S.CAPTURE_DAILY_CAP}${rolled()}`,
                  {
                    tag: `#${i}`,
                  },
                );
              } catch (err) {
                stopped.err ??= err instanceof Error ? err : new Error(String(err));
              }
            }
          };
          await Promise.all([worker(), worker()]);
          if (stopped.err) throw stopped.err;
          const used = (await tokenById(ctx, info.id))?.usedToday;
          if (used !== S.CAPTURE_DAILY_CAP)
            throw new Error(`after the captures it reads ${used} today${rolled()}`);
          const over = S.CAPTURE_DAILY_CAP + 1;
          refused(
            await ctx.api.writes.captureRaw(token, { text, voice: true }, { tag: `#${over}` }),
            429,
            `capture ${over}${rolled()}`,
            S.CAPTURE_SAY.cap,
          );
        });
      },
    },
    {
      id: 'api-parse-cap',
      entry: 'api',
      proves: ['parse-cap'],
      cost: 'slow',
      title:
        'A fresh token: distinct spoken lines (real parses) until the user’s 40 a day are spent, then one saves without AI, keeping its time',
      async run(ctx) {
        const S = await loadShared();
        await clearOfMidnight(ctx, untilUtcMidnight, 'UTC midnight', 7 * MIN); // the parse cap's day is UTC too
        await withToken(ctx, nameD(ctx), async (token) => {
          const day = new Date().toISOString().slice(0, 10);
          const at = aheadClock(laClock(Date.now()).hour);
          // One at a time: each is a real model call. The cap is the user's, across every live capture token, so
          // the run's earlier rows spent some of it already: the refusal comes within the cap's count, never
          // later. A raw save on the way (a missed deadline) still spent its claim, so it counts like a parse.
          let raws = 0;
          const spentB = parsedB.filter((d) => d === day).length;
          const latest = S.CAPTURE_PARSE_DAILY_CAP - spentB + 1;
          for (let i = 1; i <= latest; i++) {
            const text = `${line(ctx, `parse ${i} call the vet`)} at ${at}`;
            const t0 = Date.now();
            const r = await capture(ctx, token, text, `parse ${i}`);
            if (!r.raw) continue;
            if (!r.detail.includes('daily parse limit reached')) {
              raws++;
              continue;
            }
            // Past the cap: no model, but the words' own time, placed by the voice rules, and said so.
            const want = spokenWant(S, text, t0, Date.now());
            if (!r.due || !want.some((w) => w.day === r.due!.day && w.time === r.due!.time))
              throw new Error(
                `parse ${i}: due ${JSON.stringify(r.due)}, expected ${JSON.stringify(want[0])}`,
              );
            if (!r.say.startsWith('Added without AI, as typed: '))
              throw new Error(`parse ${i}: say is “${r.say}”`);
            ctx.log(
              `parse cap: refused at capture ${i} of this token, ${spentB} spent through another this run (${raws} saved as typed on the way)`,
            );
            return;
          }
          throw new Error(
            `no refusal by capture ${latest} of this token, though another spent ${spentB} of the user's ${S.CAPTURE_PARSE_DAILY_CAP} today — a per-token cap?${new Date().toISOString().slice(0, 10) !== day ? ' (the UTC day rolled)' : ''}`,
          );
        });
      },
    },
    {
      id: 'api-long-line',
      entry: 'api',
      proves: ['long-line'],
      title: 'A spoken line past 600 characters: saved as typed, its time kept, “without AI”',
      async run(ctx) {
        const S = await loadShared();
        await clearOfMidnight(ctx, untilLaMidnight, 'LA midnight');
        const head = line(ctx, 'long call the vet');
        const pad = ' and then the rest of a very long thought'.repeat(
          Math.ceil(S.CAPTURE_PARSE_TEXT_MAX / 40),
        );
        const text = `${head}${pad} at ${aheadClock(laClock(Date.now()).hour)}`;
        const t0 = Date.now();
        const r = await capture(ctx, tokenB, text, 'the long line');
        const want = spokenWant(S, text, t0, Date.now());
        if (!r.raw || !r.detail.includes('too long for the model'))
          throw new Error(`not saved as typed: ${r.detail}`);
        if (!r.due || !want.some((w) => w.day === r.due!.day && w.time === r.due!.time))
          throw new Error(`due ${JSON.stringify(r.due)}, expected ${JSON.stringify(want[0])}`);
        if (!r.say.startsWith('Added without AI, as typed: ')) throw new Error(`say is “${r.say}”`);
        if ((await getTask(ctx, r.id!)).title !== text)
          throw new Error('the title isn’t the line as typed');
      },
    },
    {
      id: 'teardown',
      entry: 'api',
      title:
        'Revoke the run’s tokens and delete the route’s tasks now, so no later scenario sees them',
      async run(ctx) {
        for (const t of await ctx.api.reads.listScopedTokens())
          if (t.id === infoB?.id) await ctx.api.writes.revokeScopedToken(t.id);
        for (const id of taskIds)
          if (await ctx.api.reads.getTask(id)) await ctx.api.writes.deleteTask(id);
        const left = (await ctx.api.reads.listScopedTokens()).filter((t) =>
          t.name.includes(ctx.nonce),
        );
        if (left.length) throw new Error(`still listed: ${left.map((t) => t.name).join(', ')}`);
      },
    },
    noConsoleErrors,
  ],
};
