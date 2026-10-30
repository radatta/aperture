import { describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ulid, type RecordFluxSetInput } from '@aperture/shared';
import { renderWithProviders } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';
import { FLUX_OUTBOX_KEY } from './fluxOutbox';
import { UnsavedSetsStrip } from './UnsavedSetsStrip';
import { useFluxOutbox } from './useFluxOutbox';

// The outbox's send path (D49) under a controllable server: a first send in flight isn't "unsaved", a
// set is sent once however many triggers race, another tab's queue shows up, and nothing is silent.

const input = (over: Partial<RecordFluxSetInput> = {}): RecordFluxSetInput => ({
  id: ulid(),
  day: '2026-10-20',
  exerciseId: 'chin-tuck',
  kind: 'holdAtTarget',
  side: null,
  condition: null,
  count: 10,
  avgPeakDeg: null,
  avgErrorDeg: null,
  rom: { pitch: 8, yaw: 1, roll: 1 },
  calibrated: true,
  delegate: 'GPU',
  durationSec: 120,
  completedAt: 1_000,
  repTaskId: null,
  ...over,
});

function Harness({ set }: { set: RecordFluxSetInput }) {
  const o = useFluxOutbox();
  return (
    <>
      <button onClick={() => void o.save(set)}>save</button>
      <button onClick={() => void o.flush()}>flush</button>
      <UnsavedSetsStrip />
      <button>after</button>
    </>
  );
}

// A server whose answers the test hands out one by one.
function server() {
  const api = createStubClient({ seed: false, storageKey: `outbox-${Math.random()}` });
  const pending: { resolve: () => void; reject: (e: Error) => void }[] = [];
  const record = vi.fn<(input: RecordFluxSetInput) => Promise<never>>(
    () =>
      new Promise<never>((resolve, reject) =>
        pending.push({ resolve: () => resolve(undefined as never), reject }),
      ),
  );
  api.recordFluxSet = record;
  return { api, record, pending };
}

describe('useFluxOutbox', () => {
  it('a first send on its way shows no strip; its failure does', async () => {
    const { api, pending } = server();
    const user = userEvent.setup();
    renderWithProviders(<Harness set={input()} />, { api });
    await user.click(screen.getByRole('button', { name: 'save' }));
    expect(localStorage.getItem(FLUX_OUTBOX_KEY)).not.toBeNull(); // guarded before it's sent
    expect(screen.queryByText(/not saved yet/)).toBeNull();
    await act(async () => pending[0]!.reject(new Error('Load failed')));
    expect(await screen.findByText('1 set not saved yet')).toBeTruthy();
    expect(screen.getByText(/Last try: Load failed/)).toBeTruthy();
  });

  it('a send still waiting after the grace counts as unsaved', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const { api } = server();
    renderWithProviders(<Harness set={input()} />, { api });
    act(() => screen.getByRole('button', { name: 'save' }).click());
    expect(screen.queryByText(/not saved yet/)).toBeNull();
    act(() => vi.advanceTimersByTime(8_000));
    expect(screen.getByText('1 set not saved yet')).toBeTruthy();
  });

  it('a save and a flush racing send the set once', async () => {
    const { api, record, pending } = server();
    const user = userEvent.setup();
    renderWithProviders(<Harness set={input()} />, { api });
    await user.click(screen.getByRole('button', { name: 'save' }));
    await user.click(screen.getByRole('button', { name: 'flush' }));
    await user.click(screen.getByRole('button', { name: 'flush' }));
    expect(record).toHaveBeenCalledTimes(1);
    await act(async () => pending[0]!.resolve());
    await waitFor(() => expect(localStorage.getItem(FLUX_OUTBOX_KEY)).toBeNull());
  });

  it('another tab’s queued set shows through the storage event', async () => {
    const { api } = server();
    renderWithProviders(<UnsavedSetsStrip />, { api });
    expect(screen.queryByText(/not saved yet/)).toBeNull();
    const raw = JSON.stringify([{ input: input(), at: 1, error: 'offline' }]);
    localStorage.setItem(FLUX_OUTBOX_KEY, raw);
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: FLUX_OUTBOX_KEY })));
    expect(screen.getByText('1 set not saved yet')).toBeTruthy();
  });

  it('a set the shared rules refuse is never sent, and says it can’t be saved', async () => {
    const { api, record } = server();
    const user = userEvent.setup();
    renderWithProviders(<Harness set={input({ count: -1 })} />, { api });
    await user.click(screen.getByRole('button', { name: 'save' }));
    expect(await screen.findByText(/Can’t be saved: .*whole number/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'flush' }));
    expect(record).not.toHaveBeenCalled();
  });

  it('says so when this device can’t store the set', async () => {
    const { api, pending } = server();
    const user = userEvent.setup();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    renderWithProviders(<Harness set={input()} />, { api });
    await user.click(screen.getByRole('button', { name: 'save' }));
    await act(async () => pending[0]!.reject(new Error('Load failed')));
    expect(await screen.findByText(/can’t store it — keep Flux open until it saves/)).toBeTruthy();
  });

  it('focus moves on to what follows when a Retry saves or a Discard clears the strip', async () => {
    const { api, pending } = server();
    const user = userEvent.setup();
    renderWithProviders(<Harness set={input()} />, { api });
    await user.click(screen.getByRole('button', { name: 'save' }));
    await act(async () => pending[0]!.reject(new Error('Load failed')));
    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    await act(async () => pending[1]!.resolve());
    await waitFor(() => expect(screen.queryByText(/not saved yet/)).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'after' }));
    // Again, ending in Discard.
    await user.click(screen.getByRole('button', { name: 'save' })); // the same id: already saved, re-queued
    await act(async () => pending[2]!.reject(new Error('Load failed')));
    await user.click(await screen.findByRole('button', { name: 'Discard' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard' }),
    );
    expect(screen.queryByText(/not saved yet/)).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'after' }));
  });
});
