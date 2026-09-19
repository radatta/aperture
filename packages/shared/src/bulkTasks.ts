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
//
// errors[] are RED (blocking — gate submit); warnings[] are YELLOW (non-blocking — the task is still
// created). A token that declares intent but can't be parsed is red; one that parses but doesn't match
// (an unknown #label) is yellow. Titles are NEVER rewritten — a list marker or stray '|' is an error.

import { isDayKey } from './dates';
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

// Split the token region into raw token strings, keeping a #"quoted label" (which contains spaces)
// whole. A '#"' with no closing quote runs to the end of the region and is flagged at classify time.
function scanTokens(region: string): string[] {
  const out: string[] = [];
  const n = region.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(region[i]!)) i++;
    if (i >= n) break;
    const start = i;
    if (region[i] === '#' && region[i + 1] === '"') {
      i += 2;
      while (i < n && region[i] !== '"') i++;
      if (i < n) i++; // consume the closing quote
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

  const seen = new Set<'estimate' | 'category' | 'due'>();
  const once = (kind: 'estimate' | 'category' | 'due', label: string): boolean => {
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
        else label = tok.slice(2, -1);
      } else {
        label = tok.slice(1);
        if (label === '') out.errors.push("empty category label — use #Label or #\"Two Words\"");
      }
      if (label !== null && label !== '') {
        out.categoryLabel = label;
        const m = matchCategory(label, categories);
        if (m.ambiguous) out.errors.push(`ambiguous category '${label}' — it matches more than one`);
        else if (m.unknown) out.warnings.push(`no category '${label}' — created without one`);
        else out.categoryId = m.id;
      }
    } else if (tok.startsWith('due:')) {
      if (!once('due', 'due')) continue;
      const rest = tok.slice(4);
      if (!isDayKey(rest)) out.errors.push(`invalid due date '${tok}' — use due:YYYY-MM-DD`);
      else out.dueDay = rest;
    } else {
      out.errors.push(`unrecognized token '${tok}' — expected ~<min>, #<label>, or due:YYYY-MM-DD`);
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

// The create inputs for a clean parse. The caller checks `canSubmit` first; an unmatched #label leaves
// categoryId null (created uncategorised, by design).
export function toCreateInputs(parse: BulkParse): CreateTaskInput[] {
  return parse.lines.map((l) => ({
    title: l.title,
    categoryId: l.categoryId,
    estimateMin: l.estimateMin,
    dueDay: l.dueDay,
  }));
}
