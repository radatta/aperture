import { describe, expect, it } from 'vitest';
import { forgetStubBlob, resolveViewUrl, uploadTo } from './attachmentTransport';

// The stub path is the one exercised in-app (page-first). The XHR path is covered on dev against real S3.
describe('attachment transport (stub path)', () => {
  it('stores the blob for a stub url and resolves it back to an object url', async () => {
    const file = new File(['hi'], 'x.png', { type: 'image/png' });
    let progress = 0;
    await uploadTo('stub:abc', file, 'image/png', (f) => (progress = f));
    expect(progress).toBe(1); // stub upload completes immediately

    const orig = URL.createObjectURL;
    URL.createObjectURL = () => 'blob:abc'; // jsdom lacks it
    try {
      expect(resolveViewUrl('stub:abc')).toBe('blob:abc');
    } finally {
      URL.createObjectURL = orig;
    }
  });

  it('forgets one stub blob (the stub delete), leaving the rest', async () => {
    await uploadTo('stub:gone', new File(['a'], 'a.txt'), 'text/plain');
    await uploadTo('stub:kept', new File(['b'], 'b.txt'), 'text/plain');
    forgetStubBlob('gone');
    const orig = URL.createObjectURL;
    URL.createObjectURL = () => 'blob:kept'; // jsdom lacks it
    try {
      expect(resolveViewUrl('stub:gone')).toBeNull();
      expect(resolveViewUrl('stub:kept')).toBe('blob:kept');
    } finally {
      URL.createObjectURL = orig;
    }
  });

  it('returns null for an unknown stub id and passes real urls through', () => {
    expect(resolveViewUrl('stub:missing')).toBeNull();
    expect(resolveViewUrl('https://s3.example.com/obj?sig=x')).toBe(
      'https://s3.example.com/obj?sig=x',
    );
  });
});
