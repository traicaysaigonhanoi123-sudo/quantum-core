/* ==========================================================================
   QUANTUM CORE // Runtime Schema Validators & Public DTO Whitelisters
   Strips sensitive credentials/secrets and enforces strict input contracts
   ========================================================================== */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.QuantumSchemas = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  const VALID_SYMBOLS = new Set(['BTC-PERP', 'ETH-PERP', 'SOL-PERP', 'HYPE-PERP', 'BNB-PERP', 'XRP-PERP', 'DOGE-PERP']);
  const DYNAMIC_SYMBOL_REGEX = /^[A-Z0-9]{2,16}-PERP$/;
  const VALID_EXCHANGES = new Set(['ALL', 'HYPERLIQUID', 'BINANCE', 'BYBIT', 'OKX', 'DERIBIT']);
  const VALID_SIDES = new Set(['LONG', 'SHORT']);
  const SENSITIVE_KEYS = new Set([
    'apiSecret',
    'secret',
    'agentKey',
    'privateKey',
    'otpHmac',
    'otp',
    'sessionToken',
    'passphrase',
    'password'
  ]);

  function isValidSymbol(symbol) {
    return typeof symbol === 'string' && (VALID_SYMBOLS.has(symbol) || DYNAMIC_SYMBOL_REGEX.test(symbol));
  }

  function registerSymbol(symbol) {
    if (typeof symbol === 'string' && DYNAMIC_SYMBOL_REGEX.test(symbol)) {
      VALID_SYMBOLS.add(symbol);
      return true;
    }
    return false;
  }

  function validateOrderInput(input) {
    const errors = [];
    if (!input || typeof input !== 'object') {
      return { ok: false, errors: ['Payload đặt lệnh không hợp lệ.'] };
    }
    const symbol = input.symbol;
    const exchange = input.exchange || 'HYPERLIQUID';
    const side = input.side;
    const sizeUsd = Number(input.sizeUsd);
    const leverage = Number(input.leverage);
    const slPct = Number(input.slPct);
    const tpPct = Number(input.tpPct);

    if (!isValidSymbol(symbol)) errors.push(`Mã giao dịch không hỗ trợ: ${symbol}`);
    if (!VALID_EXCHANGES.has(exchange)) errors.push(`Sàn không hỗ trợ: ${exchange}`);
    if (!VALID_SIDES.has(side)) errors.push(`Hướng lệnh phải là LONG hoặc SHORT`);
    if (!Number.isFinite(sizeUsd) || sizeUsd < 5 || sizeUsd > 5000000) {
      errors.push('Kích thước lệnh phải nằm trong khoảng $5 - $5,000,000');
    }
    if (!Number.isFinite(leverage) || leverage < 1 || leverage > 50) {
      errors.push('Đòn bẩy phải nằm trong khoảng 1x - 50x');
    }
    if (input.slPct !== undefined && (!Number.isFinite(slPct) || slPct <= 0 || slPct > 50)) {
      errors.push('Stop Loss % không hợp lệ');
    }
    if (input.tpPct !== undefined && (!Number.isFinite(tpPct) || tpPct <= 0 || tpPct > 200)) {
      errors.push('Take Profit % không hợp lệ');
    }
    if (input.entryPrice !== undefined && (!Number.isFinite(Number(input.entryPrice)) || Number(input.entryPrice) <= 0)) {
      errors.push('Giá Entry phải lớn hơn 0');
    }

    return { ok: errors.length === 0, errors };
  }

  function validateMarketTick(tick) {
    if (!tick || typeof tick !== 'object') return { ok: false, error: 'Tick rỗng' };
    if (!isValidSymbol(tick.symbol)) return { ok: false, error: 'Sai mã symbol' };
    const price = Number(tick.price);
    if (!Number.isFinite(price) || price <= 0) return { ok: false, error: 'Giá không hợp lệ' };
    if (tick.funding8h !== undefined && !Number.isFinite(Number(tick.funding8h))) {
      return { ok: false, error: 'Funding rate không hợp lệ' };
    }
    return { ok: true };
  }

  function scrubSensitive(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map((item) => scrubSensitive(item));
    const clean = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SENSITIVE_KEYS.has(k)) continue;
      clean[k] = typeof v === 'object' && v !== null ? scrubSensitive(v) : v;
    }
    return clean;
  }

  function toPositionPublicDTO(p) {
    return {
      id: p.id,
      symbol: p.symbol,
      exchange: p.exchange,
      side: p.side,
      entryPrice: p.entryPrice,
      markPrice: p.markPrice,
      slPrice: p.slPrice,
      tpPrice: p.tpPrice,
      sizeUsd: p.sizeUsd,
      leverage: p.leverage,
      marginUsd: p.marginUsd,
      unrealizedPnl: p.unrealizedPnl,
      roePct: p.roePct,
      beLocked: Boolean(p.beLocked),
      trailingActive: Boolean(p.trailingActive),
      tpExtensions: Number(p.tpExtensions) || 0,
      hedgeGroupId: p.hedgeGroupId || null,
      accruedFundingUsd: p.accruedFundingUsd || 0,
      source: p.source
    };
  }

  function toOrderPublicDTO(o) {
    return {
      id: o.id,
      symbol: o.symbol,
      exchange: o.exchange,
      side: o.side,
      entryPrice: o.entryPrice,
      slPrice: o.slPrice,
      tpPrice: o.tpPrice,
      sizeUsd: o.sizeUsd,
      leverage: o.leverage,
      marginUsd: o.marginUsd,
      source: o.source,
      hedgeGroupId: o.hedgeGroupId || null,
      createdAt: o.createdAt
    };
  }

  function toHistoryPublicDTO(h) {
    return {
      id: h.id,
      time: h.time,
      closedAt: h.closedAt ?? null,
      dateKey: h.dateKey ?? null,
      symbol: h.symbol,
      exchange: h.exchange,
      side: h.side,
      entryPrice: h.entryPrice,
      exitPrice: h.exitPrice,
      reason: h.reason,
      grossPnl: h.grossPnl ?? h.pnl,
      feeUsd: h.feeUsd ?? 0,
      entryFeeUsd: h.entryFeeUsd ?? 0,
      exitFeeUsd: h.exitFeeUsd ?? 0,
      entryFeeBps: h.entryFeeBps ?? 0,
      exitFeeBps: h.exitFeeBps ?? 0,
      pnl: h.pnl
    };
  }

  function toSessionPublicDTO(s) {
    if (!s) return null;
    return {
      sessionId: s.sessionId,
      email: s.email,
      role: s.role,
      expiresAt: s.expiresAt,
      createdAt: s.createdAt
    };
  }

  return {
    VALID_SYMBOLS,
    VALID_EXCHANGES,
    VALID_SIDES,
    isValidSymbol,
    registerSymbol,
    validateOrderInput,
    validateMarketTick,
    scrubSensitive,
    toPositionPublicDTO,
    toOrderPublicDTO,
    toHistoryPublicDTO,
    toSessionPublicDTO
  };
});
