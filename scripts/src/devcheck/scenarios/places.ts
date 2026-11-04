// Places — errand lists by store, and the iPhone Shortcut's read of one (docs/areas/tasks/places.md). The
// place is added in Settings and errands captured onto it the way the user does it; the Shortcut's route is
// driven raw (api.ts placeDigestRaw) with a token rotated through the guarded API. Names and slugs carry the
// run's nonce, so no run can collide with another's leftover; the place is ledgered from the browser's
// upsertPlace response (recorder.ts), the token as `place-token:<run>`, and cleanup deletes the places and
// revokes the token by those records. The token's plaintext lives in this module's memory only — never in a
// log, an error or the ledger. The rows are the plan's dev-test matrix (localNotes/plan.md §4 D).
import { randomBytes } from 'node:crypto';
import { DEV_ORIGIN } from '../config';
import type { DevPlace, DevPlaceTokenStatus } from '../api';
import { laDay, noConsoleErrors, type Ctx, type Scenario } from '../scenario';

// slugify(name) for these names: the nonce is [A-Za-z0-9], so lowercasing it is the whole rule.
const n = (ctx: Ctx) => ctx.nonce.toLowerCase();
const placeName = (ctx: Ctx) => `Devcheck ${ctx.nonce}`;
const placeSlug = (ctx: Ctx) => `devcheck-${n(ctx)}`;
const otherName = (ctx: Ctx) => `Devcheck ${ctx.nonce} B`;
const otherSlug = (ctx: Ctx) => `devcheck-${n(ctx)}-b`;
const unknownSlug = (ctx: Ctx) => `nx-${n(ctx)}`; // never created
// Not "devcheck <nonce> …": the parts scenarios match their tasks by that prefix.
const errand = (ctx: Ctx, what: string) => `devcheck-pl ${ctx.nonce} ${what}`;
const lensPath = (slug: string) => `/tasks?lens=places&place=${slug}`;

// Steps share what earlier ones made; a failed step skips the rest, so these are set when read.
let place: DevPlace;
let shampooId: string;
let placeToken: string; // the plaintext, once — never logged
let readsToday = 0;

const lastCreated = (ctx: Ctx, what: string): string => {
  const id = ctx.createdIds().at(-1);
  if (!id) throw new Error(`${what}: the create response never reached the ledger`);
  return id;
};
async function tokenStatus(ctx: Ctx): Promise<DevPlaceTokenStatus> {
  return ctx.api.reads.getPlaceTokenStatus();
}
// The Shortcut's read answered `status`; on a refusal, the server counted nothing.
async function expectRefused(ctx: Ctx, got: { status: number; body: unknown }, status: number) {
  if (got.status !== status)
    throw new Error(`expected HTTP ${status}, got ${got.status}: ${JSON.stringify(got.body)}`);
  const after = (await tokenStatus(ctx)).readsToday;
  if (after !== readsToday)
    throw new Error(`a ${status} counted a read (${readsToday} → ${after})`);
}
const errorOf = (body: unknown): string =>
  body && typeof body === 'object' ? String((body as { error?: unknown }).error ?? '') : '';
