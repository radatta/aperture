import { describe, expect, it } from 'vitest';
import {
  SUGGEST_MIN_HISTORY,
  suggestCategory,
  suggestionTokens,
  type SuggestableTask,
} from './categorySuggest';

// Synthetic history: two categories with their own vocabulary, nothing from a real backlog.
const GARDEN = 'cat-garden';
const KITCHEN = 'cat-kitchen';
const cats = (over: { id: string; active?: boolean }[] = []) =>
  [{ id: GARDEN, active: true }, { id: KITCHEN, active: true }, ...over].map((c) => ({
    active: true,
    ...c,
  }));

const GARDEN_TITLES = [
  'water the tomato beds',
  'prune the rose hedge',
  'spread mulch on the border',
  'sow carrot seeds',
  'stake the bean poles',
  'weed the herb patch',
  'repot the fern',
  'trim the lawn edge',
  'turn the compost heap',
  'plant tulip bulbs',
  'net the berry bushes',
  'rake the fallen leaves',
];
const KITCHEN_TITLES = [
  'descale the kettle',
  'sharpen the chef knife',
  'clean the oven racks',
  'restock the pantry shelf',
  'season the cast skillet',
  'defrost the freezer drawer',
  'wipe the range hood',
  'sort the spice rack',
  'replace the sink filter',
  'scrub the cutting board',
  'organise the baking tins',
  'degrease the stove top',
];

type H = { id: string; title: string; categoryId: string | null; notes?: string | null };
const rows = (titles: string[], categoryId: string | null, prefix: string): H[] =>
  titles.map((title, i) => ({ id: `${prefix}${i}`, title, categoryId }));
const history = (garden = GARDEN_TITLES, kitchen = KITCHEN_TITLES): H[] => [
  ...rows(garden, GARDEN, 'g'),
  ...rows(kitchen, KITCHEN, 'k'),
];
const ask = (task: SuggestableTask, h = history(), c = cats()) => suggestCategory(task, h, c);

describe('suggestionTokens', () => {
  it('takes [a-z0-9]{2,} runs of the title and the first 200 chars of notes, once each', () => {
    const t = suggestionTokens('Re-pot the FERN, fern!', `${'x'.repeat(200)} tomato`);
    expect([...t].sort()).toEqual(['fern', 'pot', 're', 'the', 'x'.repeat(200)].sort());
  });
});

