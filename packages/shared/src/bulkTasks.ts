// The bulk-add grammar — pure, the single validator for the "paste many tasks" flow. The OPERATOR of
// this grammar is Claude (the user asks Claude to generate the paste), so it is deliberately strict and
// concrete: no natural-language dates, no silent rewrites. Every ambiguity is a loud error, not a guess.
//
//   line   := title [ ' | ' tokens ]        -- split on the FIRST ' | ' (space pipe space)
//   title  := literal text, trimmed, non-empty; '#' '~' 'due:' are LITERAL here (never parsed)
//   tokens := token (whitespace token)*      -- each KIND at most once, any order
//   token  := '~' <digits>                   -- estimateMin, whole minutes >= 1
//           | '#' <word> | '#"' <text> '"'   -- Category.label, case-insensitive exact match
//           | 'due:' YYYY-MM-DD ['@' HH:MM] -- dueDay, real calendar date, lowercase keyword; the
//                                               optional '@HH:MM' (24h, zero-padded) is the dueTime
//           | 'notes:"' <text> '"'           -- notes; escapes '\n' (newline) and '\\' (backslash)
//                                               only, no '"' inside, <= TASK_NOTES_MAX after unescaping
//           | '@' <slug>                     -- Place.slug (places.ts), case-insensitive exact match
//
// errors[] are RED (blocking — gate submit); warnings[] are YELLOW (non-blocking — the task is still
// created). A token that declares intent but can't be parsed is red; one that parses but doesn't match
// (an unknown #label) is yellow. Titles are NEVER rewritten — a list marker or stray '|' is an error.
//
// The capture bar's Task mode takes ONE line of the same grammar (parseTaskLine), gated on ' | ' so a
// bare capture never meets it — still one validator, two surfaces.

import { isDayKey, isTimeKey } from './dates';
import { TASK_NOTES_MAX } from './taskNotes';
import type { CreateTaskInput } from './api';
import { PLACE_SLUG_RE } from './places';
import type { Category, Place } from './types';

export type PlaceRef = Pick<Place, 'slug' | 'name'>;

export interface BulkLine {
  line: number; // 1-based line number in the textarea (blank lines are counted, so it matches)
  raw: string;
  title: string;
  estimateMin: number | null;
  categoryLabel: string | null; // as written, for the preview (present even when unmatched)
  categoryId: string | null; // resolved match, or null
  dueDay: string | null;
  dueTime: string | null; // "HH:MM" from due:<day>@HH:MM
  notes: string | null; // unescaped + trimmed
  placeSlug: string | null; // as written (lowercased), for the preview (present even when unmatched)
  place: string | null; // resolved Place slug, or null
  errors: string[]; // red — blocking
  errorKinds: BulkErrorKind[]; // parallel to errors: what each is about, for a surface with its own words
  warnings: string[]; // yellow — non-blocking
}
// `unknown` carries the token that wasn't recognized.
export type BulkErrorKind =
  { kind: 'category' | 'due' | 'place' | 'other' } | { kind: 'unknown'; token: string };

export interface BulkParse {
  lines: BulkLine[]; // one per non-blank input line
  errorCount: number; // lines carrying >= 1 error
  canSubmit: boolean; // no errors AND at least one line
}

const SEP = ' | ';
const LIST_MARKER = /^([-*+•]|\d+[.)])\s/;
const NOTES_OPEN = /^notes:"/i; // case-insensitive here so `Notes:` gets its own error, not "unrecognized"

