import { describe, expect, it } from 'vitest';
import { pickSlot } from './slot';

const holder = (branch: string) =>
  JSON.stringify({ branch, sha: 'a'.repeat(40), expiresAt: '2026-10-13T20:30:00.000Z' });
// Two lock refs → tag shas → holder messages; anything else unrouted.
const deps = (locks: Partial<Record<'dev' | 'devb', string>>) => ({
  lsRemote: async () =>
    Object.entries(locks)
      .map(([slot]) => `tag-${slot}\trefs/locks/${slot}`)
      .join('\n'),
  tagMessage: async (sha: string) => {
    const slot = sha.replace('tag-', '') as 'dev' | 'devb';
    const branch = locks[slot];
    if (branch === undefined) throw new Error(`unrouted ${sha}`);
    return branch === '<garbled>' ? 'not json' : holder(branch);
  },
});

describe('pickSlot (the lock is the only thing that picks a slot)', () => {
  it('targets the slot whose lock this branch holds', async () => {
    expect(await pickSlot('ci-bot', deps({ dev: 'flux', devb: 'ci-bot' }))).toMatchObject({
      slot: 'devb',
    });
    expect(await pickSlot('ci-bot', deps({ dev: 'ci-bot', devb: 'flux' }))).toMatchObject({
      slot: 'dev',
    });
  });

  it("never follows another branch's lock: no lock of its own → slot A, as before slot B", async () => {
    const pick = await pickSlot('ci-bot', deps({ dev: 'flux', devb: 'lc' }));
    expect(pick).toEqual({
      slot: 'dev',
      why: 'ci-bot holds no dev lock — dev (slot A), as before slot B',
    });
    expect((await pickSlot('ci-bot', deps({}))).slot).toBe('dev');
    expect((await pickSlot('ci-bot', deps({ devb: '<garbled>' }))).slot).toBe('dev');
  });

  it('propagates a failed lock read (run.ts turns it into SLOT_UNKNOWN), never guessing', async () => {
    await expect(
      pickSlot('ci-bot', {
        lsRemote: async () => {
          throw new Error('network down');
        },
        tagMessage: async () => '',
      }),
    ).rejects.toThrow('network down');
  });
});
