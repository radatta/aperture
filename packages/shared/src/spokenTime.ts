// Voice capture's clock (capture.md → Time rules). A spoken line's time comes from here, never from the
// model: the model only says which day was named, this module finds the time in the words and resolves it
// against the server clock. The rules (the maintainer, 2026-11-16):
//   - a bare "at N" / "N o'clock" is the next N o'clock, wrapping (2am + "at 5" → 5am; 6am → 5pm);
//   - a time already past rolls forward to its next occurrence (3pm + "at 9am" → tomorrow 9am);
//   - "morning" is 9 AM, "tonight" is 8 PM;
//   - "in N minutes/hours" is now + N, from the server clock.
// Typed quick add shares the roll and the stated clock (quickParse.ts, the maintainer 2026-11-17); the bare
// hour, the day-parts and the delay stay voice-only.

import { addDays, USER_TIME_ZONE, zonedDayTime, zonedEpoch } from './dates';

export type DayPart = 'morning' | 'tonight';
// `said` is the words that matched, as written — the caller checks the model took them out of the title
// (if the model kept "at one" in "look at one of the leases", it wasn't a time).
export type SpokenTime = { said: string } & (
  | { kind: 'relative'; minutes: number }
  | { kind: 'clock'; hhmm: string } // stated outright: "9am", "5:30 pm", "17:00", "noon", "midnight"
  | { kind: 'bare'; hour: number; minute: number; part: DayPart | null } // "at 5", "five o'clock", "at 8 tonight"
  | { kind: 'part'; part: DayPart } // "tonight", "tomorrow morning"
);

export const DAY_PART_TIME: Record<DayPart, string> = { morning: '09:00', tonight: '20:00' };

const WORD_NUM: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  'forty-five': 45,
  'forty five': 45,
  fifty: 50,
  ninety: 90,
};
const HOUR_WORD = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';
const AMOUNT_WORD = `${HOUR_WORD}|fifteen|twenty|thirty|forty[- ]five|forty|fifty|ninety`;
const num = (s: string): number => WORD_NUM[s.toLowerCase()] ?? Number(s);

// "in 20 minutes", "in an hour", "in half an hour", "in 1.5 hours", "in an hour and a half", "in five mins".
const RELATIVE = new RegExp(
  `\\bin\\s+(?:(half\\s+an?)|(an?|\\d+(?:\\.\\d+)?|${AMOUNT_WORD}))\\s*(minutes?|mins?|hours?|hrs?)(\\s+and\\s+a\\s+half)?\\b`,
  'i',
);
// A spoken minute after an hour word: "five thirty", "at 8 fifteen".
const MINUTE_WORD = `\\s+(fifteen|thirty|forty[- ]five)`;
// Stated outright: am/pm (Siri writes "5 PM" or "5 p.m."), a 24-hour clock, noon, midnight.
const AMPM = new RegExp(
  `\\b(\\d{1,2}|${HOUR_WORD})(?::(\\d{2})|${MINUTE_WORD})?\\s*(a\\.?m\\.?|p\\.?m\\.?)(?=\\s|$|[,.;!?])`,
  'i',
);
// "half past five pm", "quarter past 9 am", "quarter to six pm": the am/pm belongs to the hour named — read
// alone, "five pm" would be 17:00, half an hour early (F208, 2026-11-17).
const PAST_TO = new RegExp(
  `\\b(half\\s+past|quarter\\s+past|quarter\\s+to)\\s+(\\d{1,2}|${HOUR_WORD})\\s*(a\\.?m\\.?|p\\.?m\\.?)(?=\\s|$|[,.;!?])`,
  'i',
);
const H24 = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;
const NOON = /\bnoon\b/i;
const MIDNIGHT = /\bmidnight\b/i;
// A bare hour: "at 5", "at 5:30", "at five", "at five thirty", "5 o'clock", "five o'clock". "at 5 o'clock" is
// said whole, so the title loses all of it (titleWords.ts), not "at 5" alone.
const AT_HOUR = new RegExp(
  `\\bat\\s+(\\d{1,2}|${HOUR_WORD})(?::([0-5]\\d)|${MINUTE_WORD})?(?:\\s*o['’]?\\s?clock\\b)?(?=\\s|$|[,.;!?])`,
  'i',
);
const OCLOCK = new RegExp(`\\b(\\d{1,2}|${HOUR_WORD})\\s*o['’]?\\s?clock\\b`, 'i');
const MORNING = /\bmorning\b/i;
const MORE_NUMBER =
  /^\s+(\d|(oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|sixteen|seventeen|eighteen|nineteen|twenty|forty|fifty)\b)/i;
// A day the words name. Without one, a model day of calendar tomorrow isn't trusted for a bare hour
// (resolveSpoken): a model that ignored the voice rules and dated "at 5" tomorrow mustn't turn it daytime.
export const DAY_WORD =
  /\b(tomorrow|tmrw?|tmw|today|days?|mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday|weekend|week|month|jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december|\d{1,2}(st|nd|rd|th)|\d{1,2}\/\d{1,2})\b/i;
const TONIGHT = /\btonight\b/i;

