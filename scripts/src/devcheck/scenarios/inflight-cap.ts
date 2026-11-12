// The app caps /api calls in flight at 8 (app/src/data/httpClient.ts → MAX_IN_FLIGHT), under the BFF's reserved
// concurrency on dev (CI-BOT.md → Compute), so a page-load burst no longer gets 429s. Dev proves what only
// dev can: a real quota against the BFF cold right after the deploy (smoke's Home load, whose console this run
// still holds — consoleErrors is cumulative) got no 429, and the deployed bundle really holds a burst at 8.
// Home alone never fills the cap (7 on the wire at most; its getDay refetch joins reads still in flight, so its
// total swung 8–10 by timing), so the step holds every /api response while Home loads and three nav taps add
// reads, until the UI wants more than 8: exactly 8 must be on the wire, and the rest must go out after the
// release. The slot itself — freed on a throw, held by nothing during a 429's backoff, lapsing at 15 s — is
// unobservable from outside, so those edges are the http client's tests.
import { targetOrigin } from '../config';
import type { PwRequest, PwResponse, PwRoute } from '../pw-types';
import { noConsoleErrors, type Row, type Scenario } from '../scenario';

const CAP = 8; // app/src/data/httpClient.ts → MAX_IN_FLIGHT
const HTTP = 'app/src/data/httpClient.test.ts';
const edge = (id: string, what: string, test: string): Row => ({
  id,
  entry: 'ui',
  kind: 'edge',
  what,
  offDev: {
    file: HTTP,
    test,
    why: 'dev shows the requests on the wire (cap-holds), never the slot behind them; this is the slot’s own rule, and the test drives it',
  },
});
// Under the slot lease (SLOT_MS, 15 s): a slot lapsing mid-hold would let a 9th call out and read as a breach.
const HOLD_MAX_MS = 8_000;
// Pages whose reads Home doesn't make (sittings + stories, open ideas, habit checks): Home's cold wave is 7–10
// by time of day, and with these the UI wants at least 11 at once in every mode.
const NAV: [string, RegExp][] = [
  ['Recruiting', /\/recruiting$/],
  ['Inbox', /\/inbox$/],
  ['Habits', /\/habits$/],
];
const isApi = (url: string) => new URL(url).pathname.startsWith('/api/');

// Counts /api requests by identity while the step holds them, and judges the burst: the cap must be reached
// (the UI wanted more), never passed, and the calls behind it must go out once slots free.
export function createBurstMeter(cap: number) {
  const live = new Set<object>();
  let total = 0;
  let peak = 0;
  let released = false;
  let afterRelease = 0;
  return {
    started(r: object) {
      live.add(r);
      total++;
      if (released) afterRelease++;
      peak = Math.max(peak, live.size);
    },
    ended: (r: object) => live.delete(r),
    release() {
      released = true;
    },
    live: () => live.size,
    counts: () => ({ total, peak, afterRelease }),
    verdict(): string | null {
      if (peak > cap) return `${peak} /api calls on the wire at once — the cap is ${cap}`;
      if (peak < cap)
        return `the UI wanted only ${peak} /api calls at once, under the cap of ${cap} — this step proves nothing now`;
      if (!released) return 'the held calls were never released';
      if (!afterRelease)
        return `nothing queued behind the cap: ${total} calls, none sent after the release`;
      return null;
    },
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, ok: () => boolean, timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(100);
  }
}

