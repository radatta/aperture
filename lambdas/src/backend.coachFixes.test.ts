import { describe, expect, it } from 'vitest';
import { legacyFixture, ulid } from '@aperture/shared';
import { InMemoryDoc } from './ddb/DocClient';
import { entityItem } from './ddb/mapping';
import { Repo } from './ddb/repo';
import { liveWrites } from './ddb/writes';
import { pk } from './ddb/keys';
import { BackendClient } from './backend';

// What the shared contract can't see: the table rows. The legacy capture's `lc#` rows are only ever read, and a
// trace comment's head row is the server's own, written once.
const T0 = 1_700_000_000_000;
async function setup() {
  const doc = new InMemoryDoc();
  for (const r of legacyFixture('2023-11-14', T0 - 30 * 86_400_000))
    await doc.put(entityItem('u1', `lc#${r.day}#${r.id}`, r));
  const now = { t: T0 };
  const backend = new BackendClient(new Repo(doc, liveWrites(doc, 'prod'), 'u1'), {
    userId: 'u1',
    now: () => now.t,
  });
  return { doc, backend, now };
}
const legacyItems = async (doc: InMemoryDoc) => JSON.stringify(await doc.query(pk('u1'), 'lc#'));
// Synthetic: a docstring that names an input, then walks it.
const TRACE =
  '"""\nnums = [3, 4], target = 7\ni=0: 3 -> add\ni=1: 4 -> found\n"""\nclass Solution: pass';

describe('the legacy rows on the table', () => {
  it('every coach write leaves the lc# rows exactly as they were', async () => {
    const { doc, backend } = await setup();
    const before = await legacyItems(doc);
    const groups = await backend.listLegacyGroups();
    await backend.setCoachVoids(groups.map((g) => ({ day: g.day, slug: g.slug, void: true })));
    await backend.setCoachVoids(groups.map((g) => ({ day: g.day, slug: g.slug, void: false })));
    await backend.logCoachAttempts([{ slug: 'two-sum', day: groups[0]!.day, outcome: 'clean' }]);
    await backend.getCoachToday();
    await backend.exportData();
    expect(await legacyItems(doc)).toBe(before);
    expect(JSON.parse(before)).toHaveLength(4);
  });

  it('a tombstoned legacy row is skipped', async () => {
    const { doc, backend } = await setup();
    const [first] = await doc.query(pk('u1'), 'lc#');
    await doc.put({ ...first!, deletedAt: T0 });
    expect((await backend.listLegacyGroups()).map((g) => g.submits)).toEqual([1, 1, 1]);
  });
});

describe('the trace comment row', () => {
  async function opened() {
    const { doc, backend } = await setup();
    const roll = await backend.upsertRoll({ name: 'LeetCode', categoryId: null, estimateMin: 45 });
    await backend.updateSettings({ leetcodeRollId: roll.id });
    const { sitting } = await backend.lcSittingStart({
      clientSittingId: ulid(),
      problemSlug: 'two-sum',
      problemTitle: 'Two Sum',
      lang: 'python3',
      startedAt: T0,
      tzOffsetMinutes: 480,
    });
    const traceRows = async () =>
      (await doc.query(pk('u1'), `lcs#${sitting.id}#hd#`)).filter(
        (r) => r.type === 'trace-comment',
      );
    return { backend, sitting, traceRows };
  }
  const snap = (code: string, at: number) => ({
    id: ulid(),
    type: 'snapshot' as const,
    at,
    payload: { code },
  });
  const submit = (at: number) => ({
    id: ulid(),
    type: 'submit' as const,
    at,
    payload: { result: { status_code: 11 } },
  });

  it('is written once, for the earliest traced snapshot, however many snapshots carry it', async () => {
    const { backend, sitting, traceRows } = await opened();
    const a = snap(TRACE, T0 + 2000);
    await backend.lcSittingEvents({ sittingId: sitting.id, events: [snap(TRACE, T0 + 3000), a] });
    await backend.lcSittingEvents({ sittingId: sitting.id, events: [snap(TRACE, T0 + 4000)] });
    await backend.lcSittingEvents({ sittingId: sitting.id, events: [a] }); // a retry
    const rows = await traceRows();
    expect(rows.map((r) => r.id)).toEqual([a.id]);
    await backend.lcSittingEvents({ sittingId: sitting.id, events: [submit(T0 + 5000)] });
    expect((await backend.getSitting(sitting.id)).sitting.summary.commentTrace).toBe('traced');
  });

  it('is never written for a snapshot after the first judged event, even in the same batch', async () => {
    const { backend, sitting, traceRows } = await opened();
    await backend.lcSittingEvents({
      sittingId: sitting.id,
      events: [submit(T0 + 1000), snap(TRACE, T0 + 2000)],
    });
    expect(await traceRows()).toEqual([]);
    await backend.lcSittingEvents({ sittingId: sitting.id, events: [snap(TRACE, T0 + 3000)] });
    expect(await traceRows()).toEqual([]);
    expect((await backend.getSitting(sitting.id)).sitting.summary.commentTrace).toBe('none');
  });
});
