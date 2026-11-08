// Pull requests from `gh pr list`, at most once a minute (the container token is read-only). A failed
// fetch keeps the last list and says how old it is.
import { execFile } from 'node:child_process';
import { parseTime } from './fmt.ts';

export type Pr = {
  number: number;
  title: string;
  branch: string;
  state: string;
  mergedAt: number | null;
};

export function parsePrs(text: string): Pr[] {
  const raw = JSON.parse(text) as unknown;
  if (!Array.isArray(raw)) throw new Error('gh pr list: not an array');
  return raw
    .map((x) => x as Record<string, unknown>)
    .filter((x) => Number.isInteger(x.number))
    .map((x) => ({
      number: x.number as number,
      title: typeof x.title === 'string' ? x.title : '',
      branch: typeof x.headRefName === 'string' ? x.headRefName : '',
      state: typeof x.state === 'string' ? x.state : '',
      mergedAt: parseTime(x.mergedAt),
    }));
}

export const GH_ARGS = [
  'pr',
  'list',
  '--state',
  'all',
  '--limit',
  '40',
  '--json',
  'number,title,headRefName,state,mergedAt',
];

export type Fetch = () => Promise<string>;
export const ghFetch: Fetch = () =>
  new Promise((resolve, reject) =>
    execFile('gh', GH_ARGS, { timeout: 8000, maxBuffer: 1 << 20 }, (err, out) =>
      err ? reject(err) : resolve(out),
    ),
  );

export class PrCache {
  list: Pr[] = [];
  at: number | null = null; // last success
  error: string | null = null;
  private tried = -Infinity;
  private busy = false;
  private fetch: Fetch;
  private everyMs: number;
  constructor(fetch: Fetch, everyMs = 60000) {
    this.fetch = fetch;
    this.everyMs = everyMs;
  }

  // Starts a fetch when the last attempt is older than everyMs; never two at once.
  async poll(now: number): Promise<void> {
    if (this.busy || now - this.tried < this.everyMs) return;
    this.busy = true;
    this.tried = now;
    try {
      this.list = parsePrs(await this.fetch());
      this.at = now;
      this.error = null;
    } catch (e) {
      this.error = ((e as Error).message || 'failed').split('\n')[0]!.slice(0, 80);
    } finally {
      this.busy = false;
    }
  }
}
