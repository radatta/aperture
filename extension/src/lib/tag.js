// The relay's keyed tag: HMAC-SHA256 over each message, keyed by a per-load nonce. Loaded in both worlds at
// document_start, before any LeetCode script exists, so the crypto functions it binds are the originals — a
// page script that patches crypto.subtle later can't see or change what this file holds.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.ApertureLC = root.ApertureLC || {}).tag = api;
})(globalThis, function () {
  'use strict';
  const subtle = crypto.subtle;
  const importRaw = subtle.importKey.bind(subtle);
  const signRaw = subtle.sign.bind(subtle);
  const verifyRaw = subtle.verify.bind(subtle);
  const getRandom = crypto.getRandomValues.bind(crypto);
  const encoder = new TextEncoder();
  const encode = encoder.encode.bind(encoder);
  const HMAC = { name: 'HMAC', hash: 'SHA-256' };

  const hex = (buf) =>
    Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  const fromHex = (s) => {
    if (typeof s !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(s)) return null;
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return out;
  };
  const newNonce = () => hex(getRandom(new Uint8Array(32)));
  // A 64-hex-char nonce → its HMAC key (null for anything else).
  async function keyOf(nonceHex) {
    const raw = typeof nonceHex === 'string' && nonceHex.length === 64 ? fromHex(nonceHex) : null;
    return raw ? importRaw('raw', raw, HMAC, false, ['sign', 'verify']) : null;
  }
  const sign = async (key, text) => hex(await signRaw('HMAC', key, encode(text)));
  async function verify(key, text, tagHex) {
    const sig = typeof tagHex === 'string' && tagHex.length === 64 ? fromHex(tagHex) : null;
    return !!sig && verifyRaw('HMAC', key, sig, encode(text));
  }
  return { newNonce, keyOf, sign, verify };
});
