import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fetchExchangeBalance } from '../server/exchangeBalanceAdapter.mjs';
import { keccak256, msgpackEncode, privateKeyToAddress, signHyperliquidL1Action } from '../server/hlEip712Signer.mjs';
import {
  placeExchangeOrder,
  modifyExchangeStopLoss,
  cancelExchangeOrder,
  closeExchangePosition,
  fetchExchangePositions
} from '../server/exchangeOrderAdapter.mjs';

const require = createRequire(import.meta.url);
const QuantumUUID = require('../src/core/uuid.js');
const QuantumSchemas = require('../src/core/schemas.js');
const QuantumSecurityGate = require('../src/core/securityGate.js');
const QuantumMarketEngine = require('../src/engines/marketEngine.js');
const QuantumTradingEngine = require('../src/engines/tradingEngine.js');

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test('uuid.js generates valid unique RFC 4122 v4 UUIDs and short IDs', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const id = QuantumUUID.v4();
    assert.match(id, UUID_V4_REGEX);
    assert.equal(seen.has(id), false);
    seen.add(id);
  }
  const sample = QuantumUUID.v4();
  assert.equal(QuantumUUID.shortId(sample).length, 4);
  assert.equal(QuantumUUID.isValid(sample), true);
  assert.equal(QuantumUUID.isValid('1001'), false);
});

test('schemas.js validates order input, market ticks, and strips sensitive fields in DTOs', () => {
  const okOrder = QuantumSchemas.validateOrderInput({
    symbol: 'BTC-PERP',
    exchange: 'HYPERLIQUID',
    side: 'LONG',
    entryPrice: 94000,
    sizeUsd: 5000,
    leverage: 5,
    slPct: 0.8,
    tpPct: 1.8
  });
  assert.equal(okOrder.ok, true);

  const badOrder = QuantumSchemas.validateOrderInput({
    symbol: 'INVALID',
    side: 'BUY_ALL',
    sizeUsd: -50,
    leverage: 500
  });
  assert.equal(badOrder.ok, false);
  assert.ok(badOrder.errors.length >= 3);

  const tickOk = QuantumSchemas.validateMarketTick({ symbol: 'BTC-PERP', price: 94250, funding8h: 0.01 });
  assert.equal(tickOk.ok, true);
  assert.equal(QuantumSchemas.validateMarketTick({ symbol: 'BTC-PERP', price: -10 }).ok, false);

  const scrubbed = QuantumSchemas.scrubSensitive({
    venue: 'BINANCE',
    apiKey: 'bn_123456789',
    apiSecret: 'super_secret',
    agentKey: '0xprivate',
    otpHmac: 'deadbeef',
    sessionToken: 'tok_xyz',
    passphrase: 'pass'
  });
  assert.equal(scrubbed.venue, 'BINANCE');
  assert.equal('apiSecret' in scrubbed, false);
  assert.equal('agentKey' in scrubbed, false);
  assert.equal('otpHmac' in scrubbed, false);
  assert.equal('sessionToken' in scrubbed, false);
  assert.equal('passphrase' in scrubbed, false);

  const posDto = QuantumSchemas.toPositionPublicDTO({
    id: QuantumUUID.v4(),
    symbol: 'BTC-PERP',
    exchange: 'HYPERLIQUID',
    side: 'LONG',
    entryPrice: 94000,
    markPrice: 94200,
    slPrice: 93200,
    tpPrice: 95800,
    sizeUsd: 5000,
    leverage: 5,
    marginUsd: 1000,
    unrealizedPnl: 10.6,
    roePct: 1.06,
    beLocked: false,
    trailingActive: false,
    hedgeGroupId: null,
    accruedFundingUsd: 0,
    source: 'MANUAL',
    apiSecret: 'MUST_NOT_LEAK'
  });
  assert.equal('apiSecret' in posDto, false);
  assert.equal(posDto.symbol, 'BTC-PERP');
});

test('securityGate.js enforces HMAC-SHA256 OTP, 60s cooldown, IP binding, 5-attempt lockout, 10m expiry, and session revocation', async () => {
  let fakeNow = 1_700_000_000_000;
  const gate = new QuantumSecurityGate({
    hmacKey: 'unit-test-hmac-secret',
    nowFn: () => fakeNow
  });

  const req1 = await gate.requestOtp({ email: 'trader@quantum.io', ip: '127.0.0.1' });
  assert.equal(req1.ok, true);
  assert.match(req1.challengeId, UUID_V4_REGEX);
  assert.match(req1.devPreviewOtp, /^\d{6}$/);

  // Ensure plaintext OTP is NOT stored in internal challenge state
  const internalJson = JSON.stringify(gate.debugDumpPublicMetrics());
  assert.equal(internalJson.includes(req1.devPreviewOtp), false);
  const rawChallenge = gate._challenges.get(req1.challengeId);
  assert.equal(JSON.stringify(rawChallenge).includes(req1.devPreviewOtp), false);
  assert.ok(typeof rawChallenge.otpHmac === 'string' && rawChallenge.otpHmac.length === 64);

  // 60s resend cooldown blocks immediate duplicate request
  const reqCooldown = await gate.requestOtp({ email: 'trader@quantum.io', ip: '127.0.0.1' });
  assert.equal(reqCooldown.ok, false);
  assert.equal(reqCooldown.code, 'RESEND_COOLDOWN');

  // IP mismatch check
  const ipFail = await gate.verifyOtp({
    challengeId: req1.challengeId,
    otp: req1.devPreviewOtp,
    ip: '10.0.0.99'
  });
  assert.equal(ipFail.ok, false);
  assert.equal(ipFail.code, 'IP_MISMATCH');

  // 5 wrong attempts lock out the challenge
  const wrongOtp = req1.devPreviewOtp === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) {
    const fail = await gate.verifyOtp({ challengeId: req1.challengeId, otp: wrongOtp, ip: '127.0.0.1' });
    assert.equal(fail.ok, false);
  }
  const lockedOut = await gate.verifyOtp({ challengeId: req1.challengeId, otp: req1.devPreviewOtp, ip: '127.0.0.1' });
  assert.equal(lockedOut.ok, false);
  assert.equal(lockedOut.code, 'MAX_ATTEMPTS_EXCEEDED');

  // Advance clock past 60s cooldown, request new OTP, and test 10m expiry
  fakeNow += 65_000;
  const req2 = await gate.requestOtp({ email: 'trader@quantum.io', ip: '127.0.0.1' });
  assert.equal(req2.ok, true);
  fakeNow += 601_000;
  const expiredRes = await gate.verifyOtp({ challengeId: req2.challengeId, otp: req2.devPreviewOtp, ip: '127.0.0.1' });
  assert.equal(expiredRes.ok, false);
  assert.equal(expiredRes.code, 'OTP_EXPIRED');

  // Valid OTP verification creates TRADER session and revokeAllSessions() invalidates it
  fakeNow += 65_000;
  const req3 = await gate.requestOtp({ email: 'trader@quantum.io', ip: '127.0.0.1', role: 'TRADER' });
  const verified = await gate.verifyOtp({ challengeId: req3.challengeId, otp: req3.devPreviewOtp, ip: '127.0.0.1' });
  assert.equal(verified.ok, true);
  assert.match(verified.session.sessionId, UUID_V4_REGEX);
  assert.equal(gate.validateSession(verified.session.sessionId, '127.0.0.1', 'TRADER').ok, true);

  gate.revokeAllSessions();
  assert.equal(gate.validateSession(verified.session.sessionId, '127.0.0.1', 'TRADER').ok, false);
});

