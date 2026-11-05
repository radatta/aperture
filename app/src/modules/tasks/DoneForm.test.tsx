import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TASK_REFLECTION_MAX } from '@aperture/shared';
import type { ApiClient, Task } from '@aperture/shared';
import { renderWithProviders } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';
import { DoneForm } from './DoneForm';

function api(): ApiClient {
  return createStubClient({ seed: false, storageKey: `done-${Math.random()}` });
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
});
