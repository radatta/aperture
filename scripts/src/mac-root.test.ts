import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAC_PLACEHOLDER, macRoot, readMacRoot } from './mac-root.ts';

const dir = mkdtempSync(join(tmpdir(), 'mac-root-'));
const file = (name: string, body: string) => {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
};

describe('readMacRoot', () => {
  it('reads one absolute line, trimming the newline and a trailing slash', () => {
    expect(readMacRoot(file('ok', '/Volumes/host/aperture/\n'))).toBe('/Volumes/host/aperture');
  });

  it.each([
    ['empty', ''],
    ['relative', 'Volumes/host/aperture'],
    ['a space', '/Volumes/my host/aperture'],
    ['a metacharacter', '/Volumes/host/aperture;rm'],
    ['a parent hop', '/Volumes/host/../etc'],
    ['two lines', '/Volumes/a\n/Volumes/b'],
  ])('refuses %s', (_why, body) => {
    expect(readMacRoot(file(_why.replace(/\W/g, '_'), body))).toBeNull();
  });

  it('a missing file, or no git checkout, is null', () => {
    expect(readMacRoot(join(dir, 'nope'))).toBeNull();
    expect(readMacRoot(null)).toBeNull();
  });

  it('macRoot falls back to the placeholder', () => {
    expect(macRoot(join(dir, 'nope'))).toBe(MAC_PLACEHOLDER);
    expect(macRoot(file('ok2', '/Volumes/host/aperture'))).toBe('/Volumes/host/aperture');
  });
});
