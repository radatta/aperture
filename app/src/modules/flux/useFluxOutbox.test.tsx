import { describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ulid, type RecordFluxSetInput } from '@aperture/shared';
import { renderWithProviders } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';
import { FLUX_OUTBOX_KEY, outboxAdd, outboxMarkError } from './fluxOutbox';
import { UnsavedSetsStrip } from './UnsavedSetsStrip';
import { useFluxOutbox, useFluxOutboxFlush } from './useFluxOutbox';

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

  it('a send still waiting after the grace shows even if the clock stepped back', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const { api } = server();
    renderWithProviders(<Harness set={input()} />, { api });
    act(() => screen.getByRole('button', { name: 'save' }).click());
    vi.setSystemTime(Date.now() - 2_000); // the timer will fire 2 s inside the grace
    act(() => vi.advanceTimersByTime(8_000));
    expect(screen.queryByText(/not saved yet/)).toBeNull();
    act(() => vi.advanceTimersByTime(2_000)); // re-armed, not given up
    expect(screen.getByText('1 set not saved yet')).toBeTruthy();
  });

  it('a send that never answers times out, so Retry can send it again', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const { api, record } = server();
    renderWithProviders(<Harness set={input()} />, { api });
    act(() => screen.getByRole('button', { name: 'save' }).click());
    await act(async () => vi.advanceTimersByTime(20_000));
    expect(screen.getByText(/Last try: No answer from the server/)).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(FLUX_OUTBOX_KEY) ?? '[]')[0]?.unanswered).toBe(true);
    await act(async () => screen.getByRole('button', { name: 'Retry' }).click());
    expect(record).toHaveBeenCalledTimes(2);
  });

  it('a refused set and a waiting one both say what’s true, and Retry stays for the waiting one', async () => {
    const { api } = server();
    const raw = JSON.stringify([
      { input: input(), at: 1, error: 'A Flux set count must be a whole number.', refused: true },
      { input: input(), at: 2, error: 'Load failed' },
    ]);
    localStorage.setItem(FLUX_OUTBOX_KEY, raw);
    renderWithProviders(<UnsavedSetsStrip />, { api });
    expect(screen.getByText('2 sets not saved yet')).toBeTruthy();
    expect(
      screen.getByText('1 can’t be saved: A Flux set count must be a whole number.'),
    ).toBeTruthy();
    expect(screen.getByText(/retried when you’re back online. Last try: Load failed/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('the storage warning follows where the list lives, even with the same contents', async () => {
    const { api } = server();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const a = input();
    outboxAdd(a, 1);
    outboxMarkError(a.id, 'Load failed');
    renderWithProviders(<UnsavedSetsStrip />, { api });
    expect(screen.getByText(/can’t store it/)).toBeTruthy();
    setItem.mockRestore();
    act(() => outboxMarkError(a.id, 'Load failed')); // same contents, now in storage
    expect(screen.getByText(/Kept on this device and retried/)).toBeTruthy();
  });

  it('a slow Retry doesn’t pull focus back from where the user moved it', async () => {
    const { api, pending } = server();
    const user = userEvent.setup();
    renderWithProviders(<Harness set={input()} />, { api });
    await user.click(screen.getByRole('button', { name: 'save' }));
    await act(async () => pending[0]!.reject(new Error('Load failed')));
    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    const elsewhere = screen.getByRole('button', { name: 'flush' });
    elsewhere.focus();
    await act(async () => pending[1]!.resolve());
    await waitFor(() => expect(screen.queryByText(/not saved yet/)).toBeNull());
    expect(document.activeElement).toBe(elsewhere);
  });

  it('keeps its live region mounted while empty, so the strip arriving is announced', async () => {
    const { api } = server();
    renderWithProviders(<UnsavedSetsStrip />, { api });
    const region = screen.getByRole('status');
    expect(region.textContent).toBe('');
    localStorage.setItem(FLUX_OUTBOX_KEY, JSON.stringify([{ input: input(), at: 1, error: 'x' }]));
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: FLUX_OUTBOX_KEY })));
    expect(screen.getByRole('status')).toBe(region);
    expect(region.textContent).toMatch(/1 set not saved yet/);
  });

  it('a Discard question left open closes when the strip empties on its own', async () => {
    const { api, pending } = server();
    const user = userEvent.setup();
    renderWithProviders(<Harness set={input()} />, { api });
    await user.click(screen.getByRole('button', { name: 'save' }));
    await act(async () => pending[0]!.reject(new Error('Load failed')));
    await user.click(await screen.findByRole('button', { name: 'Discard' }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'flush' })); // a background flush gets it through
    await act(async () => pending[1]!.resolve());
    await waitFor(() => expect(screen.queryByText(/not saved yet/)).toBeNull());
    await user.click(screen.getByRole('button', { name: 'save' })); // and the next failure…
    await act(async () => pending[2]!.reject(new Error('Load failed')));
    await screen.findByText('1 set not saved yet');
    expect(screen.queryByRole('alertdialog')).toBeNull(); // …starts at Retry, not mid-question
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('when only refused sets are left, Retry’s focus goes to Discard', async () => {
    const { api, pending } = server();
    const user = userEvent.setup();
    localStorage.setItem(
      FLUX_OUTBOX_KEY,
      JSON.stringify([{ input: input({ count: -1 }), at: 1, error: 'bad', refused: true }]),
    );
    renderWithProviders(<Harness set={input()} />, { api });
    await user.click(screen.getByRole('button', { name: 'save' }));
    await act(async () => pending[0]!.reject(new Error('Load failed')));
    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    await act(async () => pending[1]!.resolve());
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Discard' }));
  });

  it('Discard waits while a set is still being sent', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const { api } = server();
    renderWithProviders(<Harness set={input()} />, { api });
    act(() => screen.getByRole('button', { name: 'save' }).click());
    act(() => vi.advanceTimersByTime(8_000)); // shown, but still on its way
    expect(screen.getByRole('button', { name: 'Discard' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
  });

  it('only the page’s focus rescue counts as lost focus — another tabindex=-1 target keeps it', async () => {
    const { api, pending } = server();
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <Harness set={input()} />
        <div tabIndex={-1} data-testid="announcer" />
      </>,
      { api },
    );
    await user.click(screen.getByRole('button', { name: 'save' }));
    await act(async () => pending[0]!.reject(new Error('Load failed')));
    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    const announcer = screen.getByTestId('announcer');
    announcer.focus(); // something on the page placed focus here on purpose
    await act(async () => pending[1]!.resolve());
    await waitFor(() => expect(screen.queryByText(/not saved yet/)).toBeNull());
    expect(document.activeElement).toBe(announcer);
  });

  it('a background flush that empties the strip moves focus on from inside it', async () => {
    const { api, pending } = server();
    const user = userEvent.setup();
    function Online() {
      useFluxOutboxFlush();
      return null;
    }
    renderWithProviders(
      <>
        <Online />
        <Harness set={input()} />
      </>,
      { api },
    );
    await user.click(screen.getByRole('button', { name: 'save' }));
    await act(async () => pending[0]!.reject(new Error('Load failed')));
    act(() => screen.getByRole('button', { name: 'Discard' }).focus());
    act(() => window.dispatchEvent(new Event('online')));
    await act(async () => pending[1]!.resolve());
    await waitFor(() => expect(screen.queryByText(/not saved yet/)).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'after' }));
  });

  it('a background resend blocks Discard — the trigger and an already-open question alike', async () => {
    const { api, pending } = server();
    const user = userEvent.setup();
    function Online() {
      useFluxOutboxFlush();
      return null;
    }
    renderWithProviders(
      <>
        <Online />
        <Harness set={input()} />
      </>,
      { api },
    );
    await user.click(screen.getByRole('button', { name: 'save' }));
    await act(async () => pending[0]!.reject(new Error('Load failed')));
    await user.click(await screen.findByRole('button', { name: 'Discard' })); // the question is open
    act(() => window.dispatchEvent(new Event('online'))); // …and a resend starts behind it
    const question = screen.getByRole('alertdialog');
    expect(question.textContent).toMatch(/Still sending/);
    const confirm = within(question).getByRole('button', { name: 'Discard' });
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    await user.click(confirm);
    expect(localStorage.getItem(FLUX_OUTBOX_KEY)).not.toBeNull(); // not discarded
    await user.click(within(question).getByRole('button', { name: 'Keep' }));
    const trigger = screen.getByRole('button', { name: 'Discard' });
    expect(trigger.getAttribute('aria-disabled')).toBe('true');
    await user.click(trigger);
    expect(screen.queryByRole('alertdialog')).toBeNull(); // the question doesn't open meanwhile
    expect(screen.getByRole('button', { name: 'Retrying…' })).toBeTruthy();
    await act(async () => pending[1]!.reject(new Error('Load failed'))); // the resend answers
    expect(
      screen.getByRole('button', { name: 'Discard' }).getAttribute('aria-disabled'),
    ).toBeNull();
  });

  it('focus that left the strip for somewhere real stays put when it empties', async () => {
    const { api, pending } = server();
    const user = userEvent.setup();
    renderWithProviders(<Harness set={input()} />, { api });
    await user.click(screen.getByRole('button', { name: 'save' }));
    await act(async () => pending[0]!.reject(new Error('Load failed')));
    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    await user.click(screen.getByRole('button', { name: 'flush' })); // the user moved on
    await act(async () => pending[1]!.resolve());
    await waitFor(() => expect(screen.queryByText(/not saved yet/)).toBeNull());
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'after' }));
  });

  it('focus that went from the strip straight to the page (a Safari tap) stays put', async () => {
    const { api, pending } = server();
    const user = userEvent.setup();
    renderWithProviders(<Harness set={input()} />, { api });
    await user.click(screen.getByRole('button', { name: 'save' }));
    await act(async () => pending[0]!.reject(new Error('Load failed')));
    const discard = await screen.findByRole('button', { name: 'Discard' });
    act(() => discard.focus());
    act(() => discard.blur()); // to body, no relatedTarget — and the button is still there
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    await user.click(screen.getByRole('button', { name: 'flush' }));
    act(() => (document.activeElement as HTMLElement).blur());
    await act(async () => pending[1]!.resolve());
    await waitFor(() => expect(screen.queryByText(/not saved yet/)).toBeNull());
    expect(document.activeElement).toBe(document.body);
  });

  it('after a try that timed out, Discard says it may still land', async () => {
    const { api } = server();
    const raw = JSON.stringify([
      { input: input(), at: 1, error: 'No answer from the server', unanswered: true },
    ]);
    localStorage.setItem(FLUX_OUTBOX_KEY, raw);
    const user = userEvent.setup();
    renderWithProviders(<UnsavedSetsStrip />, { api });
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByRole('alertdialog').textContent).toMatch(/may still reach the server/);
  });
});
