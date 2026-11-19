// dispatch's asks of the maintainer (queue.json asks[]: docs/ops/HUB.md → Asks): the open ones for the tower and the
// brief, and the writes `pnpm board asks add|answer|close` make. Writes take and return the raw queue object, so keys
// this file doesn't know are kept; the CLI re-parses the result before it writes. Pure.
import { clean, hhmm } from './fmt.ts';
import { ASK_ID, letter, type Ask, type QueueData } from './queue.ts';

export const ASK_KEEP_MS = 24 * 3600e3; // answered and closed asks stay a day, for /back and `asks show`
const LINE_MAX = 120;

type Raw = Record<string, unknown>;
type Fmt = (t: number) => string;

const num = (id: string) => Number(ASK_ID.exec(id)?.[1] ?? 0);
const one = (s: string, max = LINE_MAX) => {
  const t = clean(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

// Open asks, oldest id first.
export const openAsks = (q: QueueData | null): Ask[] =>
  (q?.asks ?? []).filter((a) => a.status === 'open').sort((x, y) => num(x.id) - num(y.id));

// Where a pane ask's go is typed, and the words.
export const paneOf = (a: Ask) => a.pane ?? a.lane ?? 'pane not named';
export const goLine = (a: Ask) => `type in the ${paneOf(a)} pane: ${a.go ?? 'go'}`;
const optionText = (a: Ask, l: string) => a.options[l.charCodeAt(0) - 97] ?? '?';

// `pnpm board asks list`: every open ask, its options lettered, and how to reply.
export function askLines(asks: Ask[], f: Fmt = hhmm): string {
  if (!asks.length) return 'ASKS none open';
  const newest = asks.reduce((m, a) => (num(a.id) > num(m) ? a.id : m), asks[0]!.id);
  const out = [`ASKS ${asks.length} open · newest ${newest}`];
  for (const a of asks) {
    out.push(
      `${a.id} · ${a.asked === null ? '--:--' : f(a.asked)}${a.lane ? ` · ${a.lane}` : ''} · ${one(a.text)}`,
    );
    if (a.options.length)
      out.push(`   ${a.options.map((o, i) => `${letter(i)}) ${one(o, 60)}`).join('   ')}`);
    if (a.needsPane) out.push(`   GO NEEDED: ${goLine(a)}`);
    else
      out.push(
        a.pick
          ? `   pick ${a.pick} · reply ${a.id} ${a.pick} | ${a.id} ok | ${a.id} ?${a.explicit ? ' · its own reply, not all ok' : ''}`
          : `   no pick · reply ${a.id} <letter> | ${a.id} ?`,
      );
  }
  return out.join('\n');
}

// `pnpm board asks show <id>`: one ask in full, any status.
export function askShow(a: Ask, f: Fmt = hhmm): string {
  const out = [
    `${a.id} · ${a.status}${a.asked === null ? '' : ` · asked ${f(a.asked)}`}${a.lane ? ` · ${a.lane}` : ''}`,
    one(a.text, 400),
    ...a.options.map(
      (o, i) => `  ${letter(i)}) ${one(o, 200)}${a.pick === letter(i) ? '  ← pick' : ''}`,
    ),
  ];
  if (a.needsPane) out.push(`GO NEEDED: ${goLine(a)}`);
  if (a.answer)
    out.push(
      `answered ${a.answer}) ${one(optionText(a, a.answer), 200)}${a.answeredAt === null ? '' : ` at ${f(a.answeredAt)}`}`,
    );
  else if (a.status === 'closed')
    out.push(`closed${a.answeredAt === null ? '' : ` at ${f(a.answeredAt)}`}`);
  return out.join('\n');
}

// The brief's ASKS section (brief.ts): a count, then the first rows.
export function askBriefLines(asks: Ask[], max = 5): string[] {
  if (!asks.length) return ['ASKS none'];
  const pane = asks.filter((a) => a.needsPane).length;
  const row = (a: Ask) =>
    `  ${one(
      `${a.id} ${one(a.text, 60)} · ${
        a.needsPane
          ? `go typed in ${paneOf(a)}`
          : `${a.options.map((o, i) => `${letter(i)}) ${one(o, 24)}`).join(' ')}${a.pick ? ` · pick ${a.pick}` : ''}`
      }`,
      LINE_MAX - 2,
    )}`;
  return [
    `ASKS ${asks.length}${pane ? ` · ${pane} needs your go in a pane` : ''}`,
    ...asks.slice(0, max).map(row),
    ...(asks.length > max ? [`  +${asks.length - max} more`] : []),
  ];
}

