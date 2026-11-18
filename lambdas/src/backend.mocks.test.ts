import { describe, expect, it } from 'vitest';
import { ulid } from '@aperture/shared';
import { InMemoryDoc } from './ddb/DocClient';
import { Repo } from './ddb/repo';
import { liveWrites } from './ddb/writes';
import { pk } from './ddb/keys';
import { BackendClient } from './backend';

// What the shared contract can't see (coach.md → Mocks): the rows on the table, and a second user on the same
// table. Synthetic data only.
const T0 = 1_700_000_000_000;
function setup() {
  const doc = new InMemoryDoc();
  const client = (u: string) =>
    new BackendClient(new Repo(doc, liveWrites(doc, 'prod'), u), { userId: u, now: () => T0 });
  return { doc, a: client('u1'), b: client('u2') };
}
const done = { scores: { code: 3, solve: 2 } } as const;

describe('mocks on the table', () => {
  it('a mock is one lcc#mock# row in its owner’s partition, and nothing else is written', async () => {
    const { doc, a } = setup();
    const m = await a.upsertMock(done);
    const rows = await doc.query(pk('u1'), 'lcc#');
    expect(rows.map((r) => r.SK)).toEqual([`lcc#mock#${m.id}`]);
    expect(await doc.query(pk('u1'), 'task#')).toEqual([]);
  });

  it('another user’s mock is Not found to read, change or delete, and stays as it was', async () => {
    const { doc, a, b } = setup();
    const m = await a.upsertMock(done);
    const before = JSON.stringify(await doc.query(pk('u1'), 'lcc#mock#'));
    expect(await b.listMocks()).toEqual([]);
    await expect(b.upsertMock({ id: m.id, ...done, partner: 'x' })).rejects.toThrow(/Not found/);
    await b.deleteMock(m.id); // idempotent: nothing of theirs to delete
    expect((await b.getCoachToday()).mock.doneCount).toBe(0);
    expect((await b.exportData()).mocks).toEqual([]);
    expect(JSON.stringify(await doc.query(pk('u1'), 'lcc#mock#'))).toBe(before);
    expect(await a.listMocks()).toEqual([m]);
  });

  it('another user’s sitting can’t be named', async () => {
    const { a, b } = setup();
    const roll = await a.upsertRoll({ name: 'LeetCode', categoryId: null, estimateMin: 45 });
    await a.updateSettings({ leetcodeRollId: roll.id });
    const { sitting } = await a.lcSittingStart({
      clientSittingId: ulid(),
      problemSlug: 'two-sum',
      problemTitle: 'Two Sum',
      lang: 'python3',
      startedAt: T0,
      tzOffsetMinutes: 480,
    });
    await expect(b.upsertMock({ ...done, sittingId: sitting.id })).rejects.toThrow(/Not found/);
    expect(await b.listMocks()).toEqual([]);
  });
});
