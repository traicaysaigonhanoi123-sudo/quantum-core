/* ==========================================================================
   QUANTUM CORE // Multi-Exchange Real Order Execution Adapter (5 Venues)
   - Supports Testnet (default safe) & Mainnet across:
     HYPERLIQUID, BINANCE, BYBIT, OKX, DERIBIT
   - Enforces step/tick/contract quantization, notional safety caps & DTO scrubbing
   - Injectable fetchFn & nowFn for deterministic unit testing
   ========================================================================== */

import { createHmac } from 'node:crypto';
import { signHyperliquidL1Action } from './hlEip712Signer.mjs';

const SUPPORTED_VENUES = new Set(['HYPERLIQUID', 'BINANCE', 'BYBIT', 'OKX', 'DERIBIT']);
const specCache = new Map();

function trimZeros(str) {
  if (!str.includes('.')) return str;
  const trimmed = str.replace(/\.?0+$/, '');
  return trimmed === '' || trimmed === '-0' ? '0' : trimmed;
}

export function quantizeStep(value, step, mode = 'floor') {
  const v = Number(value);
  const s = Number(step);
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (!Number.isFinite(s) || s <= 0) return trimZeros(v.toFixed(6));
  const inv = 1 / s;
  const scaled = mode === 'round' ? Math.round(v * inv) : Math.floor((v * inv) + 1e-9);
  const dec = (String(s).split('.')[1] || '').length;
  const out = (Math.max(1, scaled) * s).toFixed(Math.min(8, dec));
  return trimZeros(out);
}

export function formatHlPrice(price, szDecimals = 2) {
  const px = Number(price);
  if (!Number.isFinite(px) || px <= 0) return '0';
  if (Number.isInteger(px)) return String(px);
  const sigStr = Number(px.toPrecision(5));
  const maxDec = Math.max(0, 6 - (Number(szDecimals) || 0));
  return trimZeros(sigStr.toFixed(Math.min(8, maxDec)));
}

export function formatHlSize(qty, szDecimals = 3) {
  const q = Number(qty);
  if (!Number.isFinite(q) || q <= 0) return '0';
  const dec = Math.max(0, Math.min(6, Number(szDecimals) || 0));
  const step = Math.pow(10, -dec);
  const floored = Math.floor((q / step) + 1e-9) * step;
  return trimZeros(Math.max(step, floored).toFixed(dec));
}

function buildFetchOpts(method, headers, bodyObj, useDefaultTimeout) {
  const opts = { method, headers: headers || {} };
  if (bodyObj !== undefined) {
    opts.body = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
  }
  if (useDefaultTimeout && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    opts.signal = AbortSignal.timeout(10000);
  }
  return opts;
}

export function resolveVenueSymbol(canonicalSymbol, venue, explicitVenueSymbol = null) {
  if (explicitVenueSymbol && typeof explicitVenueSymbol === 'string') {
    return explicitVenueSymbol.trim();
  }
  const base = String(canonicalSymbol || 'BTC-PERP').toUpperCase().replace(/-PERP$/, '');
  if (venue === 'BINANCE' || venue === 'BYBIT') return `${base}USDT`;
  if (venue === 'OKX') return `${base}-USDT-SWAP`;
  if (venue === 'DERIBIT') {
    if (base === 'BTC' || base === 'ETH') return `${base}-PERPETUAL`;
    return `${base}_USDC-PERPETUAL`;
  }
  return base;
}

function fallbackSpecs(refPrice) {
  const p = Number(refPrice) || 50000;
  let qtyStep = 0.001;
  let tickSize = 0.1;
  let szDecimals = 3;
  if (p < 0.2) { qtyStep = 10; tickSize = 0.00001; szDecimals = 0; }
  else if (p < 5) { qtyStep = 1; tickSize = 0.0001; szDecimals = 0; }
  else if (p < 100) { qtyStep = 0.1; tickSize = 0.01; szDecimals = 1; }
  else if (p < 1000) { qtyStep = 0.01; tickSize = 0.05; szDecimals = 2; }
  return { qtyStep, tickSize, ctVal: 1, szDecimals, assetId: 0 };
}

async function getVenueInstrumentSpec({ venue, net, venueSymbol, refPrice }, fetchFn, useDefaultTimeout) {
  const cacheKey = `${venue}:${net}:${venueSymbol}`;
  const cached = specCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < 300000) return cached.spec;

  const fb = fallbackSpecs(refPrice);
  try {
    if (venue === 'BINANCE') {
      const base = net === 'TESTNET' ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
      const r = await fetchFn(`${base}/fapi/v1/exchangeInfo`, buildFetchOpts('GET', {}, undefined, useDefaultTimeout));
      if (r.ok) {
        const j = await r.json();
        const hit = (j?.symbols || []).find((s) => s.symbol === venueSymbol);
        if (hit) {
          const lot = (hit.filters || []).find((f) => f.filterType === 'LOT_SIZE');
          const pxF = (hit.filters || []).find((f) => f.filterType === 'PRICE_FILTER');
          const spec = {
            qtyStep: parseFloat(lot?.stepSize) || fb.qtyStep,
            tickSize: parseFloat(pxF?.tickSize) || fb.tickSize,
            ctVal: 1
          };
          specCache.set(cacheKey, { ts: Date.now(), spec });
          return spec;
        }
      }
    } else if (venue === 'BYBIT') {
      const base = net === 'TESTNET' ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
      const r = await fetchFn(`${base}/v5/market/instruments-info?category=linear&symbol=${encodeURIComponent(venueSymbol)}`, buildFetchOpts('GET', {}, undefined, useDefaultTimeout));
      if (r.ok) {
        const j = await r.json();
        const hit = j?.result?.list?.[0];
        if (hit) {
          const spec = {
            qtyStep: parseFloat(hit.lotSizeFilter?.qtyStep) || fb.qtyStep,
            tickSize: parseFloat(hit.priceFilter?.tickSize) || fb.tickSize,
            ctVal: 1
          };
          specCache.set(cacheKey, { ts: Date.now(), spec });
          return spec;
        }
      }
    } else if (venue === 'OKX') {
      const headers = net === 'TESTNET' ? { 'x-simulated-trading': '1' } : {};
      const r = await fetchFn(`https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=${encodeURIComponent(venueSymbol)}`, buildFetchOpts('GET', headers, undefined, useDefaultTimeout));
      if (r.ok) {
        const j = await r.json();
        const hit = j?.data?.[0];
        if (hit) {
          const spec = {
            qtyStep: parseFloat(hit.lotSz) || 1,
            tickSize: parseFloat(hit.tickSz) || fb.tickSize,
            ctVal: parseFloat(hit.ctVal) || 1
          };
          specCache.set(cacheKey, { ts: Date.now(), spec });
          return spec;
        }
      }
    } else if (venue === 'HYPERLIQUID') {
      const base = net === 'TESTNET' ? 'https://api.hyperliquid-testnet.xyz/info' : 'https://api.hyperliquid.xyz/info';
      const r = await fetchFn(base, buildFetchOpts('POST', { 'Content-Type': 'application/json' }, { type: 'meta' }, useDefaultTimeout));
      if (r.ok) {
        const j = await r.json();
        const universe = Array.isArray(j?.universe) ? j.universe : [];
        const idx = universe.findIndex((u) => String(u.name).toUpperCase() === venueSymbol.toUpperCase());
        if (idx >= 0) {
          const spec = {
            assetId: idx,
            szDecimals: Number(universe[idx].szDecimals) || 0,
            qtyStep: Math.pow(10, -(Number(universe[idx].szDecimals) || 0)),
            tickSize: fb.tickSize
          };
          specCache.set(cacheKey, { ts: Date.now(), spec });
          return spec;
        }
      }
    }
  } catch (_) {}

  if (venue === 'HYPERLIQUID') {
    const hlFallbackMap = { BTC: { assetId: 0, szDecimals: 5 }, ETH: { assetId: 1, szDecimals: 4 }, SOL: { assetId: 5, szDecimals: 2 } };
    const hit = hlFallbackMap[venueSymbol.toUpperCase()];
    if (hit) return { ...fb, ...hit };
  }
  return fb;
}

