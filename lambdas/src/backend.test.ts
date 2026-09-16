import { describe, expect, it } from 'vitest';
import { InMemoryDoc } from './ddb/DocClient';
import { Repo } from './ddb/repo';
import { liveWrites } from './ddb/writes';
import { sk } from './ddb/keys';
import { BackendClient } from './backend';

// The contract suite proves list-level behavior against both impls, but it can't tell a soft-delete from a
// hard one — both just make the row vanish from the list. TECH.md's tech-debt ledger asks any new delete
// path to prove the difference, so this reaches under the facade: after deleteStory the row is still in the
// table with a tombstone (recoverable / export-auditable), yet filtered out of listStories.
describe('backend story soft-delete', () => {
  it('tombstones the row — kept in the table, gone from the list', async () => {
    const doc = new InMemoryDoc();
    let clock = 1_700_000_000_000;
    const backend = new BackendClient(new Repo(doc, liveWrites(doc), 'local'), {
      userId: 'local',
      now: () => clock,
    });

    const s = await backend.createStory({ title: 'To be deleted' });
    clock += 1000;
    await backend.deleteStory(s.id);

    // Still physically present, with a tombstone — not hard-deleted.
    const raw = await doc.get('u#local', sk.story(s.id));
    expect(raw).toBeTruthy();
    expect(raw!.deletedAt).not.toBeNull();

    // But filtered out of the live list.
    expect((await backend.listStories()).map((x) => x.id)).not.toContain(s.id);
  });
});
