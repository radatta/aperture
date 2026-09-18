import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ATTACHMENT_MAX_BYTES } from '@aperture/shared';
import { renderWithProviders } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';
import { AttachmentsPanel } from './AttachmentsPanel';

afterEach(() => vi.restoreAllMocks());

async function setup() {
  const api = createStubClient({ seed: false, storageKey: `att-${Math.random()}` });
  const task = await api.createTask({ title: 'has files' });
  return { api, task };
}

function file(name: string, size: number, type = 'image/png') {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size }); // jsdom doesn't derive size from parts reliably
  return f;
}

const fileInput = () => document.querySelector('input[type=file]') as HTMLInputElement;

describe('attachments panel', () => {
  it('uploads a file and shows it in the list', async () => {
    const { api, task } = await setup();
    const user = userEvent.setup();
    renderWithProviders(<AttachmentsPanel taskId={task.id} />, { api });

    await user.upload(fileInput(), file('report.png', 100));

    expect(await screen.findByText('report.png')).toBeTruthy();
    await waitFor(async () =>
      expect((await api.listAttachments(task.id)).map((a) => a.filename)).toEqual(['report.png']),
    );
  });

  it('rejects a file over the size cap and never calls the API', async () => {
    const { api, task } = await setup();
    const spy = vi.spyOn(api, 'createAttachmentUploadUrl');
    const user = userEvent.setup();
    renderWithProviders(<AttachmentsPanel taskId={task.id} />, { api });

    await user.upload(fileInput(), file('huge.png', ATTACHMENT_MAX_BYTES + 1));

    expect(await screen.findByText(/too large/i)).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
    expect(await api.listAttachments(task.id)).toHaveLength(0);
  });

  it('asks before deleting an attachment', async () => {
    const { api, task } = await setup();
    const { attachment } = await api.createAttachmentUploadUrl({
      taskId: task.id,
      filename: 'a.pdf',
      contentType: 'application/pdf',
      size: 10,
    });
    await api.confirmAttachment(attachment.id);
    const user = userEvent.setup();
    renderWithProviders(<AttachmentsPanel taskId={task.id} />, { api });

    await user.click(await screen.findByRole('button', { name: 'Delete a.pdf' }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(await api.listAttachments(task.id)).toHaveLength(1); // confirm only; nothing deleted yet

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(async () => expect(await api.listAttachments(task.id)).toHaveLength(0));
  });
});
