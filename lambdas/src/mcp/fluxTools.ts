import { isDayKey } from '@aperture/shared';
import type { FluxSet, FluxSetFilter } from '@aperture/shared';
import {
  EXERCISES,
  getExercise,
  hasSide,
  isExerciseId,
  setMetric,
  sideLabel,
  summarizeSets,
  type ExerciseDefinition,
} from '@aperture/shared/flux';
import { RpcParamError } from './types';
import type { Tool } from './types';

// Read-only Flux tools (docs/areas/mcp → Tools, docs/areas/flux D52): the saved sets and the exercise
// catalog, with every label resolved here (exercise name, Right/Left, the per-kind number) so the model
// never re-derives what the History tab shows. Nothing writable — a misheard sentence can't delete a set.

const HONESTY =
  "Angles are relative to each session's own calibrated neutral, from a webcam — a trend to watch, not clinical measurements. Guided exercises are counts only.";

const iso = (ms: number) => new Date(ms).toISOString();

function setRow(s: FluxSet) {
  const def = isExerciseId(s.exerciseId) ? getExercise(s.exerciseId) : null;
  const metric = def ? setMetric(def, s) : null;
  return {
    id: s.id,
    day: s.day,
    completedAt: iso(s.completedAt),
    exerciseId: s.exerciseId,
    exercise: def?.name ?? s.exerciseId,
    measurement: def?.measurement ?? null,
    side: def && s.side ? (sideLabel(def, s.side) === 'Right' ? 'right' : 'left') : null,
    count: s.count,
    metric, // the one number History judges this set by
    rom: s.rom, // range since the neutral, degrees
    calibrated: s.calibrated,
    durationSec: s.durationSec,
    countedTowardRollRep: s.repTaskId !== null,
    stoppedEarly: s.stoppedEarly, // ended before its prescription; `count` is what was done
    planned: s.planned, // the count it was going for (null for a timed set)
  };
}

// Per exercise: how many sets, and its number first → latest in the window (oldest first). A stopped
// set's angle counts, as in History's trend; its count doesn't — one hold of six would read as a
// collapse (D55). How many were stopped early is counted beside it.
function summary(sets: readonly FluxSet[]) {
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

function exercise(def: ExerciseDefinition) {
  const prescription =
    def.kind === 'romReps'
      ? {
          axis: def.axis,
          direction: def.direction,
          targetDeg: def.targetDeg,
          reps: def.reps,
          holdSec: def.holdSec ?? 0,
        }
      : def.kind === 'holdAtTarget'
        ? { holdSec: def.holdSec, reps: def.reps }
        : def.kind === 'guidedHold'
          ? { holdSec: def.holdSec, reps: def.reps, restSec: def.restSec }
          : def.kind === 'reposition'
            ? { trials: def.reps }
            : { durationSec: def.durationSec };
  return {
    id: def.id,
    name: def.name,
    kind: def.kind,
    measurement: def.measurement,
    sided: hasSide(def),
    ...(hasSide(def)
      ? { sides: { a: sideLabel(def, 'a').toLowerCase(), b: sideLabel(def, 'b').toLowerCase() } }
      : {}),
    prescription,
    conditions: def.conditions,
    stages: def.stages,
    endRange: def.provocative === true,
  };
}

export const FLUX_TOOLS: Tool[] = [
  {
    name: 'list_flux_sets',
    description: [
      'Saved Flux neck-rehab sets (webcam-tracked exercises), newest first — "how\'s my neck rehab going?". Each row has the exercise, side (right/left for the three one-sided stretches), count, and its one number (`metric`: avg peak degrees for ROM reps, holds done, avg error degrees for joint position — lower is better). A set stopped before its prescription has `stoppedEarly: true`; `planned` is the count it was going for.',
      "`summary` gives per-exercise first → latest over the window (a stopped set's count is left out of it, its angle isn't; `stoppedEarly` counts them), and `daySummary` a one-line summary when the window is a single day (from = to).",
      'Optional from/to ISO dates (pass BOTH or NEITHER) and exerciseId (see list_flux_exercises).',
      HONESTY,
      'Read-only: sets are recorded by the app; nothing here edits or deletes.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        to: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        exerciseId: { type: 'string' },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const { from, to, exerciseId } = args;
      if ((from === undefined) !== (to === undefined))
        throw new RpcParamError('pass both "from" and "to", or neither');
      for (const [k, v] of [
        ['from', from],
        ['to', to],
      ] as const)
        if (v !== undefined && (typeof v !== 'string' || !isDayKey(v)))
          throw new RpcParamError(`"${k}" must be an ISO date (YYYY-MM-DD)`);
      if (exerciseId !== undefined && (typeof exerciseId !== 'string' || !isExerciseId(exerciseId)))
        throw new RpcParamError(`Unknown exerciseId — list_flux_exercises gives the ids`);
      const filter: FluxSetFilter = {
        ...(from !== undefined ? { from: from as string, to: to as string } : {}),
        ...(exerciseId !== undefined ? { exerciseId: exerciseId as string } : {}),
      };
      const sets = (await ctx.dispatch('listFluxSets', [filter])) as FluxSet[];
      return {
        sets: sets.map(setRow),
        summary: summary(sets),
        ...(from !== undefined && from === to
          ? { daySummary: summarizeSets(sets) || 'No sets.' }
          : {}),
        note: HONESTY,
      };
    },
  },
  {
    name: 'list_flux_exercises',
    description:
      "The Flux exercise catalog (19 neck-rehab exercises): id, name, kind, how honestly it's measured (measured / approximate / guided), whether it's one-sided, its prescription (reps, hold seconds, target degrees), and the conditions and rehab stages it suits. Use the ids with list_flux_sets.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      return (EXERCISES as readonly ExerciseDefinition[]).map(exercise);
    },
  },
];
