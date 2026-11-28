import { describe, expect, it } from 'vitest';
import { createStubClient } from '../data/stubClient';
import { realWait } from './realWait';
import { renderWithProviders, timersAdopted } from './utils';

const api = () => createStubClient({ seed: false, storageKey: `adopt-${Math.random()}` });

// Order is load-bearing (the last test reads what the one before it left), so it stays fixed whatever the shuffle.
describe('timersAdopted()', { shuffle: false }, () => {
  it('waits once per render: a second call throws', async () => {
    renderWithProviders(<p>x</p>, { api: api() });
    await timersAdopted();
    await expect(timersAdopted()).rejects.toThrow(/no adopt read found/);
  });

  it('a test that renders and lets the read land another way leaves its read behind', async () => {
    renderWithProviders(<p>x</p>, { api: api() });
    await realWait(20);
  });

  it('throws in a test with no render of its own, not waiting on an earlier test’s read', async () => {
    await expect(timersAdopted()).rejects.toThrow(/no adopt read found/);
  });
});
