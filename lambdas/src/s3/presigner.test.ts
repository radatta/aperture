import { beforeAll, describe, expect, it } from 'vitest';
import { createS3Presigner } from './presigner';

// The presigner signs offline — no network — so with static dummy credentials we can assert exactly what
// the query string constrains. This is the proof that the size/type cap is enforced cryptographically by
// S3, not just by trusting the client.
describe('s3 presigner', () => {
  beforeAll(() => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    process.env.AWS_REGION = 'us-west-1';
  });

  it('signs content-length into the PUT with the 15-min upload TTL', async () => {
    const url = await createS3Presigner('aperture-files').putUrl('u/alice/t1/att1', 'image/png', 1234);
    const params = new URL(url).searchParams;
    const signed = decodeURIComponent(params.get('X-Amz-SignedHeaders') ?? '');
    // content-length is signed, so the byte size is cryptographically fixed — the cap can't be exceeded
    // by a client lying about the size. (content-type is sent to set the object type but is NOT signed;
    // serving safety comes from the forced ResponseContentType/Disposition on the GET, tested below.)
    expect(signed).toContain('content-length');
    expect(signed).toContain('host');
    expect(params.get('X-Amz-Expires')).toBe('900');
  });

  it('forces response content-type + disposition on the GET with the 5-min download TTL', async () => {
    const url = await createS3Presigner('aperture-files').getUrl(
      'u/alice/t1/att1',
      'application/pdf',
      "attachment; filename*=UTF-8''report.pdf",
    );
    const params = new URL(url).searchParams;
    expect(params.get('response-content-type')).toBe('application/pdf');
    expect(params.get('response-content-disposition')).toContain('attachment');
    expect(params.get('X-Amz-Expires')).toBe('300');
  });
});