/* ==================== 1. BINANCE FUTURES ==================== */
function binanceSign(qs, secret) {
  return createHmac('sha256', secret).update(qs).digest('hex');
}

async function binancePlaceOrder(p, fetchFn, nowFn, useDefaultTimeout) {
  const { apiKey, apiSecret, net, symbol, side, orderType, sizeUsd, price, leverage, slPrice, tpPrice, isMaker } = p;
  if (!apiKey || !apiSecret) return { ok: false, error: 'Thiếu Binance API Key / Secret.' };
  const baseUrl = net === 'TESTNET' ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
  const venueSym = resolveVenueSymbol(symbol, 'BINANCE', p.venueSymbol);
  const spec = await getVenueInstrumentSpec({ venue: 'BINANCE', net, venueSymbol: venueSym, refPrice: price }, fetchFn, useDefaultTimeout);
  const headers = { 'X-MBX-APIKEY': apiKey };

  // Set leverage best-effort
  const levQs = `symbol=${venueSym}&leverage=${Math.max(1, Math.min(20, Math.round(leverage || 5)))}&timestamp=${nowFn()}&recvWindow=5000`;
  await fetchFn(`${baseUrl}/fapi/v1/leverage?${levQs}&signature=${binanceSign(levQs, apiSecret)}`, buildFetchOpts('POST', headers, undefined, useDefaultTimeout)).catch(() => null);

  const qty = quantizeStep(sizeUsd / Math.max(1e-9, price), spec.qtyStep);
  const sideStr = side === 'LONG' ? 'BUY' : 'SELL';
  const exitSideStr = side === 'LONG' ? 'SELL' : 'BUY';

  const params = [
    `symbol=${venueSym}`,
    `side=${sideStr}`,
    `type=${orderType === 'LIMIT' ? 'LIMIT' : 'MARKET'}`,
    `quantity=${qty}`
  ];
  if (orderType === 'LIMIT') {
    params.push(`price=${quantizeStep(price, spec.tickSize, 'round')}`);
    params.push(`timeInForce=${isMaker ? 'GTX' : 'GTC'}`);
  }
  params.push(`timestamp=${nowFn()}`, 'recvWindow=5000');
  const qs = params.join('&');
  const res = await fetchFn(`${baseUrl}/fapi/v1/order?${qs}&signature=${binanceSign(qs, apiSecret)}`, buildFetchOpts('POST', headers, undefined, useDefaultTimeout));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, error: data?.msg ? `Binance: ${data.msg}` : `Binance HTTP ${res.status}` };
  }

  let slOrderId = null;
  let tpOrderId = null;
  if (Number.isFinite(slPrice) && slPrice > 0) {
    const slQs = `symbol=${venueSym}&side=${exitSideStr}&type=STOP_MARKET&stopPrice=${quantizeStep(slPrice, spec.tickSize, 'round')}&closePosition=true&workingType=MARK_PRICE&timestamp=${nowFn()}&recvWindow=5000`;
    const slRes = await fetchFn(`${baseUrl}/fapi/v1/order?${slQs}&signature=${binanceSign(slQs, apiSecret)}`, buildFetchOpts('POST', headers, undefined, useDefaultTimeout)).catch(() => null);
    if (slRes?.ok) {
      const sj = await slRes.json().catch(() => ({}));
      slOrderId = sj.orderId ? String(sj.orderId) : null;
    }
  }
  if (Number.isFinite(tpPrice) && tpPrice > 0) {
    const tpQs = `symbol=${venueSym}&side=${exitSideStr}&type=TAKE_PROFIT_MARKET&stopPrice=${quantizeStep(tpPrice, spec.tickSize, 'round')}&closePosition=true&workingType=MARK_PRICE&timestamp=${nowFn()}&recvWindow=5000`;
    const tpRes = await fetchFn(`${baseUrl}/fapi/v1/order?${tpQs}&signature=${binanceSign(tpQs, apiSecret)}`, buildFetchOpts('POST', headers, undefined, useDefaultTimeout)).catch(() => null);
    if (tpRes?.ok) {
      const tj = await tpRes.json().catch(() => ({}));
      tpOrderId = tj.orderId ? String(tj.orderId) : null;
    }
  }

  return {
    ok: true,
    venue: 'BINANCE',
    network: net,
    venueSymbol: venueSym,
    exchangeOrderId: String(data.orderId || data.clientOrderId || ''),
    slOrderId,
    tpOrderId,
    qty: Number(qty),
    fillPrice: parseFloat(data.avgPrice) || parseFloat(data.price) || price,
    status: data.status || 'SUBMITTED'
  };
}

async function binanceModifySl(p, fetchFn, nowFn, useDefaultTimeout) {
  const { apiKey, apiSecret, net, symbol, side, slPrice, refPrice } = p;
  const baseUrl = net === 'TESTNET' ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
  const venueSym = resolveVenueSymbol(symbol, 'BINANCE', p.venueSymbol);
  const spec = await getVenueInstrumentSpec({ venue: 'BINANCE', net, venueSymbol: venueSym, refPrice: refPrice || slPrice }, fetchFn, useDefaultTimeout);
  const headers = { 'X-MBX-APIKEY': apiKey };

  // Cancel old STOP_MARKET orders cleanly before setting tighter SL
  const openQs = `symbol=${venueSym}&timestamp=${nowFn()}&recvWindow=5000`;
  const openRes = await fetchFn(`${baseUrl}/fapi/v1/openOrders?${openQs}&signature=${binanceSign(openQs, apiSecret)}`, buildFetchOpts('GET', headers, undefined, useDefaultTimeout)).catch(() => null);
  if (openRes?.ok) {
    const list = await openRes.json().catch(() => []);
    for (const ord of (Array.isArray(list) ? list : [])) {
      if (ord.type === 'STOP_MARKET' || ord.type === 'STOP') {
        const delQs = `symbol=${venueSym}&orderId=${ord.orderId}&timestamp=${nowFn()}&recvWindow=5000`;
        await fetchFn(`${baseUrl}/fapi/v1/order?${delQs}&signature=${binanceSign(delQs, apiSecret)}`, buildFetchOpts('DELETE', headers, undefined, useDefaultTimeout)).catch(() => null);
      }
    }
  }

  const exitSide = side === 'LONG' ? 'SELL' : 'BUY';
  const slQs = `symbol=${venueSym}&side=${exitSide}&type=STOP_MARKET&stopPrice=${quantizeStep(slPrice, spec.tickSize, 'round')}&closePosition=true&workingType=MARK_PRICE&timestamp=${nowFn()}&recvWindow=5000`;
  const res = await fetchFn(`${baseUrl}/fapi/v1/order?${slQs}&signature=${binanceSign(slQs, apiSecret)}`, buildFetchOpts('POST', headers, undefined, useDefaultTimeout));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data?.msg ? `Binance SL: ${data.msg}` : `Binance SL HTTP ${res.status}` };
  return { ok: true, slOrderId: String(data.orderId || '') };
}

