/* ==========================================================================
   QUANTUM CORE // Zero-Trust HTTP Server (Node.js built-in, zero npm bloat)
   - HttpOnly; SameSite=Strict session cookies (qc_sid)
   - HMAC-SHA256 2FA OTP endpoints (/api/v1/auth/otp/request, verify, session, revoke)
   - Per-IP sliding-window rate limiter + security headers + path-traversal guard
   ========================================================================== */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const QuantumUUID = require('../src/core/uuid.js');
const QuantumSecurityGate = require('../src/core/securityGate.js');
import { fetchExchangeBalance } from './exchangeBalanceAdapter.mjs';
import {
  placeExchangeOrder,
  modifyExchangeStopLoss,
  cancelExchangeOrder,
  closeExchangePosition,
  fetchExchangePositions
} from './exchangeOrderAdapter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';

const securityGate = new QuantumSecurityGate({
  hmacKey: process.env.QUANTUM_OTP_SECRET || QuantumUUID.v4()
});

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8'
};

// Sliding-window per-IP rate limiter
const rateBuckets = new Map();
function checkRateLimit(ip, bucketKey, maxPerMin) {
  const now = Date.now();
  const key = `${ip}:${bucketKey}`;
  const list = (rateBuckets.get(key) || []).filter((ts) => now - ts < 60000);
  if (list.length >= maxPerMin) return false;
  list.push(now);
  rateBuckets.set(key, list);
  return true;
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '127.0.0.1';
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cache-Control', 'no-store');
}

