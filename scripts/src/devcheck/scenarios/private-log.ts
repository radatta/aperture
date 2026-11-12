// Private log entries on dev (docs/areas/log): the capture bar's one-shot `private` pill and its "Make
// private?" nudge, the /log row lock (and a failed toggle said out loud), the night review's lock glyph, the
// API's flag, and MCP's redaction — a private entry reads "🔒 private entry" and search never matches it.
// Every entry is ledgered by id (the API's createLogEntry, or the capture bar's through the recorder) and
// tombstoned by the pipeline; text only finds a row on screen. Texts carry `tag`, the run's nonce with its
// letters dropped, so no run's nonce can spell a sensitive term ("…7pw2…") and nudge a line by accident.
import { PHONE } from '../browser';
import { laDay, noConsoleErrors, type Ctx, type Scenario } from '../scenario';

const FLOOR = { width: 390, height: 844 } as const;
const MASK = '🔒 private entry';
const NUDGE = 'Looks sensitive — make it private?';
const HELD = 'Looks sensitive — Enter again saves it as is';

const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (msg: string): never => {
  throw new Error(msg);
};
const tag = (ctx: Ctx) => `dcp${ctx.nonce.replace(/[^0-9]/g, '') || ctx.nonce}`;
const line = (ctx: Ctx, what: string) => `devcheck-priv ${tag(ctx)} ${what}`;
// The app's day, not the calendar's: before the day start an entry belongs to yesterday.
const appToday = async (ctx: Ctx) => {
  const { dayStartHour } = await ctx.api.reads.getSettings();
  return laDay(new Date(Date.now() - dayStartHour * 3_600_000));
};

// What this run made, shared across steps (a scenario's steps run in order).
const made = { pill: '', after: '', nudgeHeld: '', makePrivate: '', a: '', b: '', night: '' };

async function entryByText(ctx: Ctx, text: string) {
  const today = await appToday(ctx);
  return (await ctx.api.reads.listLogEntries(today)).find((e) => e.text === text);
}
async function savedAs(ctx: Ctx, text: string, isPrivate: boolean): Promise<string> {
  let e: Awaited<ReturnType<typeof entryByText>>;
  for (let i = 0; i < 20 && !e; i++) {
    e = await entryByText(ctx, text);
    if (!e) await nap(500);
  }
  if (!e) return fail(`"${text}" never reached the server`);
  if (!ctx.createdIds().includes(e.id)) fail(`the capture's id ${e.id} wasn't ledgered`);
  if ((e.private === true) !== isPrivate)
    fail(`"${text}" saved private=${e.private}, not ${isPrivate}`);
  return e.id;
}

const bar = (ctx: Ctx) => ({
  field: ctx.page.getByLabel('Capture log', { exact: true }),
  pill: ctx.page.getByRole('button', { name: 'private', exact: true }),
});
async function logMode(ctx: Ctx) {
  await ctx.ui.goto('/log');
  await ctx.page.getByRole('button', { name: 'Log', exact: true }).click();
}
async function pressed(
  l: { getAttribute(n: string): Promise<string | null> },
  want: boolean,
  what: string,
) {
  const v = await l.getAttribute('aria-pressed');
  if (v !== String(want)) fail(`${what}: aria-pressed=${v}, want ${want}`);
}
const rowLock = (ctx: Ctx, text: string) =>
  ctx.page
    .getByRole('listitem')
    .filter({ hasText: text })
    .getByRole('button', { name: 'Private entry' });