// ---- writes (on the raw object) ----

const rawAsks = (raw: Raw): Raw[] => (Array.isArray(raw.asks) ? (raw.asks as Raw[]) : []);
const iso = (t: number) => new Date(t).toISOString();

// Answered and closed asks older than a day go; open ones always stay. askSeq keeps the highest id ever used, so a
// pruned id is never handed out again (a stale `d5 b` must never land on a new d5).
export function pruneAsks(raw: Raw, now: number): Raw {
  if (!Array.isArray(raw.asks)) return raw;
  const keep = rawAsks(raw).filter((a) => {
    if (a?.status === 'open') return true;
    const t = Date.parse(String(a?.answeredAt ?? ''));
    return !(t > 0) || now - t <= ASK_KEEP_MS; // no time: kept, so a hand-written entry never vanishes unseen
  });
  if (keep.length === rawAsks(raw).length) return raw;
  return { ...raw, askSeq: maxSeq(raw), asks: keep };
}
const maxSeq = (raw: Raw) =>
  Math.max(
    Number.isInteger(raw.askSeq) ? (raw.askSeq as number) : 0,
    ...rawAsks(raw).map((a) => num(String(a?.id ?? ''))),
  );

export type AskInput = {
  text: string;
  options?: string[];
  pick?: string;
  lane?: string;
  pane?: string;
  go?: string;
  explicit?: boolean;
};

// `asks add` (stdin JSON): the next id after askSeq and every id in the file, so a pruned id never returns.
export function addAsk(raw: Raw, input: unknown, now: number): { raw: Raw; id: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error(
      'asks add: stdin wants a JSON object {text, options, pick, lane?, pane?, go?, explicit?}',
    );
  const i = input as Record<string, unknown>;
  const known = ['text', 'options', 'pick', 'lane', 'pane', 'go', 'explicit'];
  const extra = Object.keys(i).filter((k) => !known.includes(k));
  if (extra.length) throw new Error(`asks add: unknown field ${extra.join(', ')}`);
  const seq = maxSeq(raw);
  const id = `d${seq + 1}`;
  const entry: Raw = {
    id,
    asked: iso(now),
    text: i.text,
    options: i.options ?? [],
    ...(i.pick !== undefined ? { pick: i.pick } : {}),
    ...(i.lane !== undefined ? { lane: i.lane } : {}),
    ...(i.pane !== undefined ? { needsPane: true, pane: i.pane } : {}),
    ...(i.go !== undefined ? { go: i.go } : {}),
    ...(i.explicit !== undefined ? { explicit: i.explicit } : {}),
    status: 'open',
  };
  return { raw: { ...raw, askSeq: seq + 1, asks: [...rawAsks(raw), entry] }, id };
}

