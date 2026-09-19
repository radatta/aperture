import { describe, expect, it } from 'vitest';
import { isImage, viewableInline } from './attachments';

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

  it('forces a download for active-content and unknown types', () => {
    for (const t of [
      'text/html',
      'image/svg+xml',
      'application/xhtml+xml',
      'text/xml',
      'application/xml',
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