async function binanceCancelOrder(p, fetchFn, nowFn, useDefaultTimeout) {
  const { apiKey, apiSecret, net, symbol, exchangeOrderId } = p;
  const baseUrl = net === 'TESTNET' ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
  const venueSym = resolveVenueSymbol(symbol, 'BINANCE', p.venueSymbol);
  const qs = `symbol=${venueSym}&orderId=${encodeURIComponent(exchangeOrderId)}&timestamp=${nowFn()}&recvWindow=5000`;
  const res = await fetchFn(`${baseUrl}/fapi/v1/order?${qs}&signature=${binanceSign(qs, apiSecret)}`, buildFetchOpts('DELETE', { 'X-MBX-APIKEY': apiKey }, undefined, useDefaultTimeout));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data?.msg ? `Binance Cancel: ${data.msg}` : `Binance HTTP ${res.status}` };
  return { ok: true, exchangeOrderId: String(data.orderId || exchangeOrderId) };
}

async function binanceClosePosition(p, fetchFn, nowFn, useDefaultTimeout) {
  const { apiKey, apiSecret, net, symbol, side, sizeUsd, refPrice, qty: explicitQty } = p;
  const baseUrl = net === 'TESTNET' ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
  const venueSym = resolveVenueSymbol(symbol, 'BINANCE', p.venueSymbol);
  const spec = await getVenueInstrumentSpec({ venue: 'BINANCE', net, venueSymbol: venueSym, refPrice }, fetchFn, useDefaultTimeout);
  const headers = { 'X-MBX-APIKEY': apiKey };

  // Cancel open conditional SL/TP orders on this symbol
  const allOpenQs = `symbol=${venueSym}&timestamp=${nowFn()}&recvWindow=5000`;
  await fetchFn(`${baseUrl}/fapi/v1/allOpenOrders?${allOpenQs}&signature=${binanceSign(allOpenQs, apiSecret)}`, buildFetchOpts('DELETE', headers, undefined, useDefaultTimeout)).catch(() => null);

  const qty = explicitQty ? quantizeStep(explicitQty, spec.qtyStep) : quantizeStep(sizeUsd / Math.max(1e-9, refPrice), spec.qtyStep);
  const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
  const qs = `symbol=${venueSym}&side=${closeSide}&type=MARKET&quantity=${qty}&reduceOnly=true&timestamp=${nowFn()}&recvWindow=5000`;
  const res = await fetchFn(`${baseUrl}/fapi/v1/order?${qs}&signature=${binanceSign(qs, apiSecret)}`, buildFetchOpts('POST', headers, undefined, useDefaultTimeout));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data?.msg ? `Binance Close: ${data.msg}` : `Binance HTTP ${res.status}` };
  return { ok: true, exchangeOrderId: String(data.orderId || '') };
}

/* ==================== 2. BYBIT V5 LINEAR ==================== */
function bybitHeaders(apiKey, apiSecret, payloadStr, nowFn) {
  const ts = String(nowFn());
  const recv = '5000';
  const sign = createHmac('sha256', apiSecret).update(ts + apiKey + recv + payloadStr).digest('hex');
  return {
    'Content-Type': 'application/json',
    'X-BAPI-API-KEY': apiKey,
    'X-BAPI-TIMESTAMP': ts,
    'X-BAPI-RECV-WINDOW': recv,
    'X-BAPI-SIGN': sign
  };
}

async function bybitPlaceOrder(p, fetchFn, nowFn, useDefaultTimeout) {
  const { apiKey, apiSecret, net, symbol, side, orderType, sizeUsd, price, leverage, slPrice, tpPrice, isMaker } = p;
  if (!apiKey || !apiSecret) return { ok: false, error: 'Thiếu Bybit API Key / Secret.' };
  const baseUrl = net === 'TESTNET' ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
  const venueSym = resolveVenueSymbol(symbol, 'BYBIT', p.venueSymbol);
  const spec = await getVenueInstrumentSpec({ venue: 'BYBIT', net, venueSymbol: venueSym, refPrice: price }, fetchFn, useDefaultTimeout);

  const levStr = String(Math.max(1, Math.min(20, Math.round(leverage || 5))));
  const levBody = JSON.stringify({ category: 'linear', symbol: venueSym, buyLeverage: levStr, sellLeverage: levStr });
  await fetchFn(`${baseUrl}/v5/position/set-leverage`, buildFetchOpts('POST', bybitHeaders(apiKey, apiSecret, levBody, nowFn), levBody, useDefaultTimeout)).catch(() => null);

  const qty = quantizeStep(sizeUsd / Math.max(1e-9, price), spec.qtyStep);
  const bodyObj = {
    category: 'linear',
    symbol: venueSym,
    side: side === 'LONG' ? 'Buy' : 'Sell',
    orderType: orderType === 'LIMIT' ? 'Limit' : 'Market',
    qty,
    positionIdx: 0
  };
  if (orderType === 'LIMIT') {
    bodyObj.price = quantizeStep(price, spec.tickSize, 'round');
    bodyObj.timeInForce = isMaker ? 'PostOnly' : 'GTC';
  }
  if (Number.isFinite(slPrice) && slPrice > 0) {
    bodyObj.stopLoss = quantizeStep(slPrice, spec.tickSize, 'round');
    bodyObj.slTriggerBy = 'MarkPrice';
  }
  if (Number.isFinite(tpPrice) && tpPrice > 0) {
    bodyObj.takeProfit = quantizeStep(tpPrice, spec.tickSize, 'round');
    bodyObj.tpTriggerBy = 'MarkPrice';
  }

  const bodyStr = JSON.stringify(bodyObj);
  const res = await fetchFn(`${baseUrl}/v5/order/create`, buildFetchOpts('POST', bybitHeaders(apiKey, apiSecret, bodyStr, nowFn), bodyStr, useDefaultTimeout));
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.retCode !== 0) {
    return { ok: false, error: data?.retMsg ? `Bybit: ${data.retMsg}` : `Bybit HTTP ${res.status}` };
  }

  return {
    ok: true,
    venue: 'BYBIT',
    network: net,
    venueSymbol: venueSym,
    exchangeOrderId: String(data?.result?.orderId || ''),
    qty: Number(qty),
    fillPrice: price,
    status: 'SUBMITTED'
  };
}

async function bybitModifySl(p, fetchFn, nowFn, useDefaultTimeout) {
  const { apiKey, apiSecret, net, symbol, slPrice, refPrice } = p;
  const baseUrl = net === 'TESTNET' ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
  const venueSym = resolveVenueSymbol(symbol, 'BYBIT', p.venueSymbol);
  const spec = await getVenueInstrumentSpec({ venue: 'BYBIT', net, venueSymbol: venueSym, refPrice: refPrice || slPrice }, fetchFn, useDefaultTimeout);
  const bodyStr = JSON.stringify({
    category: 'linear',
    symbol: venueSym,
    stopLoss: quantizeStep(slPrice, spec.tickSize, 'round'),
    slTriggerBy: 'MarkPrice',
    positionIdx: 0
  });
  const res = await fetchFn(`${baseUrl}/v5/position/trading-stop`, buildFetchOpts('POST', bybitHeaders(apiKey, apiSecret, bodyStr, nowFn), bodyStr, useDefaultTimeout));
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.retCode !== 0) return { ok: false, error: data?.retMsg ? `Bybit SL: ${data.retMsg}` : `Bybit HTTP ${res.status}` };
  return { ok: true };
}

async function bybitCancelOrder(p, fetchFn, nowFn, useDefaultTimeout) {
  const { apiKey, apiSecret, net, symbol, exchangeOrderId } = p;
  const baseUrl = net === 'TESTNET' ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
  const venueSym = resolveVenueSymbol(symbol, 'BYBIT', p.venueSymbol);
  const bodyStr = JSON.stringify({ category: 'linear', symbol: venueSym, orderId: String(exchangeOrderId) });
  const res = await fetchFn(`${baseUrl}/v5/order/cancel`, buildFetchOpts('POST', bybitHeaders(apiKey, apiSecret, bodyStr, nowFn), bodyStr, useDefaultTimeout));
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.retCode !== 0) return { ok: false, error: data?.retMsg ? `Bybit Cancel: ${data.retMsg}` : `Bybit HTTP ${res.status}` };
  return { ok: true, exchangeOrderId: String(exchangeOrderId) };
}

