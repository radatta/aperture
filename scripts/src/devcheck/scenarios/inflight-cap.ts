// The app caps /api calls in flight at 8 (app/src/data/httpClient.ts → MAX_IN_FLIGHT), under the BFF's reserved
// concurrency on dev (CI-BOT.md → Compute), so a page-load burst no longer gets 429s. Dev proves what only
// dev can: a real quota against the BFF cold right after the deploy (smoke's Home load, whose console this run
// still holds — consoleErrors is cumulative) got no 429, and the deployed bundle really holds Home's burst at 8,
// counted from the page's own requests. The slot itself — freed on a throw, held by nothing during a 429's
// backoff, lapsing at 15 s — is unobservable from outside, so those edges are the http client's tests.
import type { PwRequest, PwResponse } from '../pw-types';
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
      what: 'Home’s ~10 calls at once: never more than 8 on the wire, the rest queued',
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
      title: 'Home’s burst: never more than 8 /api calls on the wire',
      entry: 'ui',
      proves: ['cap-holds'],
      async run(ctx) {
        const isApi = (url: string) => new URL(url).pathname.startsWith('/api/');
        // Paired by request identity: the last scenario's reads, aborted by this navigation, end here without
        // having started here, and a request whose body fails after its headers ends twice.
        const live = new Set<object>(); // by identity: a response's request() is the event's Request object
        let peak = 0;
        let total = 0;
        let last = Date.now();
        const started = (r: PwRequest) => {
          if (!isApi(r.url())) return;
          live.add(r);
          total++;
          peak = Math.max(peak, live.size);
          last = Date.now();
        };
        const ended = (r: object) => {
          if (live.delete(r)) last = Date.now();
        };
        const responded = (res: PwResponse) => ended(res.request());
        ctx.page.on('request', started);
        ctx.page.on('response', responded);
        ctx.page.on('requestfailed', ended);
        try {
          await ctx.ui.goto('/');
          // The burst is over once nothing is on the wire and nothing new has started for a second.
          await until(
            'Home’s burst to finish',
            () => total > 0 && live.size === 0 && Date.now() - last > 1_000,
            20_000,
          );
        } finally {
          ctx.page.off('request', started);
          ctx.page.off('response', responded);
          ctx.page.off('requestfailed', ended);
        }
        ctx.log(`${total} /api calls loading Home, at most ${peak} on the wire at once`);
        if (peak > CAP)
          throw new Error(`${peak} /api calls on the wire at once — the cap is ${CAP}`);
        // Fewer calls than the cap would pass without exercising it: then this step needs a page that bursts.
        if (total <= CAP)
          throw new Error(
            `Home made only ${total} /api calls, under the cap — this step proves nothing now`,
          );
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
