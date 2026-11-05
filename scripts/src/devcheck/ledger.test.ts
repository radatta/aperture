import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openLedger, orphanIntents, pendingIds, type LedgerEntry } from './ledger';

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
