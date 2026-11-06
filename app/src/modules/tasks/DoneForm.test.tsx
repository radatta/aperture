import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TASK_REFLECTION_MAX } from '@aperture/shared';
import type { ApiClient, Task } from '@aperture/shared';
import type { ReactNode } from 'react';
import { renderWithProviders } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';
import { usePomodoro } from '../pomodoro/pomodoro-context';
import { DoneForm } from './DoneForm';

function api(now?: () => number): ApiClient {
  return createStubClient({ seed: false, storageKey: `done-${Math.random()}`, now });
}

// Mounts its children once the timer engine has adopted a running session, as the real app has long before a
// Done form opens — the form reads the running timers when it mounts.
function WhenAdopted({ children }: { children: ReactNode }) {
  const { timers } = usePomodoro();
  return timers.length ? children : null;
}

// A task with a work timer that has already run `minutesAgo` minutes: the stub's clock sits that far behind
// while the session starts, and a heartbeat at real time banks the gap (and keeps the timer fresh enough for
// the engine to adopt it rather than hold it as stale).
async function timed(minutesAgo: number) {
  let behindMs = minutesAgo * 60_000;
  const client = api(() => Date.now() - behindMs);
  const task = await started(client);
  const session = await client.startSession({
    taskId: task.id,
    categoryId: null,
    kind: 'work',
    day: '2026-08-04',
  });
  behindMs = 0;
  await client.heartbeatSession(session.id);
  return { client, task, session };
}

async function started(client: ApiClient): Promise<Task> {
  const t = await client.createTask({ title: 'Pset', estimateMin: 30, bufferMin: 0 });
  return client.transitionTask(t.id, 'in_progress');
}

function renderDone(client: ApiClient, task: Task) {
  const onDone = vi.fn();
  renderWithProviders(<DoneForm task={task} initialActualMin={40} onDone={onDone} />, {
    api: client,
  });
  return { onDone, user: userEvent.setup() };
}