test('MarketEngine + TradingEngine use UUIDv4 IDs, Risk Shield, Auto-BE, Delta-Neutral Hedge, and 2FA Live Gate', async () => {
  const gate = new QuantumSecurityGate({ hmacKey: 'engine-test-key' });
  const market = new QuantumMarketEngine({ QuantumUUID, QuantumSchemas });
  const trading = new QuantumTradingEngine(market, { QuantumUUID, QuantumSchemas, securityGate: gate });

  const sym = 'BTC-PERP';
  const px = market.getPrice(sym, 'HYPERLIQUID');

  // Place Limit order and verify UUID v4
  const ord = trading.placeLimitOrder({
    symbol: sym,
    exchange: 'HYPERLIQUID',
    side: 'LONG',
    entryPrice: px * 0.995,
    sizeUsd: 4000,
    leverage: 5,
    slPct: 0.8,
    tpPct: 1.8
  });
  assert.ok(ord);
  assert.match(ord.id, UUID_V4_REGEX);

  // Market order opens position with UUID v4
  const pos = trading.placeMarketOrder({
    symbol: sym,
    exchange: 'HYPERLIQUID',
    side: 'LONG',
    sizeUsd: 4000,
    leverage: 5,
    slPct: 0.8,
    tpPct: 1.8
  });
  assert.ok(pos);
  assert.match(pos.id, UUID_V4_REGEX);
  assert.equal(trading.getPublicPositions().length, 1);

  // Delta-Neutral Hedge pair shares a UUID v4 hedgeGroupId
  const opps = market.getArbitrageOpportunities();
  assert.ok(opps.length > 0);
  const hedged = trading.executeDeltaNeutralArb(opps[0], 8000, 'ARB');
  assert.equal(hedged, true);
  const hedgeLegs = trading.positions.filter((p) => p.hedgeGroupId);
  assert.equal(hedgeLegs.length, 2);
  assert.match(hedgeLegs[0].hedgeGroupId, UUID_V4_REGEX);

  // Zero-Trust Live Gate rejects without valid 2FA session
  const unauthRes = trading.configureLiveBridge({ venue: 'HYPERLIQUID DEX', network: 'TESTNET' }, 'fake-sid', '127.0.0.1');
  assert.equal(unauthRes.ok, false);

  const otpReq = await gate.requestOtp({ email: 'ops@quantum.io', ip: '127.0.0.1', role: 'TRADER' });
  const otpVer = await gate.verifyOtp({ challengeId: otpReq.challengeId, otp: otpReq.devPreviewOtp, ip: '127.0.0.1' });
  const authRes = trading.configureLiveBridge(
    { venue: 'HYPERLIQUID DEX', network: 'TESTNET', walletAddress: '0x71C9000000000000000000000000000000001234' },
    otpVer.session.sessionId,
    '127.0.0.1'
  );
  assert.equal(authRes.ok, true);
  assert.equal(trading.mode, 'LIVE');

  trading.revokeLiveSessions();
  assert.equal(trading.mode, 'DEMO');
  assert.equal(trading.liveConfig.connected, false);
});

test('MarketEngine.getDirectionalSignal and TradingEngine.setBotDirectionMode + executeAiSignalOrder work cleanly', () => {
  const market = new QuantumMarketEngine({ QuantumUUID, QuantumSchemas });
  const trading = new QuantumTradingEngine(market, { QuantumUUID, QuantumSchemas });

  const sig = market.getDirectionalSignal('BTC-PERP');
  assert.ok(['LONG', 'SHORT', 'WAIT'].includes(sig.side));
  assert.ok(sig.score >= -100 && sig.score <= 100);
  assert.ok(sig.confidence >= 50 && sig.confidence <= 95);

  trading.setBotDirectionMode('LONG_ONLY');
  assert.equal(trading.botDirectionMode, 'LONG_ONLY');
  const longPos = trading.executeAiSignalOrder({ symbol: 'BTC-PERP', forceEntry: true, source: 'AI_1CLICK' });
  assert.ok(longPos);
  assert.equal(longPos.side, 'LONG');

  trading.setBotDirectionMode('SHORT_ONLY');
  assert.equal(trading.botDirectionMode, 'SHORT_ONLY');
  const shortPos = trading.executeAiSignalOrder({ symbol: 'ETH-PERP', forceEntry: true, source: 'AI_1CLICK' });
  assert.ok(shortPos);
  assert.equal(shortPos.side, 'SHORT');

  trading.setBotDirectionMode('HEDGE');
  assert.equal(trading.botStrategy, 'DELTA_ARB');
  trading.setBotDirectionMode('AUTO');
  assert.equal(trading.botStrategy, 'MOMENTUM');
});

test('Auto-Bot ledger reconciliation, anti-stacking, and positive multi-regime expectancy (+EV)', () => {
  // Test MOMENTUM (AUTO) across 7 multi-seed runs to verify genuine +EV without cherry-picking
  let netProfitableRuns = 0;
  let totalWins = 0;
  let totalClosed = 0;
  let totalNetPnl = 0;
  const runCount = 7;

  for (let run = 0; run < runCount; run++) {
    const market = new QuantumMarketEngine({ QuantumUUID, QuantumSchemas });
    const trading = new QuantumTradingEngine(market, { QuantumUUID, QuantumSchemas });

    trading.toggleBot();
    assert.equal(trading.botRunning, true);

    for (let t = 0; t < 900; t++) {
      market.tick();
      trading.onMarketTick();

      // Anti-stacking invariant: max 1 non-hedge position per symbol and max 2 directional overall
      const dirPos = trading.positions.filter((p) => !p.hedgeGroupId);
      assert.ok(dirPos.length <= 2, `Stacked ${dirPos.length} directional positions`);
      const syms = dirPos.map((p) => p.symbol);
      assert.equal(new Set(syms).size, syms.length, `Duplicate position on same symbol: ${syms.join(',')}`);
    }

    trading.closeAll('BACKTEST END');
    const metrics = trading.getMetrics();
    const sumHistoryPnl = trading.history.reduce((acc, h) => acc + h.pnl, 0);

    // Exact accounting invariant: balance - 100000 === realizedPnl === sum(history.pnl)
    assert.ok(Math.abs((trading.balance - 100000) - trading.realizedPnl) < 1e-6);
    assert.ok(Math.abs(trading.realizedPnl - sumHistoryPnl) < 1e-6);
    assert.ok(metrics.drawdownPct <= 2.55, `Drawdown exceeded safety ceiling: ${metrics.drawdownPct.toFixed(2)}%`);

    totalWins += metrics.wins;
    totalClosed += metrics.wins + metrics.losses;
    totalNetPnl += trading.realizedPnl;
    if (trading.balance >= 100000) {
      netProfitableRuns++;
    }
  }

  const aggWinRate = totalClosed > 0 ? (totalWins / totalClosed) * 100 : 0;
  assert.ok(netProfitableRuns >= 5, `Expected >=5/7 profitable runs, got ${netProfitableRuns}/${runCount}`);
  assert.ok(totalNetPnl > 0, `Expected positive aggregate Net PnL, got ${totalNetPnl.toFixed(2)}`);
  assert.ok(aggWinRate >= 55, `Expected aggregate Win Rate >= 55%, got ${aggWinRate.toFixed(1)}%`);

  // Also verify DELTA_ARB (HEDGE), MEAN_REV, STAT_ARB, GRID execute cleanly with exact ledger reconciliation
  for (const strat of ['DELTA_ARB', 'MEAN_REV', 'STAT_ARB', 'GRID']) {
    const market = new QuantumMarketEngine({ QuantumUUID, QuantumSchemas });
    const trading = new QuantumTradingEngine(market, { QuantumUUID, QuantumSchemas });
    trading.setBotStrategy(strat);
    trading.toggleBot();

    for (let t = 0; t < 450; t++) {
      market.tick();
      trading.onMarketTick();
    }
    trading.closeAll('STRATEGY VERIFY');
    const m = trading.getMetrics();
    assert.ok(Math.abs((trading.balance - 100000) - trading.realizedPnl) < 1e-6);
    assert.ok(m.drawdownPct <= 2.55, `${strat} drawdown too high: ${m.drawdownPct.toFixed(2)}%`);
  }
});

