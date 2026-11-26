/* ==========================================================================
   QUANTUM CORE // Multi-Exchange Market & Orderflow Engine (Standardized UMD)
   - Validates all external ticks via QuantumSchemas.validateMarketTick
   - Uses UUID v4 on trade prints (no sequential IDs)
   - Provides per-venue fees, slippage estimation & Delta-Neutral Arb scanner
   ========================================================================== */

(function (root, factory) {
  let uuidMod = root?.QuantumUUID;
  let schemaMod = root?.QuantumSchemas;
  if (typeof require === 'function') {
    try { uuidMod = uuidMod || require('../core/uuid.js'); } catch (_) {}
    try { schemaMod = schemaMod || require('../core/schemas.js'); } catch (_) {}
  }
  const MarketEngine = factory(uuidMod, schemaMod);
  if (typeof module === 'object' && module.exports) {
    module.exports = MarketEngine;
  }
  if (root) {
    root.QuantumMarketEngine = MarketEngine;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function (QuantumUUID, QuantumSchemas) {
  'use strict';

  const EXCHANGES = [
    { id: 'HYPERLIQUID', name: 'HYPERLIQUID', tag: 'DEX L1',   color: '#34d399', baseLatency: 11, weight: 0.25, makerBps: 1.0, takerBps: 3.5 },
    { id: 'BINANCE',     name: 'BINANCE',     tag: 'CEX PERP', color: '#fbbf24', baseLatency: 14, weight: 0.30, makerBps: 2.0, takerBps: 5.0 },
    { id: 'BYBIT',       name: 'BYBIT',       tag: 'LINEAR',   color: '#fb923c', baseLatency: 18, weight: 0.18, makerBps: 2.0, takerBps: 5.5 },
    { id: 'OKX',         name: 'OKX',         tag: 'SWAP',     color: '#60a5fa', baseLatency: 21, weight: 0.15, makerBps: 1.5, takerBps: 5.0 },
    { id: 'DERIBIT',     name: 'DERIBIT',     tag: 'VOL/PERP', color: '#c084fc', baseLatency: 24, weight: 0.12, makerBps: 0.0, takerBps: 5.0 }
  ];

  const DEFAULT_INSTRUMENTS = {
    'BTC-PERP':  { base: 58585.0, tick: 0.5,     vol: 0.00055, oi: 18.42, wsBinance: 'btcusdt',  bybitSym: 'BTCUSDT',  okxInst: 'BTC-USDT-SWAP',  deribitInst: 'BTC-PERPETUAL',      hlCoin: 'BTC',  decimals: 1 },
    'ETH-PERP':  { base: 1642.4,  tick: 0.1,     vol: 0.00072, oi: 8.75,  wsBinance: 'ethusdt',  bybitSym: 'ETHUSDT',  okxInst: 'ETH-USDT-SWAP',  deribitInst: 'ETH-PERPETUAL',      hlCoin: 'ETH',  decimals: 2 },
    'SOL-PERP':  { base: 67.88,   tick: 0.01,    vol: 0.00095, oi: 3.64,  wsBinance: 'solusdt',  bybitSym: 'SOLUSDT',  okxInst: 'SOL-USDT-SWAP',  deribitInst: 'SOL_USDC-PERPETUAL', hlCoin: 'SOL',  decimals: 2 },
    'HYPE-PERP': { base: 58.12,   tick: 0.005,   vol: 0.00145, oi: 1.18,  wsBinance: 'hypeusdt', bybitSym: 'HYPEUSDT', okxInst: 'HYPE-USDT-SWAP', deribitInst: 'HYPE_USDC-PERPETUAL',hlCoin: 'HYPE', decimals: 3 },
    'BNB-PERP':  { base: 539.4,   tick: 0.1,     vol: 0.00075, oi: 2.15,  wsBinance: 'bnbusdt',  bybitSym: 'BNBUSDT',  okxInst: 'BNB-USDT-SWAP',  deribitInst: 'BNB_USDC-PERPETUAL', hlCoin: 'BNB',  decimals: 2 },
    'XRP-PERP':  { base: 0.9085,  tick: 0.0001,  vol: 0.00105, oi: 1.85,  wsBinance: 'xrpusdt',  bybitSym: 'XRPUSDT',  okxInst: 'XRP-USDT-SWAP',  deribitInst: 'XRP_USDC-PERPETUAL', hlCoin: 'XRP',  decimals: 4 },
    'DOGE-PERP': { base: 0.05375, tick: 0.00001, vol: 0.00125, oi: 1.42,  wsBinance: 'dogeusdt', bybitSym: 'DOGEUSDT', okxInst: 'DOGE-USDT-SWAP', deribitInst: 'DOGE_USDC-PERPETUAL',hlCoin: 'DOGE', decimals: 5 }
  };

  const DYNAMIC_SYMBOL_REGEX = /^[A-Z0-9]{2,16}-PERP$/;

  const VENUE_SYMBOLS = {
    ALL:         ['BTC-PERP', 'ETH-PERP', 'SOL-PERP', 'HYPE-PERP', 'BNB-PERP', 'XRP-PERP'],
    HYPERLIQUID: ['BTC-PERP', 'ETH-PERP', 'SOL-PERP', 'HYPE-PERP', 'XRP-PERP', 'DOGE-PERP'],
    BINANCE:     ['BTC-PERP', 'ETH-PERP', 'SOL-PERP', 'BNB-PERP', 'XRP-PERP', 'HYPE-PERP'],
    BYBIT:       ['BTC-PERP', 'ETH-PERP', 'SOL-PERP', 'HYPE-PERP', 'XRP-PERP', 'DOGE-PERP'],
    OKX:         ['BTC-PERP', 'ETH-PERP', 'SOL-PERP', 'XRP-PERP', 'BNB-PERP', 'DOGE-PERP'],
    DERIBIT:     ['BTC-PERP', 'ETH-PERP', 'SOL-PERP', 'HYPE-PERP', 'BNB-PERP']
  };

  class MarketEngine {
    constructor(deps = {}) {
      this._uuid = deps.QuantumUUID || QuantumUUID;
      this._schemas = deps.QuantumSchemas || QuantumSchemas;

      this.exchanges = EXCHANGES;
      this.coreSymbols = Object.keys(DEFAULT_INSTRUMENTS);
      this.instruments = Object.fromEntries(
        Object.entries(DEFAULT_INSTRUMENTS).map(([k, v]) => [k, { ...v }])
      );
      this.venueCatalog = { ALL: [], HYPERLIQUID: [], BINANCE: [], BYBIT: [], OKX: [], DERIBIT: [] };
      this.activeSymbol = 'BTC-PERP';
      this.activeExchange = 'ALL';
      this.timeframe = '1s';

      this.state = {};
      this.listeners = [];
      this.wsEnabled = false;
      this._liveWsStarted = false;
      this.wsSockets = {};
      this.dynamicWsOrder = [];
      this.hlPollTimer = null;
      this.otherVenuesPollTimer = null;
      this.klinePollTimer = null;

      this.shockIntensity = 0;
      this.shockDirection = -1;
      this.shockTicksRemaining = 0;
      this.shockHeadline = '';

      // Institutional Pre-Entry Filters (5m MTF Trend Alignment + News-Spike Guard)
      this.mtfFilterEnabled = true;
      this.newsSpikeFilterEnabled = true;

      this._initAllSymbols();
    }

    _inferPrecision(price) {
      const p = Math.abs(Number(price) || 0);
      if (p >= 10000) return { decimals: 1, tick: 0.5 };
      if (p >= 1000) return { decimals: 2, tick: 0.1 };
      if (p >= 100) return { decimals: 2, tick: 0.05 };
      if (p >= 10) return { decimals: 3, tick: 0.005 };
      if (p >= 1) return { decimals: 4, tick: 0.0005 };
      if (p >= 0.05) return { decimals: 5, tick: 0.00001 };
      if (p >= 0.001) return { decimals: 6, tick: 0.000001 };
      return { decimals: 8, tick: 0.00000001 };
    }

    _initSingleSymbol(sym, overrideBasePrice = null) {
      const cfg = this.instruments[sym];
      if (!cfg) return null;
      const basePx = (Number.isFinite(overrideBasePrice) && overrideBasePrice > 0) ? overrideBasePrice : cfg.base;
      const candles = this._seedCandles(basePx, cfg.vol, 110);
      const lastClose = candles[candles.length - 1].c;
      const venuePrices = {};
      const venueScores = {};
      const venueFlow = {};
      const venueFunding8h = {};
      const venueBasis = {};

      EXCHANGES.forEach((ex, idx) => {
        const initBasis = (idx - 2) * 0.00004;
        venueBasis[ex.id] = initBasis;
        venuePrices[ex.id] = lastClose * (1 + initBasis);
        venueScores[ex.id] = Math.round(62 - idx * 5 + Math.random() * 6);
        venueFlow[ex.id] = (Math.random() - 0.45) * 850000;
        const seedOffsets = [0.0175, 0.0085, 0.0112, 0.0054, -0.0028];
        venueFunding8h[ex.id] = seedOffsets[idx] + (Math.random() - 0.5) * 0.006;
      });

      const lastCandle = candles[candles.length - 1];
      const prevCandle = candles[Math.max(0, candles.length - 4)];
      const seedDir = lastCandle.c >= prevCandle.c ? 1 : -1;
      const st = {
        symbol: sym,
        open24h: basePx * (1 - (Math.random() * 0.03 - 0.01)),
        price: lastClose,
        prevPrice: lastClose,
        funding8h: venueFunding8h.BINANCE,
        oiBillions: cfg.oi,
        candles,
        signalCandles: candles.map((c) => ({ ...c })),
        currentCandle: { ...candles[candles.length - 1] },
        candleTickCounter: 0,
        regimeDrift: seedDir * 0.48,
        regimeTarget: seedDir * (0.62 + Math.random() * 0.35),
        regimeTicksLeft: 75 + Math.floor(Math.random() * 65),
        flowImbalance: seedDir * 0.16,
        orderbook: { asks: [], bids: [], bidRatio: 0.54, spread: cfg.tick * 2, spreadBps: 1.4 },
        tape: [],
        cvdHistory: Array.from({ length: 70 }, (_, i) => Math.sin(i * 0.14) * 1.6 + (Math.random() - 0.45) * 0.8),
        cvd: 0.85,
        realizedVol: 36 + Math.random() * 12,
        shockSigma: 0.35,
        orderflowIndex: 1290,
        netFlowPerSec: 1.24,
        venuePrices,
        venueBasis,
        venueScores,
        venueFlow,
        venueFunding8h,
        venueChange24hPct: {},
        radarAxes: [0.34, 0.42, 0.28, 0.51, 0.38, 0.31],
        liveWsPrice: null,
        liveHlPrice: null,
        liveVenuePrices: {}
      };

      this.state[sym] = st;
      this._rebuildOrderbook(st);
      for (let i = 0; i < 20; i++) {
        this._pushTapePrint(st, true);
      }
      return st;
    }

    _seedInitialCatalogs() {
      const seedOrder = Object.keys(this.instruments);
      ['HYPERLIQUID', 'BINANCE', 'BYBIT', 'OKX', 'DERIBIT'].forEach((exId) => {
        const syms = VENUE_SYMBOLS[exId] || seedOrder;
        this.venueCatalog[exId] = syms.map((sym, idx) => {
          const cfg = this.instruments[sym];
          const st = this.state[sym];
          return {
            symbol: sym,
            baseCoin: sym.split('-')[0],
            venue: exId,
            venueSymbol: exId === 'BINANCE' ? cfg.wsBinance?.toUpperCase() : (exId === 'BYBIT' ? cfg.bybitSym : (exId === 'OKX' ? cfg.okxInst : (exId === 'DERIBIT' ? cfg.deribitInst : cfg.hlCoin))),
            price: st ? st.venuePrices[exId] : cfg.base,
            change24hPct: 0,
            funding8h: st ? st.venueFunding8h[exId] : 0.01,
            volume24hUsd: Math.max(1e6, cfg.oi * 1e9 * (1 - idx * 0.05))
          };
        });
      });
      this._rebuildMergedCatalog();
    }

    _initAllSymbols() {
      Object.keys(this.instruments).forEach((sym) => {
        this._initSingleSymbol(sym);
      });
      this._seedInitialCatalogs();
    }

    _seedCandles(basePrice, vol, count) {
      const arr = [];
      let p = basePrice * (0.992 + Math.random() * 0.012);
      const now = Date.now();
      let segTicksLeft = 18 + Math.floor(Math.random() * 24);
      let segTarget = (Math.random() < 0.5 ? 1 : -1) * (0.55 + Math.random() * 0.45);
      let segDrift = segTarget * 0.4;

      for (let i = count; i > 0; i--) {
        segTicksLeft--;
        if (segTicksLeft <= 0) {
          segTicksLeft = 16 + Math.floor(Math.random() * 22);
          const meanPull = ((basePrice - p) / Math.max(1e-9, basePrice)) * 2.5;
          segTarget = Math.max(-1.2, Math.min(1.2, (Math.random() < 0.5 ? 1 : -1) * (0.5 + Math.random() * 0.55) + meanPull));
        }
        segDrift = segDrift * 0.85 + segTarget * 0.15;
        const move = (segDrift * 0.95 + (Math.random() + Math.random() - 1) * 1.25) * vol * p;
        const o = p;
        const c = Math.max(basePrice * 0.82, o + move);
        const wickUp = Math.random() * vol * 1.3 * p;
        const wickDn = Math.random() * vol * 1.3 * p;
        arr.push({
          t: now - i * 1000,
          o,
          h: Math.max(o, c) + wickUp,
          l: Math.min(o, c) - wickDn,
          c,
          v: 12 + Math.random() * 88
        });
        p = c;
      }
      return arr;
    }

    getSymbolState(sym = this.activeSymbol) {
      return this.state[sym];
    }

    getVenueSymbols(exchange = this.activeExchange) {
      const baseList = (VENUE_SYMBOLS[exchange] || VENUE_SYMBOLS.ALL).slice();
      const act = this.activeSymbol;
      if (act && !baseList.includes(act)) {
        const cat = this.venueCatalog?.[exchange] || [];
        const isInVenue = exchange === 'ALL' || this.state[act] || cat.some((c) => c.symbol === act);
        if (isInVenue) {
          return [act, ...baseList.slice(0, 5)];
        }
      }
      return baseList;
    }

    getVenueCatalog(exchange = this.activeExchange) {
      return (this.venueCatalog?.[exchange] || this.venueCatalog?.ALL || []).slice();
    }

    _rebuildMergedCatalog() {
      const mergedMap = new Map();
      const order = ['BINANCE', 'HYPERLIQUID', 'BYBIT', 'OKX', 'DERIBIT'];
      order.forEach((exId) => {
        const rows = this.venueCatalog[exId] || [];
        rows.forEach((item) => {
          const existing = mergedMap.get(item.symbol);
          if (!existing) {
            mergedMap.set(item.symbol, {
              ...item,
              venue: exId,
              venues: [exId]
            });
          } else {
            if (!existing.venues.includes(exId)) existing.venues.push(exId);
            if ((item.volume24hUsd || 0) > (existing.volume24hUsd || 0)) {
              existing.price = item.price;
              existing.volume24hUsd = item.volume24hUsd;
              existing.venue = exId;
              if (Number.isFinite(item.change24hPct)) existing.change24hPct = item.change24hPct;
            }
            if (existing.funding8h === undefined && Number.isFinite(item.funding8h)) {
              existing.funding8h = item.funding8h;
            }
          }
        });
      });
      this.venueCatalog.ALL = Array.from(mergedMap.values()).sort((a, b) => (b.volume24hUsd || 0) - (a.volume24hUsd || 0));
    }

    ingestVenueCatalog(venueId, items) {
      if (!venueId || !Array.isArray(items)) return [];
      const dedup = new Map();
      for (const raw of items) {
        if (!raw || typeof raw !== 'object') continue;
        const sym = String(raw.symbol || '').toUpperCase().trim();
        const px = Number(raw.price);
        if (!DYNAMIC_SYMBOL_REGEX.test(sym) || !Number.isFinite(px) || px <= 0) continue;
        const prev = dedup.get(sym);
        const vol = Number.isFinite(Number(raw.volume24hUsd)) ? Math.max(0, Number(raw.volume24hUsd)) : 0;
        if (prev && (prev.volume24hUsd || 0) >= vol) continue;
        dedup.set(sym, {
          symbol: sym,
          baseCoin: raw.baseCoin || sym.split('-')[0],
          venue: venueId,
          venueSymbol: raw.venueSymbol || '',
          price: px,
          change24hPct: Number.isFinite(Number(raw.change24hPct)) ? Number(raw.change24hPct) : undefined,
          funding8h: Number.isFinite(Number(raw.funding8h)) ? Number(raw.funding8h) : undefined,
          volume24hUsd: vol
        });
      }

      const cleaned = Array.from(dedup.values()).sort((a, b) => (b.volume24hUsd || 0) - (a.volume24hUsd || 0));
      this.venueCatalog[venueId] = cleaned;

      // Sync quotes into all registered/active instruments cleanly
      cleaned.forEach((item) => {
        const cfg = this.instruments[item.symbol];
        const st = this.state[item.symbol];
        if (!cfg || !st) return;
        if (venueId === 'HYPERLIQUID' && item.venueSymbol && !cfg.hlCoin) cfg.hlCoin = item.venueSymbol;
        else if (venueId === 'BINANCE' && item.venueSymbol && !cfg.wsBinance) cfg.wsBinance = item.venueSymbol.toLowerCase();
        else if (venueId === 'BYBIT' && item.venueSymbol && !cfg.bybitSym) cfg.bybitSym = item.venueSymbol;
        else if (venueId === 'OKX' && item.venueSymbol && !cfg.okxInst) cfg.okxInst = item.venueSymbol;
        else if (venueId === 'DERIBIT' && item.venueSymbol && !cfg.deribitInst) cfg.deribitInst = item.venueSymbol;

        if (venueId === 'HYPERLIQUID') st.liveHlPrice = item.price;
        if (venueId === 'BINANCE' || !st.liveWsPrice) st.liveWsPrice = item.price;
        this.applyLiveVenueQuote(item.symbol, venueId, item.price, item.funding8h, item.change24hPct);
      });

      this._rebuildMergedCatalog();
      this._emit('catalogUpdated', {
        venue: venueId,
        count: cleaned.length,
        allCount: this.venueCatalog.ALL.length
      });
      return cleaned;
    }

    ensureInstrument(rawSym, hintMeta = {}) {
      let sym = String(rawSym || '').toUpperCase().trim();
      if (sym && !sym.endsWith('-PERP')) sym = `${sym}-PERP`;
      if (!DYNAMIC_SYMBOL_REGEX.test(sym)) return null;

      if (this._schemas && typeof this._schemas.registerSymbol === 'function') {
        this._schemas.registerSymbol(sym);
      } else if (this._schemas?.VALID_SYMBOLS instanceof Set) {
        this._schemas.VALID_SYMBOLS.add(sym);
      }

      const venueMatches = {};
      ['HYPERLIQUID', 'BINANCE', 'BYBIT', 'OKX', 'DERIBIT'].forEach((vId) => {
        const hit = (this.venueCatalog[vId] || []).find((x) => x.symbol === sym);
        if (hit) venueMatches[vId] = hit;
      });
      const allHit = (this.venueCatalog.ALL || []).find((x) => x.symbol === sym);

      const refPrice = Number(hintMeta.price)
        || allHit?.price
        || Object.values(venueMatches)[0]?.price
        || this.instruments[sym]?.base
        || 10;
      const { decimals, tick } = this._inferPrecision(refPrice);

      if (!this.instruments[sym]) {
        const maxVol = Math.max(
          Number(hintMeta.volume24hUsd) || 0,
          allHit?.volume24hUsd || 0,
          ...Object.values(venueMatches).map((m) => m.volume24hUsd || 0)
        );
        this.instruments[sym] = {
          base: refPrice,
          tick,
          vol: 0.0011,
          oi: Math.max(0.05, Number((maxVol / 1e9).toFixed(2)) || 0.25),
          wsBinance: venueMatches.BINANCE?.venueSymbol ? venueMatches.BINANCE.venueSymbol.toLowerCase() : null,
          bybitSym: venueMatches.BYBIT?.venueSymbol || null,
          okxInst: venueMatches.OKX?.venueSymbol || null,
          deribitInst: venueMatches.DERIBIT?.venueSymbol || null,
          hlCoin: venueMatches.HYPERLIQUID?.venueSymbol || null,
          decimals,
          dynamic: true
        };
      } else {
        const cfg = this.instruments[sym];
        if (!cfg.wsBinance && venueMatches.BINANCE?.venueSymbol) cfg.wsBinance = venueMatches.BINANCE.venueSymbol.toLowerCase();
        if (!cfg.bybitSym && venueMatches.BYBIT?.venueSymbol) cfg.bybitSym = venueMatches.BYBIT.venueSymbol;
        if (!cfg.okxInst && venueMatches.OKX?.venueSymbol) cfg.okxInst = venueMatches.OKX.venueSymbol;
        if (!cfg.deribitInst && venueMatches.DERIBIT?.venueSymbol) cfg.deribitInst = venueMatches.DERIBIT.venueSymbol;
        if (!cfg.hlCoin && venueMatches.HYPERLIQUID?.venueSymbol) cfg.hlCoin = venueMatches.HYPERLIQUID.venueSymbol;
      }

      if (!this.state[sym]) {
        this._initSingleSymbol(sym, refPrice);
      }

      const st = this.state[sym];
      Object.entries(venueMatches).forEach(([vId, item]) => {
        if (vId === 'HYPERLIQUID') st.liveHlPrice = item.price;
        if (vId === 'BINANCE' || !st.liveWsPrice) st.liveWsPrice = item.price;
        this.applyLiveVenueQuote(sym, vId, item.price, item.funding8h, item.change24hPct);
      });

      if (this._liveWsStarted && this.wsEnabled && this.instruments[sym].wsBinance && !this.wsSockets[sym]) {
        this._openBinanceWsForSymbol(sym);
      }
      return st;
    }

    selectDynamicSymbol(rawSym, exchange = this.activeExchange, hintMeta = {}) {
      const st = this.ensureInstrument(rawSym, hintMeta);
      if (!st) return null;
      if (exchange && exchange !== this.activeExchange && this.venueCatalog[exchange]) {
        this.activeExchange = exchange;
      }
      this.activeSymbol = st.symbol;
      if (this.wsEnabled) {
        this.fetchVenueKlines(st.symbol, this.activeExchange);
      }
      this._emit('symbolChanged', st.symbol);
      return st;
    }

    getPrice(sym = this.activeSymbol, exchange = this.activeExchange) {
      const st = this.state[sym];
      if (!st) return 0;
      if (exchange && exchange !== 'ALL' && st.venuePrices[exchange]) {
        return st.venuePrices[exchange];
      }
      return st.price;
    }

    getChange24hPct(sym = this.activeSymbol, exchange = this.activeExchange) {
      const st = this.state[sym];
      if (!st) return 0;
      if (exchange && exchange !== 'ALL' && Number.isFinite(st.venueChange24hPct?.[exchange])) {
        return st.venueChange24hPct[exchange];
      }
      if (exchange === 'ALL' && Number.isFinite(st.venueChange24hPct?.BINANCE)) {
        return st.venueChange24hPct.BINANCE;
      }
      const px = this.getPrice(sym, exchange);
      return ((px - st.open24h) / Math.max(1e-9, st.open24h)) * 100;
    }

    getFunding8h(sym = this.activeSymbol, exchange = this.activeExchange) {
      const st = this.state[sym];
      if (!st) return 0;
      if (exchange && exchange !== 'ALL' && Number.isFinite(st.venueFunding8h?.[exchange])) {
        return st.venueFunding8h[exchange];
      }
      return st.funding8h;
    }

    getVenueCandles(sym = this.activeSymbol, exchange = this.activeExchange) {
      const st = this.state[sym];
      if (!st) return [];
      if (!exchange || exchange === 'ALL' || !st.venuePrices[exchange]) {
        return st.candles;
      }
      const offset = st.venuePrices[exchange] - st.price;
      if (Math.abs(offset) < 1e-12) return st.candles;
      return st.candles.map((c) => ({
        t: c.t,
        o: c.o + offset,
        h: c.h + offset,
        l: c.l + offset,
        c: c.c + offset,
        v: c.v
      }));
    }

    getDecimals(sym = this.activeSymbol) {
      return this.instruments[sym]?.decimals ?? 2;
    }

    formatPrice(val, sym = this.activeSymbol) {
      const dec = this.getDecimals(sym);
      return Number(val).toLocaleString('en-US', {
        minimumFractionDigits: dec,
        maximumFractionDigits: dec
      });
    }

    setSymbol(sym) {
      if (!this.state[sym]) {
        this.ensureInstrument(sym);
      }
      if (this.state[sym]) {
        this.activeSymbol = sym;
        if (this.wsEnabled) {
          this.fetchVenueKlines(sym, this.activeExchange);
        }
        this._emit('symbolChanged', sym);
      }
    }

    setExchange(exId) {
      this.activeExchange = exId;
      const list = this.getVenueSymbols(exId);
      const cat = this.venueCatalog?.[exId] || [];
      const activeAvailableOnVenue = exId === 'ALL'
        || list.includes(this.activeSymbol)
        || cat.some((c) => c.symbol === this.activeSymbol);
      if (!activeAvailableOnVenue && list.length > 0) {
        this.activeSymbol = list[0];
      }
      if (this.wsEnabled) {
        this.refreshVenueNow(exId);
      }
      this._emit('exchangeChanged', exId);
    }

    setTimeframe(tf) {
      this.timeframe = tf;
      if (this.wsEnabled) {
        this.fetchVenueKlines(this.activeSymbol, this.activeExchange);
      } else {
        const tfVolMult = { '1s': 1.0, '5s': 1.45, '1m': 2.2, '5m': 3.4 }[tf] || 1.0;
        const st = this.getSymbolState(this.activeSymbol);
        const cfg = this.instruments[this.activeSymbol];
        if (st && cfg) {
          st.candles = this._seedCandles(st.price, cfg.vol * tfVolMult, 110);
          st.currentCandle = { ...st.candles[st.candles.length - 1] };
          st.price = st.currentCandle.c;
          st.prevPrice = st.price;
        }
      }
      this._emit('timeframeChanged', tf);
    }

    _rebaseSymbolToPrice(st, newPrice) {
      const cfg = this.instruments[st.symbol];
      if (!cfg || !Number.isFinite(newPrice) || newPrice <= 0) return;
      const tfVolMult = { '1s': 1.0, '5s': 1.45, '1m': 2.2, '5m': 3.4 }[this.timeframe] || 1.0;
      st.candles = this._seedCandles(newPrice, cfg.vol * tfVolMult, 110);
      st.currentCandle = { ...st.candles[st.candles.length - 1] };
      st.open24h = st.candles[0].o;
      st.price = newPrice;
      st.prevPrice = newPrice;
      st.regimeDrift = 0;
      st.flowImbalance = 0;
      EXCHANGES.forEach((ex, idx) => {
        const basis = (idx - 2) * 0.00004;
        if (st.venueBasis) st.venueBasis[ex.id] = basis;
        st.venuePrices[ex.id] = newPrice * (1 + basis);
      });
      this._rebuildOrderbook(st);
    }

    _hydrateLiveOrderflowFromCandles(st, parsedCandles) {
      if (!st || !Array.isArray(parsedCandles) || parsedCandles.length < 5) return;
      const slice = parsedCandles.slice(-35);
      const avgVol = slice.reduce((acc, c) => acc + Math.max(0.01, c.v || 1), 0) / slice.length;
      let cum = 0;
      const cvdHist = [];
      let recentFlow = 0;
      for (let i = 0; i < slice.length; i++) {
        const c = slice[i];
        const range = Math.max(1e-9, c.h - c.l);
        const bodyMove = (c.c - c.o) / range;
        const clv = ((c.c - c.l) - (c.h - c.c)) / range;
        const pressure = clv * 0.65 + bodyMove * 0.35;
        const volNorm = Math.min(2.5, Math.max(0.3, (c.v || avgVol) / Math.max(1e-6, avgVol)));
        cum = Math.max(-25, Math.min(25, cum * 0.92 + pressure * volNorm * 1.15));
        cvdHist.push(cum);
        if (i >= slice.length - 5) recentFlow += pressure * 0.12;
      }
      st.cvd = cum;
      st.cvdHistory = cvdHist;
      st.flowImbalance = Math.max(-0.35, Math.min(0.35, (recentFlow / 5) * 2.2));
      st.netFlowPerSec = st.flowImbalance * 3.8;
    }

    async fetchVenueKlines(sym = this.activeSymbol, exchange = this.activeExchange) {
      const cfg = this.instruments[sym];
      if (!cfg || typeof fetch !== 'function') return;
      const ex = exchange && exchange !== 'ALL' ? exchange : (cfg.wsBinance ? 'BINANCE' : 'HYPERLIQUID');
      const tfMin = this.timeframe === '5m' ? 5 : 1;

      const applyParsedCandles = (parsed, targetEx) => {
        if (!Array.isArray(parsed) || parsed.length < 10) return false;
        const st = this.state[sym];
        st.candles = parsed;
        if (tfMin === 1 || !st.signalCandles || st.signalCandles.length < 22) {
          st.signalCandles = parsed.map((c) => ({ ...c }));
        }
        st.currentCandle = { ...parsed[parsed.length - 1] };
        st.open24h = parsed[0].o;
        const latestC = st.currentCandle.c;
        st.price = latestC;
        st.prevPrice = latestC;
        if (targetEx && st.venuePrices[targetEx]) {
          st.venuePrices[targetEx] = latestC;
          st.liveVenuePrices[targetEx] = latestC;
        }
        this._hydrateLiveOrderflowFromCandles(st, st.signalCandles);
        this._rebuildOrderbook(st);
        return true;
      };

      try {
        if (ex === 'BYBIT' && cfg.bybitSym) {
          const res = await fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${cfg.bybitSym}&interval=${tfMin}&limit=100`);
          if (res.ok) {
            const json = await res.json();
            const list = json?.result?.list;
            if (Array.isArray(list) && list.length >= 10) {
              const parsed = list.slice().reverse().map((r) => ({
                t: Number(r[0]), o: parseFloat(r[1]), h: parseFloat(r[2]), l: parseFloat(r[3]), c: parseFloat(r[4]), v: parseFloat(r[5])
              })).filter((c) => Number.isFinite(c.o) && Number.isFinite(c.c));
              if (applyParsedCandles(parsed, 'BYBIT')) return;
            }
          }
        } else if (ex === 'OKX' && cfg.okxInst) {
          const bar = tfMin === 5 ? '5m' : '1m';
          const res = await fetch(`https://www.okx.com/api/v5/market/candles?instId=${cfg.okxInst}&bar=${bar}&limit=100`);
          if (res.ok) {
            const json = await res.json();
            const rows = json?.data;
            if (Array.isArray(rows) && rows.length >= 10) {
              const parsed = rows.slice().reverse().map((r) => ({
                t: Number(r[0]), o: parseFloat(r[1]), h: parseFloat(r[2]), l: parseFloat(r[3]), c: parseFloat(r[4]), v: parseFloat(r[5])
              })).filter((c) => Number.isFinite(c.o) && Number.isFinite(c.c));
              if (applyParsedCandles(parsed, 'OKX')) return;
            }
          }
        } else if (ex === 'HYPERLIQUID' && cfg.hlCoin) {
          const now = Date.now();
          const interval = tfMin === 5 ? '5m' : '1m';
          const res = await fetch('https://api.hyperliquid.xyz/info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'candleSnapshot',
              req: { coin: cfg.hlCoin, interval, startTime: now - 100 * tfMin * 60000, endTime: now }
            })
          });
          if (res.ok) {
            const rows = await res.json();
            if (Array.isArray(rows) && rows.length >= 10) {
              const parsed = rows.map((r) => ({
                t: Number(r.t), o: parseFloat(r.o), h: parseFloat(r.h), l: parseFloat(r.l), c: parseFloat(r.c), v: parseFloat(r.v)
              })).filter((c) => Number.isFinite(c.o) && Number.isFinite(c.c));
              if (applyParsedCandles(parsed, 'HYPERLIQUID')) return;
            }
          }
        }
      } catch (_) {}

      await this._fetchBinanceKlines(sym);
    }

    async _fetchBinanceKlines(sym) {
      const cfg = this.instruments[sym];
      if (!cfg || !cfg.wsBinance || typeof fetch !== 'function') return;
      const interval = this.timeframe === '5m' ? '5m' : '1m';
      try {
        const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${cfg.wsBinance.toUpperCase()}&interval=${interval}&limit=100`;
        const res = await fetch(url);
        if (!res.ok) return;
        const rows = await res.json();
        if (!Array.isArray(rows) || rows.length < 10) return;
        const parsed = rows
          .map((r) => ({
            t: Number(r[0]),
            o: parseFloat(r[1]),
            h: parseFloat(r[2]),
            l: parseFloat(r[3]),
            c: parseFloat(r[4]),
            v: parseFloat(r[5])
          }))
          .filter((c) => Number.isFinite(c.o) && Number.isFinite(c.h) && Number.isFinite(c.l) && Number.isFinite(c.c));
        if (parsed.length < 10) return;
        const st = this.state[sym];
        st.candles = parsed;
        if (interval === '1m' || !st.signalCandles || st.signalCandles.length < 22) {
          st.signalCandles = parsed.map((c) => ({ ...c }));
        }
        st.currentCandle = { ...parsed[parsed.length - 1] };
        st.open24h = parsed[0].o;
        st.price = st.currentCandle.c;
        st.prevPrice = st.price;
        this._hydrateLiveOrderflowFromCandles(st, st.signalCandles);
        this._rebuildOrderbook(st);
      } catch (_) {
        // Silent fallback if offline or CORS blocked
      }
    }

    on(fn) {
      this.listeners.push(fn);
    }

    _emit(type, payload) {
      for (let i = 0; i < this.listeners.length; i++) {
        this.listeners[i](type, payload);
      }
    }

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

    applyLiveVenueQuote(sym, venueId, px, funding8h, change24hPct) {
      const check = this._schemas ? this._schemas.validateMarketTick({ symbol: sym, price: px, funding8h }) : { ok: true };
      if (!check.ok) return;
      const st = this.state[sym];
      if (!st) return;
      if (!st.liveVenuePrices) st.liveVenuePrices = {};
      if (!st.venueChange24hPct) st.venueChange24hPct = {};
      st.liveVenuePrices[venueId] = px;
      st.venuePrices[venueId] = px;
      if (Number.isFinite(change24hPct)) {
        st.venueChange24hPct[venueId] = change24hPct;
      }
      if (funding8h !== undefined && Number.isFinite(funding8h)) {
        st.venueFunding8h[venueId] = funding8h;
        if (venueId === this.activeExchange || (this.activeExchange === 'ALL' && venueId === 'BINANCE')) {
          st.funding8h = funding8h;
        }
      }
      const isPrimary = this.activeExchange === venueId || (this.activeExchange === 'ALL' && !st.liveWsPrice && venueId === 'HYPERLIQUID');
      if (isPrimary && Math.abs(px - st.price) / Math.max(1e-9, st.price) > 0.02) {
        this._rebaseSymbolToPrice(st, px);
        st.venuePrices[venueId] = px;
        st.liveVenuePrices[venueId] = px;
        if (Number.isFinite(change24hPct)) {
          st.venueChange24hPct[venueId] = change24hPct;
        }
      }
    }

    async _pollVenueLive(targetEx = 'ALL') {
      if (!this.wsEnabled || typeof fetch !== 'function') return;
      const want = (id) => targetEx === 'ALL' || targetEx === id;

      if (want('HYPERLIQUID')) {
        try {
          const res = await fetch('https://api.hyperliquid.xyz/info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'metaAndAssetCtxs' })
          });
          if (res.ok) {
            const json = await res.json();
            const universe = json?.[0]?.universe;
            const ctxs = json?.[1];
            if (Array.isArray(universe) && Array.isArray(ctxs)) {
              const hlItems = [];
              for (let i = 0; i < universe.length; i++) {
                const u = universe[i];
                const ctx = ctxs[i];
                if (!u || !ctx || u.isDelisted) continue;
                const name = String(u.name || '').trim();
                const mark = parseFloat(ctx.markPx);
                if (!name || !Number.isFinite(mark) || mark <= 0) continue;
                const prevDay = parseFloat(ctx.prevDayPx);
                const hourlyFunding = parseFloat(ctx.funding);
                const funding8h = Number.isFinite(hourlyFunding) ? hourlyFunding * 8 * 100 : undefined;
                const chgPct = (Number.isFinite(prevDay) && prevDay > 0) ? ((mark - prevDay) / prevDay) * 100 : undefined;
                const volUsd = parseFloat(ctx.dayNtlVlm) || 0;
                hlItems.push({
                  symbol: `${name.toUpperCase()}-PERP`,
                  baseCoin: name.toUpperCase(),
                  venue: 'HYPERLIQUID',
                  venueSymbol: name,
                  price: mark,
                  change24hPct: chgPct,
                  funding8h,
                  volume24hUsd: volUsd
                });
              }
              this.ingestVenueCatalog('HYPERLIQUID', hlItems);
            }
          }
        } catch (_) {}
      }

      if (want('BINANCE')) {
        try {
          const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr');
          if (res.ok) {
            const rows = await res.json();
            if (Array.isArray(rows)) {
              const bnItems = [];
              for (const r of rows) {
                const rawSym = String(r?.symbol || '');
                if (!rawSym.endsWith('USDT') || rawSym.includes('_')) continue;
                const base = rawSym.slice(0, -4).toUpperCase();
                const px = parseFloat(r.lastPrice);
                if (!base || !Number.isFinite(px) || px <= 0) continue;
                const chgPct = parseFloat(r.priceChangePercent);
                const volUsd = parseFloat(r.quoteVolume) || 0;
                bnItems.push({
                  symbol: `${base}-PERP`,
                  baseCoin: base,
                  venue: 'BINANCE',
                  venueSymbol: rawSym,
                  price: px,
                  change24hPct: Number.isFinite(chgPct) ? chgPct : undefined,
                  funding8h: undefined,
                  volume24hUsd: volUsd
                });
              }
              this.ingestVenueCatalog('BINANCE', bnItems);
            }
          }
        } catch (_) {}
      }

      if (want('BYBIT')) {
        try {
          const res = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
          if (res.ok) {
            const json = await res.json();
            const rows = json?.result?.list || [];
            const bbItems = [];
            for (const hit of rows) {
              const rawSym = String(hit?.symbol || '');
              if (!rawSym.endsWith('USDT') || rawSym.includes('-')) continue;
              const base = rawSym.slice(0, -4).toUpperCase();
              const px = parseFloat(hit.lastPrice || hit.markPrice);
              if (!base || !Number.isFinite(px) || px <= 0) continue;
              const f8h = hit.fundingRate !== undefined ? parseFloat(hit.fundingRate) * 100 : undefined;
              const chgPct = hit.price24hPcnt !== undefined ? parseFloat(hit.price24hPcnt) * 100 : undefined;
              const volUsd = parseFloat(hit.turnover24h) || 0;
              bbItems.push({
                symbol: `${base}-PERP`,
                baseCoin: base,
                venue: 'BYBIT',
                venueSymbol: rawSym,
                price: px,
                change24hPct: Number.isFinite(chgPct) ? chgPct : undefined,
                funding8h: Number.isFinite(f8h) ? f8h : undefined,
                volume24hUsd: volUsd
              });
            }
            this.ingestVenueCatalog('BYBIT', bbItems);
          }
        } catch (_) {}
      }

      if (want('OKX')) {
        try {
          const res = await fetch('https://www.okx.com/api/v5/market/tickers?instType=SWAP');
          if (res.ok) {
            const json = await res.json();
            const rows = json?.data || [];
            const okxItems = [];
            for (const hit of rows) {
              const instId = String(hit?.instId || '');
              if (!instId.endsWith('-USDT-SWAP')) continue;
              const base = instId.slice(0, -10).toUpperCase();
              const px = parseFloat(hit.last || hit.askPx || hit.bidPx);
              if (!base || !Number.isFinite(px) || px <= 0) continue;
              const open24 = parseFloat(hit.open24h);
              const chgPct = (Number.isFinite(open24) && open24 > 0) ? ((px - open24) / open24) * 100 : undefined;
              const volUsd = (parseFloat(hit.volCcy24h) || 0) * px;
              okxItems.push({
                symbol: `${base}-PERP`,
                baseCoin: base,
                venue: 'OKX',
                venueSymbol: instId,
                price: px,
                change24hPct: Number.isFinite(chgPct) ? chgPct : undefined,
                funding8h: undefined,
                volume24hUsd: Number.isFinite(volUsd) ? volUsd : 0
              });
            }
            this.ingestVenueCatalog('OKX', okxItems);
          }
        } catch (_) {}
      }

      if (want('DERIBIT')) {
        try {
          const [btcRes, ethRes, usdcRes] = await Promise.all([
            fetch('https://www.deribit.com/api/v2/public/ticker?instrument_name=BTC-PERPETUAL'),
            fetch('https://www.deribit.com/api/v2/public/ticker?instrument_name=ETH-PERPETUAL'),
            fetch('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=USDC&kind=future')
          ]);
          const dbItems = [];
          if (btcRes.ok) {
            const j = await btcRes.json();
            const r = j?.result;
            const px = parseFloat(r?.mark_price || r?.last_price);
            if (Number.isFinite(px) && px > 0) {
              dbItems.push({
                symbol: 'BTC-PERP',
                baseCoin: 'BTC',
                venue: 'DERIBIT',
                venueSymbol: 'BTC-PERPETUAL',
                price: px,
                change24hPct: parseFloat(r?.stats?.price_change),
                funding8h: parseFloat(r?.funding_8h) * 100,
                volume24hUsd: parseFloat(r?.stats?.volume_usd) || 0
              });
            }
          }
          if (ethRes.ok) {
            const j = await ethRes.json();
            const r = j?.result;
            const px = parseFloat(r?.mark_price || r?.last_price);
            if (Number.isFinite(px) && px > 0) {
              dbItems.push({
                symbol: 'ETH-PERP',
                baseCoin: 'ETH',
                venue: 'DERIBIT',
                venueSymbol: 'ETH-PERPETUAL',
                price: px,
                change24hPct: parseFloat(r?.stats?.price_change),
                funding8h: parseFloat(r?.funding_8h) * 100,
                volume24hUsd: parseFloat(r?.stats?.volume_usd) || 0
              });
            }
          }
          if (usdcRes.ok) {
            const j = await usdcRes.json();
            const list = Array.isArray(j?.result) ? j.result : [];
            for (const hit of list) {
              const instName = String(hit?.instrument_name || '');
              if (!instName.endsWith('_USDC-PERPETUAL')) continue;
              const base = instName.replace('_USDC-PERPETUAL', '').toUpperCase();
              const px = parseFloat(hit.mark_price || hit.last);
              if (!base || !Number.isFinite(px) || px <= 0) continue;
              dbItems.push({
                symbol: `${base}-PERP`,
                baseCoin: base,
                venue: 'DERIBIT',
                venueSymbol: instName,
                price: px,
                change24hPct: parseFloat(hit.price_change),
                funding8h: undefined,
                volume24hUsd: (parseFloat(hit.volume_usd) || (parseFloat(hit.volume) || 0) * px) || 0
              });
            }
          }
          if (dbItems.length > 0) {
            this.ingestVenueCatalog('DERIBIT', dbItems);
          }
        } catch (_) {}
      }
    }

    _openBinanceWsForSymbol(sym) {
      if (!this.wsEnabled || typeof WebSocket === 'undefined') return null;
      const cfg = this.instruments[sym];
      if (!cfg || !cfg.wsBinance || this.wsSockets[sym]) return this.wsSockets[sym] || null;

      // Bound dynamic WS streams to max 12 active sockets to preserve browser CPU/bandwidth
      if (!this.coreSymbols.includes(sym)) {
        this.dynamicWsOrder = this.dynamicWsOrder.filter((s) => s !== sym);
        this.dynamicWsOrder.push(sym);
        while (this.dynamicWsOrder.length > 5) {
          const evict = this.dynamicWsOrder.shift();
          if (evict && evict !== this.activeSymbol && this.wsSockets[evict]) {
            try { this.wsSockets[evict].close(); } catch (_) {}
            delete this.wsSockets[evict];
          }
        }
      }

      try {
        const ws = new WebSocket(`wss://fstream.binance.com/ws/${cfg.wsBinance}@markPrice@1s`);
        ws.onopen = () => {
          const liveCount = Object.keys(this.wsSockets).length;
          this._emit('wsStatus', { connected: true, text: `WS: ON (${liveCount})` });
        };
        ws.onmessage = (evt) => {
          try {
            const data = JSON.parse(evt.data);
            const px = parseFloat(data.p);
            const fPct = data.r !== undefined ? parseFloat(data.r) * 100 : undefined;
            const check = this._schemas ? this._schemas.validateMarketTick({ symbol: sym, price: px, funding8h: fPct }) : { ok: true };
            if (check.ok && this.state[sym]) {
              const st = this.state[sym];
              if (this.activeExchange === 'ALL' || this.activeExchange === 'BINANCE') {
                if (Math.abs(px - st.price) / Math.max(1e-9, st.price) > 0.02) {
                  this._rebaseSymbolToPrice(st, px);
                }
              }
              st.liveWsPrice = px;
              this.applyLiveVenueQuote(sym, 'BINANCE', px, fPct);
            }
          } catch (_) {}
        };
        ws.onerror = () => {
          const liveCount = Object.keys(this.wsSockets).length;
          this._emit('wsStatus', { connected: liveCount > 0, text: liveCount > 0 ? `WS: ON (${liveCount})` : 'WS: FALLBACK' });
        };
        this.wsSockets[sym] = ws;
        return ws;
      } catch (_) {
        this._emit('wsStatus', { connected: false, text: 'WS: FALLBACK' });
        return null;
      }
    }

    refreshVenueNow(exId = this.activeExchange) {
      if (!this.wsEnabled) return;
      this._pollVenueLive(exId === 'ALL' ? 'ALL' : exId);
      this.fetchVenueKlines(this.activeSymbol, exId);
    }

    toggleLiveWebSocket(enable) {
      this.wsEnabled = enable;
      if (this.hlPollTimer) {
        clearInterval(this.hlPollTimer);
        this.hlPollTimer = null;
      }
      if (this.otherVenuesPollTimer) {
        clearInterval(this.otherVenuesPollTimer);
        this.otherVenuesPollTimer = null;
      }
      if (this.klinePollTimer) {
        clearInterval(this.klinePollTimer);
        this.klinePollTimer = null;
      }
      if (!enable) {
        this._liveWsStarted = false;
        Object.values(this.wsSockets).forEach((ws) => {
          try { ws.close(); } catch (_) {}
        });
        this.wsSockets = {};
        this.dynamicWsOrder = [];
        Object.values(this.state).forEach((st) => {
          st.liveWsPrice = null;
          st.liveHlPrice = null;
          st.liveVenuePrices = {};
          st.venueChange24hPct = {};
        });
        this._emit('wsStatus', { connected: false, text: 'WS: OFF' });
        return;
      }

      if (typeof WebSocket === 'undefined') {
        this._liveWsStarted = false;
        this._emit('wsStatus', { connected: false, text: 'WS: N/A' });
        return;
      }

      this._liveWsStarted = true;

      this._emit('wsStatus', { connected: false, text: 'WS: LIVE...' });

      const activeTargets = new Set([...this.coreSymbols, this.activeSymbol]);
      activeTargets.forEach((sym) => {
        if (!this.instruments[sym]) return;
        this.fetchVenueKlines(sym, this.activeExchange);
        this._openBinanceWsForSymbol(sym);
      });

      this._pollVenueLive('ALL');
      this.hlPollTimer = setInterval(() => this._pollVenueLive('HYPERLIQUID'), 4000);
      this.otherVenuesPollTimer = setInterval(() => this._pollVenueLive('ALL'), 4000);
      this.klinePollTimer = setInterval(() => {
        const pollSyms = new Set([...this.coreSymbols, this.activeSymbol]);
        pollSyms.forEach((sym) => this.fetchVenueKlines(sym, this.activeExchange));
      }, 60000);
    }

    getVenueFeeBps(exchangeId, isMaker = true) {
      const targetId = exchangeId && exchangeId !== 'ALL' ? exchangeId : 'HYPERLIQUID';
      const ex = EXCHANGES.find((e) => e.id === targetId) || EXCHANGES[0];
      return isMaker ? ex.makerBps : ex.takerBps;
    }

    estimateSlippageBps(sym = this.activeSymbol, sizeUsd = 5000) {
      const cfg = this.instruments[sym] || this.instruments['BTC-PERP'];
      const liqFactor = Math.max(0.4, cfg.oi / 18.42);
      const sizeImpact = (sizeUsd / 100000) * (1.25 / liqFactor);
      const shockPenalty = this.shockIntensity * 14.0;
      return Math.min(45, 0.35 + sizeImpact + shockPenalty);
    }

    getArbitrageOpportunities() {
      const list = [];
      Object.keys(this.state).forEach((sym) => {
        const st = this.state[sym];
        let best = null;

        for (let i = 0; i < EXCHANGES.length; i++) {
          for (let j = 0; j < EXCHANGES.length; j++) {
            if (i === j) continue;
            const exL = EXCHANGES[i];
            const exS = EXCHANGES[j];
            const pL = st.venuePrices[exL.id];
            const pS = st.venuePrices[exS.id];
            const fL = st.venueFunding8h[exL.id];
            const fS = st.venueFunding8h[exS.id];

            const netFunding8h = fS - fL;
            const basisBps = ((pS - pL) / pL) * 10000;
            const roundTripMakerFeeBps = (exL.makerBps + exS.makerBps) * 2;
            const netAprPct = netFunding8h * 3 * 365;
            const score = netAprPct + basisBps * 2.5 - roundTripMakerFeeBps * 0.4;

            if (!best || score > best.score) {
              best = {
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
        if (best) list.push(best);
      });

      list.sort((a, b) => b.netAprPct - a.netAprPct);
      return list;
    }

    _aggregateCandles(candles, groupSize = 5) {
      if (!Array.isArray(candles) || candles.length === 0) return [];
      const out = [];
      for (let i = 0; i < candles.length; i += groupSize) {
        const chunk = candles.slice(i, i + groupSize);
        if (chunk.length === 0) continue;
        let h = -Infinity;
        let l = Infinity;
        let v = 0;
        for (const bar of chunk) {
          if (bar.h > h) h = bar.h;
          if (bar.l < l) l = bar.l;
          v += Number(bar.v) || 0;
        }
        out.push({
          t: chunk[0].t,
          o: chunk[0].o,
          h,
          l,
          c: chunk[chunk.length - 1].c,
          v
        });
      }
      return out;
    }

    _compute5mTrend(candles1m) {
      const bars5m = this._aggregateCandles(candles1m, 5);
      if (bars5m.length < 8) {
        return { bias: 'NEUTRAL', spreadPct: 0, slopePct: 0, atr5mPct: 0.2, barsCount: bars5m.length };
      }
      const closes = bars5m.map((b) => b.c);
      const calcEma = (arr, period) => {
        const k = 2 / (period + 1);
        const res = [arr[0]];
        for (let i = 1; i < arr.length; i++) res.push(arr[i] * k + res[i - 1] * (1 - k));
        return res;
      };
      const ema5 = calcEma(closes, 5);
      const ema13 = calcEma(closes, 13);
      const m = closes.length;
      const lastEma5 = ema5[m - 1];
      const lastEma13 = ema13[m - 1];
      const spreadPct = ((lastEma5 - lastEma13) / Math.max(1e-9, lastEma13)) * 100;
      const prevIdx = Math.max(0, m - 3);
      const slopePct = ((closes[m - 1] - closes[prevIdx]) / Math.max(1e-9, closes[prevIdx])) * 100;

      let trSum = 0;
      const trStart = Math.max(1, bars5m.length - 6);
      const trCnt = Math.max(1, bars5m.length - trStart);
      for (let i = trStart; i < bars5m.length; i++) {
        const cur = bars5m[i];
        const prevC = Math.max(1e-9, bars5m[i - 1].c);
        const tr = Math.max(cur.h - cur.l, Math.abs(cur.h - prevC), Math.abs(cur.l - prevC));
        trSum += (tr / prevC) * 100;
      }
      const atr5mPct = trSum / trCnt;
      const minThreshold = Math.max(0.05, atr5mPct * 0.22);

      let bias = 'NEUTRAL';
      if (spreadPct > minThreshold && slopePct >= -0.02) bias = 'BULL';
      else if (spreadPct < -minThreshold && slopePct <= 0.02) bias = 'BEAR';

      return { bias, spreadPct, slopePct, atr5mPct, barsCount: bars5m.length };
    }

    _detectVolatilitySpike(recentCandles, atrPct, st) {
      if (!Array.isArray(recentCandles) || recentCandles.length < 4) {
        return { active: false, reason: '', maxRangePct: 0, wickRatio: 0 };
      }
      // Compute baseline ATR from bars BEFORE the last 2 bars so the spike itself doesn't mask the baseline
      const baseSlice = recentCandles.slice(-16, -2);
      let baseAtrPct = atrPct;
      if (baseSlice.length >= 4) {
        let sum = 0;
        for (let i = 1; i < baseSlice.length; i++) {
          const cur = baseSlice[i];
          const prevC = Math.max(1e-9, baseSlice[i - 1].c);
          const tr = Math.max(cur.h - cur.l, Math.abs(cur.h - prevC), Math.abs(cur.l - prevC));
          sum += (tr / prevC) * 100;
        }
        baseAtrPct = sum / Math.max(1, baseSlice.length - 1);
      }
      const baseline = Math.max(0.06, baseAtrPct);

      const n = recentCandles.length;
      const tail2 = recentCandles.slice(-2);
      let maxRangePct = 0;
      let lastWickRatio = 0;
      let lastRangePct = 0;

      tail2.forEach((bar, idx) => {
        const prevRef = Math.max(1e-9, recentCandles[Math.max(0, n - tail2.length + idx - 1)]?.c || bar.o);
        const rangePct = ((bar.h - bar.l) / prevRef) * 100;
        const bodyPct = (Math.abs(bar.c - bar.o) / prevRef) * 100;
        const wickRatio = rangePct > 1e-6 ? Math.max(0, 1 - (bodyPct / rangePct)) : 0;
        if (rangePct > maxRangePct) maxRangePct = rangePct;
        if (idx === tail2.length - 1) {
          lastRangePct = rangePct;
          lastWickRatio = wickRatio;
        }
      });

      if (maxRangePct >= Math.max(0.45, baseline * 2.8)) {
        return {
          active: true,
          reason: `Nến giật tin ${maxRangePct.toFixed(2)}% (>= ${(Math.max(0.45, baseline * 2.8)).toFixed(2)}%)`,
          maxRangePct,
          wickRatio: lastWickRatio
        };
      }
      if (lastRangePct >= Math.max(0.30, baseline * 2.0) && lastWickRatio >= 0.72) {
        return {
          active: true,
          reason: `Quét râu 2 đầu (${Math.round(lastWickRatio * 100)}% râu)`,
          maxRangePct,
          wickRatio: lastWickRatio
        };
      }
      if (st.shockSigma >= 1.5 || (st.orderbook?.spreadBps || 0) >= 6.5 || (st.realizedVol || 0) >= 88) {
        return {
          active: true,
          reason: `Sốc biến động (${st.shockSigma.toFixed(2)}σ, Spread ${(st.orderbook?.spreadBps || 0).toFixed(1)} bps)`,
          maxRangePct,
          wickRatio: lastWickRatio
        };
      }
      return { active: false, reason: '', maxRangePct, wickRatio: lastWickRatio };
    }

    getDirectionalSignal(sym = this.activeSymbol) {
      const st = this.state[sym];
      const cfg = this.instruments[sym] || this.instruments['BTC-PERP'];
      const srcCandles = (this.wsEnabled && Array.isArray(st?.signalCandles) && st.signalCandles.length >= 22)
        ? st.signalCandles
        : st?.candles;
      if (!st || !srcCandles || srcCandles.length < 22) {
        return {
          score: 0,
          side: 'WAIT',
          confidence: 50,
          reasons: 'Đang thu thập dữ liệu nến',
          suggestedSlPct: 0.65,
          suggestedTpPct: 1.55,
          rsi: 50,
          zScore: 0,
          atrPct: Number((cfg.vol * 100 * 2.5).toFixed(3)),
          bbMean: st?.price || cfg.base,
          emaSlopePct: 0,
          cvdSlope: 0,
          bidRatio: st?.orderbook?.bidRatio ?? 0.5
        };
      }

      const recentCandles = srcCandles.slice(-55);
      const closes = recentCandles.map((c) => c.c);
      const n = closes.length;
      const calcEmaSeries = (arr, period) => {
        const k = 2 / (period + 1);
        const out = [arr[0]];
        for (let i = 1; i < arr.length; i++) {
          out.push(arr[i] * k + out[i - 1] * (1 - k));
        }
        return out;
      };

      const ema8Series = calcEmaSeries(closes, 8);
      const ema21Series = calcEmaSeries(closes, 21);
      const ema50Series = calcEmaSeries(closes, 50);

      const ema8 = ema8Series[n - 1];
      const ema8Prev = ema8Series[Math.max(0, n - 4)];
      const ema21 = ema21Series[n - 1];
      const ema50 = ema50Series[n - 1];
      const lastClose = closes[n - 1];

      const emaSpread821Pct = ((ema8 - ema21) / Math.max(1e-9, ema21)) * 100;
      const emaSpread2150Pct = ((ema21 - ema50) / Math.max(1e-9, ema50)) * 100;
      const emaSlopePct = ((ema8 - ema8Prev) / Math.max(1e-9, ema8Prev)) * 100;

      // MACD (8, 21, 5) + Histogram acceleration
      const macdSeries = ema8Series.map((v, idx) => v - ema21Series[idx]);
      const macdSigSeries = calcEmaSeries(macdSeries, 5);
      const histNow = macdSeries[n - 1] - macdSigSeries[n - 1];
      const histPrev = macdSeries[Math.max(0, n - 2)] - macdSigSeries[Math.max(0, n - 2)];
      const macdHistPct = (histNow / Math.max(1e-9, lastClose)) * 100;
      const macdAccelPct = ((histNow - histPrev) / Math.max(1e-9, lastClose)) * 100;

      // ATR-14 (%)
      let trSum = 0;
      const atrStart = Math.max(1, recentCandles.length - 14);
      const atrCount = Math.max(1, recentCandles.length - atrStart);
      for (let i = atrStart; i < recentCandles.length; i++) {
        const cur = recentCandles[i];
        const prevC = Math.max(1e-9, recentCandles[i - 1].c);
        const tr = Math.max(cur.h - cur.l, Math.abs(cur.h - prevC), Math.abs(cur.l - prevC));
        trSum += (tr / prevC) * 100;
      }
      const atrPct = trSum / atrCount;

      // Bollinger Bands (20, 2.0) Z-Score
      const bbSlice = closes.slice(-20);
      const bbMean = bbSlice.reduce((a, b) => a + b, 0) / bbSlice.length;
      const bbVar = bbSlice.reduce((acc, v) => acc + (v - bbMean) ** 2, 0) / bbSlice.length;
      const bbStd = Math.sqrt(bbVar);
      const zScore = bbStd > 1e-9 ? (lastClose - bbMean) / bbStd : 0;

      // RSI-14 (safe zero-diff fallback = 50)
      let gains = 0;
      let losses = 0;
      const rsiStart = Math.max(1, n - 14);
      for (let i = rsiStart; i < n; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff;
        else losses -= diff;
      }
      const rsi = (gains === 0 && losses === 0)
        ? 50
        : (100 - 100 / (1 + gains / Math.max(1e-9, losses)));

      // L2 Orderbook imbalance + 5-tick CVD slope + Net Flow
      const bidRatio = st.orderbook.bidRatio;
      const cvdArr = st.cvdHistory;
      const cvdSlope = cvdArr.length >= 5 ? cvdArr[cvdArr.length - 1] - cvdArr[cvdArr.length - 5] : 0;

      let rawScore;
      let suggestedSlPct;
      let suggestedTpPct;
      let htf5m = { bias: 'NEUTRAL', aligned: false, spreadPct: 0, slopePct: 0, atr5mPct: 0.2, barsCount: 0 };
      let spikeBlocked = false;
      let spikeReason = '';

      if (this.wsEnabled) {
        // ATR-normalized scoring tuned for real exchange 1m candles (prevents under-scoring 0.08%-0.15% ATR moves)
        const normAtr = Math.max(0.06, atrPct);
        const normTrend = (emaSpread821Pct / normAtr) * 26 + (emaSpread2150Pct / normAtr) * 10 + (emaSlopePct / normAtr) * 34;
        const normMacd = (macdHistPct / normAtr) * 42 + (macdAccelPct / normAtr) * 48;
        const flowLeadScore =
          (bidRatio - 0.5) * 150 +
          Math.max(-18, Math.min(18, cvdSlope * 10)) +
          Math.max(-12, Math.min(12, (st.netFlowPerSec || 0) * 8));

        rawScore = normTrend + normMacd + flowLeadScore;

        if (rawScore > 0 && ((rsi > 78 && zScore > 1.75) || zScore > 2.2)) {
          rawScore = Math.min(rawScore, 22);
        } else if (rawScore < 0 && ((rsi < 22 && zScore < -1.75) || zScore < -2.2)) {
          rawScore = Math.max(rawScore, -22);
        }

        if ((emaSpread821Pct > 0 && emaSlopePct < 0 && macdAccelPct < 0) || (emaSpread821Pct < 0 && emaSlopePct > 0 && macdAccelPct > 0)) {
          rawScore *= 0.55;
        }

        // Filter 1: Multi-timeframe 5m trend confirmation (blocks counter-trend traps)
        const computed5m = this._compute5mTrend(srcCandles);
        htf5m = { ...computed5m, aligned: false };
        if (this.mtfFilterEnabled && computed5m.bias !== 'NEUTRAL') {
          if ((rawScore > 0 && computed5m.bias === 'BEAR') || (rawScore < 0 && computed5m.bias === 'BULL')) {
            rawScore *= 0.30;
            htf5m.aligned = false;
          } else if ((rawScore > 0 && computed5m.bias === 'BULL') || (rawScore < 0 && computed5m.bias === 'BEAR')) {
            rawScore *= 1.12;
            htf5m.aligned = true;
          }
        }

        // Filter 2: High-volatility / Flash-news spike detector
        if (this.newsSpikeFilterEnabled) {
          const spike = this._detectVolatilitySpike(recentCandles, atrPct, st);
          if (spike.active) {
            rawScore = Math.max(-18, Math.min(18, rawScore));
            spikeBlocked = true;
            spikeReason = spike.reason;
          }
        }

        suggestedSlPct = Number(Math.max(0.35, Math.min(1.05, atrPct * 3.8)).toFixed(2));
        suggestedTpPct = Number(Math.max(0.85, Math.min(2.35, suggestedSlPct * 2.2)).toFixed(2));
      } else {
        const extFromEma21Pct = ((lastClose - ema21) / Math.max(1e-9, ema21)) * 100;
        const maxSafeExtPct = Math.max(0.45, atrPct * 3.4);
        const flowLeadScore = (bidRatio - 0.5) * 195 + cvdSlope * 22 + (st.netFlowPerSec || 0) * 16;
        const impulseScore = emaSlopePct * 250 + macdAccelPct * 340 + macdHistPct * 220 + emaSpread821Pct * 115;

        rawScore = impulseScore + flowLeadScore;

        // Hard late-wave exhaustion cap: never enter late in an aging rally or selloff
        if (rawScore > 0 && (extFromEma21Pct > maxSafeExtPct || rsi > 64 || zScore > 1.45)) {
          rawScore = Math.min(rawScore, 20);
        } else if (rawScore < 0 && (extFromEma21Pct < -maxSafeExtPct || rsi < 36 || zScore < -1.45)) {
          rawScore = Math.max(rawScore, -20);
        }

        // Late momentum deceleration dampener
        if ((emaSpread821Pct > 0 && emaSlopePct < 0) || (emaSpread821Pct < 0 && emaSlopePct > 0)) {
          rawScore *= 0.4;
        }

        suggestedSlPct = Number(Math.max(0.45, Math.min(1.05, Math.max(atrPct * 2.7, cfg.vol * 100 * 6.5))).toFixed(2));
        suggestedTpPct = Number(Math.max(1.02, Math.min(2.35, suggestedSlPct * 2.2)).toFixed(2));
      }

      const score = Math.max(-100, Math.min(100, Math.round(rawScore)));
      const side = (spikeBlocked || Math.abs(score) < 32) ? 'WAIT' : (score >= 32 ? 'LONG' : 'SHORT');
      const confidence = Math.min(95, Math.round(52 + Math.abs(score) * 0.45));

      const bidPct = Math.round(bidRatio * 100);
      const emaTag = ema8 >= ema21 ? (ema21 >= ema50 ? 'EMA8>21>50' : 'EMA8>21') : (ema21 <= ema50 ? 'EMA8<21<50' : 'EMA8<21');
      const cvdTag = cvdSlope >= 0 ? 'CVD↑' : 'CVD↓';
      const htfTag = htf5m.bias === 'BULL'
        ? (htf5m.aligned ? ' • 5m↑✓' : (score < 0 ? ' • 5m↑ NGƯỢC' : ' • 5m↑'))
        : (htf5m.bias === 'BEAR'
          ? (htf5m.aligned ? ' • 5m↓✓' : (score > 0 ? ' • 5m↓ NGƯỢC' : ' • 5m↓'))
          : '');
      const spikeTag = spikeBlocked ? ' • ⚡ LỌC TIN' : '';
      const reasons = `${emaTag} • Bid ${bidPct}% • ${cvdTag} • Z ${zScore.toFixed(1)} • RSI ${Math.round(rsi)}${htfTag}${spikeTag}`;

      return {
        score,
        side,
        confidence,
        reasons,
        suggestedSlPct,
        suggestedTpPct,
        rsi,
        zScore,
        atrPct,
        bbMean,
        emaSlopePct,
        cvdSlope,
        bidRatio,
        htf5m,
        spikeBlocked,
        spikeReason
      };
    }

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
        const cfg = this.instruments[sym];
        st.prevPrice = st.price;

        let deltaPct = 0;
        let nextPrice = st.price;
        const liveAnchor = this.wsEnabled
          ? ((this.activeExchange && this.activeExchange !== 'ALL' && st.liveVenuePrices?.[this.activeExchange])
            || st.liveWsPrice
            || st.liveHlPrice
            || st.liveVenuePrices?.BINANCE
            || st.liveVenuePrices?.HYPERLIQUID
            || Object.values(st.liveVenuePrices || {})[0])
          : null;
        if (this.shockIntensity > 0.15) {
          const shockImpulse = this.shockDirection * (0.0022 + Math.random() * 0.0046) * this.shockIntensity;
          const whip = (Math.random() - 0.5) * 0.0038 * this.shockIntensity;
          deltaPct = shockImpulse + whip;
          st.flowImbalance = st.flowImbalance * 0.65 + this.shockDirection * 0.75 * 0.35;
          nextPrice = Math.max(cfg.tick * 10, st.price * (1 + deltaPct));
        } else if (liveAnchor) {
          nextPrice = Math.max(cfg.tick * 10, liveAnchor);
          deltaPct = (nextPrice - st.prevPrice) / Math.max(1e-9, st.prevPrice);
          if (Math.abs(deltaPct) > 1e-8) {
            st.flowImbalance = st.flowImbalance * 0.72 + Math.max(-0.8, Math.min(0.8, deltaPct * 250)) * 0.28;
          } else if (Array.isArray(st.signalCandles) && st.signalCandles.length > 0) {
            const lc = st.signalCandles[st.signalCandles.length - 1];
            const rng = Math.max(1e-9, lc.h - lc.l);
            const sigHint = (((lc.c - lc.l) - (lc.h - lc.c)) / rng) * 0.28;
            st.flowImbalance = st.flowImbalance * 0.94 + sigHint * 0.06;
          }
        } else {
          st.regimeTicksLeft--;
          if (st.regimeTicksLeft <= 0) {
            st.regimeTicksLeft = 90 + Math.floor(Math.random() * 85);
            const meanPull = ((cfg.base - st.price) / Math.max(1e-9, cfg.base)) * 2.2;
            const dir = Math.random() < 0.5 ? 1 : -1;
            st.regimeTarget = Math.max(-1.15, Math.min(1.15, dir * (0.50 + Math.random() * 0.60) + meanPull));
          }
          st.regimeDrift = st.regimeDrift * 0.90 + st.regimeTarget * 0.10;
          st.flowImbalance = st.flowImbalance * 0.82 + (st.regimeTarget * 0.30 + (Math.random() - 0.5) * 0.12) * 0.18;
          deltaPct = (st.regimeDrift * 0.38 + st.flowImbalance * 0.62) * cfg.vol + (Math.random() + Math.random() - 1) * cfg.vol * 0.52;
          nextPrice = Math.max(cfg.tick * 10, st.price * (1 + deltaPct));
        }

        st.price = nextPrice;

        let totalFlow = 0;
        EXCHANGES.forEach((ex, idx) => {
          const venueBias = (idx === 0 ? 0.00018 : idx === 4 ? -0.00016 : (idx - 2) * 0.00005);
          const targetBasis = venueBias
            + Math.sin(Date.now() * 0.00035 + idx * 1.4) * (0.00024 + this.shockIntensity * 0.0018)
            + (Math.random() - 0.5) * (0.00014 + this.shockIntensity * 0.0012);
          st.venueBasis[ex.id] = (st.venueBasis[ex.id] ?? venueBias) * 0.85 + targetBasis * 0.15;
          const hasLiveVenuePx = this.wsEnabled && Number.isFinite(st.liveVenuePrices?.[ex.id]);
          if (!hasLiveVenuePx) {
            st.venuePrices[ex.id] = st.price * (1 + st.venueBasis[ex.id]);
          }

          const fDrift = (Math.random() - 0.49) * 0.0006;
          st.venueFunding8h[ex.id] = Math.max(-0.025, Math.min(0.055, st.venueFunding8h[ex.id] + fDrift));

          const flowDelta = ((st.flowImbalance * 0.4 + deltaPct * 520) * 1250000 + (Math.random() - 0.5) * 420000) * ex.weight;
          st.venueFlow[ex.id] = st.venueFlow[ex.id] * 0.72 + flowDelta * 0.28;
          totalFlow += st.venueFlow[ex.id];

          st.venueScores[ex.id] = Math.max(
            18,
            Math.min(
              98,
              Math.round(64 - idx * 5 + Math.sin(Date.now() * 0.0009 + idx * 1.7) * 8 - this.shockIntensity * 22 + (Math.random() - 0.5) * 3)
            )
          );
        });

        st.netFlowPerSec = totalFlow / 1e6;
        st.orderflowIndex = Math.max(420, Math.round(1290 + st.netFlowPerSec * 48 + Math.sin(Date.now() * 0.001) * 35));

        const c = st.currentCandle;
        c.c = st.price;
        c.h = Math.max(c.h, st.price);
        c.l = Math.min(c.l, st.price);
        c.v += (this.wsEnabled ? 0.8 + Math.abs(deltaPct) * 600 : 2.5 + Math.random() * 14) * (1 + this.shockIntensity * 4.5);
        st.candles[st.candles.length - 1] = { ...c };

        if (this.wsEnabled && this.shockIntensity <= 0.15) {
          const nowTs = Date.now();
          const tfMs = { '1s': 1000, '5s': 5000, '1m': 60000, '5m': 300000 }[this.timeframe] || 60000;
          if (nowTs - c.t >= tfMs) {
            const nextCandle = { t: nowTs, o: st.price, h: st.price, l: st.price, c: st.price, v: 1 };
            st.currentCandle = nextCandle;
            st.candles.push(nextCandle);
            if (st.candles.length > 130) st.candles.shift();
          }
          if (Array.isArray(st.signalCandles) && st.signalCandles.length > 0) {
            const sigLast = st.signalCandles[st.signalCandles.length - 1];
            sigLast.c = st.price;
            sigLast.h = Math.max(sigLast.h, st.price);
            sigLast.l = Math.min(sigLast.l, st.price);
            if (nowTs - sigLast.t >= 60000) {
              st.signalCandles.push({ t: nowTs, o: st.price, h: st.price, l: st.price, c: st.price, v: 1 });
              if (st.signalCandles.length > 130) st.signalCandles.shift();
            }
          }
        } else {
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
        }

        const cvdStep = this.wsEnabled
          ? (Math.abs(deltaPct) > 1e-8 ? deltaPct * 420 + st.flowImbalance * 0.25 : 0)
          : (st.flowImbalance * 0.95 + deltaPct * 340 + (Math.random() - 0.5) * 0.18);
        st.cvd = Math.max(-25, Math.min(25, st.cvd + cvdStep));
        st.cvdHistory.push(st.cvd);
        if (st.cvdHistory.length > 85) st.cvdHistory.shift();

        const targetVol = 34 + Math.abs(deltaPct) * 28000 + this.shockIntensity * 96;
        st.realizedVol = st.realizedVol * 0.85 + targetVol * 0.15;

        const targetSigma = 0.35 + Math.abs(deltaPct) * 420 + this.shockIntensity * 3.85;
        st.shockSigma = st.shockSigma * 0.78 + targetSigma * 0.22;

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
      const cfg = this.instruments[st.symbol];
      const mid = this.getPrice(st.symbol, this.activeExchange);
      const spreadMult = 1 + this.shockIntensity * 8.5;
      const halfSpread = cfg.tick * spreadMult;

      const asks = [];
      const bids = [];
      let cumAsk = 0;
      let cumBid = 0;

      const flowTilt = this.shockIntensity > 0.25
        ? (this.shockDirection > 0 ? 0.36 : -0.36)
        : Math.max(-0.34, Math.min(0.34, (st.flowImbalance || 0) * 0.95));
      const askMult = 1 - flowTilt;
      const bidMult = 1 + flowTilt;

      for (let i = 0; i < 9; i++) {
        const askPx = mid + halfSpread + i * cfg.tick * (1.2 + this.shockIntensity * 2.5);
        const bidPx = mid - halfSpread - i * cfg.tick * (1.2 + this.shockIntensity * 2.5);

        const depthFactor = Math.max(0.25, 1 - this.shockIntensity * 0.62);
        const baseLvl = (0.6 + (0.65 + Math.random() * 0.7) * 2.4 * (i + 1) * 0.45) * depthFactor * (cfg.base < 500 ? 18 : 1);
        const askQty = baseLvl * askMult;
        const bidQty = baseLvl * bidMult;

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

      const print = {
        id: this._uuid ? this._uuid.v4() : String(Date.now()),
        exchange: ex.id,
        shortEx: ex.id === 'HYPERLIQUID' ? 'HL-DEX' : ex.id.slice(0, 3),
        side: isBuy ? 'BUY' : 'SELL',
        price: st.venuePrices[ex.id] || st.price,
        usdSize,
        whale: isWhale,
        time: new Date().toISOString().substr(11, 8)
      };

      st.tape.unshift(print);
      if (st.tape.length > 34) st.tape.pop();

      if (!silent) {
        this._emit('tradePrint', { symbol: st.symbol, print });
      }
    }
  }

  return MarketEngine;
});
