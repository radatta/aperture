// The app caps /api calls in flight at 8 (app/src/data/httpClient.ts → MAX_IN_FLIGHT), under dev's Lambda
// concurrency quota of 10 (CI-BOT.md → Compute), so a page-load burst no longer gets 429s. Dev proves the one
// thing only dev can — a real quota, the BFF cold right after the deploy (smoke's Home load, whose console this
// run still holds: consoleErrors is cumulative) — got no 429. The queue's own edges are the http client's tests.
import { noConsoleErrors, type Row, type Scenario } from '../scenario';

const HTTP = 'app/src/data/httpClient.test.ts';
const edge = (id: string, what: string, test: string, shows: string): Row => ({
  id,
  entry: 'ui',
  kind: 'edge',
  what,
  offDev: {
    file: HTTP,
    test,
    why: `dev can't show ${shows}; the queue is the whole case and the test drives it`,
  },
});

export const inflightCap: Scenario = {
  id: 'inflight-cap',
  title: 'In-flight cap keeps a page-load burst under dev’s quota',
  tiers: ['full'],
  rows: [
    {
      id: 'cold-burst',
      entry: 'ui',
      kind: 'nominal',
      what: 'Home’s cold-start burst gets no 429 under dev’s quota of 10',
    },
    edge(
      'cap-holds',
      '20 calls at once: never more than 8 on the wire, sent in order',
      'never has more than MAX_IN_FLIGHT calls on the wire, and starts them in dispatch order',
      'how many calls are on the wire at once',
    ),
    edge(
      'slot-freed',
      'A dropped connection frees its slot for the next call',
      'a rejected fetch frees its slot',
      'a dropped connection on demand',
    ),
    edge(
      'throttle-requeues',
      'A call that got a 429 backs off holding no slot, then queues behind the waiters',
      'a 429 re-enters the queue while it waits to retry',
      'a 429 on demand (an injected one tests the retry, not the slot)',
    ),
  ],
  steps: [
    {
      id: 'home',
      title: 'Home renders; no call was throttled so far this run',
      entry: 'ui',
      proves: ['cold-burst'],
      async run(ctx) {
        await ctx.ui.goto('/');
        const throttled = ctx.consoleErrors().filter((e) => e.includes('status of 429'));
        if (throttled.length)
          throw new Error(`${throttled.length} throttled call(s) this run: ${throttled[0]}`);
      },
    },
    noConsoleErrors,
  ],
};
