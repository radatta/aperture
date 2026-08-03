// Rolled our own ULID: Crockford base32, 48-bit time + 80-bit randomness, with a MONOTONIC
// factory — ids minted in the same millisecond still sort in creation order, which the
// (eventual) DynamoDB sort keys depend on. Correctness (alphabet, length, monotonicity) is
// covered by property tests. We fall back to the `ulid` npm pkg only if this proves fiddly.

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (no I, L, O, U)
const TIME_LEN = 10;
const RANDOM_LEN = 16;

// 256 % 32 === 0, so a raw byte mod 32 is unbiased.
function randomByteMod32(): number {
  const buf = new Uint8Array(1);
  crypto.getRandomValues(buf);
  return buf[0]! % 32;
}

function newRandom(): number[] {
  const out: number[] = [];
  for (let i = 0; i < RANDOM_LEN; i++) out.push(randomByteMod32());
  return out;
}

// Increment the random component as a base-32 big number (for same-ms monotonicity).
function incrementRandom(rand: number[]): number[] {
  const out = rand.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const v = out[i]!;
    if (v < 31) {
      out[i] = v + 1;
      return out;
    }
    out[i] = 0;
  }
  return newRandom(); // overflow (astronomically unlikely) → reseed
}

function encodeTime(time: number): string {
  let out = '';
  let t = time;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENCODING.charAt(t % 32) + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(rand: number[]): string {
  let out = '';
  for (let i = 0; i < RANDOM_LEN; i++) out += ENCODING.charAt(rand[i]!);
  return out;
}

// Factory takes an injectable clock so tests can pin/rewind time deterministically.
export function createUlid(now: () => number = () => Date.now()): () => string {
  let lastTime = -1;
  let lastRandom: number[] = [];
  return function ulid(): string {
    const time = Math.max(now(), lastTime); // never move backwards, even if the clock does
    if (time === lastTime) {
      lastRandom = incrementRandom(lastRandom);
    } else {
      lastTime = time;
      lastRandom = newRandom();
    }
    return encodeTime(time) + encodeRandom(lastRandom);
  };
}

export const ulid = createUlid();

export function isUlid(s: string): boolean {
  if (s.length !== TIME_LEN + RANDOM_LEN) return false;
  for (const ch of s) if (!ENCODING.includes(ch)) return false;
  return true;
}
