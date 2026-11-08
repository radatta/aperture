// Saved Flux sets (docs/areas/flux, D47–D54): the helpers the History tab, the night line, both ApiClient
// impls and the MCP tools share, so they label, validate and summarise a set the same way.

import { addDays, isDayKey, weekdayOf } from '../dates';
import { isUlid } from '../ulid';
import type { FluxSet, FluxSide, FluxWeekNote, FluxWeekNoteRow } from '../types';
import type { FluxSetFilter, RecordFluxSetInput } from '../api';
import { CONDITION_LABELS } from './catalog';
import { getExercise, isExerciseId, type ExerciseId } from './definitions';
import type { ExerciseDefinition } from './types';

// The three one-sided stretches. Side B mirrors the definition (yaw and roll negate).
export const hasSide = (def: ExerciseDefinition): boolean =>
  def.kind === 'holdAtTarget' && (def.target.yaw !== undefined || def.target.roll !== undefined);

// Sides are named by where the head mainly goes (D48): the larger of the target's yaw and roll, and
// +yaw / +roll = right (verified on the iPhone, 2026-10-29). Upper trap and levator Side A go right;
// scalene's Side A tilts left (roll −22) while turning a little right, so it's Left.
export function sideLabel(def: ExerciseDefinition, side: FluxSide): 'Right' | 'Left' {
  const { yaw = 0, roll = 0 } = def.kind === 'holdAtTarget' ? def.target : {};
  const aRight = (Math.abs(roll) >= Math.abs(yaw) ? roll : yaw) >= 0;
  return (side === 'a') === aRight ? 'Right' : 'Left';
}

// Bilateral ROM reps count +yaw / +roll (repsPos) as Right, the other way as Left (D48).
export const BILATERAL_LABELS = { positive: 'Right', negative: 'Left' } as const;

// Short names for one-line summaries (the night line, MCP).
export const SHORT_NAMES: Readonly<Record<ExerciseId, string>> = {
  'cervical-rotation': 'rotation',
  'cervical-lateral-flexion': 'side bend',
  'cervical-flexion': 'flexion',
  'cervical-extension': 'extension',
  'chin-tuck': 'chin tuck',
  'retraction-extension': 'retraction',
  'upper-trap-stretch': 'upper trap',
  'levator-scapulae-stretch': 'levator',
  'scalene-stretch': 'scalene',
  'eye-head-coordination': 'eye–head',
  'deep-neck-flexor': 'deep neck flexor',
  'isometric-flexion': 'isometric flexion',
  'isometric-extension': 'isometric extension',
  'isometric-lateral-flexion': 'isometric side bend',
  'isometric-rotation': 'isometric rotation',
  'scapular-retraction': 'scapular retraction',
  'median-nerve-glide': 'nerve glide',
  'joint-position-sense': 'joint position',
  'gaze-stability': 'gaze stability',
};

const finite = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n);
const optFinite = (n: unknown): boolean => n === undefined || n === null || finite(n);

// The one refusal text for a set the server won't store (stub and Lambda both throw it); null = valid.
export function fluxSetError(input: RecordFluxSetInput): string | null {
  if (typeof input.id !== 'string' || !isUlid(input.id)) return 'A Flux set needs a valid id.';
  if (typeof input.day !== 'string' || !isDayKey(input.day)) return 'A Flux set needs a valid day.';
  if (typeof input.exerciseId !== 'string' || !isExerciseId(input.exerciseId))
    return `Unknown Flux exercise "${String(input.exerciseId)}".`;
  const def = getExercise(input.exerciseId);
  if (input.kind !== def.kind)
    return `${def.name} is a ${def.kind} exercise, not ${String(input.kind)}.`;
  if (hasSide(def) ? input.side !== 'a' && input.side !== 'b' : input.side !== null)
    return hasSide(def) ? `${def.name} needs a side.` : `${def.name} has no side.`;
  if (input.condition !== null && !Object.hasOwn(CONDITION_LABELS, input.condition))
    return `Unknown condition "${String(input.condition)}".`;
  if (!Number.isInteger(input.count) || input.count < 0)
    return 'A Flux set count must be a whole number.';
  const rom = input.rom as unknown as Record<string, unknown> | null;
  if (
    !optFinite(input.avgPeakDeg) ||
    !optFinite(input.avgErrorDeg) ||
    !rom ||
    !finite(rom.pitch) ||
    !finite(rom.yaw) ||
    !finite(rom.roll) ||
    !finite(input.durationSec) ||
    input.durationSec < 0 ||
    !finite(input.completedAt)
  )
    return 'A Flux set has a measurement that is not a number.';
  if (typeof input.calibrated !== 'boolean')
    return 'A Flux set must say whether it was calibrated.';
  if (input.delegate !== null && input.delegate !== 'GPU' && input.delegate !== 'CPU')
    return `Unknown tracking delegate "${String(input.delegate)}".`;
  if (input.repTaskId !== null && (typeof input.repTaskId !== 'string' || !input.repTaskId))
    return 'A Flux set links to its Roll rep by task id.';
  if (typeof input.stoppedEarly !== 'boolean')
    return 'A Flux set must say whether it was stopped early.';
  if (input.planned !== null && (!Number.isInteger(input.planned) || input.planned < 1))
    return "A Flux set's planned count must be a positive whole number.";
  if ((input.planned === null) !== (def.kind === 'oscillation'))
    return def.kind === 'oscillation'
      ? `${def.name} is timed — it has no planned count.`
      : `${def.name} needs its planned count.`;
  if (input.stoppedEarly && input.count < 1)
    return "A set stopped before its first rep isn't saved.";
  return null;
}