async function bybitClosePosition(p, fetchFn, nowFn, useDefaultTimeout) {
  const { apiKey, apiSecret, net, symbol, side, sizeUsd, refPrice, qty: explicitQty } = p;
  const baseUrl = net === 'TESTNET' ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
  const venueSym = resolveVenueSymbol(symbol, 'BYBIT', p.venueSymbol);
  const spec = await getVenueInstrumentSpec({ venue: 'BYBIT', net, venueSymbol: venueSym, refPrice }, fetchFn, useDefaultTimeout);
  const qty = explicitQty ? quantizeStep(explicitQty, spec.qtyStep) : quantizeStep(sizeUsd / Math.max(1e-9, refPrice), spec.qtyStep);
  const bodyStr = JSON.stringify({
    category: 'linear',
    symbol: venueSym,
    side: side === 'LONG' ? 'Sell' : 'Buy',
    orderType: 'Market',
    qty,
    reduceOnly: true,
    positionIdx: 0
  });
  const res = await fetchFn(`${baseUrl}/v5/order/create`, buildFetchOpts('POST', bybitHeaders(apiKey, apiSecret, bodyStr, nowFn), bodyStr, useDefaultTimeout));
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.retCode !== 0) return { ok: false, error: data?.retMsg ? `Bybit Close: ${data.retMsg}` : `Bybit HTTP ${res.status}` };
  return { ok: true, exchangeOrderId: String(data?.result?.orderId || '') };
}

/* ==================== 3. OKX V5 SWAP ==================== */
function okxHeaders(apiKey, apiSecret, passphrase, net, method, reqPath, bodyStr, nowFn) {
  const tsIso = new Date(nowFn()).toISOString();
  const sign = createHmac('sha256', apiSecret).update(`${tsIso}${method}${reqPath}${bodyStr}`).digest('base64');
  const h = {
    'Content-Type': 'application/json',
    'OK-ACCESS-KEY': apiKey,
    'OK-ACCESS-SIGN': sign,
    'OK-ACCESS-TIMESTAMP': tsIso,
    'OK-ACCESS-PASSPHRASE': passphrase
  };
  if (net === 'TESTNET') h['x-simulated-trading'] = '1';
  return h;
}

async function okxPlaceOrder(p, fetchFn, nowFn, useDefaultTimeout) {
  const { apiKey, apiSecret, passphrase, net, symbol, side, orderType, sizeUsd, price, leverage, slPrice, tpPrice, isMaker } = p;
  if (!apiKey || !apiSecret || !passphrase) return { ok: false, error: 'OKX yêu cầu API Key, Secret & Passphrase.' };
  const instId = resolveVenueSymbol(symbol, 'OKX', p.venueSymbol);
  const spec = await getVenueInstrumentSpec({ venue: 'OKX', net, venueSymbol: instId, refPrice: price }, fetchFn, useDefaultTimeout);

  const levPath = '/api/v5/account/set-leverage';
  const levBody = JSON.stringify({ instId, lever: String(Math.max(1, Math.min(20, Math.round(leverage || 5)))), mgnMode: 'cross' });
  await fetchFn(`https://www.okx.com${levPath}`, buildFetchOpts('POST', okxHeaders(apiKey, apiSecret, passphrase, net, 'POST', levPath, levBody, nowFn), levBody, useDefaultTimeout)).catch(() => null);

  const contracts = quantizeStep(sizeUsd / Math.max(1e-9, price * (spec.ctVal || 1)), spec.qtyStep);
  const ordPath = '/api/v5/trade/order';
  const bodyObj = {
    instId,
    tdMode: 'cross',
    side: side === 'LONG' ? 'buy' : 'sell',
    ordType: orderType === 'LIMIT' ? (isMaker ? 'post_only' : 'limit') : 'market',
    sz: contracts
  };
  if (orderType === 'LIMIT') {
    bodyObj.px = quantizeStep(price, spec.tickSize, 'round');
  }
  const algoAttach = {};
  if (Number.isFinite(slPrice) && slPrice > 0) {
    algoAttach.slTriggerPx = quantizeStep(slPrice, spec.tickSize, 'round');
    algoAttach.slOrdPx = '-1';
    algoAttach.slTriggerPxType = 'mark';
  }
  if (Number.isFinite(tpPrice) && tpPrice > 0) {
    algoAttach.tpTriggerPx = quantizeStep(tpPrice, spec.tickSize, 'round');
    algoAttach.tpOrdPx = '-1';
    algoAttach.tpTriggerPxType = 'mark';
  }
  if (Object.keys(algoAttach).length > 0) {
    bodyObj.attachAlgoOrds = [algoAttach];
  }

  const bodyStr = JSON.stringify(bodyObj);
  const res = await fetchFn(`https://www.okx.com${ordPath}`, buildFetchOpts('POST', okxHeaders(apiKey, apiSecret, passphrase, net, 'POST', ordPath, bodyStr, nowFn), bodyStr, useDefaultTimeout));
  const data = await res.json().catch(() => ({}));
  const row = data?.data?.[0];
  if (!res.ok || String(data?.code) !== '0' || (row && String(row.sCode) !== '0')) {
    const errMsg = row?.sMsg || data?.msg || `OKX HTTP ${res.status}`;
    return { ok: false, error: `OKX: ${errMsg}` };
  }

  return {
    ok: true,
    venue: 'OKX',
    network: net,
    venueSymbol: instId,
    exchangeOrderId: String(row?.ordId || ''),
    qty: Number(contracts),
    fillPrice: price,
    status: 'SUBMITTED'
  };
}

async function okxModifySl(p, fetchFn, nowFn, useDefaultTimeout) {
  const { apiKey, apiSecret, passphrase, net, symbol, side, slPrice, refPrice } = p;
  const instId = resolveVenueSymbol(symbol, 'OKX', p.venueSymbol);
  const spec = await getVenueInstrumentSpec({ venue: 'OKX', net, venueSymbol: instId, refPrice: refPrice || slPrice }, fetchFn, useDefaultTimeout);
  const algoPath = '/api/v5/trade/order-algo';
  const bodyStr = JSON.stringify({
    instId,
    tdMode: 'cross',
    side: side === 'LONG' ? 'sell' : 'buy',
    ordType: 'conditional',
    closeFraction: '1',
    reduceOnly: true,
    slTriggerPx: quantizeStep(slPrice, spec.tickSize, 'round'),
    slOrdPx: '-1',
    slTriggerPxType: 'mark'
  });
  const res = await fetchFn(`https://www.okx.com${algoPath}`, buildFetchOpts('POST', okxHeaders(apiKey, apiSecret, passphrase, net, 'POST', algoPath, bodyStr, nowFn), bodyStr, useDefaultTimeout));
  const data = await res.json().catch(() => ({}));
  if (!res.ok || String(data?.code) !== '0') return { ok: false, error: data?.msg ? `OKX SL: ${data.msg}` : `OKX HTTP ${res.status}` };
  return { ok: true, slOrderId: String(data?.data?.[0]?.algoId || '') };
}

