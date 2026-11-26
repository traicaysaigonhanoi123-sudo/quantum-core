/* ==========================================================================
   QUANTUM CORE // Zero-Trust Account Auth, 3-Device Takeover & Live Key Gate (UMD)
   - Strict @gmail.com registration + Math CAPTCHA + 6-digit HMAC-SHA256 OTP
   - PBKDF2-SHA256 (100,000 iterations) app password hashing
   - Max 3 registered devices per account + mandatory Yes/No Active-Device Takeover
   - Admin role locked to traicaysaigonhanoi123@gmail.com (Live auto-unlocked)
   - Normal Gmail defaults to Demo; unlocked via single-use LIVE-XXXX-XXXX-XXXX key
   ========================================================================== */

(function (root, factory) {
  let uuidMod = root?.QuantumUUID;
  if (typeof require === 'function') {
    try { uuidMod = uuidMod || require('./uuid.js'); } catch (_) {}
  }
  const AccountAuth = factory(uuidMod);
  if (typeof module === 'object' && module.exports) {
    module.exports = AccountAuth;
  }
  if (root) {
    root.QuantumAccountAuth = AccountAuth;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function (QuantumUUID) {
  'use strict';

  const ADMIN_EMAIL = 'traicaysaigonhanoi123@gmail.com';
  const MAX_DEVICES = 3;
  const OTP_TTL_MS = 10 * 60 * 1000;
  const OTP_COOLDOWN_MS = 60 * 1000;
  const OTP_MAX_ATTEMPTS = 5;
  const CAPTCHA_TTL_MS = 5 * 60 * 1000;
  const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days until logout or device takeover
  const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function getNodeCrypto() {
    if (typeof require === 'function') {
      try {
        return require('node:crypto');
      } catch (_) {}
    }
    return null;
  }

  function newId() {
    if (QuantumUUID && typeof QuantumUUID.v4 === 'function') return QuantumUUID.v4();
    const nc = getNodeCrypto();
    if (nc && typeof nc.randomUUID === 'function') return nc.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function randomHex(byteLen = 16) {
    const nc = getNodeCrypto();
    if (nc) return nc.randomBytes(byteLen).toString('hex');
    if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
      const buf = new Uint8Array(byteLen);
      globalThis.crypto.getRandomValues(buf);
      return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
    }
    let out = '';
    for (let i = 0; i < byteLen; i++) {
      out += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
    }
    return out;
  }

  function randomInt(min, maxInclusive) {
    const span = maxInclusive - min + 1;
    const nc = getNodeCrypto();
    if (nc && typeof nc.randomInt === 'function') {
      return nc.randomInt(min, maxInclusive + 1);
    }
    if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
      const arr = new Uint32Array(1);
      globalThis.crypto.getRandomValues(arr);
      return min + (arr[0] % span);
    }
    return min + Math.floor(Math.random() * span);
  }

  function randomSixDigits() {
    return String(randomInt(0, 999999)).padStart(6, '0');
  }

  function constantTimeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  async function hmacSha256Hex(secret, message) {
    const nc = getNodeCrypto();
    if (nc) {
      return nc.createHmac('sha256', String(secret)).update(String(message)).digest('hex');
    }
    const subtle = typeof globalThis !== 'undefined' ? globalThis.crypto?.subtle : null;
    if (subtle) {
      const enc = new TextEncoder();
      const key = await subtle.importKey('raw', enc.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sig = await subtle.sign('HMAC', key, enc.encode(String(message)));
      return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
    }
    // Non-WebCrypto deterministic fallback for restricted http contexts
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

  async function pbkdf2Hash(password, saltHex) {
    const nc = getNodeCrypto();
    if (nc) {
      return nc.pbkdf2Sync(String(password), String(saltHex), 100000, 32, 'sha256').toString('hex');
    }
    const subtle = typeof globalThis !== 'undefined' ? globalThis.crypto?.subtle : null;
    if (subtle) {
      const enc = new TextEncoder();
      const keyMat = await subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
      const bits = await subtle.deriveBits(
        { name: 'PBKDF2', salt: enc.encode(String(saltHex)), iterations: 100000, hash: 'SHA-256' },
        keyMat,
        256
      );
      return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, '0')).join('');
    }
    return hmacSha256Hex(`pbkdf2:${saltHex}`, password);
  }

  function normalizeEmail(raw) {
    return String(raw || '').trim().toLowerCase();
  }

  function isValidGmail(email) {
    return /^[a-z0-9._%+-]{2,64}@gmail\.com$/i.test(email);
  }

  function normalizeActivationKey(raw) {
    return String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  }

  function generateLiveKeyPlain() {
    const seg = () => {
      let s = '';
      for (let i = 0; i < 4; i++) {
        s += KEY_ALPHABET[randomInt(0, KEY_ALPHABET.length - 1)];
      }
      return s;
    };
    return `LIVE-${seg()}-${seg()}-${seg()}`;
  }

  function detectDeviceLabel(userAgent) {
    const ua = String(userAgent || (typeof navigator !== 'undefined' ? navigator.userAgent : '') || '');
    if (/android/i.test(ua)) return '📱 Điện thoại Android';
    if (/iphone/i.test(ua)) return '📱 iPhone iOS';
    if (/ipad/i.test(ua)) return '📱 iPad';
    if (/macintosh|mac os/i.test(ua)) return '💻 Máy tính macOS';
    if (/windows/i.test(ua)) return '💻 Máy tính Windows';
    if (/linux/i.test(ua)) return '💻 Máy tính Linux';
    return '🌐 Thiết bị Web';
  }

  function generateDeviceId() {
    return `dev_${randomHex(6)}`;
  }

  function toPublicUser(acc) {
    if (!acc) return null;
    return {
      email: acc.email,
      role: acc.role,
      isAdmin: acc.role === 'ADMIN',
      liveActivated: Boolean(acc.liveActivated),
      accountTierLabel: acc.role === 'ADMIN' ? 'ADMIN MASTER (LIVE)' : (acc.liveActivated ? 'TÀI KHOẢN CHÍNH (LIVE)' : 'TÀI KHOẢN DEMO'),
      deviceCount: Array.isArray(acc.devices) ? acc.devices.length : 0,
      maxDevices: MAX_DEVICES,
      devices: Array.isArray(acc.devices)
        ? acc.devices.map((d) => ({
            deviceId: d.deviceId,
            deviceLabel: d.deviceLabel,
            active: Boolean(d.active),
            registeredAt: d.registeredAt,
            lastSeenAt: d.lastSeenAt
          }))
        : [],
      activeDeviceId: acc.activeSession?.deviceId || null,
      activeDeviceLabel: acc.activeSession?.deviceLabel || null,
      createdAt: acc.createdAt
    };
  }

  class QuantumAccountAuth {
    constructor(options = {}) {
      this._hmacSecret = options.hmacSecret || options.secret || 'quantum-core-zero-trust-auth-secret-v1';
      this._now = options.nowFn || (() => Date.now());
      this._captchas = new Map();
      this._challenges = new Map();
      this._cooldowns = new Map();
      this._accounts = new Map();
      this._liveKeys = new Map();
    }

    exportDb() {
      return {
        version: 1,
        captchas: Array.from(this._captchas.entries()),
        challenges: Array.from(this._challenges.entries()),
        cooldowns: Array.from(this._cooldowns.entries()),
        accounts: Array.from(this._accounts.entries()),
        liveKeys: Array.from(this._liveKeys.entries())
      };
    }

    importDb(snapshot) {
      if (!snapshot || typeof snapshot !== 'object') return false;
      const now = this._now();
      this._captchas = new Map((snapshot.captchas || []).filter(([, v]) => v && v.expiresAt > now));
      this._challenges = new Map((snapshot.challenges || []).filter(([, v]) => v && v.expiresAt > now && !v.used));
      this._cooldowns = new Map((snapshot.cooldowns || []).filter(([, ts]) => now - ts < OTP_COOLDOWN_MS));
      this._accounts = new Map(snapshot.accounts || []);
      this._liveKeys = new Map(snapshot.liveKeys || []);
      return true;
    }

    createMathCaptcha() {
      const now = this._now();
      for (const [cid, c] of this._captchas.entries()) {
        if (now > c.expiresAt) this._captchas.delete(cid);
      }
      const isSub = randomInt(0, 1) === 1;
      const a = randomInt(12, 48);
      const b = isSub ? randomInt(3, a - 2) : randomInt(4, 29);
      const answer = isSub ? (a - b) : (a + b);
      const expression = isSub ? `${a} - ${b} = ?` : `${a} + ${b} = ?`;
      const captchaId = newId();
      this._captchas.set(captchaId, {
        captchaId,
        expression,
        answer,
        expiresAt: now + CAPTCHA_TTL_MS
      });
      return { ok: true, captchaId, expression, expiresInSec: CAPTCHA_TTL_MS / 1000 };
    }

    _verifyCaptcha(captchaId, captchaAnswer) {
      const ch = this._captchas.get(String(captchaId || ''));
      if (!ch) return { ok: false, error: 'Mã CAPTCHA không tồn tại hoặc đã dùng — hãy bấm làm mới.' };
      if (this._now() > ch.expiresAt) {
        this._captchas.delete(ch.captchaId);
        return { ok: false, error: 'Mã CAPTCHA đã hết hạn — hãy bấm làm mới.' };
      }
      const parsed = Number(String(captchaAnswer ?? '').trim());
      if (!Number.isFinite(parsed) || parsed !== ch.answer) {
        return { ok: false, error: 'Kết quả CAPTCHA chưa chính xác.' };
      }
      this._captchas.delete(ch.captchaId);
      return { ok: true };
    }

    async requestRegisterOtp({ email, captchaId, captchaAnswer, deviceId, deviceLabel }) {
      const normalized = normalizeEmail(email);
      if (!isValidGmail(normalized)) {
        return { ok: false, code: 'INVALID_GMAIL', error: 'Bắt buộc nhập địa chỉ @gmail.com hợp lệ.' };
      }

      const cap = this._verifyCaptcha(captchaId, captchaAnswer);
      if (!cap.ok) {
        return { ok: false, code: 'INVALID_CAPTCHA', error: cap.error };
      }

      const now = this._now();
      const prevSent = this._cooldowns.get(normalized) || 0;
      if (now - prevSent < OTP_COOLDOWN_MS) {
        const waitSec = Math.ceil((OTP_COOLDOWN_MS - (now - prevSent)) / 1000);
        return { ok: false, code: 'RESEND_COOLDOWN', retryAfterSec: waitSec, error: `Chờ ${waitSec}s trước khi gửi lại OTP.` };
      }

      const otp = randomSixDigits();
      const challengeId = newId();
      const otpHmac = await hmacSha256Hex(this._hmacSecret, `${challengeId}:${normalized}:${otp}`);
      this._challenges.set(challengeId, {
        challengeId,
        email: normalized,
        deviceId: String(deviceId || generateDeviceId()),
        deviceLabel: String(deviceLabel || detectDeviceLabel()),
        otpHmac,
        attempts: 0,
        used: false,
        locked: false,
        createdAt: now,
        expiresAt: now + OTP_TTL_MS
      });
      this._cooldowns.set(normalized, now);

      return {
        ok: true,
        challengeId,
        email: normalized,
        expiresInSec: OTP_TTL_MS / 1000,
        cooldownSec: OTP_COOLDOWN_MS / 1000,
        devPreviewOtp: otp
      };
    }

    async _activateDeviceSession(acc, { deviceId, deviceLabel, forceTakeover }) {
      const now = this._now();
      const devId = String(deviceId || '').trim() || generateDeviceId();
      const devLbl = String(deviceLabel || '').trim() || detectDeviceLabel();

      const curSess = acc.activeSession;
      if (curSess && curSess.expiresAt > now && curSess.deviceId !== devId) {
        if (!forceTakeover) {
          return {
            ok: false,
            code: 'ACTIVE_SESSION_CONFLICT',
            error: `Tài khoản đang hoạt động trên "${curSess.deviceLabel}" (${curSess.deviceId}). Bạn có muốn thoát thiết bị kia để vào thiết bị này không?`,
            activeDevice: {
              deviceId: curSess.deviceId,
              deviceLabel: curSess.deviceLabel,
              issuedAt: curSess.issuedAt
            },
            deviceCount: acc.devices.length,
            maxDevices: MAX_DEVICES
          };
        }
        acc.kickedDevice = {
          deviceId: curSess.deviceId,
          kickedByLabel: devLbl,
          kickedAt: now
        };
      }

      if (!Array.isArray(acc.devices)) acc.devices = [];
      acc.devices.forEach((d) => { d.active = false; });

      let existingDev = acc.devices.find((d) => d.deviceId === devId);
      if (!existingDev) {
        if (acc.devices.length >= MAX_DEVICES) {
          // Evict oldest inactive device (respecting strict 3-device ceiling)
          acc.devices.sort((a, b) => (a.lastSeenAt || 0) - (b.lastSeenAt || 0));
          acc.devices.shift();
        }
        existingDev = {
          deviceId: devId,
          deviceLabel: devLbl,
          registeredAt: now,
          lastSeenAt: now,
          active: true
        };
        acc.devices.push(existingDev);
      } else {
        existingDev.deviceLabel = devLbl;
        existingDev.lastSeenAt = now;
        existingDev.active = true;
      }

      if (acc.kickedDevice && acc.kickedDevice.deviceId === devId) {
        acc.kickedDevice = null;
      }

      const sessionToken = `${newId()}.${randomHex(12)}`;
      const tokenHash = await hmacSha256Hex(this._hmacSecret, `${acc.email}:${devId}:${sessionToken}`);
      acc.activeSession = {
        tokenHash,
        deviceId: devId,
        deviceLabel: devLbl,
        issuedAt: now,
        expiresAt: now + SESSION_TTL_MS
      };

      return {
        ok: true,
        tookOver: Boolean(forceTakeover),
        sessionToken,
        deviceId: devId,
        user: toPublicUser(acc)
      };
    }

    async verifyRegisterAndActivate({ challengeId, email, otp, password, deviceId, deviceLabel, forceTakeover = false }) {
      const normalized = normalizeEmail(email);
      const ch = this._challenges.get(String(challengeId || ''));
      if (!ch || ch.email !== normalized) {
        return { ok: false, code: 'CHALLENGE_NOT_FOUND', error: 'Phiên OTP không tồn tại hoặc không khớp Gmail.' };
      }
      if (ch.used) {
        return { ok: false, code: 'OTP_ALREADY_USED', error: 'Mã OTP này đã được dùng.' };
      }
      if (ch.locked || ch.attempts >= OTP_MAX_ATTEMPTS) {
        ch.locked = true;
        return { ok: false, code: 'MAX_ATTEMPTS_EXCEEDED', error: 'Sai OTP quá 5 lần — hãy gửi lại mã mới.' };
      }
      if (this._now() > ch.expiresAt) {
        return { ok: false, code: 'OTP_EXPIRED', error: 'Mã OTP đã hết hạn (10 phút).' };
      }

      const cleanPass = String(password || '');
      if (cleanPass.length < 6) {
        return { ok: false, code: 'WEAK_PASSWORD', error: 'Mật khẩu riêng ứng dụng cần tối thiểu 6 ký tự.' };
      }

      const candHmac = await hmacSha256Hex(this._hmacSecret, `${ch.challengeId}:${ch.email}:${String(otp || '').trim()}`);
      if (!constantTimeEqual(candHmac, ch.otpHmac)) {
        ch.attempts += 1;
        if (ch.attempts >= OTP_MAX_ATTEMPTS) ch.locked = true;
        return {
          ok: false,
          code: 'INVALID_OTP',
          attemptsRemaining: Math.max(0, OTP_MAX_ATTEMPTS - ch.attempts),
          error: ch.locked ? 'Sai OTP quá 5 lần — đã khóa thử thách.' : `Mã OTP sai (còn ${OTP_MAX_ATTEMPTS - ch.attempts} lần).`
        };
      }

      const saltHex = randomHex(16);
      const passwordHash = await pbkdf2Hash(cleanPass, saltHex);
      const existingAcc = this._accounts.get(normalized);
      const isAdmin = normalized === ADMIN_EMAIL;

      const acc = existingAcc || {
        email: normalized,
        role: isAdmin ? 'ADMIN' : 'USER',
        liveActivated: isAdmin,
        saltHex,
        passwordHash,
        devices: [],
        activeSession: null,
        kickedDevice: null,
        createdAt: this._now()
      };
      acc.saltHex = saltHex;
      acc.passwordHash = passwordHash;
      if (isAdmin) {
        acc.role = 'ADMIN';
        acc.liveActivated = true;
      }

      const devOutcome = await this._activateDeviceSession(acc, {
        deviceId: deviceId || ch.deviceId,
        deviceLabel: deviceLabel || ch.deviceLabel,
        forceTakeover
      });
      if (!devOutcome.ok) {
        return devOutcome;
      }

      ch.used = true;
      this._accounts.set(normalized, acc);
      return devOutcome;
    }

    async login({ email, password, deviceId, deviceLabel, forceTakeover = false }) {
      const normalized = normalizeEmail(email);
      if (!isValidGmail(normalized)) {
        return { ok: false, code: 'INVALID_GMAIL', error: 'Vui lòng nhập đúng @gmail.com.' };
      }
      const acc = this._accounts.get(normalized);
      if (!acc) {
        return { ok: false, code: 'ACCOUNT_NOT_FOUND', error: 'Gmail chưa đăng ký — hãy chuyển sang tab "Đăng ký / OTP Gmail".' };
      }

      const candHash = await pbkdf2Hash(String(password || ''), acc.saltHex);
      if (!constantTimeEqual(candHash, acc.passwordHash)) {
        return { ok: false, code: 'INVALID_CREDENTIALS', error: 'Mật khẩu không đúng.' };
      }

      return this._activateDeviceSession(acc, { deviceId, deviceLabel, forceTakeover });
    }

    async validateSession({ email, sessionToken, deviceId }) {
      const normalized = normalizeEmail(email);
      const acc = this._accounts.get(normalized);
      if (!acc) {
        return { ok: false, code: 'NO_SESSION', error: 'Tài khoản không tồn tại.' };
      }
      const now = this._now();
      if (acc.kickedDevice && acc.kickedDevice.deviceId === deviceId && acc.activeSession && acc.activeSession.deviceId !== deviceId) {
        return {
          ok: false,
          code: 'SESSION_KICKED',
          kickedBy: acc.kickedDevice.kickedByLabel || acc.activeSession.deviceLabel || 'Thiết bị khác',
          error: `Tài khoản đã đăng nhập trên "${acc.kickedDevice.kickedByLabel || 'thiết bị khác'}" và tự thoát thiết bị này.`
        };
      }
      if (!acc.activeSession || now > acc.activeSession.expiresAt) {
        return { ok: false, code: 'SESSION_EXPIRED', error: 'Phiên đăng nhập đã hết hạn hoặc đã đăng xuất.' };
      }
      if (acc.activeSession.deviceId !== String(deviceId || '')) {
        return {
          ok: false,
          code: 'SESSION_KICKED',
          kickedBy: acc.activeSession.deviceLabel || 'Thiết bị khác',
          error: `Tài khoản đang đăng nhập trên "${acc.activeSession.deviceLabel}" nên phiên này đã thoát.`
        };
      }

      const candTokenHash = await hmacSha256Hex(this._hmacSecret, `${normalized}:${deviceId}:${String(sessionToken || '')}`);
      if (!constantTimeEqual(candTokenHash, acc.activeSession.tokenHash)) {
        return { ok: false, code: 'SESSION_INVALID', error: 'Phiên đăng nhập không hợp lệ.' };
      }

      const dev = (acc.devices || []).find((d) => d.deviceId === deviceId);
      if (dev) dev.lastSeenAt = now;
      return { ok: true, user: toPublicUser(acc) };
    }

    async logout({ email, sessionToken, deviceId }) {
      const check = await this.validateSession({ email, sessionToken, deviceId });
      const acc = this._accounts.get(normalizeEmail(email));
      if (check.ok && acc) {
        acc.activeSession = null;
        acc.devices.forEach((d) => { if (d.deviceId === deviceId) d.active = false; });
      }
      return { ok: true };
    }

    async issueLiveActivationKey({ adminEmail, adminSessionToken, adminDeviceId, targetEmail = '*', note = '' }) {
      const check = await this.validateSession({ email: adminEmail, sessionToken: adminSessionToken, deviceId: adminDeviceId });
      if (!check.ok) return check;
      if (check.user.role !== 'ADMIN' || check.user.email !== ADMIN_EMAIL) {
        return { ok: false, code: 'FORBIDDEN', error: 'Chỉ tài khoản Admin traicaysaigonhanoi123@gmail.com mới có quyền cấp mã LIVE.' };
      }

      const normTarget = targetEmail && targetEmail !== '*' ? normalizeEmail(targetEmail) : '*';
      if (normTarget !== '*' && !isValidGmail(normTarget)) {
        return { ok: false, code: 'INVALID_GMAIL', error: 'Gmail đích không hợp lệ (hoặc để trống để tạo mã dùng chung 1 lần).' };
      }

      const keyPlain = generateLiveKeyPlain();
      const keyHash = await hmacSha256Hex(this._hmacSecret, `livekey:${keyPlain}`);
      const id = newId();
      const record = {
        id,
        keyHash,
        keyHint: `${keyPlain.slice(0, 9)}-****-${keyPlain.slice(-4)}`,
        targetEmail: normTarget,
        note: String(note || '').slice(0, 80),
        createdAt: this._now(),
        createdBy: check.user.email,
        usedBy: null,
        usedAt: null,
        revoked: false
      };
      this._liveKeys.set(id, record);
      return {
        ok: true,
        activationKey: keyPlain,
        keyRecord: {
          id: record.id,
          keyHint: record.keyHint,
          targetEmail: record.targetEmail,
          note: record.note,
          createdAt: record.createdAt,
          usedBy: null,
          usedAt: null,
          revoked: false
        }
      };
    }

    async listAdminKeys({ adminEmail, adminSessionToken, adminDeviceId }) {
      const check = await this.validateSession({ email: adminEmail, sessionToken: adminSessionToken, deviceId: adminDeviceId });
      if (!check.ok) return check;
      if (check.user.role !== 'ADMIN' || check.user.email !== ADMIN_EMAIL) {
        return { ok: false, code: 'FORBIDDEN', error: 'Không có quyền Admin.' };
      }
      const list = Array.from(this._liveKeys.values())
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((k) => ({
          id: k.id,
          keyHint: k.keyHint,
          targetEmail: k.targetEmail,
          note: k.note,
          createdAt: k.createdAt,
          usedBy: k.usedBy,
          usedAt: k.usedAt,
          revoked: k.revoked
        }));
      return { ok: true, keys: list };
    }

    async revokeLiveKey({ adminEmail, adminSessionToken, adminDeviceId, keyId }) {
      const check = await this.validateSession({ email: adminEmail, sessionToken: adminSessionToken, deviceId: adminDeviceId });
      if (!check.ok) return check;
      if (check.user.role !== 'ADMIN' || check.user.email !== ADMIN_EMAIL) {
        return { ok: false, code: 'FORBIDDEN', error: 'Không có quyền Admin.' };
      }
      const rec = this._liveKeys.get(String(keyId || ''));
      if (!rec) return { ok: false, error: 'Không tìm thấy mã kích hoạt.' };
      rec.revoked = true;
      return { ok: true };
    }

    async activateLiveKey({ email, sessionToken, deviceId, activationKey }) {
      const check = await this.validateSession({ email, sessionToken, deviceId });
      if (!check.ok) return check;

      const cleanKey = normalizeActivationKey(activationKey);
      if (!/^LIVE-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(cleanKey)) {
        return { ok: false, code: 'INVALID_KEY_FORMAT', error: 'Mã kích hoạt phải có dạng LIVE-XXXX-XXXX-XXXX.' };
      }

      const candHash = await hmacSha256Hex(this._hmacSecret, `livekey:${cleanKey}`);
      let matched = null;
      for (const rec of this._liveKeys.values()) {
        if (constantTimeEqual(rec.keyHash, candHash)) {
          matched = rec;
          break;
        }
      }

      if (!matched) {
        return { ok: false, code: 'KEY_NOT_FOUND', error: 'Mã kích hoạt không hợp lệ hoặc không do Admin cấp.' };
      }
      if (matched.revoked) {
        return { ok: false, code: 'KEY_REVOKED', error: 'Mã kích hoạt này đã bị Admin thu hồi.' };
      }
      if (matched.usedBy) {
        return { ok: false, code: 'KEY_ALREADY_USED', error: `Mã kích hoạt này đã được dùng bởi ${matched.usedBy}.` };
      }
      if (matched.targetEmail !== '*' && matched.targetEmail !== check.user.email) {
        return { ok: false, code: 'KEY_EMAIL_MISMATCH', error: `Mã kích hoạt này chỉ dành riêng cho ${matched.targetEmail}.` };
      }

      const acc = this._accounts.get(check.user.email);
      matched.usedBy = acc.email;
      matched.usedAt = this._now();
      acc.liveActivated = true;
      return { ok: true, user: toPublicUser(acc) };
    }

    async revokeDevice({ email, sessionToken, deviceId, targetDeviceId }) {
      const check = await this.validateSession({ email, sessionToken, deviceId });
      if (!check.ok) return check;
      const acc = this._accounts.get(check.user.email);
      acc.devices = (acc.devices || []).filter((d) => d.deviceId !== targetDeviceId);
      if (acc.activeSession && acc.activeSession.deviceId === targetDeviceId) {
        acc.activeSession = null;
      }
      return { ok: true, user: toPublicUser(acc) };
    }
  }

  QuantumAccountAuth.ADMIN_EMAIL = ADMIN_EMAIL;
  QuantumAccountAuth.MAX_DEVICES = MAX_DEVICES;
  QuantumAccountAuth.detectDeviceLabel = detectDeviceLabel;
  QuantumAccountAuth.generateDeviceId = generateDeviceId;

  return QuantumAccountAuth;
});