// Exact: the second place's name extends the first's.
const region = (ctx: Ctx, name: string) => ctx.page.getByRole('region', { name, exact: true });
// The body has exactly these fields with these values — nothing more (no ids, notes or estimates leave).
function expectBody(body: unknown, want: Record<string, unknown>): void {
  const got = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const keys = (o: object) => Object.keys(o).sort().join();
  const off = Object.entries(want).filter(([k, v]) => JSON.stringify(got[k]) !== JSON.stringify(v));
  if (keys(got) !== keys(want) || off.length)
    throw new Error(`GET answered ${JSON.stringify(body)}`);
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
      id: 'settings-heartbeat',
      entry: 'ui',
      kind: 'nominal',
      what: 'After the Shortcut’s read, Settings says the place was last called and the token was used today',
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
      id: 'neighbour',
      entry: 'api',
      kind: 'edge',
      what: 'Another place’s errand never shows in this place’s read, and that place’s heartbeat stays unset',
    },
    {
      id: 'wrong-token',
      entry: 'api',
      kind: 'edge',
      what: 'A well-formed token that isn’t the user’s → 401',
    },
    { id: 'no-token', entry: 'api', kind: 'edge', what: 'No token header → 401' },
    {
      id: 'unknown-place',
      entry: 'api',
      kind: 'edge',
      what: 'An unknown slug with a good token → 404, and the read isn’t counted',
    },
    {
      id: 'post',
      entry: 'api',
      kind: 'edge',
      what: 'A POST to the route → 405, and the read isn’t counted',
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
      what: 'Past the daily cap (200 reads a token a UTC day) → 429, with no task read and no write',
      offDev: {
        file: 'lambdas/src/index.test.ts',
        test: '429s at the daily cap with no task read and no write',
        why: 'reaching it on dev takes 200 Shortcut reads on one token in a run — invocations against dev’s low Lambda concurrency quota (DEV-CHECK.md → Known 429s), whose throttle 429s would be indistinguishable in the run from the cap’s own; the handler test drives the cap at the edge with a seeded count',
      },
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
      title: 'An unknown @word warns, and Enter still saves',
      async run(ctx) {
        await ctx.ui.goto('/tasks'); // a fresh bar: the last receipt can't stand in for this one's
        await ctx.page.getByRole('button', { name: 'Task', exact: true }).click();
        const field = ctx.page.locator('textarea[aria-label="Capture task"]');
        await field.fill(`${errand(ctx, 'stray')} | @${unknownSlug(ctx)}`);
        await ctx.ui.expectText(`no place '@${unknownSlug(ctx)}' — created without one`);
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
        const task = await ctx.api.reads.getTask(lastCreated(ctx, 'the unknown-place capture'));
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
        const list = region(ctx, place.name);
        await list
          .getByRole('button', { name: `Check off ${errand(ctx, 'shampoo')}`, exact: true })
          .waitFor({ state: 'visible', timeout: 15_000 });
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
        await region(ctx, place.name)
          .getByRole('button', { name: `Check off ${errand(ctx, 'shampoo')}`, exact: true })
          .waitFor({ state: 'visible', timeout: 15_000 });
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
          throw new Error(`rotate answered status ${JSON.stringify(status)}`);
        placeToken = token;
        const got = await ctx.api.reads.placeDigestRaw(place.slug, placeToken);
        if (got.status !== 200) throw new Error(`GET → ${got.status}: ${JSON.stringify(got.body)}`);
        expectBody(got.body, {
          place: place.name,
          slug: place.slug,
          count: 1,
          titles: [errand(ctx, 'shampoo')],
          text: `${place.name} · 1 — ${errand(ctx, 'shampoo')}`,
          url: `${DEV_ORIGIN}${lensPath(place.slug)}`,
        });
        const now = await tokenStatus(ctx);
        if (now.readsToday !== 1 || now.lastUsedAt === null)
          throw new Error(`after one read the status is ${JSON.stringify({ ...now, hint: '…' })}`);
        readsToday = now.readsToday;
        const after = (await ctx.api.reads.listPlaces()).find((p) => p.id === place.id);
        if (!after?.lastReadAt) throw new Error('the place’s lastReadAt was not set by the read');
      },
    },
    {
      id: 'api-neighbour',
      entry: 'api',
      proves: ['neighbour'],
      title:
        'A second place with its own errand: never in the first one’s read, its heartbeat unset',
      async run(ctx) {
        const other = await ctx.api.writes.upsertPlace({ name: otherName(ctx) });
        if (other.slug !== otherSlug(ctx)) throw new Error(`the second place got ${other.slug}`);
        await ctx.api.writes.createTask({ title: errand(ctx, 'nails'), place: other.slug });
        const got = await ctx.api.reads.placeDigestRaw(place.slug, placeToken);
        const titles = (got.body as { titles?: string[] } | null)?.titles;
        if (
          got.status !== 200 ||
          JSON.stringify(titles) !== JSON.stringify([errand(ctx, 'shampoo')])
        )
          throw new Error(
            `the first place’s read answered ${got.status} ${JSON.stringify(titles)}`,
          );
        readsToday++;
        const digest = await ctx.api.reads.listPlaceTasks(other.slug); // the RPC read: no heartbeat
        if (JSON.stringify(digest.titles) !== JSON.stringify([errand(ctx, 'nails')]))
          throw new Error(`the second place lists ${JSON.stringify(digest.titles)}`);
        const stored = (await ctx.api.reads.listPlaces()).find((p) => p.id === other.id);
        if (stored?.lastReadAt !== null)
          throw new Error(`the unread place has lastReadAt ${stored?.lastReadAt}`);
      },
    },
    {
      id: 'api-wrong-token',
      entry: 'api',
      proves: ['wrong-token'],
      title: 'A well-formed token that isn’t ours → 401',
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
      title: 'No token header → 401',
      async run(ctx) {
        await expectRefused(ctx, await ctx.api.reads.placeDigestRaw(place.slug, null), 401);
      },
    },
    {
      id: 'api-unknown-place',
      entry: 'api',
      proves: ['unknown-place'],
      title: 'An unknown slug with our token → 404, not counted',
      async run(ctx) {
        const got = await ctx.api.reads.placeDigestRaw(unknownSlug(ctx), placeToken);
        await expectRefused(ctx, got, 404);
        if (errorOf(got.body) !== `No place "${unknownSlug(ctx)}" — add it in Settings › Places`)
          throw new Error(`404 body ${JSON.stringify(got.body)}`);
      },
    },
    {
      id: 'api-post',
      entry: 'api',
      proves: ['post'],
      title: 'A POST to the route → 405, not counted',
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
        const check = region(ctx, place.name).getByRole('button', {
          name: `Check off ${errand(ctx, 'shampoo')}`,
          exact: true,
        });
        await check.click({ timeout: 15_000 });
        await ctx.ui.expectText(`Checked off “${errand(ctx, 'shampoo')}”.`, 15_000);
        await check.waitFor({ state: 'hidden', timeout: 10_000 });
        await ctx.shot('checked-off');
      },
    },
    {
      id: 'server-done',
      entry: 'api',
      proves: ['check-off'],
      title: 'The server has it done, and off the list’s digest',
      async run(ctx) {
        const task = await ctx.api.reads.getTask(shampooId);
        if (task?.status !== 'done') throw new Error(`server has ${JSON.stringify(task)}`);
        const digest = await ctx.api.reads.listPlaceTasks(place.slug);
        if (digest.count !== 0 || digest.text !== '')
          throw new Error(`the list still reads ${JSON.stringify(digest)}`);
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
        const list = await ctx.mcp.reads.listPlaceTasks(place.slug);
        const row = list.tasks.find((t) => t.id === task.id);
        if (
          !row ||
          row.status !== 'backlog' ||
          list.count !== 1 ||
          list.text !== `${place.name} · 1 — ${errand(ctx, 'syrup')}`
        )
          throw new Error(`list_place_tasks answered ${JSON.stringify(list)}`);
      },
    },
    {
      id: 'api-revoke',
      entry: 'api',
      proves: ['revoked'],
      title: 'Revoke: the status reads inactive and the old token → 401',
      async run(ctx) {
        await ctx.api.writes.revokePlaceToken();
        if ((await tokenStatus(ctx)).active) throw new Error('the status still reads active');
        const got = await ctx.api.reads.placeDigestRaw(place.slug, placeToken);
        if (got.status !== 401) throw new Error(`the revoked token → ${got.status}`);
      },
    },
    noConsoleErrors,
  ],
};
