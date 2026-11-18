import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { launch } from './browser';
import type { PwModule } from './pw-types';

const fakePw = () => {
  const newContext = vi.fn(async () => ({}));
  const pw = { chromium: { launch: vi.fn(async () => ({ newContext })) } } as unknown as PwModule;
  return { pw, newContext };
};
const opts = (newContext: ReturnType<typeof fakePw>['newContext']) =>
  (newContext.mock.calls[0] as unknown[])[0] as Record<string, unknown>;

describe('launch', () => {
  it('hands an in-memory state to the context as it is', async () => {
    const { pw, newContext } = fakePw();
    const state = { cookies: [], origins: [] };
    await launch(pw, state);
    expect(opts(newContext).storageState).toBe(state);
  });
  it('passes a path that exists, and nothing for a missing path or none', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'state-')), 'state.json');
    writeFileSync(path, '{}');
    for (const [arg, want] of [
      [path, path],
      [`${path}.gone`, undefined],
      [undefined, undefined],
    ] as const) {
      const { pw, newContext } = fakePw();
      await launch(pw, arg);
      expect(opts(newContext).storageState).toBe(want);
    }
  });
});