// Split the token region into token spans, keeping a #"quoted label" or notes:"…" (both contain
// spaces) whole. An unclosed quote runs to the end of the region and is flagged at classify time.
// Text glued to a notes closing quote stays in the token, so an embedded '"' is reported as one.
// Spans, not strings, so tokenAtCaret shares these exact quoting rules.
function scanTokens(region: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const n = region.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(region[i]!)) i++;
    if (i >= n) break;
    const start = i;
    const notes = NOTES_OPEN.test(region.slice(i, i + 7));
    if ((region[i] === '#' && region[i + 1] === '"') || notes) {
      i += notes ? 7 : 2;
      while (i < n && region[i] !== '"') i++;
      if (i < n) i++; // consume the closing quote
      if (notes) while (i < n && !/\s/.test(region[i]!)) i++;
    } else {
      while (i < n && !/\s/.test(region[i]!)) i++;
    }
    out.push({ start, end: i });
  }
  return out;
}

function matchCategory(
  label: string,
  categories: readonly Pick<Category, 'id' | 'label'>[],
): { id: string | null; ambiguous: boolean; unknown: boolean } {
  const hits = categories.filter((c) => c.label.toLowerCase() === label.toLowerCase());
  if (hits.length > 1) return { id: null, ambiguous: true, unknown: false };
  if (hits.length === 1) return { id: hits[0]!.id, ambiguous: false, unknown: false };
  return { id: null, ambiguous: false, unknown: true };
}

