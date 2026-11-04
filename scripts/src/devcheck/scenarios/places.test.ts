import { describe, expect, it } from 'vitest';
import type { PwPage } from '../pw-types';
import { shotWithheld } from '../scenario';
import { takeRevealedToken } from './places';

const TOKEN = `apl_${'x'.repeat(43)}`;

// A Settings page whose show-once reveal does what `opts` says; `events` is the order things happened in.
function fakePage(opts: { revealShows?: boolean; doneCloses?: boolean; gotoFails?: boolean } = {}) {
  const events: string[] = [];
  let shown = false;
  const field = {
    waitFor: async ({ state }: { state: string }) => {
      events.push(`wait ${state}`);
      if (state === 'visible' && opts.revealShows === false) {
        shown = true; // the reveal arrives just after the wait gave up
        throw new Error('Timeout 15000ms exceeded');
      }
      if (state === 'hidden' && shown) throw new Error('Timeout 5000ms exceeded');
      if (state === 'visible') shown = true;
    },
    inputValue: async () => TOKEN,
  };
  const done = {
    click: async () => {
      events.push('done');
      if (opts.doneCloses !== false) shown = false;
    },
  };
  const page = {
    getByRole: (role: string) => (role === 'textbox' ? field : done),
    goto: async (url: string) => {
      events.push(`goto ${url}`);
      if (opts.gotoFails) throw new Error('page crashed');
      shown = false;
    },
  } as unknown as PwPage;
  return { page, events, shown: () => shown };
}

describe('takeRevealedToken', () => {
  it('reads the token and closes the reveal, never leaving the page', async () => {
    const f = fakePage();
    const mint = async () => void f.events.push('mint');
    expect(await takeRevealedToken({ page: f.page }, mint)).toBe(TOKEN);
    expect(f.events).toEqual(['mint', 'wait visible', 'done', 'wait hidden']);
    expect(f.shown()).toBe(false);
  });

  it('a reveal that comes after the wait gave up is blanked before the error leaves, and never shot', async () => {
    const f = fakePage({ revealShows: false });
    const err = await takeRevealedToken({ page: f.page }, async () => undefined).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toBe('Timeout 15000ms exceeded');
    expect(f.events).toEqual(['wait visible', 'goto about:blank']);
    expect(f.shown()).toBe(false);
    expect(shotWithheld(err)).toBe(true);
  });

  it('a reveal that won’t close is blanked before the error leaves', async () => {
    const f = fakePage({ doneCloses: false });
    const err = await takeRevealedToken({ page: f.page }, async () => undefined).catch(
      (e: unknown) => e,
    );
    expect(f.events.at(-1)).toBe('goto about:blank');
    expect(f.shown()).toBe(false);
    expect(shotWithheld(err)).toBe(true);
    expect(String(err)).not.toContain(TOKEN);
  });

  it('a mint click that throws is blanked too — the reveal may still come', async () => {
    const f = fakePage();
    const err = await takeRevealedToken({ page: f.page }, async () => {
      throw new Error('click timed out');
    }).catch((e: unknown) => e);
    expect(f.events).toEqual(['goto about:blank']);
    expect(shotWithheld(err)).toBe(true);
  });

  it('a page that won’t navigate still rethrows the step’s error, marked so no failure shot is taken', async () => {
    const f = fakePage({ revealShows: false, gotoFails: true });
    const err = await takeRevealedToken({ page: f.page }, async () => undefined).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toBe('Timeout 15000ms exceeded');
    expect(shotWithheld(err)).toBe(true);
  });
});