// The sets stepper's range (D42), and the one refusal for a `fluxSets` settings patch (D61): a plain
// object of catalogue ids to whole numbers in that range; null = valid. Stub and Lambda both throw it.
export const FLUX_MIN_SETS = 1;
export const FLUX_MAX_SETS = 5;
export function fluxSetsError(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return 'Flux sets must be a map of exercise to count.';
  for (const [id, n] of Object.entries(value)) {
    if (!isExerciseId(id)) return `Unknown Flux exercise "${id}".`;
    if (!Number.isInteger(n) || (n as number) < FLUX_MIN_SETS || (n as number) > FLUX_MAX_SETS)
      return `Sets for ${getExercise(id).name} must be a whole number from ${FLUX_MIN_SETS} to ${FLUX_MAX_SETS}.`;
  }
  return null;
}

// The count a set goes for under its prescription (D56): both sides for a bilateral drill, none for a
// timed one. One home for the live readout's "/ 10", the draft's `planned` and so History's "2 of 10".
export function plannedCount(def: ExerciseDefinition): number | null {
  switch (def.kind) {
    case 'romReps':
      return def.direction === 'bilateral' ? def.reps * 2 : def.reps;
    case 'holdAtTarget':
    case 'guidedHold':
    case 'reposition':
      return def.reps;
    case 'oscillation':
      return null;
  }
}

// from/to both or neither (the LeetCode rule), each a day key.
export function fluxFilterError(filter: FluxSetFilter | undefined): string | null {
  if (!filter) return null;
  const { from, to } = filter;
  if ((from === undefined) !== (to === undefined)) return 'Give both from and to, or neither.';
  if (from !== undefined && (!isDayKey(from) || !isDayKey(to ?? '')))
    return 'from and to are days (YYYY-MM-DD).';
  return null;
}

// Alive sets in the filter, newest first — the one filter both impls apply.
export function inRange(sets: readonly FluxSet[], filter: FluxSetFilter = {}): FluxSet[] {
  const { from, to, exerciseId } = filter;
  return sets
    .filter(
      (s) =>
        s.deletedAt === null &&
        (from === undefined || (s.day >= from && s.day <= (to ?? from))) &&
        (exerciseId === undefined || s.exerciseId === exerciseId),
    )
    .sort((a, b) => b.completedAt - a.completedAt);
}

// The one number a set is judged by, per kind — what History's row and trend show.
export interface SetMetric {
  readonly label: string;
  readonly value: number;
  readonly unit: '°' | 'reps' | 'holds' | 'trials' | 'cycles';
  readonly target?: number;
  readonly betterWhen: 'higher' | 'lower';
}

export function setMetric(
  def: ExerciseDefinition,
  set: Pick<FluxSet, 'count' | 'avgPeakDeg' | 'avgErrorDeg'>,
): SetMetric | null {
  switch (def.kind) {
    case 'romReps':
      return set.avgPeakDeg === null
        ? null
        : {
            label: 'avg peak',
            value: set.avgPeakDeg,
            unit: '°',
            target: def.targetDeg,
            betterWhen: 'higher',
          };
    case 'holdAtTarget':
      return {
        label: 'holds',
        value: set.count,
        unit: 'holds',
        target: def.reps,
        betterWhen: 'higher',
      };
    case 'guidedHold':
      return {
        label: 'reps',
        value: set.count,
        unit: 'reps',
        target: def.reps,
        betterWhen: 'higher',
      };
    case 'reposition':
      return set.avgErrorDeg === null
        ? null
        : { label: 'avg error', value: set.avgErrorDeg, unit: '°', betterWhen: 'lower' };
    case 'oscillation':
      return { label: 'cycles', value: set.count, unit: 'cycles', betterWhen: 'higher' };
  }
}

