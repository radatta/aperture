import { describe, expect, it } from 'vitest';
import { fluxNoteOutputSchema, fluxNoteSystemPrompt, fluxNoteUserContent } from './fluxNotePrompt';

// The exact wording the model gets is a product surface — a change here changes every note, so it
// shows up as a snapshot diff in review.
describe('fluxNoteSystemPrompt', () => {
  it('asks for one descriptive sentence under the cap, with no praise and no invented numbers', () => {
    expect(fluxNoteSystemPrompt()).toMatchSnapshot();
  });
});

describe('fluxNoteUserContent', () => {
  it('carries the draft line and the summary as data', () => {
    const out = fluxNoteUserContent('This week: 2 sets rotation · first week', {
      weekStart: '2026-11-02',
      weekEnd: '2026-11-08',
      totalSets: 2,
      lastWeekSets: 0,
      exercises: [],
    });
    expect(out.startsWith('Draft line: This week: 2 sets rotation · first week\nData: {')).toBe(
      true,
    );
    expect(out).toContain('"weekStart":"2026-11-02"');
  });
});

describe('fluxNoteOutputSchema', () => {
  it('is one required string, nothing else', () => {
    expect(fluxNoteOutputSchema()).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['note'],
      properties: { note: { type: 'string' } },
    });
  });
});
