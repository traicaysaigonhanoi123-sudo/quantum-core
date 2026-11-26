/* ==========================================================================
   QUANTUM CORE // Zero-Dependency Hyperliquid EIP-712 & secp256k1 Signer
   - Standard Ethereum Keccak-256 (0x01 domain padding)
   - Canonical MessagePack encoder preserving key insertion order
   - Pure BigInt secp256k1 + RFC 6979 deterministic ECDSA with EIP-2 low-S
   - Hyperliquid L1 Exchange Action signing (Agent domain, chainId 1337)
   ========================================================================== */

import { createHmac } from 'node:crypto';

const MASK64 = 0xFFFFFFFFFFFFFFFFn;
const SECP_P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const HALF_N = SECP_N >> 1n;
const SECP_G = {
  x: 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n,
  y: 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n
};

const KECCAK_RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];

const KECCAK_ROTC = [
  1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14,
  27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44
];

const KECCAK_PILN = [
  10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4,
  15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1
];

function rotl64(x, n) {
  const s = BigInt(n);
  return ((x << s) | (x >> (64n - s))) & MASK64;
}

function keccakF1600(st) {
  const bc = new Array(5);
  for (let round = 0; round < 24; round++) {
    for (let i = 0; i < 5; i++) {
      bc[i] = st[i] ^ st[i + 5] ^ st[i + 10] ^ st[i + 15] ^ st[i + 20];
    }
    for (let i = 0; i < 5; i++) {
      const t = bc[(i + 4) % 5] ^ rotl64(bc[(i + 1) % 5], 1);
      for (let j = 0; j < 25; j += 5) st[j + i] ^= t;
    }
    let t = st[1];
    for (let i = 0; i < 24; i++) {
      const j = KECCAK_PILN[i];
      bc[0] = st[j];
      st[j] = rotl64(t, KECCAK_ROTC[i]);
      t = bc[0];
    }
    for (let j = 0; j < 25; j += 5) {
      for (let i = 0; i < 5; i++) bc[i] = st[j + i];
      for (let i = 0; i < 5; i++) {
        st[j + i] ^= (~bc[(i + 1) % 5]) & bc[(i + 2) % 5];
      }
    }
    st[0] ^= KECCAK_RC[round];
  }
}

export function keccak256(input) {
  const bytes = typeof input === 'string'
    ? Buffer.from(input, 'utf8')
    : Buffer.from(input);
  const rate = 136;
  const rem = bytes.length % rate;
  const padLen = rate - rem;
  const padded = Buffer.alloc(bytes.length + padLen);
  bytes.copy(padded, 0);
  padded[bytes.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  const st = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < 17; i++) {
      const lane = padded.readBigUInt64LE(off + i * 8);
      st[i] ^= lane;
    }
    keccakF1600(st);
  }

  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) {
    out.writeBigUInt64LE(st[i] & MASK64, i * 8);
  }
  return out;
}

export function msgpackEncode(value) {
  const out = [];
  const pushU16 = (n) => out.push((n >>> 8) & 0xff, n & 0xff);
  const pushU32 = (n) => out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);

  const encodeAny = (v) => {
    if (v === null || v === undefined) {
      out.push(0xc0);
      return;
    }
    if (typeof v === 'boolean') {
      out.push(v ? 0xc3 : 0xc2);
      return;
    }
    if (typeof v === 'number') {
      if (!Number.isInteger(v)) {
        const b = Buffer.alloc(9);
        b[0] = 0xcb;
        b.writeDoubleBE(v, 1);
        for (let i = 0; i < b.length; i++) out.push(b[i]);
        return;
      }
      if (v >= 0) {
        if (v <= 0x7f) out.push(v);
        else if (v <= 0xff) out.push(0xcc, v);
        else if (v <= 0xffff) { out.push(0xcd); pushU16(v); }
        else if (v <= 0xffffffff) { out.push(0xce); pushU32(v); }
        else {
          const b = Buffer.alloc(9);
          b[0] = 0xcf;
          b.writeBigUInt64BE(BigInt(v), 1);
          for (let i = 0; i < 9; i++) out.push(b[i]);
        }
      } else {
        if (v >= -32) out.push(v & 0xff);
        else if (v >= -128) out.push(0xd0, v & 0xff);
        else if (v >= -32768) { out.push(0xd1); pushU16(v & 0xffff); }
        else { out.push(0xd2); pushU32(v >>> 0); }
      }
      return;
    }
    if (typeof v === 'string') {
      const sb = Buffer.from(v, 'utf8');
      if (sb.length <= 31) out.push(0xa0 | sb.length);
      else if (sb.length <= 0xff) out.push(0xd9, sb.length);
      else if (sb.length <= 0xffff) { out.push(0xda); pushU16(sb.length); }
      else { out.push(0xdb); pushU32(sb.length); }
      for (let i = 0; i < sb.length; i++) out.push(sb[i]);
      return;
    }
    if (Array.isArray(v)) {
      if (v.length <= 15) out.push(0x90 | v.length);
      else if (v.length <= 0xffff) { out.push(0xdc); pushU16(v.length); }
      else { out.push(0xdd); pushU32(v.length); }
      for (let i = 0; i < v.length; i++) encodeAny(v[i]);
      return;
    }
    if (typeof v === 'object') {
      const entries = Object.entries(v).filter(([, val]) => val !== undefined);
      if (entries.length <= 15) out.push(0x80 | entries.length);
      else if (entries.length <= 0xffff) { out.push(0xde); pushU16(entries.length); }
      else { out.push(0xdf); pushU32(entries.length); }
      for (const [k, val] of entries) {
        encodeAny(String(k));
        encodeAny(val);
      }
    }
  };

  encodeAny(value);
  return Buffer.from(out);
}