describe('DoneForm', () => {
  it('Mark done sends the reflection with the actual; left alone, it sends none', async () => {
    const client = api();
    const task = await started(client);
    const setActual = vi.spyOn(client, 'setTaskActual');
    const { onDone, user } = renderDone(client, task);
    // Focus is the caller's (actualRef), never the reflection's.
    expect(document.activeElement).not.toBe(screen.getByLabelText('Reflection'));

    await user.type(screen.getByLabelText('Reflection'), '  Should have outlined first  ');
    await user.click(screen.getByRole('button', { name: 'Mark done' }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(setActual).toHaveBeenCalledWith(task.id, 40, 'Should have outlined first');
    const saved = await client.getTask(task.id);
    expect(saved?.status).toBe('done');
    expect(saved?.reflection).toBe('Should have outlined first');

    const blank = await started(client);
    const second = renderDone(client, blank);
    await second.user.click(screen.getAllByRole('button', { name: 'Mark done' }).at(-1)!);
    await waitFor(() => expect(second.onDone).toHaveBeenCalled());
    expect(setActual).toHaveBeenLastCalledWith(blank.id, 40, undefined); // nothing to change
  });

  it('left as seeded, a reflection saved meanwhile is kept; cleared, it sends null', async () => {
    const client = api();
    const task = await started(client);
    const first = renderDone(client, task);
    // Saved elsewhere (MCP, another device) after the form opened with an empty field.
    await client.setTaskReflection(task.id, 'from MCP');
    await first.user.click(screen.getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(first.onDone).toHaveBeenCalled());
    expect((await client.getTask(task.id))?.reflection).toBe('from MCP');

    const seeded = await started(client);
    await client.setTaskReflection(seeded.id, 'old');
    const second = renderDone(client, (await client.getTask(seeded.id))!);
    const box = screen.getAllByLabelText(/^Reflection/).at(-1)!;
    expect((box as HTMLTextAreaElement).value).toBe('old');
    await second.user.clear(box);
    await second.user.click(screen.getAllByRole('button', { name: 'Mark done' }).at(-1)!);
    await waitFor(() => expect(second.onDone).toHaveBeenCalled());
    expect((await client.getTask(seeded.id))?.reflection).toBeNull();
  });

  it('a reflection over the cap disables Mark done and says so', async () => {
    const client = api();
    const task = await started(client);
    renderDone(client, task);
    const box = screen.getByLabelText('Reflection');
    expect(screen.queryByText(/\/ 1,000/)).toBeNull(); // the counter stays out of the way

    fireEvent.change(box, { target: { value: 'x'.repeat(TASK_REFLECTION_MAX + 1) } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Mark done' }).disabled).toBe(
      true,
    );
    expect(screen.getByText(/1,001 \/ 1,000 · too long to save/)).toBeTruthy();

    fireEvent.change(box, { target: { value: 'x'.repeat(TASK_REFLECTION_MAX) } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Mark done' }).disabled).toBe(
      false,
    );
  });

  it('Mark done stops the running session first; its minutes land, the typed actual stands', async () => {
    const { client, task, session } = await timed(7);
    const order: string[] = [];
    const stopSession = client.stopSession.bind(client);
    const setTaskActual = client.setTaskActual.bind(client);
    vi.spyOn(client, 'stopSession').mockImplementation((...a) => {
      order.push('stop');
      return stopSession(...a);
    });
    vi.spyOn(client, 'setTaskActual').mockImplementation((...a) => {
      order.push('actual');
      return setTaskActual(...a);
    });
    const onDone = vi.fn();
    renderWithProviders(
      <WhenAdopted>
        <DoneForm task={task} onDone={onDone} />
      </WhenAdopted>,
      { api: client },
    );
    const user = userEvent.setup();
    // Prefilled from the live timer, not the task's persisted 0.
    const actual = await screen.findByLabelText<HTMLInputElement>('Actual (min)');
    expect(actual.value).toBe('7');

    await user.clear(actual);
    await user.type(actual, '30');
    await user.click(screen.getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());

    expect(order).toEqual(['stop', 'actual']);
    expect(await client.listRunningSessions()).toEqual([]);
    const stopped = (await client.listSessionsForDay('2026-08-04')).find(
      (s) => s.id === session.id,
    );
    expect(stopped?.status).toBe('completed');
    expect(stopped?.activeMinutes).toBeCloseTo(7, 0); // history keeps the time
    expect(await client.getTask(task.id)).toMatchObject({ status: 'done', actualAccruedMin: 30 });
  });

  it('a stop that fails keeps the form, the timer and the typed actual; the task stays in progress', async () => {
    const { client, task, session } = await timed(2);
    vi.spyOn(client, 'stopSession').mockRejectedValue(new Error('offline'));
    const setActual = vi.spyOn(client, 'setTaskActual');
    const onDone = vi.fn();
    renderWithProviders(
      <WhenAdopted>
        <DoneForm task={task} onDone={onDone} />
      </WhenAdopted>,
      { api: client },
    );
    const user = userEvent.setup();
    const actual = await screen.findByLabelText<HTMLInputElement>('Actual (min)');
    await user.clear(actual);
    await user.type(actual, '25');
    await user.click(screen.getByRole('button', { name: 'Mark done' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn’t mark it done/);
    expect(screen.getByLabelText<HTMLInputElement>('Actual (min)').value).toBe('25');
    expect(onDone).not.toHaveBeenCalled();
    expect(setActual).not.toHaveBeenCalled(); // nothing after a stop that didn't land
    expect((await client.listRunningSessions()).map((s) => s.id)).toEqual([session.id]);
    expect((await client.getTask(task.id))?.status).toBe('in_progress');
  });

  it('a block sitting on Done prefills Actual with its length, not the wait', async () => {
    const client = api();
    const task = await started(client);
    const s = await client.startSession({
      taskId: task.id,
      categoryId: null,
      kind: 'work',
      day: '2026-08-04',
    });
    // 24.9 minutes banked, last beat 80 s ago (still fresh): the count would read 26.2 without the hold.
    client.listRunningSessions = async () => [
      { ...s, activeMinutes: 24.9, lastHeartbeatAt: Date.now() - 80_000 },
    ];
    renderWithProviders(
      <WhenAdopted>
        <DoneForm task={task} onDone={vi.fn()} />
      </WhenAdopted>,
      { api: client },
    );
    expect(((await screen.findByLabelText('Actual (min)')) as HTMLInputElement).value).toBe('25');
  });

  it('a failed Mark done keeps the reflection text', async () => {
    const client = api();
    const task = await started(client);
    vi.spyOn(client, 'setTaskActual').mockRejectedValue(new Error('offline'));
    const { onDone, user } = renderDone(client, task);

    await user.type(screen.getByLabelText('Reflection'), 'Keep me');
    await user.click(screen.getByRole('button', { name: 'Mark done' }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByLabelText<HTMLTextAreaElement>('Reflection').value).toBe('Keep me');
    expect(onDone).not.toHaveBeenCalled();
  });
  describe('the done gate', () => {
    async function unscoped(client: ApiClient) {
      const t = await client.createTask({ title: 'Unscoped' });
      return client.transitionTask(t.id, 'in_progress');
    }
    const markDone = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Mark done' });

    it('a scoped task is not asked for an estimate', async () => {
      const client = api();
      renderDone(client, await started(client));
      expect(screen.queryByLabelText('Estimate (min)')).toBeNull();
    });

    it('an unscoped task needs the estimate, which lands first and marks it retro', async () => {
      const client = api();
      const task = await unscoped(client);
      const { onDone, user } = renderDone(client, task);
      expect(markDone().disabled).toBe(true);
      await user.type(screen.getByLabelText('Estimate (min)'), '25');
      expect(markDone().disabled).toBe(false);
      const estimate = vi.spyOn(client, 'setTaskEstimate');
      const actual = vi.spyOn(client, 'setTaskActual');
      await user.click(markDone());
      await waitFor(() => expect(onDone).toHaveBeenCalled());
      expect(estimate.mock.invocationCallOrder[0]).toBeLessThan(
        actual.mock.invocationCallOrder[0]!,
      );
      expect(await client.getTask(task.id)).toMatchObject({
        status: 'done',
        estimateMin: 25,
        estimateLockedMin: 25,
        estimateSource: 'retro',
        actualAccruedMin: 40,
      });
    });

    it('a typed 0 blocks Mark done and says why, on either number', async () => {
      const client = api();
      const { user } = renderDone(client, await unscoped(client));
      await user.type(screen.getByLabelText('Estimate (min)'), '0');
      expect(screen.getByText('Minutes need to be at least 1.')).toBeTruthy();
      expect(markDone().disabled).toBe(true);
      await user.clear(screen.getByLabelText('Estimate (min)'));
      await user.type(screen.getByLabelText('Estimate (min)'), '20');
      await user.clear(screen.getByLabelText('Actual (min)'));
      await user.type(screen.getByLabelText('Actual (min)'), '0');
      expect(screen.getByText('Minutes need to be at least 1.')).toBeTruthy();
      expect(markDone().disabled).toBe(true);
    });

    it('an estimate write that fails keeps the form and says so', async () => {
      const client = api();
      const task = await unscoped(client);
      const { onDone, user } = renderDone(client, task);
      vi.spyOn(client, 'setTaskEstimate').mockRejectedValueOnce(new Error('nope'));
      await user.type(screen.getByLabelText('Estimate (min)'), '25');
      await user.click(markDone());
      expect(await screen.findByRole('alert')).toBeTruthy();
      expect(onDone).not.toHaveBeenCalled();
      expect((await client.getTask(task.id))?.status).toBe('in_progress');
    });
  });
});