async function okxCancelOrder(p, fetchFn, nowFn, useDefaultTimeout) {
  const { apiKey, apiSecret, passphrase, net, symbol, exchangeOrderId } = p;
  const instId = resolveVenueSymbol(symbol, 'OKX', p.venueSymbol);
  const reqPath = '/api/v5/trade/cancel-order';
  const bodyStr = JSON.stringify({ instId, ordId: String(exchangeOrderId) });
  const res = await fetchFn(`https://www.okx.com${reqPath}`, buildFetchOpts('POST', okxHeaders(apiKey, apiSecret, passphrase, net, 'POST', reqPath, bodyStr, nowFn), bodyStr, useDefaultTimeout));
  const data = await res.json().catch(() => ({}));
  if (!res.ok || String(data?.code) !== '0') return { ok: false, error: data?.msg ? `OKX Cancel: ${data.msg}` : `OKX HTTP ${res.status}` };
  return { ok: true, exchangeOrderId: String(exchangeOrderId) };
}

async function okxClosePosition(p, fetchFn, nowFn, useDefaultTimeout) {
  const { apiKey, apiSecret, passphrase, net, symbol } = p;
  const instId = resolveVenueSymbol(symbol, 'OKX', p.venueSymbol);
  const reqPath = '/api/v5/trade/close-position';
  const bodyStr = JSON.stringify({ instId, mgnMode: 'cross', autoCxl: true });
  const res = await fetchFn(`https://www.okx.com${reqPath}`, buildFetchOpts('POST', okxHeaders(apiKey, apiSecret, passphrase, net, 'POST', reqPath, bodyStr, nowFn), bodyStr, useDefaultTimeout));
  const data = await res.json().catch(() => ({}));
  if (!res.ok || String(data?.code) !== '0') return { ok: false, error: data?.msg ? `OKX Close: ${data.msg}` : `OKX HTTP ${res.status}` };
  return { ok: true };
}

/* ==================== 4. DERIBIT V2 ==================== */
async function deribitAuth(clientId, clientSecret, net, fetchFn, useDefaultTimeout) {
  if (!clientId || !clientSecret) return { ok: false, error: 'Thiếu Deribit Client ID / Secret.' };
  const baseUrl = net === 'TESTNET' ? 'https://test.deribit.com' : 'https://www.deribit.com';
  const url = `${baseUrl}/api/v2/public/auth?client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&grant_type=client_credentials`;
  const r = await fetchFn(url, buildFetchOpts('GET', {}, undefined, useDefaultTimeout));
  const j = await r.json().catch(() => ({}));
  const token = j?.result?.access_token;
  if (!r.ok || !token) return { ok: false, error: j?.error?.message || `Deribit Auth HTTP ${r.status}` };
  return { ok: true, baseUrl, token };
}

async function deribitPlaceOrder(p, fetchFn, useDefaultTimeout) {
  const { apiKey, apiSecret, net, symbol, side, orderType, sizeUsd, price, isMaker } = p;
  const auth = await deribitAuth(apiKey, apiSecret, net, fetchFn, useDefaultTimeout);
  if (!auth.ok) return auth;

  const inst = resolveVenueSymbol(symbol, 'DERIBIT', p.venueSymbol);
  const isInverse = inst.endsWith('-PERPETUAL');
  const amount = isInverse
    ? Math.max(10, Math.round(sizeUsd / 10) * 10)
    : Number(quantizeStep(sizeUsd / Math.max(1e-9, price), 0.1));

  const actionPath = side === 'LONG' ? 'buy' : 'sell';
  const qp = new URLSearchParams({
    instrument_name: inst,
    amount: String(amount),
    type: orderType === 'LIMIT' ? 'limit' : 'market',
    label: 'quantum_core'
  });
  if (orderType === 'LIMIT') {
    qp.set('price', quantizeStep(price, price >= 1000 ? 0.5 : 0.01, 'round'));
    if (isMaker) qp.set('post_only', 'true');
  }

  const res = await fetchFn(`${auth.baseUrl}/api/v2/private/${actionPath}?${qp.toString()}`, buildFetchOpts('GET', { Authorization: `Bearer ${auth.token}` }, undefined, useDefaultTimeout));
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    return { ok: false, error: data?.error?.message ? `Deribit: ${data.error.message}` : `Deribit HTTP ${res.status}` };
  }
  const ord = data?.result?.order || {};
  return {
    ok: true,
    venue: 'DERIBIT',
    network: net,
    venueSymbol: inst,
    exchangeOrderId: String(ord.order_id || ''),
    qty: amount,
    fillPrice: parseFloat(ord.average_price) || parseFloat(ord.price) || price,
    status: ord.order_state || 'SUBMITTED'
  };
}

async function deribitModifySl(p, fetchFn, useDefaultTimeout) {
  const { apiKey, apiSecret, net, symbol, side, slPrice, sizeUsd, refPrice } = p;
  const auth = await deribitAuth(apiKey, apiSecret, net, fetchFn, useDefaultTimeout);
  if (!auth.ok) return auth;
  const inst = resolveVenueSymbol(symbol, 'DERIBIT', p.venueSymbol);
  await fetchFn(`${auth.baseUrl}/api/v2/private/cancel_all_by_instrument?instrument_name=${encodeURIComponent(inst)}&type=stop`, buildFetchOpts('GET', { Authorization: `Bearer ${auth.token}` }, undefined, useDefaultTimeout)).catch(() => null);
  const actionPath = side === 'LONG' ? 'sell' : 'buy';
  const amount = inst.endsWith('-PERPETUAL') ? Math.max(10, Math.round(sizeUsd / 10) * 10) : Number(quantizeStep(sizeUsd / Math.max(1e-9, refPrice || slPrice), 0.1));
  const qp = new URLSearchParams({
    instrument_name: inst,
    amount: String(amount),
    type: 'stop_market',
    trigger: 'mark_price',
    trigger_price: quantizeStep(slPrice, slPrice >= 1000 ? 0.5 : 0.01, 'round'),
    reduce_only: 'true'
  });
  const res = await fetchFn(`${auth.baseUrl}/api/v2/private/${actionPath}?${qp.toString()}`, buildFetchOpts('GET', { Authorization: `Bearer ${auth.token}` }, undefined, useDefaultTimeout));
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) return { ok: false, error: data?.error?.message || `Deribit HTTP ${res.status}` };
  return { ok: true, slOrderId: String(data?.result?.order?.order_id || '') };
}

async function deribitCancelOrder(p, fetchFn, useDefaultTimeout) {
  const { apiKey, apiSecret, net, exchangeOrderId } = p;
  const auth = await deribitAuth(apiKey, apiSecret, net, fetchFn, useDefaultTimeout);
  if (!auth.ok) return auth;
  const res = await fetchFn(`${auth.baseUrl}/api/v2/private/cancel?order_id=${encodeURIComponent(exchangeOrderId)}`, buildFetchOpts('GET', { Authorization: `Bearer ${auth.token}` }, undefined, useDefaultTimeout));
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) return { ok: false, error: data?.error?.message || `Deribit HTTP ${res.status}` };
  return { ok: true, exchangeOrderId: String(exchangeOrderId) };
}

async function deribitClosePosition(p, fetchFn, useDefaultTimeout) {
  const { apiKey, apiSecret, net, symbol } = p;
  const auth = await deribitAuth(apiKey, apiSecret, net, fetchFn, useDefaultTimeout);
  if (!auth.ok) return auth;
  const inst = resolveVenueSymbol(symbol, 'DERIBIT', p.venueSymbol);
  const res = await fetchFn(`${auth.baseUrl}/api/v2/private/close_position?instrument_name=${encodeURIComponent(inst)}&type=market`, buildFetchOpts('GET', { Authorization: `Bearer ${auth.token}` }, undefined, useDefaultTimeout));
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) return { ok: false, error: data?.error?.message || `Deribit HTTP ${res.status}` };
  return { ok: true };
}

