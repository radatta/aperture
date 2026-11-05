import { FLUX_NOTE_MAX, type FluxWeekSummary } from '@aperture/shared/flux';

// The weekly Flux note's one prompt (docs/areas/flux D62): the model rephrases a deterministic line into
// one natural sentence, from the summary — descriptive only. Pure, so a snapshot pins the exact wording.

export const NOTE_MODEL = 'claude-haiku-5-5';

export const fluxNoteSystemPrompt = (): string =>
  `You write one short note about a week of neck-rehab exercises, for the person who did them, from the data given.
Rules:
- One sentence, at most ${FLUX_NOTE_MAX} characters, plain words, no emoji.
- Describe only: say what was done and how the numbers moved (this week against last, first against latest, right against left). Never praise, judge, advise, encourage, warn, or mention streaks, goals or consistency.
- Use only numbers that appear in the input, rounded as given. Never invent a number, a date or an exercise.
- Angles are relative to each session's own calibrated neutral, from a webcam — describe them as a trend, never as a measurement or a diagnosis.
- Name exercises as the input's short names. If the input has one exercise, the note is about that one.
- If nothing changed, say so plainly.`;

export const fluxNoteUserContent = (line: string, summary: FluxWeekSummary): string =>
  `Draft line: ${line}\nData: ${JSON.stringify(summary)}`;

export const fluxNoteOutputSchema = (): Record<string, unknown> => ({
  type: 'object',
  additionalProperties: false,
  required: ['note'],
  properties: { note: { type: 'string' } },
});