function mod(a, m = SECP_P) {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

function modPow(base, exp, m = SECP_P) {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    e >>= 1n;
    b = (b * b) % m;
  }
  return result;
}

function modInv(a, m = SECP_P) {
  let t = 0n;
  let newT = 1n;
  let r = m;
  let newR = mod(a, m);
  while (newR !== 0n) {
    const q = r / newR;
    [t, newT] = [newT, t - q * newT];
    [r, newR] = [newR, r - q * newR];
  }
  if (r > 1n) throw new Error('Not invertible');
  return t < 0n ? t + m : t;
}

function pointAdd(p1, p2) {
  if (!p1) return p2;
  if (!p2) return p1;
  if (p1.x === p2.x) {
    if (p1.y !== p2.y) return null;
    const lam = mod(3n * p1.x * p1.x * modInv(2n * p1.y, SECP_P), SECP_P);
    const x3 = mod(lam * lam - 2n * p1.x, SECP_P);
    const y3 = mod(lam * (p1.x - x3) - p1.y, SECP_P);
    return { x: x3, y: y3 };
  }
  const lam = mod((p2.y - p1.y) * modInv(p2.x - p1.x, SECP_P), SECP_P);
  const x3 = mod(lam * lam - p1.x - p2.x, SECP_P);
  const y3 = mod(lam * (p1.x - x3) - p1.y, SECP_P);
  return { x: x3, y: y3 };
}

function pointMul(k, pt = SECP_G) {
  let r = null;
  let addend = pt;
  let n = k;
  while (n > 0n) {
    if (n & 1n) r = pointAdd(r, addend);
    addend = pointAdd(addend, addend);
    n >>= 1n;
  }
  return r;
}

function pointFromX(x, oddY) {
  const y2 = mod(x * x * x + 7n, SECP_P);
  // P % 4 === 3 on secp256k1 => sqrt(y2) = y2 ^ ((P + 1) / 4)
  let y = modPow(y2, (SECP_P + 1n) >> 2n, SECP_P);
  if (((y & 1n) === 1n) !== Boolean(oddY)) {
    y = mod(SECP_P - y, SECP_P);
  }
  return { x, y };
}

function normalizePrivKey(privKeyHex) {
  const clean = String(privKeyHex || '').trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error('Private key phải gồm đúng 64 ký tự hex (256-bit).');
  }
  const k = BigInt(`0x${clean}`);
  if (k <= 0n || k >= SECP_N) {
    throw new Error('Private key nằm ngoài giới hạn secp256k1.');
  }
  return { buf: Buffer.from(clean, 'hex'), scalar: k };
}