/* ==================== 5. HYPERLIQUID DEX (EIP-712) ==================== */
async function hlPostAction({ action, nonce, net, vaultAddress, privateKey }, fetchFn, useDefaultTimeout) {
  const isMainnet = net === 'MAINNET';
  const url = isMainnet ? 'https://api.hyperliquid.xyz/exchange' : 'https://api.hyperliquid-testnet.xyz/exchange';
  const signature = signHyperliquidL1Action({
    action,
    nonce,
    vaultAddress: vaultAddress || null,
    isMainnet,
    privateKey
  });
  const payload = { action, nonce, signature };
  if (vaultAddress && /^0x[a-fA-F0-9]{40}$/.test(String(vaultAddress).trim())) {
    payload.vaultAddress = String(vaultAddress).trim().toLowerCase();
  }
  const res = await fetchFn(url, buildFetchOpts('POST', { 'Content-Type': 'application/json' }, payload, useDefaultTimeout));
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok && json?.status === 'ok', status: res.status, json };
}

async function hyperliquidPlaceOrder(p, fetchFn, nowFn, useDefaultTimeout) {
  const { agentKey, walletAddress, vaultAddress, net, symbol, side, orderType, sizeUsd, price, leverage, slPrice, tpPrice, isMaker } = p;
  const privKey = agentKey || p.privateKey;
  if (!privKey) return { ok: false, error: 'Thiếu Hyperliquid Agent Private Key để ký lệnh.' };

  const coin = resolveVenueSymbol(symbol, 'HYPERLIQUID', p.venueSymbol);
  const spec = await getVenueInstrumentSpec({ venue: 'HYPERLIQUID', net, venueSymbol: coin, refPrice: price }, fetchFn, useDefaultTimeout);
  const isBuy = side === 'LONG';
  const szDecimals = spec.szDecimals ?? 2;

  await hlPostAction({
    action: {
      type: 'updateLeverage',
      asset: spec.assetId,
      isCross: true,
      leverage: Math.max(1, Math.min(20, Math.round(leverage || 5)))
    },
    nonce: nowFn(),
    net,
    vaultAddress,
    privateKey: privKey
  }, fetchFn, useDefaultTimeout).catch(() => null);

  const qtyStr = formatHlSize(sizeUsd / Math.max(1e-9, price), szDecimals);
  const limitSlipPx = orderType === 'MARKET'
    ? price * (isBuy ? 1.003 : 0.997)
    : price;
  const pxStr = formatHlPrice(limitSlipPx, szDecimals);
  const tif = orderType === 'MARKET' ? 'Ioc' : (isMaker ? 'Alo' : 'Gtc');

  const orders = [{
    a: spec.assetId,
    b: isBuy,
    p: pxStr,
    s: qtyStr,
    r: false,
    t: { limit: { tif } }
  }];

  let grouping = 'na';
  if ((Number.isFinite(tpPrice) && tpPrice > 0) || (Number.isFinite(slPrice) && slPrice > 0)) {
    grouping = 'normalTpsl';
    if (Number.isFinite(tpPrice) && tpPrice > 0) {
      orders.push({
        a: spec.assetId,
        b: !isBuy,
        p: formatHlPrice(tpPrice, szDecimals),
        s: qtyStr,
        r: true,
        t: { trigger: { isMarket: true, triggerPx: formatHlPrice(tpPrice, szDecimals), tpsl: 'tp' } }
      });
    }
    if (Number.isFinite(slPrice) && slPrice > 0) {
      orders.push({
        a: spec.assetId,
        b: !isBuy,
        p: formatHlPrice(slPrice, szDecimals),
        s: qtyStr,
        r: true,
        t: { trigger: { isMarket: true, triggerPx: formatHlPrice(slPrice, szDecimals), tpsl: 'sl' } }
      });
    }
  }

  const execRes = await hlPostAction({
    action: { type: 'order', orders, grouping },
    nonce: nowFn() + 1,
    net,
    vaultAddress,
    privateKey: privKey
  }, fetchFn, useDefaultTimeout);

  const statuses = execRes.json?.response?.data?.statuses || [];
  const firstStatus = statuses[0];
  if (!execRes.ok || firstStatus?.error) {
    const err = firstStatus?.error || execRes.json?.response || `Hyperliquid HTTP ${execRes.status}`;
    return { ok: false, error: `Hyperliquid: ${typeof err === 'string' ? err : JSON.stringify(err)}` };
  }

  const oid = firstStatus?.filled?.oid || firstStatus?.resting?.oid || '';
  return {
    ok: true,
    venue: 'HYPERLIQUID',
    network: net,
    venueSymbol: coin,
    walletAddress,
    exchangeOrderId: String(oid),
    qty: Number(qtyStr),
    fillPrice: parseFloat(firstStatus?.filled?.avgPx) || price,
    status: firstStatus?.filled ? 'FILLED' : 'RESTING'
  };
}

async function hyperliquidModifySl(p, fetchFn, nowFn, useDefaultTimeout) {
  const { agentKey, net, symbol, side, slPrice, sizeUsd, refPrice, vaultAddress } = p;
  const privKey = agentKey || p.privateKey;
  if (!privKey) return { ok: false, error: 'Thiếu Hyperliquid Agent Private Key.' };
  const coin = resolveVenueSymbol(symbol, 'HYPERLIQUID', p.venueSymbol);
  const spec = await getVenueInstrumentSpec({ venue: 'HYPERLIQUID', net, venueSymbol: coin, refPrice: refPrice || slPrice }, fetchFn, useDefaultTimeout);
  const szDecimals = spec.szDecimals ?? 2;
  const qtyStr = formatHlSize(sizeUsd / Math.max(1e-9, refPrice || slPrice), szDecimals);
  const slStr = formatHlPrice(slPrice, szDecimals);
  const execRes = await hlPostAction({
    action: {
      type: 'order',
      orders: [{
        a: spec.assetId,
        b: side !== 'LONG',
        p: slStr,
        s: qtyStr,
        r: true,
        t: { trigger: { isMarket: true, triggerPx: slStr, tpsl: 'sl' } }
      }],
      grouping: 'positionTpsl'
    },
    nonce: nowFn(),
    net,
    vaultAddress,
    privateKey: privKey
  }, fetchFn, useDefaultTimeout);
  if (!execRes.ok) return { ok: false, error: `Hyperliquid SL: ${JSON.stringify(execRes.json?.response || execRes.status)}` };
  return { ok: true };
}

async function hyperliquidCancelOrder(p, fetchFn, nowFn, useDefaultTimeout) {
  const { agentKey, net, symbol, exchangeOrderId, vaultAddress } = p;
  const privKey = agentKey || p.privateKey;
  const coin = resolveVenueSymbol(symbol, 'HYPERLIQUID', p.venueSymbol);
  const spec = await getVenueInstrumentSpec({ venue: 'HYPERLIQUID', net, venueSymbol: coin, refPrice: 100 }, fetchFn, useDefaultTimeout);
  const oidNum = Number(exchangeOrderId);
  if (!Number.isFinite(oidNum)) return { ok: false, error: 'Hyperliquid order ID không hợp lệ.' };
  const res = await hlPostAction({
    action: { type: 'cancel', cancels: [{ a: spec.assetId, o: oidNum }] },
    nonce: nowFn(),
    net,
    vaultAddress,
    privateKey: privKey
  }, fetchFn, useDefaultTimeout);
  if (!res.ok) return { ok: false, error: `Hyperliquid Cancel: ${JSON.stringify(res.json?.response || res.status)}` };
  return { ok: true, exchangeOrderId: String(exchangeOrderId) };
}