// `asks answer <id|all> <letter|ok> [--upto d<n>]`: what it printed and the new raw (unchanged when nothing was
// answered). A pane ask is never answered here, by a letter or by `ok`: its go is typed in the pane (GO NEEDED). `ok`
// takes the pick; an ask with no pick needs a letter (NO PICK). `all ok` covers only what the user was shown — the
// asks up to `upto`, the newest id dispatch last put in front of them — and never an explicit ask (OWN REPLY).
export function answerAsks(
  raw: Raw,
  asks: Ask[],
  target: string,
  reply: string,
  now: number,
  upto: string | null = null,
): { raw: Raw; out: string[]; answered: number } {
  const r = reply.toLowerCase();
  if (r !== 'ok' && !/^[a-z]$/.test(r))
    throw new Error(
      `asks answer: reply "${reply}" is not a letter or ok (an explanation is \`asks show\`)`,
    );
  let todo: Ask[];
  if (target === 'all') {
    if (r !== 'ok')
      throw new Error('asks answer all: only `all ok` (each pick), never one letter for every ask');
    if (!upto || !ASK_ID.test(upto.toLowerCase()))
      throw new Error(
        'asks answer all ok: wants --upto d<n>, the newest ask the user was shown (`asks list` prints it)',
      );
    todo = asks.filter((a) => a.status === 'open').sort((x, y) => num(x.id) - num(y.id));
    if (!todo.length) return { raw, out: ['ASKS none open'], answered: 0 };
  } else {
    const a = asks.find((x) => x.id === target.toLowerCase());
    if (!a) throw new Error(`asks answer: no ask ${target}`);
    if (a.status !== 'open')
      throw new Error(
        `asks answer: ${a.id} is ${a.status}${a.answer ? ` (${a.answer})` : ''}, not open`,
      );
    todo = [a];
  }
  const out: string[] = [];
  const picked = new Map<string, string>();
  const cap = upto ? num(upto.toLowerCase()) : Infinity;
  for (const a of todo) {
    if (num(a.id) > cap) {
      out.push(`NOT SHOWN ${a.id}: newer than ${upto}, so not covered by all ok · show it: asks show ${a.id}`);
      continue;
    }
    if (a.needsPane) {
      out.push(`GO NEEDED ${a.id}: ${goLine(a)} (a reply here is not the go)`);
      continue;
    }
    if (target === 'all' && a.explicit) {
      out.push(`OWN REPLY ${a.id}: its own reply only (${a.id} ok or ${a.id} <letter>), never all ok`);
      continue;
    }
    const l = r === 'ok' ? a.pick : r;
    if (!l) {
      out.push(
        `NO PICK ${a.id}: choose a letter (${a.options.map((_, i) => letter(i)).join(', ')})`,
      );
      continue;
    }
    if (l.charCodeAt(0) - 97 >= a.options.length)
      throw new Error(
        `asks answer: ${a.id} has ${a.options.length} options (a–${letter(a.options.length - 1)}), not ${l}`,
      ); // a pick is always one of its options (parseQueue), so only a typed letter lands here
    picked.set(a.id, l);
    const said = `${a.id} ${r}`;
    const meaning = `${l}) ${one(optionText(a, l), 200)}`;
    out.push(`ANSWERED ${a.id}: ${meaning}${l === a.pick ? ' (the pick)' : ''}`);
    out.push(
      a.lane
        ? `relay to ${a.lane}: [relay] ${a.lane} — the user: "${said}" → "${one(a.text, 200)}" = ${meaning}`
        : `dispatch's own: "${one(a.text, 200)}" = ${meaning}`,
    );
  }
  if (!picked.size) return { raw, out, answered: 0 };
  const at = iso(now);
  const next = rawAsks(raw).map((e) =>
    typeof e?.id === 'string' && picked.has(e.id)
      ? { ...e, status: 'answered', answer: picked.get(e.id), answeredAt: at }
      : e,
  );
  return { raw: { ...raw, asks: next }, out, answered: picked.size };
}

// `asks close <id>`: withdrawn, answered in words, or a pane go that arrived.
export function closeAsk(raw: Raw, asks: Ask[], id: string, now: number): Raw {
  const a = asks.find((x) => x.id === id.toLowerCase());
  if (!a) throw new Error(`asks close: no ask ${id}`);
  if (a.status !== 'open') throw new Error(`asks close: ${a.id} is ${a.status}, not open`);
  return {
    ...raw,
    asks: rawAsks(raw).map((e) =>
      e?.id === a.id ? { ...e, status: 'closed', answeredAt: iso(now) } : e,
    ),
  };
}
