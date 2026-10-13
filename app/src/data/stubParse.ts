import {
  addDays,
  PARSE_TITLE_MAX,
  weekdayOf,
  type ParsedTaskFields,
  type ParseCategory,
} from '@aperture/shared';

// The stub's stand-in for Haiku: a small deterministic parser covering the shapes the Raycast README
// teaches (`aperture, fix x due fri 4pm 30m`), so quick add works offline and in tests. It only has to
// be plausible — the real parse is the Lambda's prompt — and it feeds the same validateParsedTask.

// Dev/test hook: set this localStorage key (any value) and the stub's next parseTask fails, once — to see
// the "saved unparsed" path without a Lambda.
export const STUB_FAIL_NEXT_PARSE_KEY = 'aperture:stub:failNextParse';
export function takeStubParseFailure(): boolean {
  try {
    const hit = globalThis.localStorage?.getItem(STUB_FAIL_NEXT_PARSE_KEY) != null;
    if (hit) globalThis.localStorage?.removeItem(STUB_FAIL_NEXT_PARSE_KEY);
    return hit;
  } catch {
    return false;
  }
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY = String.raw`today|tonight|tmw|tmrw|tomorrow|(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*`;
const CLOCK = String.raw`(\d{1,2})(?::(\d{2}))?\s*(am|pm)|([01]?\d|2[0-3]):([0-5]\d)`;

function dayFor(word: string, today: string): string | null {
  const w = word.toLowerCase();
  if (w === 'today' || w === 'tonight') return today;
  if (w.startsWith('tm') || w === 'tomorrow') return addDays(today, 1);
  const i = WEEKDAYS.indexOf(w.slice(0, 3));
  if (i < 0) return null;
  // The next such day, never today: "fri" on a Friday means next week's.
  return addDays(today, ((i - weekdayOf(today) + 6) % 7) + 1);
}

function clockFor(m: RegExpMatchArray, at: number): string {
  if (m[at + 3] !== undefined) return `${m[at + 3]!.padStart(2, '0')}:${m[at + 4]}`;
  const h = (Number(m[at]) % 12) + (m[at + 2]!.toLowerCase() === 'pm' ? 12 : 0);
  return `${String(h).padStart(2, '0')}:${m[at + 1] ?? '00'}`;
}

export function heuristicParse(
  line: string,
  categories: readonly ParseCategory[],
  today: string,
): ParsedTaskFields {
  let rest = line;
  let categoryId: string | null = null;
  const lead = categories.find((c) => rest.toLowerCase().startsWith(`${c.label.toLowerCase()},`));
  if (lead) {
    categoryId = lead.id;
    rest = rest.slice(lead.label.length + 1);
  }

  let dueDay: string | null = null;
  let dueTime: string | null = null;
  const due = rest.match(
    new RegExp(String.raw`\b(?:due|by)\s+(${DAY})(?:\s+(?:at\s+)?(?:${CLOCK}))?\b`, 'i'),
  );
  if (due) {
    dueDay = dayFor(due[1]!, today);
    if (due[2] !== undefined || due[5] !== undefined) dueTime = clockFor(due, 2);
    rest = rest.replace(due[0], ' ');
  } else {
    const clock = rest.match(new RegExp(String.raw`\b(?:at\s+)?(?:${CLOCK})\b`, 'i'));
    if (clock && (clock[3] !== undefined || clock[4] !== undefined)) {
      dueTime = clockFor(clock, 1);
      rest = rest.replace(clock[0], ' ');
    }
  }

  let estimateMin: number | null = null;
  const est = rest.match(/\b(\d+)\s*(m|mins?|h|hrs?)\b/i);
  if (est) {
    estimateMin = Number(est[1]) * (est[2]!.toLowerCase().startsWith('h') ? 60 : 1);
    rest = rest.replace(est[0], ' ');
  }

  const text = rest.replace(/\s+/g, ' ').replace(/^[\s,;:.-]+|[\s,;:-]+$/g, '');
  let title = text;
  let notes: string | null = null;
  if (text.length > PARSE_TITLE_MAX) {
    const cut = text.lastIndexOf(' ', PARSE_TITLE_MAX);
    const at = cut > 0 ? cut : PARSE_TITLE_MAX;
    title = text.slice(0, at).replace(/[\s,;:.-]+$/, '');
    notes = text.slice(at).trim() || null;
  }
  return { title, notes, categoryId, dueDay, dueTime, estimateMin };
}