async function hyperliquidClosePosition(p, fetchFn, nowFn, useDefaultTimeout) {
  const { agentKey, net, symbol, side, sizeUsd, refPrice, vaultAddress } = p;
  const privKey = agentKey || p.privateKey;
  const coin = resolveVenueSymbol(symbol, 'HYPERLIQUID', p.venueSymbol);
  const spec = await getVenueInstrumentSpec({ venue: 'HYPERLIQUID', net, venueSymbol: coin, refPrice }, fetchFn, useDefaultTimeout);
  const szDecimals = spec.szDecimals ?? 2;
  const isCloseBuy = side !== 'LONG';
  const qtyStr = formatHlSize(sizeUsd / Math.max(1e-9, refPrice), szDecimals);
  const pxStr = formatHlPrice(refPrice * (isCloseBuy ? 1.004 : 0.996), szDecimals);

  const res = await hlPostAction({
    action: {
      type: 'order',
      orders: [{
        a: spec.assetId,
        b: isCloseBuy,
        p: pxStr,
        s: qtyStr,
        r: true,
        t: { limit: { tif: 'Ioc' } }
      }],
      grouping: 'na'
    },
    nonce: nowFn(),
    net,
    vaultAddress,
    privateKey: privKey
  }, fetchFn, useDefaultTimeout);
  if (!res.ok) return { ok: false, error: `Hyperliquid Close: ${JSON.stringify(res.json?.response || res.status)}` };
  return { ok: true };
}

/* ==================== POSITION FETCH (ALL 5 VENUES) ==================== */
export async function fetchExchangePositions(params = {}, deps = {}) {
  const fetchFn = deps.fetchFn || globalThis.fetch;
  const nowFn = deps.nowFn || Date.now;
  const useDefaultTimeout = !deps.fetchFn;
  const venue = String(params.venue || '').toUpperCase();
  const net = String(params.network || 'TESTNET').toUpperCase() === 'MAINNET' ? 'MAINNET' : 'TESTNET';
  if (!SUPPORTED_VENUES.has(venue)) return { ok: false, error: `Sàn không hỗ trợ: ${venue}` };

  try {
    if (venue === 'HYPERLIQUID') {
      const targetAddr = String(params.vaultAddress || params.walletAddress || '').trim();
      const url = net === 'MAINNET' ? 'https://api.hyperliquid.xyz/info' : 'https://api.hyperliquid-testnet.xyz/info';
      const r = await fetchFn(url, buildFetchOpts('POST', { 'Content-Type': 'application/json' }, { type: 'clearinghouseState', user: targetAddr }, useDefaultTimeout));
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, error: `Hyperliquid HTTP ${r.status}` };
      const positions = (j?.assetPositions || [])
        .map((ap) => ap.position)
        .filter((pos) => Math.abs(parseFloat(pos?.szi) || 0) > 0)
        .map((pos) => {
          const szi = parseFloat(pos.szi);
          return {
            symbol: `${String(pos.coin).toUpperCase()}-PERP`,
            venue: 'HYPERLIQUID',
            side: szi > 0 ? 'LONG' : 'SHORT',
            qty: Math.abs(szi),
            sizeUsd: Math.abs(parseFloat(pos.positionValue) || 0),
            entryPrice: parseFloat(pos.entryPx) || 0,
            unrealizedPnl: parseFloat(pos.unrealizedPnl) || 0,
            leverage: Number(pos.leverage?.value) || 5
          };
        });
      return { ok: true, venue, network: net, positions };
    }
    if (venue === 'BINANCE') {
      const base = net === 'TESTNET' ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
      const qs = `timestamp=${nowFn()}&recvWindow=5000`;
      const r = await fetchFn(`${base}/fapi/v2/positionRisk?${qs}&signature=${binanceSign(qs, params.apiSecret)}`, buildFetchOpts('GET', { 'X-MBX-APIKEY': params.apiKey }, undefined, useDefaultTimeout));
      const rows = await r.json().catch(() => ([]));
      if (!r.ok) return { ok: false, error: rows?.msg || `Binance HTTP ${r.status}` };
      const positions = (Array.isArray(rows) ? rows : [])
        .filter((x) => Math.abs(parseFloat(x.positionAmt) || 0) > 0)
        .map((x) => {
          const amt = parseFloat(x.positionAmt);
          const ep = parseFloat(x.entryPrice) || 0;
          return {
            symbol: `${String(x.symbol).replace(/USDT$/, '')}-PERP`,
            venue: 'BINANCE',
            side: amt > 0 ? 'LONG' : 'SHORT',
            qty: Math.abs(amt),
            sizeUsd: Math.abs(amt * ep),
            entryPrice: ep,
            unrealizedPnl: parseFloat(x.unRealizedProfit) || 0,
            leverage: Number(x.leverage) || 5
          };
        });
      return { ok: true, venue, network: net, positions };
    }
    if (venue === 'BYBIT') {
      const base = net === 'TESTNET' ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
      const qs = 'category=linear&settleCoin=USDT';
      const r = await fetchFn(`${base}/v5/position/list?${qs}`, buildFetchOpts('GET', bybitHeaders(params.apiKey, params.apiSecret, qs, nowFn), undefined, useDefaultTimeout));
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.retCode !== 0) return { ok: false, error: j?.retMsg || `Bybit HTTP ${r.status}` };
      const positions = (j?.result?.list || [])
        .filter((x) => Math.abs(parseFloat(x.size) || 0) > 0)
        .map((x) => ({
          symbol: `${String(x.symbol).replace(/USDT$/, '')}-PERP`,
          venue: 'BYBIT',
          side: x.side === 'Buy' ? 'LONG' : 'SHORT',
          qty: Math.abs(parseFloat(x.size) || 0),
          sizeUsd: Math.abs(parseFloat(x.positionValue) || 0),
          entryPrice: parseFloat(x.avgPrice) || 0,
          unrealizedPnl: parseFloat(x.unrealisedPnl) || 0,
          leverage: Number(x.leverage) || 5
        }));
      return { ok: true, venue, network: net, positions };
    }
    if (venue === 'OKX') {
      const reqPath = '/api/v5/account/positions?instType=SWAP';
      const r = await fetchFn(`https://www.okx.com${reqPath}`, buildFetchOpts('GET', okxHeaders(params.apiKey, params.apiSecret, params.passphrase, net, 'GET', reqPath, '', nowFn), undefined, useDefaultTimeout));
      const j = await r.json().catch(() => ({}));
      if (!r.ok || String(j?.code) !== '0') return { ok: false, error: j?.msg || `OKX HTTP ${r.status}` };
      const positions = (j?.data || [])
        .filter((x) => Math.abs(parseFloat(x.pos) || 0) > 0)
        .map((x) => {
          const posQty = parseFloat(x.pos);
          return {
            symbol: `${String(x.instId).replace(/-USDT-SWAP$/, '')}-PERP`,
            venue: 'OKX',
            side: posQty > 0 ? 'LONG' : 'SHORT',
            qty: Math.abs(posQty),
            sizeUsd: Math.abs(parseFloat(x.notionalUsd) || 0),
            entryPrice: parseFloat(x.avgPx) || 0,
            unrealizedPnl: parseFloat(x.upl) || 0,
            leverage: Number(x.lever) || 5
          };
        });
      return { ok: true, venue, network: net, positions };
    }
    if (venue === 'DERIBIT') {
      const auth = await deribitAuth(params.apiKey, params.apiSecret, net, fetchFn, useDefaultTimeout);
      if (!auth.ok) return auth;
      const r = await fetchFn(`${auth.baseUrl}/api/v2/private/get_positions?kind=future`, buildFetchOpts('GET', { Authorization: `Bearer ${auth.token}` }, undefined, useDefaultTimeout));
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.error) return { ok: false, error: j?.error?.message || `Deribit HTTP ${r.status}` };
      const positions = (j?.result || [])
        .filter((x) => Math.abs(parseFloat(x.size) || 0) > 0)
        .map((x) => ({
          symbol: `${String(x.instrument_name).split(/[-_]/)[0].toUpperCase()}-PERP`,
          venue: 'DERIBIT',
          side: x.direction === 'buy' ? 'LONG' : 'SHORT',
          qty: Math.abs(parseFloat(x.size) || 0),
          sizeUsd: Math.abs(parseFloat(x.size_currency) || parseFloat(x.size) || 0),
          entryPrice: parseFloat(x.average_price) || 0,
          unrealizedPnl: parseFloat(x.floating_profit_loss_usd ?? x.floating_profit_loss) || 0,
          leverage: Number(x.leverage) || 5
        }));
      return { ok: true, venue, network: net, positions };
    }
  } catch (err) {
    return { ok: false, error: `Lỗi đọc vị thế ${venue}: ${err?.message || 'Network error'}` };
  }
  return { ok: false, error: 'Sàn không hợp lệ.' };
}

