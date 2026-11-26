/* ==========================================================================
   QUANTUM CORE // Zero-Trust Exchange Balance Adapter
   - Queries official read-only balance endpoints for 5 venues:
     HYPERLIQUID, BINANCE, BYBIT, OKX, DERIBIT
   - Never logs or returns apiKey / apiSecret / passphrase / agentKey
   - Injectable fetchFn & nowFn for deterministic unit testing
   ========================================================================== */

import { createHmac } from 'node:crypto';

const SUPPORTED_VENUES = new Set(['HYPERLIQUID', 'BINANCE', 'BYBIT', 'OKX', 'DERIBIT']);

function numOrZero(val) {
  const n = parseFloat(val);
  return Number.isFinite(n) ? n : 0;
}

function buildFetchOpts(method, headers, bodyObj, useDefaultTimeout) {
  const opts = { method, headers: headers || {} };
  if (bodyObj !== undefined) {
    opts.body = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
  }
  if (useDefaultTimeout && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    opts.signal = AbortSignal.timeout(8000);
  }
  return opts;
}

async function fetchHyperliquidBalance({ walletAddress, vaultAddress, network = 'MAINNET' }, fetchFn, useDefaultTimeout) {
  const targetAddr = String(vaultAddress || walletAddress || '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(targetAddr)) {
    return { ok: false, error: 'Địa chỉ ví Hyperliquid phải là chuỗi 0x hợp lệ gồm 42 ký tự.' };
  }

  const baseUrl = String(network).toUpperCase() === 'TESTNET'
    ? 'https://api.hyperliquid-testnet.xyz/info'
    : 'https://api.hyperliquid.xyz/info';
  const headers = { 'Content-Type': 'application/json' };

  const [chRes, spotRes] = await Promise.all([
    fetchFn(baseUrl, buildFetchOpts('POST', headers, { type: 'clearinghouseState', user: targetAddr }, useDefaultTimeout)),
    fetchFn(baseUrl, buildFetchOpts('POST', headers, { type: 'spotClearinghouseState', user: targetAddr }, useDefaultTimeout))
  ]);

  if (!chRes.ok) {
    return { ok: false, error: `Hyperliquid API trả lỗi HTTP ${chRes.status}` };
  }

  const ch = await chRes.json();
  const spot = spotRes.ok ? await spotRes.json() : {};

  const perpEq = numOrZero(ch?.marginSummary?.accountValue ?? ch?.crossMarginSummary?.accountValue);
  const marginUsed = numOrZero(ch?.marginSummary?.totalMarginUsed ?? ch?.crossMarginSummary?.totalMarginUsed);
  const withdrawableRaw = ch?.withdrawable !== undefined ? numOrZero(ch.withdrawable) : Math.max(0, perpEq - marginUsed);

  let spotUsdc = 0;
  let spotHold = 0;
  const spotBalances = Array.isArray(spot?.balances) ? spot.balances : [];
  for (const b of spotBalances) {
    if (String(b?.coin || '').toUpperCase().startsWith('USDC')) {
      spotUsdc += numOrZero(b.total);
      spotHold += numOrZero(b.hold);
    }
  }
  const spotFreeUsdc = Math.max(0, spotUsdc - spotHold);

  const equityUsd = perpEq > 0 ? perpEq : spotUsdc;
  const freeMarginUsd = perpEq > 0 ? Math.max(0, withdrawableRaw) : spotFreeUsdc;

  return {
    ok: true,
    venue: 'HYPERLIQUID',
    network: String(network).toUpperCase(),
    equityUsd: Number(equityUsd.toFixed(4)),
    freeMarginUsd: Number(freeMarginUsd.toFixed(4)),
    perpEquityUsd: Number(perpEq.toFixed(4)),
    spotUsdc: Number(spotUsdc.toFixed(4))
  };
}

async function fetchBinanceBalance({ apiKey, apiSecret, network = 'MAINNET' }, fetchFn, nowFn, useDefaultTimeout) {
  const key = String(apiKey || '').trim();
  const secret = String(apiSecret || '').trim();
  if (key.length < 8 || secret.length < 8) {
    return { ok: false, error: 'Thiếu API Key hoặc API Secret Binance Futures hợp lệ.' };
  }

  const net = String(network).toUpperCase() === 'TESTNET' ? 'TESTNET' : 'MAINNET';
  const baseUrl = net === 'TESTNET' ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
  const ts = nowFn();
  const qs = `timestamp=${ts}&recvWindow=5000`;
  const sig = createHmac('sha256', secret).update(qs).digest('hex');
  const url = `${baseUrl}/fapi/v2/account?${qs}&signature=${sig}`;

  const res = await fetchFn(url, buildFetchOpts('GET', { 'X-MBX-APIKEY': key }, undefined, useDefaultTimeout));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, error: data?.msg ? `Binance: ${data.msg}` : `Binance HTTP ${res.status}` };
  }

  const equityUsd = numOrZero(data?.totalMarginBalance ?? data?.totalWalletBalance);
  const freeMarginUsd = data?.availableBalance !== undefined ? numOrZero(data.availableBalance) : equityUsd;

  return {
    ok: true,
    venue: 'BINANCE',
    network: net,
    equityUsd: Number(equityUsd.toFixed(4)),
    freeMarginUsd: Number(Math.max(0, freeMarginUsd).toFixed(4)),
    perpEquityUsd: Number(equityUsd.toFixed(4)),
    spotUsdc: 0
  };
}