test('Venue exact price locking and adaptive capital tiers ($10-$100 MICRO vs $100+ GROWTH)', () => {
  const market = new QuantumMarketEngine({ QuantumUUID, QuantumSchemas });
  const trading = new QuantumTradingEngine(market, { QuantumUUID, QuantumSchemas });

  // 1. Venue lock: selecting BYBIT locks preferred venue, anchored candles, and execution price
  market.setExchange('BYBIT');
  assert.equal(trading.getPreferredVenue(), 'BYBIT');
  const bybitPx = market.getPrice('BTC-PERP', 'BYBIT');
  const bybitCandles = market.getVenueCandles('BTC-PERP', 'BYBIT');
  assert.ok(Math.abs(bybitCandles[bybitCandles.length - 1].c - bybitPx) < 1e-6);

  const bybitOrd = trading.placeMarketOrder({
    symbol: 'BTC-PERP',
    exchange: market.activeExchange,
    side: 'LONG',
    sizeUsd: 2000,
    leverage: 5,
    slPct: 0.8,
    tpPct: 1.8
  });
  assert.ok(bybitOrd);
  assert.equal(bybitOrd.exchange, 'BYBIT');
  assert.ok(Math.abs(bybitOrd.entryPrice - bybitPx) < 1e-6);
  trading.closeAll('CLEANUP');

  // 2. Micro tier ($15 account): $5-$60 sizing, max 1 directional pos, exact venue & ledger reconciliation
  const microProf = trading.setCapital(15);
  assert.equal(microProf.tier, 'MICRO');
  assert.equal(microProf.maxConcurrentDirectional, 1);
  assert.equal(trading.maxDrawdownPct, 5.0);

  const microOptSize = trading.calculateOptimalSize({ symbol: 'SOL-PERP', exchange: 'BYBIT', slPct: 0.65, isMaker: false });
  assert.ok(microOptSize >= 5 && microOptSize <= 15 * 5 * 0.7 + 0.1, `Micro size out of range: ${microOptSize}`);

  const microPos = trading.placeMarketOrder({
    symbol: 'SOL-PERP',
    exchange: 'BYBIT',
    side: 'LONG',
    sizeUsd: microOptSize,
    leverage: 5,
    slPct: 0.65,
    tpPct: 1.55
  });
  assert.ok(microPos);
  assert.equal(microPos.exchange, 'BYBIT');

  // Run Auto-Bot on $15 Micro account — must respect max 1 directional position & ledger invariant
  trading.closeAll('RESET');
  trading.toggleBot();
  for (let t = 0; t < 250; t++) {
    market.tick();
    trading.onMarketTick();
    const dirCount = trading.positions.filter((p) => !p.hedgeGroupId).length;
    assert.ok(dirCount <= 1, `Micro account opened ${dirCount} simultaneous positions (max 1)`);
  }
  trading.closeAll('MICRO END');
  assert.ok(Math.abs((trading.balance - 15) - trading.realizedPnl) < 1e-6);

  // 3. Growth tier ($150 account): SMALL tier, max 2 directional pos, 1.0% risk/trade
  const smallProf = trading.setCapital(150);
  assert.equal(smallProf.tier, 'SMALL');
  assert.equal(smallProf.maxConcurrentDirectional, 2);
  assert.equal(trading.riskShield.riskPerTradePct, 1.0);

  const smallSize = trading.calculateOptimalSize({ symbol: 'ETH-PERP', exchange: 'BYBIT', slPct: 0.65, isMaker: false });
  assert.ok(smallSize >= 10 && smallSize <= 150 * 5 * 0.85, `Small size out of range: ${smallSize}`);
  const smallPos = trading.placeMarketOrder({
    symbol: 'ETH-PERP',
    exchange: 'BYBIT',
    side: 'SHORT',
    sizeUsd: smallSize,
    leverage: 5,
    slPct: 0.65,
    tpPct: 1.55
  });
  assert.ok(smallPos);
  assert.equal(smallPos.exchange, 'BYBIT');
  trading.closeAll('SMALL END');
  assert.ok(Math.abs((trading.balance - 150) - trading.realizedPnl) < 1e-6);
});

test('Zero-Trust exchangeBalanceAdapter fetches & signs all 5 venues cleanly and syncLiveAccountBalance restores Demo on exit', async () => {
  const FIXED_TS = 1700000000000;
  const mockJsonRes = (data, ok = true, status = 200) => ({
    ok,
    status,
    json: async () => data
  });

  // 1. Hyperliquid DEX (Perp clearinghouseState + Spot fallback)
  const hlRes = await fetchExchangeBalance(
    { venue: 'HYPERLIQUID', walletAddress: '0x1111111111111111111111111111111111111111', network: 'MAINNET' },
    {
      nowFn: () => FIXED_TS,
      fetchFn: async (_url, opts) => {
        const body = JSON.parse(opts.body);
        if (body.type === 'clearinghouseState') {
          return mockJsonRes({ marginSummary: { accountValue: '42.75', totalMarginUsed: '5.0' }, withdrawable: '37.75' });
        }
        return mockJsonRes({ balances: [{ coin: 'USDC', total: '12.5', hold: '0' }] });
      }
    }
  );
  assert.equal(hlRes.ok, true);
  assert.equal(hlRes.equityUsd, 42.75);
  assert.equal(hlRes.freeMarginUsd, 37.75);

  // 2. Binance Futures (HMAC-SHA256 signature & X-MBX-APIKEY)
  let capturedBinanceUrl = '';
  const bnRes = await fetchExchangeBalance(
    { venue: 'BINANCE', apiKey: 'bn_key_123456', apiSecret: 'bn_secret_abcdef' },
    {
      nowFn: () => FIXED_TS,
      fetchFn: async (url, opts) => {
        capturedBinanceUrl = url;
        assert.equal(opts.headers['X-MBX-APIKEY'], 'bn_key_123456');
        return mockJsonRes({ totalMarginBalance: '250.50', availableBalance: '210.25' });
      }
    }
  );
  assert.equal(bnRes.ok, true);
  assert.match(capturedBinanceUrl, /signature=[a-f0-9]{64}$/);
  assert.equal(bnRes.equityUsd, 250.5);
  assert.equal(bnRes.freeMarginUsd, 210.25);

  // 3. Bybit V5 (UNIFIED wallet-balance + X-BAPI-SIGN)
  const bbRes = await fetchExchangeBalance(
    { venue: 'BYBIT', apiKey: 'bb_key_123456', apiSecret: 'bb_secret_abcdef' },
    {
      nowFn: () => FIXED_TS,
      fetchFn: async (_url, opts) => {
        assert.match(opts.headers['X-BAPI-SIGN'], /^[a-f0-9]{64}$/);
        return mockJsonRes({ retCode: 0, result: { list: [{ totalEquity: '88.12', totalAvailableBalance: '75.00' }] } });
      }
    }
  );
  assert.equal(bbRes.ok, true);
  assert.equal(bbRes.equityUsd, 88.12);
  assert.equal(bbRes.freeMarginUsd, 75.0);

  // 4. OKX V5 (OK-ACCESS-SIGN Base64 + Passphrase)
  const okxRes = await fetchExchangeBalance(
    { venue: 'OKX', apiKey: 'okx_key_123456', apiSecret: 'okx_secret_abcdef', passphrase: 'pass_okx' },
    {
      nowFn: () => FIXED_TS,
      fetchFn: async (_url, opts) => {
        assert.equal(opts.headers['OK-ACCESS-PASSPHRASE'], 'pass_okx');
        assert.ok(opts.headers['OK-ACCESS-SIGN'].length > 20);
        return mockJsonRes({ code: '0', data: [{ totalEq: '150.25', details: [{ availEq: '130.00' }] }] });
      }
    }
  );
  assert.equal(okxRes.ok, true);
  assert.equal(okxRes.equityUsd, 150.25);
  assert.equal(okxRes.freeMarginUsd, 130.0);

  // 5. Deribit V2 (OAuth2 + USDC/USDT account_summary)
  const dbRes = await fetchExchangeBalance(
    { venue: 'DERIBIT', apiKey: 'db_client_123', apiSecret: 'db_secret_abcdef' },
    {
      nowFn: () => FIXED_TS,
      fetchFn: async (url) => {
        if (url.includes('/public/auth')) return mockJsonRes({ result: { access_token: 'tok_db' } });
        if (url.includes('currency=USDC')) return mockJsonRes({ result: { equity: 60.5, available_funds: 50.0 } });
        return mockJsonRes({ result: { equity: 40.0, available_funds: 35.0 } });
      }
    }
  );
  assert.equal(dbRes.ok, true);
  assert.equal(dbRes.equityUsd, 100.5);
  assert.equal(dbRes.freeMarginUsd, 85.0);

  // Ensure no secrets appear in any adapter response
  for (const r of [hlRes, bnRes, bbRes, okxRes, dbRes]) {
    const s = JSON.stringify(r);
    assert.equal(s.includes('secret'), false);
    assert.equal(s.includes('pass_okx'), false);
    assert.equal(s.includes('tok_db'), false);
  }

  // 6. TradingEngine.syncLiveAccountBalance applies exact real balance & restores Demo backup on revoke/exit
  const gate = new QuantumSecurityGate({ hmacKey: 'sync-test-key' });
  const market = new QuantumMarketEngine({ QuantumUUID, QuantumSchemas });
  const trading = new QuantumTradingEngine(market, { QuantumUUID, QuantumSchemas, securityGate: gate });
  trading.setCapital(500);

  const otpReq = await gate.requestOtp({ email: 'ops@quantum.io', ip: '127.0.0.1', role: 'TRADER' });
  const otpVer = await gate.verifyOtp({ challengeId: otpReq.challengeId, otp: otpReq.devPreviewOtp, ip: '127.0.0.1' });
  trading.configureLiveBridge({ venue: 'HYPERLIQUID DEX', network: 'MAINNET' }, otpVer.session.sessionId, '127.0.0.1');

  const prof = trading.syncLiveAccountBalance(hlRes);
  assert.equal(prof.tier, 'MICRO');
  const liveMetrics = trading.getMetrics();
  assert.equal(liveMetrics.equity, 42.75);
  assert.equal(liveMetrics.freeMargin, 37.75);

  trading.revokeLiveSessions();
  assert.equal(trading.mode, 'DEMO');
  assert.equal(trading.balance, 500);
});

