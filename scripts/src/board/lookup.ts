// `pnpm board wi <id>` (the hub's /wi): what an id names, in one short block, from what the board already holds — an
// F-number (queue.json followups[], else the roadmap's first lines naming it), a PR (the tower's pr-index.json), an
// ask (d<n>), or a lane (its lane file, its devQueue and autoStart entries, its kickoff's first line). Pure; the CLI
// reads the files.
import { askShow } from './tower/asks.ts';
import { clean, hhmm } from './tower/fmt.ts';
import type { LaneFile } from './tower/lanes.ts';
import type { Pr } from './tower/prs.ts';
import type { QueueData } from './tower/queue.ts';

export const PRS_FILE = 'pr-index.json'; // the tower writes it beside brief.txt
const PRS_OLD_MS = 10 * 60e3; // the tower refetches every minute or so: a list past this is a failing fetch

export type PrIndexRow = Pick<Pr, 'number' | 'title' | 'branch' | 'state' | 'url'>;
export type PrIndex = { at: number | null; prs: PrIndexRow[] }; // at null: gh never answered since the tower started

export const prsFile = (prs: Pr[], at: number | null) =>
  JSON.stringify({
    at: at === null ? null : new Date(at).toISOString(),
    prs: prs.map(({ number, title, branch, state, url }) => ({
      number,
      title,
      branch,
      state,
      url,
    })),
  }) + '\n';

export function readPrIndex(text: string | null): PrIndex | null {
  if (text === null) return null;
  try {
    const raw = JSON.parse(text) as { at?: unknown; prs?: unknown };
    const at = raw.at === null ? null : typeof raw.at === 'string' ? Date.parse(raw.at) : NaN;
    if (!Array.isArray(raw.prs) || (at !== null && !(at > 0))) return null;
    const prs = raw.prs.flatMap((x) => {
      const p = (x ?? {}) as Record<string, unknown>;
      if (!Number.isInteger(p.number)) return [];
      const s = (k: string) => (typeof p[k] === 'string' ? clean(p[k] as string) : '');
      return [
        {
          number: p.number as number,
          title: s('title'),
          branch: s('branch'),
          state: s('state'),
          url: s('url') || null,
        },
      ];
    });
    return { at, prs };
  } catch {
    return null;
  }
}

export type WiSources = {
  queue: QueueData | null;
  queueWhy?: string | null; // why there is no queue (missing, unreadable)
  lanes: LaneFile[];
  prs: PrIndex | null;
  roadmap: string | null; // /workspace/localNotes/roadmap.md
  kickoff: (branch: string) => string | null; // the kickoff file's text, when there is one
  now: number;
};
type Fmt = (t: number) => string;

const one = (s: string, max = 200) => {
  const t = clean(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const range = (r: { lo: number; hi: number } | null | undefined, f: Fmt) =>
  r ? `~${f(r.lo)}–${f(r.hi)}` : null;

export function whatIs(idIn: string, s: WiSources, f: Fmt = hhmm): string {
  const id = idIn.trim().replace(/^#/, '');
  const pr = /^(?:pr ?)?(\d{1,6})$/i.exec(id);
  if (pr) return prInfo(+pr[1]!, s, f);
  if (/^f\d{1,5}$/i.test(id)) return followup(id.toUpperCase(), s);
  if (/^d\d{1,6}$/i.test(id)) {
    if (!s.queue) return `unknown: ${id} (${s.queueWhy ?? 'no queue.json'})`;
    const a = s.queue?.asks?.find((x) => x.id === id.toLowerCase());
    return a ? askShow(a, f) : `not found: ${id} (no such ask in queue.json)`;
  }
  if (/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) return lane(id, s, f);
  return `not found: ${one(id, 60)} (an F-number, PR n, d<n> or a lane name)`;
}

function followup(id: string, s: WiSources): string {
  const fu = s.queue?.followups.find((x) => x.id === id);
  const unk = s.queue ? '' : ` (${s.queueWhy ?? 'no queue.json'}: followups[] unknown)`;
  if (fu)
    return `${fu.id} · ${fu.status} · ${fu.owner} · after ${one(fu.after, 80)}${fu.sinceDay ? ` · since ${fu.sinceDay}` : ''} · ${one(fu.what)}${fu.source ? ` (${one(fu.source, 80)})` : ''}`;
  const re = new RegExp(`\\b${id}\\b`);
  const lines = (s.roadmap ?? '')
    .split('\n')
    .filter((l) => re.test(l))
    .slice(0, 2);
  if (lines.length)
    return [`${id} (roadmap, not in followups[]${unk}):`, ...lines.map((l) => `  ${one(l)}`)].join(
      '\n',
    );
  return `not found: ${id} (not in followups[] or the roadmap)${unk}`;
}

function prInfo(n: number, s: WiSources, f: Fmt): string {
  if (!s.prs)
    return `PR ${n}: no pr-index.json yet (the web tower writes it every 30 s: board.sh tower start)`;
  if (s.prs.at === null)
    return `PR ${n}: the tower has no PR list yet (gh PRs not answered since it started)`;
  const p = s.prs.prs.find((x) => x.number === n);
  const age =
    s.now - s.prs.at > PRS_OLD_MS ? ` (the list is from ${f(s.prs.at)}: gh PRs failing?)` : '';
  if (!p) return `PR ${n}: not in the tower's newest PRs (as of ${f(s.prs.at)})${age}`;
  const out = [
    `PR ${n} · ${p.state} · ${p.branch} · "${one(p.title, 120)}"${p.url ? ` · ${p.url}` : ''}${age}`,
  ];
  const l = s.lanes.find((x) => x.branch === p.branch);
  if (l) out.push(laneLine(l, f));
  return out.join('\n');
}

const laneLine = (l: LaneFile, f: Fmt) =>
  [
    `  lane ${l.phase}`,
    l.step ? one(l.step, 100) : null,
    l.eta?.pr ? `PR ${range(l.eta.pr, f)}` : null,
    l.needs ? `needs: ${one(l.needs.what, 100)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

function lane(b: string, s: WiSources, f: Fmt): string {
  const out: string[] = [];
  const l = s.lanes.find((x) => x.branch === b);
  if (l) out.push(`${b} · lane file:`, laneLine(l, f));
  const q = s.queue?.devQueue.find((x) => x.branch === b);
  if (q)
    out.push(
      `  devQueue ${q.state}${q.pr ? ` · PR ${q.pr}` : ''}${q.note ? ` · ${one(q.note, 100)}` : ''}${q.waitingOn ? ` · waiting on ${one(q.waitingOn, 80)}` : ''}`,
    );
  const a = s.queue?.autoQueue?.find((x) => x.branch === b);
  if (a)
    out.push(
      `  autoStart ${a.order ?? '-'}${a.cls ? ` ${a.cls}` : ''}${a.after.length ? ` · after ${a.after.join(', ')}` : ''}${a.note ? ` · ${one(a.note, 100)}` : ''}`,
    );
  const pr = s.prs?.prs.filter((x) => x.branch === b).sort((x, y) => y.number - x.number)[0];
  if (pr) out.push(`  PR ${pr.number} · ${pr.state} · "${one(pr.title, 100)}"`);
  if (!s.queue) out.push(`  devQueue, autoStart: unknown (${s.queueWhy ?? 'no queue.json'})`);
  const k = s.kickoff(b);
  const first = k?.split('\n').find((x) => x.trim());
  if (first) out.push(`  kickoff: ${one(first, 160)}`);
  if (!out.length) return `not found: ${b} (no lane file, queue entry, PR or kickoff)`;
  if (!l) out.unshift(`${b}:`);
  return out.join('\n');
}
