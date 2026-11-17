// Voice capture — "Hey Siri, Aperture" / the Action Button / Raycast → a task (docs/areas/tasks/capture.md). A
// capture token is made, kept through a cancelled revoke and a reload, and revoked in Settings › Capture; the
// route itself (POST /api/capture) is driven raw (api.ts captureRaw) with tokens minted through the guarded API.
// Tokens are ledgered by the id the mint answered with (the browser's mintScopedToken response, recorder.ts,
// or the API's), every task the route made by the 200's `id`; cleanup revokes and deletes by those records,
// and the scenario's last step does it early so the scenarios after it see none of this. A token's plaintext
// lives in this module's memory only — never in a log, an error, a screenshot or the ledger. Names and titles
// carry the run's nonce. The time rows compute what the server should answer with the shared resolver itself
// (packages/shared/src/spokenTime.ts) at the moment of the call: the rules are the unit tests' (the off-dev
// rows); these prove the route applies them, with the model's day and the server's clock, end to end.
import { randomBytes } from 'node:crypto';
import type { DevCaptureResult, DevScopedToken } from '../api';
import type { PwRequest } from '../pw-types';
import { methodOf } from '../recorder';
import { hidingSecret, laDay, noConsoleErrors, type Ctx, type Scenario } from '../scenario';

// The slice of @aperture/shared the scenario reads. scripts doesn't depend on shared, so its source is loaded at
// run time (tsx transpiles it) — the same rules and texts the Lambda runs, never a copy that could drift.
interface Shared {
  CAPTURE_SAY: Record<'unauthorized' | 'method' | 'path' | 'empty' | 'tooLong' | 'cap', string>;
  CAPTURE_DAILY_CAP: number;
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
}
const SHARED_SRC = new URL('../../../../packages/shared/src/', import.meta.url);
let sharedP: Promise<Shared> | undefined;
export const loadShared = (): Promise<Shared> =>
  (sharedP ??= Promise.all(
    ['dates.ts', 'spokenTime.ts', 'capture.ts'].map(
      (f) => import(new URL(f, SHARED_SRC).href) as Promise<object>,
    ),
  ).then((mods) => Object.assign({}, ...mods) as Shared));