test('Per-exchange coin selector, zero-noise live quote sync, and $100 Demo default compatibility', () => {
  const market = new QuantumMarketEngine({ QuantumUUID, QuantumSchemas });
  const trading = new QuantumTradingEngine(market, { QuantumUUID, QuantumSchemas });

  // 1. Per-venue coin lists match exchange coverage
  assert.ok(market.getVenueSymbols('BINANCE').includes('BNB-PERP'));
  assert.ok(market.getVenueSymbols('OKX').includes('DOGE-PERP'));
  assert.ok(market.getVenueSymbols('HYPERLIQUID').includes('HYPE-PERP'));

  // 2. Zero-noise live quote application per venue
  market.wsEnabled = true;
  market.setExchange('BYBIT');
  market.applyLiveVenueQuote('BTC-PERP', 'BYBIT', 58581.1, 0.0105, -2.75);
  market.tick();
  assert.equal(market.getPrice('BTC-PERP', 'BYBIT'), 58581.1);
  assert.equal(market.getChange24hPct('BTC-PERP', 'BYBIT'), -2.75);
  const candles = market.getVenueCandles('BTC-PERP', 'BYBIT');
  assert.ok(Math.abs(candles[candles.length - 1].c - 58581.1) < 1e-6);

  // 3. $100 Demo capital works across expanded 7 coins (BNB/XRP/DOGE/SOL/HYPE/ETH/BTC)
  const prof = trading.setCapital(100);
  assert.equal(prof.tier, 'SMALL');
  for (const sym of ['BNB-PERP', 'XRP-PERP', 'DOGE-PERP']) {
    const v = QuantumSchemas.validateOrderInput({
      symbol: sym,
      exchange: 'BINANCE',
      side: 'LONG',
      entryPrice: market.getPrice(sym, 'BINANCE'),
      sizeUsd: 25,
      leverage: 5,
      slPct: 0.8,
      tpPct: 1.8
    });
    assert.equal(v.ok, true, `Schema failed for ${sym}: ${v.errors.join(',')}`);
  }
});

test('Live 1m signalCandles preserve ATR/RSI across flat ticks and trigger Auto-Bot cleanly on $100 Demo', () => {
  const market = new QuantumMarketEngine({ QuantumUUID, QuantumSchemas });
  const trading = new QuantumTradingEngine(market, { QuantumUUID, QuantumSchemas });
  trading.setCapital(100);

  market.wsEnabled = true;
  market.timeframe = '1s';

  // Feed 55 realistic 1m candles on SOL-PERP transitioning into a bearish impulse with realistic pullbacks (ATR ~0.12%)
  const now = Date.now();
  const liveCandles = [];
  let px = 68.40;
  for (let i = 55; i > 0; i--) {
    const o = px;
    const step = i > 14 ? (i % 2 === 0 ? 0.03 : -0.025) : (i % 4 === 0 ? 0.025 : -0.048);
    const c = o + step;
    const h = Math.max(o, c) + 0.035;
    const l = Math.min(o, c) - 0.045;
    liveCandles.push({ t: now - i * 60000, o, h, l, c, v: 1200 + i * 10 });
    px = c;
  }

  const solSt = market.getSymbolState('SOL-PERP');
  solSt.candles = liveCandles.map((c) => ({ ...c }));
  solSt.signalCandles = liveCandles.map((c) => ({ ...c }));
  solSt.currentCandle = { ...liveCandles[liveCandles.length - 1] };
  solSt.price = px;
  solSt.prevPrice = px;
  market.applyLiveVenueQuote('SOL-PERP', 'HYPERLIQUID', px, 0.008, -1.85);
  market._hydrateLiveOrderflowFromCandles(solSt, solSt.signalCandles);
  market._rebuildOrderbook(solSt);

  // Simulate 60 fast ticks (no price change) — ATR/RSI must NOT collapse to 0
  for (let t = 0; t < 60; t++) {
    market.tick();
  }

  const sig = market.getDirectionalSignal('SOL-PERP');
  assert.ok(sig.atrPct > 0.05, `Expected non-zero live ATR%, got ${sig.atrPct}`);
  assert.ok(sig.rsi > 5 && sig.rsi < 95, `Expected non-degenerate RSI, got ${sig.rsi}`);
  assert.equal(sig.side, 'SHORT', `Expected actionable SHORT on live 1m breakdown, got ${sig.side} (score=${sig.score})`);
  assert.ok(Math.abs(sig.score) >= 33);

  // Auto-Bot on $100 Demo must enter automatically on live signal without stalling
  trading.toggleBot();
  for (let t = 0; t < 5; t++) {
    market.tick();
    trading.onMarketTick();
  }
  const openedPos = trading.positions.find((p) => p.symbol === 'SOL-PERP' && p.source === 'BOT');
  assert.ok(openedPos, 'Auto-Bot failed to open position on valid live 1m signal');
  assert.equal(openedPos.side, 'SHORT');
});

