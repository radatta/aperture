import { describe, expect, it } from 'vitest';
import { parseOutputSchema, parseSystemPrompt } from './parsePrompt';

// The exact wording the model gets is a product surface — a change here changes every parse, so it
// shows up as a snapshot diff in review.
describe('parseSystemPrompt', () => {
  it('names the day with its weekday and lists categories as id: label', () => {
    expect(
      parseSystemPrompt('2026-10-12', [
        { id: 'c1', label: 'Aperture' },
        { id: 'c2', label: 'System Design' },
      ]),
    ).toMatchSnapshot();
  });

  it('with no categories, says categoryId must be null', () => {
    const p = parseSystemPrompt('2026-10-16', []);
    expect(p).toContain('Today is 2026-10-16 (Friday)');
    expect(p).toContain('(none — categoryId must be null)');
  });

  it('never files a line under a category just because it is the only one (F229)', () => {
    const p = parseSystemPrompt('2026-11-17', [{ id: 'c1', label: 'Garden' }]);
    expect(p).toContain('Never pick a category because it is the only one or the nearest.');
  });

  it('a spoken line asks for the clock as said — the server places it', () => {
    const voice = parseSystemPrompt('2026-11-17', [], { voice: true });
    expect(voice).toContain('"at 5" or "five o\'clock" with no am/pm is 05:00');
    expect(voice).not.toContain('dueTime is always null');
  });

  it('a spoken line adds the voice rules after the typed ones, which stay word for word', () => {
    const cats = [{ id: 'c1', label: 'Aperture' }];
    const typed = parseSystemPrompt('2026-11-16', cats);
    const voice = parseSystemPrompt('2026-11-16', cats, { voice: true });
    expect(parseSystemPrompt('2026-11-16', cats, { voice: false })).toBe(typed);
    expect(voice.startsWith(typed)).toBe(true);
    expect(voice.slice(typed.length)).toMatchSnapshot();
  });
});

describe('parseOutputSchema', () => {
  it('requires every key and constrains categoryId to the given ids', () => {
    const s = parseOutputSchema(['c1', 'c2']) as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    expect(s.required).toEqual([
      'title',
      'notes',
      'categoryId',
      'dueDay',
      'dueTime',
      'estimateMin',
    ]);
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.categoryId).toEqual({
      anyOf: [{ type: 'string', enum: ['c1', 'c2'] }, { type: 'null' }],
    });
  });

  it('with no categories, categoryId can only be null', () => {
    const s = parseOutputSchema([]) as { properties: Record<string, unknown> };
    expect(s.properties.categoryId).toEqual({ type: 'null' });
  });
});
