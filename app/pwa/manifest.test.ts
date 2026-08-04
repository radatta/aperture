import { describe, expect, it } from 'vitest';
import { APERTURE_MANIFEST } from './manifest';

describe('APERTURE_MANIFEST', () => {
  it('is installable-standalone from the root scope', () => {
    expect(APERTURE_MANIFEST.display).toBe('standalone');
    expect(APERTURE_MANIFEST.start_url).toBe('/');
    expect(APERTURE_MANIFEST.scope).toBe('/');
  });

  it('uses the dark identity anchor for install chrome', () => {
    expect(APERTURE_MANIFEST.theme_color).toBe('#33453f');
    expect(APERTURE_MANIFEST.background_color).toBe('#33453f');
  });

  it('ships the icon sizes browsers actually require', () => {
    const bySize = (APERTURE_MANIFEST.icons ?? []).map((i) => `${i.sizes}:${i.purpose ?? 'any'}`);
    expect(bySize).toContain('192x192:any');
    expect(bySize).toContain('512x512:any');
    // Maskable is what makes the Android/adaptive install icon fill its safe zone.
    expect(bySize).toContain('512x512:maskable');
  });

  it('points every icon at a real emitted path under icons/', () => {
    for (const icon of APERTURE_MANIFEST.icons ?? []) {
      expect(icon.src).toMatch(/^icons\/icon-.+\.png$/);
      expect(icon.type).toBe('image/png');
    }
  });
});