const pad2 = (n: number) => String(n).padStart(2, '0');

// The first spoken time in the line, by precedence: relative → stated clock → bare hour → day-part. Null
// when the line has none.
export function spokenTimeIn(line: string): SpokenTime | null {
  const rel = RELATIVE.exec(line);
  if (rel) {
    const amount = rel[1] ? 0.5 : /^an?$/i.test(rel[2]!) ? 1 : num(rel[2]!);
    const hours = /^h/i.test(rel[3]!);
    const extra = rel[4] ? 0.5 : 0;
    const minutes = Math.round(hours ? (amount + extra) * 60 : amount + extra);
    if (minutes > 0 && minutes <= 7 * 24 * 60) return { said: rel[0], kind: 'relative', minutes };
  }
  const partMatch = TONIGHT.exec(line) ?? MORNING.exec(line);
  const part: DayPart | null = partMatch
    ? /^t/i.test(partMatch[0])
      ? 'tonight'
      : 'morning'
    : null;
  // A minute given as digits ("5:30") or as a word ("five thirty").
  const minuteOf = (digits: string | undefined, word: string | undefined) =>
    digits ? Number(digits) : word ? num(word.replace(' ', '-')) : 0;
  const pastTo = PAST_TO.exec(line);
  if (pastTo) {
    const h = num(pastTo[2]!);
    if (h >= 1 && h <= 12) {
      const pm = /^p/i.test(pastTo[3]!);
      const by = /^half/i.test(pastTo[1]!) ? 30 : /past$/i.test(pastTo[1]!) ? 15 : -15;
      const min = (((((h % 12) + (pm ? 12 : 0)) * 60 + by) % 1440) + 1440) % 1440;
      return {
        said: pastTo[0],
        kind: 'clock',
        hhmm: `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`,
      };
    }
  }
  const ampm = AMPM.exec(line);
  if (ampm) {
    const h = num(ampm[1]!);
    const m = minuteOf(ampm[2], ampm[3]);
    if (h >= 1 && h <= 12 && m < 60) {
      const pm = /^p/i.test(ampm[4]!);
      return { said: ampm[0], kind: 'clock', hhmm: `${pad2((h % 12) + (pm ? 12 : 0))}:${pad2(m)}` };
    }
  }
  const noon = NOON.exec(line);
  if (noon) return { said: noon[0], kind: 'clock', hhmm: '12:00' };
  const midnight = MIDNIGHT.exec(line);
  if (midnight) return { said: midnight[0], kind: 'clock', hhmm: '00:00' };
  // "17:00" or "09:30" is a 24-hour clock; "5:30" (no leading zero, under 13) is a bare hour.
  const h24 = H24.exec(line);
  if (h24 && (Number(h24[1]) >= 13 || h24[1]!.startsWith('0')))
    return { said: h24[0], kind: 'clock', hhmm: `${pad2(Number(h24[1]))}:${h24[2]}` };
  const at = AT_HOUR.exec(line);
  const oclock = at ? null : OCLOCK.exec(line);
  const bare = at
    ? { said: at[0], hour: num(at[1]!), minute: minuteOf(at[2], at[3]) }
    : oclock
      ? { said: oclock[0], hour: num(oclock[1]!), minute: 0 }
      : h24
        ? { said: h24[0], hour: Number(h24[1]), minute: Number(h24[2]) }
        : null;
  // "at five twenty pm", "at 5 20": a minute the grammar doesn't read follows the hour — not a time it
  // can resolve, so none (the model's own clock takes over, quickParse.ts).
  // No minute follows "o'clock": "at five o'clock one more time" is 5:00.
  if (at && !/clock$/i.test(at[0]) && MORE_NUMBER.test(line.slice(at.index + at[0].length)))
    return null;
  if (bare && bare.hour >= 1 && bare.hour <= 12 && bare.minute < 60)
    return { kind: 'bare', ...bare, part };
  return partMatch && part ? { said: partMatch[0], kind: 'part', part } : null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A stated clock phrased as a due — "at 1 am", "by 5pm", "due at noon": the model's title with that phrase taken
// out, else null. Phrased so, it's the due time even when the model kept it in its title (quick-add.md
// 2026-11-17); "watch 9pm show" or "the 3pm meeting" kept theirs, and weren't.
export function dueClock(line: string, title: string, said: string): { title: string } | null {
  // Spelled any way: "5pm", "5 PM", "5 p.m." are one clock (Siri writes the last, a model the first).
  const words = said
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s*([ap])m$/, ' $1m')
    .trim();
  const clock = escapeRe(words)
    .replace(/\s+/g, '\\s*')
    .replace(/([ap])m$/, '$1\\.?\\s*m');
  const re = new RegExp(`\\b(?:due\\s+)?(?:at|by)\\s+${clock}\\.?(?=\\s|$|[,;:!?])`, 'i');
  const at = re.exec(line);
  if (!at) return null;
  // A second stated clock ("move standup at 3pm to 5pm") makes the at/by one no surer than the other: a kept
  // title then gets no time from it — typed keeps a model time, spoken gets none.
  if (spokenTimeIn(line.slice(0, at.index) + line.slice(at.index + at[0].length))?.kind === 'clock')
    return null;
  // The model already took the phrase out: its title stands as written.
  const m = re.exec(title);
  if (!m) return { title };
  // Only the join is tidied: ".env cleanup at 5pm" keeps its dot, "At noon, call mum" loses the comma.
  // A dash set off by a space only separated the clock ("fix login - by 5pm"); "--force" is a word.
  const head = title
    .slice(0, m.index)
    .replace(/\s+[-–—]+\s*$/, '')
    .replace(/[\s,;:]+$/, '');
  const tail = title.slice(m.index + m[0].length).trimStart();
  const rest = !head
    ? tail.replace(/^([,;:]+|[-–—]+\s)\s*/, '')
    : !tail
      ? head
      : /^[,;:!?.]/.test(tail)
        ? head + tail
        : `${head} ${tail}`;
  return { title: rest || title };
}

