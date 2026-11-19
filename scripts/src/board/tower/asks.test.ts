import { describe, expect, it } from 'vitest';
import {
  addAsk,
  answerAsks,
  askBriefLines,
  askLines,
  askShow,
  ASK_KEEP_MS,
  closeAsk,
  openAsks,
  pruneAsks,
} from './asks.ts';
import { parseQueue } from './queue.ts';

const NOW = Date.parse('2026-11-18T20:00:00Z');
const f = (t: number) => new Date(t).toISOString().slice(11, 16); // UTC HH:MM, so the test is TZ-free
const base = () => ({
  v: 1,
  updatedAt: '2026-11-18T19:00:00Z',
  askSeq: 3,
  asks: [
    {
      id: 'd3',
      asked: '2026-11-18T19:10:00Z',
      text: 'Cache key?',
      options: ['per branch', 'per lockfile'],
      pick: 'b',
      lane: 'warm-caches',
      status: 'open',
    },
    {
      id: 'd2',
      asked: '2026-11-18T19:05:00Z',
      text: 'Start golf tonight?',
      options: ['yes', 'no'],
      status: 'open',
    },
    {
      id: 'd1',
      asked: '2026-11-18T19:00:00Z',
      text: 'Apply the skills patch',
      needsPane: true,
      pane: 'dispatch',
      go: 'go 1a2b3c4d',
      status: 'open',
    },
  ],
});
const parsed = (raw: unknown) => {
  const q = parseQueue(JSON.stringify(raw));
  expect(q.problems).toEqual([]);
  return q.data!;
};

describe('openAsks and the printed lines', () => {
  it('lists open asks by id, each with its options, pick and how to reply', () => {
    const asks = openAsks(parsed(base()));
    expect(asks.map((a) => a.id)).toEqual(['d1', 'd2', 'd3']);
    expect(askLines(asks, f)).toBe(
      [
        'ASKS 3 open · newest d3',
        'd1 · 19:00 · Apply the skills patch',
        '   GO NEEDED: type in the dispatch pane: go 1a2b3c4d',
        'd2 · 19:05 · Start golf tonight?',
        '   a) yes   b) no',
        '   no pick · reply d2 <letter> | d2 ?',
        'd3 · 19:10 · warm-caches · Cache key?',
        '   a) per branch   b) per lockfile',
        '   pick b · reply d3 b | d3 ok | d3 ?',
      ].join('\n'),
    );
    expect(askLines([], f)).toBe('ASKS none open');
  });
  it('answered and closed asks are not open', () => {
    const raw = base();
    raw.asks[0] = {
      ...raw.asks[0]!,
      status: 'answered',
      answer: 'b',
      answeredAt: '2026-11-18T19:20:00Z',
    } as never;
    raw.asks[1] = { ...raw.asks[1]!, status: 'closed' } as never;
    expect(openAsks(parsed(raw)).map((a) => a.id)).toEqual(['d1']);
    expect(openAsks(null)).toEqual([]);
  });
  it('show prints one ask in full, its pick and answer marked', () => {
    const raw = base();
    raw.asks[0] = {
      ...raw.asks[0]!,
      status: 'answered',
      answer: 'a',
      answeredAt: '2026-11-18T19:20:00Z',
    } as never;
    const d3 = parsed(raw).asks!.find((a) => a.id === 'd3')!;
    expect(askShow(d3, f)).toBe(
      [
        'd3 · answered · asked 19:10 · warm-caches',
        'Cache key?',
        '  a) per branch',
        '  b) per lockfile  ← pick',
        'answered a) per branch at 19:20',
      ].join('\n'),
    );
  });
  it('the brief: a count, the pane asks said, rows capped, control bytes gone', () => {
    const raw = base();
    raw.asks[1]!.text = 'Start golf\u001b[2J tonight?';
    const lines = askBriefLines(openAsks(parsed(raw)), 2);
    expect(lines).toEqual([
      'ASKS 3 · 1 needs your go in a pane',
      '  d1 Apply the skills patch · go typed in dispatch',
      '  d2 Start golf[2J tonight? · a) yes b) no',
      '  +1 more',
    ]);
    expect(askBriefLines([])).toEqual(['ASKS none']);
    const long = base();
    long.asks[0]!.text = 'q'.repeat(300);
    long.asks[0]!.options = ['o'.repeat(80), 'p'.repeat(80)];
    for (const l of askBriefLines(openAsks(parsed(long))))
      expect(l.length).toBeLessThanOrEqual(120);
    for (const l of askLines(openAsks(parsed(long)), f).split('\n'))
      expect(l.length).toBeLessThanOrEqual(150); // text 120, options 60 each with their letters
  });
});

