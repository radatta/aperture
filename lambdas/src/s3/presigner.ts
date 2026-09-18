import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DOWNLOAD_URL_TTL_MS, UPLOAD_URL_TTL_MS } from '@aperture/shared';

// The S3 presigning seam. The Lambda makes ZERO S3 API calls in this feature — it only SIGNS URLs the
// browser then uses to PUT/GET bytes directly. The S3Client exists purely as a signer; the IAM grant is
// what a signed URL acts as. Kept behind an interface so tests (and the contract suite) inject a fake.
export interface Presigner {
  // Signs content-length into the PUT, so S3 rejects any upload whose byte size differs from what the
  // server declared — the size cap is enforced cryptographically, not by trusting the client. The
  // content-type is set on the object but is NOT part of the signature; serving safety instead comes from
  // the forced ResponseContentType/ResponseContentDisposition on the GET (non-images → attachment).
  putUrl(key: string, contentType: string, size: number): Promise<string>;
  // Forces the response content-type + disposition (inline for images, attachment otherwise), so active
  // content never renders from the S3 origin.
  getUrl(key: string, contentType: string, disposition: string): Promise<string>;
}

export function createS3Presigner(bucket: string): Presigner {
  const s3 = new S3Client({}); // region from AWS_REGION at runtime; construction never touches network
  return {
    putUrl: (key, contentType, size) =>
      getSignedUrl(
        s3,
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          ContentType: contentType,
          ContentLength: size,
        }),
        { expiresIn: Math.floor(UPLOAD_URL_TTL_MS / 1000) },
      ),
    getUrl: (key, contentType, disposition) =>
      getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ResponseContentType: contentType,
          ResponseContentDisposition: disposition,
        }),
        { expiresIn: Math.floor(DOWNLOAD_URL_TTL_MS / 1000) },
      ),
  };
}

// Deterministic, network-free stand-in for tests + the contract suite. Echoes the key so assertions can
// see it flowed through.
export function fakePresigner(): Presigner {
  return {
    putUrl: async (key) => `fake://put/${key}`,
    getUrl: async (key) => `fake://get/${key}`,
  };
}