// The line with any "in N minutes/hours" phrase taken out — so the estimate guard doesn't read a
// reminder's delay ("call mum in 20 minutes") as how long the task takes.
export const withoutRelative = (line: string): string =>
  line.replace(new RegExp(RELATIVE.source, 'gi'), ' ').replace(/\s+/g, ' ').trim();

export interface SpokenContext {
  now: number;
  today: string; // the app's today (dayStartHour); never after the calendar's, so the rule reads the latter
  // The line has a day word (DAY_WORD). Without one, a model day of calendar tomorrow isn't trusted for a
  // bare hour: it's the model moving the time on its own ("at 5" at 6 PM → tomorrow 17:00). Any other day,
  // and any day for a stated clock or a day-part, is: "in 2 days" or "Christmas Eve" name days no list of
  // words covers, and a stated clock reads the same whichever day it lands on.
  dayInWords?: boolean;
  timeZone?: string;
}

// A spoken time → the task's due day + time, as calendar dates in the user's zone.
// `modelDay` is the day the model read in the line (null: none). A day counts as named only when it is after
// the calendar's today — "today at 9am" said at 3pm still rolls to tomorrow, and a past day rolls too.
//   - relative: now + N, rounded up to the minute; any named day is ignored.
//   - named day: that day; a bare hour reads as the daytime one (07:00–18:59), "at 5" = 5 PM.
//   - no day: the next occurrence after now — a bare hour tries AM then PM today, then tomorrow.
export function resolveSpoken(
  spoken: SpokenTime,
  modelDay: string | null,
  ctx: SpokenContext,
): { day: string; time: string } {
  const zone = ctx.timeZone ?? USER_TIME_ZONE;
  const at = (day: string, hhmm: string) => zonedEpoch(day, hhmm, zone);
  if (spoken.kind === 'relative') {
    const ms = Math.ceil((ctx.now + spoken.minutes * 60_000) / 60_000) * 60_000;
    const r = zonedDayTime(ms, zone);
    return { day: r.day, time: r.hhmm };
  }
  const calToday = zonedDayTime(ctx.now, zone).day;
  // A past day (the model reading "monday" as last Monday) isn't named either: it rolls forward.
  const bareHour = spoken.kind === 'bare' && spoken.part === null;
  const named =
    modelDay !== null &&
    modelDay > calToday &&
    (ctx.dayInWords !== false || !bareHour || modelDay !== addDays(calToday, 1));
  const hhmmOf = (h24: number, m: number) => `${pad2(h24)}:${pad2(m)}`;
  // "at 12 tonight" is midnight and "at 1 tonight" the small hours; 4–11 tonight is the evening.
  const tonightHour = (h: number) => (h === 12 ? 0 : h <= 3 ? h : h + 12);
  // Every clock the words could mean, in order of preference on a given day.
  const clocks: string[] =
    spoken.kind === 'clock'
      ? [spoken.hhmm]
      : spoken.kind === 'part'
        ? [DAY_PART_TIME[spoken.part]]
        : spoken.part === 'tonight'
          ? [hhmmOf(tonightHour(spoken.hour), spoken.minute)]
          : spoken.part === 'morning'
            ? [hhmmOf(spoken.hour % 12, spoken.minute)]
            : named
              ? [
                  hhmmOf(
                    spoken.hour < 7 ? spoken.hour + 12 : spoken.hour === 12 ? 12 : spoken.hour,
                    spoken.minute,
                  ),
                ]
              : [
                  hhmmOf(spoken.hour % 12, spoken.minute),
                  hhmmOf((spoken.hour % 12) + 12, spoken.minute),
                ];
  if (named) {
    // "friday at 1 tonight" is the small hours after Friday.
    const late = spoken.kind === 'bare' && spoken.part === 'tonight' && spoken.hour % 12 <= 3;
    return { day: late ? addDays(modelDay, 1) : modelDay, time: clocks[0]! };
  }
  for (const day of [calToday, addDays(calToday, 1)])
    for (const time of clocks) if (at(day, time) > ctx.now) return { day, time };
  return { day: addDays(calToday, 1), time: clocks[0]! }; // unreachable: tomorrow is always ahead
}