async function fetchBybitBalance({ apiKey, apiSecret, network = 'MAINNET' }, fetchFn, nowFn, useDefaultTimeout) {
  const key = String(apiKey || '').trim();
  const secret = String(apiSecret || '').trim();
  if (key.length < 8 || secret.length < 8) {
    return { ok: false, error: 'Thiếu API Key hoặc API Secret Bybit hợp lệ.' };
  }

  const net = String(network).toUpperCase() === 'TESTNET' ? 'TESTNET' : 'MAINNET';
  const baseUrl = net === 'TESTNET' ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';

  const queryAccountType = async (accountType) => {
    const ts = String(nowFn());
    const recv = '5000';
    const qs = `accountType=${accountType}`;
    const sign = createHmac('sha256', secret).update(ts + key + recv + qs).digest('hex');
    const url = `${baseUrl}/v5/account/wallet-balance?${qs}`;
    const headers = {
      'X-BAPI-API-KEY': key,
      'X-BAPI-TIMESTAMP': ts,
      'X-BAPI-RECV-WINDOW': recv,
      'X-BAPI-SIGN': sign
    };
    const res = await fetchFn(url, buildFetchOpts('GET', headers, undefined, useDefaultTimeout));
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  };

  let attempt = await queryAccountType('UNIFIED');
  if (!attempt.ok || attempt.json?.retCode !== 0) {
    attempt = await queryAccountType('CONTRACT');
  }
  if (!attempt.ok || attempt.json?.retCode !== 0) {
    return { ok: false, error: attempt.json?.retMsg ? `Bybit: ${attempt.json.retMsg}` : `Bybit HTTP ${attempt.status}` };
  }

  const acct = attempt.json?.result?.list?.[0] || {};
  const equityUsd = numOrZero(acct.totalEquity ?? acct.totalMarginBalance ?? acct.totalWalletBalance);
  const freeMarginUsd = acct.totalAvailableBalance !== undefined ? numOrZero(acct.totalAvailableBalance) : equityUsd;

  return {
    ok: true,
    venue: 'BYBIT',
    network: String(network).toUpperCase(),
    equityUsd: Number(equityUsd.toFixed(4)),
    freeMarginUsd: Number(Math.max(0, freeMarginUsd).toFixed(4)),
    perpEquityUsd: Number(equityUsd.toFixed(4)),
    spotUsdc: 0
  };
}

async function fetchOkxBalance({ apiKey, apiSecret, passphrase, network = 'MAINNET' }, fetchFn, nowFn, useDefaultTimeout) {
  const key = String(apiKey || '').trim();
  const secret = String(apiSecret || '').trim();
  const pass = String(passphrase || '').trim();
  if (key.length < 8 || secret.length < 8 || !pass) {
    return { ok: false, error: 'OKX yêu cầu đầy đủ API Key, API Secret và Passphrase.' };
  }

  const net = String(network).toUpperCase() === 'TESTNET' ? 'TESTNET' : 'MAINNET';
  const tsIso = new Date(nowFn()).toISOString();
  const reqPath = '/api/v5/account/balance';
  const prehash = `${tsIso}GET${reqPath}`;
  const sign = createHmac('sha256', secret).update(prehash).digest('base64');
  const reqHeaders = {
    'OK-ACCESS-KEY': key,
    'OK-ACCESS-SIGN': sign,
    'OK-ACCESS-TIMESTAMP': tsIso,
    'OK-ACCESS-PASSPHRASE': pass
  };
  if (net === 'TESTNET') reqHeaders['x-simulated-trading'] = '1';

  const res = await fetchFn(
    `https://www.okx.com${reqPath}`,
    buildFetchOpts(
      'GET',
      reqHeaders,
      undefined,
      useDefaultTimeout
    )
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok || String(json?.code) !== '0') {
    return { ok: false, error: json?.msg ? `OKX: ${json.msg}` : `OKX HTTP ${res.status}` };
  }

  const acct = json?.data?.[0] || {};
  const equityUsd = numOrZero(acct.totalEq);
  let availSum = 0;
  let hasAvailDetail = false;
  if (Array.isArray(acct.details)) {
    for (const d of acct.details) {
      if (d?.availEq !== undefined && d.availEq !== '') {
        hasAvailDetail = true;
        availSum += numOrZero(d.availEq);
      }
    }
  }
  const freeMarginUsd = hasAvailDetail ? Math.min(equityUsd || availSum, availSum) : equityUsd;

  return {
    ok: true,
    venue: 'OKX',
    network: String(network).toUpperCase(),
    equityUsd: Number(equityUsd.toFixed(4)),
    freeMarginUsd: Number(Math.max(0, freeMarginUsd).toFixed(4)),
    perpEquityUsd: Number(equityUsd.toFixed(4)),
    spotUsdc: 0
  };
}

