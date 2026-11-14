import { FLUX_NOTE_MAX, fluxNoteData, type FluxWeekSummary } from '@aperture/shared/flux';

// The weekly Flux note's one prompt (docs/areas/flux D62): the model rephrases a deterministic line into
// one natural sentence, from the summary — descriptive only. Pure, so a snapshot pins the exact wording.

export const NOTE_MODEL = 'claude-haiku-5-5';

export const fluxNoteSystemPrompt = (): string =>
  `You write one short note about a week of neck exercises, for the person who did them, from the data given.
Rules:
- One sentence, at most ${FLUX_NOTE_MAX} characters, plain words, no emoji.
- Describe only: say what was done and how the numbers moved (this week against last, first against latest, right against left). Never praise, judge, advise, encourage, warn, or mention streaks, goals or consistency.
- Use only numbers that appear in the input, rounded as given. Never invent a number, a date or an exercise.
- A set stopped early ended short of its count; finishedCount is from finished sets only, angle from every set. When any set was stopped early, give no count of reps, holds, trials or cycles at all — say how many sets were stopped early instead.
- Angles are relative to each session's own calibrated neutral, from a webcam — describe them as a trend, never as a measurement or a diagnosis.
- Name the exercises by the names in the data, every one the note mentions; the note names at least one.
- If nothing changed, say so plainly.`;

// The data is the note's shape, not the summary's: no dates, targets or directions, and each number named
// for its scope — angle, finishedCount, finishedSets beside stoppedEarly (fluxNoteData).
export const fluxNoteUserContent = (line: string, summary: FluxWeekSummary): string =>
  `Draft line: ${line}\nData: ${JSON.stringify(fluxNoteData(summary))}`;

export const fluxNoteOutputSchema = (): Record<string, unknown> => ({
  type: 'object',
  additionalProperties: false,
  required: ['note'],
  properties: { note: { type: 'string' } },
});
