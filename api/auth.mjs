/* ==========================================================================
   QUANTUM CORE // Auth, 3-Device Takeover & Live Activation API (Vercel + Node)
   - Supports optional RESEND_API_KEY (real Gmail OTP delivery via Resend REST API)
   - Supports optional UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (shared DB)
   - Falls back cleanly to in-memory store when running standalone locally
   ========================================================================== */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const QuantumAccountAuth = require('../src/core/accountAuth.js');

const AUTH_DB_KEY = 'quantum_core:auth_db:v1';
const globalAuth = new QuantumAccountAuth({
  hmacSecret: process.env.QC_ADMIN_SECRET || process.env.QUANTUM_OTP_SECRET || 'quantum-core-zero-trust-auth-secret-v1'
});

function hasUpstashStore() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

function hasMailServer() {
  return Boolean(process.env.RESEND_API_KEY);
}

async function loadSharedDb() {
  if (!hasUpstashStore()) return;
  try {
    const base = process.env.UPSTASH_REDIS_REST_URL.replace(/\/+$/, '');
    const res = await fetch(`${base}/get/${encodeURIComponent(AUTH_DB_KEY)}`, {
      headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
    });
    if (!res.ok) return;
    const json = await res.json();
    if (json && typeof json.result === 'string' && json.result.length > 2) {
      globalAuth.importDb(JSON.parse(json.result));
    }
  } catch (_) {}
}

async function saveSharedDb() {
  if (!hasUpstashStore()) return;
  try {
    const base = process.env.UPSTASH_REDIS_REST_URL.replace(/\/+$/, '');
    const payload = JSON.stringify(globalAuth.exportDb());
    await fetch(`${base}/set/${encodeURIComponent(AUTH_DB_KEY)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  } catch (_) {}
}

async function sendGmailOtpViaResend({ toEmail, otp, deviceLabel }) {
  if (!hasMailServer()) return { sent: false };
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'QUANTUM CORE Security <onboarding@resend.dev>';
  const html = `
    <div style="font-family:Arial,sans-serif;background:#080b11;color:#e2ecf8;padding:24px;border-radius:8px;max-width:480px;">
      <h2 style="color:#fbbf24;margin:0 0 12px;">QUANTUM CORE // Xác thực Gmail OTP</h2>
      <p style="font-size:14px;line-height:1.5;color:#cbd5e1;">Mã OTP xác thực đăng ký &amp; kích hoạt thiết bị <strong>${deviceLabel}</strong>:</p>
      <div style="font-size:28px;font-weight:800;letter-spacing:6px;color:#00f0ff;background:#0d1422;padding:14px 18px;border:1px solid #1e293b;border-radius:6px;text-align:center;margin:16px 0;">
        ${otp}
      </div>
      <p style="font-size:12px;color:#94a3b8;">Mã có hiệu lực trong 10 phút. Tuyệt đối không chia sẻ mã này cho bất kỳ ai.</p>
    </div>
  `;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        subject: `[QUANTUM CORE] Mã OTP xác thực Gmail: ${otp}`,
        html
      })
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { sent: false, error: `Resend HTTP ${res.status}: ${txt.slice(0, 120)}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err?.message || 'Resend send failed' };
  }
}

export async function processAuthAction(method, query = {}, body = {}) {
  if (method === 'OPTIONS') {
    return { status: 204, body: null };
  }

  await loadSharedDb();

  const action = String((method === 'GET' ? query.action : body.action) || 'status').toLowerCase();

  if (action === 'status') {
    return {
      status: 200,
      body: {
        ok: true,
        adminEmail: QuantumAccountAuth.ADMIN_EMAIL,
        maxDevices: QuantumAccountAuth.MAX_DEVICES,
        mailServerConnected: hasMailServer(),
        multiDeviceDb: hasUpstashStore() ? 'UPSTASH_REDIS' : 'MEMORY'
      }
    };
  }

  if (action === 'captcha') {
    const res = globalAuth.createMathCaptcha();
    await saveSharedDb();
    return { status: 200, body: res };
  }

  if (action === 'register_otp') {
    const res = await globalAuth.requestRegisterOtp({
      email: body.email,
      captchaId: body.captchaId,
      captchaAnswer: body.captchaAnswer,
      deviceId: body.deviceId,
      deviceLabel: body.deviceLabel
    });
    if (!res.ok) {
      await saveSharedDb();
      return { status: 400, body: res };
    }
    if (hasMailServer()) {
      const mailRes = await sendGmailOtpViaResend({
        toEmail: res.email,
        otp: res.devPreviewOtp,
        deviceLabel: body.deviceLabel || 'Thiết bị mới'
      });
      if (mailRes.sent) {
        delete res.devPreviewOtp;
        res.mailSent = true;
      } else {
        res.mailWarning = mailRes.error;
      }
    }
    await saveSharedDb();
    return { status: 200, body: res };
  }

  if (action === 'verify_register') {
    const res = await globalAuth.verifyRegisterAndActivate(body);
    await saveSharedDb();
    const status = res.ok ? 200 : (res.code === 'ACTIVE_SESSION_CONFLICT' ? 409 : 400);
    return { status, body: res };
  }

  if (action === 'login') {
    const res = await globalAuth.login(body);
    await saveSharedDb();
    const status = res.ok ? 200 : (res.code === 'ACTIVE_SESSION_CONFLICT' ? 409 : 401);
    return { status, body: res };
  }

  if (action === 'session_check') {
    const res = await globalAuth.validateSession(body);
    await saveSharedDb();
    return { status: res.ok ? 200 : 401, body: res };
  }

  if (action === 'logout') {
    const res = await globalAuth.logout(body);
    await saveSharedDb();
    return { status: 200, body: res };
  }

  if (action === 'activate_live') {
    const res = await globalAuth.activateLiveKey(body);
    await saveSharedDb();
    return { status: res.ok ? 200 : 400, body: res };
  }

  if (action === 'admin_issue_key') {
    const res = await globalAuth.issueLiveActivationKey(body);
    await saveSharedDb();
    return { status: res.ok ? 200 : 403, body: res };
  }

  if (action === 'admin_list_keys') {
    const res = await globalAuth.listAdminKeys(body);
    return { status: res.ok ? 200 : 403, body: res };
  }

  if (action === 'admin_revoke_key') {
    const res = await globalAuth.revokeLiveKey(body);
    await saveSharedDb();
    return { status: res.ok ? 200 : 403, body: res };
  }

  if (action === 'device_revoke') {
    const res = await globalAuth.revokeDevice(body);
    await saveSharedDb();
    return { status: res.ok ? 200 : 400, body: res };
  }

  return { status: 400, body: { ok: false, error: `Unknown auth action: ${action}` } };
}

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  let body = req.body;
  if (typeof body === 'string' && body.length > 0) {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  if (!body || typeof body !== 'object') {
    body = {};
  }
  const query = req.query || {};
  const result = await processAuthAction(req.method || 'GET', query, body);
  if (result.status === 204) {
    res.status(204).end();
    return;
  }
  res.status(result.status).json(result.body);
}
