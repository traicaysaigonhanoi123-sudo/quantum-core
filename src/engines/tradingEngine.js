/* ==========================================================================
   QUANTUM CORE // Trading, Risk Shield, Auto-Bot & Zero-Trust Gate Engine (UMD)
   - UUID v4 identifiers everywhere (Orders, Positions, History, Logs, Hedges)
   - DTO-sanitized public accessors (never leaks secrets)
   - Institutional Risk Shield (+EV sizing, Post-Only Maker, Auto-BE, Trailing)
   - Zero-Trust 2FA Gate check on configureLiveBridge & Session Revocation
   ========================================================================== */

(function (root, factory) {
  let uuidMod = root?.QuantumUUID;
  let schemaMod = root?.QuantumSchemas;
  let gateMod = root?.QuantumSecurityGate;
  if (typeof require === 'function') {
    try { uuidMod = uuidMod || require('../core/uuid.js'); } catch (_) {}
    try { schemaMod = schemaMod || require('../core/schemas.js'); } catch (_) {}
    try { gateMod = gateMod || require('../core/securityGate.js'); } catch (_) {}
  }
  const TradingEngine = factory(uuidMod, schemaMod, gateMod);
  if (typeof module === 'object' && module.exports) {
    module.exports = TradingEngine;
  }
  if (root) {
    root.QuantumTradingEngine = TradingEngine;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function (QuantumUUID, QuantumSchemas, QuantumSecurityGate) {
  'use strict';

  const INITIAL_BALANCE = 100000;

  class TradingEngine {
    constructor(marketEngine, deps = {}) {
      this.market = marketEngine;
      this._uuid = deps.QuantumUUID || QuantumUUID;
      this._schemas = deps.QuantumSchemas || QuantumSchemas;
      this.securityGate = deps.securityGate || (QuantumSecurityGate ? new QuantumSecurityGate() : null);

      this.mode = 'DEMO'; // 'DEMO' | 'LIVE'

      this.initialCapital = INITIAL_BALANCE;
      this.demoCapitalBackup = INITIAL_BALANCE;
      this.liveSyncedBalance = null;
      this.liveSyncedFreeMargin = null;
      this.balance = INITIAL_BALANCE;
      this.peakEquity = INITIAL_BALANCE;
      this.realizedPnl = 0;
      this.equityHistory = Array.from({ length: 48 }, () => INITIAL_BALANCE);

      this.positions = [];
      this.limitOrders = [];
      this.history = [];
      this.logs = [];

      this.wins = 0;
      this.losses = 0;

      // Bot State
      this.botRunning = false;
      this.botStrategy = 'MOMENTUM';
      this.botDirectionMode = 'AUTO'; // 'AUTO' | 'LONG_ONLY' | 'SHORT_ONLY' | 'HEDGE'
      this.botCooldown = 0;
      this.tickCounter = 0;
      this.lastClosedMap = {};

      // Adaptive Capital Plan & Daily Profit Lock
      this.riskMode = 'BALANCED'; // 'SAFE' | 'BALANCED' | 'AGGRESSIVE'
      this.dailyProfitLockEnabled = true;
      this.dailyProfitLocked = false;
      this.dailyProfitLockReason = '';
      this.dailyStartEquity = INITIAL_BALANCE;
      this.dailyPeakProfitUsd = 0;

      // Circuit Breaker State
      this.breakerTripped = false;
      this.breakerReason = '';
      this.maxDrawdownPct = 2.0;
      this.maxShockSigma = 2.2;
      this.autoFlattenOnBreak = true;

      // Institutional Risk Shield (+EV & Capital Preservation)
      this.riskShield = {
        enabled: true,
        autoSizeEnabled: true,
        riskPerTradePct: 0.5,
        dailyMaxLossPct: 2.0,
        maxSafeLeverage: 5,
        postOnlyMaker: true,
        autoBreakeven: true,
        autoTrailing: true,
        minNetRR: 1.5,
        consecutiveLosses: 0,
        cooldownUntil: 0,
        cooldownTicks: 0
      };

      // Live API / Hyperliquid DEX In-Memory Config (NEVER persisted to disk/localStorage)
      this.liveExecutionAdapter = deps.liveExecutionAdapter || null;
      this.liveConfig = {
        connected: false,
        venue: null,
        network: 'TESTNET',
        execMode: 'SHADOW', // 'SHADOW' | 'LIVE_EXEC'
        maxLiveNotionalUsd: 500,
        walletAddress: '',
        apiKeyMasked: '',
        sessionId: null
      };

      this.listeners = [];
      this._log('SYS', 'Khởi tạo ví Demo $100,000.00 USDC. Risk Shield (0.5%/lệnh, UUID v4, Zero-Trust Gate) đã sẵn sàng.');
    }

    on(fn) {
      this.listeners.push(fn);
    }

    _emit(type, payload) {
      for (let i = 0; i < this.listeners.length; i++) {
        this.listeners[i](type, payload);
      }
    }

    _log(tag, msg) {
      const id = this._uuid ? this._uuid.v4() : String(Date.now());
      const time = new Date().toISOString().substr(11, 8);
      this.logs.unshift({ id, time, tag, msg });
      if (this.logs.length > 80) this.logs.pop();
      this._emit('log', { id, time, tag, msg });
    }

    getPublicPositions() {
      return this._schemas ? this.positions.map((p) => this._schemas.toPositionPublicDTO(p)) : this.positions;
    }

    getPublicOrders() {
      return this._schemas ? this.limitOrders.map((o) => this._schemas.toOrderPublicDTO(o)) : this.limitOrders;
    }

    getPublicHistory() {
      return this._schemas ? this.history.map((h) => this._schemas.toHistoryPublicDTO(h)) : this.history;
    }

    computeCapitalPlan(equityOverride, riskModeOverride, marketCtx = {}) {
      const eq = Math.max(0, Number.isFinite(equityOverride) ? equityOverride : (this.balance || this.initialCapital));
      const mode = ['SAFE', 'BALANCED', 'AGGRESSIVE'].includes(riskModeOverride) ? riskModeOverride : this.riskMode;

      let base;
      if (eq < 10) {
        base = {
          tier: 'INSUFFICIENT',
          label: `VỐN THỰC ($${eq.toFixed(2)})`,
          riskPerTradePct: 1.8,
          maxSafeLeverage: 5,
          maxDrawdownPct: 5.0,
          dailyProfitLockPct: 10.0,
          minNotionalUsd: 5,
          marginUsageCap: 0.70,
          maxConcurrentDirectional: 1,
          minSignalScore: 36,
          minNetRR: 1.6,
          preferredSymbols: ['SOL-PERP', 'HYPE-PERP', 'ETH-PERP', 'BTC-PERP'],
          arbTotalNotional: 12
        };
      } else if (eq < 100) {
        base = {
          tier: 'MICRO',
          label: 'MICRO ($10–$100)',
          riskPerTradePct: 1.8,
          maxSafeLeverage: 5,
          maxDrawdownPct: 5.0,
          dailyProfitLockPct: 12.0,
          minNotionalUsd: 6,
          marginUsageCap: 0.70,
          maxConcurrentDirectional: 1,
          minSignalScore: 36,
          minNetRR: 1.6,
          preferredSymbols: ['SOL-PERP', 'HYPE-PERP', 'ETH-PERP', 'BTC-PERP'],
          arbTotalNotional: Math.max(12, Math.floor(eq * 1.5))
        };
      } else if (eq < 500) {
        base = {
          tier: 'SMALL',
          label: 'SMALL ($100–$500)',
          riskPerTradePct: 1.0,
          maxSafeLeverage: 5,
          maxDrawdownPct: 3.0,
          dailyProfitLockPct: 10.0,
          minNotionalUsd: 10,
          marginUsageCap: 0.85,
          maxConcurrentDirectional: 2,
          minSignalScore: 33,
          minNetRR: 1.5,
          preferredSymbols: ['BTC-PERP', 'ETH-PERP', 'SOL-PERP', 'HYPE-PERP', 'BNB-PERP', 'XRP-PERP', 'DOGE-PERP'],
          arbTotalNotional: Math.max(60, Math.floor(eq * 1.4))
        };
      } else if (eq < 2000) {
        base = {
          tier: 'GROWTH',
          label: 'GROWTH ($500–$2K)',
          riskPerTradePct: 0.85,
          maxSafeLeverage: 5,
          maxDrawdownPct: 2.5,
          dailyProfitLockPct: 8.0,
          minNotionalUsd: 15,
          marginUsageCap: 0.85,
          maxConcurrentDirectional: 2,
          minSignalScore: 33,
          minNetRR: 1.5,
          preferredSymbols: ['BTC-PERP', 'ETH-PERP', 'SOL-PERP', 'HYPE-PERP', 'BNB-PERP', 'XRP-PERP', 'DOGE-PERP'],
          arbTotalNotional: Math.max(250, Math.floor(eq * 1.3))
        };
      } else if (eq < 10000) {
        base = {
          tier: 'PRO',
          label: 'PRO ($2K–$10K)',
          riskPerTradePct: 0.65,
          maxSafeLeverage: 5,
          maxDrawdownPct: 2.2,
          dailyProfitLockPct: 5.0,
          minNotionalUsd: 25,
          marginUsageCap: 0.85,
          maxConcurrentDirectional: 2,
          minSignalScore: 32,
          minNetRR: 1.5,
          preferredSymbols: ['BTC-PERP', 'ETH-PERP', 'SOL-PERP', 'HYPE-PERP', 'BNB-PERP', 'XRP-PERP', 'DOGE-PERP'],
          arbTotalNotional: Math.min(8000, Math.floor(eq * 1.1))
        };
      } else {
        base = {
          tier: 'FUND',
          label: 'PRO QUANT ($10K+)',
          riskPerTradePct: 0.5,
          maxSafeLeverage: 5,
          maxDrawdownPct: 2.0,
          dailyProfitLockPct: 3.0,
          minNotionalUsd: 25,
          marginUsageCap: 0.85,
          maxConcurrentDirectional: 2,
          minSignalScore: 32,
          minNetRR: 1.5,
          preferredSymbols: ['BTC-PERP', 'ETH-PERP', 'SOL-PERP', 'HYPE-PERP', 'BNB-PERP', 'XRP-PERP', 'DOGE-PERP'],
          arbTotalNotional: Math.min(10000, Math.max(500, Math.floor(eq * 1.0)))
        };
      }

      let riskPerTradePct = base.riskPerTradePct;
      let maxSafeLeverage = base.maxSafeLeverage;
      let maxDrawdownPct = base.maxDrawdownPct;
      let dailyProfitLockPct = base.dailyProfitLockPct;
      let minSignalScore = base.minSignalScore;
      let minNetRR = base.minNetRR;
      let tpMultiplier = 2.15;
      let riskModeLabel = 'CÂN BẰNG';

      if (mode === 'SAFE') {
        riskPerTradePct = Number((base.riskPerTradePct * 0.6).toFixed(2));
        maxSafeLeverage = Math.min(base.maxSafeLeverage, 3);
        maxDrawdownPct = Number((base.maxDrawdownPct * 0.7).toFixed(2));
        dailyProfitLockPct = Number((base.dailyProfitLockPct * 0.6).toFixed(2));
        minSignalScore = base.minSignalScore + 4;
        minNetRR = Number((base.minNetRR + 0.25).toFixed(2));
        tpMultiplier = 2.0;
        riskModeLabel = 'AN TOÀN';
      } else if (mode === 'AGGRESSIVE') {
        const aggMap = {
          INSUFFICIENT: { riskPerTradePct: 2.4, maxSafeLeverage: 5, maxDrawdownPct: 7.0, dailyProfitLockPct: 20.0, minSignalScore: 34, minNetRR: 1.9, tpMultiplier: 2.35 },
          MICRO: { riskPerTradePct: 2.6, maxSafeLeverage: 6, maxDrawdownPct: 8.0, dailyProfitLockPct: 24.0, minSignalScore: 34, minNetRR: 1.9, tpMultiplier: 2.35 },
          SMALL: { riskPerTradePct: 2.5, maxSafeLeverage: 8, maxDrawdownPct: 7.0, dailyProfitLockPct: 20.0, minSignalScore: 31, minNetRR: 2.0, tpMultiplier: 2.40 },
          GROWTH: { riskPerTradePct: 1.6, maxSafeLeverage: 8, maxDrawdownPct: 5.5, dailyProfitLockPct: 16.0, minSignalScore: 31, minNetRR: 1.9, tpMultiplier: 2.35 },
          PRO: { riskPerTradePct: 1.05, maxSafeLeverage: 6, maxDrawdownPct: 4.0, dailyProfitLockPct: 10.0, minSignalScore: 30, minNetRR: 1.8, tpMultiplier: 2.30 },
          FUND: { riskPerTradePct: 0.75, maxSafeLeverage: 5, maxDrawdownPct: 3.0, dailyProfitLockPct: 6.0, minSignalScore: 30, minNetRR: 1.7, tpMultiplier: 2.25 }
        };
        const ov = aggMap[base.tier] || aggMap.FUND;
        riskPerTradePct = ov.riskPerTradePct;
        maxSafeLeverage = ov.maxSafeLeverage;
        maxDrawdownPct = ov.maxDrawdownPct;
        dailyProfitLockPct = ov.dailyProfitLockPct;
        minSignalScore = ov.minSignalScore;
        minNetRR = ov.minNetRR;
        tpMultiplier = ov.tpMultiplier;
        riskModeLabel = 'SĂN MỤC TIÊU';
      }

      // Adaptive Quarter-Kelly drawdown damper when sample size >= 10 closed trades
      let kellyDamped = false;
      let quarterKellyPct = riskPerTradePct;
      if ((this.wins + this.losses) >= 10 && this.history.length >= 10) {
        const sample = this.history.slice(0, 30);
        const winItems = sample.filter((h) => h.pnl > 0);
        const lossItems = sample.filter((h) => h.pnl < 0);
        const winRate = winItems.length / sample.length;
        if (lossItems.length > 0) {
          const avgWin = winItems.length > 0
            ? winItems.reduce((a, h) => a + h.pnl, 0) / winItems.length
            : 0;
          const avgLoss = lossItems.reduce((a, h) => a + Math.abs(h.pnl), 0) / lossItems.length;
          const payoffRatio = avgWin / Math.max(0.01, avgLoss);
          const fullKellyPct = ((winRate * payoffRatio - (1 - winRate)) / Math.max(0.1, payoffRatio)) * 100;
          quarterKellyPct = Number(Math.max(0.35, Math.min(3.5, fullKellyPct * 0.25)).toFixed(2));
          if (quarterKellyPct < riskPerTradePct) {
            riskPerTradePct = Number(Math.max(riskPerTradePct * 0.5, quarterKellyPct).toFixed(2));
            kellyDamped = true;
          }
        }
      }

      const sym = marketCtx.symbol || this.market.activeSymbol || 'BTC-PERP';
      const ex = (marketCtx.exchange && marketCtx.exchange !== 'ALL')
        ? marketCtx.exchange
        : this.getPreferredVenue('HYPERLIQUID');
      const isMaker = Boolean(marketCtx.isMaker);
      const slPct = Math.max(0.2, Number(marketCtx.slPct) || 0.65);

      const entryFeeBps = this.market.getVenueFeeBps(ex, isMaker);
      const exitFeeBps = this.market.getVenueFeeBps(ex, false);
      const slipBps = isMaker ? 0.3 : this.market.estimateSlippageBps(sym, Math.min(5000, Math.max(100, eq * maxSafeLeverage)));
      const roundTripCostPct = (entryFeeBps + exitFeeBps + slipBps) / 100;

      const safeEq = Math.max(10, eq);
      const riskPerTradeUsd = Number(((safeEq * riskPerTradePct) / 100).toFixed(2));
      const rawSize = riskPerTradeUsd / Math.max(0.001, (slPct + roundTripCostPct) / 100);
      const maxNotionalByMargin = safeEq * maxSafeLeverage * base.marginUsageCap;
      const clampedSize = Math.max(
        Math.min(base.minNotionalUsd, maxNotionalByMargin),
        Math.min(rawSize, maxNotionalByMargin)
      );
      const optimalSizeUsd = safeEq < 500 ? Number(clampedSize.toFixed(1)) : Math.floor(clampedSize);

      const minTpPct = Number((((slPct + roundTripCostPct) * minNetRR) + roundTripCostPct + 0.05).toFixed(2));
      const recommendedTpPct = Number(Math.max(minTpPct, slPct * tpMultiplier).toFixed(2));
      const dailyStopLossUsd = Number(((safeEq * maxDrawdownPct) / 100).toFixed(2));
      const dailyProfitLockUsd = Number(((safeEq * dailyProfitLockPct) / 100).toFixed(2));
      const profitTrailingTriggerUsd = Number((dailyProfitLockUsd * 0.75).toFixed(2));
      const profitTrailingFloorPct = 0.70;

      const guide = eq < 10
        ? 'Số dư < $10 USDC — Cần nạp tối thiểu $10 trên sàn để giao dịch an toàn'
        : `${riskModeLabel} • Tối đa ${base.maxConcurrentDirectional} lệnh (${maxSafeLeverage}x) • Rủi ro ${riskPerTradePct}% ($${riskPerTradeUsd.toFixed(2)}) • Chốt ngày +$${dailyProfitLockUsd.toFixed(2)} / Dừng lỗ -$${dailyStopLossUsd.toFixed(2)}`;

      return {
        tier: base.tier,
        label: base.label,
        riskMode: mode,
        riskModeLabel,
        equityUsd: eq,
        riskPerTradePct,
        riskPerTradeUsd,
        maxSafeLeverage,
        maxDrawdownPct,
        dailyStopLossUsd,
        dailyProfitLockPct,
        dailyProfitLockUsd,
        profitTrailingTriggerUsd,
        profitTrailingFloorPct,
        minNotionalUsd: base.minNotionalUsd,
        marginUsageCap: base.marginUsageCap,
        maxConcurrentDirectional: base.maxConcurrentDirectional,
        minSignalScore,
        minNetRR,
        minTpPct,
        recommendedTpPct,
        optimalSizeUsd,
        quarterKellyPct,
        kellyDamped,
        preferredSymbols: base.preferredSymbols,
        arbTotalNotional: base.arbTotalNotional,
        guide
      };
    }

    getCapitalProfile(equityOverride) {
      return this.computeCapitalPlan(equityOverride);
    }

    _syncRiskToCapitalProfile(eq) {
      const p = this.computeCapitalPlan(eq);
      this.riskShield.riskPerTradePct = p.riskPerTradePct;
      this.riskShield.maxSafeLeverage = p.maxSafeLeverage;
      this.riskShield.minNetRR = p.minNetRR;
      this.maxDrawdownPct = p.maxDrawdownPct;
      return p;
    }

    setRiskMode(mode) {
      const normalized = String(mode || '').toUpperCase();
      if (!['SAFE', 'BALANCED', 'AGGRESSIVE'].includes(normalized)) return this.computeCapitalPlan();
      this.riskMode = normalized;
      const eq = this.positions.length > 0 ? this.getMetrics().equity : (this.balance || this.initialCapital);
      const plan = this._syncRiskToCapitalProfile(eq);
      this._log('SHIELD', `Chuyển chế độ rủi ro [${plan.riskModeLabel}]: Risk ${plan.riskPerTradePct}% ($${plan.riskPerTradeUsd}/lệnh), Đòn bẩy max ${plan.maxSafeLeverage}x, Khóa lãi ngày +$${plan.dailyProfitLockUsd.toFixed(2)} / Cắt lỗ ngày -$${plan.dailyStopLossUsd.toFixed(2)}.`);
      this._emit('toast', {
        type: normalized === 'AGGRESSIVE' ? 'gold' : 'cyan',
        title: `CHẾ ĐỘ RỦI RO: ${plan.riskModeLabel}`,
        msg: `Risk ${plan.riskPerTradePct}%/lệnh (${plan.maxSafeLeverage}x) • Mục tiêu +$${plan.dailyProfitLockUsd.toFixed(2)} / Cắt lỗ -$${plan.dailyStopLossUsd.toFixed(2)}`
      });
      this._emit('updated');
      return plan;
    }

    setDailyProfitLockEnabled(enabled) {
      this.dailyProfitLockEnabled = Boolean(enabled);
      this._log('SHIELD', this.dailyProfitLockEnabled
        ? 'Đã BẬT Daily Profit Lock (tự khóa lãi & tạm dừng Bot khi đạt mục tiêu ngày).'
        : 'Đã TẮT Daily Profit Lock (Bot tiếp tục chạy qua mục tiêu ngày).');
      this._emit('updated');
      return this.dailyProfitLockEnabled;
    }

    unlockDailyProfitLock(rebaseDailyTarget = true) {
      this.dailyProfitLocked = false;
      this.dailyProfitLockReason = '';
      if (rebaseDailyTarget) {
        const metrics = this.getMetrics();
        this.dailyStartEquity = metrics.equity;
        this.dailyPeakProfitUsd = 0;
      }
      this._log('SHIELD', '🔓 Đã mở khóa Daily Profit Lock — Làm mới mốc mục tiêu lãi cho phiên giao dịch tiếp theo.');
      this._emit('toast', {
        type: 'cyan',
        title: 'ĐÃ MỞ KHÓA DAILY PROFIT LOCK',
        msg: 'Đã đặt lại mốc lãi phiên mới. Có thể bật lại Bot nếu muốn giao dịch tiếp.'
      });
      this._emit('updated');
      return true;
    }

    setCapital(amountUsd) {
      const cap = Math.max(10, Math.min(10000000, Number(amountUsd) || INITIAL_BALANCE));
      this.initialCapital = cap;
      if (this.mode === 'DEMO') {
        this.demoCapitalBackup = cap;
      }
      this.balance = cap;
      this.peakEquity = cap;
      this.realizedPnl = 0;
      this.dailyStartEquity = cap;
      this.dailyPeakProfitUsd = 0;
      this.dailyProfitLocked = false;
      this.dailyProfitLockReason = '';
      this.positions = [];
      this.limitOrders = [];
      this.history = [];
      this.wins = 0;
      this.losses = 0;
      this.tickCounter = 0;
      this.lastClosedMap = {};
      this.riskShield.consecutiveLosses = 0;
      this.riskShield.cooldownUntil = 0;
      this.riskShield.cooldownTicks = 0;
      this.equityHistory = Array.from({ length: 48 }, () => cap);
      const prof = this._syncRiskToCapitalProfile(cap);
      this.resetCircuitBreaker(true);
      this._log('SYS', `Đã đặt vốn tài khoản $${cap.toLocaleString('en-US')} USDC [${prof.label}] — ${prof.guide}`);
      this._emit('updated');
      return prof;
    }

    _normalizeVenueId(raw) {
      if (!raw || typeof raw !== 'string') return null;
      const u = raw.toUpperCase();
      if (u.includes('HYPERLIQUID')) return 'HYPERLIQUID';
      if (u.includes('BINANCE')) return 'BINANCE';
      if (u.includes('BYBIT')) return 'BYBIT';
      if (u.includes('OKX')) return 'OKX';
      if (u.includes('DERIBIT')) return 'DERIBIT';
      return null;
    }

    getPreferredVenue(fallback = 'HYPERLIQUID') {
      if (this.liveConfig.connected && this.liveConfig.venueId) {
        return this.liveConfig.venueId;
      }
      if (this.market.activeExchange && this.market.activeExchange !== 'ALL') {
        return this.market.activeExchange;
      }
      return fallback;
    }

    resetDemo() {
      const cap = this.initialCapital || INITIAL_BALANCE;
      this.balance = cap;
      this.peakEquity = cap;
      this.realizedPnl = 0;
      this.dailyStartEquity = cap;
      this.dailyPeakProfitUsd = 0;
      this.dailyProfitLocked = false;
      this.dailyProfitLockReason = '';
      this.positions = [];
      this.limitOrders = [];
      this.history = [];
      this.wins = 0;
      this.losses = 0;
      this.riskShield.consecutiveLosses = 0;
      this.riskShield.cooldownUntil = 0;
      this.riskShield.cooldownTicks = 0;
      this.tickCounter = 0;
      this.lastClosedMap = {};
      this.equityHistory = Array.from({ length: 48 }, () => cap);
      this._syncRiskToCapitalProfile(cap);
      this.resetCircuitBreaker(true);
      this._log('SYS', `Đã reset ví Demo về $${cap.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC & xóa toàn bộ vị thế.`);
      this._emit('updated');
    }

    syncLiveAccountBalance({ equityUsd, freeMarginUsd, venue } = {}) {
      const eq = Math.max(0, Number(equityUsd) || 0);
      const free = Number.isFinite(Number(freeMarginUsd)) ? Math.max(0, Number(freeMarginUsd)) : eq;
      const wasSynced = this.liveSyncedBalance !== null;
      if (!wasSynced) {
        this.demoCapitalBackup = this.initialCapital || this.demoCapitalBackup || INITIAL_BALANCE;
      }

      this.liveSyncedBalance = eq;
      this.liveSyncedFreeMargin = free;
      this.initialCapital = Math.max(0.01, eq);
      this.balance = eq;

      if (!wasSynced) {
        this.peakEquity = eq;
        this.realizedPnl = 0;
        this.dailyStartEquity = eq;
        this.dailyPeakProfitUsd = 0;
        this.dailyProfitLocked = false;
        this.dailyProfitLockReason = '';
        this.positions = [];
        this.limitOrders = [];
        this.history = [];
        this.wins = 0;
        this.losses = 0;
        this.tickCounter = 0;
        this.lastClosedMap = {};
        this.equityHistory = Array.from({ length: 48 }, () => eq);
        this.resetCircuitBreaker(true);
      } else {
        if (eq > this.peakEquity) this.peakEquity = eq;
      }

      const prof = this._syncRiskToCapitalProfile(Math.max(10, eq));
      const venueTag = venue || this.getPreferredVenue('LIVE');
      this._log('SYS', `[LIVE SYNC] Đã đồng bộ số dư thực từ ${venueTag}: Equity $${eq.toFixed(2)} USDC (Khả dụng: $${free.toFixed(2)} USDC) — ${prof.label}`);
      this._emit('updated');
      return prof;
    }

    setMode(mode) {
      if (mode === 'LIVE' && !this.liveConfig.connected) {
        this._emit('toast', { type: 'neg', title: 'CHƯA XÁC THỰC 2FA', msg: 'Cần xác minh 2FA OTP trước khi kích hoạt LIVE Bridge.' });
        return false;
      }
      this.mode = mode;
      if (mode === 'DEMO' && this.liveSyncedBalance !== null) {
        const restoreCap = this.demoCapitalBackup || INITIAL_BALANCE;
        this.liveSyncedBalance = null;
        this.liveSyncedFreeMargin = null;
        this.setCapital(restoreCap);
      }
      this._log('SYS', mode === 'LIVE'
        ? 'Chuyển sang chế độ LIVE API / DEX (phiên đã xác thực 2FA).'
        : `Chuyển về chế độ DEMO $${(this.initialCapital || INITIAL_BALANCE).toLocaleString('en-US')} USDC.`);
      this._emit('modeChanged', mode);
      return true;
    }

    // Zero-Trust Live Bridge configuration (requires valid 2FA session unless verified via server HttpOnly session)
    configureLiveBridge(cfg, sessionId, clientIp = '127.0.0.1', serverVerifiedSession = null) {
      let verifiedSession = serverVerifiedSession;
      if (!verifiedSession && this.securityGate) {
        const check = this.securityGate.validateSession(sessionId, clientIp, 'TRADER');
        if (!check.ok) {
          this._log('SHIELD', `Từ chối kích hoạt LIVE Bridge: ${check.error}`);
          this._emit('toast', { type: 'neg', title: 'ZERO-TRUST 2FA CHẶN', msg: check.error });
          return { ok: false, error: check.error };
        }
        verifiedSession = check.session;
      }

      const safeCfg = this._schemas ? this._schemas.scrubSensitive(cfg) : { ...cfg };
      const venueId = this._normalizeVenueId(safeCfg?.venue) || 'HYPERLIQUID';
      const execMode = safeCfg?.execMode === 'LIVE_EXEC' ? 'LIVE_EXEC' : 'SHADOW';
      const net = String(safeCfg?.network || 'TESTNET').toUpperCase() === 'MAINNET' ? 'MAINNET' : 'TESTNET';
      const maxLiveNotionalUsd = Math.max(5, Math.min(500000, Number(safeCfg?.maxLiveNotionalUsd) || 50000));
      this.liveConfig = {
        ...safeCfg,
        venueId,
        network: net,
        execMode,
        maxLiveNotionalUsd,
        connected: true,
        sessionId: verifiedSession?.sessionId || sessionId || null
      };
      this.mode = 'LIVE';
      if (this.market.activeExchange !== venueId) {
        this.market.setExchange(venueId);
      }
      const modeTag = execMode === 'LIVE_EXEC' ? `ĐẨY LỆNH THẬT (${net}, Trần $${maxLiveNotionalUsd})` : `CHẠY BÓNG SHADOW (${net})`;
      this._log('SYS', `Kết nối Live Bridge thành công: ${this.liveConfig.venue} [${venueId}] — ${modeTag} — Chỉ lưu trong RAM phiên.`);
      this._emit('liveConfigured', this._schemas ? this._schemas.scrubSensitive(this.liveConfig) : this.liveConfig);
      return { ok: true, config: this.liveConfig };
    }

    setLiveExecutionAdapter(adapter) {
      this.liveExecutionAdapter = adapter || null;
    }

    isLiveExecutionActive() {
      return Boolean(
        this.mode === 'LIVE' &&
        this.liveConfig.connected &&
        this.liveConfig.execMode === 'LIVE_EXEC' &&
        this.liveExecutionAdapter &&
        typeof this.liveExecutionAdapter.placeOrder === 'function'
      );
    }

    _dispatchLiveOrder({ targetType, targetObj, orderType, sizeUsd, price, slPrice, tpPrice, isMaker }) {
      if (!this.isLiveExecutionActive()) return null;
      const venue = targetObj.exchange || this.getPreferredVenue('HYPERLIQUID');
      return Promise.resolve()
        .then(() =>
          this.liveExecutionAdapter.placeOrder({
            venue,
            network: this.liveConfig.network || 'TESTNET',
            symbol: targetObj.symbol,
            side: targetObj.side,
            orderType,
            sizeUsd,
            price,
            leverage: targetObj.leverage,
            slPrice,
            tpPrice,
            isMaker: Boolean(isMaker),
            maxLiveNotionalUsd: this.liveConfig.maxLiveNotionalUsd || 50000
          })
        )
        .then((res) => {
          if (res && res.ok) {
            targetObj.exchangeOrderId = res.exchangeOrderId || targetObj.exchangeOrderId || '';
            if (res.slOrderId) targetObj.slOrderId = res.slOrderId;
            if (res.tpOrderId) targetObj.tpOrderId = res.tpOrderId;
            if (res.qty) targetObj._liveQty = res.qty;
            this._log('EXEC', `⚡ [LIVE ${venue} ${this.liveConfig.network}] Sàn xác nhận ${orderType} ${targetObj.side} ${targetObj.symbol} #${res.exchangeOrderId || 'OK'}`);
            this._emit('updated');
            return res;
          }
          const err = res?.error || 'Sàn từ chối lệnh.';
          targetObj._rolledBack = true;
          if (targetType === 'POS') {
            const pIdx = this.positions.findIndex((p) => p.id === targetObj.id);
            if (pIdx !== -1) this.positions.splice(pIdx, 1);
          } else {
            const oIdx = this.limitOrders.findIndex((o) => o.id === targetObj.id);
            if (oIdx !== -1) this.limitOrders.splice(oIdx, 1);
          }
          this._log('SHIELD', `❌ [LIVE REJECT ${venue}] Đã rollback lệnh ${targetObj.symbol}: ${err}`);
          this._emit('toast', { type: 'neg', title: `SÀN ${venue} TỪ CHỐI LỆNH`, msg: err });
          this._emit('updated');
          return res;
        })
        .catch((err) => {
          const msg = err?.message || 'Lỗi mạng Local Signer';
          targetObj._rolledBack = true;
          if (targetType === 'POS') {
            const pIdx = this.positions.findIndex((p) => p.id === targetObj.id);
            if (pIdx !== -1) this.positions.splice(pIdx, 1);
          } else {
            const oIdx = this.limitOrders.findIndex((o) => o.id === targetObj.id);
            if (oIdx !== -1) this.limitOrders.splice(oIdx, 1);
          }
          this._log('SHIELD', `❌ [LIVE ERROR ${venue}] Rollback ${targetObj.symbol}: ${msg}`);
          this._emit('toast', { type: 'neg', title: `LỖI ĐẨY LỆNH ${venue}`, msg });
          this._emit('updated');
          return { ok: false, error: msg };
        });
    }

    revokeLiveSessions() {
      if (this.securityGate) {
        this.securityGate.revokeAllSessions();
      }
      this.liveConfig = {
        connected: false,
        venue: null,
        venueId: null,
        network: 'TESTNET',
        execMode: 'SHADOW',
        maxLiveNotionalUsd: 500,
        walletAddress: '',
        apiKeyMasked: '',
        sessionId: null
      };
      this.mode = 'DEMO';
      if (this.liveSyncedBalance !== null) {
        const restoreCap = this.demoCapitalBackup || INITIAL_BALANCE;
        this.liveSyncedBalance = null;
        this.liveSyncedFreeMargin = null;
        this.setCapital(restoreCap);
      }
      this._log('SHIELD', 'Đã thu hồi toàn bộ phiên đăng nhập trên mọi thiết bị & khóa Live Bridge về DEMO.');
      this._emit('toast', { type: 'gold', title: 'ĐÃ THU HỒI TOÀN BỘ PHIÊN', msg: 'Mọi session cũ đã bị vô hiệu hóa.' });
      this._emit('updated');
      return { ok: true };
    }

    setBotStrategy(strat) {
      this.botStrategy = strat;
      if (strat === 'DELTA_ARB') this.botDirectionMode = 'HEDGE';
      else if (this.botDirectionMode === 'HEDGE') this.botDirectionMode = 'AUTO';
      this._log('BOT', `Đã chọn chiến lược Bot: ${strat} (Hướng: ${this.botDirectionMode})`);
      this._emit('updated');
    }

    setBotDirectionMode(mode) {
      const allowed = ['AUTO', 'LONG_ONLY', 'SHORT_ONLY', 'HEDGE'];
      if (!allowed.includes(mode)) return;
      this.botDirectionMode = mode;
      if (mode === 'HEDGE') {
        this.botStrategy = 'DELTA_ARB';
      } else if (this.botStrategy === 'DELTA_ARB') {
        this.botStrategy = 'MOMENTUM';
      }
      this._log('BOT', `Chế độ Bot chọn hướng lệnh: ${mode} (Chiến lược: ${this.botStrategy})`);
      this._emit('updated');
    }

    _hasSymbolExposure(sym) {
      return (
        this.positions.some((p) => !p.hedgeGroupId && p.symbol === sym) ||
        this.limitOrders.some((o) => !o.hedgeGroupId && o.symbol === sym)
      );
    }

    _directionalPosCount() {
      return this.positions.filter((p) => !p.hedgeGroupId).length;
    }

    executeAiSignalOrder({ symbol, forceEntry = false, source = 'BOT' } = {}) {
      if (this.breakerTripped) {
        if (forceEntry) {
          this._emit('toast', { type: 'neg', title: 'CIRCUIT BREAKER ĐANG KHÓA', msg: 'Hãy mở khóa Circuit Breaker trước.' });
        }
        return null;
      }

      const sym = symbol || this.market.activeSymbol;
      const profile = this.getCapitalProfile();
      const prefVenue = this.getPreferredVenue('HYPERLIQUID');

      if (this.botDirectionMode === 'HEDGE') {
        if (this.liveConfig.connected && this.liveConfig.venueId) {
          this._log('SHIELD', `Đang liên kết riêng sàn ${prefVenue}, không mở cặp 2 sàn khác nhau.`);
          return null;
        }
        const opps = this.market.getArbitrageOpportunities();
        const best = opps.find((o) => o.symbol === sym) || opps[0];
        if (!best) return null;
        return this.executeDeltaNeutralArb(best, profile.arbTotalNotional, source);
      }

      if (forceEntry) {
        const sig = this.market.getDirectionalSignal(sym);
        let targetSide = sig.score >= 0 ? 'LONG' : 'SHORT';
        if (this.botDirectionMode === 'LONG_ONLY') targetSide = 'LONG';
        else if (this.botDirectionMode === 'SHORT_ONLY') targetSide = 'SHORT';

        const slPct = sig.suggestedSlPct || 0.65;
        const plan = this.computeCapitalPlan(undefined, undefined, { symbol: sym, exchange: prefVenue, slPct, isMaker: false });
        const tpPct = Number(Math.max(sig.suggestedTpPct || 1.55, plan.minTpPct).toFixed(2));
        const sizeUsd = this.calculateOptimalSize({ symbol: sym, exchange: prefVenue, slPct, isMaker: false });
        const pos = this.placeMarketOrder({
          symbol: sym,
          exchange: prefVenue,
          side: targetSide,
          sizeUsd,
          leverage: plan.maxSafeLeverage,
          slPct,
          tpPct,
          source
        });
        if (pos) {
          this._log('BOT', `⚡ AI 1-Click ${targetSide} ${sym} trên ${prefVenue} (${sig.confidence}% | ${sig.reasons})`);
        }
        return pos;
      }

      if (this._directionalPosCount() >= profile.maxConcurrentDirectional) return null;

      const scanOrder = (profile.tier === 'MICRO' || profile.tier === 'INSUFFICIENT')
        ? profile.preferredSymbols
        : [sym, ...Object.keys(this.market.instruments).filter((s) => s !== sym)];

      let best = null;
      for (const candSym of scanOrder) {
        if (this._hasSymbolExposure(candSym)) continue;
        const sig = this.market.getDirectionalSignal(candSym);
        let targetSide = null;
        if (this.botDirectionMode === 'LONG_ONLY') {
          if (sig.score >= profile.minSignalScore) targetSide = 'LONG';
        } else if (this.botDirectionMode === 'SHORT_ONLY') {
          if (sig.score <= -profile.minSignalScore) targetSide = 'SHORT';
        } else if (sig.side !== 'WAIT' && Math.abs(sig.score) >= profile.minSignalScore) {
          targetSide = sig.side;
        }
        if (!targetSide) continue;

        // Same-wave anti-chasing cooldown per symbol & direction
        const lastClosed = this.lastClosedMap[candSym];
        if (lastClosed && lastClosed.side === targetSide && (this.tickCounter - lastClosed.tick) < 55) {
          continue;
        }

        if (!best || Math.abs(sig.score) > Math.abs(best.sig.score)) {
          best = { sym: candSym, side: targetSide, sig };
        }
      }

      if (!best) return null;

      const slPct = best.sig.suggestedSlPct || 0.65;
      const plan = this.computeCapitalPlan(undefined, undefined, { symbol: best.sym, exchange: prefVenue, slPct, isMaker: false });
      const tpPct = Number(Math.max(best.sig.suggestedTpPct || 1.45, plan.minTpPct).toFixed(2));
      const sizeUsd = this.calculateOptimalSize({ symbol: best.sym, exchange: prefVenue, slPct, isMaker: false });

      const pos = this.placeMarketOrder({
        symbol: best.sym,
        exchange: prefVenue,
        side: best.side,
        sizeUsd,
        leverage: plan.maxSafeLeverage,
        slPct,
        tpPct,
        source
      });

      if (pos) {
        this._log('BOT', `🤖 AI khớp ngay ${best.side} ${best.sym} (${prefVenue} • ${profile.tier}/${plan.riskMode} ${best.sig.confidence}% | ${best.sig.reasons})`);
      }
      return pos;
    }

    toggleBot() {
      if (this.breakerTripped) {
        this._emit('toast', {
          type: 'neg',
          title: 'CIRCUIT BREAKER ĐANG KHÓA',
          msg: 'Hãy Reset Circuit Breaker trước khi khởi động lại Bot.'
        });
        return false;
      }
      if (!this.botRunning && this.dailyProfitLocked) {
        this._emit('toast', {
          type: 'gold',
          title: 'ĐÃ KHÓA MỤC TIÊU LÃI NGÀY',
          msg: 'Hãy bấm "🔓 Mở Khóa Chạy Tiếp" nếu bạn muốn bắt đầu phiên mới.'
        });
        return false;
      }
      this.botRunning = !this.botRunning;
      this.botCooldown = 0;
      this._log('BOT', this.botRunning
        ? `Kích hoạt Bot tự động [${this.botStrategy} | ${this.botDirectionMode}] — Quét đa mã hội tụ +EV.`
        : 'Đã tạm dừng Bot tự động.');
      this._emit('toast', {
        type: this.botRunning ? 'pos' : 'gold',
        title: this.botRunning ? 'BOT ĐÃ KHỞI CHẠY' : 'BOT ĐÃ DỪNG',
        msg: this.botRunning ? `Chiến lược ${this.botStrategy} (${this.botDirectionMode}) đang quét 4 mã.` : 'Chế độ tự động đã tạm ngưng.'
      });
      if (this.botRunning) {
        this._runBotStep(this.market.getSymbolState());
        if (this.positions.length === 0 && this.limitOrders.length === 0) {
          this._log('BOT', '🔎 Bot đang quét đa mã tìm điểm vào hội tụ xác suất cao (Confidence >= 66%)...');
        }
      }
      this._emit('updated');
      return this.botRunning;
    }

    getMetrics() {
      let unrealizedPnl = 0;
      let usedMargin = 0;

      for (const pos of this.positions) {
        const mark = this.market.getPrice(pos.symbol, pos.exchange);
        const dir = pos.side === 'LONG' ? 1 : -1;
        const pricePnl = ((mark - pos.entryPrice) / pos.entryPrice) * pos.sizeUsd * dir;
        const pnl = pricePnl + (pos.accruedFundingUsd || 0) - (pos.entryFeeUsd || 0);
        pos.markPrice = mark;
        pos.unrealizedPnl = pnl;
        pos.roePct = (pnl / pos.marginUsd) * 100;
        unrealizedPnl += pnl;
        usedMargin += pos.marginUsd;
      }

      for (const ord of this.limitOrders) {
        usedMargin += ord.marginUsd * 0.5;
      }

      const equity = this.balance + unrealizedPnl;
      if (equity > this.peakEquity) this.peakEquity = equity;
      const drawdownPct = this.peakEquity > 0 ? ((this.peakEquity - equity) / this.peakEquity) * 100 : 0;
      const baseStartEquity = Number.isFinite(this.dailyStartEquity) ? this.dailyStartEquity : (this.initialCapital || INITIAL_BALANCE);
      const dailyPnlUsd = equity - baseStartEquity;
      if (dailyPnlUsd > this.dailyPeakProfitUsd) {
        this.dailyPeakProfitUsd = dailyPnlUsd;
      }
      let freeMargin = Math.max(0, equity - usedMargin);
      if (this.mode === 'LIVE' && this.positions.length === 0 && this.limitOrders.length === 0 && this.liveSyncedFreeMargin !== null) {
        freeMargin = Math.max(0, Math.min(equity, this.liveSyncedFreeMargin));
      }
      const totalClosed = this.wins + this.losses;
      const winRate = totalClosed > 0 ? (this.wins / totalClosed) * 100 : 0;

      return {
        balance: this.balance,
        equity,
        unrealizedPnl,
        unrealizedPct: (unrealizedPnl / Math.max(1, this.initialCapital || INITIAL_BALANCE)) * 100,
        realizedPnl: this.realizedPnl,
        dailyPnlUsd,
        dailyPeakProfitUsd: this.dailyPeakProfitUsd,
        dailyProfitLocked: this.dailyProfitLocked,
        usedMargin,
        freeMargin,
        drawdownPct,
        winRate,
        wins: this.wins,
        losses: this.losses
      };
    }

    calculateOptimalSize({ symbol, exchange, slPct, isMaker = true }) {
      const sym = symbol || this.market.activeSymbol;
      const ex = (exchange && exchange !== 'ALL') ? exchange : this.getPreferredVenue('HYPERLIQUID');
      const metrics = this.getMetrics();
      const profile = this.computeCapitalPlan(metrics.equity, undefined, { symbol: sym, exchange: ex, slPct, isMaker });
      const safeSl = Math.max(0.15, Number(slPct) || 0.8);

      const entryFeeBps = this.market.getVenueFeeBps(ex, isMaker);
      const exitFeeBps = this.market.getVenueFeeBps(ex, false);
      const slipBps = isMaker ? 0.3 : this.market.estimateSlippageBps(sym, Math.min(5000, Math.max(100, metrics.equity * profile.maxSafeLeverage)));
      const roundTripCostPct = (entryFeeBps + exitFeeBps + slipBps) / 100;

      const totalRiskPerDollar = (safeSl + roundTripCostPct) / 100;
      const maxDollarRisk = metrics.equity * (this.riskShield.riskPerTradePct / 100);
      const rawOptimal = maxDollarRisk / Math.max(0.001, totalRiskPerDollar);
      const marginUsageCap = profile.marginUsageCap || (profile.tier === 'MICRO' ? 0.70 : 0.85);
      const maxMarginCap = metrics.freeMargin * profile.maxSafeLeverage * marginUsageCap;
      if (maxMarginCap < 5) return 5;
      const sized = Math.max(Math.min(profile.minNotionalUsd, maxMarginCap), Math.min(rawOptimal, maxMarginCap));
      return metrics.equity < 500 ? Number(sized.toFixed(1)) : Math.floor(sized);
    }

    evaluatePreTrade({ symbol, exchange, side, slPct, tpPct, sizeUsd, leverage, isMaker = true, isHedge = false }) {
      const sym = symbol || this.market.activeSymbol;
      const ex = (exchange && exchange !== 'ALL') ? exchange : this.getPreferredVenue('HYPERLIQUID');
      const st = this.market.getSymbolState(sym);
      const safeSl = Math.max(0.1, Number(slPct) || 0.8);
      const safeTp = Math.max(0.1, Number(tpPct) || 1.8);

      const entryFeeBps = this.market.getVenueFeeBps(ex, isMaker);
      const exitFeeBps = this.market.getVenueFeeBps(ex, false);
      const slipBps = isMaker ? 0.35 : this.market.estimateSlippageBps(sym, sizeUsd);
      const feePct = (entryFeeBps + exitFeeBps + slipBps) / 100;

      const netRewardPct = safeTp - feePct;
      const netRiskPct = safeSl + feePct;
      const netRR = netRewardPct / Math.max(0.05, netRiskPct);
      const maxLossUsd = sizeUsd * (netRiskPct / 100);

      let effectiveLev = Math.max(1, Number(leverage) || 5);
      if (this.riskShield.enabled && !isHedge && effectiveLev > this.riskShield.maxSafeLeverage) {
        effectiveLev = this.riskShield.maxSafeLeverage;
      }

      if (!this.riskShield.enabled || isHedge) {
        return { ok: true, effectiveLev, feePct, netRR, maxLossUsd, entryFeeBps };
      }

      if ((this.riskShield.cooldownTicks || 0) > 0 && Date.now() < this.riskShield.cooldownUntil) {
        const waitSec = Math.max(1, Math.ceil((this.riskShield.cooldownUntil - Date.now()) / 1000));
        return {
          ok: false,
          reason: `Anti-Revenge Cooldown: Tạm nghỉ ${waitSec}s (${this.riskShield.cooldownTicks} ticks) sau 2 lệnh thua liên tiếp để giữ kỷ luật.`
        };
      }

      if (st.shockSigma >= 1.8 || st.orderbook.spreadBps > 8.0) {
        return {
          ok: false,
          reason: `Thị trường đang sốc (${st.shockSigma.toFixed(2)}σ, Spread ${st.orderbook.spreadBps.toFixed(1)} bps) — Risk Shield chặn lệnh mới.`
        };
      }

      if (netRR < this.riskShield.minNetRR) {
        return {
          ok: false,
          reason: `Net R:R sau phí chỉ đạt 1:${netRR.toFixed(2)} (< 1:${this.riskShield.minNetRR}). Hãy tăng TP% hoặc dùng Limit Maker!`
        };
      }

      return { ok: true, effectiveLev, feePct, netRR, maxLossUsd, entryFeeBps };
    }

    placeLimitOrder({ symbol, exchange, side, entryPrice, sizeUsd, leverage, slPct, tpPct, source = 'MANUAL', hedgeGroupId = null }) {
      if (this.breakerTripped) {
        this._emit('toast', { type: 'neg', title: 'BỊ CHẶN BỞI CIRCUIT BREAKER', msg: 'Hệ thống đang tự ngắt bảo vệ tài khoản.' });
        return null;
      }

      const sym = symbol || this.market.activeSymbol;
      const ex = (exchange && exchange !== 'ALL') ? exchange : this.getPreferredVenue('HYPERLIQUID');
      const size = Math.max(5, Number(sizeUsd) || this.calculateOptimalSize({ symbol: sym, exchange: ex, slPct, isMaker: true }));
      const isHedge = Boolean(hedgeGroupId);

      if (this._schemas) {
        const v = this._schemas.validateOrderInput({ symbol: sym, exchange: ex, side, entryPrice, sizeUsd: size, leverage, slPct, tpPct });
        if (!v.ok) {
          this._emit('toast', { type: 'neg', title: 'DỮ LIỆU LỆNH KHÔNG HỢP LỆ', msg: v.errors[0] });
          return null;
        }
      }

      const check = this.evaluatePreTrade({ symbol: sym, exchange: ex, side, slPct, tpPct, sizeUsd: size, leverage, isMaker: true, isHedge });
      if (!check.ok) {
        if (source !== 'BOT') {
          this._emit('toast', { type: 'neg', title: '🛡 RISK SHIELD CHẶN LỆNH', msg: check.reason });
        }
        this._log('SHIELD', `Chặn Limit ${side} ${sym}: ${check.reason}`);
        return null;
      }

      const lev = check.effectiveLev;
      const marginUsd = size / lev;
      const metrics = this.getMetrics();

      if (this.isLiveExecutionActive() && size > (this.liveConfig.maxLiveNotionalUsd || 50000)) {
        const capMsg = `Size $${size.toFixed(1)} vượt trần đẩy lệnh thật ($${this.liveConfig.maxLiveNotionalUsd}).`;
        if (source !== 'BOT') this._emit('toast', { type: 'neg', title: 'VƯỢT TRẦN LỆNH THẬT', msg: capMsg });
        this._log('SHIELD', capMsg);
        return null;
      }

      if (marginUsd > metrics.freeMargin) {
        if (source !== 'BOT') {
          this._emit('toast', { type: 'neg', title: 'KHÔNG ĐỦ KÝ QUỸ', msg: `Cần $${marginUsd.toFixed(0)} margin, khả dụng $${metrics.freeMargin.toFixed(0)}.` });
        }
        return null;
      }

      let targetEntry = entryPrice;
      const currentPx = this.market.getPrice(sym, ex);
      const tick = this.market.instruments[sym]?.tick || 0.1;

      if (this.riskShield.postOnlyMaker && !isHedge) {
        if (side === 'LONG' && targetEntry >= currentPx) {
          targetEntry = currentPx - tick;
        } else if (side === 'SHORT' && targetEntry <= currentPx) {
          targetEntry = currentPx + tick;
        }
      }

      const dir = side === 'LONG' ? 1 : -1;
      const order = {
        id: this._uuid.v4(),
        symbol: sym,
        exchange: ex,
        side,
        entryPrice: targetEntry,
        slPrice: isHedge ? null : targetEntry * (1 - dir * (Number(slPct) / 100)),
        tpPrice: isHedge ? null : targetEntry * (1 + dir * (Number(tpPct) / 100)),
        slPct: Number(slPct) || 0.8,
        sizeUsd: size,
        leverage: lev,
        marginUsd,
        source,
        isMaker: true,
        hedgeGroupId,
        createdAt: Date.now()
      };

      const isImmediatelyFillable =
        isHedge ||
        (side === 'LONG' && currentPx <= targetEntry) ||
        (side === 'SHORT' && currentPx >= targetEntry);

      if (isImmediatelyFillable) {
        return this._openPositionFromOrder(order, isHedge ? targetEntry : currentPx, isHedge ? 'MAKER HEDGE' : 'LIMIT IMMEDIATE');
      }

      this.limitOrders.unshift(order);
      if (!isHedge && this.isLiveExecutionActive()) {
        this._dispatchLiveOrder({
          targetType: 'ORD',
          targetObj: order,
          orderType: 'LIMIT',
          sizeUsd: size,
          price: targetEntry,
          slPrice: order.slPrice,
          tpPrice: order.tpPrice,
          isMaker: true
        });
      }
      this._log(source === 'BOT' ? 'BOT' : 'EXEC',
        `Đặt LIMIT MAKER ${side} ${sym} (${ex}, ${lev}x) #${this._uuid.shortId(order.id)} @ ${this.market.formatPrice(targetEntry, sym)} | Net R:R 1:${check.netRR.toFixed(2)}`);
      this._emit('toast', {
        type: side === 'LONG' ? 'pos' : 'neg',
        title: `ĐÃ ĐẶT LIMIT MAKER ${side}`,
        msg: `${sym} @ $${this.market.formatPrice(targetEntry, sym)} (Phí ${check.entryFeeBps} bps)`
      });
      this._emit('updated');
      return order;
    }

    placeMarketOrder({ symbol, exchange, side, sizeUsd, leverage, slPct, tpPct, source = 'MANUAL' }) {
      if (this.breakerTripped) {
        this._emit('toast', { type: 'neg', title: 'BỊ CHẶN BỞI CIRCUIT BREAKER', msg: 'Hệ thống đang ở chế độ bảo vệ.' });
        return null;
      }
      const sym = symbol || this.market.activeSymbol;
      const ex = (exchange && exchange !== 'ALL') ? exchange : this.getPreferredVenue('HYPERLIQUID');
      const fillPx = this.market.getPrice(sym, ex);
      const size = Math.max(5, Number(sizeUsd) || this.calculateOptimalSize({ symbol: sym, exchange: ex, slPct, isMaker: false }));

      if (this.isLiveExecutionActive() && size > (this.liveConfig.maxLiveNotionalUsd || 50000)) {
        const capMsg = `Size $${size.toFixed(1)} vượt trần đẩy lệnh thật ($${this.liveConfig.maxLiveNotionalUsd}).`;
        if (source !== 'BOT') this._emit('toast', { type: 'neg', title: 'VƯỢT TRẦN LỆNH THẬT', msg: capMsg });
        this._log('SHIELD', capMsg);
        return null;
      }

      if (this._schemas) {
        const v = this._schemas.validateOrderInput({ symbol: sym, exchange: ex, side, entryPrice: fillPx, sizeUsd: size, leverage, slPct, tpPct });
        if (!v.ok) {
          this._emit('toast', { type: 'neg', title: 'DỮ LIỆU LỆNH KHÔNG HỢP LỆ', msg: v.errors[0] });
          return null;
        }
      }

      const check = this.evaluatePreTrade({ symbol: sym, exchange: ex, side, slPct, tpPct, sizeUsd: size, leverage, isMaker: false, isHedge: false });
      if (!check.ok) {
        if (source !== 'BOT') {
          this._emit('toast', { type: 'neg', title: '🛡 RISK SHIELD CHẶN LỆNH', msg: check.reason });
        }
        this._log('SHIELD', `Chặn Market ${side} ${sym}: ${check.reason}`);
        return null;
      }

      const lev = check.effectiveLev;
      const marginUsd = size / lev;
      const metrics = this.getMetrics();

      if (this.isLiveExecutionActive() && size > (this.liveConfig.maxLiveNotionalUsd || 50000)) {
        const capMsg = `Size $${size.toFixed(1)} vượt trần đẩy lệnh thật ($${this.liveConfig.maxLiveNotionalUsd}).`;
        if (source !== 'BOT') this._emit('toast', { type: 'neg', title: 'VƯỢT TRẦN LỆNH THẬT', msg: capMsg });
        this._log('SHIELD', capMsg);
        return null;
      }

      if (marginUsd > metrics.freeMargin) {
        if (source !== 'BOT') {
          this._emit('toast', { type: 'neg', title: 'KHÔNG ĐỦ KÝ QUỸ', msg: `Cần $${marginUsd.toFixed(0)} margin.` });
        }
        return null;
      }

      const dir = side === 'LONG' ? 1 : -1;
      const order = {
        id: this._uuid.v4(),
        symbol: sym,
        exchange: ex,
        side,
        entryPrice: fillPx,
        slPrice: fillPx * (1 - dir * (Number(slPct) / 100)),
        tpPrice: fillPx * (1 + dir * (Number(tpPct) / 100)),
        slPct: Number(slPct) || 0.8,
        sizeUsd: size,
        leverage: lev,
        marginUsd,
        source,
        isMaker: false,
        hedgeGroupId: null
      };
      return this._openPositionFromOrder(order, fillPx, 'MARKET');
    }

    executeDeltaNeutralArb(opp, totalNotionalUsd, source = 'ARB') {
      if (this.breakerTripped) {
        this._emit('toast', { type: 'neg', title: 'CIRCUIT BREAKER ĐANG KHÓA', msg: 'Không thể mở cặp Arbitrage khi đang bảo vệ.' });
        return false;
      }
      const existingPair = this.positions.some((p) => p.hedgeGroupId && p.symbol === opp.symbol);
      if (existingPair) {
        if (source !== 'BOT') {
          this._emit('toast', { type: 'gold', title: 'ĐÃ CÓ CẶP HEDGE', msg: `${opp.symbol} đang chạy Delta-Neutral Arbitrage.` });
        }
        return false;
      }

      const profile = this.getCapitalProfile();
      const notional = Number.isFinite(totalNotionalUsd) && totalNotionalUsd > 0 ? totalNotionalUsd : profile.arbTotalNotional;
      const legNotional = Math.max(6, Number((notional / 2).toFixed(1)));
      const metrics = this.getMetrics();
      const totalMarginNeeded = (legNotional * 2) / 2;
      if (totalMarginNeeded > metrics.freeMargin) {
        if (source !== 'BOT') {
          this._emit('toast', { type: 'neg', title: 'KHÔNG ĐỦ MARGIN', msg: `Cần $${totalMarginNeeded.toLocaleString()} để mở 2 chân Hedge 2x.` });
        }
        return false;
      }

      const groupId = this._uuid.v4();
      const longPos = this.placeLimitOrder({
        symbol: opp.symbol,
        exchange: opp.longVenue,
        side: 'LONG',
        entryPrice: opp.longPrice,
        sizeUsd: legNotional,
        leverage: 2,
        slPct: 5,
        tpPct: 5,
        source,
        hedgeGroupId: groupId
      });
      const shortPos = this.placeLimitOrder({
        symbol: opp.symbol,
        exchange: opp.shortVenue,
        side: 'SHORT',
        entryPrice: opp.shortPrice,
        sizeUsd: legNotional,
        leverage: 2,
        slPct: 5,
        tpPct: 5,
        source,
        hedgeGroupId: groupId
      });

      if (longPos && shortPos) {
        this._log('SHIELD', `⚡ MỞ CẶP DELTA-NEUTRAL ${opp.symbol} #${this._uuid.shortId(groupId)}: LONG ${opp.longVenue} + SHORT ${opp.shortVenue} | Net APR: +${opp.netAprPct.toFixed(1)}%/năm.`);
        this._emit('toast', {
          type: 'pos',
          title: `⚡ ĐÃ KHỚP HEDGE ${opp.symbol}`,
          msg: `Long ${opp.longVenue} + Short ${opp.shortVenue} | Kỳ vọng +${opp.netAprPct.toFixed(1)}% APR`
        });
        return true;
      }
      return false;
    }

    _openPositionFromOrder(order, fillPrice, execLabel) {
      const feeBps = this.market.getVenueFeeBps(order.exchange, Boolean(order.isMaker));
      const slipBps = order.isMaker ? 0 : this.market.estimateSlippageBps(order.symbol, order.sizeUsd);
      const entryFeeUsd = order.sizeUsd * ((feeBps + slipBps) / 10000);

      const pos = {
        id: order.id || this._uuid.v4(),
        symbol: order.symbol,
        exchange: order.exchange,
        side: order.side,
        entryPrice: fillPrice,
        markPrice: fillPrice,
        peakPrice: fillPrice,
        slPrice: order.slPrice,
        tpPrice: order.tpPrice,
        initialRiskPct: order.slPct || 0.8,
        beLocked: false,
        trailingActive: false,
        hedgeGroupId: order.hedgeGroupId || null,
        accruedFundingUsd: 0,
        entryFeeUsd,
        isMakerEntry: Boolean(order.isMaker),
        sizeUsd: order.sizeUsd,
        leverage: order.leverage,
        marginUsd: order.marginUsd,
        unrealizedPnl: -entryFeeUsd,
        roePct: (-entryFeeUsd / order.marginUsd) * 100,
        source: order.source,
        openedAt: Date.now()
      };
      this.positions.unshift(pos);

      if (!pos.hedgeGroupId && this.isLiveExecutionActive() && !order._fromLimitFill) {
        this._dispatchLiveOrder({
          targetType: 'POS',
          targetObj: pos,
          orderType: execLabel === 'MARKET' ? 'MARKET' : 'LIMIT',
          sizeUsd: pos.sizeUsd,
          price: fillPrice,
          slPrice: pos.slPrice,
          tpPrice: pos.tpPrice,
          isMaker: Boolean(order.isMaker)
        });
      }

      this._log('EXEC', `KHỚP ${execLabel} ${pos.side} ${pos.symbol} #${this._uuid.shortId(pos.id)} (${pos.exchange} ${pos.leverage}x) $${pos.sizeUsd.toLocaleString()} @ ${this.market.formatPrice(fillPrice, pos.symbol)}`);
      if (!pos.hedgeGroupId) {
        this._emit('toast', {
          type: 'pos',
          title: `KHỚP LỆNH ${pos.side} (${execLabel})`,
          msg: `${pos.symbol} @ $${this.market.formatPrice(fillPrice, pos.symbol)} | Size $${pos.sizeUsd.toLocaleString()}`
        });
      }
      this._emit('updated');
      return pos;
    }

    cancelLimitOrder(orderId) {
      const idx = this.limitOrders.findIndex((o) => String(o.id) === String(orderId));
      if (idx === -1) return;
      const [ord] = this.limitOrders.splice(idx, 1);
      if (this.isLiveExecutionActive() && ord.exchangeOrderId && !ord._rolledBack && typeof this.liveExecutionAdapter.cancelOrder === 'function') {
        Promise.resolve()
          .then(() => this.liveExecutionAdapter.cancelOrder({
            venue: ord.exchange,
            network: this.liveConfig.network || 'TESTNET',
            symbol: ord.symbol,
            exchangeOrderId: ord.exchangeOrderId
          }))
          .catch(() => null);
      }
      this._log('EXEC', `Đã hủy lệnh Limit #${this._uuid.shortId(ord.id)} (${ord.symbol} ${ord.side}).`);
      this._emit('updated');
    }

    closePosition(posId, reason = 'MANUAL CLOSE', explicitExitPrice = null) {
      const idx = this.positions.findIndex((p) => String(p.id) === String(posId));
      if (idx === -1) return;
      const [pos] = this.positions.splice(idx, 1);
      const exitPrice = (Number.isFinite(explicitExitPrice) && explicitExitPrice > 0)
        ? explicitExitPrice
        : this.market.getPrice(pos.symbol, pos.exchange);
      if (!pos.hedgeGroupId && !pos._rolledBack && this.isLiveExecutionActive() && typeof this.liveExecutionAdapter.closePosition === 'function') {
        Promise.resolve()
          .then(() => this.liveExecutionAdapter.closePosition({
            venue: pos.exchange,
            network: this.liveConfig.network || 'TESTNET',
            symbol: pos.symbol,
            side: pos.side,
            sizeUsd: pos.sizeUsd,
            qty: pos._liveQty,
            refPrice: exitPrice
          }))
          .then((res) => {
            if (res && !res.ok) {
              this._log('SHIELD', `⚠ [LIVE CLOSE ${pos.exchange}] ${res.error}`);
              this._emit('toast', { type: 'neg', title: `CẢNH BÁO ĐÓNG LỆNH ${pos.exchange}`, msg: res.error });
            }
          })
          .catch(() => null);
      }
      const dir = pos.side === 'LONG' ? 1 : -1;
      const grossPnl = ((exitPrice - pos.entryPrice) / pos.entryPrice) * pos.sizeUsd * dir + (pos.accruedFundingUsd || 0);
      const isMakerExit = reason.includes('TAKE PROFIT') || reason.includes('ARB PROFIT') || reason.includes('AI FLOW REVERSAL TP');
      const exitFeeBps = this.market.getVenueFeeBps(pos.exchange, isMakerExit);
      const exitFeeUsd = pos.sizeUsd * (exitFeeBps / 10000);
      const totalFeeUsd = (pos.entryFeeUsd || 0) + exitFeeUsd;
      const netPnl = grossPnl - totalFeeUsd;

      this.balance += netPnl;
      this.realizedPnl += netPnl;
      this.lastClosedMap[pos.symbol] = { side: pos.side, tick: this.tickCounter };
      if (netPnl >= 0) {
        this.wins++;
        this.riskShield.consecutiveLosses = 0;
      } else {
        this.losses++;
        if (!pos.hedgeGroupId) {
          this.riskShield.consecutiveLosses++;
          if (this.riskShield.consecutiveLosses >= 2 && this.riskShield.enabled) {
            this.riskShield.cooldownUntil = Date.now() + 10000;
            this.riskShield.cooldownTicks = 40;
            this._log('SHIELD', 'Anti-Revenge Trigger: Tạm khóa đặt lệnh mới 40 nhịp (~10s) sau 2 lệnh lỗ liên tiếp.');
          }
        }
      }

      const record = {
        id: pos.id,
        time: new Date().toISOString().substr(11, 8),
        symbol: pos.symbol,
        exchange: pos.exchange,
        side: pos.side,
        entryPrice: pos.entryPrice,
        exitPrice,
        reason,
        grossPnl,
        feeUsd: totalFeeUsd,
        pnl: netPnl
      };
      this.history.unshift(record);
      if (this.history.length > 60) this.history.pop();

      this._log(reason.includes('BREAKER') ? 'SHOCK' : 'EXEC',
        `ĐÓNG ${pos.side} ${pos.symbol} #${this._uuid.shortId(pos.id)} [${reason}] @ ${this.market.formatPrice(exitPrice, pos.symbol)} | PnL: ${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)} (Phí: -$${totalFeeUsd.toFixed(2)})`);

      this._emit('toast', {
        type: netPnl >= 0 ? 'pos' : 'neg',
        title: `${reason}: ${pos.symbol} ${pos.side}`,
        msg: `PnL: ${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)} @ $${this.market.formatPrice(exitPrice, pos.symbol)}`
      });
      this._emit('tradeClosed', record);
      this._emit('updated');
    }

    closeAll(reason = 'CLOSE ALL') {
      while (this.limitOrders.length > 0) {
        this.limitOrders.pop();
      }
      const ids = this.positions.map((p) => p.id);
      ids.forEach((id) => this.closePosition(id, reason));
      this._emit('updated');
    }

    tripCircuitBreaker(reason) {
      if (this.breakerTripped) return;
      this.breakerTripped = true;
      this.breakerReason = reason;
      this.botRunning = false;

      const cancelledCount = this.limitOrders.length;
      this.limitOrders = [];

      let closedCount = 0;
      if (this.autoFlattenOnBreak && this.positions.length > 0) {
        closedCount = this.positions.length;
        const ids = this.positions.map((p) => p.id);
        ids.forEach((id) => this.closePosition(id, 'CIRCUIT BREAKER'));
      }

      this._log('SHOCK', `🚨 CIRCUIT BREAKER TRIPPED! ${reason} (Hủy ${cancelledCount} lệnh chờ, đóng bảo vệ ${closedCount} vị thế).`);
      this._emit('breakerTripped', { reason, cancelledCount, closedCount });
      this._emit('toast', {
        type: 'neg',
        title: '🚨 CIRCUIT BREAKER KÍCH HOẠT',
        msg: `${reason} — Bot đã ngắt & hủy ${cancelledCount} lệnh chờ.`
      });
      this._emit('updated');
    }

    resetCircuitBreaker(silent = false) {
      this.breakerTripped = false;
      this.breakerReason = '';
      this.market.clearShock();
      this.peakEquity = Math.max(this.balance, this.getMetrics().equity);
      if (!silent) {
        this._log('SYS', 'Circuit Breaker đã được mở khóa & vũ trang lại (ARMED).');
        this._emit('toast', { type: 'gold', title: 'CIRCUIT BREAKER ARMED', msg: 'Hệ thống đã sẵn sàng giao dịch trở lại.' });
      }
      this._emit('breakerReset');
      this._emit('updated');
    }

    onMarketTick() {
      this.tickCounter++;
      if ((this.riskShield.cooldownTicks || 0) > 0) {
        this.riskShield.cooldownTicks--;
        if (this.riskShield.cooldownTicks === 0) this.riskShield.cooldownUntil = 0;
      }
      const nowMs = Date.now();
      for (let i = this.limitOrders.length - 1; i >= 0; i--) {
        const ord = this.limitOrders[i];
        ord.ticksWaiting = (ord.ticksWaiting || 0) + 1;
        if (ord.source === 'BOT' && !ord.hedgeGroupId && (ord.ticksWaiting > 20 || (nowMs - (ord.createdAt || nowMs)) > 5000)) {
          this.limitOrders.splice(i, 1);
          if (this.isLiveExecutionActive() && ord.exchangeOrderId && typeof this.liveExecutionAdapter.cancelOrder === 'function') {
            Promise.resolve().then(() => this.liveExecutionAdapter.cancelOrder({
              venue: ord.exchange,
              network: this.liveConfig.network || 'TESTNET',
              symbol: ord.symbol,
              exchangeOrderId: ord.exchangeOrderId
            })).catch(() => null);
          }
          continue;
        }
        const px = this.market.getPrice(ord.symbol, ord.exchange);
        const filled =
          (ord.side === 'LONG' && px <= ord.entryPrice) ||
          (ord.side === 'SHORT' && px >= ord.entryPrice);
        if (filled) {
          this.limitOrders.splice(i, 1);
          ord._fromLimitFill = true;
          const openedPos = this._openPositionFromOrder(ord, ord.entryPrice, 'LIMIT FILLED');
          if (openedPos && ord.exchangeOrderId) {
            openedPos.exchangeOrderId = ord.exchangeOrderId;
            openedPos.slOrderId = ord.slOrderId;
            openedPos.tpOrderId = ord.tpOrderId;
            openedPos._liveQty = ord._liveQty;
          }
        }
      }

      const toClose = [];
      const hedgeGroups = {};

      for (const pos of this.positions) {
        const px = this.market.getPrice(pos.symbol, pos.exchange);
        const dir = pos.side === 'LONG' ? 1 : -1;

        if (pos.hedgeGroupId) {
          const st = this.market.getSymbolState(pos.symbol);
          const fRate = st?.venueFunding8h?.[pos.exchange] || 0;
          const stepYield = (fRate / 100) * pos.sizeUsd * (-dir) * 0.018;
          pos.accruedFundingUsd = (pos.accruedFundingUsd || 0) + stepYield;
          if (!hedgeGroups[pos.hedgeGroupId]) hedgeGroups[pos.hedgeGroupId] = [];
          hedgeGroups[pos.hedgeGroupId].push(pos);
          continue;
        }

        const movePct = ((px - pos.entryPrice) / pos.entryPrice) * 100 * dir;
        const rMultiple = movePct / Math.max(0.15, pos.initialRiskPct || 0.8);

        if (dir === 1 && px > (pos.peakPrice || pos.entryPrice)) pos.peakPrice = px;
        if (dir === -1 && px < (pos.peakPrice || pos.entryPrice)) pos.peakPrice = px;

        const rtFeeFrac = ((pos.entryFeeUsd || 0) / Math.max(1, pos.sizeUsd)) + (this.market.getVenueFeeBps(pos.exchange, false) / 10000);
        const beBuffer = rtFeeFrac + 0.0012;
        const minBeSl = pos.entryPrice * (1 + dir * beBuffer);

        if (this.riskShield.autoBreakeven && !pos.beLocked && rMultiple >= 0.65) {
          pos.slPrice = minBeSl;
          pos.beLocked = true;
          this._log('SHIELD', `🔒 AUTO-BREAKEVEN: Dời SL ${pos.symbol} #${this._uuid.shortId(pos.id)} khóa lãi dương + phí @ ${this.market.formatPrice(pos.slPrice, pos.symbol)}`);
          if (this.isLiveExecutionActive() && !pos._rolledBack && typeof this.liveExecutionAdapter.modifyStopLoss === 'function') {
            pos._lastLiveSlSyncAt = nowMs;
            pos._lastSyncedSlPx = pos.slPrice;
            Promise.resolve().then(() => this.liveExecutionAdapter.modifyStopLoss({
              venue: pos.exchange,
              network: this.liveConfig.network || 'TESTNET',
              symbol: pos.symbol,
              side: pos.side,
              slPrice: pos.slPrice,
              sizeUsd: pos.sizeUsd,
              refPrice: px
            })).catch(() => null);
          }
        }

        if (this.riskShield.autoTrailing && pos.beLocked && rMultiple >= 0.95) {
          const trailDist = Math.max(rtFeeFrac + 0.0014, (pos.initialRiskPct * 0.40) / 100);
          let candidateSl = pos.peakPrice * (1 - dir * trailDist);
          candidateSl = dir === 1 ? Math.max(candidateSl, minBeSl) : Math.min(candidateSl, minBeSl);
          if ((dir === 1 && candidateSl > pos.slPrice) || (dir === -1 && candidateSl < pos.slPrice)) {
            pos.slPrice = candidateSl;
            pos.trailingActive = true;
            const prevSynced = pos._lastSyncedSlPx || 0;
            const slMoveFrac = prevSynced > 0 ? Math.abs(pos.slPrice - prevSynced) / prevSynced : 1;
            if (this.isLiveExecutionActive() && !pos._rolledBack && slMoveFrac >= 0.0015 && (nowMs - (pos._lastLiveSlSyncAt || 0)) >= 5000 && typeof this.liveExecutionAdapter.modifyStopLoss === 'function') {
              pos._lastLiveSlSyncAt = nowMs;
              pos._lastSyncedSlPx = pos.slPrice;
              Promise.resolve().then(() => this.liveExecutionAdapter.modifyStopLoss({
                venue: pos.exchange,
                network: this.liveConfig.network || 'TESTNET',
                symbol: pos.symbol,
                side: pos.side,
                slPrice: pos.slPrice,
                sizeUsd: pos.sizeUsd,
                refPrice: px
              })).catch(() => null);
            }
          }
        }

        if (pos.side === 'LONG') {
          if (pos.slPrice && px <= pos.slPrice) {
            toClose.push({ id: pos.id, reason: pos.trailingActive ? 'TRAILING PROFIT' : (pos.beLocked ? 'BREAKEVEN EXIT' : 'STOP LOSS HIT'), exitPrice: null });
          } else if (pos.tpPrice && px >= pos.tpPrice) {
            toClose.push({ id: pos.id, reason: 'TAKE PROFIT HIT', exitPrice: pos.tpPrice });
          } else if (pos.source === 'BOT' && rMultiple >= 0.35) {
            const sig = this.market.getDirectionalSignal(pos.symbol);
            if (dir * sig.score <= -26) {
              toClose.push({ id: pos.id, reason: 'AI FLOW REVERSAL TP', exitPrice: px });
            }
          }
        } else {
          if (pos.slPrice && px >= pos.slPrice) {
            toClose.push({ id: pos.id, reason: pos.trailingActive ? 'TRAILING PROFIT' : (pos.beLocked ? 'BREAKEVEN EXIT' : 'STOP LOSS HIT'), exitPrice: null });
          } else if (pos.tpPrice && px <= pos.tpPrice) {
            toClose.push({ id: pos.id, reason: 'TAKE PROFIT HIT', exitPrice: pos.tpPrice });
          } else if (pos.source === 'BOT' && rMultiple >= 0.35) {
            const sig = this.market.getDirectionalSignal(pos.symbol);
            if (dir * sig.score <= -26) {
              toClose.push({ id: pos.id, reason: 'AI FLOW REVERSAL TP', exitPrice: px });
            }
          }
        }
      }

      Object.values(hedgeGroups).forEach((legs) => {
        if (legs.length !== 2) return;
        let combinedNetPnl = 0;
        let totalNotional = 0;
        legs.forEach((leg) => {
          const mark = this.market.getPrice(leg.symbol, leg.exchange);
          const dir = leg.side === 'LONG' ? 1 : -1;
          const gross = ((mark - leg.entryPrice) / leg.entryPrice) * leg.sizeUsd * dir + (leg.accruedFundingUsd || 0);
          const exitMakerFee = leg.sizeUsd * (this.market.getVenueFeeBps(leg.exchange, true) / 10000);
          combinedNetPnl += gross - (leg.entryFeeUsd || 0) - exitMakerFee;
          totalNotional += leg.sizeUsd;
        });
        const netRetPct = (combinedNetPnl / Math.max(1, totalNotional)) * 100;
        if (netRetPct >= 0.14) {
          legs.forEach((leg) => toClose.push({ id: leg.id, reason: 'ARB PROFIT TAKE', exitPrice: null }));
        } else if (netRetPct <= -0.35) {
          legs.forEach((leg) => toClose.push({ id: leg.id, reason: 'ARB BASIS STOP', exitPrice: null }));
        }
      });

      toClose.forEach((item) => this.closePosition(item.id, item.reason, item.exitPrice));

      const metrics = this.getMetrics();
      this.equityHistory.push(metrics.equity);
      if (this.equityHistory.length > 64) this.equityHistory.shift();

      const activeSt = this.market.getSymbolState();
      if (!this.breakerTripped && activeSt.shockSigma >= this.maxShockSigma) {
        this.tripCircuitBreaker(`Sốc biến động đạt ${activeSt.shockSigma.toFixed(2)}σ (vượt ngưỡng ${this.maxShockSigma}σ)`);
      }

      if (!this.breakerTripped) {
        this._checkDailyProfitLock(metrics);
      }

      if (!this.breakerTripped && !this.dailyProfitLocked) {
        const curMetrics = this.getMetrics();
        if (curMetrics.drawdownPct >= this.maxDrawdownPct) {
          this.tripCircuitBreaker(`Drawdown chạm ${curMetrics.drawdownPct.toFixed(2)}% (vượt ngưỡng ${this.maxDrawdownPct}%)`);
        }
      }

      if (this.botRunning && !this.breakerTripped && !this.dailyProfitLocked) {
        this._runBotStep(activeSt);
      }
    }

    _checkDailyProfitLock(metrics) {
      if (!this.dailyProfitLockEnabled || this.dailyProfitLocked || !this.botRunning || this.breakerTripped) {
        return false;
      }
      const baseEquity = (Number.isFinite(this.dailyStartEquity) && this.dailyStartEquity > 0)
        ? this.dailyStartEquity
        : (this.initialCapital || INITIAL_BALANCE);
      const plan = this.computeCapitalPlan(baseEquity);
      const dailyPnl = metrics.dailyPnlUsd;
      const hitTarget = dailyPnl >= plan.dailyProfitLockUsd;
      const hitGivebackFloor =
        this.dailyPeakProfitUsd >= plan.profitTrailingTriggerUsd &&
        dailyPnl > 0 &&
        dailyPnl <= this.dailyPeakProfitUsd * plan.profitTrailingFloorPct;

      if (!hitTarget && !hitGivebackFloor) return false;

      // Cancel pending BOT directional limit orders and lock in open BOT directional positions
      for (let i = this.limitOrders.length - 1; i >= 0; i--) {
        if (this.limitOrders[i].source === 'BOT' && !this.limitOrders[i].hedgeGroupId) {
          this.limitOrders.splice(i, 1);
        }
      }
      const botPosIds = this.positions
        .filter((p) => p.source === 'BOT' && !p.hedgeGroupId)
        .map((p) => p.id);
      botPosIds.forEach((id) => this.closePosition(id, 'DAILY PROFIT LOCK'));

      const postLockMetrics = this.getMetrics();
      const finalDailyPnl = postLockMetrics.dailyPnlUsd;
      this.dailyProfitLocked = true;
      this.botRunning = false;
      this.dailyProfitLockReason = hitTarget
        ? `Đạt mục tiêu lãi ngày +$${finalDailyPnl.toFixed(2)} (ngưỡng +$${plan.dailyProfitLockUsd.toFixed(2)})`
        : `Bảo toàn tối thiểu 70% đỉnh lãi ngày (Đỉnh +$${this.dailyPeakProfitUsd.toFixed(2)}, chốt +$${finalDailyPnl.toFixed(2)})`;

      this._log('SHIELD', `🎯 DAILY PROFIT LOCK: ${this.dailyProfitLockReason} — Đã tự khóa lãi & tạm dừng Bot!`);
      this._emit('profitLocked', { reason: this.dailyProfitLockReason, dailyPnlUsd: finalDailyPnl, peakProfitUsd: this.dailyPeakProfitUsd });
      this._emit('toast', {
        type: 'pos',
        title: `🎯 ĐÃ KHÓA LÃI NGÀY (+$${finalDailyPnl.toFixed(2)})`,
        msg: `${this.dailyProfitLockReason}. Bấm "🔓 Mở Khóa Chạy Tiếp" nếu muốn mở phiên mới.`
      });
      this._emit('updated');
      return true;
    }

    _runBotStep(st) {
      if (this.botCooldown > 0) {
        this.botCooldown--;
        return;
      }
      if (this.positions.length >= 4 || this.limitOrders.length >= 4) {
        this.botCooldown = 6;
        return;
      }

      const sym = st.symbol;
      const profile = this.getCapitalProfile();
      const prefVenue = this.getPreferredVenue('HYPERLIQUID');
      const allowLong = this.botDirectionMode === 'AUTO' || this.botDirectionMode === 'LONG_ONLY';
      const allowShort = this.botDirectionMode === 'AUTO' || this.botDirectionMode === 'SHORT_ONLY';
      const scanSyms = profile.tier === 'MICRO'
        ? profile.preferredSymbols
        : [sym, ...Object.keys(this.market.instruments).filter((s) => s !== sym)];

      if (this.botDirectionMode === 'HEDGE' || this.botStrategy === 'DELTA_ARB') {
        if (this.liveConfig.connected && this.liveConfig.venueId) {
          const opened = this.executeAiSignalOrder({ symbol: sym, forceEntry: false, source: 'BOT' });
          if (opened) this.botCooldown = 12;
          return;
        }
        const opps = this.market.getArbitrageOpportunities();
        const activePairs = new Set(this.positions.filter((p) => p.hedgeGroupId).map((p) => p.symbol));
        if (activePairs.size < 2) {
          const best = opps.find((o) => (o.netAprPct >= 12 || o.netInstantEdgeBps > 1.0) && this.market.shockIntensity < 0.25 && !activePairs.has(o.symbol));
          if (best) {
            this.executeDeltaNeutralArb(best, profile.arbTotalNotional, 'BOT');
            this.botCooldown = 14;
            return;
          }
        }
        this.botCooldown = 6;
        return;
      }

      if (this._directionalPosCount() >= profile.maxConcurrentDirectional) {
        this.botCooldown = 6;
        return;
      }

      if (this.botStrategy === 'MOMENTUM') {
        const opened = this.executeAiSignalOrder({ symbol: sym, forceEntry: false, source: 'BOT' });
        if (opened) this.botCooldown = 12;
      } else if (this.botStrategy === 'GRID') {
        const sig = this.market.getDirectionalSignal(sym);
        if (Math.abs(sig.score) >= 40) {
          for (let i = this.limitOrders.length - 1; i >= 0; i--) {
            if (this.limitOrders[i].source === 'BOT' && this.limitOrders[i].symbol === sym && !this.limitOrders[i].hedgeGroupId) {
              this.limitOrders.splice(i, 1);
            }
          }
          this.botCooldown = 8;
          return;
        }
        if (Math.abs(sig.score) <= 22 && st.shockSigma < 0.85 && !this._hasSymbolExposure(sym) && this.limitOrders.length < 2) {
          const px = this.market.getPrice(sym, prefVenue);
          const slPct = Math.max(0.55, sig.suggestedSlPct || 0.65);
          const tpPct = Number(Math.max(slPct * 2.15, profile.minTpPct).toFixed(2));
          const stepFrac = Math.max(0.0022, ((sig.atrPct || 0.14) / 100) * 1.6);
          const sizeUsd = this.calculateOptimalSize({ symbol: sym, exchange: prefVenue, slPct, isMaker: true });
          let placed = false;
          if (allowLong) {
            if (this.placeLimitOrder({ symbol: sym, exchange: prefVenue, side: 'LONG', entryPrice: px * (1 - stepFrac), sizeUsd, leverage: profile.maxSafeLeverage, slPct, tpPct, source: 'BOT' })) placed = true;
          }
          if (allowShort && profile.maxConcurrentDirectional > 1) {
            if (this.placeLimitOrder({ symbol: sym, exchange: prefVenue, side: 'SHORT', entryPrice: px * (1 + stepFrac), sizeUsd, leverage: profile.maxSafeLeverage, slPct, tpPct, source: 'BOT' })) placed = true;
          }
          if (placed) this.botCooldown = 18;
        }
      } else if (this.botStrategy === 'STAT_ARB') {
        let bestArb = null;
        for (const candSym of scanSyms) {
          if (this._hasSymbolExposure(candSym)) continue;
          const cst = this.market.getSymbolState(candSym);
          if (!cst) continue;
          const sig = this.market.getDirectionalSignal(candSym);
          const mid = cst.price;
          const venuePx = this.market.getPrice(candSym, prefVenue);
          const diffBps = ((venuePx - mid) / Math.max(1e-9, mid)) * 10000;
          const side = (diffBps <= -1.4 && sig.score >= 26)
            ? 'LONG'
            : ((diffBps >= 1.4 && sig.score <= -26) ? 'SHORT' : null);
          if (!side) continue;
          if ((side === 'LONG' && !allowLong) || (side === 'SHORT' && !allowShort)) continue;
          const lastClosed = this.lastClosedMap[candSym];
          if (lastClosed && lastClosed.side === side && (this.tickCounter - lastClosed.tick) < 55) continue;
          if (!bestArb || Math.abs(diffBps) > Math.abs(bestArb.diffBps)) {
            bestArb = { sym: candSym, side, sig, diffBps };
          }
        }
        if (bestArb) {
          const slPct = bestArb.sig.suggestedSlPct || 0.55;
          const plan = this.computeCapitalPlan(undefined, undefined, { symbol: bestArb.sym, exchange: prefVenue, slPct, isMaker: false });
          const tpPct = Number(Math.max(bestArb.sig.suggestedTpPct || 1.25, plan.minTpPct).toFixed(2));
          const sizeUsd = this.calculateOptimalSize({ symbol: bestArb.sym, exchange: prefVenue, slPct, isMaker: false });
          const pos = this.placeMarketOrder({ symbol: bestArb.sym, exchange: prefVenue, side: bestArb.side, sizeUsd, leverage: plan.maxSafeLeverage, slPct, tpPct, source: 'BOT' });
          if (pos) this.botCooldown = 15;
        }
      } else if (this.botStrategy === 'MEAN_REV') {
        let bestMr = null;
        for (const candSym of scanSyms) {
          if (this._hasSymbolExposure(candSym)) continue;
          const sig = this.market.getDirectionalSignal(candSym);
          const cst = this.market.getSymbolState(candSym);
          if (!cst) continue;
          if (sig.zScore <= -1.75 && sig.rsi <= 35 && allowLong && cst.price > cst.prevPrice) {
            const lastClosed = this.lastClosedMap[candSym];
            if (lastClosed && lastClosed.side === 'LONG' && (this.tickCounter - lastClosed.tick) < 55) continue;
            if (!bestMr || Math.abs(sig.zScore) > Math.abs(bestMr.sig.zScore)) {
              bestMr = { sym: candSym, side: 'LONG', sig };
            }
          } else if (sig.zScore >= 1.75 && sig.rsi >= 65 && allowShort && cst.price < cst.prevPrice) {
            const lastClosed = this.lastClosedMap[candSym];
            if (lastClosed && lastClosed.side === 'SHORT' && (this.tickCounter - lastClosed.tick) < 55) continue;
            if (!bestMr || Math.abs(sig.zScore) > Math.abs(bestMr.sig.zScore)) {
              bestMr = { sym: candSym, side: 'SHORT', sig };
            }
          }
        }
        if (bestMr) {
          const slPct = bestMr.sig.suggestedSlPct || 0.55;
          const plan = this.computeCapitalPlan(undefined, undefined, { symbol: bestMr.sym, exchange: prefVenue, slPct, isMaker: false });
          const tpPct = Number(Math.max(slPct * 2.15, plan.minTpPct).toFixed(2));
          const sizeUsd = this.calculateOptimalSize({ symbol: bestMr.sym, exchange: prefVenue, slPct, isMaker: false });
          const pos = this.placeMarketOrder({ symbol: bestMr.sym, exchange: prefVenue, side: bestMr.side, sizeUsd, leverage: plan.maxSafeLeverage, slPct, tpPct, source: 'BOT' });
          if (pos) {
            this._log('BOT', `🤖 MEAN_REV Confirmed Bounce ${bestMr.side} ${bestMr.sym} trên ${prefVenue} (Z ${bestMr.sig.zScore.toFixed(2)} | RSI ${Math.round(bestMr.sig.rsi)})`);
            this.botCooldown = 15;
          }
        }
      }
    }
  }

  return TradingEngine;
});
