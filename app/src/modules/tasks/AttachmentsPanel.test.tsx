import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ATTACHMENT_MAX_BYTES } from '@aperture/shared';
import { renderWithProviders } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';
import { uploadTo } from '../../data/attachmentTransport';
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

  it('mints a fresh download url on click and opens it in the pre-opened tab', async () => {
    const { api, task } = await setup();
    const { attachment } = await api.createAttachmentUploadUrl({
      taskId: task.id,
      filename: 'a.pdf',
      contentType: 'application/pdf',
      size: 10,
    });
    await api.confirmAttachment(attachment.id);
    // Register a blob so the stub's resolveViewUrl returns one (the transport map is module-scoped).
    await uploadTo(`stub:${attachment.id}`, file('a.pdf', 10, 'application/pdf'), 'application/pdf');

    const fakeTab = { location: { href: '' }, close: vi.fn(), opener: {} };
    vi.spyOn(window, 'open').mockReturnValue(fakeTab as unknown as Window);
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = () => 'blob:fake'; // jsdom lacks it
    const spy = vi.spyOn(api, 'getAttachmentDownloadUrl');

    try {
      const user = userEvent.setup();
      renderWithProviders(<AttachmentsPanel taskId={task.id} />, { api });
      await user.click(await screen.findByRole('button', { name: /^a\.pdf/ }));
      await waitFor(() => expect(fakeTab.location.href).toBe('blob:fake'));
      expect(spy).toHaveBeenCalledTimes(1); // minted at click, not at mount (a PDF has no thumbnail)
      expect(window.open).toHaveBeenCalledWith('', '_blank');
    } finally {
      URL.createObjectURL = origCreate;
    }
  });

  it('closes the tab and marks the row unavailable when the stub blob is gone', async () => {
    const { api, task } = await setup();
    const { attachment } = await api.createAttachmentUploadUrl({
      taskId: task.id,
      filename: 'b.pdf',
      contentType: 'application/pdf',
      size: 10,
    });
    await api.confirmAttachment(attachment.id);
    // No uploadTo → the stub has no blob for this id → resolveViewUrl returns null (the reload case).

    const fakeTab = { location: { href: '' }, close: vi.fn(), opener: {} };
    vi.spyOn(window, 'open').mockReturnValue(fakeTab as unknown as Window);

    const user = userEvent.setup();
    renderWithProviders(<AttachmentsPanel taskId={task.id} />, { api });
    await user.click(await screen.findByRole('button', { name: /^b\.pdf/ }));
    await waitFor(() => expect(fakeTab.close).toHaveBeenCalled());
    expect(await screen.findByText(/not available/i)).toBeTruthy();
    // The row stays clickable — a transient failure must be retryable, not permanently locked.
    expect((screen.getByRole('button', { name: /^b\.pdf/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('uploads a file dropped onto the panel', async () => {
    const { api, task } = await setup();
    renderWithProviders(<AttachmentsPanel taskId={task.id} />, { api });

    const zone = screen.getByRole('group', { name: 'Task files' });
    fireEvent.drop(zone, { dataTransfer: { files: [file('dropped.png', 100)], types: ['Files'] } });

    expect(await screen.findByText('dropped.png')).toBeTruthy();
    await waitFor(async () =>
      expect((await api.listAttachments(task.id)).map((a) => a.filename)).toEqual(['dropped.png']),
    );
  });

  it('rejects an oversized dropped file with the cap message (same path as the button)', async () => {
    const { api, task } = await setup();
    const spy = vi.spyOn(api, 'createAttachmentUploadUrl');
    renderWithProviders(<AttachmentsPanel taskId={task.id} />, { api });

    const zone = screen.getByRole('group', { name: 'Task files' });
    fireEvent.drop(zone, {
      dataTransfer: { files: [file('huge.png', ATTACHMENT_MAX_BYTES + 1)], types: ['Files'] },
    });

    expect(await screen.findByText(/too large/i)).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });
});
