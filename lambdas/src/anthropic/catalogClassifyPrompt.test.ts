import { describe, expect, it } from 'vitest';
import type { LcSourceRow } from '@aperture/shared';
import {
  catalogClassifyOutputSchema,
  catalogClassifySystemPrompt,
  catalogClassifyUserContent,
  validateCatalogClasses,
} from './catalogClassifyPrompt';

const rows: LcSourceRow[] = [
  {
    id: 9001,
    slug: 'synthetic-a',
    title: 'Synthetic A',
    difficulty: 'Medium',
    premium: false,
    acRate: 40,
    tags: ['Array'],
    algorithms: true,
  },
  {
    id: 9002,
    slug: 'synthetic-b',
    title: 'Synthetic B',
    difficulty: 'Hard',
    premium: true,
    acRate: null,
    tags: [],
    algorithms: true,
  },
];

describe('the catalog classification prompt', () => {
  it('names every roadmap pattern and sends metadata only', () => {
    const system = catalogClassifySystemPrompt();
    for (const p of ['arrays-hashing', 'advanced-graphs', 'bit-manipulation', 'other'])
      expect(system).toContain(p);
    expect(catalogClassifyUserContent(rows)).toBe(
      'Problems (number | difficulty | title | tags):\n9001 | Medium | Synthetic A | Array\n9002 | Hard | Synthetic B | -',
    );
  });

  it('narrows the answer’s ids to the problems asked about', () => {
    const schema = catalogClassifyOutputSchema(rows) as {
      properties: {
        items: { items: { properties: { id: { enum: number[] }; pattern: { enum: string[] } } } };
      };
    };
    expect(schema.properties.items.items.properties.id.enum).toEqual([9001, 9002]);
    expect(schema.properties.items.items.properties.pattern.enum).toContain('other');
  });

  it('keeps only valid items for ids asked about, once each, two related ids at most', () => {
    const got = validateCatalogClasses(
      {
        items: [
          { id: 9001, pattern: 'heap', similar: [1, 2, 3], harder: [] },
          { id: 9001, pattern: 'trees', similar: [], harder: [] }, // repeated
          { id: 9002, pattern: 'not-a-pattern', similar: [], harder: [] },
          { id: 404, pattern: 'heap', similar: [], harder: [] }, // not asked
          { id: 9002, pattern: 'greedy', similar: [1.5], harder: [] },
        ],
      },
      [9001, 9002],
    );
    expect([...got]).toEqual([[9001, { pattern: 'heap', similar: [1, 2], harder: [] }]]);
    expect(validateCatalogClasses(null, [1]).size).toBe(0);
    expect(validateCatalogClasses({ items: 'x' }, [1]).size).toBe(0);
  });
});
