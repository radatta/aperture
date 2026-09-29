// The bulk-add grammar — pure, the single validator for the "paste many tasks" flow. The OPERATOR of
// this grammar is Claude (the user asks Claude to generate the paste), so it is deliberately strict and
// concrete: no natural-language dates, no silent rewrites. Every ambiguity is a loud error, not a guess.
//
//   line   := title [ ' | ' tokens ]        -- split on the FIRST ' | ' (space pipe space)
//   title  := literal text, trimmed, non-empty; '#' '~' 'due:' are LITERAL here (never parsed)
//   tokens := token (whitespace token)*      -- each KIND at most once, any order
//   token  := '~' <digits>                   -- estimateMin, whole minutes >= 1
//           | '#' <word> | '#"' <text> '"'   -- Category.label, case-insensitive exact match
//           | 'due:' YYYY-MM-DD              -- dueDay, real calendar date, lowercase keyword
//           | 'notes:"' <text> '"'           -- notes; escapes '\n' (newline) and '\\' (backslash)
//                                               only, no '"' inside, <= TASK_NOTES_MAX after unescaping
//
// errors[] are RED (blocking — gate submit); warnings[] are YELLOW (non-blocking — the task is still
// created). A token that declares intent but can't be parsed is red; one that parses but doesn't match
// (an unknown #label) is yellow. Titles are NEVER rewritten — a list marker or stray '|' is an error.
//
// The capture bar's Task mode takes ONE line of the same grammar (parseTaskLine), gated on ' | ' so a
// bare capture never meets it — still one validator, two surfaces.

import { isDayKey } from './dates';
import { TASK_NOTES_MAX } from './taskNotes';
import type { CreateTaskInput } from './api';
import type { Category } from './types';

export interface BulkLine {
  line: number; // 1-based line number in the textarea (blank lines are counted, so it matches)
  raw: string;
  title: string;
  estimateMin: number | null;
  categoryLabel: string | null; // as written, for the preview (present even when unmatched)
  categoryId: string | null; // resolved match, or null
  dueDay: string | null;
  notes: string | null; // unescaped + trimmed
  errors: string[]; // red — blocking
  warnings: string[]; // yellow — non-blocking
}

export interface BulkParse {
  lines: BulkLine[]; // one per non-blank input line
  errorCount: number; // lines carrying >= 1 error
  canSubmit: boolean; // no errors AND at least one line
}

const SEP = ' | ';
const LIST_MARKER = /^([-*+•]|\d+[.)])\s/;
const NOTES_OPEN = /^notes:"/i; // case-insensitive here so `Notes:` gets its own error, not "unrecognized"

