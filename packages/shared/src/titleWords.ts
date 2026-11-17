// A quick-add title keeps every word the user typed that the parse didn't use (quick-add.md → 2026-11-17, titles).
// The model sometimes drops a title word ("call the bank typed at 1 am" → "call the bank") or keeps a due phrase
// it used ("finish slides before 3pm" with 15:00). quickParse.ts says which line ranges the parse used; this
// lines the model's title up against the typed words and puts back, or takes out, the difference. Pure.

export type Range = readonly [start: number, end: number];

export interface TitleMeta {
  meta: readonly Range[]; // words the parse used: the model may drop them
  tail: readonly Range[]; // a due phrase the parse used: taken out when it ends the title
  lead: readonly Range[]; // a lead-in the parse used ("aperture,", a spoken "remind me … to"): taken out
}

interface Token {
  raw: string;
  key: string; // compared: NFKC, lowercase, edge punctuation off; '' = no letter or digit
  start: number; // the key's range in the line
  end: number;
}

const EDGE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
// Left dangling at the end of a title once the due phrase after it went: "send invoice until". Not "on" or "to":
// "turn the heating on 7am", "decide what to work on tomorrow" keep theirs.
const CONNECTOR = new Set(['at', 'by', 'before', 'until', 'till', 'due', '@']);

function tokens(text: string): Token[] {
  return [...text.matchAll(/\S+/g)].map((m) => {
    const lead = m[0].length - m[0].replace(/^[^\p{L}\p{N}]+/u, '').length;
    const key = m[0].replace(EDGE, '');
    const start = m.index + lead;
    return { raw: m[0], key: key.normalize('NFKC').toLowerCase(), start, end: start + key.length };
  });
}

const same = (a: Token, b: Token) => (a.key || a.raw) === (b.key || b.raw);
const inside = (t: Token, rs: readonly Range[]) =>
  t.key !== '' && rs.some(([s, e]) => t.start >= s && t.end <= e);
// A word a used range touches is the parse's: "p.m." of a clock read as "5 p".
const touches = (t: Token, rs: readonly Range[]) =>
  t.key !== '' && rs.some(([s, e]) => t.start < e && t.end > s);

// The model's title with every dropped word the parse didn't use put back and any due phrase it did use taken out.
// The model's own string stands when nothing changes, or when its title isn't the line's words in order
// (reworded, reordered) — then there's nothing to line up. A word it only recapitalized is the user's again.
export function keepTitleWords(line: string, title: string, m: TitleMeta): string {
  const words = tokens(line);
  const kept = new Array<boolean>(words.length).fill(false);
  let at = 0;
  let recased = false;
  for (const t of tokens(title)) {
    let i = at;
    while (i < words.length && !same(words[i]!, t)) i++;
    if (i === words.length) {
      if (t.key === '') continue; // a dash or '&' the line spells differently
      return title;
    }
    kept[i] = true;
    at = i + 1;
    if (t.raw !== words[i]!.raw && t.raw.toLowerCase() === words[i]!.raw.toLowerCase())
      recased = true;
  }
  let changed = recased;
  words.forEach((w, i) => {
    if (kept[i] || w.key === '' || touches(w, m.meta)) return;
    kept[i] = changed = true;
  });
  const drop = (i: number) => {
    kept[i] = false;
    changed = true;
  };
  words.forEach(
    (w, i) => kept[i] && m.lead.some(([s, e]) => w.start >= s && w.end <= e) && drop(i),
  );
  // From the end: a due phrase the parse used, then a connector its going left behind ("until", "at").
  for (let i = words.length - 1; i >= 0; i--) {
    if (!kept[i]) continue;
    const w = words[i]!;
    const next = words[i + 1];
    if (inside(w, m.tail)) drop(i);
    else if (
      CONNECTOR.has(w.key || w.raw) &&
      next &&
      !kept[i + 1] &&
      touches(next, [...m.meta, ...m.tail])
    )
      drop(i);
    else if (w.key === '')
      continue; // a dash before the phrase: the rebuild trims it
    else break;
  }
  if (!changed) return title;
  // A dash or emoji between two words that stay stays with them ("buy cake 🎂 for sam").
  const keyed = words.flatMap((w, i) => (w.key ? [i] : []));
  words.forEach((w, i) => {
    if (w.key || kept[i]) return;
    const before = keyed.filter((k) => k < i).at(-1);
    const after = keyed.find((k) => k > i);
    if (before !== undefined && after !== undefined && kept[before] && kept[after]) kept[i] = true;
  });
  const out = words
    .filter((_, i) => kept[i])
    .map((w) => w.raw)
    .join(' ')
    .replace(/^(?:[,;:]+|[-–—]+(?=\s|$))\s*/, '')
    .replace(/(?:\s+[-–—]+|[,;:]+)$/, '')
    .trim();
  return out || title;
}
