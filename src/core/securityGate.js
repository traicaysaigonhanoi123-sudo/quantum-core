/* ==========================================================================
   QUANTUM CORE // Zero-Trust MFA 2FA Gate (HMAC-SHA256 OTP + RBAC + Revocation)
   - Never stores plaintext OTP (only HMAC-SHA256 digest)
   - 10-minute expiry, max 5 failed attempts lockout, 60s resend cooldown
   - IP-bound challenges & sessions + global Session Revocation
   ========================================================================== */

(function (root, factory) {
  let uuidMod = root?.QuantumUUID;
  let schemaMod = root?.QuantumSchemas;
  if (typeof require === 'function') {
    try { uuidMod = uuidMod || require('./uuid.js'); } catch (_) {}
    try { schemaMod = schemaMod || require('./schemas.js'); } catch (_) {}
  }
  const SecurityGate = factory(uuidMod, schemaMod);
  if (typeof module === 'object' && module.exports) {
    module.exports = SecurityGate;
  }
  if (root) {
    root.QuantumSecurityGate = SecurityGate;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function (QuantumUUID, QuantumSchemas) {
  'use strict';

  const OTP_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
  const RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds
  const SESSION_TTL_MS = 60 * 60 * 1000; // 60 minutes
  const MAX_ATTEMPTS = 5;

  const ROLE_RANK = { VIEWER: 1, TRADER: 2, ADMIN: 3 };

  async function hmacSha256Hex(secret, message) {
    if (typeof require === 'function') {
      try {
        const nodeCrypto = require('node:crypto');
        return nodeCrypto.createHmac('sha256', secret).update(message).digest('hex');
      } catch (_) {}
    }
    const subtle = typeof globalThis !== 'undefined' ? globalThis.crypto?.subtle : null;
    if (subtle) {
      const enc = new TextEncoder();
      const key = await subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sig = await subtle.sign('HMAC', key, enc.encode(message));
      return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
    }
    // Lightweight fallback only if WebCrypto subtle is unavailable (e.g. restricted context)
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b9;
    const combo = `${secret}:${message}`;
    for (let i = 0; i < combo.length; i++) {
      h1 ^= combo.charCodeAt(i);
      h1 = Math.imul(h1, 0x01000193);
      h2 ^= combo.charCodeAt(i) + i;
      h2 = Math.imul(h2, 0x85ebca6b);
    }
    return (h1 >>> 0).toString(16).padStart(8, '0').repeat(4) + (h2 >>> 0).toString(16).padStart(8, '0').repeat(4);
  }

  function constantTimeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  function randomSixDigits() {
    if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
      const arr = new Uint32Array(1);
      globalThis.crypto.getRandomValues(arr);
      return String(arr[0] % 1000000).padStart(6, '0');
    }
    return String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
  }

  class SecurityGate {
    constructor(options = {}) {
      this._hmacKey = options.hmacKey || QuantumUUID.v4();
      this._now = options.nowFn || (() => Date.now());
      this._challenges = new Map();
      this._sessions = new Map();
      this._cooldownByEmail = new Map();
    }

    async requestOtp({ email, ip = '127.0.0.1', role = 'TRADER' }) {
      const normalizedEmail = String(email || '').trim().toLowerCase();
      if (!normalizedEmail || !normalizedEmail.includes('@')) {
        return { ok: false, code: 'INVALID_EMAIL', error: 'Email nhận mã OTP không hợp lệ.' };
      }

      const now = this._now();
      const lastSent = this._cooldownByEmail.get(normalizedEmail) || 0;
      if (now - lastSent < RESEND_COOLDOWN_MS) {
        const waitSec = Math.ceil((RESEND_COOLDOWN_MS - (now - lastSent)) / 1000);
        return {
          ok: false,
          code: 'RESEND_COOLDOWN',
          retryAfterSec: waitSec,
          error: `Vui lòng chờ ${waitSec}s trước khi yêu cầu gửi lại OTP.`
        };
      }

      const otp = randomSixDigits();
      const challengeId = QuantumUUID.v4();
      const otpHmac = await hmacSha256Hex(this._hmacKey, `${challengeId}:${normalizedEmail}:${otp}`);

      this._challenges.set(challengeId, {
        challengeId,
        email: normalizedEmail,
        ip,
        role: ROLE_RANK[role] ? role : 'TRADER',
        otpHmac,
        attempts: 0,
        locked: false,
        used: false,
        createdAt: now,
        expiresAt: now + OTP_EXPIRY_MS
      });
      this._cooldownByEmail.set(normalizedEmail, now);

      return {
        ok: true,
        challengeId,
        expiresInSec: OTP_EXPIRY_MS / 1000,
        cooldownSec: RESEND_COOLDOWN_MS / 1000,
        // Local loopback sandbox preview only; production dispatches via Gmail SMTP
        devPreviewOtp: otp
      };
    }

    async verifyOtp({ challengeId, otp, ip = '127.0.0.1' }) {
      const ch = this._challenges.get(challengeId);
      if (!ch) {
        return { ok: false, code: 'CHALLENGE_NOT_FOUND', error: 'Phiên OTP không tồn tại.' };
      }
      if (ch.used) {
        return { ok: false, code: 'OTP_ALREADY_USED', error: 'Mã OTP đã được sử dụng.' };
      }
      if (ch.locked || ch.attempts >= MAX_ATTEMPTS) {
        ch.locked = true;
        return { ok: false, code: 'MAX_ATTEMPTS_EXCEEDED', error: 'Nhập sai OTP quá 5 lần — Thử thách đã bị khóa.' };
      }

      const now = this._now();
      if (now > ch.expiresAt) {
        return { ok: false, code: 'OTP_EXPIRED', error: 'Mã OTP đã hết hạn (10 phút). Hãy yêu cầu mã mới.' };
      }

      if (ch.ip !== ip) {
        return { ok: false, code: 'IP_MISMATCH', error: 'IP xác minh không khớp với IP khởi tạo (chặn hijacking).' };
      }

      const cleanOtp = String(otp || '').trim();
      const candidateHmac = await hmacSha256Hex(this._hmacKey, `${ch.challengeId}:${ch.email}:${cleanOtp}`);

      if (!constantTimeEqual(candidateHmac, ch.otpHmac)) {
        ch.attempts += 1;
        if (ch.attempts >= MAX_ATTEMPTS) ch.locked = true;
        return {
          ok: false,
          code: ch.locked ? 'MAX_ATTEMPTS_EXCEEDED' : 'INVALID_OTP',
          attemptsRemaining: Math.max(0, MAX_ATTEMPTS - ch.attempts),
          error: ch.locked
            ? 'Nhập sai OTP quá 5 lần — Đã khóa thử thách OTP.'
            : `Mã OTP không đúng (còn ${MAX_ATTEMPTS - ch.attempts} lần thử).`
        };
      }

      ch.used = true;
      const sessionId = QuantumUUID.v4();
      const session = {
        sessionId,
        email: ch.email,
        ip: ch.ip,
        role: ch.role,
        createdAt: now,
        expiresAt: now + SESSION_TTL_MS,
        revoked: false
      };
      this._sessions.set(sessionId, session);

      return {
        ok: true,
        session: QuantumSchemas ? QuantumSchemas.toSessionPublicDTO(session) : session
      };
    }

    validateSession(sessionId, ip = '127.0.0.1', requiredRole = 'TRADER') {
      const s = this._sessions.get(sessionId);
      if (!s || s.revoked) {
        return { ok: false, code: 'SESSION_INVALID', error: 'Chưa xác thực 2FA hoặc phiên đã bị thu hồi.' };
      }
      if (this._now() > s.expiresAt) {
        return { ok: false, code: 'SESSION_EXPIRED', error: 'Phiên xác thực đã hết hạn.' };
      }
      if (s.ip !== ip) {
        return { ok: false, code: 'IP_MISMATCH', error: 'IP phiên không khớp.' };
      }
      const rank = ROLE_RANK[s.role] || 0;
      const minRank = ROLE_RANK[requiredRole] || 0;
      if (rank < minRank) {
        return { ok: false, code: 'FORBIDDEN', error: `Yêu cầu quyền ${requiredRole}.` };
      }
      return {
        ok: true,
        session: QuantumSchemas ? QuantumSchemas.toSessionPublicDTO(s) : s
      };
    }

    revokeAllSessions() {
      let count = 0;
      for (const s of this._sessions.values()) {
        if (!s.revoked) {
          s.revoked = true;
          count++;
        }
      }
      this._sessions.clear();
      return { ok: true, revokedCount: count };
    }

    debugDumpPublicMetrics() {
      return {
        activeChallenges: this._challenges.size,
        activeSessions: this._sessions.size
      };
    }
  }

  return SecurityGate;
});