async function fetchDeribitBalance({ apiKey, apiSecret, network = 'MAINNET' }, fetchFn, useDefaultTimeout) {
  const clientId = String(apiKey || '').trim();
  const clientSecret = String(apiSecret || '').trim();
  if (clientId.length < 6 || clientSecret.length < 8) {
    return { ok: false, error: 'Deribit yêu cầu Client ID (API Key) và Client Secret hợp lệ.' };
  }

  const net = String(network).toUpperCase() === 'TESTNET' ? 'TESTNET' : 'MAINNET';
  const baseUrl = net === 'TESTNET' ? 'https://test.deribit.com' : 'https://www.deribit.com';
  const authUrl = `${baseUrl}/api/v2/public/auth?client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&grant_type=client_credentials`;
  const authRes = await fetchFn(authUrl, buildFetchOpts('GET', {}, undefined, useDefaultTimeout));
  const authJson = await authRes.json().catch(() => ({}));
  const token = authJson?.result?.access_token;
  if (!authRes.ok || !token) {
    return { ok: false, error: authJson?.error?.message ? `Deribit Auth: ${authJson.error.message}` : `Deribit Auth HTTP ${authRes.status}` };
  }

  const headers = { Authorization: `Bearer ${token}` };
  const [usdcRes, usdtRes] = await Promise.all([
    fetchFn(`${baseUrl}/api/v2/private/get_account_summary?currency=USDC`, buildFetchOpts('GET', headers, undefined, useDefaultTimeout)),
    fetchFn(`${baseUrl}/api/v2/private/get_account_summary?currency=USDT`, buildFetchOpts('GET', headers, undefined, useDefaultTimeout))
  ]);

  const usdcJson = await usdcRes.json().catch(() => ({}));
  const usdtJson = await usdtRes.json().catch(() => ({}));
  const eq = numOrZero(usdcJson?.result?.equity) + numOrZero(usdtJson?.result?.equity);
  const avail = numOrZero(usdcJson?.result?.available_funds) + numOrZero(usdtJson?.result?.available_funds);

  return {
    ok: true,
    venue: 'DERIBIT',
    network: String(network).toUpperCase(),
    equityUsd: Number(eq.toFixed(4)),
    freeMarginUsd: Number(Math.max(0, avail).toFixed(4)),
    perpEquityUsd: Number(eq.toFixed(4)),
    spotUsdc: 0
  };
}

export async function fetchExchangeBalance(params = {}, deps = {}) {
  const fetchFn = deps.fetchFn || globalThis.fetch;
  const nowFn = deps.nowFn || Date.now;
  const useDefaultTimeout = !deps.fetchFn;

  if (typeof fetchFn !== 'function') {
    return { ok: false, error: 'Môi trường hiện tại không hỗ trợ fetch.' };
  }

  const venue = String(params.venue || '').toUpperCase();
  if (!SUPPORTED_VENUES.has(venue)) {
    return { ok: false, error: `Sàn không được hỗ trợ truy vấn số dư: ${venue || 'N/A'}` };
  }

  try {
    if (venue === 'HYPERLIQUID') {
      return await fetchHyperliquidBalance(params, fetchFn, useDefaultTimeout);
    }
    if (venue === 'BINANCE') {
      return await fetchBinanceBalance(params, fetchFn, nowFn, useDefaultTimeout);
    }
    if (venue === 'BYBIT') {
      return await fetchBybitBalance(params, fetchFn, nowFn, useDefaultTimeout);
    }
    if (venue === 'OKX') {
      return await fetchOkxBalance(params, fetchFn, nowFn, useDefaultTimeout);
    }
    if (venue === 'DERIBIT') {
      return await fetchDeribitBalance(params, fetchFn, useDefaultTimeout);
    }
    return { ok: false, error: 'Sàn không hợp lệ.' };
  } catch (err) {
    return { ok: false, error: `Lỗi kết nối ${venue}: ${err?.name === 'TimeoutError' ? 'Hết thời gian chờ (8s)' : (err?.message || 'Unknown error')}` };
  }
}