const TOKEN_RE = /^apc_[A-Za-z0-9_-]{43}$/;
const MIN = 60_000;
const HOUR = 60 * MIN;
// A clock or a stated time left in a title: the voice rules strip it (capture.md → Time rules).
const TIME_WORDS =
  /\bat\s+\d|\b\d{1,2}(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)(?=\s|$)|o['’]?\s?clock|\bin\s+\d+\s*min/i;

const line = (ctx: Ctx, what: string) => `devcheck ${ctx.nonce} ${what}`;
const nameA = (ctx: Ctx) => `devcheck ${ctx.nonce} phone`; // made and revoked in Settings
const nameB = (ctx: Ctx) => `devcheck ${ctx.nonce} mac`; // the neighbour, minted through the API
const nameC = (ctx: Ctx) => `devcheck ${ctx.nonce} cap`; // the cap row's own
const fillName = (ctx: Ctx, i: number) => `devcheck ${ctx.nonce} fill ${i}`;

// Steps share what earlier ones made; a failed step skips the rest, so these are set when read.
let tokenA: string; // plaintexts — never logged
let tokenB: string;
let tokenC: string | undefined;
let infoA: DevScopedToken;
let infoB: DevScopedToken;
let infoC: DevScopedToken | undefined;
let taskIds: string[] = []; // every task the route made this run, torn down by the last step

// The LA wall clock now (the hour 0–23 and the minute).
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
const h12 = (h: number) => h % 12 || 12;
const ampm = (h: number) => `${h12(h)} ${h < 12 ? 'am' : 'pm'}`;
// "at N" for an hour already past in both its AM and PM readings today (or today's, then the next) — so it can
// only wrap: the hour before now; near the hour's end (≥ :55) the current one, so the answer can't move while
// the call is in flight. Lands 10–12 h ahead.
export const wrapHour = (hour: number, minute: number): number =>
  h12(minute >= 55 ? hour : (hour + 23) % 24);
// A stated clock one hour ago ("at 5 pm" at 6:xx PM) — rolled to tomorrow. At midnight's hour the hour before
// is yesterday's 11 PM, which is still ahead today, so it says this hour's "12 am" instead.
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
// One spoken capture with `token`; a new task's id is kept for the teardown (the ledger has it already).
async function capture(ctx: Ctx, token: string, text: string, what: string) {
  const r = ok(await ctx.api.writes.captureRaw(token, { text, voice: true }), what);
  if (r.id && !r.duplicate && !taskIds.includes(r.id)) taskIds.push(r.id);
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
    await new Promise((r) => setTimeout(r, 500));
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

// The show-once reveal, from the click that mints: read it, then close it at once. Any throw on the way blanks
// the page before it leaves (scenario.ts hidingSecret), so no shot, a failure's included, ever holds the token.
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

// The voice rows: the answer's due equals what the shared resolver gives for the words with no named day, at
// the call's start or its end (the server's clock is somewhere between), and `say` speaks it.
async function expectSpokenDue(
  ctx: Ctx,
  S: Shared,
  text: string,
  r: DevCaptureResult,
  t0: number,
  t1: number,
): Promise<{ day: string; time: string; at: number }> {
  if (r.raw)
    throw new Error(
      `saved as typed (raw: true) — the parse failed or missed its deadline; if this repeats, raise CAPTURE_PARSE_DEADLINE_MS: ${r.say}`,
    );
  const spoken = S.spokenTimeIn(text);
  if (!spoken) throw new Error(`the scenario's line has no spoken time: ${text}`);
  const want = [t0, t1].map((now) =>
    S.resolveSpoken(spoken, null, { now, today: laDay(new Date(now)) }),
  );
  const due = r.due;
  if (!due?.time || !want.some((w) => w.day === due.day && w.time === due.time))
    throw new Error(`due ${JSON.stringify(due)}, expected ${JSON.stringify(want[0])}`);
  const task = await getTask(ctx, r.id!);
  if (task.dueDay !== due.day || task.dueTime !== due.time)
    throw new Error(
      `the answer says ${JSON.stringify(due)}, the task holds ${task.dueDay} ${task.dueTime}`,
    );
  if (!task.title.includes(ctx.nonce) || TIME_WORDS.test(task.title))
    throw new Error(`the title is “${task.title}” — the nonce kept, the spoken time taken out`);
  const when = S.captureWhen(due, laDay(new Date(t1)), laDay(new Date(t1)));
  if (!r.say.startsWith('Added: ') || !when || !r.say.endsWith(`, ${when}.`))
    throw new Error(`say is “${r.say}”, expected it to end “, ${when}.”`);
  return { ...due, time: due.time, at: S.zonedEpoch(due.day, due.time, S.USER_TIME_ZONE) };
}

export const siriCapture: Scenario = {
  id: 'siri-capture',
  title: 'Voice capture: Settings › Capture tokens and the capture route',
  tiers: ['full'],
  slowPaths: ['lambdas/src/auth/scopedToken.ts', 'packages/shared/src/capture.ts'],
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
      id: 'limit',
      entry: 'api',
      kind: 'edge',
      what: 'A 6th live token is refused: “At most 5 tokens”',
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
      id: 'relative',
      entry: 'api',
      kind: 'nominal',
      what: '“in 20 minutes” is now + 20 from the server clock, never an estimate, and the answer names the day',
    },
    {
      id: 'wrap',
      entry: 'api',
      kind: 'edge',
      what: 'A bare “at N” already past in both readings wraps to the next N o’clock, ~11 h on',
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
      id: 'typed-unchanged',
      entry: 'api',
      kind: 'edge',
      what: 'A typed line (no voice flag) keeps the typed rule: a past clock lands today',
      offDev: {
        file: 'packages/shared/src/quickParse.test.ts',
        test: 'typed lines keep the 2026-10-09 rule: a past clock lands today',
        why: 'needs a clock already past a stated time and a model reply that names it, which dev can’t pin',
      },
    },
    {
      id: 'dup-window',
      entry: 'api',
      kind: 'edge',
      what: 'The same line after the 60 s window is a new task',
      offDev: {
        file: 'lambdas/src/backend.capture.test.ts',
        // The it() title is a template literal; matrix.ts matches its source text.
        test: 'the same line after ${CAPTURE_DUPLICATE_MS / 1000} s is a new task',
        why: 'a 60 s wall-clock wait per run — the window itself is a pure comparison on the token row',
      },
    },
    {
      id: 'parse-cap',
      entry: 'api',
      kind: 'edge',
      what: 'Past 50 model parses a day the line saves as typed, and says so',
      offDev: {
        file: 'lambdas/src/backend.capture.test.ts',
        test: 'past ${CAPTURE_PARSE_DAILY_CAP} model calls a day the line saves as typed, and the model isn’t called',
        why: '50 real Haiku calls a run — the cap is a counter on the token row, the same conditional write the capture cap (proven on dev) uses',
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
        test: 'a failed or timed-out parse saves the line as typed and says so',
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
        tokenC = undefined;
        infoC = undefined;
        const S = await loadShared();
        // A token a crashed run minted is swept first; one nothing recorded (the pipeline reports those) can
        // still crowd the run out of the room it needs (this one, the neighbour, the cap's).
        const live = await ctx.api.reads.listScopedTokens();
        if (live.length > S.SCOPED_TOKENS_MAX - 3)
          throw new Error(
            `the test user already holds ${live.length} capture tokens (${live.map((t) => t.name).join(', ')}) — revoke the strays`,
          );
        await ctx.ui.goto('/settings');
        await ctx.page.getByLabel('New token for', { exact: true }).fill(nameA(ctx));
        tokenA = await takeRevealedToken(ctx, () =>
          ctx.page.getByRole('button', { name: 'Make capture token', exact: true }).click(),
        );
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
          const field = ctx.page.getByLabel('New token for', { exact: true });
          const make = ctx.page.getByRole('button', { name: 'Make capture token', exact: true });
          const refusedWith = async (name: string, why: string | null, shot: string) => {
            await field.fill(name);
            if (why) await ctx.ui.expectText(why);
            if (!(await make.isDisabled()))
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
          await new Promise((r) => setTimeout(r, 500)); // a stray mint would be on the wire by now
        } finally {
          ctx.page.off('request', watch);
        }
        if (sent.length) throw new Error(`a refused name still sent ${sent.length} mint(s)`);
        const after = (await ctx.api.reads.listScopedTokens()).length;
        if (after !== before) throw new Error(`the token count moved ${before} → ${after}`);
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
        const t0 = Date.now();
        const text = `${line(ctx, 'call the plumber')} at ${aheadClock(laClock(t0).hour)}`;
        const r = await capture(ctx, tokenB, text, 'the spoken line');
        await expectSpokenDue(ctx, S, text, r, t0, Date.now());
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
          throw new Error(
            `due ${Math.round((due.at - t0) / 1000)} s after the call, not 20–21 min`,
          );
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
      title: 'A bare “at N” already past in both readings wraps ~11 h on',
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
      id: 'api-roll',
      entry: 'api',
      proves: ['roll'],
      title: 'A stated clock an hour ago rolls to tomorrow, said “tomorrow”',
      async run(ctx) {
        const S = await loadShared();
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
          const extra = fillName(ctx, room + 1);
          const err = await ctx.api.writes.mintScopedToken(extra).then(
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
      id: 'api-cap',
      entry: 'api',
      proves: ['cap'],
      cost: 'slow',
      title:
        'A fresh token: 200 captures of one grammar line, then the 201st → 429 with the spoken limit',
      async run(ctx) {
        const S = await loadShared();
        const minted = await ctx.api.writes.mintScopedToken(nameC(ctx));
        tokenC = minted.token;
        infoC = expectFresh(tokenC, minted.info, 'the cap’s token');
        const token = tokenC;
        const text = `${line(ctx, 'cap')} | ~5`;
        const day = new Date().toISOString().slice(0, 10); // the cap's day is UTC
        const rolled = () =>
          new Date().toISOString().slice(0, 10) !== day ? ' (the UTC day rolled)' : '';
        // The first alone (it makes the task), then the rest four at a time — under dev's concurrency
        // reservation. A duplicate counts toward the cap and costs no model call; past the minute's window
        // the same line makes one more task, recorded like the first.
        await capture(ctx, token, text, 'capture 1');
        let next = 2;
        const worker = async () => {
          while (next <= S.CAPTURE_DAILY_CAP) {
            const i = next++;
            const got = await ctx.api.writes.captureRaw(token, { text, voice: true });
            if (got.status !== 200)
              throw new Error(
                `capture ${i} of ${S.CAPTURE_DAILY_CAP} → ${got.status}${rolled()}: ${JSON.stringify(got.body)}`,
              );
            const r = got.body as DevCaptureResult;
            if (r.id && !r.duplicate && !taskIds.includes(r.id)) taskIds.push(r.id);
          }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
        const used = (await tokenById(ctx, infoC.id))?.usedToday;
        if (used !== S.CAPTURE_DAILY_CAP)
          throw new Error(`after the captures it reads ${used} today${rolled()}`);
        refused(
          await ctx.api.writes.captureRaw(token, { text, voice: true }),
          429,
          `capture ${S.CAPTURE_DAILY_CAP + 1}${rolled()}`,
          S.CAPTURE_SAY.cap,
        );
      },
    },
    {
      id: 'teardown',
      entry: 'api',
      title:
        'Revoke the run’s tokens and delete the route’s tasks now, so no later scenario sees them',
      async run(ctx) {
        for (const id of [infoB?.id, infoC?.id])
          if (id && (await tokenById(ctx, id))) await ctx.api.writes.revokeScopedToken(id);
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