function bigIntToHex32(n) {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

function pointToAddress(pt) {
  const xy = Buffer.concat([
    Buffer.from(pt.x.toString(16).padStart(64, '0'), 'hex'),
    Buffer.from(pt.y.toString(16).padStart(64, '0'), 'hex')
  ]);
  const hash = keccak256(xy);
  return `0x${hash.subarray(12).toString('hex')}`;
}

export function privateKeyToAddress(privKeyHex) {
  const { scalar } = normalizePrivKey(privKeyHex);
  return pointToAddress(pointMul(scalar));
}

// Deterministic RFC 6979 HMAC-SHA256 k generator
function rfc6979GenerateK(privBuf, msgHash32, attempt = 0) {
  const hashInt = BigInt(`0x${msgHash32.toString('hex')}`) % SECP_N;
  const h1 = Buffer.from(hashInt.toString(16).padStart(64, '0'), 'hex');

  let V = Buffer.alloc(32, 0x01);
  let K = Buffer.alloc(32, 0x00);

  const seedSuffix = attempt > 0 ? Buffer.from([attempt & 0xff]) : Buffer.alloc(0);
  K = createHmac('sha256', K).update(Buffer.concat([V, Buffer.from([0x00]), privBuf, h1, seedSuffix])).digest();
  V = createHmac('sha256', K).update(V).digest();
  K = createHmac('sha256', K).update(Buffer.concat([V, Buffer.from([0x01]), privBuf, h1, seedSuffix])).digest();
  V = createHmac('sha256', K).update(V).digest();

  for (let i = 0; i < 64; i++) {
    V = createHmac('sha256', K).update(V).digest();
    const k = BigInt(`0x${V.toString('hex')}`);
    if (k >= 1n && k < SECP_N) return k;
    K = createHmac('sha256', K).update(Buffer.concat([V, Buffer.from([0x00])])).digest();
    V = createHmac('sha256', K).update(V).digest();
  }
  throw new Error('RFC6979 failed to derive valid k');
}

export function signDigest(digest32, privKeyHex) {
  const { buf: privBuf, scalar: d } = normalizePrivKey(privKeyHex);
  const pubPt = pointMul(d);
  const z = mod(BigInt(`0x${Buffer.from(digest32).toString('hex')}`), SECP_N);

  for (let attempt = 0; attempt < 32; attempt++) {
    const k = rfc6979GenerateK(privBuf, digest32, attempt);
    const R = pointMul(k);
    const r = mod(R.x, SECP_N);
    if (r === 0n) continue;

    let s = mod(modInv(k, SECP_N) * (z + r * d), SECP_N);
    if (s === 0n) continue;

    let yParity = Number(R.y & 1n);
    if (s > HALF_N) {
      s = SECP_N - s;
      yParity ^= 1;
    }

    // Verify recovery parity directly against signer public point
    const rInv = modInv(r, SECP_N);
    let verifiedParity = null;
    for (const parityTry of [yParity, yParity ^ 1]) {
      const Rrec = pointFromX(r, parityTry === 1);
      const sR = pointMul(s, Rrec);
      const zG = pointMul(z, SECP_G);
      const negZG = { x: zG.x, y: mod(SECP_P - zG.y, SECP_P) };
      const qRec = pointMul(rInv, pointAdd(sR, negZG));
      if (qRec && qRec.x === pubPt.x && qRec.y === pubPt.y) {
        verifiedParity = parityTry;
        break;
      }
    }
    if (verifiedParity === null) continue;

    return {
      r: bigIntToHex32(r),
      s: bigIntToHex32(s),
      v: 27 + verifiedParity
    };
  }
  throw new Error('ECDSA signing failed');
}

function uint256Word(n) {
  const hex = BigInt(n).toString(16).padStart(64, '0');
  return Buffer.from(hex, 'hex');
}

function addressWord(addrHex) {
  const clean = String(addrHex || '').replace(/^0x/i, '').toLowerCase().padStart(40, '0');
  return Buffer.from(clean.padStart(64, '0'), 'hex');
}

const EIP712_DOMAIN_TYPEHASH = keccak256('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)');
const HL_AGENT_TYPEHASH = keccak256('Agent(string source,bytes32 connectionId)');
const HL_DOMAIN_SEPARATOR = keccak256(
  Buffer.concat([
    EIP712_DOMAIN_TYPEHASH,
    keccak256('Exchange'),
    keccak256('1'),
    uint256Word(1337n),
    addressWord('0x0000000000000000000000000000000000000000')
  ])
);

export function hashHyperliquidAction(action, nonce, vaultAddress = null) {
  const packed = msgpackEncode(action);
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64BE(BigInt(nonce), 0);

  let vaultBuf;
  const vClean = typeof vaultAddress === 'string' ? vaultAddress.trim().replace(/^0x/i, '') : '';
  if (/^[0-9a-fA-F]{40}$/.test(vClean)) {
    vaultBuf = Buffer.concat([Buffer.from([0x01]), Buffer.from(vClean, 'hex')]);
  } else {
    vaultBuf = Buffer.from([0x00]);
  }

  return keccak256(Buffer.concat([packed, nonceBuf, vaultBuf]));
}

export function signHyperliquidL1Action({ action, nonce, vaultAddress = null, isMainnet = false, privateKey }) {
  const connectionId = hashHyperliquidAction(action, nonce, vaultAddress);
  const sourceHash = keccak256(isMainnet ? 'a' : 'b');
  const structHash = keccak256(Buffer.concat([HL_AGENT_TYPEHASH, sourceHash, connectionId]));
  const digest = keccak256(Buffer.concat([Buffer.from([0x19, 0x01]), HL_DOMAIN_SEPARATOR, structHash]));
  return signDigest(digest, privateKey);
}
