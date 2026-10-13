import { describe, expect, it } from 'vitest';
import { PARSE_TEXT_MAX, USER_TIME_ZONE, zonedEpoch } from '@aperture/shared';
import { InMemoryDoc } from './ddb/DocClient';
import { Repo } from './ddb/repo';
import { liveWrites } from './ddb/writes';
import { BackendClient } from './backend';
import { FakeAnthropic } from './anthropic/gateway';

// Quick add's parse on the server: the shared runQuickParse flow over the gated Claude seam. The stub
// is held to the same flow in app/src/data/stubParse.test.ts (parseTask is out of the contract suite —
// it rides a model gateway). No network: FakeAnthropic records what the model would have been sent.

function makeBackend(now = zonedEpoch('2026-10-12', '10:00', USER_TIME_ZONE)) {
  const doc = new InMemoryDoc();
  const anthropic = new FakeAnthropic();
  const b = new BackendClient(new Repo(doc, liveWrites(doc), 'local'), {
    userId: 'local',
    now: () => now,
    anthropic,
  });
  return { b, doc, anthropic };
}
const fields = (over: Record<string, unknown> = {}) => ({
  title: 'fix login',
  notes: null,
  categoryId: null,
  dueDay: null,
  dueTime: null,
  estimateMin: null,
  ...over,
});

describe('backend parseTask', () => {
  it("sends the model the active categories and the user's day, and validates what comes back", async () => {
    const { b, anthropic } = makeBackend();
    const ap = await b.upsertCategory({ label: 'Aperture', isWork: true });
    const old = await b.upsertCategory({ label: 'Old', isWork: true });
    await b.upsertCategory({ id: old.id, label: 'Old', isWork: true, active: false });
    anthropic.next = {
      ok: true,
      fields: fields({ categoryId: ap.id, dueTime: '16:00', estimateMin: 30 }),
    };

    expect(await b.parseTask('  aperture, fix login 4pm 30m ')).toEqual({
      ok: true,
      source: 'haiku',
      input: {
        title: 'fix login',
        categoryId: ap.id,
        dueDay: '2026-10-12',
        dueTime: '16:00',
        estimateMin: 30,
      },
      categoryLabel: 'Aperture',
      dropped: [],
      today: '2026-10-12',
    });
    expect(anthropic.calls).toEqual([
      {
        text: 'aperture, fix login 4pm 30m',
        today: '2026-10-12',
        categories: [{ id: ap.id, label: 'Aperture' }],
        timeoutMs: 4_000,
      },
    ]);
  });

  it("today follows the user's dayStartHour in their zone, not UTC midnight", async () => {
    const at = (hhmm: string) => makeBackend(zonedEpoch('2026-10-13', hhmm, USER_TIME_ZONE));
    for (const [hhmm, today] of [
      ['03:59', '2026-10-12'],
      ['04:01', '2026-10-13'],
    ] as const) {
      const { b, anthropic } = at(hhmm);
      anthropic.next = { ok: true, fields: fields() };
      expect(await b.parseTask('x')).toMatchObject({ today });
      expect(anthropic.calls[0]!.today).toBe(today);
    }
    const { b, anthropic } = at('05:00');
    await b.updateSettings({ dayStartHour: 6 });
    anthropic.next = { ok: true, fields: fields() };
    expect(await b.parseTask('x')).toMatchObject({ today: '2026-10-12' });
  });

  it('a field the server would reject is dropped and named, the rest kept', async () => {
    const { b, anthropic } = makeBackend();
    anthropic.next = {
      ok: true,
      fields: fields({ categoryId: 'gone', dueDay: '2026-02-30', estimateMin: 15 }),
    };
    expect(await b.parseTask('x 15m')).toMatchObject({
      ok: true,
      input: { title: 'fix login', estimateMin: 15 },
      dropped: ['unknown category', 'dropped due day'],
    });
  });

  it("a ' | ' line takes the grammar and never reaches the model", async () => {
    const { b, anthropic } = makeBackend();
    await b.upsertCategory({ label: 'Admin', isWork: true });
    expect(await b.parseTask('memo | ~30 #admin')).toMatchObject({
      ok: true,
      source: 'grammar',
      input: { title: 'memo', estimateMin: 30 },
      categoryLabel: 'Admin',
    });
    expect(await b.parseTask('memo | ~0')).toMatchObject({ ok: false, reason: 'grammar' });
    expect(anthropic.calls).toHaveLength(0);
  });

  it('failures come back as outcomes (a raw save), never throws; over-long text skips the model', async () => {
    const { b, anthropic } = makeBackend();
    anthropic.next = { ok: false, reason: 'timeout' };
    expect(await b.parseTask('x')).toEqual({ ok: false, reason: 'timeout' });
    anthropic.next = { ok: true, fields: fields({ title: '' }) };
    expect(await b.parseTask('x')).toEqual({ ok: false, reason: 'empty-title' });
    expect(await b.parseTask('x'.repeat(PARSE_TEXT_MAX + 1))).toMatchObject({
      ok: false,
      reason: 'unavailable',
    });
    expect(anthropic.calls).toHaveLength(2);
  });

  it('writes nothing', async () => {
    const { b, doc, anthropic } = makeBackend();
    await b.getSettings(); // materialise the settings singleton first
    const before = doc.size;
    anthropic.next = { ok: true, fields: fields() };
    await b.parseTask('x');
    expect(doc.size).toBe(before);
  });

  it('the model budget grows with the line, capped', async () => {
    const { b, anthropic } = makeBackend();
    anthropic.next = { ok: false, reason: 'timeout' };
    await b.parseTask('y'.repeat(1_000));
    await b.parseTask('y'.repeat(2_000)); // 4s + 5s, capped at 8s
    expect(anthropic.calls.map((c) => c.timeoutMs)).toEqual([6_000, 8_000]);
  });
});
