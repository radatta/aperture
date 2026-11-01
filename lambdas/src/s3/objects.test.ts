import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { createS3ObjectStore, fakeObjectStore, noopObjectStore } from './objects';

describe('s3 object store', () => {
  it('sends one DeleteObject for exactly the bucket and key', async () => {
    const send = vi.fn().mockResolvedValue({});
    await createS3ObjectStore('aperture-files', { send } as never).deleteObject('u/alice/t1/att1');
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0]![0];
    expect(cmd).toBeInstanceOf(DeleteObjectCommand);
    expect(cmd.input).toEqual({ Bucket: 'aperture-files', Key: 'u/alice/t1/att1' });
  });

  it('logs one structured line and rethrows when S3 fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = vi.fn().mockRejectedValue(new Error('AccessDenied'));
    await expect(
      createS3ObjectStore('b', { send } as never).deleteObject('u/alice/t1/att1'),
    ).rejects.toThrow('AccessDenied');
    expect(JSON.parse(err.mock.calls[0]![0] as string)).toMatchObject({
      event: 's3_delete_failed',
      key: 'u/alice/t1/att1',
    });
    err.mockRestore();
  });

  it('the fake records keys and fails once on demand; the noop records nothing', async () => {
    const fake = fakeObjectStore();
    fake.failNext = new Error('boom');
    await expect(fake.deleteObject('k1')).rejects.toThrow('boom');
    await fake.deleteObject('k2');
    expect(fake.deleted).toEqual(['k2']);
    await expect(noopObjectStore().deleteObject('k')).resolves.toBeUndefined();
  });
});
