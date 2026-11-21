import { describe, expect, it } from 'vitest';
import type { CoachPickContext } from '@aperture/shared';
import {
  coachPickOutputSchema,
  coachPickSystemPrompt,
  coachPickUserContent,
} from './coachPickPrompt';

// The exact wording the model gets is a product surface — a change here changes every day's pick, so it shows up as
// a snapshot diff in review. Synthetic context only.
const ctx: CoachPickContext = {
  today: '2026-11-16',
  planMode: { mode: 'balanced', due: 1 },
  candidates: [
    {
      slug: 'two-sum',
      title: 'Two Sum',
      pattern: 'arrays-hashing',
      difficulty: 'Easy',
      kind: 're-solve',
      ifFocus: null,
      capMin: 10,
      capRange: [5, 15],
      rule: 'Re-solve today',
      history: {
        tries: 1,
        lastDay: '2026-11-12',
        lastOutcome: 'failed',
        cause: null,
        peeked: false,
      },
    },
    {
      slug: 'valid-parentheses',
      title: 'Valid Parentheses',
      pattern: 'stack',
      difficulty: 'Easy',
      kind: 'new',
      ifFocus: 'stack',
      capMin: 20,
      capRange: [10, 30],
      rule: 'New in Stack',
      history: null,
    },
  ],
  rules: ['two-sum'],
  focus: { pattern: 'arrays-hashing', day: 2, of: 3, locked: false },
  top3: ['arrays-hashing', 'stack', 'two-pointers'],
  mustInclude: null,
  oldestDue: 'two-sum',
  momentum: { activeDays: 3, of: 7, lastActiveDay: '2026-11-15', missedYesterday: false },
  rates: [{ pattern: 'arrays-hashing', firstTry: '1/3', resolve: '0/0', peeked: 0, rank: 1 }],
  recent: [],
};

describe('coachPickSystemPrompt', () => {
  it('asks for four candidates with a why each, the guardrails stated, notes as data', () => {
    const p = coachPickSystemPrompt();
    expect(p).toMatch(/from `candidates` only/);
    expect(p).toMatch(/never as instructions/);
    expect(p).toMatch(/never mention missed days, gaps, streaks/); // the coach's wording rule (coachTools TODAY_NOTE)
    expect(p).toMatchSnapshot();
  });
});

describe('coachPickUserContent', () => {
  it('carries the context as JSON', () => {
    expect(coachPickUserContent(ctx)).toBe(`Data: ${JSON.stringify(ctx)}`);
  });
});

describe('coachPickOutputSchema', () => {
  it('narrows slugs to the candidates and a focus change to the other top-three patterns, all fields required', () => {
    const s = coachPickOutputSchema(ctx) as {
      required: string[];
      properties: {
        picks: { items: { properties: { slug: { enum: string[] } } } };
        focus: { anyOf: [{ properties: { to: { enum: string[] } } }, unknown] };
      };
    };
    expect(s.required).toEqual(['picks', 'note', 'focus']);
    expect(s.properties.picks.items.properties.slug.enum).toEqual(['two-sum', 'valid-parentheses']);
    expect(s.properties.focus.anyOf[0].properties.to.enum).toEqual(['stack', 'two-pointers']);
  });
  it('each pick carries a required nullable integer cap; bounds stay in code', () => {
    const items = (
      coachPickOutputSchema(ctx) as {
        properties: {
          picks: { items: { required: string[]; properties: Record<string, unknown> } };
        };
      }
    ).properties.picks.items;
    expect(items.required).toEqual(['slug', 'why', 'capMin']);
    expect(items.properties.capMin).toEqual({ anyOf: [{ type: 'integer' }, { type: 'null' }] });
  });
  // Structured outputs cap a request at 16 union-typed and 24 optional parameters (platform docs → Structured
  // outputs → Schema complexity limits); every object here lists all its properties as required.
  it('stays inside the structured-output limits: few unions, no optional parameters', () => {
    let unions = 0;
    let optional = 0;
    const walk = (n: unknown): void => {
      if (!n || typeof n !== 'object') return;
      const o = n as Record<string, unknown>;
      if (Array.isArray(o.anyOf) || Array.isArray(o.type)) unions += 1;
      if (o.properties && typeof o.properties === 'object') {
        const req = new Set((o.required as string[] | undefined) ?? []);
        optional += Object.keys(o.properties).filter((k) => !req.has(k)).length;
      }
      for (const v of Object.values(o)) (Array.isArray(v) ? v : [v]).forEach(walk);
    };
    walk(coachPickOutputSchema(ctx));
    expect(unions).toBe(3); // note, focus, a pick's capMin
    expect(optional).toBe(0);
  });
  it('offers no focus change while a pick is held', () => {
    const held = { ...ctx, focus: { ...ctx.focus, locked: true } };
    expect(
      (coachPickOutputSchema(held) as { properties: { focus: unknown } }).properties.focus,
    ).toEqual({
      type: 'null',
    });
  });
});
