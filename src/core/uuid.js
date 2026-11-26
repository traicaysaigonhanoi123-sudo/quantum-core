/* ==========================================================================
   QUANTUM CORE // Cryptographic UUID v4 Module (Zero Sequential IDs)
   UMD module: works in Node.js (require) and Browser (<script defer>)
   ========================================================================== */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.QuantumUUID = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function randomBytes16() {
    const buf = new Uint8Array(16);
    if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
      globalThis.crypto.getRandomValues(buf);
      return buf;
    }
    if (typeof require === 'function') {
      try {
        const nodeCrypto = require('node:crypto');
        return new Uint8Array(nodeCrypto.randomBytes(16));
      } catch (_) {}
    }
    for (let i = 0; i < 16; i++) {
      buf[i] = Math.floor(Math.random() * 256);
    }
    return buf;
  }

  function v4() {
    if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
    const b = randomBytes16();
    b[6] = (b[6] & 0x0f) | 0x40; // RFC 4122 version 4
    b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant 1
    const hex = Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function isValid(id) {
    return typeof id === 'string' && UUID_V4_RE.test(id);
  }

  function shortId(id) {
    return typeof id === 'string' && id.length >= 4 ? id.slice(0, 4) : '0000';
  }

  return { v4, isValid, shortId };
});