describe('suggestCategory', () => {
  it('suggests the category whose vocabulary the title shares, with its margin', () => {
    const s = ask({ title: 'mulch the tomato beds' });
    expect(s?.categoryId).toBe(GARDEN);
    expect(s!.margin).toBeGreaterThanOrEqual(2);
    expect(ask({ title: 'descale the oven' })?.categoryId).toBe(KITCHEN);
  });

  it('no suggestion from a one-category history', () => {
    expect(ask({ title: 'mulch the tomato beds' }, rows(GARDEN_TITLES, GARDEN, 'g'))).toBeNull();
    // Enough rows, still one category.
    expect(
      ask(
        { title: 'mulch the tomato beds' },
        rows([...GARDEN_TITLES, ...GARDEN_TITLES], GARDEN, 'g'),
      ),
    ).toBeNull();
  });

  it('needs 20 categorised tasks', () => {
    expect(SUGGEST_MIN_HISTORY).toBe(20); // the title above is what the devcheck matrix names
    const h = history();
    expect(ask({ title: 'mulch the tomato beds' }, h.slice(0, SUGGEST_MIN_HISTORY - 1))).toBeNull();
    expect(ask({ title: 'mulch the tomato beds' }, h.slice(0, SUGGEST_MIN_HISTORY))).not.toBeNull();
    // Uncategorised rows don't count toward it.
    const padded = [...h.slice(0, SUGGEST_MIN_HISTORY - 1), ...rows(['stray thing'], null, 'u')];
    expect(ask({ title: 'mulch the tomato beds' }, padded)).toBeNull();
  });

  it('never a retired category — its tasks leave the evidence too', () => {
    const c = [
      { id: GARDEN, active: false },
      { id: KITCHEN, active: true },
    ];
    // Garden retired: only kitchen remains → one category → nothing.
    expect(ask({ title: 'mulch the tomato beds' }, history(), c)).toBeNull();
    // An id the roster doesn't know at all is treated the same.
    expect(
      ask({ title: 'mulch the tomato beds' }, history(), [{ id: KITCHEN, active: true }]),
    ).toBeNull();
  });

  it('excludes the task itself from its own evidence', () => {
    const h = history();
    // "fern" appears only in g6; scored as g6, that word is nobody's.
    expect(ask({ id: 'g6', title: 'repot the fern' }, h)).toBeNull();
    expect(ask({ id: 'other', title: 'repot the fern' }, h)?.categoryId).toBe(GARDEN);
  });

  it('needs 3 examples behind the winner', () => {
    const h = [
      ...rows(GARDEN_TITLES.slice(0, 2), GARDEN, 'g'),
      ...rows(KITCHEN_TITLES, KITCHEN, 'k'),
    ];
    const more = [...h, ...rows(KITCHEN_TITLES, KITCHEN, 'kk')]; // 26 rows, 2 garden
    expect(ask({ title: 'mulch the tomato beds' }, more)).toBeNull();
  });

  it('stays quiet under the margin — a title that fits both, or shares only "the"', () => {
    expect(ask({ title: 'the tomato kettle' })).toBeNull();
    expect(ask({ title: 'file the quarterly report' })).toBeNull();
  });

  it('says nothing when no word has been seen before', () => {
    expect(ask({ title: 'quarterly filing' })).toBeNull();
  });

  describe('a big category against a small one, on a long line', () => {
    // Garden 17 tasks of three once-used words each, Ledger 4: every word here is rare, where a small
    // category's smaller denominator pulls hardest.
    const words = (stem: string, n: number) => Array.from({ length: n }, (_, i) => `${stem}${i}`);
    const titles = (w: string[], per: number) =>
      Array.from({ length: Math.floor(w.length / per) }, (_, i) =>
        w.slice(i * per, i * per + per).join(' '),
      );
    const gardenWords = words('plot', 51);
    const ledgerWords = words('sum', 12);
    const LEDGER = 'cat-ledger';
    const h = [
      ...rows(titles(gardenWords, 3), GARDEN, 'g'),
      ...rows(titles(ledgerWords, 3), LEDGER, 'l'),
    ];
    const c = [
      { id: GARDEN, active: true },
      { id: LEDGER, active: true },
    ];

    it('31 of the big category’s words name it, not the small one', () => {
      const s = ask({ title: gardenWords.slice(0, 31).join(' ') }, h, c);
      expect(s?.categoryId).toBe(GARDEN);
      expect(s!.margin).toBeGreaterThanOrEqual(2);
    });

    it('a clear line of the small category’s own words still names it', () => {
      expect(ask({ title: ledgerWords.slice(0, 8).join(' ') }, h, c)?.categoryId).toBe(LEDGER);
    });

    it('a line split evenly between them says nothing', () => {
      const line = [...gardenWords.slice(0, 6), ...ledgerWords.slice(0, 6)].join(' ');
      expect(ask({ title: line }, h, c)).toBeNull();
    });

    describe('when the big one’s words repeat', () => {
      // 120 tasks over 100 common words plus one once-used word each: the words the line uses cost more
      // in this big denominator than absence does in a small one, so the margin alone would pick it.
      const common = words('crop', 100);
      const big = Array.from({ length: 120 }, (_, i) =>
        [`rare${i}`, ...[0, 1, 2, 3, 4].map((k) => common[(i * 5 + k) % 100]!)].join(' '),
      );
      const skewed = [...rows(big, GARDEN, 'g'), ...rows(titles(words('sum', 20), 5), LEDGER, 'l')];
      const rareLine = (n: number) => Array.from({ length: n }, (_, i) => `rare${i}`).join(' ');

      it('never names a small category that hasn’t seen the line', () => {
        for (const n of [4, 8, 15])
          expect(ask({ title: rareLine(n) }, skewed, c)?.categoryId).not.toBe(LEDGER);
      });

      it('never names a category whose tasks hold no words at all', () => {
        // Titles the tokeniser reads as nothing leave it the smallest denominator of all.
        // Alone with the big one: a second small category would stop it at the margin instead.
        const empty = [...rows(big, GARDEN, 'g'), ...rows(['?', '!!', '…'], 'cat-empty', 'e')];
        const roster = [
          { id: GARDEN, active: true },
          { id: 'cat-empty', active: true },
        ];
        expect(ask({ title: rareLine(10) }, empty, roster)?.categoryId).not.toBe('cat-empty');
      });
    });
  });

  it('reads notes — the first 200 chars only', () => {
    expect(ask({ title: 'thing', notes: 'mulch the tomato beds' })?.categoryId).toBe(GARDEN);
    expect(ask({ title: 'thing', notes: `${'z'.repeat(200)} mulch the tomato beds` })).toBeNull();
  });
});