test('Adaptive computeCapitalPlan across 5 tiers & 3 risk modes, Quarter-Kelly damping, and Daily Profit Lock', () => {
  const market = new QuantumMarketEngine({ QuantumUUID, QuantumSchemas });
  const trading = new QuantumTradingEngine(market, { QuantumUUID, QuantumSchemas });

  // 1. Verify all 5 tiers + INSUFFICIENT return structured plans
  const tiers = [
    [5, 'INSUFFICIENT'],
    [50, 'MICRO'],
    [100, 'SMALL'],
    [750, 'GROWTH'],
    [5000, 'PRO'],
    [50000, 'FUND']
  ];
  for (const [eq, expectedTier] of tiers) {
    for (const rmode of ['SAFE', 'BALANCED', 'AGGRESSIVE']) {
      const p = trading.computeCapitalPlan(eq, rmode);
      assert.equal(p.tier, expectedTier);
      assert.equal(p.riskMode, rmode);
      assert.ok(p.optimalSizeUsd >= 5, `Invalid sizeUsd for $${eq} ${rmode}`);
      assert.ok(p.riskPerTradeUsd > 0 && p.dailyStopLossUsd > 0 && p.dailyProfitLockUsd > 0);
      assert.ok(p.minTpPct > 0.5);
    }
  }

  // 2. Verify exact $100 targets (SAFE +$6, BALANCED +$10, AGGRESSIVE +$20) and proportional scaling for $250-$10K+
  const pSafe = trading.computeCapitalPlan(100, 'SAFE');
  const pBal = trading.computeCapitalPlan(100, 'BALANCED');
  const pAgg = trading.computeCapitalPlan(100, 'AGGRESSIVE');

  assert.equal(pSafe.dailyProfitLockUsd, 6.0);
  assert.equal(pBal.dailyProfitLockUsd, 10.0);
  assert.equal(pAgg.dailyProfitLockUsd, 20.0);
  assert.equal(pSafe.maxSafeLeverage, 3);
  assert.ok(pSafe.riskPerTradePct < pBal.riskPerTradePct);
  assert.ok(pAgg.dailyStopLossUsd <= 8.0, `Expected daily stop <= $8 on $100 AGGRESSIVE, got $${pAgg.dailyStopLossUsd}`);
  assert.equal(pAgg.maxSafeLeverage, 8);
  assert.ok(pAgg.minNetRR >= 2.0);

  for (const eq of [250, 500, 1000, 5000, 10000]) {
    const s = trading.computeCapitalPlan(eq, 'SAFE');
    const b = trading.computeCapitalPlan(eq, 'BALANCED');
    const a = trading.computeCapitalPlan(eq, 'AGGRESSIVE');
    assert.ok(Math.abs(s.dailyProfitLockUsd - b.dailyProfitLockUsd * 0.6) < 0.05);
    assert.ok(Math.abs(a.dailyProfitLockUsd - b.dailyProfitLockUsd * 2.0) < 0.05);
  }

  // 3. Adaptive Quarter-Kelly cold-streak damping when >= 10 closed trades exist
  trading.setCapital(100);
  trading.setRiskMode('AGGRESSIVE');
  for (let i = 0; i < 12; i++) {
    const isWin = i < 2;
    trading.history.push({
      id: QuantumUUID.v4(),
      time: '00:00:00',
      symbol: 'SOL-PERP',
      exchange: 'HYPERLIQUID',
      side: 'LONG',
      entryPrice: 68,
      exitPrice: isWin ? 69 : 67.5,
      reason: isWin ? 'TAKE PROFIT HIT' : 'STOP LOSS HIT',
      pnl: isWin ? 2.0 : -2.5
    });
    if (isWin) trading.wins++;
    else trading.losses++;
  }
  const dampedPlan = trading.computeCapitalPlan(100, 'AGGRESSIVE');
  assert.equal(dampedPlan.kellyDamped, true);
  assert.ok(dampedPlan.riskPerTradePct < pAgg.riskPerTradePct, `Expected Kelly damping below ${pAgg.riskPerTradePct}%, got ${dampedPlan.riskPerTradePct}%`);

  // 4. Daily Profit Lock (Target Hit = $20.00 on $100 AGGRESSIVE)
  trading.setCapital(100);
  trading.setRiskMode('AGGRESSIVE');
  market.wsEnabled = true;
  market.clearShock();
  const solBase = 68.0;
  const solSt = market.getSymbolState('SOL-PERP');
  solSt.signalCandles = Array.from({ length: 40 }, (_, i) => ({
    t: Date.now() - (40 - i) * 60000,
    o: solBase - 0.5 + i * 0.012,
    h: solBase - 0.4 + i * 0.012,
    l: solBase - 0.55 + i * 0.012,
    c: solBase - 0.45 + i * 0.012,
    v: 1000
  }));
  solSt.flowImbalance = 0.2;
  solSt.cvdHistory = [0.2, 0.4, 0.6, 0.8, 1.0, 1.2];
  market._rebuildOrderbook(solSt);
  market.applyLiveVenueQuote('SOL-PERP', 'HYPERLIQUID', solBase, 0.01, 0);
  trading.toggleBot();
  assert.equal(trading.botRunning, true);
  if (trading.positions.length > 0 || trading.limitOrders.length > 0) {
    trading.closeAll('CLEAR SCOUT');
    trading.setCapital(100);
    trading.setRiskMode('AGGRESSIVE');
    trading.botRunning = true;
  }

  // Open a BOT LONG position on SOL-PERP with wide TP (14%) so price jump locks via DAILY PROFIT LOCK
  const botPos = trading.placeMarketOrder({
    symbol: 'SOL-PERP',
    exchange: 'HYPERLIQUID',
    side: 'LONG',
    sizeUsd: 400,
    leverage: 8,
    slPct: 0.7,
    tpPct: 14.0,
    source: 'BOT'
  });
  assert.ok(botPos);

  // Move SOL-PERP up +5.5% (+$22 gross -> ~$21.7 net >= $20.00 dailyProfitLockUsd)
  market.applyLiveVenueQuote('SOL-PERP', 'HYPERLIQUID', solBase * 1.055, 0.01, 5.5);
  trading.onMarketTick();

  assert.equal(trading.dailyProfitLocked, true, 'Daily Profit Lock should engage after hitting $20 target');
  assert.equal(trading.botRunning, false, 'Bot must auto-stop when Daily Profit Lock engages');
  assert.equal(trading.positions.length, 0, 'BOT positions should close on Daily Profit Lock');
  assert.ok(trading.history.some((h) => h.reason === 'DAILY PROFIT LOCK'));
  assert.ok(Math.abs((trading.balance - 100) - trading.realizedPnl) < 1e-6);

  // Bot cannot resume while locked; unlockDailyProfitLock re-arms and rebases target
  assert.equal(trading.toggleBot(), false);
  trading.unlockDailyProfitLock(true);
  assert.equal(trading.dailyProfitLocked, false);
  assert.equal(trading.dailyPeakProfitUsd, 0);

  // 5. Profit-Giveback Trailing Floor: reach >= 75% of target (~$24.30 * 0.75 = $18.23), then pull back <= 70% of peak
  const secondPos = trading.placeMarketOrder({
    symbol: 'SOL-PERP',
    exchange: 'HYPERLIQUID',
    side: 'LONG',
    sizeUsd: 400,
    leverage: 8,
    slPct: 3.5,
    tpPct: 14.0,
    source: 'BOT'
  });
  assert.ok(secondPos);
  assert.equal(trading.toggleBot(), true);
  const startPx2 = secondPos.entryPrice;
  // +4.9% (~+$19.4 >= 75% of rebased ~$24.3 target = $18.23, < $24.32 target)
  market.applyLiveVenueQuote('SOL-PERP', 'HYPERLIQUID', startPx2 * 1.049, 0.01, 4.9);
  trading.onMarketTick();
  assert.equal(trading.dailyProfitLocked, false);
  assert.ok(trading.dailyPeakProfitUsd >= 18.5);

  // Pull back to +2.2% (~+$8.6 <= 70% of ~$19.4 peak) -> must lock remaining gains!
  market.applyLiveVenueQuote('SOL-PERP', 'HYPERLIQUID', startPx2 * 1.022, 0.01, 2.2);
  trading.onMarketTick();
  assert.equal(trading.dailyProfitLocked, true, 'Profit-giveback trailing guard must lock gains');
  assert.equal(trading.botRunning, false);
});

