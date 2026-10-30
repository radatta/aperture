import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The committed Face Landmarker model (docs/areas/flux). Guards a truncated download, an LFS pointer or a
// silent swap: the bytes must be exactly Google's float16/1 file.
const MODEL = join(
  import.meta.dirname,
  '../src/modules/flux/engine/model/face_landmarker.float16.v1.task',
);
const SHA256 = '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff';

describe('flux model asset', () => {
  it('is the pinned float16/1 face_landmarker.task', () => {
    const bytes = readFileSync(MODEL);
    expect(bytes.byteLength).toBe(3_758_596);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(SHA256);
  });
});
