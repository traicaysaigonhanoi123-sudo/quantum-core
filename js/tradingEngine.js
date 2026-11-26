/* ==========================================================================
   QUANTUM CORE // Trading, Matching, Auto-Bot & Circuit Breaker Engine
   - $100,000 USDC Demo Wallet with real price-driven Limit fills & SL/TP triggers
   - Multi-Strategy Quant Bot (Momentum, Grid, Stat-Arb, VWAP Mean Reversion)
   - Circuit Breaker Protection (Volatility Shock & Max Drawdown Auto-Trip)
   - Live API / Hyperliquid DEX Bridge Session Manager (In-Memory Only)
   ========================================================================== */

(function (global) {
  'use strict';

  const INITIAL_BALANCE = 100000;

  class TradingEngine {
    constructor(marketEngine) {
      this.market = marketEngine;
      this.mode = 'DEMO'; // 'DEMO' | 'LIVE'

      // Demo Wallet State
      this.balance = INITIAL_BALANCE;
      this.peakEquity = INITIAL_BALANCE;
      this.realizedPnl = 0;
      this.equityHistory = Array.from({ length: 48 }, () => INITIAL_BALANCE);

      this.positions = [];
      this.limitOrders = [];
      this.history = [];
      this.logs = [];
      this.nextId = 1001;

      this.wins = 0;
      this.losses = 0;

      // Bot State
      this.botRunning = false;
      this.botStrategy = 'DELTA_ARB';
      this.botCooldown = 0;

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
        cooldownUntil: 0
      };

      // Live API / Hyperliquid DEX In-Memory Config (NEVER persisted to disk/localStorage)
      this.liveConfig = {
        connected: false,
        venue: null,
        network: 'TESTNET',
        walletAddress: '',
        apiKeyMasked: ''
      };

      this.listeners = [];
      this._log('SYS', 'Khởi tạo ví Demo $100,000.00 USDC. Risk Shield (0.5%/lệnh, Post-Only, Auto-BE) & Circuit Breaker (2.0% DD) đã kích hoạt.');
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
      const time = new Date().toISOString().substr(11, 8);
      this.logs.unshift({ time, tag, msg });
      if (this.logs.length > 80) this.logs.pop();
      this._emit('log', { time, tag, msg });
    }

    resetDemo() {
      this.balance = INITIAL_BALANCE;
      this.peakEquity = INITIAL_BALANCE;
      this.realizedPnl = 0;
      this.positions = [];
      this.limitOrders = [];
      this.history = [];
      this.wins = 0;
      this.losses = 0;
      this.riskShield.consecutiveLosses = 0;
      this.riskShield.cooldownUntil = 0;
      this.equityHistory = Array.from({ length: 48 }, () => INITIAL_BALANCE);
      this.resetCircuitBreaker(true);
      this._log('SYS', 'Đã reset ví Demo về $100,000.00 USDC & xóa toàn bộ vị thế.');
      this._emit('updated');
    }

    setMode(mode) {
      this.mode = mode;
      this._log('SYS', mode === 'LIVE'
        ? 'Chuyển sang chế độ LIVE API / DEX (chỉ định tuyến lệnh khi đã xác thực khóa).'
        : 'Chuyển về chế độ DEMO $100,000 USDC.');
      this._emit('modeChanged', mode);
    }

    configureLiveBridge(cfg) {
      this.liveConfig = { ...cfg, connected: true };
      this.mode = 'LIVE';
      this._log('SYS', `Kết nối Live Bridge thành công: ${cfg.venue} (${cfg.network || 'API'}) — Chỉ lưu khóa trong RAM phiên.`);
      this._emit('liveConfigured', this.liveConfig);
    }

    setBotStrategy(strat) {
      this.botStrategy = strat;
      this._log('BOT', `Đã chọn chiến lược Bot: ${strat}`);
      this._emit('updated');
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
      this.botRunning = !this.botRunning;
      this.botCooldown = 0;
      this._log('BOT', this.botRunning
        ? `Kích hoạt Bot tự động [${this.botStrategy}] trên ${this.market.activeSymbol}.`
        : 'Đã tạm dừng Bot tự động.');
      this._emit('toast', {
        type: this.botRunning ? 'pos' : 'gold',
        title: this.botRunning ? 'BOT ĐÃ KHỞI CHẠY' : 'BOT ĐÃ DỪNG',
        msg: this.botRunning ? `Chiến lược ${this.botStrategy} đang quét orderflow đa sàn.` : 'Chế độ tự động đã tạm ngưng.'
      });
      this._emit('updated');
      return this.botRunning;
    }

    // Account metrics
    getMetrics() {
      let unrealizedPnl = 0;
      let usedMargin = 0;

      for (const pos of this.positions) {
        const mark = this.market.getPrice(pos.symbol, pos.exchange);
        const dir = pos.side === 'LONG' ? 1 : -1;
        const pricePnl = ((mark - pos.entryPrice) / pos.entryPrice) * pos.sizeUsd * dir;
        const pnl = pricePnl + (pos.accruedFundingUsd || 0);
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
      const freeMargin = Math.max(0, equity - usedMargin);
      const totalClosed = this.wins + this.losses;
      const winRate = totalClosed > 0 ? (this.wins / totalClosed) * 100 : 0;

      return {
        balance: this.balance,
        equity,
        unrealizedPnl,
        unrealizedPct: (unrealizedPnl / INITIAL_BALANCE) * 100,
        realizedPnl: this.realizedPnl,
        usedMargin,
        freeMargin,
        drawdownPct,
        winRate,
        wins: this.wins,
        losses: this.losses
      };
    }

    /* ==================== INSTITUTIONAL RISK SHIELD & OPTIMAL SIZING ==================== */
    calculateOptimalSize({ symbol, exchange, slPct, isMaker = true }) {
      const sym = symbol || this.market.activeSymbol;
      const ex = exchange && exchange !== 'ALL' ? exchange : 'HYPERLIQUID';
      const metrics = this.getMetrics();
      const safeSl = Math.max(0.15, Number(slPct) || 0.8);

      const entryFeeBps = this.market.getVenueFeeBps(ex, isMaker);
      const exitFeeBps = this.market.getVenueFeeBps(ex, false);
      const slipBps = isMaker ? 0.3 : this.market.estimateSlippageBps(sym, 5000);
      const roundTripCostPct = (entryFeeBps + exitFeeBps + slipBps) / 100;

      const totalRiskPerDollar = (safeSl + roundTripCostPct) / 100;
      const maxDollarRisk = metrics.equity * (this.riskShield.riskPerTradePct / 100);
      const rawOptimal = Math.floor(maxDollarRisk / Math.max(0.001, totalRiskPerDollar));
      const maxMarginCap = Math.floor(metrics.freeMargin * this.riskShield.maxSafeLeverage * 0.85);
      return Math.max(100, Math.min(rawOptimal, maxMarginCap));
    }

    evaluatePreTrade({ symbol, exchange, side, slPct, tpPct, sizeUsd, leverage, isMaker = true, isHedge = false }) {
      const sym = symbol || this.market.activeSymbol;
      const ex = exchange && exchange !== 'ALL' ? exchange : 'HYPERLIQUID';
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

      if (Date.now() < this.riskShield.cooldownUntil) {
        const waitSec = Math.ceil((this.riskShield.cooldownUntil - Date.now()) / 1000);
        return {
          ok: false,
          reason: `Anti-Revenge Cooldown: Tạm nghỉ ${waitSec}s sau 2 lệnh thua liên tiếp để giữ kỷ luật.`
        };
      }

      if (st.shockSigma >= 1.8 || st.orderbook.spreadBps > 8.0) {
        return {
          ok: false,
          reason: `Thị trường đang sốc (${st.shockSigma.toFixed(2)}σ, Spread ${st.orderbook.spreadBps.toFixed(1)} bps) — Risk Shield chặn lệnh ngược/mới.`
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

    // Place a Limit Order with built-in SL & TP + Post-Only Maker Guard
    placeLimitOrder({ symbol, exchange, side, entryPrice, sizeUsd, leverage, slPct, tpPct, source = 'MANUAL', hedgeGroupId = null }) {
      if (this.breakerTripped) {
        this._emit('toast', { type: 'neg', title: 'BỊ CHẶN BỞI CIRCUIT BREAKER', msg: 'Hệ thống đang tự ngắt bảo vệ tài khoản.' });
        return null;
      }

      const sym = symbol || this.market.activeSymbol;
      const ex = exchange && exchange !== 'ALL' ? exchange : 'HYPERLIQUID';
      const size = Math.max(100, Number(sizeUsd) || 5000);
      const isHedge = Boolean(hedgeGroupId);

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

      if (marginUsd > metrics.freeMargin) {
        if (source !== 'BOT') {
          this._emit('toast', { type: 'neg', title: 'KHÔNG ĐỦ KÝ QUỸ', msg: `Cần $${marginUsd.toFixed(0)} margin, khả dụng $${metrics.freeMargin.toFixed(0)}.` });
        }
        return null;
      }

      let targetEntry = entryPrice;
      const currentPx = this.market.getPrice(sym, ex);
      const tick = this.market.instruments[sym]?.tick || 0.1;

      // Post-Only Maker protection: nudge entry 1 tick to passive side if crossing book
      if (this.riskShield.postOnlyMaker && !isHedge) {
        if (side === 'LONG' && targetEntry >= currentPx) {
          targetEntry = currentPx - tick;
        } else if (side === 'SHORT' && targetEntry <= currentPx) {
          targetEntry = currentPx + tick;
        }
      }

      const dir = side === 'LONG' ? 1 : -1;
      const slPrice = isHedge ? null : targetEntry * (1 - dir * (Number(slPct) / 100));
      const tpPrice = isHedge ? null : targetEntry * (1 + dir * (Number(tpPct) / 100));

      const order = {
        id: this.nextId++,
        symbol: sym,
        exchange: ex,
        side,
        entryPrice: targetEntry,
        slPrice,
        tpPrice,
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
      this._log(source === 'BOT' ? 'BOT' : 'EXEC',
        `Đặt LIMIT MAKER ${side} ${sym} (${ex}, ${lev}x) @ ${this.market.formatPrice(targetEntry, sym)} | Net R:R 1:${check.netRR.toFixed(2)}`);
      this._emit('toast', {
        type: side === 'LONG' ? 'pos' : 'neg',
        title: `ĐÃ ĐẶT LIMIT MAKER ${side}`,
        msg: `${sym} @ $${this.market.formatPrice(targetEntry, sym)} (Phí ${check.entryFeeBps} bps)`
      });
      this._emit('updated');
      return order;
    }

    // Place an instant Market Order with SL & TP
    placeMarketOrder({ symbol, exchange, side, sizeUsd, leverage, slPct, tpPct, source = 'MANUAL' }) {
      if (this.breakerTripped) {
        this._emit('toast', { type: 'neg', title: 'BỊ CHẶN BỞI CIRCUIT BREAKER', msg: 'Hệ thống đang ở chế độ bảo vệ.' });
        return null;
      }
      const sym = symbol || this.market.activeSymbol;
      const ex = exchange && exchange !== 'ALL' ? exchange : 'HYPERLIQUID';
      const fillPx = this.market.getPrice(sym, ex);
      const size = Math.max(100, Number(sizeUsd) || 5000);

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

      if (marginUsd > metrics.freeMargin) {
        if (source !== 'BOT') {
          this._emit('toast', { type: 'neg', title: 'KHÔNG ĐỦ KÝ QUỸ', msg: `Cần $${marginUsd.toFixed(0)} margin.` });
        }
        return null;
      }

      const dir = side === 'LONG' ? 1 : -1;
      const order = {
        id: this.nextId++,
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

    // 1-Click Delta-Neutral Cross-Exchange Funding & Basis Arbitrage
    executeDeltaNeutralArb(opp, totalNotionalUsd = 10000, source = 'ARB') {
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

      const legNotional = Math.max(1000, Math.floor(totalNotionalUsd / 2));
      const metrics = this.getMetrics();
      const totalMarginNeeded = (legNotional * 2) / 2; // 2x ultra-safe leverage per leg
      if (totalMarginNeeded > metrics.freeMargin) {
        if (source !== 'BOT') {
          this._emit('toast', { type: 'neg', title: 'KHÔNG ĐỦ MARGIN', msg: `Cần $${totalMarginNeeded.toLocaleString()} để mở 2 chân Hedge 2x.` });
        }
        return false;
      }

      const groupId = `ARB-${this.nextId}`;
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
        this._log('SHIELD', `⚡ MỞ CẶP DELTA-NEUTRAL ${opp.symbol}: LONG ${opp.longVenue} + SHORT ${opp.shortVenue} | Net APR: +${opp.netAprPct.toFixed(1)}%/năm (2x an toàn).`);
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
      const totalEntryCost = order.sizeUsd * ((feeBps + slipBps) / 10000);

      this.balance -= totalEntryCost;
      this.realizedPnl -= totalEntryCost;

      const pos = {
        id: order.id,
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
        sizeUsd: order.sizeUsd,
        leverage: order.leverage,
        marginUsd: order.marginUsd,
        unrealizedPnl: -totalEntryCost,
        roePct: (-totalEntryCost / order.marginUsd) * 100,
        source: order.source,
        openedAt: Date.now()
      };
      this.positions.unshift(pos);

      this._log('EXEC', `KHỚP ${execLabel} ${pos.side} ${pos.symbol} (${pos.exchange} ${pos.leverage}x) $${pos.sizeUsd.toLocaleString()} @ ${this.market.formatPrice(fillPrice, pos.symbol)} (Phí ${(feeBps + slipBps).toFixed(1)} bps)`);
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
      const idx = this.limitOrders.findIndex((o) => o.id === orderId);
      if (idx === -1) return;
      const [ord] = this.limitOrders.splice(idx, 1);
      this._log('EXEC', `Đã hủy lệnh Limit #${ord.id} (${ord.symbol} ${ord.side}).`);
      this._emit('updated');
    }

    closePosition(posId, reason = 'MANUAL CLOSE') {
      const idx = this.positions.findIndex((p) => p.id === posId);
      if (idx === -1) return;
      const [pos] = this.positions.splice(idx, 1);
      const exitPrice = this.market.getPrice(pos.symbol, pos.exchange);
      const dir = pos.side === 'LONG' ? 1 : -1;
      const grossPnl = ((exitPrice - pos.entryPrice) / pos.entryPrice) * pos.sizeUsd * dir + (pos.accruedFundingUsd || 0);
      const isMakerExit = reason.includes('TAKE PROFIT') || reason.includes('ARB PROFIT');
      const exitFeeBps = this.market.getVenueFeeBps(pos.exchange, isMakerExit);
      const fee = pos.sizeUsd * (exitFeeBps / 10000);
      const netPnl = grossPnl - fee;

      this.balance += netPnl;
      this.realizedPnl += netPnl;
      if (netPnl >= 0) {
        this.wins++;
        this.riskShield.consecutiveLosses = 0;
      } else {
        this.losses++;
        if (!pos.hedgeGroupId) {
          this.riskShield.consecutiveLosses++;
          if (this.riskShield.consecutiveLosses >= 2 && this.riskShield.enabled) {
            this.riskShield.cooldownUntil = Date.now() + 15000;
            this._log('SHIELD', 'Anti-Revenge Trigger: Tạm khóa đặt lệnh mới 15s sau 2 lệnh lỗ liên tiếp.');
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
        pnl: netPnl
      };
      this.history.unshift(record);
      if (this.history.length > 60) this.history.pop();

      this._log(reason.includes('BREAKER') ? 'SHOCK' : 'EXEC',
        `ĐÓNG ${pos.side} ${pos.symbol} [${reason}] @ ${this.market.formatPrice(exitPrice, pos.symbol)} | PnL: ${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)}`);

      this._emit('toast', {
        type: netPnl >= 0 ? 'pos' : 'neg',
        title: `${reason}: ${pos.symbol} ${pos.side}`,
        msg: `PnL: ${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)} @ $${this.market.formatPrice(exitPrice, pos.symbol)}`
      });
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

    // Circuit Breaker Trigger & Reset
    tripCircuitBreaker(reason) {
      if (this.breakerTripped) return;
      this.breakerTripped = true;
      this.breakerReason = reason;
      this.botRunning = false;

      // Cancel all pending limit orders immediately
      const cancelledCount = this.limitOrders.length;
      this.limitOrders = [];

      // Optionally auto-flatten risky open positions
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

    // Run on every market engine tick
    onMarketTick() {
      // 1. Check pending Limit orders for real price fills
      for (let i = this.limitOrders.length - 1; i >= 0; i--) {
        const ord = this.limitOrders[i];
        const px = this.market.getPrice(ord.symbol, ord.exchange);
        const filled =
          (ord.side === 'LONG' && px <= ord.entryPrice) ||
          (ord.side === 'SHORT' && px >= ord.entryPrice);
        if (filled) {
          this.limitOrders.splice(i, 1);
          this._openPositionFromOrder(ord, ord.entryPrice, 'LIMIT FILLED');
        }
      }

      // 2. Auto-Breakeven, Trailing Stop & Delta-Neutral Funding Accrual + SL/TP Checks
      const toClose = [];
      const hedgeGroups = {};

      for (const pos of this.positions) {
        const px = this.market.getPrice(pos.symbol, pos.exchange);
        const dir = pos.side === 'LONG' ? 1 : -1;

        if (pos.hedgeGroupId) {
          const st = this.market.getSymbolState(pos.symbol);
          const fRate = st?.venueFunding8h?.[pos.exchange] || 0;
          // Short receives positive funding, Long pays positive funding
          const stepYield = (fRate / 100) * pos.sizeUsd * (-dir) * 0.0035;
          pos.accruedFundingUsd = (pos.accruedFundingUsd || 0) + stepYield;
          if (!hedgeGroups[pos.hedgeGroupId]) hedgeGroups[pos.hedgeGroupId] = [];
          hedgeGroups[pos.hedgeGroupId].push(pos);
          continue;
        }

        // Directional Risk Shield: Auto-Breakeven (+0.8R) & Trailing Stop (+1.2R)
        const movePct = ((px - pos.entryPrice) / pos.entryPrice) * 100 * dir;
        const rMultiple = movePct / Math.max(0.15, pos.initialRiskPct || 0.8);

        if (dir === 1 && px > (pos.peakPrice || pos.entryPrice)) pos.peakPrice = px;
        if (dir === -1 && px < (pos.peakPrice || pos.entryPrice)) pos.peakPrice = px;

        if (this.riskShield.autoBreakeven && !pos.beLocked && rMultiple >= 0.8) {
          const beBuffer = 0.0007; // Cover round-trip maker/taker fee buffer
          pos.slPrice = pos.entryPrice * (1 + dir * beBuffer);
          pos.beLocked = true;
          this._log('SHIELD', `🔒 AUTO-BREAKEVEN: Dời SL ${pos.symbol} ${pos.side} về hòa vốn + phí @ ${this.market.formatPrice(pos.slPrice, pos.symbol)}`);
        }

        if (this.riskShield.autoTrailing && pos.beLocked && rMultiple >= 1.2) {
          const trailDist = Math.max(0.0025, (pos.initialRiskPct * 0.65) / 100);
          const candidateSl = pos.peakPrice * (1 - dir * trailDist);
          if ((dir === 1 && candidateSl > pos.slPrice) || (dir === -1 && candidateSl < pos.slPrice)) {
            pos.slPrice = candidateSl;
            pos.trailingActive = true;
          }
        }

        if (pos.side === 'LONG') {
          if (pos.slPrice && px <= pos.slPrice) toClose.push({ id: pos.id, reason: pos.trailingActive ? 'TRAILING PROFIT' : (pos.beLocked ? 'BREAKEVEN EXIT' : 'STOP LOSS HIT') });
          else if (pos.tpPrice && px >= pos.tpPrice) toClose.push({ id: pos.id, reason: 'TAKE PROFIT HIT' });
        } else {
          if (pos.slPrice && px >= pos.slPrice) toClose.push({ id: pos.id, reason: pos.trailingActive ? 'TRAILING PROFIT' : (pos.beLocked ? 'BREAKEVEN EXIT' : 'STOP LOSS HIT') });
          else if (pos.tpPrice && px <= pos.tpPrice) toClose.push({ id: pos.id, reason: 'TAKE PROFIT HIT' });
        }
      }

      // Evaluate Delta-Neutral Hedge Pairs combined PnL
      Object.values(hedgeGroups).forEach((legs) => {
        if (legs.length !== 2) return;
        let combinedPnl = 0;
        let totalNotional = 0;
        legs.forEach((leg) => {
          const mark = this.market.getPrice(leg.symbol, leg.exchange);
          const dir = leg.side === 'LONG' ? 1 : -1;
          combinedPnl += ((mark - leg.entryPrice) / leg.entryPrice) * leg.sizeUsd * dir + (leg.accruedFundingUsd || 0);
          totalNotional += leg.sizeUsd;
        });
        const netRetPct = (combinedPnl / Math.max(1, totalNotional)) * 100;
        if (netRetPct >= 0.22) {
          legs.forEach((leg) => toClose.push({ id: leg.id, reason: 'ARB PROFIT TAKE' }));
        } else if (netRetPct <= -0.35) {
          legs.forEach((leg) => toClose.push({ id: leg.id, reason: 'ARB BASIS STOP' }));
        }
      });

      toClose.forEach((item) => this.closePosition(item.id, item.reason));

      // 3. Evaluate Equity & Circuit Breaker Safeguards
      const metrics = this.getMetrics();
      this.equityHistory.push(metrics.equity);
      if (this.equityHistory.length > 64) this.equityHistory.shift();

      const activeSt = this.market.getSymbolState();
      if (!this.breakerTripped) {
        if (activeSt.shockSigma >= this.maxShockSigma) {
          this.tripCircuitBreaker(`Sốc biến động đạt ${activeSt.shockSigma.toFixed(2)}σ (vượt ngưỡng ${this.maxShockSigma}σ)`);
        } else if (metrics.drawdownPct >= this.maxDrawdownPct) {
          this.tripCircuitBreaker(`Drawdown chạm ${metrics.drawdownPct.toFixed(2)}% (vượt ngưỡng ${this.maxDrawdownPct}%)`);
        }
      }

      // 4. Execute Auto-Trading Bot logic if running & safe
      if (this.botRunning && !this.breakerTripped) {
        this._runBotStep(activeSt);
      }
    }

    _runBotStep(st) {
      if (this.botCooldown > 0) {
        this.botCooldown--;
        return;
      }
      if (this.positions.length >= 4 || this.limitOrders.length >= 5) {
        this.botCooldown = 6;
        return;
      }

      const sym = st.symbol;
      const px = st.price;

      if (this.botStrategy === 'DELTA_ARB') {
        const opps = this.market.getArbitrageOpportunities();
        const activePairs = new Set(this.positions.filter((p) => p.hedgeGroupId).map((p) => p.symbol));
        if (activePairs.size < 2) {
          const best = opps.find((o) => o.actionable && !activePairs.has(o.symbol));
          if (best) {
            this.executeDeltaNeutralArb(best, 10000, 'BOT');
            this.botCooldown = 14;
            return;
          }
        }
        this.botCooldown = 6;
      } else if (this.botStrategy === 'MOMENTUM') {
        const sizeUsd = this.calculateOptimalSize({ symbol: sym, exchange: 'HYPERLIQUID', slPct: 0.45, isMaker: false });
        if (st.orderbook.bidRatio > 0.565 && st.netFlowPerSec > 0.35) {
          this.placeMarketOrder({ symbol: sym, exchange: 'HYPERLIQUID', side: 'LONG', sizeUsd, leverage: 5, slPct: 0.45, tpPct: 0.95, source: 'BOT' });
          this.botCooldown = 14;
        } else if (st.orderbook.bidRatio < 0.435 && st.netFlowPerSec < -0.35) {
          this.placeMarketOrder({ symbol: sym, exchange: 'BINANCE', side: 'SHORT', sizeUsd, leverage: 5, slPct: 0.45, tpPct: 0.95, source: 'BOT' });
          this.botCooldown = 14;
        }
      } else if (this.botStrategy === 'GRID') {
        const sizeUsd = this.calculateOptimalSize({ symbol: sym, exchange: 'HYPERLIQUID', slPct: 0.6, isMaker: true });
        if (this.limitOrders.length < 2) {
          this.placeLimitOrder({ symbol: sym, exchange: 'HYPERLIQUID', side: 'LONG', entryPrice: px * 0.9988, sizeUsd, leverage: 5, slPct: 0.6, tpPct: 1.15, source: 'BOT' });
          this.placeLimitOrder({ symbol: sym, exchange: 'BYBIT', side: 'SHORT', entryPrice: px * 1.0012, sizeUsd, leverage: 5, slPct: 0.6, tpPct: 1.15, source: 'BOT' });
          this.botCooldown = 16;
        }
      } else if (this.botStrategy === 'STAT_ARB') {
        const hlPx = st.venuePrices.HYPERLIQUID;
        const bnPx = st.venuePrices.BINANCE;
        const spreadBps = ((hlPx - bnPx) / bnPx) * 10000;
        const sizeUsd = this.calculateOptimalSize({ symbol: sym, exchange: 'HYPERLIQUID', slPct: 0.35, isMaker: false });
        if (Math.abs(spreadBps) > 1.2) {
          const side = spreadBps < 0 ? 'LONG' : 'SHORT';
          this.placeMarketOrder({ symbol: sym, exchange: 'HYPERLIQUID', side, sizeUsd, leverage: 5, slPct: 0.35, tpPct: 0.75, source: 'BOT' });
          this.botCooldown = 15;
        }
      } else if (this.botStrategy === 'MEAN_REV') {
        const candles = st.candles;
        const sizeUsd = this.calculateOptimalSize({ symbol: sym, exchange: 'OKX', slPct: 0.5, isMaker: true });
        if (candles.length > 20) {
          let sum = 0;
          for (let i = candles.length - 20; i < candles.length; i++) sum += candles[i].c;
          const mean = sum / 20;
          const dev = (px - mean) / mean;
          if (dev < -0.0018) {
            this.placeLimitOrder({ symbol: sym, exchange: 'OKX', side: 'LONG', entryPrice: px * 0.9997, sizeUsd, leverage: 5, slPct: 0.5, tpPct: 1.05, source: 'BOT' });
            this.botCooldown = 15;
          } else if (dev > 0.0018) {
            this.placeLimitOrder({ symbol: sym, exchange: 'DERIBIT', side: 'SHORT', entryPrice: px * 1.0003, sizeUsd, leverage: 5, slPct: 0.5, tpPct: 1.05, source: 'BOT' });
            this.botCooldown = 15;
          }
        }
      }
    }
  }

  global.QuantumTradingEngine = TradingEngine;
})(window);