describe('the writes', () => {
  it('prune keeps askSeq at the highest id it drops, so a hand-kept file never reuses one', () => {
    const raw = {
      v: 1,
      updatedAt: '2026-11-18T19:00:00Z',
      asks: [
        {
          id: 'd5',
          asked: '2026-11-17T10:00:00Z',
          text: 'old',
          options: ['x', 'y'],
          status: 'answered',
          answer: 'a',
          answeredAt: '2026-11-17T10:05:00Z',
        },
      ],
    };
    const pruned = pruneAsks(raw, NOW);
    expect(pruned).toMatchObject({ askSeq: 5, asks: [] });
    expect(addAsk(pruned, { text: 't', options: ['x', 'y'] }, NOW).id).toBe('d6');
    const fresh = base();
    expect(pruneAsks(fresh, NOW)).toBe(fresh); // nothing to drop: untouched
  });
  it('add hands out the next id past askSeq and every id on file, and the result parses', () => {
    const raw = base();
    raw.askSeq = 1; // behind the file: d3 is on file, so the next is d4
    const { raw: out, id } = addAsk(
      raw,
      { text: 'Which slot?', options: ['A', 'B'], pick: 'a', lane: 'gate-trims' },
      NOW,
    );
    expect(id).toBe('d4');
    expect(out.askSeq).toBe(4);
    const d4 = parsed(out).asks!.find((a) => a.id === 'd4')!;
    expect(d4).toMatchObject({
      status: 'open',
      pick: 'a',
      lane: 'gate-trims',
      asked: NOW,
      needsPane: false,
    });
    // a pruned id never comes back: askSeq remembers it
    const { id: next } = addAsk({ ...out, asks: [] }, { text: 't', options: ['x', 'y'] }, NOW);
    expect(next).toBe('d5');
  });
  it('add: a pane sets needsPane; an unknown field or a non-object refuses', () => {
    const { raw } = addAsk(base(), { text: 'Type go', pane: 'warm-caches', go: 'go' }, NOW);
    expect(parsed(raw).asks!.at(-1)).toMatchObject({ needsPane: true, pane: 'warm-caches' });
    expect(() => addAsk(base(), { text: 't', needsPane: false }, NOW)).toThrow(
      /unknown field needsPane/,
    );
    expect(() => addAsk(base(), [], NOW)).toThrow(/JSON object/);
    expect(() => addAsk(base(), null, NOW)).toThrow(/JSON object/);
  });
  it('answer by letter: marks it, prints the meaning and the relay to its lane', () => {
    const raw = base();
    const r = answerAsks(raw, parsed(raw).asks!, 'd3', 'a', NOW);
    expect(r.answered).toBe(1);
    expect(r.out).toEqual([
      'ANSWERED d3: a) per branch',
      'relay to warm-caches: [relay] warm-caches — the user: "d3 a" → "Cache key?" = a) per branch',
    ]);
    expect(parsed(r.raw).asks!.find((a) => a.id === 'd3')).toMatchObject({
      status: 'answered',
      answer: 'a',
      answeredAt: NOW,
    });
  });
  it("answer ok takes the pick; with no lane it is dispatch's own", () => {
    const raw = base();
    raw.asks[1]!.pick = 'a';
    const r = answerAsks(raw, parsed(raw).asks!, 'D2', 'OK', NOW);
    expect(r.out).toEqual([
      'ANSWERED d2: a) yes (the pick)',
      'dispatch\'s own: "Start golf tonight?" = a) yes',
    ]);
  });
  it('answer refuses: no such ask, not open, a bad reply, a letter past its options', () => {
    const raw = base();
    const asks = parsed(raw).asks!;
    expect(() => answerAsks(raw, asks, 'd9', 'a', NOW)).toThrow(/no ask d9/);
    expect(() => answerAsks(raw, asks, 'd3', '?', NOW)).toThrow(/not a letter or ok/);
    expect(() => answerAsks(raw, asks, 'd3', 'yes', NOW)).toThrow(/not a letter or ok/);
    expect(() => answerAsks(raw, asks, 'd3', 'c', NOW)).toThrow(/has 2 options \(a–b\), not c/);
    expect(() => answerAsks(raw, asks, 'all', 'a', NOW)).toThrow(/only `all ok`/);
    const done = answerAsks(raw, asks, 'd3', 'b', NOW).raw;
    expect(() => answerAsks(done, parsed(done).asks!, 'd3', 'a', NOW)).toThrow(
      /d3 is answered \(b\), not open/,
    );
  });
  it('a pane ask is never answered here, by a letter or by ok', () => {
    const raw = base();
    raw.asks[2]!.options = ['go', 'no'] as never;
    const asks = parsed(raw).asks!;
    for (const reply of ['a', 'ok']) {
      const r = answerAsks(raw, asks, 'd1', reply, NOW);
      expect(r.answered).toBe(0);
      expect(r.raw).toBe(raw);
      expect(r.out).toEqual([
        'GO NEEDED d1: type in the dispatch pane: go 1a2b3c4d (a reply here is not the go)',
      ]);
    }
  });
  it('a garbled needsPane fails closed: ok never answers it', () => {
    const raw = base();
    raw.asks[0] = { ...raw.asks[0]!, needsPane: 'yes' } as never;
    const q = parseQueue(JSON.stringify(raw));
    const r = answerAsks(raw, q.data!.asks!, 'd3', 'ok', NOW);
    expect(r.answered).toBe(0);
    expect(r.out[0]).toBe(
      'GO NEEDED d3: type in the warm-caches pane: go (a reply here is not the go)',
    );
  });
  it('all ok answers every pick up to the newest shown and lists the rest', () => {
    const raw = base();
    const r = answerAsks(raw, parsed(raw).asks!, 'all', 'ok', NOW, 'd3');
    expect(r.answered).toBe(1);
    expect(r.out).toEqual([
      'GO NEEDED d1: type in the dispatch pane: go 1a2b3c4d (a reply here is not the go)',
      'NO PICK d2: choose a letter (a, b)',
      'ANSWERED d3: b) per lockfile (the pick)',
      'relay to warm-caches: [relay] warm-caches — the user: "d3 ok" → "Cache key?" = b) per lockfile',
    ]);
    expect(openAsks(parsed(r.raw)).map((a) => a.id)).toEqual(['d1', 'd2']);
    const none = { ...base(), asks: [] };
    expect(answerAsks(none, [], 'all', 'ok', NOW, 'd1').out).toEqual(['ASKS none open']);
  });
  it('all ok covers only what the user was shown: no newest refuses, a newer ask is left open', () => {
    const raw = base();
    const asks = parsed(raw).asks!;
    for (const upto of [null, '', 'seven', 'd0'])
      expect(() => answerAsks(raw, asks, 'all', 'ok', NOW, upto)).toThrow(
        /wants <newest> after it/,
      );
    raw.asks[1]!.pick = 'a';
    const r = answerAsks(raw, parsed(raw).asks!, 'all', 'ok', NOW, 'D2');
    expect(r.answered).toBe(1);
    expect(r.out).toContain(
      'NOT SHOWN d3: newer than D2, so not covered by all ok · show it: asks show d3',
    );
    expect(openAsks(parsed(r.raw)).map((a) => a.id)).toEqual(['d1', 'd3']);
  });
  it('an explicit ask takes its own reply: all ok passes over it, d<n> ok answers it; garbled reads as explicit', () => {
    const raw = base();
    raw.asks[0] = { ...raw.asks[0]!, explicit: true } as never;
    const all = answerAsks(raw, parsed(raw).asks!, 'all', 'ok', NOW, 'd3');
    expect(all.answered).toBe(0);
    expect(all.out).toContain(
      'OWN REPLY d3: its own reply only (d3 ok or d3 <letter>), never all ok',
    );
    expect(askLines(openAsks(parsed(raw)), f)).toContain(
      '   pick b · reply d3 b | d3 ok | d3 ? · its own reply, not all ok',
    );
    const own = answerAsks(raw, parsed(raw).asks!, 'd3', 'ok', NOW);
    expect(own.answered).toBe(1);
    const garbled = base();
    garbled.asks[0] = { ...garbled.asks[0]!, explicit: 'maybe' } as never;
    const q = parseQueue(JSON.stringify(garbled));
    expect(q.problems).toEqual(['asks[0]: explicit is not true or false']);
    expect(answerAsks(garbled, q.data!.asks!, 'all', 'ok', NOW, 'd3').answered).toBe(0);
    const { raw: added } = addAsk(
      base(),
      { text: 'xhigh for gate-trims?', options: ['yes', 'no'], explicit: true },
      NOW,
    );
    expect(parsed(added).asks!.at(-1)).toMatchObject({ explicit: true });
  });
  it('answer and close edit only the entry the parser kept, never a dropped twin with its id', () => {
    const raw = base();
    raw.asks.unshift({ ...raw.asks[0]!, status: 'maybe' } as never); // a bad d3 the parser drops
    const q = parseQueue(JSON.stringify(raw));
    expect(q.problems).toEqual(['asks[0]: status "maybe"']);
    for (const out of [
      closeAsk(raw, q.data!.asks!, 'd3', NOW),
      answerAsks(raw, q.data!.asks!, 'd3', 'a', NOW).raw,
    ]) {
      expect((out.asks as { status: string }[]).map((a) => a.status)).toEqual([
        'maybe',
        expect.stringMatching(/^(closed|answered)$/),
        'open',
        'open',
      ]);
      expect(parseQueue(JSON.stringify(out)).problems).toEqual(['asks[0]: status "maybe"']); // no new duplicate
    }
  });
  it('close: an open ask only, kept a day like an answered one', () => {
    const raw = base();
    const out = closeAsk(raw, parsed(raw).asks!, 'd1', NOW);
    expect(parsed(out).asks!.find((a) => a.id === 'd1')).toMatchObject({
      status: 'closed',
      answeredAt: NOW,
    });
    expect(() => closeAsk(out, parsed(out).asks!, 'd1', NOW)).toThrow(/d1 is closed, not open/);
    expect(() => closeAsk(raw, parsed(raw).asks!, 'd8', NOW)).toThrow(/no ask d8/);
  });
  it('prune drops answered and closed asks past a day; open and undated ones stay; unknown keys kept', () => {
    const old = new Date(NOW - ASK_KEEP_MS - 1).toISOString();
    const fresh = new Date(NOW - ASK_KEEP_MS + 60e3).toISOString();
    const raw = {
      ...base(),
      extra: { kept: true },
      asks: [
        { id: 'd1', status: 'answered', answeredAt: old },
        { id: 'd2', status: 'closed', answeredAt: fresh },
        { id: 'd3', status: 'open', answeredAt: old },
        { id: 'd4', status: 'answered' },
      ],
    };
    const out = pruneAsks(raw, NOW);
    expect((out.asks as { id: string }[]).map((a) => a.id)).toEqual(['d2', 'd3', 'd4']);
    expect(out.extra).toEqual({ kept: true });
  });
});