export const inflightCap: Scenario = {
  id: 'inflight-cap',
  title: 'In-flight cap keeps a page-load burst under the BFF’s reservation',
  tiers: ['full'],
  rows: [
    {
      id: 'cold-burst',
      entry: 'ui',
      kind: 'nominal',
      what: 'Home’s cold-start burst gets no 429 under the BFF’s reservation',
    },
    {
      id: 'cap-holds',
      entry: 'ui',
      kind: 'edge',
      what: 'Home plus three nav taps want more than 8 calls at once: exactly 8 on the wire, never more',
    },
    {
      id: 'queue-drains',
      entry: 'ui',
      kind: 'nominal',
      what: 'The calls queued behind the cap go out once slots free, and the burst finishes',
    },
    edge(
      'slot-freed',
      'A dropped connection frees its slot for the next call',
      'a rejected fetch frees its slot',
    ),
    edge(
      'throttle-requeues',
      'A call that got a 429 backs off holding no slot, then queues behind the waiters',
      'a 429 re-enters the queue while it waits to retry',
    ),
    edge(
      'slot-lapses',
      'A call stalled on a dead connection frees its slot after 15 s, so the queue moves on',
      'a call that never answers frees its slot after SLOT_MS — the Lambda behind it has timed out',
    ),
  ],
  steps: [
    {
      id: 'burst',
      title: 'Home plus three nav taps: exactly 8 /api calls on the wire, the rest queued',
      entry: 'ui',
      proves: ['cap-holds', 'queue-drains'],
      async run(ctx) {
        const page = ctx.page;
        const meter = createBurstMeter(CAP);
        let last = Date.now();
        const started = (r: PwRequest) => {
          if (!isApi(r.url())) return;
          meter.started(r);
          last = Date.now();
        };
        // Paired by request identity: the last scenario's reads, aborted by this navigation, end here without
        // having started here, and a request whose body fails after its headers ends twice.
        const ended = (r: object) => {
          if (meter.ended(r)) last = Date.now();
        };
        const responded = (res: PwResponse) => ended(res.request());
        // Held routes: a handler that keeps the route and returns leaves the request paused on the wire (the
        // page's `request` event has already fired), so the app's slot stays taken until fallback() lets it go.
        const held: PwRoute[] = [];
        let firstHeldAt = 0;
        let releasing = false;
        const match = (u: URL) => u.origin === targetOrigin() && isApi(u.href);
        const hold = (route: PwRoute) => {
          if (releasing) return route.fallback();
          if (!held.length) firstHeldAt = Date.now();
          held.push(route);
        };
        // Release before unroute: unroute alone would continue the held ones too, but after the release mark.
        const release = async () => {
          if (releasing) return;
          releasing = true;
          meter.release();
          await Promise.all(held.splice(0).map((r) => r.fallback().catch(() => undefined)));
          await page.unroute(match, hold).catch(() => undefined);
        };
        page.on('request', started);
        page.on('response', responded);
        page.on('requestfailed', ended);
        await page.route(match, hold);
        try {
          await ctx.ui.goto('/');
          // Client-side taps, so Home's held reads stay on the wire; each page adds keys Home doesn't load.
          for (const [name, path] of NAV) {
            await page.getByRole('link', { name, exact: true }).click();
            await page.waitForURL(path, { timeout: 10_000 });
          }
          await until('the cap to fill', () => meter.live() >= CAP, 10_000).catch(() => {
            throw new Error(meter.verdict() ?? 'the cap never filled');
          });
          // Whatever else the UI wants now must queue: a 9th on the wire would show within this second.
          await until('the burst to settle at the cap', () => Date.now() - last > 1_000, 5_000);
          if (Date.now() - firstHeldAt > HOLD_MAX_MS)
            throw new Error(
              `held ${Date.now() - firstHeldAt} ms — past ${HOLD_MAX_MS} ms the 15 s slot lease could free a slot`,
            );
          await release();
          // The burst is over once nothing is on the wire and nothing new has started for a second.
          await until(
            'the queue to drain',
            () => meter.live() === 0 && Date.now() - last > 1_000,
            20_000,
          );
        } finally {
          await release();
          page.off('request', started);
          page.off('response', responded);
          page.off('requestfailed', ended);
        }
        const m = meter.counts();
        ctx.log(
          `${m.total} /api calls, at most ${m.peak} on the wire at once; ${m.afterRelease} went out only after the release`,
        );
        const failed = meter.verdict();
        if (failed) throw new Error(failed);
      },
    },
    {
      id: 'no-429',
      title: 'No call was throttled so far this run',
      entry: 'ui',
      proves: ['cold-burst'],
      async run(ctx) {
        const throttled = ctx.consoleErrors().filter((e) => e.includes('status of 429'));
        if (throttled.length)
          throw new Error(`${throttled.length} throttled call(s) this run: ${throttled[0]}`);
      },
    },
    noConsoleErrors,
  ],
};