// Sets grouped by day, newest day first, each day's sets newest first.
export function groupByDay(sets: readonly FluxSet[]): { day: string; sets: FluxSet[] }[] {
  const days = new Map<string, FluxSet[]>();
  for (const s of [...sets].sort((a, b) => b.completedAt - a.completedAt)) {
    const list = days.get(s.day);
    if (list) list.push(s);
    else days.set(s.day, [s]);
  }
  return [...days].map(([day, list]) => ({ day, sets: list }));
}

// "2 sets rotation, 1 upper trap" — per exercise, in the order first done; "" for none.
export function summarizeSets(
  sets: readonly Pick<FluxSet, 'exerciseId' | 'completedAt'>[],
): string {
  const counts = new Map<string, number>();
  for (const s of [...sets].sort((a, b) => a.completedAt - b.completedAt))
    counts.set(s.exerciseId, (counts.get(s.exerciseId) ?? 0) + 1);
  return [...counts]
    .map(([id, n], i) => {
      const name = isExerciseId(id) ? SHORT_NAMES[id] : id;
      return i === 0 ? `${n} ${n === 1 ? 'set' : 'sets'} ${name}` : `${n} ${name}`;
    })
    .join(', ');
}

// --- The weekly note (D62) ---------------------------------------------------------------------------

// Per exercise over a window: how many sets, and its number first → latest (oldest first). A stopped
// set's angle counts, as in History's trend; its count doesn't — one hold of six would read as a
// collapse (D55). How many were stopped early is counted beside it. The MCP's list_flux_sets `summary`
// is this shape, and the weekly note builds on it.
export interface FluxExerciseSummary {
  exerciseId: string;
  exercise: string;
  sets: number;
  stoppedEarly: number;
  metric?: string;
  unit?: string;
  first?: number;
  latest?: number;
  betterWhen?: SetMetric['betterWhen'];
  target?: number;
}

export function fluxExerciseSummary(sets: readonly FluxSet[]): FluxExerciseSummary[] {
  const byId = new Map<string, FluxSet[]>();
  for (const s of [...sets].sort((a, b) => a.completedAt - b.completedAt)) {
    const list = byId.get(s.exerciseId) ?? [];
    list.push(s);
    byId.set(s.exerciseId, list);
  }
  return [...byId].map(([id, list]) => {
    const def = isExerciseId(id) ? getExercise(id) : null;
    const stopped = list.filter((s) => s.stoppedEarly).length;
    const metrics = def
      ? list.flatMap((s) => {
          const m = setMetric(def, s);
          return m && (!s.stoppedEarly || m.unit === '°') ? [m] : [];
        })
      : [];
    const first = metrics[0];
    const latest = metrics.at(-1);
    return {
      exerciseId: id,
      exercise: def?.name ?? id,
      sets: list.length,
      stoppedEarly: stopped,
      ...(first && latest
        ? {
            metric: latest.label,
            unit: latest.unit,
            first: first.value,
            latest: latest.value,
            betterWhen: latest.betterWhen,
            ...(latest.target !== undefined ? { target: latest.target } : {}),
          }
        : {}),
    };
  });
}

// Weeks start on Monday (ISO), keyed by the user's day — so a late set before dayStartHour is Sunday's.
export const fluxWeekStart = (day: string): string => addDays(day, -((weekdayOf(day) + 6) % 7));

export interface FluxWeekExercise extends FluxExerciseSummary {
  sides: { right: number; left: number } | null; // the three one-sided stretches
  lastWeek: { sets: number; latest?: number } | null; // null: not done last week
}

export interface FluxWeekSummary {
  weekStart: string; // Monday
  weekEnd: string; // Sunday
  totalSets: number;
  lastWeekSets: number;
  exercises: FluxWeekExercise[]; // most sets first, then as first done
}

// The sets of the week starting `weekStart`, by the set's own day — the one filter the summary, the
// fingerprint and both servers use.
export const fluxWeekSets = <S extends Pick<FluxSet, 'day'>>(
  sets: readonly S[],
  weekStart: string,
): S[] => sets.filter((s) => s.day >= weekStart && s.day <= addDays(weekStart, 6));

