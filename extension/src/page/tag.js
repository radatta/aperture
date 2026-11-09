// The relay's keyed tag: HMAC-SHA256 over each message, keyed by a per-load nonce. Loaded in both worlds at
// document_start, before any LeetCode script exists, so the functions it binds are the originals — a page
// script that patches crypto.subtle, Promise.prototype.then or Array methods later can't see or change what
// this file holds. sign() runs in the page world at request time, so it neither awaits nor calls a method a
// page could replace: Reflect.apply over the captured originals, and a plain loop for the hex.
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
  const apply = Reflect.apply;
  const pThen = Promise.prototype.then;
  const Bytes = Uint8Array;
  const HEX = [];
  for (let i = 0; i < 256; i++) HEX[i] = (i < 16 ? '0' : '') + i.toString(16);

  function hex(buf) {
    const b = new Bytes(buf);
    let s = '';
    for (let i = 0; i < b.length; i++) s += HEX[b[i]];
    return s;
  }
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
  const sign = (key, text) => apply(pThen, signRaw('HMAC', key, encode(text)), [hex]);
  async function verify(key, text, tagHex) {
    const sig = typeof tagHex === 'string' && tagHex.length === 64 ? fromHex(tagHex) : null;
    return !!sig && verifyRaw('HMAC', key, sig, encode(text));
  }
  return { newNonce, keyOf, sign, verify };
});
