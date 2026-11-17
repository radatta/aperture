import { describe, expect, it } from 'vitest';
import {
  sittingDraftOutputSchema,
  sittingDraftSystemPrompt,
  sittingDraftUserContent,
} from './sittingReviewPrompt';

// The exact wording the model gets is a product surface — a change here changes every draft, so it shows up
// as a snapshot diff in review.
describe('sittingDraftSystemPrompt', () => {
  it('asks for at most five concrete, descriptive mistake lines from the data only', () => {
    expect(sittingDraftSystemPrompt()).toMatchSnapshot();
  });
});

describe('sittingDraftUserContent', () => {
  it('carries the data as JSON', () => {
    const out = sittingDraftUserContent({
      problem: { title: 'Two Sum', difficulty: 'Easy', tags: [] },
      signals: { accepted: false, ended: true, ranBeforeFirstSubmit: null, trace: null },
      judged: [],
      firstSubmitCode: null,
      finalCode: 'x',
    });
    expect(out).toBe(
      'Data: {"problem":{"title":"Two Sum","difficulty":"Easy","tags":[]},"signals":{"accepted":false,"ended":true,"ranBeforeFirstSubmit":null,"trace":null},"judged":[],"firstSubmitCode":null,"finalCode":"x"}',
    );
  });
});

describe('sittingDraftOutputSchema', () => {
  it('is a required list of strings and a required cause tag or null, nothing else', () => {
    expect(sittingDraftOutputSchema()).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['mistakes', 'cause'],
      properties: {
        mistakes: { type: 'array', items: { type: 'string' } },
        cause: {
          anyOf: [
            {
              type: 'string',
              enum: ['no-trace', 'api-slip', 'boundary', 'off-by-one', 'quit-early'],
            },
            { type: 'null' },
          ],
        },
      },
    });
  });
});