function parseLine(
  raw: string,
  lineNo: number,
  categories: readonly Pick<Category, 'id' | 'label'>[],
  places: readonly PlaceRef[],
): BulkLine {
  const out: BulkLine = {
    line: lineNo,
    raw,
    title: '',
    estimateMin: null,
    categoryLabel: null,
    categoryId: null,
    dueDay: null,
    dueTime: null,
    notes: null,
    placeSlug: null,
    place: null,
    errors: [],
    errorKinds: [],
    warnings: [],
  };
  const fail = (message: string, kind: BulkErrorKind = { kind: 'other' }) => {
    out.errors.push(message);
    out.errorKinds.push(kind);
  };
  const CATEGORY: BulkErrorKind = { kind: 'category' };
  const DUE: BulkErrorKind = { kind: 'due' };
  const PLACE: BulkErrorKind = { kind: 'place' };

  if (LIST_MARKER.test(raw.trim()))
    fail('remove the list marker (- / * / 1.) — titles are taken literally');

  const idx = raw.indexOf(SEP);
  const titleSeg = idx === -1 ? raw : raw.slice(0, idx);
  const region = idx === -1 ? '' : raw.slice(idx + SEP.length);
  out.title = titleSeg.trim();

  if (out.title.includes('|'))
    fail("remove '|' from the title — ' | ' (space pipe space) only separates tokens");
  else if (idx === -1 && raw.includes('|'))
    fail("malformed separator — use ' | ' (space pipe space) with a token after it");
  if (idx !== -1 && region.trim() === '')
    fail("nothing after ' | ' — add a token or drop the separator");
  if (out.title === '') fail('empty title');
  // Legal (titles are literal), but almost always a notes token that lost its ' | '.
  else if (/notes:"/i.test(out.title))
    out.warnings.push("'notes:\"' is in the title — tokens go after ' | '");

  type Kind = 'estimate' | 'category' | 'due' | 'notes' | 'place';
  const seen = new Set<Kind>();
  const once = (kind: Kind, label: string): boolean => {
    if (seen.has(kind)) {
      fail(
        `duplicate ${label} token — each is allowed once`,
        kind === 'category'
          ? CATEGORY
          : kind === 'due'
            ? DUE
            : kind === 'place'
              ? PLACE
              : undefined,
      );
      return false;
    }
    seen.add(kind);
    return true;
  };

  for (const tok of scanTokens(region).map((s) => region.slice(s.start, s.end))) {
    if (tok.startsWith('~')) {
      if (!once('estimate', 'estimate (~)')) continue;
      const rest = tok.slice(1);
      const min = Number(rest);
      if (!/^\d+$/.test(rest) || min < 1)
        fail(`invalid estimate '${tok}' — use ~<whole minutes>, e.g. ~30`);
      else out.estimateMin = min;
    } else if (tok.startsWith('#')) {
      if (!once('category', 'category (#)')) continue;
      let label: string | null = null;
      if (tok.startsWith('#"')) {
        if (tok.length < 3 || !tok.endsWith('"'))
          fail(`unterminated quote in category '${tok}' — use #"Label"`, CATEGORY);
        else label = tok.slice(2, -1); // may be '' for #"" — caught below, same as bare #
      } else {
        label = tok.slice(1);
      }
      if (label === '') {
        fail('empty category label — use #Label or #"Two Words"', CATEGORY);
      } else if (label !== null) {
        out.categoryLabel = label;
        const m = matchCategory(label, categories);
        if (m.ambiguous) fail(`ambiguous category '${label}' — it matches more than one`, CATEGORY);
        else if (m.unknown) out.warnings.push(`no category '${label}' — created without one`);
        else out.categoryId = m.id;
      }
    } else if (/^notes:/i.test(tok)) {
      if (!once('notes', 'notes')) continue;
      if (!tok.startsWith('notes:')) {
        fail(`use lowercase 'notes:' — got '${tok.slice(0, 6)}'`);
        continue;
      }
      if (!tok.startsWith('notes:"')) {
        fail('notes need quotes — use notes:"your text"');
        continue;
      }
      const close = tok.indexOf('"', 7);
      if (close === -1) {
        fail('unterminated notes — close the quote: notes:"…"');
        continue;
      }
      if (close !== tok.length - 1) {
        fail(`notes can't contain '"' — reword it, or use ' instead`);
        continue;
      }
      // `\n` is a newline and `\\` a literal backslash, so `\\nabla` survives as `\nabla`.
      const value = tok
        .slice(7, -1)
        .replace(/\\([\\n])/g, (_, c: string) => (c === 'n' ? '\n' : '\\'))
        .trim();
      if (value === '') fail('empty notes — drop the token or add text');
      else if (value.length > TASK_NOTES_MAX)
        fail(
          `notes are ${value.length.toLocaleString('en-US')} characters — the limit is ${TASK_NOTES_MAX.toLocaleString('en-US')}`,
        );
      else out.notes = value;
    } else if (tok.startsWith('due:')) {
      if (!once('due', 'due')) continue;
      const at = tok.indexOf('@');
      const day = at === -1 ? tok.slice(4) : tok.slice(4, at);
      const time = at === -1 ? null : tok.slice(at + 1);
      if (!isDayKey(day)) fail(`invalid due date '${tok}' — use due:YYYY-MM-DD`, DUE);
      else if (time !== null && !isTimeKey(time))
        fail(`invalid due time '${tok}' — use due:YYYY-MM-DD@HH:MM (24h)`, DUE);
      else {
        out.dueDay = day;
        out.dueTime = time;
      }
    } else if (tok.startsWith('@')) {
      if (!once('place', 'place (@)')) continue;
      const slug = tok.slice(1).toLowerCase();
      if (slug === '') fail('empty place — use @<place>, e.g. @safeway', PLACE);
      else if (!PLACE_SLUG_RE.test(slug))
        fail(`invalid place '${tok}' — use @ and the place's link word, e.g. @safeway`, PLACE);
      else {
        out.placeSlug = slug;
        if (places.some((p) => p.slug === slug)) out.place = slug;
        else out.warnings.push(`no place '@${slug}' — created without one`);
      }
    } else {
      fail(
        `unrecognized token '${tok}' — expected ~<min>, #<label>, @<place>, due:YYYY-MM-DD[@HH:MM], or notes:"…"`,
        { kind: 'unknown', token: tok },
      );
    }
  }

  return out;
}

export function parseBulkTasks(
  text: string,
  categories: readonly Pick<Category, 'id' | 'label'>[],
  places: readonly PlaceRef[],
  existingTitles?: ReadonlySet<string>, // lowercased live task titles, for the "already exists" warning
): BulkParse {
  const rawLines = text.replace(/\r\n/g, '\n').split('\n');
  const lines: BulkLine[] = [];
  const seenTitles = new Set<string>();

  rawLines.forEach((raw, i) => {
    if (raw.trim() === '') return; // skip blank lines, but i+1 keeps the true line number
    const parsed = parseLine(raw, i + 1, categories, places);
    if (parsed.title !== '') {
      const key = parsed.title.toLowerCase();
      if (seenTitles.has(key)) parsed.warnings.push('duplicate title in this paste');
      else if (existingTitles?.has(key)) parsed.warnings.push('a live task already has this title');
      seenTitles.add(key);
    }
    lines.push(parsed);
  });

  const errorCount = lines.filter((l) => l.errors.length > 0).length;
  return { lines, errorCount, canSubmit: errorCount === 0 && lines.length > 0 };
}

export type CaretTokenKind = 'category' | 'estimate' | 'due' | 'place';
export interface CaretToken {
  kind: CaretTokenKind;
  partial: string; // typed so far, after the prefix (and an opening '#"' quote)
  replaceStart: number; // absolute [start, end) of the whole token in the text
  replaceEnd: number;
}

// The completable token under the caret, for capture's suggestion chips — or null. Only in the region
// after the FIRST ' | ', only #/~/@/due: (never inside notes:"…"), and a caret at a token's end counts.
export function tokenAtCaret(text: string, caret: number): CaretToken | null {
  const idx = text.indexOf(SEP);
  if (idx === -1) return null;
  const base = idx + SEP.length;
  if (caret < base) return null;
  const rel = caret - base;
  const span = scanTokens(text.slice(base)).find((s) => s.start <= rel && rel <= s.end);
  if (!span) return null;
  const tok = text.slice(base + span.start, base + span.end);
  const [kind, prefixLen]: [CaretTokenKind, number] | [null, 0] = tok.startsWith('#"')
    ? ['category', 2]
    : tok.startsWith('#')
      ? ['category', 1]
      : tok.startsWith('~')
        ? ['estimate', 1]
        : tok.startsWith('@')
          ? ['place', 1]
          : tok.startsWith('due:')
            ? ['due', 4]
            : [null, 0];
  if (!kind) return null;
  const partial = text.slice(base + span.start + prefixLen, caret).replace(/"$/, '');
  return { kind, partial, replaceStart: base + span.start, replaceEnd: base + span.end };
}

// Capture's gate: tokens only apply once the text carries the separator, so a bare capture ("a|b",
// "- milk", "fix #42") keeps saving literally. Raw text, not trimmed — "milk | " must hit the red
// "nothing after ' | '" error, not save as "milk |".
export const hasTaskTokens = (text: string): boolean => text.includes(SEP);

// One capture = one line of the grammar. A line break is red, never split or truncated: splitting would
// turn one capture into N tasks and truncating would drop text — Bulk add is the many-lines surface.
// No duplicate-title warnings here; repeating a title is normal in quick capture.
export function parseTaskLine(
  raw: string,
  categories: readonly Pick<Category, 'id' | 'label'>[],
  places: readonly PlaceRef[],
): BulkLine {
  const out = parseLine(raw, 1, categories, places);
  if (raw.includes('\n')) {
    out.errors.push('tokens need a single line — remove the line break (Bulk add takes many)');
    out.errorKinds.push({ kind: 'other' });
  }
  return out;
}

// The create input for one clean line. An unmatched #label or @place leaves categoryId / place null
// (created uncategorised / off any list, by design).
export const toCreateInput = (l: BulkLine): CreateTaskInput => ({
  title: l.title,
  categoryId: l.categoryId,
  estimateMin: l.estimateMin,
  dueDay: l.dueDay,
  dueTime: l.dueTime,
  notes: l.notes,
  place: l.place,
});

// The create inputs for a clean parse. The caller checks `canSubmit` first.
export const toCreateInputs = (parse: BulkParse): CreateTaskInput[] =>
  parse.lines.map(toCreateInput);
