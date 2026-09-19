// The one module that knows an attachment URL might be a stub sentinel. In stub mode the ApiClient
// returns `stub:<id>` and the bytes never leave the browser — we keep the File in memory and hand back
// an object URL. In HTTP mode the URL is a real presigned S3 URL and we PUT/GET it directly. This is the
// only place binary is handled; the ApiClient/RPC layer stays strictly JSON.

const STUB = 'stub:';
const stubBlobs = new Map<string, Blob>();

// PUT the bytes to the presigned URL. `contentType` MUST be the server-signed value (the presigned PUT
// signs content-type; sending a different one fails S3's signature check). fetch can't report upload
// progress, so this uses XMLHttpRequest.
export async function uploadTo(
  url: string,
  file: File,
  contentType: string,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  if (url.startsWith(STUB)) {
    stubBlobs.set(url.slice(STUB.length), file);
    onProgress?.(1);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.send(file);
  });
}

// Resolve a URL for viewing/downloading. A stub sentinel becomes an object URL, or null if the blob is
// gone (the map is in-memory only, so a page reload loses it — the row then renders "not available");
// a real presigned URL passes straight through.
export function resolveViewUrl(url: string): string | null {
  if (!url.startsWith(STUB)) return url;
  const blob = stubBlobs.get(url.slice(STUB.length));
  if (!blob) return null;
  try {
    return URL.createObjectURL(blob);
  } catch {
    return null; // jsdom lacks createObjectURL
  }
}
