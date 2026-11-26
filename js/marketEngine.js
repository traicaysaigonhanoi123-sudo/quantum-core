/* ==========================================================================
   QUANTUM CORE // Multi-Exchange Market & Orderflow Engine
   Supports 5 Venues: Hyperliquid DEX, Binance, Bybit, OKX, Deribit
   + Optional Live Public WebSocket Bridge (Binance / Hyperliquid)
   + Volatility Shock / Flash Crash Simulator
   ========================================================================== */

(function (global) {
  'use strict';

  const EXCHANGES = [
    { id: 'HYPERLIQUID', name: 'HYPERLIQUID', tag: 'DEX L1',   color: '#34d399', baseLatency: 11, weight: 0.25, makerBps: 1.0, takerBps: 3.5 },
    { id: 'BINANCE',     name: 'BINANCE',     tag: 'CEX PERP', color: '#fbbf24', baseLatency: 14, weight: 0.30, makerBps: 2.0, takerBps: 5.0 },
    { id: 'BYBIT',       name: 'BYBIT',       tag: 'LINEAR',   color: '#fb923c', baseLatency: 18, weight: 0.18, makerBps: 2.0, takerBps: 5.5 },
    { id: 'OKX',         name: 'OKX',         tag: 'SWAP',     color: '#60a5fa', baseLatency: 21, weight: 0.15, makerBps: 1.5, takerBps: 5.0 },
    { id: 'DERIBIT',     name: 'DERIBIT',     tag: 'VOL/PERP', color: '#c084fc', baseLatency: 24, weight: 0.12, makerBps: 0.0, takerBps: 5.0 }
  ];

  const INSTRUMENTS = {
    'BTC-PERP':  { base: 94280.5, tick: 0.5,   vol: 0.00055, oi: 18.42, wsBinance: 'btcusdt',  hlCoin: 'BTC',  decimals: 1 },
    'ETH-PERP':  { base: 3412.8,  tick: 0.1,   vol: 0.00072, oi: 8.75,  wsBinance: 'ethusdt',  hlCoin: 'ETH',  decimals: 2 },
    'SOL-PERP':  { base: 218.45,  tick: 0.01,  vol: 0.00095, oi: 3.64,  wsBinance: 'solusdt',  hlCoin: 'SOL',  decimals: 2 },
    'HYPE-PERP': { base: 26.84,   tick: 0.005, vol: 0.00145, oi: 1.18,  wsBinance: null,       hlCoin: 'HYPE', decimals: 3 }
  };

  class MarketEngine {
    constructor() {
      this.exchanges = EXCHANGES;
      this.instruments = INSTRUMENTS;
      this.activeSymbol = 'BTC-PERP';
      this.activeExchange = 'ALL';
      this.timeframe = '1s';

      this.state = {};
      this.listeners = [];
      this.wsEnabled = false;
      this.wsSockets = {};
      this.hlPollTimer = null;

      // Shock / Flash Crash simulation state
      this.shockIntensity = 0; // 0..1
      this.shockDirection = -1;
      this.shockTicksRemaining = 0;
      this.shockHeadline = '';

      this._initAllSymbols();
    }

    _initAllSymbols() {
      Object.keys(INSTRUMENTS).forEach((sym) => {
        const cfg = INSTRUMENTS[sym];
        const candles = this._seedCandles(cfg.base, cfg.vol, 110);
        const lastClose = candles[candles.length - 1].c;
        const venuePrices = {};
        const venueScores = {};
        const venueFlow = {};
        const venueFunding8h = {};

        EXCHANGES.forEach((ex, idx) => {
          venuePrices[ex.id] = lastClose * (1 + (idx - 2) * 0.00004);
          venueScores[ex.id] = Math.round(62 - idx * 5 + Math.random() * 6);
          venueFlow[ex.id] = (Math.random() - 0.45) * 850000;
          // Realistic 8h funding dispersion across exchanges (-0.006% to +0.028%)
          const seedOffsets = [0.0175, 0.0085, 0.0112, 0.0054, -0.0028];
          venueFunding8h[ex.id] = seedOffsets[idx] + (Math.random() - 0.5) * 0.006;
        });

        this.state[sym] = {
          symbol: sym,
          open24h: cfg.base * (1 - (Math.random() * 0.03 - 0.01)),
          price: lastClose,
          prevPrice: lastClose,
          funding8h: venueFunding8h.BINANCE,
          oiBillions: cfg.oi,
          candles,
          currentCandle: { ...candles[candles.length - 1] },
          candleTickCounter: 0,
          orderbook: { asks: [], bids: [], bidRatio: 0.54, spread: cfg.tick * 2 },
          tape: [],
          cvdHistory: Array.from({ length: 70 }, (_, i) => Math.sin(i * 0.14) * 1.6 + (Math.random() - 0.45) * 0.8),
          cvd: 0.85,
          realizedVol: 36 + Math.random() * 12,
          shockSigma: 0.35,
          orderflowIndex: 1290,
          netFlowPerSec: 1.24,
          venuePrices,
          venueScores,
          venueFlow,
          venueFunding8h,
          radarAxes: [0.34, 0.42, 0.28, 0.51, 0.38, 0.31], // Vol, Skew, Spread, LiqRisk, Depth, Gamma
          liveWsPrice: null,
          liveHlPrice: null
        };

        this._rebuildOrderbook(this.state[sym]);
        for (let i = 0; i < 20; i++) {
          this._pushTapePrint(this.state[sym], true);
        }
      });
    }

    _seedCandles(basePrice, vol, count) {
      const arr = [];
      let p = basePrice * (0.992 + Math.random() * 0.012);
      const now = Date.now();
      for (let i = count; i > 0; i--) {
        const drift = (basePrice - p) * 0.025;
        const move = (Math.random() - 0.492) * vol * 3.1 * p + drift;
        const o = p;
        const c = Math.max(basePrice * 0.82, o + move);
        const wickUp = Math.random() * vol * 1.8 * p;
        const wickDn = Math.random() * vol * 1.8 * p;
        const h = Math.max(o, c) + wickUp;
        const l = Math.min(o, c) - wickDn;
        const v = 12 + Math.random() * 88;
        arr.push({ t: now - i * 1000, o, h, l, c, v });
        p = c;
      }
      return arr;
    }

    getSymbolState(sym = this.activeSymbol) {
      return this.state[sym];
    }

    getPrice(sym = this.activeSymbol, exchange = this.activeExchange) {
      const st = this.state[sym];
      if (!st) return 0;
      if (exchange && exchange !== 'ALL' && st.venuePrices[exchange]) {
        return st.venuePrices[exchange];
      }
      return st.price;
    }

    getDecimals(sym = this.activeSymbol) {
      return INSTRUMENTS[sym]?.decimals ?? 2;
    }

    formatPrice(val, sym = this.activeSymbol) {
      const dec = this.getDecimals(sym);
      return Number(val).toLocaleString('en-US', {
        minimumFractionDigits: dec,
        maximumFractionDigits: dec
      });
    }

    setSymbol(sym) {
      if (this.state[sym]) {
        this.activeSymbol = sym;
        this._emit('symbolChanged', sym);
      }
    }

    setExchange(exId) {
      this.activeExchange = exId;
      this._emit('exchangeChanged', exId);
    }

    setTimeframe(tf) {
      this.timeframe = tf;
      this._emit('timeframeChanged', tf);
    }

    on(fn) {
      this.listeners.push(fn);
    }

    _emit(type, payload) {
      for (let i = 0; i < this.listeners.length; i++) {
        this.listeners[i](type, payload);
      }
    }

    // Trigger extreme volatility shock / bad news cascade
    triggerShock(direction = -1) {
      const headlines = [
        'BREAKING: Đột biến thanh lý $420M Long trên đa sàn — Spread giãn rộng đột ngột!',
        'FLASH NEWS: Tin xấu vĩ mô & dòng rút thanh khoản lớn trên Hyperliquid / Binance!',
        'WHALE CASCADE: Lệnh Market Sell $185M quét sạch sổ lệnh 5 sàn liên tiếp!'
      ];
      this.shockDirection = direction;
      this.shockIntensity = 1.0;
      this.shockTicksRemaining = 26;
      this.shockHeadline = headlines[Math.floor(Math.random() * headlines.length)];
      this._emit('shockStarted', { headline: this.shockHeadline, direction });
    }

    clearShock() {
      this.shockIntensity = 0;
      this.shockTicksRemaining = 0;
    }

    // Optional Live Public WebSocket + Hyperliquid REST Price/Funding Bridge
    toggleLiveWebSocket(enable) {
      this.wsEnabled = enable;
      if (this.hlPollTimer) {
        clearInterval(this.hlPollTimer);
        this.hlPollTimer = null;
      }
      if (!enable) {
        Object.values(this.wsSockets).forEach((ws) => {
          try { ws.close(); } catch (_) {}
        });
        this.wsSockets = {};
        Object.values(this.state).forEach((st) => {
          st.liveWsPrice = null;
          st.liveHlPrice = null;
        });
        this._emit('wsStatus', { connected: false, text: 'LIVE WS: OFF' });
        return;
      }

      this._emit('wsStatus', { connected: false, text: 'LIVE WS: CONNECTING...' });
      let connectedCount = 0;

      Object.entries(INSTRUMENTS).forEach(([sym, cfg]) => {
        if (!cfg.wsBinance) return;
        try {
          const ws = new WebSocket(`wss://fstream.binance.com/ws/${cfg.wsBinance}@markPrice@1s`);
          ws.onopen = () => {
            connectedCount++;
            this._emit('wsStatus', { connected: true, text: `LIVE WS: ON (${connectedCount})` });
          };
          ws.onmessage = (evt) => {
            try {
              const data = JSON.parse(evt.data);
              const px = parseFloat(data.p);
              if (Number.isFinite(px) && px > 0) {
                const st = this.state[sym];
                st.liveWsPrice = px;
                st.venuePrices.BINANCE = px;
                if (data.r) {
                  const fPct = parseFloat(data.r) * 100;
                  st.funding8h = fPct;
                  st.venueFunding8h.BINANCE = fPct;
                }
              }
            } catch (_) {}
          };
          ws.onerror = () => {
            this._emit('wsStatus', { connected: connectedCount > 0, text: connectedCount > 0 ? `LIVE WS: ON (${connectedCount})` : 'LIVE WS: FALLBACK' });
          };
          this.wsSockets[sym] = ws;
        } catch (_) {
          this._emit('wsStatus', { connected: false, text: 'LIVE WS: FALLBACK' });
        }
      });

      // Poll live Hyperliquid DEX mark prices & 8h-normalized funding rates
      const pollHyperliquid = async () => {
        if (!this.wsEnabled) return;
        try {
          const res = await fetch('https://api.hyperliquid.xyz/info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'metaAndAssetCtxs' })
          });
          if (!res.ok) return;
          const json = await res.json();
          const universe = json?.[0]?.universe;
          const ctxs = json?.[1];
          if (!Array.isArray(universe) || !Array.isArray(ctxs)) return;

          Object.entries(INSTRUMENTS).forEach(([sym, cfg]) => {
            const idx = universe.findIndex((u) => u.name === cfg.hlCoin);
            if (idx === -1 || !ctxs[idx]) return;
            const mark = parseFloat(ctxs[idx].markPx);
            const hourlyFunding = parseFloat(ctxs[idx].funding);
            const st = this.state[sym];
            if (Number.isFinite(mark) && mark > 0) {
              st.liveHlPrice = mark;
              st.venuePrices.HYPERLIQUID = mark;
              if (!st.liveWsPrice) st.liveWsPrice = mark;
            }
            if (Number.isFinite(hourlyFunding)) {
              // Hyperliquid quotes 1h funding; multiply by 8 to normalize to 8h funding %
              st.venueFunding8h.HYPERLIQUID = hourlyFunding * 8 * 100;
            }
          });
        } catch (_) {
          // Silent fallback to synthetic/Binance feed if offline or blocked by CORS
        }
      };

      pollHyperliquid();
      this.hlPollTimer = setInterval(pollHyperliquid, 6000);
    }

    getVenueFeeBps(exchangeId, isMaker = true) {
      const targetId = exchangeId && exchangeId !== 'ALL' ? exchangeId : 'HYPERLIQUID';
      const ex = EXCHANGES.find((e) => e.id === targetId) || EXCHANGES[0];
      return isMaker ? ex.makerBps : ex.takerBps;
    }

    estimateSlippageBps(sym = this.activeSymbol, sizeUsd = 5000) {
      const cfg = INSTRUMENTS[sym] || INSTRUMENTS['BTC-PERP'];
      const liqFactor = Math.max(0.4, cfg.oi / 18.42);
      const sizeImpact = (sizeUsd / 100000) * (1.25 / liqFactor);
      const shockPenalty = this.shockIntensity * 14.0;
      return Math.min(45, 0.35 + sizeImpact + shockPenalty);
    }

    getArbitrageOpportunities() {
      const list = [];
      Object.keys(this.state).forEach((sym) => {
        const st = this.state[sym];
        let bestLong = null;
        let bestShort = null;

        // Pick best pair across exchanges optimizing net 8h funding spread & price basis
        for (let i = 0; i < EXCHANGES.length; i++) {
          for (let j = 0; j < EXCHANGES.length; j++) {
            if (i === j) continue;
            const exL = EXCHANGES[i];
            const exS = EXCHANGES[j];
            const pL = st.venuePrices[exL.id];
            const pS = st.venuePrices[exS.id];
            const fL = st.venueFunding8h[exL.id];
            const fS = st.venueFunding8h[exS.id];

            // Net 8h carry: short receives fS, long pays fL => (fS - fL) in %
            const netFunding8h = fS - fL;
            const basisBps = ((pS - pL) / pL) * 10000;
            const roundTripMakerFeeBps = (exL.makerBps + exS.makerBps) * 2;
            const netAprPct = netFunding8h * 3 * 365; // 3 funding intervals/day * 365
            const score = netAprPct + basisBps * 2.5 - roundTripMakerFeeBps * 0.4;

            if (!bestLong || score > bestLong.score) {
              bestLong = {
                symbol: sym,
                longVenue: exL.id,
                shortVenue: exS.id,
                longPrice: pL,
                shortPrice: pS,
                basisBps,
                longFunding8h: fL,
                shortFunding8h: fS,
                netFunding8h,
                netAprPct,
                roundTripMakerFeeBps,
                netInstantEdgeBps: basisBps - roundTripMakerFeeBps,
                actionable: (netAprPct >= 10 || basisBps - roundTripMakerFeeBps > 1.5) && this.shockIntensity < 0.25,
                score
              };
            }
          }
        }
        if (bestLong) list.push(bestLong);
      });

      list.sort((a, b) => b.netAprPct - a.netAprPct);
      return list;
    }

    // Core simulation tick (called every ~220ms)
    tick() {
      const tfTicks = { '1s': 4, '5s': 12, '1m': 24, '5m': 45 }[this.timeframe] || 4;

      if (this.shockTicksRemaining > 0) {
        this.shockTicksRemaining--;
        this.shockIntensity = Math.max(0.18, this.shockTicksRemaining / 26);
      } else {
        this.shockIntensity = Math.max(0, this.shockIntensity * 0.86 - 0.01);
      }

      Object.keys(this.state).forEach((sym) => {
        const st = this.state[sym];
        const cfg = INSTRUMENTS[sym];
        st.prevPrice = st.price;

        // Price evolution: either track real WS + microstructure or smooth quant SDE
        let deltaPct;
        if (this.shockIntensity > 0.15) {
          // Violent flash crash / volatility whip
          const shockImpulse = this.shockDirection * (0.0022 + Math.random() * 0.0046) * this.shockIntensity;
          const whip = (Math.random() - 0.5) * 0.0038 * this.shockIntensity;
          deltaPct = shockImpulse + whip;
        } else if (this.wsEnabled && st.liveWsPrice) {
          const gap = (st.liveWsPrice - st.price) / st.price;
          deltaPct = gap * 0.45 + (Math.random() - 0.5) * cfg.vol * 0.35;
        } else {
          // Mean-reverting + momentum microstructure noise
          const noise = (Math.random() + Math.random() - 1) * cfg.vol * 1.15;
          const microTrend = Math.sin(Date.now() * 0.00018 + cfg.oi) * cfg.vol * 0.28;
          deltaPct = noise + microTrend;
        }

        st.price = Math.max(cfg.tick * 10, st.price * (1 + deltaPct));

        // Update 5 exchanges with realistic cross-venue basis, funding & liquidity scores
        let totalFlow = 0;
        EXCHANGES.forEach((ex, idx) => {
          const basisNoise = (Math.random() - 0.5) * (0.00028 + this.shockIntensity * 0.0022);
          const venueBias = (idx === 0 ? 0.00008 : idx === 4 ? -0.00006 : 0);
          if (!(this.wsEnabled && ex.id === 'HYPERLIQUID' && st.liveHlPrice)) {
            st.venuePrices[ex.id] = st.price * (1 + basisNoise + venueBias);
          }

          // Smoothly evolve per-venue 8h funding rates
          const fDrift = (Math.random() - 0.49) * 0.0006;
          st.venueFunding8h[ex.id] = Math.max(-0.025, Math.min(0.055, st.venueFunding8h[ex.id] + fDrift));

          const flowDelta = (deltaPct * 680000000 + (Math.random() - 0.5) * 950000) * ex.weight;
          st.venueFlow[ex.id] = st.venueFlow[ex.id] * 0.72 + flowDelta * 0.28;
          totalFlow += st.venueFlow[ex.id];

          const targetScore = Math.max(
            18,
            Math.min(
              98,
              Math.round(64 - idx * 5 + Math.sin(Date.now() * 0.0009 + idx * 1.7) * 8 - this.shockIntensity * 22 + (Math.random() - 0.5) * 3)
            )
          );
          st.venueScores[ex.id] = targetScore;
        });

        st.netFlowPerSec = totalFlow / 1e6;
        st.orderflowIndex = Math.max(420, Math.round(1290 + st.netFlowPerSec * 48 + Math.sin(Date.now() * 0.001) * 35));

        // Update current OHLC candle
        const c = st.currentCandle;
        c.c = st.price;
        c.h = Math.max(c.h, st.price);
        c.l = Math.min(c.l, st.price);
        c.v += (2.5 + Math.random() * 14) * (1 + this.shockIntensity * 4.5);
        st.candles[st.candles.length - 1] = { ...c };

        st.candleTickCounter++;
        if (st.candleTickCounter >= tfTicks) {
          st.candleTickCounter = 0;
          const nextCandle = {
            t: Date.now(),
            o: st.price,
            h: st.price,
            l: st.price,
            c: st.price,
            v: 4 + Math.random() * 8
          };
          st.currentCandle = nextCandle;
          st.candles.push(nextCandle);
          if (st.candles.length > 130) st.candles.shift();
        }

        // CVD & Volatility metrics
        const cvdStep = (deltaPct * 420) + (Math.random() - 0.5) * 0.35;
        st.cvd = Math.max(-25, Math.min(25, st.cvd + cvdStep));
        st.cvdHistory.push(st.cvd);
        if (st.cvdHistory.length > 85) st.cvdHistory.shift();

        const targetVol = 34 + Math.abs(deltaPct) * 28000 + this.shockIntensity * 96;
        st.realizedVol = st.realizedVol * 0.85 + targetVol * 0.15;

        const targetSigma = 0.35 + Math.abs(deltaPct) * 420 + this.shockIntensity * 3.85;
        st.shockSigma = st.shockSigma * 0.78 + targetSigma * 0.22;

        // Update 6 Radar axes (0..1)
        const s = this.shockIntensity;
        st.radarAxes = [
          Math.min(1, 0.28 + (st.realizedVol / 145) + s * 0.45),
          Math.min(1, 0.34 + Math.abs(st.funding8h) * 14 + s * 0.35),
          Math.min(1, 0.22 + s * 0.72 + Math.random() * 0.08),
          Math.min(1, 0.26 + s * 0.74 + Math.abs(deltaPct) * 65),
          Math.min(1, Math.max(0.12, 0.68 - s * 0.45 + Math.random() * 0.06)),
          Math.min(1, 0.32 + Math.sin(Date.now() * 0.0012) * 0.12 + s * 0.48)
        ];

        this._rebuildOrderbook(st);
        if (sym === this.activeSymbol) {
          const printCount = this.shockIntensity > 0.2 ? 3 : 1;
          for (let k = 0; k < printCount; k++) {
            this._pushTapePrint(st, false);
          }
        }
      });

      this._emit('tick', this.getSymbolState());
    }

    _rebuildOrderbook(st) {
      const cfg = INSTRUMENTS[st.symbol];
      const mid = this.getPrice(st.symbol, this.activeExchange);
      const spreadMult = 1 + this.shockIntensity * 8.5;
      const halfSpread = cfg.tick * spreadMult;

      const asks = [];
      const bids = [];
      let cumAsk = 0;
      let cumBid = 0;

      const levels = 9;
      for (let i = 0; i < levels; i++) {
        const askPx = mid + halfSpread + i * cfg.tick * (1.2 + this.shockIntensity * 2.5);
        const bidPx = mid - halfSpread - i * cfg.tick * (1.2 + this.shockIntensity * 2.5);

        const depthFactor = Math.max(0.25, 1 - this.shockIntensity * 0.62);
        const askQty = (0.4 + Math.random() * 4.8 * (i + 1) * 0.45) * depthFactor * (cfg.base < 500 ? 18 : 1);
        const bidQty = (0.4 + Math.random() * 4.8 * (i + 1) * 0.45) * depthFactor * (cfg.base < 500 ? 18 : 1) * (this.shockIntensity > 0.25 ? 0.55 : 1.06);

        cumAsk += askQty * askPx;
        cumBid += bidQty * bidPx;

        asks.push({ price: askPx, qty: askQty, totalUsd: cumAsk });
        bids.push({ price: bidPx, qty: bidQty, totalUsd: cumBid });
      }

      const maxTotal = Math.max(cumAsk, cumBid, 1);
      asks.forEach((a) => { a.pct = Math.min(100, (a.totalUsd / maxTotal) * 100); });
      bids.forEach((b) => { b.pct = Math.min(100, (b.totalUsd / maxTotal) * 100); });

      st.orderbook = {
        asks: asks.reverse(),
        bids,
        spread: halfSpread * 2,
        spreadBps: ((halfSpread * 2) / mid) * 10000,
        bidRatio: cumBid / (cumBid + cumAsk)
      };
    }

    _pushTapePrint(st, silent) {
      const ex = EXCHANGES[Math.floor(Math.random() * EXCHANGES.length)];
      const isBuy = this.shockIntensity > 0.25
        ? (this.shockDirection > 0 ? Math.random() < 0.82 : Math.random() < 0.18)
        : (st.price >= st.prevPrice ? Math.random() < 0.62 : Math.random() < 0.38);

      const isWhale = Math.random() < (this.shockIntensity > 0.25 ? 0.28 : 0.08);
      const usdSize = isWhale
        ? (180000 + Math.random() * 950000)
        : (2500 + Math.random() * 64000);

      const now = new Date();
      const ts = now.toISOString().substr(11, 8);
      const print = {
        exchange: ex.id,
        shortEx: ex.id === 'HYPERLIQUID' ? 'HL-DEX' : ex.id.slice(0, 3),
        side: isBuy ? 'BUY' : 'SELL',
        price: st.venuePrices[ex.id] || st.price,
        usdSize,
        whale: isWhale,
        time: ts
      };

      st.tape.unshift(print);
      if (st.tape.length > 34) st.tape.pop();

      if (!silent) {
        this._emit('tradePrint', { symbol: st.symbol, print });
      }
    }
  }

  global.QuantumMarketEngine = MarketEngine;
})(window);
