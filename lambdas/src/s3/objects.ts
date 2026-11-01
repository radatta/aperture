import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';

// The S3 object seam: the one S3 API call the Lambda makes itself (signing aside, presigner.ts). A gated
// gateway like Google/Plaid — handleRpc pins the noop in testMode, so a smoke run deletes nothing.
export interface ObjectStore {
  // Idempotent: S3 answers 204 for a key that's already gone. On the versioned Files bucket a plain
  // delete writes a delete marker; the bytes stay as a noncurrent version for 30 days (data-stack.ts).
  deleteObject(key: string): Promise<void>;
}

type Sender = Pick<S3Client, 'send'>;

export function createS3ObjectStore(
  bucket: string,
  client: Sender = new S3Client({}),
): ObjectStore {
  return {
    deleteObject: async (key) => {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch (e) {
        // One structured line for `pnpm bot logs`; the caller still gets the throw.
        console.error(JSON.stringify({ event: 's3_delete_failed', key, error: String(e) }));
        throw e;
      }
    },
  };
}

// Records every key; `failNext` makes the next call throw once (tests).
export function fakeObjectStore(): ObjectStore & { deleted: string[]; failNext?: Error } {
  const store: ObjectStore & { deleted: string[]; failNext?: Error } = {
    deleted: [],
    deleteObject: async (key) => {
      const err = store.failNext;
      if (err) {
        store.failNext = undefined;
        throw err;
      }
      store.deleted.push(key);
    },
  };
  return store;
}

export const noopObjectStore = (): ObjectStore => ({ deleteObject: async () => {} });
