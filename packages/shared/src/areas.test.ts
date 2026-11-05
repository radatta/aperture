import { describe, expect, it } from 'vitest';
import { AREA_LABEL, AREAS, areaOf, assertArea, isArea } from './areas';

describe('areas', () => {
  it('is a fixed, ordered set with a label each', () => {
    expect(AREAS).toEqual(['school', 'aperture', 'recruiting', 'personal']);
    for (const a of AREAS) expect(AREA_LABEL[a]).toBeTruthy();
  });

  it('areaOf: null, undefined and a missing category all read as Personal', () => {
    expect(areaOf({ area: 'school' })).toBe('school');
    expect(areaOf({ area: null })).toBe('personal');
    expect(areaOf({})).toBe('personal'); // a row from before the field
    expect(areaOf(null)).toBe('personal'); // no category
    expect(areaOf(undefined)).toBe('personal');
  });

  it('assertArea refuses anything outside the set, allows null', () => {
    expect(() => assertArea('other')).toThrow(/area must be one of school, aperture/);
    expect(() => assertArea(undefined)).toThrow();
    expect(() => assertArea(3)).toThrow();
    expect(() => assertArea(null)).not.toThrow();
    expect(() => assertArea('recruiting')).not.toThrow();
    expect(isArea('aperture')).toBe(true);
    expect(isArea('Aperture')).toBe(false);
  });
});
