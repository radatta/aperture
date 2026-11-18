// Places — errand lists by store, and the iPhone Shortcut's read of one (docs/areas/tasks/places.md). The
// places are added, renamed and deleted in Settings and errands captured onto them the way the user does it;
// the Shortcut's route is driven raw (api.ts placeDigestRaw) with a token rotated through the guarded API,
// then generated, rotated and revoked through Settings. Names and slugs carry the run's nonce, so no run can
// collide with another's leftover. The token's plaintext lives in this module's memory only — never in a log,
// an error, a screenshot or the ledger. The rows are the plan's dev-test matrix (localNotes/plan.md §4 D) plus
// review rounds 1 and 2 (localNotes/decisions.md) — round 2 the broken-down errand. The scenario drives the
// daily read cap on dev (sequential GETs to the server's own 429, ~40–60 s).
//
// Places and the place token are two ledger kinds (DEV-CHECK.md → What it guarantees). A place is recorded from
// the create's id (`via: api:upsertPlace`, or `ui:upsertPlace` when the browser's request has no `id`, through
// recorder.ts — a rename is never recorded, so cleanup can't delete a place the run didn't make) and is deleted
// with deletePlace(id, null) (finished errands keep the old slug — harmless, tasks are cleaned by id). The token
// is recorded as `place-token:<run>` before rotatePlaceToken (never the token itself), and revokePlaceToken is
// refused unless a run-minted token is still unresolved — a Settings Generate/Rotate click records the same id
// first (recordPlaceTokenMint), so a browser-minted token is cleaned too. Cleanup revokes it, which leaves the
// test user an inactive `ptoken` pointer (never deleted); a revoke racing another device throws, cleanup catches
// per id, so the loop goes on, the run reports it, and the next run's sweep retries it. A step that shows the
// token runs inside hidingSecret: any failure blanks the page (about:blank) and skips the failure screenshot,
// so the token never lands in screenshots/. ledgerKind() tells task, Flux, place and token apart by `via`, so a
// task delete refuses a place id and vice versa. An unrecorded place that appears during the run is a LEFTOVERS
// failure, like a task. Every run, smoke included, lists places after the sweep — so the harness needs a dev
// build with the places methods.
import { randomBytes } from 'node:crypto';
import { targetOrigin } from '../config';
import type { DevPlace, DevPlaceTokenStatus, DevTask } from '../api';
import { hidingSecret, laDay, noConsoleErrors, type Ctx, type Scenario } from '../scenario';

// packages/shared/src/places.ts PLACE_READ_DAILY_CAP (scripts doesn't depend on shared): reads per token per
// UTC day. If it moves, the cap step fails naming where the 429 came.
const PLACE_READ_DAILY_CAP = 200;
// packages/shared/src/places.ts PLACE_PART_ERROR: setTaskPlace on a part (a part follows its parent's place).
const PLACE_PART_ERROR = "A part follows its parent's place — change the parent's";
const TOKEN_RE = /^apl_[A-Za-z0-9_-]{43}$/;

// slugify(name) for these names: the nonce is [A-Za-z0-9], so lowercasing it is the whole rule.
const n = (ctx: Ctx) => ctx.nonce.toLowerCase();
const placeName = (ctx: Ctx) => `Devcheck ${ctx.nonce}`;
const placeSlug = (ctx: Ctx) => `devcheck-${n(ctx)}`;
const otherName = (ctx: Ctx) => `Devcheck ${ctx.nonce} B`;
const otherSlug = (ctx: Ctx) => `devcheck-${n(ctx)}-b`;
// The second place after Settings renames it and retypes its link word.
const renamedName = (ctx: Ctx) => `Devcheck ${ctx.nonce} C`;
const renamedSlug = (ctx: Ctx) => `devcheck-${n(ctx)}-c`;
const thirdName = (ctx: Ctx) => `Devcheck ${ctx.nonce} D`;
const thirdSlug = (ctx: Ctx) => `devcheck-${n(ctx)}-d`;
// The list an errand is broken down on — its own, so no other list's counts move.
const partsName = (ctx: Ctx) => `Devcheck ${ctx.nonce} E`;
const partsSlug = (ctx: Ctx) => `devcheck-${n(ctx)}-e`;
const unknownSlug = (ctx: Ctx) => `nx-${n(ctx)}`; // never created
const badSlug = (ctx: Ctx) => `bad_${n(ctx)}`; // outside the slug shape: the route's malformed path
// Not "devcheck <nonce> …": the parts scenarios match their tasks by that prefix.
const errand = (ctx: Ctx, what: string) => `devcheck-pl ${ctx.nonce} ${what}`;
const lensPath = (slug: string) => `/tasks?lens=places&place=${slug}`;

// Steps share what earlier ones made; a failed step skips the rest, so these are set when read.
let place: DevPlace;
let other: DevPlace; // the second place — renamed in Settings, then deleted to "No place"
let third: DevPlace; // deleted in Settings, its errand moved to the second
let shampooId: string;
let againId: string; // "Add again"'s copy of the checked-off shampoo, back on the first list
let strayId: string; // captured onto no list, then put on the second by the editor
let nailsId: string;
let syrupId: string;
let soapId: string;
let partsPlace: DevPlace; // the list the party errand is broken down on
let partyId: string; // the errand broken down — a parent, so the lists leave it out
let partIds: string[]; // its two parts, as the server orders the list's items
let partTitles: string[];
let placeToken: string; // the current token's plaintext — never logged
let readsToday = 0; // the current token's count, as the server last said

