// ULIDs for sitting and event ids — a port of packages/shared/src/ulid.ts (the server checks them with isUlid):
// Crockford base32, 48-bit time + 80-bit randomness, monotonic within a millisecond. Minted only in the
// extension's own worlds (content, background), never in the page.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.ApertureLC = root.ApertureLC || {}).ulid = api;
})(globalThis, function () {
  'use strict';
  const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const TIME_LEN = 10;
  const RANDOM_LEN = 16;

  // 256 % 32 === 0, so a byte mod 32 is unbiased.
  function newRandom() {
    const buf = new Uint8Array(RANDOM_LEN);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => b % 32);
  }
  function increment(rand) {
    const out = rand.slice();
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i] < 31) {
        out[i]++;
        return out;
      }
      out[i] = 0;
    }
    return newRandom();
  }
  function encodeTime(time) {
    let out = '';
    let t = time;
    for (let i = 0; i < TIME_LEN; i++) {
      out = ENCODING.charAt(t % 32) + out;
      t = Math.floor(t / 32);
    }
    return out;
  }

  function createUlid(now = () => Date.now()) {
    let lastTime = -1;
    let lastRandom = [];
    return function ulid() {
      const time = Math.max(now(), lastTime);
      if (time === lastTime) lastRandom = increment(lastRandom);
      else {
        lastTime = time;
        lastRandom = newRandom();
      }
      return encodeTime(time) + lastRandom.map((d) => ENCODING.charAt(d)).join('');
    };
  }
  const isUlid = (s) =>
    typeof s === 'string' &&
    s.length === TIME_LEN + RANDOM_LEN &&
    [...s].every((ch) => ENCODING.includes(ch));

  return { createUlid, ulid: createUlid(), isUlid };
});
