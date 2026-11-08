import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApiClient } from '@aperture/shared';
import { renderWithProviders } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';
import { EstimateChips } from './EstimateChips';

const api = (): ApiClient =>
  createStubClient({ seed: false, storageKey: `chips-${Math.random()}` });

async function setup() {
  const client = api();
  const task = await client.createTask({ title: 'Unscoped' });
  const onClose = vi.fn();
  const startRef = createRef<HTMLButtonElement>();
  renderWithProviders(
    <>
      <button ref={startRef}>Start</button>
      <EstimateChips task={task} startRef={startRef} onClose={onClose} />
    </>,
    { api: client },
  );
  return { client, task, onClose, user: userEvent.setup() };
}

describe('EstimateChips', () => {
  it('a chip lands the estimate before the start, so the lock freezes on it', async () => {
    const { client, task, onClose, user } = await setup();
    await user.click(screen.getByRole('button', { name: '30' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(await client.getTask(task.id)).toMatchObject({
      status: 'in_progress',
      estimateMin: 30,
      estimateLockedMin: 30,
    });
  });

  it('offers 15 to 120 and Custom', async () => {
    await setup();
    for (const m of ['15', '30', '45', '60', '90', '120', 'Custom'])
      expect(screen.getByRole('button', { name: m })).toBeTruthy();
  });

  it('Start without one starts with no lock', async () => {
    const { client, task, onClose, user } = await setup();
    await user.click(screen.getByRole('button', { name: 'Start without one' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(await client.getTask(task.id)).toMatchObject({
      status: 'in_progress',
      estimateMin: null,
      estimateLockedMin: null,
    });
  });

  it('Cancel closes and writes nothing', async () => {
    const { client, task, onClose, user } = await setup();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Start' }));
    expect(await client.getTask(task.id)).toMatchObject({ status: 'backlog', estimateMin: null });
  });

  it('custom: 0 is refused with a message, a real number starts', async () => {
    const { client, task, onClose, user } = await setup();
    await user.click(screen.getByRole('button', { name: 'Custom' }));
    await user.type(screen.getByLabelText('Estimate (min)'), '0');
    expect(screen.getByText('Whole minutes, at least 1.')).toBeTruthy();
    const go = screen.getByRole('button', { name: 'Start with this' });
    expect((go as HTMLButtonElement).disabled).toBe(true);
    await user.clear(screen.getByLabelText('Estimate (min)'));
    await user.type(screen.getByLabelText('Estimate (min)'), '1.5');
    expect((go as HTMLButtonElement).disabled).toBe(true);
    await user.clear(screen.getByLabelText('Estimate (min)'));
    await user.type(screen.getByLabelText('Estimate (min)'), '25{Enter}'); // the return key starts it
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect((await client.getTask(task.id))?.estimateLockedMin).toBe(25);
  });

  it('Cancel holds while a start is on its way', async () => {
    const { client, onClose, user } = await setup();
    let land = () => {};
    const estimate = client.setTaskEstimate.bind(client);
    vi.spyOn(client, 'setTaskEstimate').mockImplementationOnce(
      (...a) =>
        new Promise((r) => {
          land = () => r(estimate(...a));
        }),
    );
    await user.click(screen.getByRole('button', { name: '30' }));
    expect(screen.getByRole('button', { name: 'Cancel' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    land();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('a failed start stays open and says so; the retry starts it', async () => {
    const { client, task, onClose, user } = await setup();
    const spy = vi.spyOn(client, 'transitionTask').mockRejectedValueOnce(new Error('nope'));
    await user.click(screen.getByRole('button', { name: '45' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn.t start it/);
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '45' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    spy.mockRestore();
    expect((await client.getTask(task.id))?.estimateLockedMin).toBe(45);
  });
});