function sendJson(res, status, payload, extraHeaders = {}) {
  applySecurityHeaders(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

function isLoopbackIp(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function getSafeLoopbackCors(req, ip) {
  if (!isLoopbackIp(ip)) return { allowed: false, headers: {} };
  const origin = req.headers.origin;
  if (!origin) return { allowed: true, headers: {} };
  const isLocalOrigin =
    origin === 'null' ||
    origin.startsWith('http://127.0.0.1:') ||
    origin.startsWith('http://localhost:') ||
    origin === 'http://127.0.0.1' ||
    origin === 'http://localhost';
  if (!isLocalOrigin) return { allowed: false, headers: {} };
  return {
    allowed: true,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    }
  };
}

async function readJsonBody(req, maxBytes = 16384) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function serveStatic(reqPath, res) {
  const cleanPath = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
  // Block access to sensitive internal directories/files
  if (
    cleanPath.startsWith('server/') ||
    cleanPath.startsWith('tests/') ||
    cleanPath.startsWith('.ai-memory/') ||
    cleanPath.startsWith('.') ||
    cleanPath === 'package.json'
  ) {
    sendJson(res, 403, { ok: false, error: 'FORBIDDEN' });
    return;
  }

  const resolved = path.resolve(ROOT_DIR, cleanPath);
  if (!resolved.startsWith(ROOT_DIR + path.sep) && resolved !== ROOT_DIR) {
    sendJson(res, 403, { ok: false, error: 'PATH_TRAVERSAL_BLOCKED' });
    return;
  }

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND' });
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    const data = await fs.readFile(resolved);
    applySecurityHeaders(res);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  } catch (_) {
    sendJson(res, 404, { ok: false, error: 'NOT_FOUND' });
  }
}

const server = http.createServer(async (req, res) => {
  const ip = getClientIp(req);
  const urlObj = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = urlObj.pathname;

  if (!checkRateLimit(ip, 'global', 120)) {
    return sendJson(res, 429, { ok: false, error: 'RATE_LIMIT_EXCEEDED' });
  }

  // API v1 Routes (Loopback CORS enabled for file:/// and localhost terminals)
  if (pathname.startsWith('/api/v1/')) {
    const cors = getSafeLoopbackCors(req, ip);
    if (!cors.allowed) {
      return sendJson(res, 403, { ok: false, error: 'LOOPBACK_ORIGIN_ONLY' });
    }
    if (req.method === 'OPTIONS') {
      applySecurityHeaders(res);
      res.writeHead(204, cors.headers);
      return res.end();
    }

    if (pathname === '/api/v1/health' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        service: 'quantum-core',
        requestId: QuantumUUID.v4(),
        timestamp: new Date().toISOString()
      }, cors.headers);
    }

    if (pathname.startsWith('/api/v1/auth/') && !checkRateLimit(ip, 'auth', 15)) {
      return sendJson(res, 429, { ok: false, error: 'AUTH_RATE_LIMIT_EXCEEDED' }, cors.headers);
    }

    if (pathname === '/api/v1/auth/otp/request' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const result = await securityGate.requestOtp({
          email: body.email,
          ip,
          role: 'TRADER'
        });
        return sendJson(res, result.ok ? 200 : 400, result, cors.headers);
      } catch (_) {
        return sendJson(res, 400, { ok: false, error: 'INVALID_JSON' }, cors.headers);
      }
    }

    if (pathname === '/api/v1/auth/otp/verify' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const result = await securityGate.verifyOtp({
          challengeId: body.challengeId,
          otp: body.otp,
          ip
        });
        if (!result.ok) {
          return sendJson(res, 401, result, cors.headers);
        }
        const cookieVal = `qc_sid=${encodeURIComponent(result.session.sessionId)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`;
        return sendJson(res, 200, result, { ...cors.headers, 'Set-Cookie': cookieVal });
      } catch (_) {
        return sendJson(res, 400, { ok: false, error: 'INVALID_JSON' }, cors.headers);
      }
    }

    if (pathname === '/api/v1/auth/session' && req.method === 'GET') {
      const cookies = parseCookies(req);
      const check = securityGate.validateSession(cookies.qc_sid, ip, 'TRADER');
      return sendJson(res, check.ok ? 200 : 401, check, cors.headers);
    }

    if (pathname === '/api/v1/auth/sessions/revoke' && req.method === 'POST') {
      const revoked = securityGate.revokeAllSessions();
      return sendJson(res, 200, revoked, {
        ...cors.headers,
        'Set-Cookie': 'qc_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
      });
    }

    if (pathname === '/api/v1/exchange/balance') {
      const cors = getSafeLoopbackCors(req, ip);
      if (!cors.allowed) {
        return sendJson(res, 403, { ok: false, error: 'LOOPBACK_ORIGIN_ONLY' });
      }
      if (req.method === 'OPTIONS') {
        applySecurityHeaders(res);
        res.writeHead(204, cors.headers);
        return res.end();
      }
      if (req.method === 'POST') {
        if (!checkRateLimit(ip, 'exchange_balance', 12)) {
          return sendJson(res, 429, { ok: false, error: 'BALANCE_RATE_LIMIT_EXCEEDED' }, cors.headers);
        }
        try {
          const body = await readJsonBody(req, 8192);
          const out = await fetchExchangeBalance(body);
          return sendJson(res, out.ok ? 200 : 400, out, cors.headers);
        } catch (_) {
          return sendJson(res, 400, { ok: false, error: 'INVALID_JSON' }, cors.headers);
        }
      }
    }

    const orderRoutes = {
      '/api/v1/exchange/order/place': { limitKey: 'exchange_order', maxPerMin: 30, fn: placeExchangeOrder },
      '/api/v1/exchange/order/modify-sl': { limitKey: 'exchange_order', maxPerMin: 30, fn: modifyExchangeStopLoss },
      '/api/v1/exchange/order/cancel': { limitKey: 'exchange_order', maxPerMin: 30, fn: cancelExchangeOrder },
      '/api/v1/exchange/order/close': { limitKey: 'exchange_order', maxPerMin: 30, fn: closeExchangePosition },
      '/api/v1/exchange/positions': { limitKey: 'exchange_pos', maxPerMin: 20, fn: fetchExchangePositions }
    };
    const matchedOrderRoute = orderRoutes[pathname];
    if (matchedOrderRoute) {
      const cors = getSafeLoopbackCors(req, ip);
      if (!cors.allowed) {
        return sendJson(res, 403, { ok: false, error: 'LOOPBACK_ORIGIN_ONLY' });
      }
      if (req.method === 'OPTIONS') {
        applySecurityHeaders(res);
        res.writeHead(204, cors.headers);
        return res.end();
      }
      if (req.method === 'POST') {
        if (!checkRateLimit(ip, matchedOrderRoute.limitKey, matchedOrderRoute.maxPerMin)) {
          return sendJson(res, 429, { ok: false, error: 'ORDER_RATE_LIMIT_EXCEEDED' }, cors.headers);
        }
        try {
          const body = await readJsonBody(req, 16384);
          const cookies = parseCookies(req);
          const sid = cookies.qc_sid || body?.sessionId;
          const sessCheck = securityGate.validateSession(sid, ip, 'TRADER');
          if (!sessCheck.ok) {
            return sendJson(res, 401, { ok: false, error: `ZERO_TRUST_2FA_REQUIRED: ${sessCheck.error}` }, cors.headers);
          }
          const out = await matchedOrderRoute.fn(body);
          return sendJson(res, out.ok ? 200 : 400, out, cors.headers);
        } catch (_) {
          return sendJson(res, 400, { ok: false, error: 'INVALID_JSON' }, cors.headers);
        }
      }
    }

    return sendJson(res, 404, { ok: false, error: 'API_ENDPOINT_NOT_FOUND' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  return serveStatic(pathname, res);
});

server.listen(PORT, HOST, () => {
  console.log(`QUANTUM CORE Zero-Trust Server listening at http://${HOST}:${PORT}`);
});