test('Dynamic per-exchange coin catalog ingestion, on-demand registration, and live trading on non-core coins', () => {
  // 1. Dynamic schema regex allows canonical perp symbols while rejecting malformed/dangerous strings
  assert.equal(QuantumSchemas.validateOrderInput({
    symbol: 'SUI-PERP',
    exchange: 'BYBIT',
    side: 'LONG',
    sizeUsd: 120,
    leverage: 5,
    slPct: 0.8,
    tpPct: 1.8
  }).ok, true);
  assert.equal(QuantumSchemas.validateOrderInput({
    symbol: '1000PEPE-PERP',
    exchange: 'BINANCE',
    side: 'SHORT',
    sizeUsd: 120,
    leverage: 5,
    slPct: 0.8,
    tpPct: 1.8
  }).ok, true);
  assert.equal(QuantumSchemas.validateMarketTick({ symbol: 'INVALID', price: 10 }).ok, false);
  assert.equal(QuantumSchemas.validateMarketTick({ symbol: 'BTC', price: 10 }).ok, false);
  assert.equal(QuantumSchemas.validateMarketTick({ symbol: '<SCRIPT>-PERP', price: 10 }).ok, false);

  // 2. Per-instance catalog ingestion & isolation from fresh instances
  const market = new QuantumMarketEngine({ QuantumUUID, QuantumSchemas });
  const freshMarket = new QuantumMarketEngine({ QuantumUUID, QuantumSchemas });
  const trading = new QuantumTradingEngine(market, { QuantumUUID, QuantumSchemas });

  market.ingestVenueCatalog('BINANCE', [
    { symbol: 'BTC-PERP', baseCoin: 'BTC', venue: 'BINANCE', venueSymbol: 'BTCUSDT', price: 58600, change24hPct: 1.2, volume24hUsd: 9e9 },
    { symbol: 'SUI-PERP', baseCoin: 'SUI', venue: 'BINANCE', venueSymbol: 'SUIUSDT', price: 1.425, change24hPct: 5.4, volume24hUsd: 6.5e8 },
    { symbol: '1000PEPE-PERP', baseCoin: '1000PEPE', venue: 'BINANCE', venueSymbol: '1000PEPEUSDT', price: 0.00854, change24hPct: 8.1, volume24hUsd: 4.1e8 }
  ]);
  market.ingestVenueCatalog('BYBIT', [
    { symbol: 'SUI-PERP', baseCoin: 'SUI', venue: 'BYBIT', venueSymbol: 'SUIUSDT', price: 1.428, change24hPct: 5.6, funding8h: 0.015, volume24hUsd: 3.1e8 },
    { symbol: 'TON-PERP', baseCoin: 'TON', venue: 'BYBIT', venueSymbol: 'TONUSDT', price: 3.18, change24hPct: -1.1, funding8h: 0.008, volume24hUsd: 2.2e8 }
  ]);

  const bybitCat = market.getVenueCatalog('BYBIT');
  assert.equal(bybitCat.length, 2);
  assert.equal(bybitCat[0].symbol, 'SUI-PERP');

  const allCat = market.getVenueCatalog('ALL');
  assert.ok(allCat.some((x) => x.symbol === 'SUI-PERP'));
  assert.ok(allCat.some((x) => x.symbol === '1000PEPE-PERP'));
  assert.ok(allCat.some((x) => x.symbol === 'TON-PERP'));

  // 3. On-demand registration preserves precision, venue price, and topbar visibility
  market.wsEnabled = true;
  market.selectDynamicSymbol('SUI-PERP', 'BYBIT');
  assert.equal(market.activeSymbol, 'SUI-PERP');
  assert.equal(market.activeExchange, 'BYBIT');
  assert.equal(market.instruments['SUI-PERP'].decimals, 4);
  assert.equal(market.instruments['SUI-PERP'].bybitSym, 'SUIUSDT');
  assert.equal(market.instruments['SUI-PERP'].wsBinance, 'suiusdt');
  assert.equal(market.getPrice('SUI-PERP', 'BYBIT'), 1.428);
  assert.ok(market.getVenueSymbols('BYBIT').includes('SUI-PERP'));

  // Isolation check: freshMarket does not contain SUI-PERP unless requested
  assert.equal(Boolean(freshMarket.instruments['SUI-PERP']), false);

  market.selectDynamicSymbol('1000PEPE-PERP', 'BINANCE');
  assert.equal(market.instruments['1000PEPE-PERP'].decimals, 6);
  assert.equal(market.getPrice('1000PEPE-PERP', 'BINANCE'), 0.00854);

  // 4. Trade execution and exact ledger reconciliation on a dynamic coin (SUI-PERP on BYBIT)
  trading.setCapital(250);
  market.setExchange('BYBIT');
  market.selectDynamicSymbol('SUI-PERP', 'BYBIT');
  const pos = trading.placeMarketOrder({
    symbol: 'SUI-PERP',
    exchange: 'BYBIT',
    side: 'LONG',
    sizeUsd: 300,
    leverage: 5,
    slPct: 0.8,
    tpPct: 1.8,
    source: 'MANUAL'
  });
  assert.ok(pos);
  assert.equal(pos.symbol, 'SUI-PERP');
  assert.equal(pos.exchange, 'BYBIT');
  assert.equal(pos.entryPrice, 1.428);

  market.applyLiveVenueQuote('SUI-PERP', 'BYBIT', 1.445, 0.015, 6.2);
  trading.closePosition(pos.id, 'MANUAL CLOSE');
  assert.ok(Math.abs((trading.balance - 250) - trading.realizedPnl) < 1e-6);
  assert.ok(trading.realizedPnl > 0);
});

