import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  earlierOrphans,
  leftovers,
  openLedger,
  orphanIntents,
  pendingIds,
  type LedgerEntry,
} from './ledger';

const e = (op: LedgerEntry['op'], id?: string, extra: Partial<LedgerEntry> = {}): LedgerEntry => ({
  t: '2026-10-13T00:00:00.000Z',
  run: 'r1',
  op,
  ...(id ? { id } : {}),
  ...extra,
});

describe('pendingIds', () => {
  it('is created minus deleted, gone and swept, in creation order', () => {
    const entries = [
      e('created', 'a'),
      e('created', 'b'),
      e('created', 'c'),
      e('created', 'd'),
      e('deleted', 'a'),
      e('gone', 'b'),
      e('swept', 'c'),
    ];
    expect(pendingIds(entries)).toEqual(['d']);
  });
  it('counts a re-recorded id once', () => {
    expect(pendingIds([e('created', 'a'), e('created', 'a')])).toEqual(['a']);
  });
  it('an id created again after it was resolved is pending again (a reused push endpoint)', () => {
    const later = (op: LedgerEntry['op'], id: string) => e(op, id, { run: 'r2' });
    expect(pendingIds([e('created', 'a'), e('deleted', 'a'), later('created', 'a')])).toEqual([
      'a',
    ]);
    expect(
      pendingIds([e('created', 'a'), e('gone', 'a'), later('created', 'a'), later('deleted', 'a')]),
    ).toEqual([]);
  });
});

describe('earlierOrphans', () => {
  const intent = (run: string, title: string) =>
    e('intent', undefined, { run, via: 'api:createTask', title });
  it('flags a killed run’s unresolved intent, not a finished run’s or this run’s', () => {
    const entries = [
      intent('killed', 'x'),
      intent('done', 'y'),
      e('run-end', undefined, { run: 'done', status: 'FAIL' }),
      intent('now', 'z'),
    ];
    expect(earlierOrphans(entries, 'now').map((x) => [x.run, x.title])).toEqual([['killed', 'x']]);
  });
  it('a killed run’s intent that got its created is no orphan', () => {
    const entries = [
      intent('killed', 'x'),
      e('created', 'a', { run: 'killed', via: 'api:createTask', title: 'x' }),
    ];
    expect(earlierOrphans(entries, 'now')).toEqual([]);
  });
  it('pairs answers with intents one to one: a dropped create retried under the same title stays an orphan (F257)', () => {
    const created = (id: string, run = 'r') =>
      e('created', id, { run, via: 'api:createTask', title: 'x' });
    // Two sent, one answered: one is an orphan. Which one dropped can't be told from the ledger, so the answer
    // pairs with the oldest (first in, first out) and the later intent is the one reported.
    const at = (t: string) => ({ ...intent('r', 'x'), t });
    const first = at('2026-10-13T00:00:01.000Z');
    const second = at('2026-10-13T00:00:02.000Z');
    expect(orphanIntents([first, second, created('b')])).toEqual([second]);
    // Two in flight at once, answered out of order: both resolved.
    expect(orphanIntents([intent('r', 'x'), intent('r', 'x'), created('b'), created('a')])).toEqual(
      [],
    );
    // A refusal resolves one too; an answer before any intent, or another run's, resolves none.
    const refused = e('refused', undefined, { run: 'r', via: 'api:createTask', title: 'x' });
    expect(orphanIntents([intent('r', 'x'), refused])).toEqual([]);
    expect(orphanIntents([created('a'), intent('r', 'x')])).toHaveLength(1);
    expect(orphanIntents([intent('r', 'x'), created('a', 'other')])).toHaveLength(1);
  });
  it('one already reported by a later run is not reported again', () => {
    const entries = [
      intent('killed', 'x'),
      intent('killed', 'y'),
      e('reported', undefined, { run: 'later', of: 'killed', via: 'api:createTask', title: 'x' }),
    ];
    expect(earlierOrphans(entries, 'now').map((x) => x.title)).toEqual(['y']);
  });
  it('pendingIds ignores reported lines', () => {
    const entries = [
      e('created', 'a'),
      e('reported', undefined, { of: 'killed', via: 'api:createTask', title: 'x' }),
    ];
    expect(pendingIds(entries)).toEqual(['a']);
  });
});

describe('leftovers', () => {
  it('counts pending ids and a killed run’s orphan intents: either wakes an idle lane to sweep', () => {
    const orphanOnly = [
      e('intent', undefined, { run: 'killed', via: 'api:createTask', title: 'x' }),
    ];
    expect(leftovers(orphanOnly, 'now')).toBe(1);
    expect(leftovers([e('created', 't1')], 'now')).toBe(1);
    expect(leftovers([e('created', 't1'), e('deleted', 't1')], 'now')).toBe(0);
    expect(leftovers([], 'now')).toBe(0);
  });
});

describe('orphanIntents', () => {
  it('flags an intent with no matching created after it', () => {
    const entries = [
      e('intent', undefined, { via: 'api:createTask', title: 'x' }),
      e('created', 'a', { via: 'api:createTask', title: 'x' }),
      e('intent', undefined, { via: 'api:createTask', title: 'y' }),
    ];
    expect(orphanIntents(entries).map((x) => x.title)).toEqual(['y']);
  });
  it('a refused create (a param error, nothing written) resolves its intent', () => {
    const entries = [
      e('intent', undefined, { via: 'mcp:create_series', title: 'x' }),
      e('refused', undefined, { via: 'mcp:create_series', title: 'x' }),
      e('intent', undefined, { via: 'mcp:create_series', title: 'y' }),
    ];
    expect(orphanIntents(entries).map((x) => x.title)).toEqual(['y']);
  });
});

describe('openLedger', () => {
  it('appends JSON lines with a timestamp and reads them back', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'sub', 'ledger.jsonl');
    const ledger = openLedger(path, () => new Date('2026-10-13T12:00:00Z'));
    expect(ledger.read()).toEqual([]);
    ledger.append({ run: 'r1', op: 'created', id: 'a', via: 'ui:createTask' });
    expect(readFileSync(path, 'utf8')).toBe(
      '{"t":"2026-10-13T12:00:00.000Z","run":"r1","op":"created","id":"a","via":"ui:createTask"}\n',
    );
    expect(ledger.has('a')).toBe(true);
    expect(ledger.has('b')).toBe(false);
  });
  it('has() is only true for a created id, not one merely deleted or swept', () => {
    const ledger = openLedger(join(mkdtempSync(join(tmpdir(), 'ledger-')), 'l.jsonl'));
    ledger.append({ run: 'r1', op: 'deleted', id: 'x' });
    expect(ledger.has('x')).toBe(false);
  });
});