export const privateLog: Scenario = {
  id: 'private-log',
  title: 'Private log entries: the pill, the nudge, the row lock, and MCP redaction',
  tiers: ['full'],
  rows: [
    {
      id: 'pill-saves-private',
      entry: 'ui',
      kind: 'nominal',
      what: 'Log mode, tap private, type, Enter → saved private, receipt "Logged privately", the pill resets',
    },
    {
      id: 'pill-one-shot',
      entry: 'ui',
      kind: 'edge',
      what: 'The next capture, pill untouched, saves public',
    },
    {
      id: 'pill-twice',
      entry: 'ui',
      kind: 'edge',
      what: 'Tapping the pill twice leaves it off; the line saves public',
    },
    {
      id: 'nudge-shown',
      entry: 'ui',
      kind: 'nominal',
      what: '"disk password …" shows "Looks sensitive — make it private?"',
    },
    {
      id: 'nudge-holds-once',
      entry: 'ui',
      kind: 'edge',
      what: 'The first Enter saves nothing and says "Enter again saves it as is"; the second saves it public',
    },
    {
      id: 'nudge-make-private',
      entry: 'ui',
      kind: 'nominal',
      what: 'Make private arms the pill without saving; Enter saves private',
    },
    {
      id: 'nudge-dismiss',
      entry: 'ui',
      kind: 'edge',
      what: '× (Not this one) hides the nudge and Enter saves at once',
    },
    {
      id: 'nudge-false-positive',
      entry: 'ui',
      kind: 'edge',
      what: '"pinned the keyboard PR, leetcode later" gets no nudge',
    },
    {
      id: 'nudge-terms',
      entry: 'ui',
      kind: 'edge',
      what: 'The full table of sensitive terms and look-alikes',
      offDev: {
        file: 'app/src/modules/log/sensitive.test.ts',
        test: 'matches the sensitive terms and none of the look-alikes',
        why: 'a pure local decision, nothing sent; nudge-shown and nudge-false-positive run the same matcher on dev',
      },
    },
    {
      id: 'nudge-retry',
      entry: 'ui',
      kind: 'edge',
      what: 'A sensitive line whose save failed (restored or put back) retries on one Enter',
      offDev: {
        file: 'app/src/modules/capture/CaptureBar.test.tsx',
        test: 'a sensitive draft whose save failed retries on one Enter',
        why: 'nudge-holds-once proves the hold on dev; the failed-save path needs a create to fail mid-capture, which the stub sets up exactly',
      },
    },
    {
      id: 'row-toggle',
      entry: 'ui',
      kind: 'nominal',
      what: 'A row’s lock makes an API-made entry private; its neighbour stays public',
    },
    {
      id: 'row-survives-reload',
      entry: 'ui',
      kind: 'edge',
      what: 'After a reload the lock still reads pressed',
    },
    {
      id: 'row-toggle-twice',
      entry: 'ui',
      kind: 'edge',
      what: 'A second tap makes it public again',
    },
    {
      id: 'row-toggle-fails',
      entry: 'ui',
      kind: 'edge',
      what: 'A failed toggle rolls the lock back and shows the error line',
    },
    {
      id: 'night-review-lock',
      entry: 'ui',
      kind: 'nominal',
      what: 'Home › Night › Today in review shows the lock glyph on the private line',
    },
    {
      id: 'floor-390-dark',
      entry: 'ui',
      kind: 'edge',
      what: 'At 390, light and dark: the mode row holds Log|Task|Idea and the pill on one line; the nudge row reads',
    },
    {
      id: 'api-roundtrip',
      entry: 'api',
      kind: 'nominal',
      what: 'createLogEntry {private:true} reads back private; an edit keeps it; the toggle flips it true→false→true',
    },
    {
      id: 'api-invalid',
      entry: 'api',
      kind: 'edge',
      what: 'A non-boolean flag is refused and changes nothing',
    },
    {
      id: 'api-deleted',
      entry: 'api',
      kind: 'edge',
      what: 'A deleted entry is Not found to the toggle',
    },
    {
      id: 'api-unknown-or-other-user',
      entry: 'api',
      kind: 'edge',
      what: 'An unknown id, or another user’s, is Not found and nothing is written',
      offDev: {
        file: 'lambdas/src/backend.test.ts',
        test: "another user's entry is Not found to the toggle and edit, and nothing changes",
        why: 'dev has one test user; the harness refuses to touch an id its ledger never recorded',
      },
    },
    {
      id: 'legacy-row',
      entry: 'api',
      kind: 'edge',
      what: 'A row stored before the flag existed reads public and can be made private',
      offDev: {
        file: 'lambdas/src/backend.test.ts',
        test: 'a log row stored without the private attribute reads public and can be made private',
        why: 'dev has no pre-feature rows for the test user; an absent attribute is only producible in the in-memory table',
      },
    },
    {
      id: 'export-keeps',
      entry: 'api',
      kind: 'edge',
      what: 'The export (the user’s own download) keeps a private entry’s text and flag',
      offDev: {
        file: 'lambdas/src/backend.test.ts',
        test: "the export keeps a private entry's text and flag",
        why: 'the export is a full-table read with no path of its own in this scenario; the contract suite also asserts it on both impls',
      },
    },
    {
      id: 'mcp-list-redacts',
      entry: 'mcp',
      kind: 'nominal',
      what: 'list_log reads a private entry as "🔒 private entry" with its day and time; public text intact',
    },
    {
      id: 'mcp-get-day-redacts',
      entry: 'mcp',
      kind: 'nominal',
      what: 'get_day’s log reads the same',
    },
    {
      id: 'mcp-search-miss',
      entry: 'mcp',
      kind: 'edge',
      what: 'search_log never matches private text (nor the mask); the public line still hits',
    },
    {
      id: 'mcp-unlock-reveals',
      entry: 'mcp',
      kind: 'edge',
      what: 'Unlocked in the app, the text reads over MCP again',
    },
    {
      id: 'mcp-no-write-tool',
      entry: 'mcp',
      kind: 'edge',
      what: 'No MCP tool can set or clear the flag',
      offDev: {
        file: 'lambdas/src/mcp/logTools.test.ts',
        test: 'no MCP tool can set or clear the flag',
        why: 'tools/list here returns names only; the schemas are checked where they are defined',
      },
    },
    {
      id: 'iphone-keyboard',
      entry: 'ui',
      kind: 'edge',
      what: 'On the iPhone PWA the pill and the nudge row sit above the keyboard and are tappable',
      needsYou: 'the real keyboard inset shows only on the phone',
    },
    {
      id: 'claude-ai',
      entry: 'mcp',
      kind: 'nominal',
      what: 'Asked about a private line, claude.ai sees only "🔒 private entry"',
      needsYou: 'the claude.ai connector is the user’s',
    },
  ],
  steps: [
    {
      id: 'api-roundtrip',
      title: 'The API flag: create private, edit keeps it, toggle both ways, refusals',
      entry: 'api',
      proves: ['api-roundtrip', 'api-invalid', 'api-deleted'],
      async run(ctx) {
        const today = await appToday(ctx);
        const w = ctx.api.writes;
        const e = await w.createLogEntry(line(ctx, 'api secret'), today, { private: true });
        if (e.private !== true) fail(`created private=${e.private}`);
        const back = await entryByText(ctx, e.text);
        if (back?.private !== true) fail('listLogEntries reads it public');
        if ((await w.updateLogEntry(e.id, line(ctx, 'api secret edited'))).private !== true)
          fail('an edit dropped the flag');
        if ((await w.setLogEntryPrivate(e.id, false)).private !== false) fail('toggle off');
        if ((await w.setLogEntryPrivate(e.id, true)).private !== true) fail('toggle on again');
        let refused = false;
        await w.setLogEntryPrivate(e.id, 'yes').catch(() => (refused = true));
        if (!refused) fail('a non-boolean flag was accepted');
        if ((await entryByText(ctx, line(ctx, 'api secret edited')))?.private !== true)
          fail('a refused toggle changed the entry');
        const gone = await w.createLogEntry(line(ctx, 'api deleted'), today);
        await w.deleteLogEntry(gone.id);
        refused = false;
        await w.setLogEntryPrivate(gone.id, true).catch((err: unknown) => {
          refused = /Not found/.test(String(err));
        });
        if (!refused) fail('a deleted entry took the toggle');
      },
    },
    {
      id: 'capture-pill',
      title: 'The private pill: one entry private, the next public; tapped twice, off',
      entry: 'ui',
      proves: ['pill-saves-private', 'pill-one-shot', 'pill-twice'],
      async run(ctx) {
        await logMode(ctx);
        const { field, pill } = bar(ctx);
        await pill.click();
        await pressed(pill, true, 'pill after a tap');
        made.pill = line(ctx, 'lunch notes');
        await field.fill(made.pill);
        await ctx.shot('pill-armed');
        await field.press('Enter');
        await ctx.ui.expectText(/Logged privately/, 15_000);
        await pressed(pill, false, 'pill after the save');
        made.pill = await savedAs(ctx, made.pill, true);

        made.after = line(ctx, 'next one');
        await field.fill(made.after);
        await field.press('Enter');
        made.after = await savedAs(ctx, made.after, false);

        await pill.click();
        await pill.click();
        await pressed(pill, false, 'pill tapped twice');
        const twice = line(ctx, 'tapped twice');
        await field.fill(twice);
        await field.press('Enter');
        await savedAs(ctx, twice, false);
      },
    },
    {
      id: 'nudge',
      title: 'The nudge: shown, holds the first Enter, Make private, ×, and no false alarm',
      entry: 'ui',
      proves: [
        'nudge-shown',
        'nudge-holds-once',
        'nudge-make-private',
        'nudge-dismiss',
        'nudge-false-positive',
      ],
      async run(ctx) {
        await logMode(ctx);
        const { field, pill } = bar(ctx);
        const held = line(ctx, 'disk password is swordfish');
        await field.fill(held);
        await ctx.ui.expectText(NUDGE);
        await ctx.shot('nudge');
        await field.press('Enter');
        await ctx.ui.expectText(HELD);
        await ctx.ui.expectText(/Not saved yet/);
        if (await entryByText(ctx, held)) fail('the held Enter saved');
        if ((await field.inputValue()) !== held) fail('the held Enter cleared the field');
        await ctx.shot('nudge-held');
        await field.press('Enter');
        made.nudgeHeld = await savedAs(ctx, held, false);

        const mp = line(ctx, 'wifi pw: tango');
        await field.fill(mp);
        await ctx.ui.expectText(NUDGE);
        await ctx.page.getByRole('button', { name: 'Make private', exact: true }).click();
        await pressed(pill, true, 'pill after Make private');
        if (await entryByText(ctx, mp)) fail('Make private saved the line');
        await field.press('Enter');
        made.makePrivate = await savedAs(ctx, mp, true);

        const dis = line(ctx, 'garage code 1234');
        await field.fill(dis);
        await ctx.ui.expectText(NUDGE);
        await ctx.page.getByRole('button', { name: 'Not this one', exact: true }).click();
        if (await ctx.page.getByText(NUDGE).count()) fail('× left the nudge up');
        await field.press('Enter');
        await savedAs(ctx, dis, false);

        const fp = line(ctx, 'pinned the keyboard PR, leetcode later');
        await field.fill(fp);
        await ctx.ui.settle();
        if (await ctx.page.getByText(NUDGE).count()) fail('a look-alike line was nudged');
        await field.press('Enter');
        await savedAs(ctx, fp, false);
      },
    },
    {
      id: 'row-lock',
      title: '/log: the row lock, a reload, a second tap, a neighbour untouched',
      entry: 'ui',
      proves: ['row-toggle', 'row-survives-reload', 'row-toggle-twice'],
      async run(ctx) {
        const today = await appToday(ctx);
        const a = await ctx.api.writes.createLogEntry(line(ctx, 'row A'), today);
        const b = await ctx.api.writes.createLogEntry(line(ctx, 'row B'), today);
        made.a = a.id;
        made.b = b.id;
        await ctx.ui.goto('/log');
        await rowLock(ctx, a.text).click();
        const flag = async (id: string) =>
          (await ctx.api.reads.listLogEntries(today)).find((e) => e.id === id)?.private === true;
        for (let i = 0; i < 20 && !(await flag(a.id)); i++) await nap(500);
        if (!(await flag(a.id))) fail('the row lock never made A private');
        if (await flag(b.id)) fail('the neighbour B went private too');
        await pressed(rowLock(ctx, a.text), true, 'A after a tap');
        await ctx.shot('row-locked');
        await ctx.page.reload();
        await rowLock(ctx, a.text).waitFor();
        await pressed(rowLock(ctx, a.text), true, 'A after a reload');
        await pressed(rowLock(ctx, b.text), false, 'B after a reload');
        await rowLock(ctx, a.text).click();
        for (let i = 0; i < 20 && (await flag(a.id)); i++) await nap(500);
        if (await flag(a.id)) fail('a second tap left A private');
      },
    },
    {
      id: 'row-lock-fails',
      title: 'A failed toggle rolls back and says so',
      entry: 'ui',
      proves: ['row-toggle-fails'],
      async run(ctx) {
        const today = await appToday(ctx);
        const b = (await ctx.api.reads.listLogEntries(today)).find((e) => e.id === made.b);
        if (!b) return fail('row B is gone');
        await ctx.ui.goto('/log');
        const cut = await ctx.intercept('setLogEntryPrivate', { status: 500, times: 1 });
        try {
          await rowLock(ctx, b.text).click();
          await ctx.ui.expectText(
            /Couldn’t change that entry’s lock|Couldn't change that entry's lock/,
            15_000,
          );
          await ctx.ui.settle();
          await pressed(rowLock(ctx, b.text), false, 'B after the failed toggle');
          await ctx.shot('toggle-failed');
          if (cut.hits() !== 1)
            fail(`the toggle reached the server ${cut.hits()} times through the cut`);
        } finally {
          await cut.release();
        }
        const back = (await ctx.api.reads.listLogEntries(today)).find((e) => e.id === made.b);
        if (back?.private === true) fail('a failed toggle wrote');
      },
    },
    {
      id: 'night-review',
      title: 'Night → Today in review marks the private line',
      entry: 'ui',
      proves: ['night-review-lock'],
      async run(ctx) {
        // Last in, so it is among the review's three newest.
        const n = await ctx.api.writes.createLogEntry(
          line(ctx, 'night secret'),
          await appToday(ctx),
          {
            private: true,
          },
        );
        made.night = n.id;
        await ctx.ui.goto('/');
        await ctx.page.getByRole('button', { name: 'Night', exact: true }).click();
        await ctx.ui.expectText('Today in review', 15_000);
        await ctx.ui.expectText(n.text);
        const glyph = ctx.page
          .locator('div')
          .filter({ hasText: n.text })
          .last()
          .getByRole('img', { name: 'Private' });
        if ((await glyph.count()) !== 1) fail('no lock glyph beside the private line');
        await ctx.shot('night-review-lock');
      },
    },
    {
      id: 'floor',
      title: 'At 390, light and dark: the mode row and the nudge',
      entry: 'ui',
      proves: ['floor-390-dark'],
      async run(ctx) {
        await ctx.page.setViewportSize(FLOOR);
        try {
          for (const theme of ['light', 'dark'] as const) {
            await logMode(ctx);
            await ctx.ui.setTheme(theme);
            const { field, pill } = bar(ctx);
            await field.fill(line(ctx, 'bank PIN 4821'));
            await ctx.ui.expectText(NUDGE);
            const log = await ctx.page
              .getByRole('button', { name: 'Log', exact: true })
              .boundingBox();
            const p = await pill.boundingBox();
            if (!log || !p) return fail('mode row not rendered');
            if (Math.abs(log.y + log.height / 2 - (p.y + p.height / 2)) > 4)
              fail(`the pill wrapped off the mode row at 390 (${theme})`);
            if (p.x + p.width > FLOOR.width) fail(`the pill overflows at 390 (${theme})`);
            await ctx.shot(`floor-390-${theme}`);
            await field.fill(''); // never saved
          }
        } catch (err) {
          await ctx.shot('fail-at-390').catch(() => null);
          throw err;
        } finally {
          await ctx.ui.setTheme('light');
          await ctx.page.setViewportSize(PHONE);
        }
      },
    },
    {
      id: 'mcp',
      title: 'MCP: list_log and get_day mask private text; search never matches it; unlock reveals',
      entry: 'mcp',
      proves: ['mcp-list-redacts', 'mcp-get-day-redacts', 'mcp-search-miss', 'mcp-unlock-reveals'],
      async run(ctx) {
        const today = await appToday(ctx);
        const r = ctx.mcp.reads;
        const list = await r.listLog({ from: today, to: today, limit: 200 });
        const byId = new Map(list.entries.map((e) => [e.id, e]));
        for (const id of [made.pill, made.makePrivate, made.night]) {
          const e = byId.get(id);
          if (!e) fail(`list_log is missing ${id}`);
          if (e!.text !== MASK || e!.private !== true || e!.day !== today || !e!.localTime)
            fail(`list_log private row: ${JSON.stringify(e)}`);
        }
        const pub = byId.get(made.after);
        if (!pub || pub.private || !pub.text.includes('next one'))
          fail(`public row: ${JSON.stringify(pub)}`);
        const dump = JSON.stringify(list);
        for (const word of ['lunch notes', 'tango', 'night secret'])
          if (dump.includes(word)) fail(`list_log leaked "${word}"`);

        const day = await r.getDay({ day: today });
        const dayRow = day.log.entries.find((e) => e.id === made.makePrivate);
        if (dayRow?.text !== MASK) fail(`get_day row: ${JSON.stringify(dayRow)}`);
        if (JSON.stringify(day.log).includes('tango')) fail('get_day leaked the private text');

        for (const q of [
          `${tag(ctx)} lunch`,
          'wifi pw: tango',
          `${tag(ctx)} night secret`,
          'private entry',
        ]) {
          const hit = await r.searchLog({ query: q, from: today });
          if (hit.entries.length !== 0)
            fail(`search_log "${q}" found ${JSON.stringify(hit.entries)}`);
        }
        const open = await r.searchLog({ query: `${tag(ctx)} next one`, from: today });
        if (!open.entries.some((e) => e.id === made.after))
          fail('search_log missed the public line');

        await ctx.api.writes.setLogEntryPrivate(made.makePrivate, false);
        const after = await r.searchLog({ query: 'wifi pw: tango', from: today });
        if (!after.entries.some((e) => e.id === made.makePrivate && e.text.includes('tango')))
          fail('unlocked, the text still doesn’t read over MCP');
      },
    },
    noConsoleErrors,
  ],
};