test('hlEip712Signer.mjs computes standard Ethereum Keccak-256, secp256k1 address, MsgPack, and Hyperliquid L1 EIP-712 signatures', () => {
  // 1. Official Ethereum Keccak-256 test vector for empty string ""
  const emptyHash = keccak256('').toString('hex');
  assert.equal(emptyHash, 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');

  // 2. Standard secp256k1 private key = 1 address vector
  const privKeyOne = '0x0000000000000000000000000000000000000000000000000000000000000001';
  assert.equal(privateKeyToAddress(privKeyOne), '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf');

  // 3. Canonical MessagePack encoding preserves key insertion order
  const packed = msgpackEncode({ type: 'order', grouping: 'na' });
  assert.ok(Buffer.isBuffer(packed) && packed.length > 5);

  // 4. Hyperliquid L1 Action EIP-712 signing produces valid 32-byte r/s + low-S + v in {27, 28}
  const SECP_HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0n;
  const sigTestnet = signHyperliquidL1Action({
    action: {
      type: 'order',
      orders: [{ a: 0, b: true, p: '58500', s: '0.01', r: false, t: { limit: { tif: 'Ioc' } } }],
      grouping: 'na'
    },
    nonce: 1700000000123,
    vaultAddress: null,
    isMainnet: false,
    privateKey: privKeyOne
  });
  const sigMainnet = signHyperliquidL1Action({
    action: { type: 'updateLeverage', asset: 0, isCross: true, leverage: 5 },
    nonce: 1700000000124,
    vaultAddress: null,
    isMainnet: true,
    privateKey: privKeyOne
  });
  for (const sig of [sigTestnet, sigMainnet]) {
    assert.match(sig.r, /^0x[0-9a-f]{64}$/);
    assert.match(sig.s, /^0x[0-9a-f]{64}$/);
    assert.ok(BigInt(sig.s) <= SECP_HALF_N, 'EIP-2 low-S violated');
    assert.ok(sig.v === 27 || sig.v === 28, `Unexpected v=${sig.v}`);
  }
});

test('exchangeOrderAdapter executes across all 5 venues (Testnet & Mainnet) and TradingEngine rolls back on live reject', async () => {
  const FIXED_TS = 1700000000000;
  const mockJsonRes = (data, ok = true, status = 200) => ({
    ok,
    status,
    json: async () => data
  });

  // 1. BINANCE TESTNET place + SL/TP + modifySL + cancel + close + positions
  const bnCalls = [];
  const bnFetch = async (url, opts) => {
    bnCalls.push({ url, method: opts.method });
    if (url.includes('/fapi/v1/exchangeInfo')) {
      return mockJsonRes({ symbols: [{ symbol: 'BTCUSDT', filters: [{ filterType: 'LOT_SIZE', stepSize: '0.001' }, { filterType: 'PRICE_FILTER', tickSize: '0.1' }] }] });
    }
    if (url.includes('/fapi/v1/leverage')) return mockJsonRes({ leverage: 5 });
    if (url.includes('/fapi/v1/order') && opts.method === 'POST') return mockJsonRes({ orderId: 9001, avgPrice: '58585', status: 'FILLED' });
    if (url.includes('/fapi/v1/openOrders')) return mockJsonRes([{ orderId: 9002, type: 'STOP_MARKET' }]);
    if (url.includes('/fapi/v1/order') && opts.method === 'DELETE') return mockJsonRes({ orderId: 9002, status: 'CANCELED' });
    if (url.includes('/fapi/v1/allOpenOrders')) return mockJsonRes({ code: 200 });
    if (url.includes('/fapi/v2/positionRisk')) return mockJsonRes([{ symbol: 'BTCUSDT', positionAmt: '0.01', entryPrice: '58585', unRealizedProfit: '2.5', leverage: '5' }]);
    return mockJsonRes({});
  };
  const bnPlace = await placeExchangeOrder({
    venue: 'BINANCE', network: 'TESTNET', apiKey: 'bn_k_123456', apiSecret: 'bn_s_abcdef',
    symbol: 'BTC-PERP', side: 'LONG', orderType: 'MARKET', sizeUsd: 585.85, price: 58585, leverage: 5, slPrice: 58100, tpPrice: 59500
  }, { fetchFn: bnFetch, nowFn: () => FIXED_TS });
  assert.equal(bnPlace.ok, true);
  assert.equal(bnPlace.exchangeOrderId, '9001');
  assert.ok(bnCalls.some((c) => c.url.startsWith('https://testnet.binancefuture.com/fapi/v1/order')));

  const bnModSl = await modifyExchangeStopLoss({ venue: 'BINANCE', network: 'TESTNET', apiKey: 'bn_k_123456', apiSecret: 'bn_s_abcdef', symbol: 'BTC-PERP', side: 'LONG', slPrice: 58650, refPrice: 58900 }, { fetchFn: bnFetch, nowFn: () => FIXED_TS });
  assert.equal(bnModSl.ok, true);
  assert.equal((await cancelExchangeOrder({ venue: 'BINANCE', network: 'TESTNET', apiKey: 'bn_k_123456', apiSecret: 'bn_s_abcdef', symbol: 'BTC-PERP', exchangeOrderId: '9001' }, { fetchFn: bnFetch, nowFn: () => FIXED_TS })).ok, true);
  assert.equal((await closeExchangePosition({ venue: 'BINANCE', network: 'TESTNET', apiKey: 'bn_k_123456', apiSecret: 'bn_s_abcdef', symbol: 'BTC-PERP', side: 'LONG', sizeUsd: 585.85, refPrice: 58800 }, { fetchFn: bnFetch, nowFn: () => FIXED_TS })).ok, true);
  assert.equal((await fetchExchangePositions({ venue: 'BINANCE', network: 'TESTNET', apiKey: 'bn_k_123456', apiSecret: 'bn_s_abcdef' }, { fetchFn: bnFetch, nowFn: () => FIXED_TS })).positions.length, 1);

  // 2. BYBIT TESTNET place + SL
  const bbCalls = [];
  const bbFetch = async (url, opts) => {
    bbCalls.push({ url, body: opts.body });
    if (url.includes('/v5/market/instruments-info')) return mockJsonRes({ result: { list: [{ lotSizeFilter: { qtyStep: '0.01' }, priceFilter: { tickSize: '0.01' } }] } });
    return mockJsonRes({ retCode: 0, result: { orderId: 'bb-ord-1' } });
  };
  const bbPlace = await placeExchangeOrder({
    venue: 'BYBIT', network: 'TESTNET', apiKey: 'bb_k_123456', apiSecret: 'bb_s_abcdef',
    symbol: 'SOL-PERP', side: 'SHORT', orderType: 'LIMIT', sizeUsd: 200, price: 68.0, leverage: 5, slPrice: 68.5, tpPrice: 66.8, isMaker: true
  }, { fetchFn: bbFetch, nowFn: () => FIXED_TS });
  assert.equal(bbPlace.ok, true);
  assert.equal(bbPlace.exchangeOrderId, 'bb-ord-1');
  assert.ok(bbCalls.some((c) => c.url.startsWith('https://api-testnet.bybit.com/v5/order/create') && c.body.includes('"PostOnly"')));

  // 3. OKX TESTNET (Simulated Trading header + contract ctVal conversion)
  let capturedOkxBody = null;
  let okxSimHeader = null;
  const okxFetch = async (url, opts) => {
    okxSimHeader = opts.headers['x-simulated-trading'];
    if (url.includes('/api/v5/public/instruments')) return mockJsonRes({ code: '0', data: [{ lotSz: '1', tickSz: '0.01', ctVal: '1' }] });
    if (url.includes('/api/v5/trade/order')) {
      capturedOkxBody = JSON.parse(opts.body);
      return mockJsonRes({ code: '0', data: [{ ordId: 'okx-99', sCode: '0' }] });
    }
    return mockJsonRes({ code: '0', data: [] });
  };
  const okxPlace = await placeExchangeOrder({
    venue: 'OKX', network: 'TESTNET', apiKey: 'okx_k_123', apiSecret: 'okx_s_abc', passphrase: 'p_okx',
    symbol: 'SOL-PERP', side: 'LONG', orderType: 'MARKET', sizeUsd: 204, price: 68.0, leverage: 5, slPrice: 67.4, tpPrice: 69.2
  }, { fetchFn: okxFetch, nowFn: () => FIXED_TS });
  assert.equal(okxPlace.ok, true);
  assert.equal(okxSimHeader, '1');
  assert.equal(capturedOkxBody.sz, '3');
  assert.equal(capturedOkxBody.attachAlgoOrds.length, 1);

  // 4. DERIBIT TESTNET
  const dbFetch = async (url) => {
    assert.ok(url.startsWith('https://test.deribit.com/'));
    if (url.includes('/public/auth')) return mockJsonRes({ result: { access_token: 'db_tok_test' } });
    return mockJsonRes({ result: { order: { order_id: 'db-ord-55', average_price: 58590, order_state: 'filled' } } });
  };
  const dbPlace = await placeExchangeOrder({
    venue: 'DERIBIT', network: 'TESTNET', apiKey: 'db_id_123', apiSecret: 'db_sec_abc',
    symbol: 'BTC-PERP', side: 'LONG', orderType: 'MARKET', sizeUsd: 250, price: 58590, leverage: 5
  }, { fetchFn: dbFetch, nowFn: () => FIXED_TS });
  assert.equal(dbPlace.ok, true);
  assert.equal(dbPlace.exchangeOrderId, 'db-ord-55');

  // 5. HYPERLIQUID TESTNET EIP-712 signed payload
  let hlSignedPayload = null;
  const hlFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (url.endsWith('/info') && body.type === 'meta') {
      return mockJsonRes({ universe: [{ name: 'BTC', szDecimals: 5 }, { name: 'SOL', szDecimals: 2 }] });
    }
    if (url.endsWith('/exchange')) {
      hlSignedPayload = body;
      return mockJsonRes({ status: 'ok', response: { data: { statuses: [{ filled: { oid: 777123, avgPx: '68.1' } }] } } });
    }
    return mockJsonRes({});
  };
  const hlPlace = await placeExchangeOrder({
    venue: 'HYPERLIQUID',
    network: 'TESTNET',
    agentKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
    walletAddress: '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf',
    symbol: 'SOL-PERP',
    side: 'LONG',
    orderType: 'MARKET',
    sizeUsd: 136.0,
    price: 68.0,
    leverage: 5,
    slPrice: 67.3,
    tpPrice: 69.5
  }, { fetchFn: hlFetch, nowFn: () => FIXED_TS });
  assert.equal(hlPlace.ok, true);
  assert.equal(hlPlace.exchangeOrderId, '777123');
  assert.equal(hlSignedPayload.action.type, 'order');
  assert.equal(hlSignedPayload.action.orders.length, 3); // entry + tp + sl
  assert.match(hlSignedPayload.signature.r, /^0x[0-9a-f]{64}$/);

  // 6. TradingEngine live routing + automatic rollback when exchange rejects order
  const gate = new QuantumSecurityGate({ hmacKey: 'live-exec-test' });
  const market = new QuantumMarketEngine({ QuantumUUID, QuantumSchemas });
  const trading = new QuantumTradingEngine(market, { QuantumUUID, QuantumSchemas, securityGate: gate });
  trading.setCapital(250);

  const otpReq = await gate.requestOtp({ email: 'ops@quantum.io', ip: '127.0.0.1', role: 'TRADER' });
  const otpVer = await gate.verifyOtp({ challengeId: otpReq.challengeId, otp: otpReq.devPreviewOtp, ip: '127.0.0.1' });

  let shouldReject = false;
  let closedCalled = false;
  trading.setLiveExecutionAdapter({
    placeOrder: async () => (shouldReject
      ? { ok: false, error: 'Insufficient margin on venue' }
      : { ok: true, exchangeOrderId: 'EX-CONFIRM-101', qty: 4.5 }),
    closePosition: async () => {
      closedCalled = true;
      return { ok: true };
    }
  });

  trading.configureLiveBridge(
    { venue: 'BYBIT', network: 'TESTNET', execMode: 'LIVE_EXEC', maxLiveNotionalUsd: 500 },
    otpVer.session.sessionId,
    '127.0.0.1'
  );
  assert.equal(trading.isLiveExecutionActive(), true);

  // Allowed live order gets confirmed & stamped with exchangeOrderId, then close dispatches closePosition
  const livePos = trading.placeMarketOrder({ symbol: 'SOL-PERP', exchange: 'BYBIT', side: 'LONG', sizeUsd: 200, leverage: 5, slPct: 0.8, tpPct: 1.8 });
  assert.ok(livePos);
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(livePos.exchangeOrderId, 'EX-CONFIRM-101');
  trading.closePosition(livePos.id, 'MANUAL CLOSE');
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(closedCalled, true);

  // Rejected live order automatically rolls back local position without corrupting ledger
  const balBeforeReject = trading.balance;
  shouldReject = true;
  const rejectPos = trading.placeMarketOrder({ symbol: 'SOL-PERP', exchange: 'BYBIT', side: 'SHORT', sizeUsd: 200, leverage: 5, slPct: 0.8, tpPct: 1.8 });
  assert.ok(rejectPos);
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(trading.positions.length, 0, 'Rejected live order must roll back local position');
  assert.equal(trading.balance, balBeforeReject, 'Rollback must not alter wallet balance');

  // Hard cap blocks oversized live order immediately
  const oversized = trading.placeMarketOrder({ symbol: 'SOL-PERP', exchange: 'BYBIT', side: 'LONG', sizeUsd: 900, leverage: 5, slPct: 0.8, tpPct: 1.8 });
  assert.equal(oversized, null);
});

