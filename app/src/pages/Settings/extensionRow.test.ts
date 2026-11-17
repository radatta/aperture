import { describe, expect, it } from 'vitest';
import type { Sitting } from '@aperture/shared';
import { compareVersions, extensionRow } from './extensionRow';

// Only the fields the line reads; the rest of a sitting doesn't matter here.
const sitting = (startedAt: number, extensionVersion?: string | null) =>
  ({ id: `s${startedAt}`, startedAt, extensionVersion }) as unknown as Sitting;

describe('compareVersions', () => {
  it('compares x.y.z by numbers, and says nothing for anything else', () => {
    expect(compareVersions('2.2.0', '2.2.0')).toBe(0);
    expect(compareVersions('2.1.9', '2.2.0')).toBeLessThan(0);
    expect(compareVersions('2.10.0', '2.9.0')).toBeGreaterThan(0);
    expect(compareVersions('3.0.0', '2.99.99')).toBeGreaterThan(0);
    expect(compareVersions(null, '2.2.0')).toBeNull();
    expect(compareVersions('2.2', '2.2.0')).toBeNull();
    expect(compareVersions('v2.2.0', '2.2.0')).toBeNull();
  });
});

describe('extensionRow', () => {
  it('no sitting yet: names the latest and says the next Start tells', () => {
    expect(extensionRow([], '2.2.0')).toEqual({
      text: 'Extension: latest 2.2.0. Your next Start shows which build Safari runs.',
      rebuild: false,
    });
  });
  it('the newest sitting’s build matches: up to date, as of that Start', () => {
    expect(extensionRow([sitting(1, '2.1.0'), sitting(2, '2.2.0')], '2.2.0')).toEqual({
      text: 'Extension: 2.2.0, up to date as of your last Start.',
      rebuild: false,
    });
  });
  it('an older build: installed, latest, rebuild needed — whatever order the list is in', () => {
    expect(extensionRow([sitting(5, '2.1.0'), sitting(2, '2.2.0')], '2.2.0')).toEqual({
      text: 'Extension: installed 2.1.0, latest 2.2.0 — rebuild needed.',
      rebuild: true,
    });
  });
  it('a sitting from before versions (no version on it): older, rebuild needed', () => {
    for (const v of [undefined, null, 'garbage'])
      expect(extensionRow([sitting(1, v)], '2.2.0')).toEqual({
        text: 'Extension: the last Start came from a build older than 2.2.0 — rebuild needed.',
        rebuild: true,
      });
  });
  it('a newer build than this app (the app not yet deployed): no nag', () => {
    expect(extensionRow([sitting(1, '2.3.0')], '2.2.0')).toEqual({
      text: 'Extension: installed 2.3.0; this app was built with 2.2.0.',
      rebuild: false,
    });
  });
});