// This week against last, from alive sets (the caller filters deleted ones).
export function fluxWeekSummary(sets: readonly FluxSet[], weekStart: string): FluxWeekSummary {
  const week = fluxWeekSets(sets, weekStart);
  const prev = fluxWeekSets(sets, addDays(weekStart, -7));
  const last = new Map(fluxExerciseSummary(prev).map((e) => [e.exerciseId, e]));
  const exercises = fluxExerciseSummary(week)
    .map((e): FluxWeekExercise => {
      const def = isExerciseId(e.exerciseId) ? getExercise(e.exerciseId) : null;
      const sided = def && hasSide(def);
      const mine = week.filter((s) => s.exerciseId === e.exerciseId);
      const before = last.get(e.exerciseId);
      return {
        ...e,
        sides: sided
          ? {
              right: mine.filter((s) => s.side && sideLabel(def, s.side) === 'Right').length,
              left: mine.filter((s) => s.side && sideLabel(def, s.side) === 'Left').length,
            }
          : null,
        lastWeek: before
          ? { sets: before.sets, ...(before.latest !== undefined ? { latest: before.latest } : {}) }
          : null,
      };
    })
    .sort((a, b) => b.sets - a.sets);
  return {
    weekStart,
    weekEnd: addDays(weekStart, 6),
    totalSets: week.length,
    lastWeekSets: prev.length,
    exercises,
  };
}

export const FLUX_NOTE_MAX = 140;