// Split the token region into raw token strings, keeping a #"quoted label" or notes:"…" (both contain
// spaces) whole. An unclosed quote runs to the end of the region and is flagged at classify time.
// Text glued to a notes closing quote stays in the token, so an embedded '"' is reported as one.
function scanTokens(region: string): string[] {
  const out: string[] = [];
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
    out.push(region.slice(start, i));
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
): BulkLine {
  const out: BulkLine = {
    line: lineNo,
    raw,
    title: '',
    estimateMin: null,
    categoryLabel: null,
    categoryId: null,
    dueDay: null,
    notes: null,
    errors: [],
    warnings: [],
  };

  if (LIST_MARKER.test(raw.trim()))
    out.errors.push('remove the list marker (- / * / 1.) — titles are taken literally');

  const idx = raw.indexOf(SEP);
  const titleSeg = idx === -1 ? raw : raw.slice(0, idx);
  const region = idx === -1 ? '' : raw.slice(idx + SEP.length);
  out.title = titleSeg.trim();

  if (out.title.includes('|'))
    out.errors.push("remove '|' from the title — ' | ' (space pipe space) only separates tokens");
  else if (idx === -1 && raw.includes('|'))
    out.errors.push("malformed separator — use ' | ' (space pipe space) with a token after it");
  if (idx !== -1 && region.trim() === '')
    out.errors.push("nothing after ' | ' — add a token or drop the separator");
  if (out.title === '') out.errors.push('empty title');
  // Legal (titles are literal), but almost always a notes token that lost its ' | '.
  else if (/notes:"/i.test(out.title))
    out.warnings.push("'notes:\"' is in the title — tokens go after ' | '");

  type Kind = 'estimate' | 'category' | 'due' | 'notes';
  const seen = new Set<Kind>();
  const once = (kind: Kind, label: string): boolean => {
    if (seen.has(kind)) {
      out.errors.push(`duplicate ${label} token — each is allowed once`);
      return false;
    }
    seen.add(kind);
    return true;
  };

  for (const tok of scanTokens(region)) {
    if (tok.startsWith('~')) {
      if (!once('estimate', 'estimate (~)')) continue;
      const rest = tok.slice(1);
      const min = Number(rest);
      if (!/^\d+$/.test(rest) || min < 1)
        out.errors.push(`invalid estimate '${tok}' — use ~<whole minutes>, e.g. ~30`);
      else out.estimateMin = min;
    } else if (tok.startsWith('#')) {
      if (!once('category', 'category (#)')) continue;
      let label: string | null = null;
      if (tok.startsWith('#"')) {
        if (tok.length < 3 || !tok.endsWith('"'))
          out.errors.push(`unterminated quote in category '${tok}' — use #"Label"`);
        else label = tok.slice(2, -1); // may be '' for #"" — caught below, same as bare #
      } else {
        label = tok.slice(1);
      }
      if (label === '') {
        out.errors.push('empty category label — use #Label or #"Two Words"');
      } else if (label !== null) {
        out.categoryLabel = label;
        const m = matchCategory(label, categories);
        if (m.ambiguous)
          out.errors.push(`ambiguous category '${label}' — it matches more than one`);
        else if (m.unknown) out.warnings.push(`no category '${label}' — created without one`);
        else out.categoryId = m.id;
      }
    } else if (/^notes:/i.test(tok)) {
      if (!once('notes', 'notes')) continue;
      if (!tok.startsWith('notes:')) {
        out.errors.push(`use lowercase 'notes:' — got '${tok.slice(0, 6)}'`);
        continue;
      }
      if (!tok.startsWith('notes:"')) {
        out.errors.push('notes need quotes — use notes:"your text"');
        continue;
      }
      const close = tok.indexOf('"', 7);
      if (close === -1) {
        out.errors.push('unterminated notes — close the quote: notes:"…"');
        continue;
      }
      if (close !== tok.length - 1) {
        out.errors.push(`notes can't contain '"' — reword it, or use ' instead`);
        continue;
      }
      // `\n` is a newline and `\\` a literal backslash, so `\\nabla` survives as `\nabla`.
      const value = tok
        .slice(7, -1)
        .replace(/\\([\\n])/g, (_, c: string) => (c === 'n' ? '\n' : '\\'))
        .trim();
      if (value === '') out.errors.push('empty notes — drop the token or add text');
      else if (value.length > TASK_NOTES_MAX)
        out.errors.push(
          `notes are ${value.length.toLocaleString('en-US')} characters — the limit is ${TASK_NOTES_MAX.toLocaleString('en-US')}`,
        );
      else out.notes = value;
    } else if (tok.startsWith('due:')) {
      if (!once('due', 'due')) continue;
      const rest = tok.slice(4);
      if (!isDayKey(rest)) out.errors.push(`invalid due date '${tok}' — use due:YYYY-MM-DD`);
      else out.dueDay = rest;
    } else {
      out.errors.push(
        `unrecognized token '${tok}' — expected ~<min>, #<label>, due:YYYY-MM-DD, or notes:"…"`,
      );
    }
  }

  return out;
}

export function parseBulkTasks(
  text: string,
  categories: readonly Pick<Category, 'id' | 'label'>[],
  existingTitles?: ReadonlySet<string>, // lowercased live task titles, for the "already exists" warning
): BulkParse {
  const rawLines = text.replace(/\r\n/g, '\n').split('\n');
  const lines: BulkLine[] = [];
  const seenTitles = new Set<string>();

  rawLines.forEach((raw, i) => {
    if (raw.trim() === '') return; // skip blank lines, but i+1 keeps the true line number
    const parsed = parseLine(raw, i + 1, categories);
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
): BulkLine {
  const out = parseLine(raw, 1, categories);
  if (raw.includes('\n'))
    out.errors.push('tokens need a single line — remove the line break (Bulk add takes many)');
  return out;
}

// The create input for one clean line. An unmatched #label leaves categoryId null (created
// uncategorised, by design).
export const toCreateInput = (l: BulkLine): CreateTaskInput => ({
  title: l.title,
  categoryId: l.categoryId,
  estimateMin: l.estimateMin,
  dueDay: l.dueDay,
  notes: l.notes,
});

// The create inputs for a clean parse. The caller checks `canSubmit` first.
export const toCreateInputs = (parse: BulkParse): CreateTaskInput[] =>
  parse.lines.map(toCreateInput);