const lastCreated = (ctx: Ctx, what: string): string => {
  const id = ctx.createdIds().at(-1);
  if (!id) throw new Error(`${what}: the create response never reached the ledger`);
  return id;
};
async function tokenStatus(ctx: Ctx): Promise<DevPlaceTokenStatus> {
  return ctx.api.reads.getPlaceTokenStatus();
}
const fieldsOf = (body: unknown): Record<string, unknown> =>
  (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
const errorOf = (body: unknown): string => String(fieldsOf(body).error ?? '');
// The Shortcut's read answered `status` with the route's refusal body — an `error`, and a `text` the
// Shortcut shows (no failure is silent) — and the server counted nothing.
async function expectRefused(ctx: Ctx, got: { status: number; body: unknown }, status: number) {
  if (got.status !== status)
    throw new Error(`expected HTTP ${status}, got ${got.status}: ${JSON.stringify(got.body)}`);
  const { error, text } = fieldsOf(got.body);
  if (typeof error !== 'string' || !error || typeof text !== 'string' || !text.trim())
    throw new Error(`a ${status} without its error and text: ${JSON.stringify(got.body)}`);
  const after = (await tokenStatus(ctx)).readsToday;
  if (after !== readsToday)
    throw new Error(`a ${status} counted a read (${readsToday} → ${after})`);
}
// One Shortcut read with `token` answered 200 and counted exactly one.
async function readCounted(ctx: Ctx, slug: string, token: string) {
  const got = await ctx.api.reads.placeDigestRaw(slug, token);
  if (got.status !== 200)
    throw new Error(`GET ${slug} → ${got.status}: ${JSON.stringify(got.body)}`);
  const now = (await tokenStatus(ctx)).readsToday;
  if (now !== readsToday + 1) throw new Error(`a read counted ${readsToday} → ${now}`);
  readsToday = now;
  return got.body;
}
// The status for a token just minted — without echoing its hint into an error.
async function expectFresh(ctx: Ctx, token: string, what: string) {
  if (!TOKEN_RE.test(token)) throw new Error(`${what}: the shown token isn't a place token`);
  const s = await tokenStatus(ctx);
  if (!s.active || s.hint !== token.slice(-4) || s.readsToday !== 0 || s.lastUsedAt !== null)
    throw new Error(`${what}: the status reads ${JSON.stringify({ ...s, hint: '…' })}`);
  readsToday = 0;
  return s;
}
// Exact: the other places' names extend the first's.
const region = (ctx: Ctx, name: string) => ctx.page.getByRole('region', { name, exact: true });
const checkOff = (ctx: Ctx, listName: string, what: string) =>
  region(ctx, listName).getByRole('button', {
    name: `Check off ${errand(ctx, what)}`,
    exact: true,
  });
// The body has exactly these fields with these values — nothing more (no ids, notes or estimates leave).
function expectBody(body: unknown, want: Record<string, unknown>): void {
  const got = fieldsOf(body);
  const keys = (o: object) => Object.keys(o).sort().join();
  const off = Object.entries(want).filter(([k, v]) => JSON.stringify(got[k]) !== JSON.stringify(v));
  if (keys(got) !== keys(want) || off.length)
    throw new Error(`GET answered ${JSON.stringify(body)}`);
}
// The server catches up with a save the page already showed (a Settings blur, the editor's Save).
async function until<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  const end = Date.now() + 15_000;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`${what}: the server still has ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
const getTask = async (ctx: Ctx, id: string): Promise<DevTask> => {
  const t = await ctx.api.reads.getTask(id);
  if (!t) throw new Error(`task ${id} is gone`);
  return t;
};
const placeById = async (ctx: Ctx, id: string) =>
  (await ctx.api.reads.listPlaces()).find((p) => p.id === id) ?? null;
// The open errands on one list, as the server orders its digest.
const openOn = async (ctx: Ctx, slug: string) => (await ctx.api.reads.listPlaceTasks(slug)).titles;
// The first list holds only the copy "Add again" made — so nothing the second list's edits did reached it.
async function firstListUntouched(ctx: Ctx) {
  const titles = await openOn(ctx, place.slug);
  if (JSON.stringify(titles) !== JSON.stringify([errand(ctx, 'shampoo')]))
    throw new Error(`the neighbouring list now reads ${JSON.stringify(titles)}`);
  if ((await getTask(ctx, againId)).place !== place.slug)
    throw new Error('the neighbouring errand left its list');
}

// The lens's group for the parts place reads `titles` — its header count, then its check rows in order — so
// it says what the Shortcut says: items, never the parent beside its parts.
async function lensAgrees(ctx: Ctx, titles: string[]) {
  const list = region(ctx, partsPlace.name);
  await list
    .getByText(`${partsPlace.name} · ${titles.length}`, { exact: true })
    .waitFor({ state: 'visible', timeout: 15_000 });
  const checks = list.getByRole('button', { name: /^Check off / });
  const n = await checks.count();
  const rows: string[] = [];
  for (let i = 0; i < n; i++) rows.push((await checks.nth(i).getAttribute('aria-label')) ?? '');
  const want = titles.map((t) => `Check off ${t}`);
  if (JSON.stringify(rows) !== JSON.stringify(want))
    throw new Error(
      `the lens’s rows are ${JSON.stringify(rows)}, the Shortcut’s ${JSON.stringify(want)}`,
    );
}

// The show-once screen, from the click that mints the token: read it, then close it at once. Any throw on
// the way — the reveal never came, came after the wait gave up, or wouldn't close — blanks the page before it
// leaves (scenario.ts hidingSecret), so no shot, a failure's included, ever holds the token.
export async function takeRevealedToken(
  ctx: Pick<Ctx, 'page'>,
  mint: () => Promise<void>,
): Promise<string> {
  return hidingSecret(ctx.page, async () => {
    await mint();
    const field = ctx.page.getByRole('textbox', { name: 'Shortcut token', exact: true });
    await field.waitFor({ state: 'visible', timeout: 15_000 });
    const token = await field.inputValue();
    await ctx.page.getByRole('button', { name: 'Done', exact: true }).click({ timeout: 5_000 });
    await field.waitFor({ state: 'hidden', timeout: 5_000 });
    return token;
  });
}

export const places: Scenario = {
  id: 'places',
  title: 'Places: errand lists by store, and the Shortcut’s read',
  tiers: ['full'],
  rows: [
    {
      id: 'add-place',
      entry: 'ui',
      kind: 'nominal',
      what: 'Settings › Places: a store name, Add → its row shows, the Shortcut never called',
    },
    {
      id: 'capture',
      entry: 'ui',
      kind: 'nominal',
      what: 'Capturing “… | ~15 @<link word>” says Task added, and the task is on that list',
    },
    {
      id: 'lens',
      entry: 'ui',
      kind: 'nominal',
      what: 'The lens link (?lens=places&place=<link word>) opens that store’s list with the errand on it',
    },
    {
      id: 'check-off',
      entry: 'ui',
      kind: 'nominal',
      what: 'One tap checks the errand off: “Checked off”, it leaves the list, the server has it done',
    },
    {
      id: 'add-again',
      entry: 'ui',
      kind: 'edge',
      what: 'Add again, right after a check-off, puts a copy (title, estimate) back on the same list',
    },
    {
      id: 'settings-heartbeat',
      entry: 'ui',
      kind: 'nominal',
      what: 'After the Shortcut’s read, Settings says the place was last called and the token was used today',
    },
    {
      id: 'test-panel',
      entry: 'ui',
      kind: 'nominal',
      what: 'Settings › Test on a place shows the banner text the Shortcut would show, and counts no read',
    },
    {
      id: 'recipe',
      entry: 'ui',
      kind: 'nominal',
      what: 'The Shortcut recipe gives the full URL template, <origin>/api/places/[Shortcut Input]/tasks, and says “Aperture didn’t answer” when no answer comes',
    },
    {
      id: 'rename',
      entry: 'ui',
      kind: 'nominal',
      what: 'Renaming a place and retyping its link word in Settings: its errands follow to the new word',
    },
    {
      id: 'editor-place',
      entry: 'ui',
      kind: 'nominal',
      what: 'The task editor’s Place select puts a task on a store’s list (Save → Saved)',
    },
    {
      id: 'bulk-place',
      entry: 'ui',
      kind: 'nominal',
      what: 'Bulk add “title | @<link word>” puts the task on that list',
    },
    {
      id: 'delete-move',
      entry: 'ui',
      kind: 'nominal',
      what: 'Deleting a place, moving its errands to another place: they land on that list',
    },
    {
      id: 'delete-none',
      entry: 'ui',
      kind: 'edge',
      what: 'Deleting a place with “No place”: its open errands go on no list, a done one keeps its link word',
    },
    {
      id: 'delete-neighbour',
      entry: 'ui',
      kind: 'edge',
      what: 'Deleting one place leaves another place’s errands where they are',
    },
    {
      id: 'ui-token',
      entry: 'ui',
      kind: 'nominal',
      what: 'Settings › Generate token shows it once; it reads 200, the revoked one before it still 401s',
    },
    {
      id: 'ui-rotate',
      entry: 'ui',
      kind: 'nominal',
      what: 'Settings › Rotate… → Rotate shows a new token once: the new one reads 200, the old one 401s',
    },
    {
      id: 'ui-revoke',
      entry: 'ui',
      kind: 'nominal',
      what: 'Settings › Revoke… → Revoke: “No token yet”, and the token 401s',
    },
    {
      id: 'unknown-slug',
      entry: 'ui',
      kind: 'edge',
      what: 'An unknown @word warns “no place” and still saves the task, on no list',
    },
    {
      id: 'roster-failed',
      entry: 'ui',
      kind: 'edge',
      what: 'The places read failing says “Couldn’t load places.” on Settings; Retry brings the list back',
    },
    {
      id: 'reload',
      entry: 'ui',
      kind: 'edge',
      what: 'A reload keeps the lens URL and the store’s list',
    },
    {
      id: 'shortcut-read',
      entry: 'api',
      kind: 'nominal',
      what: 'With a rotated token, GET /api/places/<slug>/tasks answers 200: the errand, the banner text, the lens link — and counts one read',
    },
    {
      id: 'capital-slug',
      entry: 'api',
      kind: 'edge',
      what: 'The link word typed capitalised in the URL still reads the list (200, the slug lowercase)',
    },
    {
      id: 'neighbour',
      entry: 'api',
      kind: 'edge',
      what: 'Another place’s errand never shows in this place’s read, and that place’s heartbeat stays unset',
    },
    {
      id: 'wrong-token',
      entry: 'api',
      kind: 'edge',
      what: 'A well-formed token that isn’t the user’s → 401, with a text to show',
    },
    { id: 'no-token', entry: 'api', kind: 'edge', what: 'No token header → 401, with a text' },
    {
      id: 'unknown-place',
      entry: 'api',
      kind: 'edge',
      what: 'An unknown slug with a good token → 422 (never 404, which CloudFront turns into the app) with a text, not counted',
    },
    {
      id: 'bad-path',
      entry: 'api',
      kind: 'edge',
      what: 'A malformed /api/places/* path → 422 with a text, not counted',
    },
    {
      id: 'post',
      entry: 'api',
      kind: 'edge',
      what: 'A POST to the route → 405 with a text, and the read isn’t counted',
    },
    {
      id: 'revoked',
      entry: 'api',
      kind: 'edge',
      what: 'After a revoke the status reads inactive and the old token → 401',
    },
    {
      id: 'calibration',
      entry: 'api',
      kind: 'edge',
      what: 'A checked-off errand with an estimate (locked at start) never becomes a calibration point',
    },
    {
      id: 'cap',
      entry: 'api',
      kind: 'edge',
      what: 'Past the daily cap (200 reads a token a UTC day) → the BFF’s own 429 with a text — not a Lambda throttle — counting and touching nothing',
    },
    {
      id: 'cross-user',
      entry: 'api',
      kind: 'edge',
      what: 'A token only ever reads its own user’s partition',
      offDev: {
        file: 'lambdas/src/backend.places.test.ts',
        test: "the lookup row's userId is the only partition read: two users, one token",
        why: 'dev has one test user, so there is no second partition for a token to try',
      },
    },
    {
      id: 'mcp',
      entry: 'mcp',
      kind: 'nominal',
      what: 'MCP list_places names the place; create_task { place } puts an errand on it; list_place_tasks lists it',
    },
    {
      id: 'mcp-update',
      entry: 'mcp',
      kind: 'nominal',
      what: 'MCP update_task { place } moves an errand from one list to another',
    },
    {
      id: 'mcp-complete',
      entry: 'mcp',
      kind: 'edge',
      what: 'MCP complete_task on an errand without actualMin checks it off (done, still on its list’s word)',
    },
    {
      id: 'mcp-complete-reflection',
      entry: 'mcp',
      kind: 'edge',
      what: 'A reflection sent with that check-off is saved — no actual for it to ride (reflection.md)',
    },
    {
      id: 'break-down',
      entry: 'ui',
      kind: 'nominal',
      what: 'Break down… on an errand: its 2 parts take its place, each its own row (“part of …”, a 44px check); the parent leaves the list',
    },
    {
      id: 'parts-digest',
      entry: 'api',
      kind: 'nominal',
      what: 'The Shortcut’s read of a broken-down errand lists its parts, not the parent — and a part checked off drops the count by one',
    },
    {
      id: 'parts-agree',
      entry: 'ui',
      kind: 'nominal',
      what: 'The lens’s count and rows for that store are the Shortcut’s count and titles (items, not parent + parts)',
    },
    {
      id: 'places-all-errands',
      entry: 'ui',
      kind: 'nominal',
      what: 'Places lists every open errand: one due tomorrow shows on Places and Week, never Backlog, and the store still agrees with the Shortcut',
    },
    {
      id: 'part-check-off',
      entry: 'ui',
      kind: 'nominal',
      what: 'One tap checks one part off: it leaves the list, its sibling stays, and the count drops by one',
    },
    {
      id: 'mcp-part-place',
      entry: 'mcp',
      kind: 'edge',
      what: 'MCP update_task { place } on a part is refused for another place (a part follows its parent’s place) and a no-op for its parent’s own, and it stays put',
    },
    {
      id: 'arrive',
      entry: 'ios',
      kind: 'nominal',
      what: 'Arriving at the store runs the Arrive automation, and its banner reads the list',
      needsYou: 'an iPhone Shortcuts automation on a real geofence',
    },
    {
      id: 'tap-through',
      entry: 'ios',
      kind: 'nominal',
      what: 'Tapping through from the Shortcut opens the installed PWA on that store’s list',
      needsYou: 'iOS opening the installed PWA from a Shortcut — headless Chromium has neither',
    },
  ],
  steps: [
    {
      id: 'ui-add',
      entry: 'ui',
      proves: ['add-place'],
      title: 'Settings › Places: type the store name, Add → its row, “Shortcut never called”',
      async run(ctx) {
        await ctx.ui.goto('/settings');
        await ctx.page.getByLabel('New place', { exact: true }).fill(placeName(ctx));
        await ctx.ui.expectText(`Link word: @${placeSlug(ctx)}`);
        await ctx.page.getByRole('button', { name: 'Add place', exact: true }).click();
        await ctx.page
          .getByRole('textbox', { name: `Rename ${placeName(ctx)}`, exact: true })
          .waitFor({ state: 'visible', timeout: 15_000 });
        await ctx.ui.expectText('Shortcut never called');
        await ctx.shot('place-added');
      },
    },
    {
      id: 'server-place',
      entry: 'api',
      proves: ['add-place'],
      title: 'The server has the place under its link word, recorded in the ledger',
      async run(ctx) {
        const found = (await ctx.api.reads.listPlaces()).find((p) => p.slug === placeSlug(ctx));
        if (!found) throw new Error(`the server has no place ${placeSlug(ctx)}`);
        if (found.name !== placeName(ctx) || found.lastReadAt !== null)
          throw new Error(`server has ${JSON.stringify(found)}`);
        if (!ctx.createdIds().includes(found.id))
          throw new Error('the upsertPlace response never reached the ledger');
        place = found;
      },
    },
    {
      id: 'ui-capture',
      entry: 'ui',
      proves: ['capture'],
      title: 'Capture “shampoo | ~15 @<link word>” → Task added',
      async run(ctx) {
        await ctx.ui.goto('/tasks');
        await ctx.ui.captureTask(`${errand(ctx, 'shampoo')} | ~15 @${place.slug}`);
        await ctx.shot('captured');
      },
    },
    {
      id: 'server-errand',
      entry: 'api',
      proves: ['capture'],
      title: 'The server has it on the list, with its 15 min',
      async run(ctx) {
        shampooId = lastCreated(ctx, 'the capture');
        const task = await ctx.api.reads.getTask(shampooId);
        if (task?.place !== place.slug || task.estimateMin !== 15)
          throw new Error(`server has ${JSON.stringify(task)}`);
      },
    },
    {
      id: 'ui-unknown',
      entry: 'ui',
      proves: ['unknown-slug'],
      title: 'An unknown @word refuses once and warns; Enter again saves',
      async run(ctx) {
        await ctx.ui.goto('/tasks'); // a fresh bar: the last receipt can't stand in for this one's
        await ctx.page.getByRole('button', { name: 'Task', exact: true }).click();
        const field = ctx.page.locator('textarea[aria-label="Capture task"]');
        // fill() leaves the caret in the @word, so the warning is held back until the first Enter.
        await field.fill(`${errand(ctx, 'stray')} | @${unknownSlug(ctx)}`);
        // Exact: a screen-reader-only span in the refusal repeats these words.
        const again = ctx.page.getByText('Enter or Save again to save without it.', {
          exact: true,
        });
        // On a throttled dev the place list can still be loading: that Enter is refused too ("Loading
        // places…") and the notice clears once the list lands — so press until the held warning answers.
        // Never on a cleared field: that would mean it saved, and a second press could save another.
        for (let i = 0; ; i++) {
          await field.press('Enter');
          const held = await again.waitFor({ state: 'visible', timeout: 5_000 }).then(
            () => true,
            () => false,
          );
          if (held) break;
          if ((await field.inputValue()) === '')
            throw new Error('the first Enter saved an unknown @word without the held refusal');
          if (i === 4) throw new Error('Enter never got the held “no place” refusal');
        }
        await ctx.page
          .getByText(`no place '@${unknownSlug(ctx)}' — created without one`, { exact: true })
          .waitFor({ state: 'visible' });
        await ctx.shot('unknown-warning');
        await field.press('Enter');
        await ctx.ui.expectText(/Task added/, 15_000);
      },
    },
    {
      id: 'server-unknown',
      entry: 'api',
      proves: ['unknown-slug'],
      title: 'The server has it, on no list',
      async run(ctx) {
        strayId = lastCreated(ctx, 'the unknown-place capture');
        const task = await ctx.api.reads.getTask(strayId);
        if (task?.title !== errand(ctx, 'stray') || task.place)
          throw new Error(`server has ${JSON.stringify(task)}`);
      },
    },
    {
      id: 'ui-lens',
      entry: 'ui',
      proves: ['lens'],
      title: 'The lens link opens the store’s list with the errand, and not the stray',
      async run(ctx) {
        await ctx.ui.goto(lensPath(place.slug));
        await checkOff(ctx, place.name, 'shampoo').waitFor({ state: 'visible', timeout: 15_000 });
        if ((await ctx.page.getByText(errand(ctx, 'stray')).count()) > 0)
          throw new Error('the task on no list shows on the Places lens');
        await ctx.shot('lens');
      },
    },
    {
      id: 'ui-reload',
      entry: 'ui',
      proves: ['reload'],
      title: 'A reload keeps the lens URL and the list',
      async run(ctx) {
        await ctx.page.reload({ waitUntil: 'load' });
        const url = new URL(ctx.page.url());
        if (
          url.searchParams.get('lens') !== 'places' ||
          url.searchParams.get('place') !== place.slug
        )
          throw new Error(`after a reload the page is at ${url.pathname}${url.search}`);
        await checkOff(ctx, place.name, 'shampoo').waitFor({ state: 'visible', timeout: 15_000 });
      },
    },
    {
      id: 'api-read',
      entry: 'api',
      proves: ['shortcut-read'],
      title:
        'Rotate the token; the Shortcut’s GET answers 200 with the errand, the text and the link',
      async run(ctx) {
        const { token, status } = await ctx.api.writes.rotatePlaceToken();
        if (!status.active || status.hint !== token.slice(-4) || status.readsToday !== 0)
          throw new Error(`rotate answered status ${JSON.stringify({ ...status, hint: '…' })}`);
        placeToken = token;
        readsToday = 0;
        const body = await readCounted(ctx, place.slug, placeToken);
        expectBody(body, {
          place: place.name,
          slug: place.slug,
          count: 1,
          titles: [errand(ctx, 'shampoo')],
          text: `${place.name} · 1 — ${errand(ctx, 'shampoo')}`,
          url: `${targetOrigin()}${lensPath(place.slug)}`,
        });
        if ((await tokenStatus(ctx)).lastUsedAt === null)
          throw new Error('after one read the token’s lastUsedAt is unset');
        if (!(await placeById(ctx, place.id))?.lastReadAt)
          throw new Error('the place’s lastReadAt was not set by the read');
      },
    },
    {
      id: 'api-capital',
      entry: 'api',
      proves: ['capital-slug'],
      title: 'The link word capitalised in the path still reads the list, slug lowercase',
      async run(ctx) {
        const body = await readCounted(ctx, place.slug.toUpperCase(), placeToken);
        expectBody(body, {
          place: place.name,
          slug: place.slug,
          count: 1,
          titles: [errand(ctx, 'shampoo')],
          text: `${place.name} · 1 — ${errand(ctx, 'shampoo')}`,
          url: `${targetOrigin()}${lensPath(place.slug)}`,
        });
      },
    },
    {
      id: 'ui-test-panel',
      entry: 'ui',
      proves: ['test-panel'],
      title: 'Settings › Test: the banner text the Shortcut would show, and no read counted',
      async run(ctx) {
        const before = (await placeById(ctx, place.id))?.lastReadAt;
        await ctx.ui.goto('/settings');
        await ctx.page.getByRole('button', { name: `Test ${place.name}`, exact: true }).click();
        await ctx.ui.expectText(`${place.name} · 1 — ${errand(ctx, 'shampoo')}`, 15_000);
        await ctx.shot('test-panel');
        const s = await tokenStatus(ctx);
        if (s.readsToday !== readsToday)
          throw new Error(`Test counted a read (${readsToday} → ${s.readsToday})`);
        if ((await placeById(ctx, place.id))?.lastReadAt !== before)
          throw new Error('Test moved the place’s “last called”');
      },
    },
    {
      id: 'ui-recipe',
      entry: 'ui',
      proves: ['recipe'],
      title:
        'The Shortcut recipe’s URL is the full template on this origin; its Otherwise branch is there',
      async run(ctx) {
        await ctx.ui.goto('/settings');
        await ctx.page.getByRole('button', { name: 'Set up the iPhone Shortcut' }).click();
        const want = `${targetOrigin()}/api/places/[Shortcut Input]/tasks`;
        await ctx.ui.expectText(want);
        // No `text` and no `count` (a CloudFront 5xx, a throttle) is a non-answer, never a quiet empty list.
        await ctx.ui.expectText(/Aperture didn[’']t answer/);
        await ctx.shot('recipe');
      },
    },
    {
      id: 'api-neighbour',
      entry: 'api',
      proves: ['neighbour'],
      title:
        'A second place with its own errand: never in the first one’s read, its heartbeat unset',
      async run(ctx) {
        other = await ctx.api.writes.upsertPlace({ name: otherName(ctx) });
        if (other.slug !== otherSlug(ctx)) throw new Error(`the second place got ${other.slug}`);
        nailsId = (
          await ctx.api.writes.createTask({ title: errand(ctx, 'nails'), place: other.slug })
        ).id;
        const body = await readCounted(ctx, place.slug, placeToken);
        const titles = fieldsOf(body).titles;
        if (JSON.stringify(titles) !== JSON.stringify([errand(ctx, 'shampoo')]))
          throw new Error(`the first place’s read lists ${JSON.stringify(titles)}`);
        const digest = await ctx.api.reads.listPlaceTasks(other.slug); // the RPC read: no heartbeat
        if (JSON.stringify(digest.titles) !== JSON.stringify([errand(ctx, 'nails')]))
          throw new Error(`the second place lists ${JSON.stringify(digest.titles)}`);
        const stored = await placeById(ctx, other.id);
        if (stored?.lastReadAt !== null)
          throw new Error(`the unread place has lastReadAt ${stored?.lastReadAt}`);
      },
    },
    {
      id: 'api-wrong-token',
      entry: 'api',
      proves: ['wrong-token'],
      title: 'A well-formed token that isn’t ours → 401, with a text',
      async run(ctx) {
        const stranger = `apl_${randomBytes(32).toString('base64url')}`;
        const got = await ctx.api.reads.placeDigestRaw(place.slug, stranger);
        await expectRefused(ctx, got, 401);
        if (!errorOf(got.body).startsWith('Unauthorized'))
          throw new Error(`401 body ${JSON.stringify(got.body)}`);
      },
    },
    {
      id: 'api-no-token',
      entry: 'api',
      proves: ['no-token'],
      title: 'No token header → 401, with a text',
      async run(ctx) {
        await expectRefused(ctx, await ctx.api.reads.placeDigestRaw(place.slug, null), 401);
      },
    },
    {
      id: 'api-unknown-place',
      entry: 'api',
      proves: ['unknown-place'],
      title: 'An unknown slug with our token → 422 with a text, not counted',
      async run(ctx) {
        const got = await ctx.api.reads.placeDigestRaw(unknownSlug(ctx), placeToken);
        await expectRefused(ctx, got, 422);
        const { error, text } = fieldsOf(got.body);
        if (
          error !== `No place "${unknownSlug(ctx)}" — add it in Settings › Places` ||
          typeof text !== 'string' ||
          !text.includes(`"${unknownSlug(ctx)}"`)
        )
          throw new Error(`422 body ${JSON.stringify(got.body)}`);
      },
    },
    {
      id: 'api-bad-path',
      entry: 'api',
      proves: ['bad-path'],
      title: 'A malformed path (a slug outside the shape) with our token → 422 with a text',
      async run(ctx) {
        await expectRefused(ctx, await ctx.api.reads.placeDigestRaw(badSlug(ctx), placeToken), 422);
      },
    },
    {
      id: 'api-post',
      entry: 'api',
      proves: ['post'],
      title: 'A POST to the route → 405 with a text, not counted',
      async run(ctx) {
        await expectRefused(
          ctx,
          await ctx.api.reads.placeDigestRaw(place.slug, placeToken, 'POST'),
          405,
        );
      },
    },
    {
      id: 'ui-heartbeat',
      entry: 'ui',
      proves: ['settings-heartbeat'],
      title: 'Settings: the place was last called, the token used, its reads today counted',
      async run(ctx) {
        const s = await tokenStatus(ctx);
        await ctx.ui.goto('/settings');
        await ctx.ui.expectText('Shortcut last called', 15_000);
        await ctx.ui.expectText(`Active · ends …${s.hint}`, 15_000);
        await ctx.ui.expectText(`${s.readsToday} ${s.readsToday === 1 ? 'read' : 'reads'} today`);
        await ctx.shot('settings-heartbeat');
      },
    },
    {
      id: 'ui-roster-failed',
      entry: 'ui',
      proves: ['roster-failed'],
      title:
        'listPlaces’ connection keeps dropping → “Couldn’t load places.”; Retry brings the row back',
      async run(ctx) {
        // Dropped, not 429: a 429 is retried inside the http client and never reaches the query layer.
        const i = await ctx.intercept('listPlaces', { abort: true });
        try {
          await ctx.ui.goto('/settings');
          await ctx.ui.expectText('Couldn’t load places.', 20_000);
          await ctx.shot('places-failed');
        } finally {
          await i.release();
        }
        await ctx.page.getByRole('button', { name: 'Retry', exact: true }).first().click();
        await ctx.page
          .getByRole('textbox', { name: `Rename ${place.name}`, exact: true })
          .waitFor({ state: 'visible', timeout: 15_000 });
        await ctx.page
          .getByText('Couldn’t load places.')
          .first()
          .waitFor({ state: 'hidden', timeout: 10_000 });
      },
    },
    {
      id: 'ui-check-off',
      entry: 'ui',
      proves: ['check-off'],
      title: 'One tap checks the errand off: “Checked off”, and it leaves the list',
      async run(ctx) {
        await ctx.ui.goto(lensPath(place.slug));
        const check = checkOff(ctx, place.name, 'shampoo');
        await check.click({ timeout: 15_000 });
        await ctx.ui.expectText(`Checked off “${errand(ctx, 'shampoo')}”.`, 15_000);
        await check.waitFor({ state: 'hidden', timeout: 10_000 });
        // No shot here: the receipt's Add again lasts 4 s, and the next step takes it.
      },
    },
    {
      id: 'ui-add-again',
      entry: 'ui',
      proves: ['add-again'],
      title: 'Add again, inside the receipt’s 4 s: the errand is back on the list',
      async run(ctx) {
        await region(ctx, place.name)
          .getByRole('button', { name: 'Add again', exact: true })
          .click({ timeout: 3_000 });
        await checkOff(ctx, place.name, 'shampoo').waitFor({ state: 'visible', timeout: 15_000 });
        await ctx.shot('added-again');
      },
    },
    {
      id: 'server-done',
      entry: 'api',
      proves: ['check-off'],
      title: 'The server has it done, and off the list’s open errands',
      async run(ctx) {
        const task = await ctx.api.reads.getTask(shampooId);
        if (task?.status !== 'done') throw new Error(`server has ${JSON.stringify(task)}`);
        const open = (await ctx.api.reads.listTasks()).filter(
          (t) => t.place === place.slug && t.status !== 'done' && t.status !== 'cancelled',
        );
        if (open.some((t) => t.id === shampooId))
          throw new Error('the checked-off errand is still open on its list');
      },
    },
    {
      id: 'server-add-again',
      entry: 'api',
      proves: ['add-again'],
      title: 'The copy is a new backlog task on the same list, with the estimate',
      async run(ctx) {
        againId = lastCreated(ctx, 'Add again');
        if (againId === shampooId) throw new Error('Add again recorded no new task');
        const copy = await getTask(ctx, againId);
        if (
          copy.title !== errand(ctx, 'shampoo') ||
          copy.place !== place.slug ||
          copy.estimateMin !== 15 ||
          copy.status !== 'backlog'
        )
          throw new Error(`the copy is ${JSON.stringify(copy)}`);
        const digest = await ctx.api.reads.listPlaceTasks(place.slug);
        if (digest.count !== 1 || digest.text !== `${place.name} · 1 — ${errand(ctx, 'shampoo')}`)
          throw new Error(`the list reads ${JSON.stringify(digest)}`);
      },
    },
    {
      id: 'calibration',
      entry: 'api',
      proves: ['calibration'],
      title: 'The done errand had its estimate locked, and is no calibration point',
      async run(ctx) {
        const task = await ctx.api.reads.getTask(shampooId);
        // Locked at start: without the place it would be a point — so its absence is the place rule.
        if (task?.estimateLockedMin !== 15)
          throw new Error(`the errand's lock is ${task?.estimateLockedMin} — expected 15`);
        const from = laDay(new Date(Date.now() - 86_400_000)); // the app day may still be yesterday
        const points = await ctx.api.reads.getCalibration({ from, to: ctx.dates.tomorrow });
        if (points.some((p) => p.taskId === shampooId))
          throw new Error('the checked-off errand is a calibration point');
      },
    },
    {
      id: 'ui-rename',
      entry: 'ui',
      proves: ['rename'],
      title: 'Settings: rename the second place, then retype its link word',
      async run(ctx) {
        await ctx.ui.goto('/settings');
        const name = ctx.page.getByRole('textbox', { name: `Rename ${other.name}`, exact: true });
        await name.fill(renamedName(ctx));
        await name.press('Tab'); // the blur saves
        // The row's labels follow the saved name — the rename landed before the link word is touched.
        const word = ctx.page.getByRole('textbox', {
          name: `Link word for ${renamedName(ctx)}`,
          exact: true,
        });
        await word.waitFor({ state: 'visible', timeout: 15_000 });
        await word.fill(renamedSlug(ctx));
        await word.press('Tab');
        await until(
          'the link word',
          () => placeById(ctx, other.id),
          (p) => p?.slug === renamedSlug(ctx),
        );
        await ctx.shot('renamed');
      },
    },
    {
      id: 'server-rename',
      entry: 'api',
      proves: ['rename'],
      title: 'The server has the new name and word, and the errand moved with it',
      async run(ctx) {
        const p = await placeById(ctx, other.id);
        if (p?.name !== renamedName(ctx) || p.slug !== renamedSlug(ctx))
          throw new Error(`the place is ${JSON.stringify(p)}`);
        other = p;
        if ((await getTask(ctx, nailsId)).place !== other.slug)
          throw new Error('the errand stayed on the old link word');
        if (
          JSON.stringify(await openOn(ctx, other.slug)) !== JSON.stringify([errand(ctx, 'nails')])
        )
          throw new Error('the renamed list doesn’t read its errand');
      },
    },
    {
      id: 'ui-rename-lens',
      entry: 'ui',
      proves: ['rename'],
      title: 'The new word’s lens shows the errand; the old word’s says no such place',
      async run(ctx) {
        await ctx.ui.goto(lensPath(other.slug));
        await checkOff(ctx, other.name, 'nails').waitFor({ state: 'visible', timeout: 15_000 });
        await ctx.ui.goto(lensPath(otherSlug(ctx)));
        await ctx.ui.expectText(`No place “${otherSlug(ctx)}”`, 15_000);
      },
    },
    {
      id: 'ui-editor-place',
      entry: 'ui',
      proves: ['editor-place'],
      title: 'The editor’s Place select puts the stray task on the second list',
      async run(ctx) {
        await ctx.ui.goto('/tasks?lens=backlog');
        await ctx.page
          .getByRole('button', { name: errand(ctx, 'stray'), exact: true })
          .first()
          .click({ timeout: 15_000 });
        const d = ctx.page.getByRole('dialog', { name: `Task: ${errand(ctx, 'stray')}` });
        await d.waitFor({ state: 'visible', timeout: 10_000 });
        // The <label> wraps the select, so its name is "Place" + the selected option ("Place No place").
        await d.getByRole('combobox', { name: /^Place\b/ }).selectOption({ label: other.name });
        await d.getByRole('button', { name: 'Save', exact: true }).click();
        await d.getByText('Saved', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
        await ctx.shot('editor-place');
        await until(
          'the stray task',
          () => getTask(ctx, strayId),
          (t) => t.place === other.slug,
        );
      },
    },
    {
      id: 'mcp',
      entry: 'mcp',
      proves: ['mcp'],
      title: 'MCP: list_places names it; create_task { place }; list_place_tasks lists the errand',
      async run(ctx) {
        if (!(await ctx.mcp.reads.listPlaces()).some((p) => p.slug === place.slug))
          throw new Error('list_places doesn’t name the place');
        const task = await ctx.mcp.writes.createTask({
          title: errand(ctx, 'syrup'),
          place: place.slug,
        });
        if (task.place !== place.slug)
          throw new Error(`create_task answered ${JSON.stringify(task)}`);
        syrupId = task.id;
        const list = await ctx.mcp.reads.listPlaceTasks(place.slug);
        const row = list.tasks.find((t) => t.id === task.id);
        const want = [errand(ctx, 'shampoo'), errand(ctx, 'syrup')]; // Add again's copy first
        if (
          !row ||
          row.status !== 'backlog' ||
          list.count !== 2 ||
          list.text !== `${place.name} · 2 — ${want.join(', ')}`
        )
          throw new Error(`list_place_tasks answered ${JSON.stringify(list)}`);
      },
    },
    {
      id: 'mcp-update',
      entry: 'mcp',
      proves: ['mcp-update'],
      title: 'MCP update_task { place } moves the errand to the second list',
      async run(ctx) {
        const task = await ctx.mcp.writes.updateTask(syrupId, { place: other.slug });
        if (task.place !== other.slug)
          throw new Error(`update_task answered ${JSON.stringify(task)}`);
        const there = await ctx.mcp.reads.listPlaceTasks(other.slug);
        if (!there.tasks.some((t) => t.id === syrupId))
          throw new Error(`the second list reads ${JSON.stringify(there)}`);
        const here = await ctx.mcp.reads.listPlaceTasks(place.slug);
        if (here.tasks.some((t) => t.id === syrupId))
          throw new Error('the errand is still on the first list');
      },
    },
    {
      id: 'mcp-complete',
      entry: 'mcp',
      proves: ['mcp-complete', 'mcp-complete-reflection'],
      title:
        'MCP complete_task on the errand with no actualMin (and a reflection): done, its word kept',
      async run(ctx) {
        const why = 'Only the big bottle left — devcheck';
        const { task } = await ctx.mcp.writes.completeTask(syrupId, undefined, why);
        if (task.status !== 'done' || task.place !== other.slug || task.reflection !== why)
          throw new Error(`complete_task answered ${JSON.stringify(task)}`);
        const list = await ctx.mcp.reads.listPlaceTasks(other.slug);
        if (list.tasks.some((t) => t.id === syrupId))
          throw new Error('the done errand is still on its list');
      },
    },
    {
      id: 'ui-break-down',
      entry: 'ui',
      proves: ['break-down'],
      title: 'Break down… an errand on its own list into 2 parts, from the lens’s editor',
      async run(ctx) {
        partsPlace = await ctx.api.writes.upsertPlace({ name: partsName(ctx) });
        if (partsPlace.slug !== partsSlug(ctx))
          throw new Error(`the parts place got ${partsPlace.slug}`);
        // Ledgered as api:createTask; its parts as ui:createTasks, after it — cleanup goes newest first, so
        // the parts are deleted before the parent and its delete never meets a part (no cascade).
        partyId = (
          await ctx.api.writes.createTask({ title: errand(ctx, 'party'), place: partsPlace.slug })
        ).id;
        await ctx.ui.goto(lensPath(partsPlace.slug));
        await region(ctx, partsPlace.name)
          .getByRole('button', { name: errand(ctx, 'party'), exact: true })
          .click({ timeout: 15_000 });
        const d = ctx.page.getByRole('dialog', { name: `Task: ${errand(ctx, 'party')}` });
        await d.waitFor({ state: 'visible', timeout: 10_000 });
        await d.getByRole('button', { name: 'Break down…', exact: true }).click();
        await d.getByLabel(/Add parts/).fill(`${errand(ctx, 'cups')}\n${errand(ctx, 'plates')}`);
        await d.getByText('2 parts', { exact: true }).waitFor({ timeout: 10_000 });
        await ctx.shot('break-down');
        await d.getByRole('button', { name: 'Add parts', exact: true }).click();
        // The form closes once the parts landed; the parent's opener is "Add parts…" now.
        await d
          .getByRole('button', { name: 'Add parts…', exact: true })
          .waitFor({ state: 'visible', timeout: 15_000 });
        await ctx.page.keyboard.press('Escape');
        await d.waitFor({ state: 'hidden', timeout: 5_000 });
        const list = region(ctx, partsPlace.name);
        for (const what of ['cups', 'plates']) {
          const check = checkOff(ctx, partsPlace.name, what);
          await check.waitFor({ state: 'visible', timeout: 15_000 });
          const box = await check.boundingBox();
          if (!box || box.width < 43.5 || box.height < 43.5)
            throw new Error(`the check on ${what} is ${box?.width}×${box?.height} — not 44px`);
        }
        const partOf = await list
          .getByText(`part of ${errand(ctx, 'party')}`, { exact: true })
          .count();
        if (partOf !== 2) throw new Error(`${partOf} rows say “part of” the parent, not 2`);
        const parentRows =
          (await list.getByRole('button', { name: errand(ctx, 'party'), exact: true }).count()) +
          (await list
            .getByRole('button', { name: `Check off ${errand(ctx, 'party')}`, exact: true })
            .count());
        if (parentRows) throw new Error('the parent is still a row on the list');
        await ctx.shot('parts-lens');
      },
    },
    {
      id: 'server-parts',
      entry: 'api',
      proves: ['break-down'],
      title: 'The server has 2 parts under the errand, both on its list, both in the ledger',
      async run(ctx) {
        const parts = (await ctx.api.reads.listTasks()).filter((t) => t.parentId === partyId);
        const titles = parts.map((t) => t.title).sort();
        if (JSON.stringify(titles) !== JSON.stringify([errand(ctx, 'cups'), errand(ctx, 'plates')]))
          throw new Error(`the errand’s parts are ${JSON.stringify(titles)}`);
        for (const t of parts) {
          if (t.place !== partsPlace.slug)
            throw new Error(`the part “${t.title}” is on ${t.place}, not its parent’s list`);
          if (!ctx.createdIds().includes(t.id))
            throw new Error(`the part “${t.title}” never reached the ledger`);
        }
        if ((await getTask(ctx, partyId)).place !== partsPlace.slug)
          throw new Error('the parent left its list');
      },
    },
    {
      id: 'api-parts-read',
      entry: 'api',
      proves: ['parts-digest'],
      title: 'The Shortcut’s read lists the 2 parts, not the parent',
      async run(ctx) {
        const body = await readCounted(ctx, partsPlace.slug, placeToken);
        const titles = fieldsOf(body).titles;
        const want = [errand(ctx, 'cups'), errand(ctx, 'plates')];
        // The server orders them (created, then id); a batch's two may tie on created.
        if (!Array.isArray(titles) || JSON.stringify([...titles].sort()) !== JSON.stringify(want))
          throw new Error(`GET answered ${JSON.stringify(body)}`);
        partTitles = titles as string[];
        expectBody(body, {
          place: partsPlace.name,
          slug: partsPlace.slug,
          count: 2,
          titles: partTitles,
          text: `${partsPlace.name} · 2 — ${partTitles.join(', ')}`,
          url: `${targetOrigin()}${lensPath(partsPlace.slug)}`,
        });
        const parts = (await ctx.api.reads.listTasks()).filter((t) => t.parentId === partyId);
        partIds = partTitles.map((title) => parts.find((t) => t.title === title)!.id);
      },
    },
    {
      id: 'ui-parts-agree',
      entry: 'ui',
      proves: ['parts-agree'],
      title: 'The lens’s count and rows for the store are the Shortcut’s count and titles',
      async run(ctx) {
        await ctx.ui.goto(lensPath(partsPlace.slug));
        await lensAgrees(ctx, partTitles);
        await ctx.shot('parts-agree');
      },
    },
    {
      id: 'ui-part-check-off',
      entry: 'ui',
      proves: ['part-check-off'],
      title: 'One tap checks the first part off: it leaves, its sibling stays, the count is 1',
      async run(ctx) {
        const [first, second] = partTitles as [string, string];
        const check = region(ctx, partsPlace.name).getByRole('button', {
          name: `Check off ${first}`,
          exact: true,
        });
        await check.click({ timeout: 15_000 });
        await ctx.ui.expectText(`Checked off “${first}”.`, 15_000);
        await check.waitFor({ state: 'hidden', timeout: 10_000 });
        await lensAgrees(ctx, [second]);
        await ctx.shot('part-checked-off');
      },
    },
    {
      id: 'api-part-check-off',
      entry: 'api',
      proves: ['parts-digest'],
      title: 'The Shortcut’s count drops by one: the sibling alone, still not the parent',
      async run(ctx) {
        if ((await getTask(ctx, partIds[0]!)).status !== 'done')
          throw new Error('the checked-off part isn’t done on the server');
        const body = await readCounted(ctx, partsPlace.slug, placeToken);
        expectBody(body, {
          place: partsPlace.name,
          slug: partsPlace.slug,
          count: 1,
          titles: [partTitles[1]],
          text: `${partsPlace.name} · 1 — ${partTitles[1]}`,
          url: `${targetOrigin()}${lensPath(partsPlace.slug)}`,
        });
      },
    },
    {
      id: 'mcp-part-place',
      entry: 'mcp',
      proves: ['mcp-part-place'],
      title: 'MCP update_task { place } on the open part: another place refused, its own a no-op',
      async run(ctx) {
        const part = partIds[1]!;
        const err = await ctx.mcp.writes.updateTask(part, { place: place.slug }).then(
          () => null,
          (e: unknown) => (e instanceof Error ? e.message : String(e)),
        );
        if (err === null) throw new Error('update_task moved a part off its parent’s place');
        if (!err.includes(PLACE_PART_ERROR)) throw new Error(`update_task refused with: ${err}`);
        if ((await getTask(ctx, part)).place !== partsPlace.slug)
          throw new Error('the refused part left its list');
        // Its parent's own place is a no-op, as create_task takes it.
        const same = await ctx.mcp.writes.updateTask(part, { place: partsPlace.slug });
        if (same.place !== partsPlace.slug)
          throw new Error(`update_task with the parent’s own place returned ${same.place}`);
        if ((await getTask(ctx, part)).place !== partsPlace.slug)
          throw new Error('the no-op part left its list');
        await firstListUntouched(ctx);
      },
    },
    {
      id: 'ui-all-errands',
      entry: 'ui',
      proves: ['places-all-errands'],
      title:
        'An errand due tomorrow shows on Places and Week, never Backlog; the store agrees with the Shortcut',
      async run(ctx) {
        const dated = await ctx.api.writes.createTask({
          title: errand(ctx, 'dated'),
          place: partsPlace.slug,
          dueDay: ctx.dates.tomorrow,
        });
        const digest = await ctx.api.reads.listPlaceTasks(partsPlace.slug);
        if (!digest.titles.includes(dated.title))
          throw new Error(`the Shortcut's list is ${JSON.stringify(digest.titles)}`);
        await ctx.ui.goto(lensPath(partsPlace.slug));
        await lensAgrees(ctx, digest.titles);
        await ctx.shot('all-errands');
        await ctx.ui.goto('/tasks?lens=week');
        await ctx.ui.expectText(dated.title, 15_000);
        // Same loaded list, one tap over: the Backlog filter runs on the tasks Week just showed.
        await ctx.page.getByRole('button', { name: 'Backlog', exact: true }).click();
        await ctx.page
          .getByText(dated.title, { exact: true })
          .waitFor({ state: 'hidden', timeout: 10_000 })
          .catch(() => {
            throw new Error('an errand showed on Backlog');
          });
      },
    },
    {
      id: 'ui-bulk',
      entry: 'ui',
      proves: ['bulk-place'],
      title: 'Bulk add “soap | @<third place>” → Added 1',
      async run(ctx) {
        third = await ctx.api.writes.upsertPlace({ name: thirdName(ctx) });
        if (third.slug !== thirdSlug(ctx)) throw new Error(`the third place got ${third.slug}`);
        await ctx.ui.goto('/tasks');
        await ctx.page.getByRole('button', { name: 'Bulk add', exact: true }).click();
        const d = ctx.page.getByRole('dialog', { name: 'Bulk add tasks' });
        await d.waitFor({ state: 'visible', timeout: 10_000 });
        await d.getByText(`@${third.slug}`).first().waitFor({ state: 'visible', timeout: 15_000 });
        await d
          .getByLabel('Tasks, one per line', { exact: true })
          .fill(`${errand(ctx, 'soap')} | @${third.slug}`);
        await d.getByText('1 task ready', { exact: true }).waitFor({ timeout: 10_000 });
        await ctx.shot('bulk');
        await d.getByRole('button', { name: 'Add 1 task', exact: true }).click();
        await ctx.ui.expectText('Added 1 to Places', 15_000); // an errand waits on Places, not Backlog
      },
    },
    {
      id: 'server-bulk',
      entry: 'api',
      proves: ['bulk-place'],
      title: 'The server has it on the third list',
      async run(ctx) {
        soapId = lastCreated(ctx, 'the bulk add');
        const task = await getTask(ctx, soapId);
        if (task.title !== errand(ctx, 'soap') || task.place !== third.slug)
          throw new Error(`server has ${JSON.stringify(task)}`);
      },
    },
    {
      id: 'ui-delete-move',
      entry: 'ui',
      proves: ['delete-move', 'delete-neighbour'],
      title: 'Settings: delete the third place, moving its errand to the second',
      async run(ctx) {
        await ctx.ui.goto('/settings');
        await ctx.page.getByRole('button', { name: `Delete ${third.name}`, exact: true }).click();
        await ctx.page
          .getByRole('combobox', { name: /^Move its 1 errand to\b/ })
          .selectOption({ label: other.name }, { timeout: 15_000 });
        await ctx.shot('delete-move');
        await ctx.page.getByRole('button', { name: 'Delete', exact: true }).click();
        await ctx.page
          .getByRole('textbox', { name: `Rename ${third.name}`, exact: true })
          .waitFor({ state: 'hidden', timeout: 15_000 });
      },
    },
    {
      id: 'server-delete-move',
      entry: 'api',
      proves: ['delete-move', 'delete-neighbour'],
      title: 'The third place is gone, its errand on the second list; the first list untouched',
      async run(ctx) {
        if (await placeById(ctx, third.id)) throw new Error('the deleted place is still listed');
        if ((await getTask(ctx, soapId)).place !== other.slug)
          throw new Error('the errand didn’t move to the chosen place');
        await firstListUntouched(ctx);
      },
    },
    {
      id: 'ui-delete-none',
      entry: 'ui',
      proves: ['delete-none', 'delete-neighbour'],
      title: 'Settings: delete the second place with “No place”',
      async run(ctx) {
        await ctx.ui.goto('/settings');
        await ctx.page.getByRole('button', { name: `Delete ${other.name}`, exact: true }).click();
        // Open: nails, stray (the editor's), soap (the move's) — the done syrup isn't counted.
        await ctx.page
          .getByRole('combobox', { name: /^Move its 3 errands to\b/ })
          .selectOption({ label: 'No place' }, { timeout: 15_000 });
        await ctx.page.getByRole('button', { name: 'Delete', exact: true }).click();
        await ctx.page
          .getByRole('textbox', { name: `Rename ${other.name}`, exact: true })
          .waitFor({ state: 'hidden', timeout: 15_000 });
        await ctx.shot('delete-none');
      },
    },
    {
      id: 'server-delete-none',
      entry: 'api',
      proves: ['delete-none', 'delete-neighbour'],
      title: 'Open errands on no list, the done one on its old word; the first list untouched',
      async run(ctx) {
        if (await placeById(ctx, other.id)) throw new Error('the deleted place is still listed');
        for (const id of [nailsId, strayId, soapId]) {
          const t = await getTask(ctx, id);
          if (t.place !== null) throw new Error(`“${t.title}” is still on ${t.place}`);
        }
        const syrup = await getTask(ctx, syrupId);
        if (syrup.status !== 'done' || syrup.place !== other.slug)
          throw new Error(`the done errand is ${JSON.stringify(syrup)} — its word is history`);
        await firstListUntouched(ctx);
      },
    },
    {
      id: 'api-cap',
      entry: 'api',
      proves: ['cap'],
      title: 'Sequential reads up to the daily cap, then the BFF’s own 429 with a text',
      async run(ctx) {
        const start = (await tokenStatus(ctx)).readsToday;
        if (start !== readsToday) throw new Error(`the count is ${start}, expected ${readsToday}`);
        const day = new Date().toISOString().slice(0, 10); // the cap's day is UTC
        // One at a time: never a burst against dev's concurrency quota (DEV-CHECK.md → Throttles (429)). A
        // Lambda throttle is backed off inside placeDigestRaw; only the BFF's own 429 comes back.
        for (let i = start + 1; i <= PLACE_READ_DAILY_CAP; i++) {
          const got = await ctx.api.reads.placeDigestRaw(place.slug, placeToken);
          if (got.status !== 200) {
            const rolled =
              new Date().toISOString().slice(0, 10) !== day ? ' (the UTC day rolled)' : '';
            throw new Error(
              `read ${i} of ${PLACE_READ_DAILY_CAP} → ${got.status}${rolled}: ${JSON.stringify(got.body)}`,
            );
          }
        }
        readsToday = (await tokenStatus(ctx)).readsToday;
        if (readsToday !== PLACE_READ_DAILY_CAP)
          throw new Error(`after the reads the count is ${readsToday}`);
        const touched = (await placeById(ctx, place.id))?.lastReadAt;
        for (const extra of [1, 2]) {
          const got = await ctx.api.reads.placeDigestRaw(place.slug, placeToken);
          if (got.status === 429 && !errorOf(got.body))
            throw new Error(
              `read ${PLACE_READ_DAILY_CAP + extra} → a Lambda throttle, not the cap`,
            );
          await expectRefused(ctx, got, 429);
        }
        if ((await placeById(ctx, place.id))?.lastReadAt !== touched)
          throw new Error('a capped read moved the place’s “last called”');
      },
    },
    {
      id: 'api-revoke',
      entry: 'api',
      proves: ['revoked'],
      title: 'Revoke: the status reads inactive and the old token → 401',
      async run(ctx) {
        await ctx.api.writes.revokePlaceToken();
        const s = await tokenStatus(ctx);
        if (s.active) throw new Error('the status still reads active');
        readsToday = s.readsToday;
        await expectRefused(ctx, await ctx.api.reads.placeDigestRaw(place.slug, placeToken), 401);
      },
    },
    {
      id: 'ui-generate',
      entry: 'ui',
      proves: ['ui-token'],
      title: 'Settings › Generate token: shown once; it reads 200, the revoked one still 401s',
      async run(ctx) {
        await ctx.ui.goto('/settings');
        await ctx.ui.expectText('No token yet', 15_000);
        ctx.api.writes.recordPlaceTokenMint(); // before the browser mints it
        const revoked = placeToken;
        const token = await takeRevealedToken(ctx, () =>
          ctx.page.getByRole('button', { name: 'Generate token', exact: true }).click(),
        );
        const s = await expectFresh(ctx, token, 'Generate');
        await ctx.ui.expectText(`Active · ends …${s.hint}`, 15_000);
        await ctx.shot('token-generated');
        await expectRefused(ctx, await ctx.api.reads.placeDigestRaw(place.slug, revoked), 401);
        await readCounted(ctx, place.slug, token);
        placeToken = token;
      },
    },
    {
      id: 'ui-rotate',
      entry: 'ui',
      proves: ['ui-rotate'],
      title: 'Settings › Rotate… → Rotate: a new token once; it reads 200, the old one 401s',
      async run(ctx) {
        await ctx.ui.goto('/settings');
        await ctx.page
          .getByRole('button', { name: 'Rotate…', exact: true })
          .click({ timeout: 15_000 });
        ctx.api.writes.recordPlaceTokenMint();
        const old = placeToken;
        const token = await takeRevealedToken(ctx, () =>
          ctx.page.getByRole('button', { name: 'Rotate', exact: true }).click(),
        );
        if (token === old) throw new Error('Rotate showed the same token');
        const s = await expectFresh(ctx, token, 'Rotate');
        await ctx.ui.expectText(`Active · ends …${s.hint}`, 15_000);
        await ctx.shot('token-rotated');
        await expectRefused(ctx, await ctx.api.reads.placeDigestRaw(place.slug, old), 401);
        await readCounted(ctx, place.slug, token);
        placeToken = token;
      },
    },
    {
      id: 'ui-revoke',
      entry: 'ui',
      proves: ['ui-revoke'],
      title: 'Settings › Revoke… → Revoke: “No token yet”, and the token 401s',
      async run(ctx) {
        await ctx.ui.goto('/settings');
        await ctx.page
          .getByRole('button', { name: 'Revoke…', exact: true })
          .click({ timeout: 15_000 });
        await ctx.page.getByRole('button', { name: 'Revoke', exact: true }).click();
        await ctx.ui.expectText('No token yet', 15_000);
        await ctx.shot('token-revoked');
        const s = await tokenStatus(ctx);
        if (s.active) throw new Error('the status still reads active');
        readsToday = s.readsToday;
        await expectRefused(ctx, await ctx.api.reads.placeDigestRaw(place.slug, placeToken), 401);
      },
    },
    noConsoleErrors,
  ],
};
