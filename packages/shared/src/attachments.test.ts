import { describe, expect, it } from 'vitest';
import { isImage, viewableInline } from './attachments';

describe('isImage', () => {
  it('accepts only web-renderable raster types (for thumbnails)', () => {
    for (const t of ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'])
      expect(isImage(t)).toBe(true);
  });

  it('rejects images browsers cannot decode + SVG + non-images', () => {
    // HEIC/HEIF/TIFF are real images but not browser-decodable → chip, not a broken thumbnail.
    for (const t of [
      'image/heic',
      'image/heif',
      'image/tiff',
      'image/svg+xml',
      'application/pdf',
      'text/plain',
    ])
      expect(isImage(t)).toBe(false);
  });
});

describe('viewableInline', () => {
  it('serves browser-renderable, script-free types inline', () => {
    for (const t of [
      'image/png',
      'image/jpeg',
      'application/pdf',
      'text/plain',
      'text/markdown',
      'audio/mpeg',
      'video/mp4',
    ])
      expect(viewableInline(t)).toBe(true);
  });

  it('forces a download for active-content, undecodable images, and unknown types', () => {
    for (const t of [
      'text/html',
      'image/svg+xml',
      'application/xhtml+xml',
      'text/xml',
      'application/xml',
      'image/heic', // Firefox can't render it → a clean download beats a blank-tab-then-download
      'image/heif',
      'application/octet-stream',
      'application/zip',
    ])
      expect(viewableInline(t)).toBe(false);
  });

  it('agrees with isImage that SVG is neither an image thumbnail nor inline-viewable', () => {
    expect(isImage('image/svg+xml')).toBe(false);
    expect(viewableInline('image/svg+xml')).toBe(false);
  });
});