// The line the note is made from, and the note itself when the model can't be asked: descriptive only,
// no judgement — counts, the angle first → latest, last week beside it. Always under FLUX_NOTE_MAX.
export function fluxWeekLine(s: FluxWeekSummary): string {
  const parts = s.exercises.map((e, i) => {
    const name = isExerciseId(e.exerciseId) ? SHORT_NAMES[e.exerciseId] : e.exerciseId;
    const n = i === 0 ? `${e.sets} ${e.sets === 1 ? 'set' : 'sets'} ${name}` : `${e.sets} ${name}`;
    const angle =
      e.unit === '°' && e.first !== undefined && e.latest !== undefined && e.sets > 1
        ? ` ${Math.round(e.first)}° → ${Math.round(e.latest)}°`
        : '';
    return n + angle;
  });
  const tail = s.lastWeekSets ? `last week ${s.lastWeekSets}` : 'first week';
  return clip(`This week: ${parts.join(', ')} · ${tail}`, FLUX_NOTE_MAX);
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 24))}…`;
}

// The cache key of a stored note: the identity of this week's alive sets — a save, a delete, or an
// offline set landing later with an earlier time all change it, so a note is rebuilt (one model call)
// only when the week's sets change. The ids are hashed so the row stays small.
export const fluxNoteFingerprint = (weekSets: readonly Pick<FluxSet, 'id'>[]): string => {
  const ids = weekSets
    .map((s) => s.id)
    .sort()
    .join(',');
  let h = 5381; // djb2 — a stable, dependency-free digest; a collision would only delay a rebuild
  for (let i = 0; i < ids.length; i++) h = ((h * 33) ^ ids.charCodeAt(i)) >>> 0;
  return `${weekSets.length}:${h.toString(16)}`;
};

export const FLUX_NOTE_MIN_SETS = 2;

// What the model is shown (fluxNotePrompt): the summary without its dates, targets or directions — only
// what a descriptive line may repeat, each exercise by the short name History uses. The names carry each
// number's scope: `angle` is over every set (a stopped set's angle counts), `finishedCount` over finished
// sets only (D55).
export interface FluxNoteData {
  totalSets: number;
  lastWeekSets: number;
  exercises: {
    name: string;
    sets: number;
    finishedSets: number;
    stoppedEarly: number;
    angle?: { first: number; latest: number };
    finishedCount?: { first: number; latest: number; unit: string };
    sides: FluxWeekExercise['sides'];
    lastWeek: {
      sets: number;
      angle?: { latest: number };
      finishedCount?: { latest: number };
    } | null;
  }[];
}

export function fluxNoteData(s: FluxWeekSummary): FluxNoteData {
  return {
    totalSets: s.totalSets,
    lastWeekSets: s.lastWeekSets,
    exercises: s.exercises.map((e) => {
      // By the exercise's kind, not this week's unit: a week whose sets carry no angle still sends last
      // week's angle as an angle.
      const def = isExerciseId(e.exerciseId) ? getExercise(e.exerciseId) : null;
      const angled = def ? def.kind === 'romReps' || def.kind === 'reposition' : e.unit === '°';
      const key = angled ? 'angle' : 'finishedCount';
      const pair =
        e.first !== undefined && e.latest !== undefined
          ? key === 'angle'
            ? { angle: { first: Math.round(e.first), latest: Math.round(e.latest) } }
            : {
                finishedCount: {
                  first: Math.round(e.first),
                  latest: Math.round(e.latest),
                  unit: e.unit ?? '',
                },
              }
          : {};
      const lastLatest =
        e.lastWeek?.latest !== undefined
          ? { [key]: { latest: Math.round(e.lastWeek.latest) } }
          : {};
      return {
        name: isExerciseId(e.exerciseId) ? SHORT_NAMES[e.exerciseId] : e.exerciseId,
        sets: e.sets,
        finishedSets: e.sets - e.stoppedEarly,
        stoppedEarly: e.stoppedEarly,
        ...pair,
        sides: e.sides,
        lastWeek: e.lastWeek ? { sets: e.lastWeek.sets, ...lastLatest } : null,
      };
    }),
  };
}

// A note the server may hand back: a trimmed, non-empty line within the cap that names at least one of
// the week's exercises and carries no number the data lacks (the model is asked to describe, never to
// invent — a number from nowhere is the one slip that reads as a score). Anything else → the line.
//
// And in a week with a set stopped early, no count claim at all (CLAIMS_A_COUNT): a stopped set ended
// short of its count, so "6 holds" can't be read across sets — on dev Haiku wrote "2 chin tuck sets with
// 6 holds each" over a tuck stopped at 2 (D62), a slip the number check can't see. The prompt asks it to
// leave the count out then; "sets with 1 stopped early" and angles ("sets at 44°") still pass. Run on the
// folded text (lowercased, dashes as spaces).
const NUM = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)';
const CLAIMS_A_COUNT = new RegExp(
  `\\b${NUM}\\s+(reps?|holds?|trials?|cycles?)\\b` + // "6 holds", "six holds each"
    `|\\bsets?\\s+(of|at|with|reaching|reached|hitting|hit)\\s+${NUM}\\b(?!\\s*(°|degrees?|stopped|finished|ended|of them))` + // "sets of 6"
    `|\\b\\d+\\s*[x×]\\s*\\d`, // "6 × 2"
);

export function fluxNoteText(note: unknown, line: string, s: FluxWeekSummary): string | null {
  if (typeof note !== 'string') return null;
  const text = note.trim().replace(/\s+/g, ' ');
  if (!text || text.length > FLUX_NOTE_MAX) return null;
  const data = fluxNoteData(s);
  // Names compare with dashes and spacing folded: "chin-tuck", "eye-head" and "eye–head" are one name.
  const fold = (t: string) => t.toLowerCase().replace(/[\s\-–—]+/g, ' ');
  const folded = fold(text);
  if (!data.exercises.some((e) => folded.includes(fold(e.name)))) return null;
  const allowed = new Set<string>();
  const add = (n: number | undefined) => {
    if (n !== undefined) allowed.add(String(Math.abs(n)));
  };
  add(data.totalSets);
  add(data.lastWeekSets);
  add(data.totalSets - data.lastWeekSets); // a difference the model may state is a number it was given
  for (const e of data.exercises) {
    add(e.sets);
    add(e.finishedSets);
    add(e.stoppedEarly);
    for (const pair of [e.angle, e.finishedCount]) {
      if (!pair) continue;
      add(pair.first);
      add(pair.latest);
      add(pair.latest - pair.first);
    }
    add(e.sides?.right);
    add(e.sides?.left);
    add(e.lastWeek?.sets);
    if (e.lastWeek) add(e.sets - e.lastWeek.sets);
    const thisLatest = e.angle?.latest ?? e.finishedCount?.latest;
    const lastLatest = e.lastWeek?.angle?.latest ?? e.lastWeek?.finishedCount?.latest;
    add(lastLatest);
    if (thisLatest !== undefined && lastLatest !== undefined) add(thisLatest - lastLatest);
  }
  for (const n of line.match(/\d+/g) ?? []) allowed.add(n);
  for (const n of text.match(/\d+/g) ?? []) if (!allowed.has(n)) return null;
  if (data.exercises.some((e) => e.stoppedEarly > 0) && CLAIMS_A_COUNT.test(folded)) return null;
  return text;
}

// The row minus its cache key — what the API hands back.
export const fluxNoteOf = ({ weekStart, text, generatedAt }: FluxWeekNoteRow): FluxWeekNote => ({
  weekStart,
  text,
  generatedAt,
});