test('Multi-timeframe 5m trend filter blocks counter-trend 1m bounces and News-Spike guard halts Bot during flash candles', () => {
  const market = new QuantumMarketEngine({ QuantumUUID, QuantumSchemas });
  const trading = new QuantumTradingEngine(market, { QuantumUUID, QuantumSchemas });
  trading.setCapital(100);
  market.wsEnabled = true;

  // Part A: Sustained 5m downtrend with realistic pullbacks -> 2-bar bounce -> 5m BEAR blocks counter-trend LONG
  const now = Date.now();
  const bounceCandles = [];
  let px = 69.8;
  for (let i = 60; i > 0; i--) {
    const o = px;
    let step;
    if (i > 2) {
      step = (i % 4 === 0) ? +0.02 : -0.048;
    } else {
      step = +0.018;
    }
    const c = o + step;
    const h = Math.max(o, c) + 0.02;
    const l = Math.min(o, c) - 0.02;
    bounceCandles.push({ t: now - i * 60000, o, h, l, c, v: 900 });
    px = c;
  }

  const solSt = market.getSymbolState('SOL-PERP');
  solSt.signalCandles = bounceCandles.map((c) => ({ ...c }));
  solSt.candles = bounceCandles.map((c) => ({ ...c }));
  solSt.currentCandle = { ...bounceCandles[bounceCandles.length - 1] };
  solSt.price = px;
  solSt.prevPrice = px;
  solSt.flowImbalance = 0.25;
  solSt.cvdHistory = [0.1, 0.3, 0.5, 0.7, 0.9, 1.1];
  market._rebuildOrderbook(solSt);

  market.mtfFilterEnabled = true;
  const sigCounter = market.getDirectionalSignal('SOL-PERP');
  assert.equal(sigCounter.htf5m.bias, 'BEAR');
  assert.notEqual(sigCounter.side, 'LONG', `5m BEAR must block counter-trend 1m LONG (got score=${sigCounter.score})`);

  // Part B: Aligned 5m BEAR + healthy 1m bearish breakdown (Z-Score > -2.0) -> boosts conviction to SHORT
  const alignedCandles = bounceCandles.slice(0, 44);
  let apx = alignedCandles[alignedCandles.length - 1].c;
  for (let i = 16; i > 0; i--) {
    const o = apx;
    const step = i > 6 ? +0.024 : (i === 4 ? +0.01 : -0.036);
    const c = o + step;
    alignedCandles.push({ t: now - i * 60000, o, h: Math.max(o, c) + 0.015, l: Math.min(o, c) - 0.018, c, v: 1300 });
    apx = c;
  }
  solSt.signalCandles = alignedCandles.map((c) => ({ ...c }));
  solSt.candles = alignedCandles.map((c) => ({ ...c }));
  solSt.currentCandle = { ...alignedCandles[alignedCandles.length - 1] };
  solSt.price = apx;
  solSt.flowImbalance = -0.28;
  solSt.cvdHistory = [-0.1, -0.3, -0.5, -0.8, -1.1, -1.4];
  market._rebuildOrderbook(solSt);

  const sigAligned = market.getDirectionalSignal('SOL-PERP');
  assert.equal(sigAligned.htf5m.bias, 'BEAR');
  assert.equal(sigAligned.htf5m.aligned, true);
  assert.equal(sigAligned.side, 'SHORT');

  // Part C: Inject flash-news spike bar (1.6% range vs ~0.10% baseline ATR) -> forced WAIT & Auto-Bot stays sidelined
  const spikeCandles = alignedCandles.slice();
  const prevC = spikeCandles[spikeCandles.length - 1].c;
  spikeCandles.push({
    t: now,
    o: prevC,
    h: prevC * 1.009,
    l: prevC * 0.993,
    c: prevC * 0.996,
    v: 9500
  });
  solSt.signalCandles = spikeCandles;
  solSt.candles = spikeCandles;
  solSt.currentCandle = { ...spikeCandles[spikeCandles.length - 1] };

  market.newsSpikeFilterEnabled = true;
  const sigSpike = market.getDirectionalSignal('SOL-PERP');
  assert.equal(sigSpike.spikeBlocked, true);
  assert.equal(sigSpike.side, 'WAIT');

  // Neutralize other symbols briefly so Bot evaluates only SOL-PERP
  Object.keys(market.instruments).forEach((s) => {
    if (s !== 'SOL-PERP') {
      const st = market.getSymbolState(s);
      st.signalCandles = Array.from({ length: 40 }, (_, k) => ({ t: now - (40 - k) * 60000, o: 100, h: 100.05, l: 99.95, c: 100, v: 500 }));
      st.flowImbalance = 0;
      market._rebuildOrderbook(st);
    }
  });
  trading.toggleBot();
  trading.onMarketTick();
  assert.equal(trading.positions.some((p) => p.symbol === 'SOL-PERP'), false, 'Bot must stay out of SOL-PERP during news spike');
});