/* ==================== DISPATCHERS ==================== */
export async function placeExchangeOrder(params = {}, deps = {}) {
  const fetchFn = deps.fetchFn || globalThis.fetch;
  const nowFn = deps.nowFn || Date.now;
  const useDefaultTimeout = !deps.fetchFn;
  if (typeof fetchFn !== 'function') return { ok: false, error: 'Thiếu fetch runtime.' };

  const venue = String(params.venue || '').toUpperCase();
  const net = String(params.network || 'TESTNET').toUpperCase() === 'MAINNET' ? 'MAINNET' : 'TESTNET';
  if (!SUPPORTED_VENUES.has(venue)) return { ok: false, error: `Sàn không hỗ trợ đặt lệnh: ${venue}` };

  const sizeUsd = Number(params.sizeUsd);
  const price = Number(params.price);
  const maxLiveNotionalUsd = Number(params.maxLiveNotionalUsd) || 50000;
  if (!Number.isFinite(sizeUsd) || sizeUsd < 5 || sizeUsd > maxLiveNotionalUsd) {
    return { ok: false, error: `Size lệnh thật $${sizeUsd} vượt trần an toàn ($5 - $${maxLiveNotionalUsd}).` };
  }
  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, error: 'Giá tham chiếu đặt lệnh không hợp lệ.' };
  }
  const normalized = { ...params, venue, net, sizeUsd, price };

  try {
    if (venue === 'BINANCE') return await binancePlaceOrder(normalized, fetchFn, nowFn, useDefaultTimeout);
    if (venue === 'BYBIT') return await bybitPlaceOrder(normalized, fetchFn, nowFn, useDefaultTimeout);
    if (venue === 'OKX') return await okxPlaceOrder(normalized, fetchFn, nowFn, useDefaultTimeout);
    if (venue === 'DERIBIT') return await deribitPlaceOrder(normalized, fetchFn, useDefaultTimeout);
    if (venue === 'HYPERLIQUID') return await hyperliquidPlaceOrder(normalized, fetchFn, nowFn, useDefaultTimeout);
    return { ok: false, error: 'Sàn không hợp lệ.' };
  } catch (err) {
    return { ok: false, error: `Lỗi đẩy lệnh ${venue}: ${err?.name === 'TimeoutError' ? 'Timeout 10s' : (err?.message || 'Unknown error')}` };
  }
}

export async function modifyExchangeStopLoss(params = {}, deps = {}) {
  const fetchFn = deps.fetchFn || globalThis.fetch;
  const nowFn = deps.nowFn || Date.now;
  const useDefaultTimeout = !deps.fetchFn;
  const venue = String(params.venue || '').toUpperCase();
  const net = String(params.network || 'TESTNET').toUpperCase() === 'MAINNET' ? 'MAINNET' : 'TESTNET';
  if (!SUPPORTED_VENUES.has(venue)) return { ok: false, error: `Sàn không hỗ trợ: ${venue}` };
  const normalized = { ...params, venue, net };
  try {
    if (venue === 'BINANCE') return await binanceModifySl(normalized, fetchFn, nowFn, useDefaultTimeout);
    if (venue === 'BYBIT') return await bybitModifySl(normalized, fetchFn, nowFn, useDefaultTimeout);
    if (venue === 'OKX') return await okxModifySl(normalized, fetchFn, nowFn, useDefaultTimeout);
    if (venue === 'DERIBIT') return await deribitModifySl(normalized, fetchFn, useDefaultTimeout);
    if (venue === 'HYPERLIQUID') return await hyperliquidModifySl(normalized, fetchFn, nowFn, useDefaultTimeout);
  } catch (err) {
    return { ok: false, error: `Lỗi sửa SL ${venue}: ${err?.message || 'Unknown'}` };
  }
  return { ok: false, error: 'Sàn không hợp lệ.' };
}

export async function cancelExchangeOrder(params = {}, deps = {}) {
  const fetchFn = deps.fetchFn || globalThis.fetch;
  const nowFn = deps.nowFn || Date.now;
  const useDefaultTimeout = !deps.fetchFn;
  const venue = String(params.venue || '').toUpperCase();
  const net = String(params.network || 'TESTNET').toUpperCase() === 'MAINNET' ? 'MAINNET' : 'TESTNET';
  if (!SUPPORTED_VENUES.has(venue)) return { ok: false, error: `Sàn không hỗ trợ: ${venue}` };
  const normalized = { ...params, venue, net };
  try {
    if (venue === 'BINANCE') return await binanceCancelOrder(normalized, fetchFn, nowFn, useDefaultTimeout);
    if (venue === 'BYBIT') return await bybitCancelOrder(normalized, fetchFn, nowFn, useDefaultTimeout);
    if (venue === 'OKX') return await okxCancelOrder(normalized, fetchFn, nowFn, useDefaultTimeout);
    if (venue === 'DERIBIT') return await deribitCancelOrder(normalized, fetchFn, useDefaultTimeout);
    if (venue === 'HYPERLIQUID') return await hyperliquidCancelOrder(normalized, fetchFn, nowFn, useDefaultTimeout);
  } catch (err) {
    return { ok: false, error: `Lỗi hủy lệnh ${venue}: ${err?.message || 'Unknown'}` };
  }
  return { ok: false, error: 'Sàn không hợp lệ.' };
}

export async function closeExchangePosition(params = {}, deps = {}) {
  const fetchFn = deps.fetchFn || globalThis.fetch;
  const nowFn = deps.nowFn || Date.now;
  const useDefaultTimeout = !deps.fetchFn;
  const venue = String(params.venue || '').toUpperCase();
  const net = String(params.network || 'TESTNET').toUpperCase() === 'MAINNET' ? 'MAINNET' : 'TESTNET';
  if (!SUPPORTED_VENUES.has(venue)) return { ok: false, error: `Sàn không hỗ trợ: ${venue}` };
  const normalized = { ...params, venue, net };
  try {
    if (venue === 'BINANCE') return await binanceClosePosition(normalized, fetchFn, nowFn, useDefaultTimeout);
    if (venue === 'BYBIT') return await bybitClosePosition(normalized, fetchFn, nowFn, useDefaultTimeout);
    if (venue === 'OKX') return await okxClosePosition(normalized, fetchFn, nowFn, useDefaultTimeout);
    if (venue === 'DERIBIT') return await deribitClosePosition(normalized, fetchFn, useDefaultTimeout);
    if (venue === 'HYPERLIQUID') return await hyperliquidClosePosition(normalized, fetchFn, nowFn, useDefaultTimeout);
  } catch (err) {
    return { ok: false, error: `Lỗi đóng lệnh ${venue}: ${err?.message || 'Unknown'}` };
  }
  return { ok: false, error: 'Sàn không hợp lệ.' };
}
