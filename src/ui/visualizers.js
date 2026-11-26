/* ==========================================================================
   QUANTUM CORE // 60FPS HiDPI Canvas Visualizers (prefers-reduced-motion aware)
   1. Interactive Candlestick Chart (Click-to-place Limit + Entry/SL/TP overlays)
   2. 3D Liquidity & Orderflow Radial Sphere + Sweeping Bezier Venue Conduits
   3. 3D Volatility & Regime Wireframe Radar Sphere
   4. CVD Orderflow Waterfall & KPI Equity Sparkline
   ========================================================================== */

(function (global) {
  'use strict';

  function isReducedMotion() {
    return typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function fitCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(10, Math.floor(rect.width));
    const h = Math.max(10, Math.floor(rect.height));
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  class CandlestickChartRenderer {
    constructor(canvas, market, trading, onChartClickPrice) {
      this.canvas = canvas;
      this.market = market;
      this.trading = trading;
      this.onChartClickPrice = onChartClickPrice;

      this.mouse = { inside: false, x: 0, y: 0 };
      this.clickEnabled = true;
      this.selectedSide = 'LONG';
      this.slPct = 0.8;
      this.tpPct = 1.8;
      this.visibleCount = 48;
      this.pendingDraftOrder = null;
      this.showForecast = true;
      this._forecastCache = { key: '', ts: 0, data: null };

      this.priceMin = 0;
      this.priceMax = 1;
      this.pad = { top: 18, right: 74, bottom: 22, left: 10 };

      this._bindEvents();
    }

    _bindEvents() {
      this.canvas.addEventListener('mousemove', (e) => {
        const rect = this.canvas.getBoundingClientRect();
        this.mouse.inside = true;
        this.mouse.x = e.clientX - rect.left;
        this.mouse.y = e.clientY - rect.top;
      });
      this.canvas.addEventListener('mouseleave', () => {
        this.mouse.inside = false;
      });
      this.canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const step = e.deltaY < 0 ? -5 : 5;
        this.visibleCount = Math.max(22, Math.min(100, this.visibleCount + step));
      }, { passive: false });
      this.canvas.addEventListener('click', (e) => {
        if (!this.clickEnabled) return;
        const rect = this.canvas.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const price = this.yToPrice(y, rect.height);
        if (price > 0 && this.onChartClickPrice) {
          this.onChartClickPrice(price);
        }
      });
    }

    priceToY(price, h) {
      const plotH = h - this.pad.top - this.pad.bottom;
      const ratio = (price - this.priceMin) / Math.max(1e-9, this.priceMax - this.priceMin);
      return this.pad.top + plotH * (1 - ratio);
    }

    yToPrice(y, h) {
      const plotH = h - this.pad.top - this.pad.bottom;
      const ratio = 1 - (y - this.pad.top) / Math.max(1, plotH);
      return this.priceMin + ratio * (this.priceMax - this.priceMin);
    }

    render(timeMs = 0) {
      const { ctx, w, h } = fitCanvas(this.canvas);
      const st = this.market.getSymbolState();
      const candles = typeof this.market.getVenueCandles === 'function'
        ? this.market.getVenueCandles(st.symbol, this.market.activeExchange).slice(-this.visibleCount)
        : st.candles.slice(-this.visibleCount);
      if (candles.length < 2) return;
      const activePx = this.market.getPrice(st.symbol, this.market.activeExchange);

      ctx.fillStyle = '#06090f';
      ctx.fillRect(0, 0, w, h);

      // Compute Y-axis bounds exclusively from candlestick highs/lows so distant SL/TP lines never squash candles
      let lo = Infinity, hi = -Infinity, maxVol = 1;
      for (const c of candles) {
        if (c.l < lo) lo = c.l;
        if (c.h > hi) hi = c.h;
        if (c.v > maxVol) maxVol = c.v;
      }

      const symOrders = this.trading.limitOrders.filter((o) => o.symbol === st.symbol);
      const symPos = this.trading.positions.filter((p) => p.symbol === st.symbol);

      const span = Math.max(hi - lo, activePx * 0.0006);
      this.priceMin = lo - span * 0.18;
      this.priceMax = hi + span * 0.18;

      const plotW = w - this.pad.left - this.pad.right;
      const plotH = h - this.pad.top - this.pad.bottom;

      ctx.strokeStyle = 'rgba(56, 189, 248, 0.08)';
      ctx.lineWidth = 1;
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.fillStyle = '#5c7396';
      ctx.textAlign = 'left';

      for (let i = 0; i <= 5; i++) {
        const py = this.pad.top + (plotH * i) / 5;
        const pVal = this.yToPrice(py, h);
        ctx.beginPath();
        ctx.moveTo(this.pad.left, py);
        ctx.lineTo(w - this.pad.right, py);
        ctx.stroke();
        ctx.fillText(this.market.formatPrice(pVal, st.symbol), w - this.pad.right + 6, py + 3);
      }

      const futureSlots = this.showForecast ? Math.max(5, Math.round(candles.length * 0.16)) : 0;
      const stepX = plotW / (candles.length + futureSlots);
      const bodyW = Math.max(4, Math.min(14, stepX * 0.68));
      const lastCandleX = this.pad.left + (candles.length - 1) * stepX + stepX * 0.5;

      const areaGrad = ctx.createLinearGradient(0, this.pad.top, 0, h - this.pad.bottom);
      areaGrad.addColorStop(0, this.market.shockIntensity > 0.2 ? 'rgba(255, 59, 107, 0.16)' : 'rgba(0, 240, 255, 0.12)');
      areaGrad.addColorStop(1, 'rgba(0, 240, 255, 0.0)');

      ctx.beginPath();
      candles.forEach((c, idx) => {
        const x = this.pad.left + idx * stepX + stepX * 0.5;
        const y = this.priceToY(c.c, h);
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.lineTo(this.pad.left + (candles.length - 1) * stepX + stepX * 0.5, h - this.pad.bottom);
      ctx.lineTo(this.pad.left + stepX * 0.5, h - this.pad.bottom);
      ctx.closePath();
      ctx.fillStyle = areaGrad;
      ctx.fill();

      let ema = candles[0].c;
      const emaPts = [];
      let vwapSumPV = 0, vwapSumV = 0;
      const vwapPts = [];

      candles.forEach((c, idx) => {
        const x = this.pad.left + idx * stepX + stepX * 0.5;
        const isUp = c.c >= c.o;

        const volH = (c.v / maxVol) * (plotH * 0.2);
        ctx.fillStyle = isUp ? 'rgba(16, 185, 129, 0.22)' : 'rgba(255, 59, 107, 0.22)';
        ctx.fillRect(x - bodyW * 0.5, h - this.pad.bottom - volH, bodyW, volH);

        const yH = this.priceToY(c.h, h);
        const yL = this.priceToY(c.l, h);
        const yO = this.priceToY(c.o, h);
        const yC = this.priceToY(c.c, h);
        const wickCol = isUp ? '#10b981' : '#f43f5e';

        ctx.strokeStyle = wickCol;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(x, yH);
        ctx.lineTo(x, yL);
        ctx.stroke();

        const top = Math.min(yO, yC);
        const bh = Math.max(2.5, Math.abs(yC - yO));
        ctx.fillStyle = wickCol;
        ctx.fillRect(x - bodyW * 0.5, top, bodyW, bh);
        ctx.strokeStyle = isUp ? '#34d399' : '#fb7185';
        ctx.lineWidth = 0.8;
        ctx.strokeRect(x - bodyW * 0.5, top, bodyW, bh);

        ema = ema * 0.82 + c.c * 0.18;
        emaPts.push({ x, y: this.priceToY(ema, h) });

        vwapSumPV += ((c.h + c.l + c.c) / 3) * c.v;
        vwapSumV += c.v;
        vwapPts.push({ x, y: this.priceToY(vwapSumPV / vwapSumV, h) });
      });

      ctx.save();
      ctx.strokeStyle = '#00f0ff';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      emaPts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      vwapPts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
      ctx.restore();

      symOrders.forEach((o) => {
        this._drawPriceLine(ctx, w, h, o.entryPrice, '#fbbf24', `LIMIT ${o.side} $${(o.sizeUsd / 1000).toFixed(1)}k`, [5, 4]);
        if (o.slPrice) this._drawPriceLine(ctx, w, h, o.slPrice, 'rgba(255,59,107,0.75)', 'SL', [2, 3]);
        if (o.tpPrice) this._drawPriceLine(ctx, w, h, o.tpPrice, 'rgba(52,211,153,0.75)', 'TP', [2, 3]);
      });

      symPos.forEach((p) => {
        const pnlStr = `${p.unrealizedPnl >= 0 ? '+' : '-'}$${Math.abs(p.unrealizedPnl).toFixed(2)}`;
        const col = p.side === 'LONG' ? '#00f0ff' : '#fb7185';
        this._drawPriceLine(ctx, w, h, p.entryPrice, col, `POS ${p.side} ${pnlStr}`, []);
        if (p.slPrice) this._drawPriceLine(ctx, w, h, p.slPrice, '#ff3b6b', `SL ${this.market.formatPrice(p.slPrice, st.symbol)}`, [4, 3]);
        if (p.tpPrice) this._drawPriceLine(ctx, w, h, p.tpPrice, '#34d399', `TP ${this.market.formatPrice(p.tpPrice, st.symbol)}`, [4, 3]);
      });

      if (this.pendingDraftOrder && this.pendingDraftOrder.symbol === st.symbol) {
        const d = this.pendingDraftOrder;
        this._drawPriceLine(ctx, w, h, d.entryPrice, '#00f0ff', `XÁC NHẬN ${d.side} ? @ ${this.market.formatPrice(d.entryPrice, st.symbol)}`, [6, 4]);
        if (d.slPrice) this._drawPriceLine(ctx, w, h, d.slPrice, 'rgba(255,59,107,0.85)', 'DRAFT SL', [3, 3]);
        if (d.tpPrice) this._drawPriceLine(ctx, w, h, d.tpPrice, 'rgba(52,211,153,0.85)', 'DRAFT TP', [3, 3]);
      }

      const curY = this.priceToY(activePx, h);
      ctx.save();
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.55)';
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(this.pad.left, curY);
      ctx.lineTo(w - this.pad.right, curY);
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = '#fbbf24';
      ctx.fillRect(w - this.pad.right + 2, curY - 8, this.pad.right - 4, 16);
      ctx.fillStyle = '#070b14';
      ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
      ctx.fillText(this.market.formatPrice(activePx, st.symbol), w - this.pad.right + 5, curY + 3);

      if (this.showForecast) {
        this._renderAiForecast(ctx, w, h, st, activePx, lastCandleX, curY, symPos, timeMs);
      }

      if (this.mouse.inside && this.mouse.x < w - this.pad.right && this.mouse.y > this.pad.top && this.mouse.y < h - this.pad.bottom) {
        const hoverPx = this.yToPrice(this.mouse.y, h);
        ctx.save();
        ctx.strokeStyle = 'rgba(0, 240, 255, 0.45)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(this.mouse.x, this.pad.top);
        ctx.lineTo(this.mouse.x, h - this.pad.bottom);
        ctx.moveTo(this.pad.left, this.mouse.y);
        ctx.lineTo(w - this.pad.right, this.mouse.y);
        ctx.stroke();

        if (this.clickEnabled) {
          const dir = this.selectedSide === 'LONG' ? 1 : -1;
          const prevSL = hoverPx * (1 - dir * (this.slPct / 100));
          const prevTP = hoverPx * (1 + dir * (this.tpPct / 100));
          const ySL = this.priceToY(prevSL, h);
          const yTP = this.priceToY(prevTP, h);

          ctx.fillStyle = 'rgba(255, 59, 107, 0.08)';
          ctx.fillRect(this.pad.left, Math.min(this.mouse.y, ySL), plotW, Math.abs(ySL - this.mouse.y));
          ctx.fillStyle = 'rgba(16, 185, 129, 0.08)';
          ctx.fillRect(this.pad.left, Math.min(this.mouse.y, yTP), plotW, Math.abs(yTP - this.mouse.y));

          this._drawPriceLine(ctx, w, h, prevSL, 'rgba(255, 59, 107, 0.7)', `PREVIEW SL (-${this.slPct}%)`, [2, 2]);
          this._drawPriceLine(ctx, w, h, prevTP, 'rgba(52, 211, 153, 0.7)', `PREVIEW TP (+${this.tpPct}%)`, [2, 2]);

          ctx.fillStyle = this.selectedSide === 'LONG' ? 'rgba(16, 185, 129, 0.92)' : 'rgba(244, 63, 94, 0.92)';
          const badgeTxt = `CLICK: ${this.selectedSide} LIMIT @ ${this.market.formatPrice(hoverPx, st.symbol)}`;
          ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
          const tw = ctx.measureText(badgeTxt).width + 12;
          const bx = Math.min(w - this.pad.right - tw - 6, Math.max(14, this.mouse.x + 10));
          ctx.fillRect(bx, this.mouse.y - 18, tw, 15);
          ctx.fillStyle = '#040812';
          ctx.fillText(badgeTxt, bx + 6, this.mouse.y - 7);
        }
        ctx.restore();
      }
    }

    _drawPriceLine(ctx, w, h, price, color, label, dash) {
      ctx.save();
      ctx.font = 'bold 9px "JetBrains Mono", monospace';
      if (price > this.priceMax) {
        const pinnedText = `▲ ${label}`;
        const tw = ctx.measureText(pinnedText).width + 10;
        const px = this.pad.left + 4;
        const py = this.pad.top - 12;
        ctx.fillStyle = 'rgba(5, 10, 20, 0.94)';
        ctx.fillRect(px, py, tw, 13);
        ctx.strokeStyle = color;
        ctx.strokeRect(px, py, tw, 13);
        ctx.fillStyle = color;
        ctx.fillText(pinnedText, px + 5, py + 9.5);
        ctx.restore();
        return;
      }
      if (price < this.priceMin) {
        const pinnedText = `▼ ${label}`;
        const tw = ctx.measureText(pinnedText).width + 10;
        const px = this.pad.left + 4;
        const py = h - this.pad.bottom - 14;
        ctx.fillStyle = 'rgba(5, 10, 20, 0.94)';
        ctx.fillRect(px, py, tw, 13);
        ctx.strokeStyle = color;
        ctx.strokeRect(px, py, tw, 13);
        ctx.fillStyle = color;
        ctx.fillText(pinnedText, px + 5, py + 9.5);
        ctx.restore();
        return;
      }

      const y = this.priceToY(price, h);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.1;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(this.pad.left, y);
      ctx.lineTo(w - this.pad.right, y);
      ctx.stroke();

      ctx.setLineDash([]);
      const tw = ctx.measureText(label).width + 8;
      ctx.fillStyle = 'rgba(5, 10, 20, 0.92)';
      ctx.fillRect(this.pad.left + 4, y - 7, tw, 13);
      ctx.strokeStyle = color;
      ctx.strokeRect(this.pad.left + 4, y - 7, tw, 13);
      ctx.fillStyle = color;
      ctx.fillText(label, this.pad.left + 8, y + 2.5);
      ctx.restore();
    }

    _drawRoundedRect(ctx, x, y, w, h, r) {
      const rr = Math.min(r, w * 0.5, h * 0.5);
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + w, y, x + w, y + h, rr);
      ctx.arcTo(x + w, y + h, x, y + h, rr);
      ctx.arcTo(x, y + h, x, y, rr);
      ctx.arcTo(x, y, x + w, y, rr);
      ctx.closePath();
    }

    _getCachedForecast(st, activePx) {
      const ex = (this.trading && typeof this.trading.getPreferredVenue === 'function')
        ? this.trading.getPreferredVenue('HYPERLIQUID')
        : this.market.activeExchange;
      const riskMode = this.trading ? this.trading.riskMode : 'BALANCED';
      const dirMode = this.trading ? this.trading.botDirectionMode : 'AUTO';
      const key = `${st.symbol}|${ex}|${riskMode}|${dirMode}|${this.market.timeframe}`;
      const now = Date.now();
      if (this._forecastCache.data && this._forecastCache.key === key && (now - this._forecastCache.ts) < 240) {
        return this._forecastCache.data;
      }

      const sig = this.market.getDirectionalSignal(st.symbol);
      const slPct = Number(sig.suggestedSlPct || 0.65);
      const plan = (this.trading && typeof this.trading.computeCapitalPlan === 'function')
        ? this.trading.computeCapitalPlan(undefined, undefined, { symbol: st.symbol, exchange: ex, slPct, isMaker: false })
        : { minSignalScore: 33, minTpPct: 1.45 };

      let dirSide = null;
      if (dirMode === 'LONG_ONLY') {
        dirSide = sig.score >= 0 ? 'LONG' : null;
      } else if (dirMode === 'SHORT_ONLY') {
        dirSide = sig.score <= 0 ? 'SHORT' : null;
      } else if (dirMode !== 'HEDGE') {
        dirSide = sig.score >= 0 ? 'LONG' : 'SHORT';
      }

      const reqScore = plan.minSignalScore || 33;
      const absScore = Math.abs(sig.score || 0);
      const tpPct = Number(Math.max(sig.suggestedTpPct || 1.45, plan.minTpPct || 1.45).toFixed(2));
      const dir = dirSide === 'SHORT' ? -1 : 1;
      const projSL = activePx * (1 - dir * (slPct / 100));
      const projTP = activePx * (1 + dir * (tpPct / 100));

      let status = 'WAIT';
      if (!sig.spikeBlocked && dirSide) {
        if (absScore >= reqScore && sig.side === dirSide) status = 'READY';
        else if (absScore >= 16) status = 'FORMING';
      }

      const confObj = this.trading && this.trading._signalConfirmMap
        ? this.trading._signalConfirmMap[st.symbol]
        : null;
      const streak = (confObj && dirSide && confObj.side === dirSide)
        ? Math.min(3, confObj.streak || 0)
        : 0;

      const data = {
        sig,
        dirSide,
        reqScore,
        absScore,
        slPct,
        tpPct,
        projSL,
        projTP,
        status,
        streak
      };
      this._forecastCache = { key, ts: now, data };
      return data;
    }

    _renderAiForecast(ctx, w, h, st, activePx, lastCandleX, curY, symPos, timeMs) {
      const f = this._getCachedForecast(st, activePx);
      const plotTop = this.pad.top + 2;
      const plotBot = h - this.pad.bottom - 2;
      const xStart = lastCandleX + 3;
      const xEnd = w - this.pad.right - 2;
      const laneW = xEnd - xStart;

      // 1. Projected TP / SL Zone & Target Path Arrow in Future Projection Lane
      if (symPos.length === 0 && (f.status === 'READY' || f.status === 'FORMING') && laneW >= 24 && f.dirSide) {
        const isLong = f.dirSide === 'LONG';
        const isReady = f.status === 'READY';
        const mainCol = isLong ? '#34d399' : '#ff3b6b';

        const clampY = (y) => Math.max(plotTop, Math.min(plotBot, y));
        const tpY = clampY(this.priceToY(f.projTP, h));
        const slY = clampY(this.priceToY(f.projSL, h));
        const entryY = clampY(curY);

        ctx.save();
        // Vertical projection origin divider
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(lastCandleX, plotTop);
        ctx.lineTo(lastCandleX, plotBot);
        ctx.stroke();
        ctx.setLineDash([]);

        // Shaded TP Reward Zone & SL Risk Zone
        ctx.fillStyle = isReady ? 'rgba(16, 185, 129, 0.14)' : 'rgba(16, 185, 129, 0.07)';
        ctx.fillRect(xStart, Math.min(entryY, tpY), laneW, Math.max(2, Math.abs(tpY - entryY)));
        ctx.fillStyle = isReady ? 'rgba(255, 59, 107, 0.13)' : 'rgba(255, 59, 107, 0.06)';
        ctx.fillRect(xStart, Math.min(entryY, slY), laneW, Math.max(2, Math.abs(slY - entryY)));

        // Dashed TP & SL boundary lines across future lane
        ctx.strokeStyle = isReady ? 'rgba(52, 211, 153, 0.85)' : 'rgba(52, 211, 153, 0.45)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(xStart, tpY);
        ctx.lineTo(xEnd, tpY);
        ctx.stroke();

        ctx.strokeStyle = isReady ? 'rgba(255, 59, 107, 0.85)' : 'rgba(255, 59, 107, 0.45)';
        ctx.beginPath();
        ctx.moveTo(xStart, slY);
        ctx.lineTo(xEnd, slY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Compact TP / SL % tags inside the future lane
        ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillStyle = '#6ee7b7';
        const tpTagY = tpY <= plotTop + 10 ? tpY + 10 : tpY - 3;
        ctx.fillText(`TP +${f.tpPct.toFixed(1)}%`, xStart + 3, tpTagY);

        ctx.fillStyle = '#fda4af';
        const slTagY = slY >= plotBot - 6 ? slY - 4 : slY + 10;
        ctx.fillText(`SL -${f.slPct.toFixed(1)}%`, xStart + 3, slTagY);

        // Curved predicted trajectory arrow from current candle toward projected target
        const arrowEndX = xEnd - 6;
        const arrowEndY = tpY + (entryY - tpY) * 0.18;
        const cpX = lastCandleX + laneW * 0.45;
        const cpY = entryY + (arrowEndY - entryY) * 0.22;

        ctx.strokeStyle = mainCol;
        ctx.lineWidth = isReady ? 2.1 : 1.5;
        ctx.globalAlpha = isReady ? 0.95 : 0.65;
        if (isReady) {
          ctx.setLineDash([5, 3]);
          ctx.lineDashOffset = -((timeMs || 0) * 0.024) % 16;
          ctx.shadowColor = mainCol;
          ctx.shadowBlur = 8;
        } else {
          ctx.setLineDash([4, 4]);
        }
        ctx.beginPath();
        ctx.moveTo(lastCandleX, entryY);
        ctx.quadraticCurveTo(cpX, cpY, arrowEndX, arrowEndY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.shadowBlur = 0;

        // Arrowhead aligned with tangent at end of curve
        const ang = Math.atan2(arrowEndY - cpY, arrowEndX - cpX);
        const headLen = isReady ? 6.5 : 5;
        ctx.fillStyle = mainCol;
        ctx.beginPath();
        ctx.moveTo(arrowEndX, arrowEndY);
        ctx.lineTo(arrowEndX - headLen * Math.cos(ang - 0.45), arrowEndY - headLen * Math.sin(ang - 0.45));
        ctx.lineTo(arrowEndX - headLen * Math.cos(ang + 0.45), arrowEndY - headLen * Math.sin(ang + 0.45));
        ctx.closePath();
        ctx.fill();

        // Pulsing origin trigger ring on the latest price point
        const pulse = 3.5 + (Math.sin((timeMs || 0) * 0.006) + 1) * (isReady ? 2.2 : 1.0);
        ctx.strokeStyle = mainCol;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(lastCandleX, entryY, pulse, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // 2. Clean top-left AI Forecast Pill Banner
      let pillText = '';
      let pillColor = '#94a3b8';
      let pillBorder = 'rgba(148, 163, 184, 0.4)';
      if (symPos.length > 0) {
        pillText = `✅ ĐANG GIỮ ${symPos[0].side} • THEO DÕI SL/TP`;
        pillColor = '#38bdf8';
        pillBorder = 'rgba(56, 189, 248, 0.55)';
      } else if (f.status === 'READY' && f.dirSide) {
        pillText = `⚡ SẮP VÀO ${f.dirSide} (${f.sig.confidence}%) • XN ${f.streak}/3 • TP +${f.tpPct.toFixed(1)}% / SL -${f.slPct.toFixed(1)}%`;
        pillColor = f.dirSide === 'LONG' ? '#34d399' : '#ff3b6b';
        pillBorder = f.dirSide === 'LONG' ? 'rgba(52, 211, 153, 0.65)' : 'rgba(255, 59, 107, 0.65)';
      } else if (f.status === 'FORMING' && f.dirSide) {
        pillText = `🔮 DỰ ĐOÁN ${f.dirSide} (${f.sig.confidence}%) • Điểm ${f.absScore}/${f.reqScore}`;
        pillColor = '#fbbf24';
        pillBorder = 'rgba(251, 191, 36, 0.55)';
      } else {
        let waitReason = 'Chờ điểm hội tụ';
        if (f.sig.spikeBlocked) waitReason = 'Lọc nến giật';
        else if (String(f.sig.reasons || '').includes('Chờ hồi')) waitReason = 'Chờ hồi giá';
        else if (String(f.sig.reasons || '').includes('NGƯỢC')) waitReason = 'Ngược khung 5m';
        pillText = `🛡 AI ĐỨNG NGOÀI • ${waitReason}`;
        pillColor = '#94a3b8';
        pillBorder = 'rgba(148, 163, 184, 0.35)';
      }

      ctx.save();
      const fontSize = w < 460 ? 8.5 : 9.5;
      ctx.font = `700 ${fontSize}px "JetBrains Mono", monospace`;
      const maxPillW = Math.max(80, (w - this.pad.left - this.pad.right) - 10);
      let drawText = pillText;
      while (ctx.measureText(drawText).width + 14 > maxPillW && drawText.length > 18) {
        drawText = drawText.slice(0, -4) + '...';
      }
      const pw = Math.min(maxPillW, ctx.measureText(drawText).width + 14);
      const ph = 17;
      const px = this.pad.left + 4;
      const py = this.pad.top + 3;

      this._drawRoundedRect(ctx, px, py, pw, ph, 4);
      ctx.fillStyle = 'rgba(6, 10, 18, 0.88)';
      ctx.fill();
      ctx.strokeStyle = pillBorder;
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = pillColor;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(drawText, px + 7, py + ph * 0.54);
      ctx.restore();
    }
  }

  class RadialSphereAndConduitsRenderer {
    constructor(canvas, market, trading = null) {
      this.canvas = canvas;
      this.market = market;
      this.trading = trading;
      this.rotY = 0.25;
      this.rotX = 0.18;
      this.dragging = false;
      this.lastX = 0;
      this.lastY = 0;
      this._downX = 0;
      this._downY = 0;

      this.filaments = [];
      const N = 312;
      const goldenAngle = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < N; i++) {
        const y = 1 - (i / (N - 1)) * 2;
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        const theta = goldenAngle * i;
        const x = Math.cos(theta) * r;
        const z = Math.sin(theta) * r;

        let role;
        if (i % 7 === 0) role = 'GOLD';
        else if (i % 5 === 0) role = 'CYAN';
        else if (i % 4 === 0) role = 'GREEN';
        else if (i % 9 === 0) role = 'RED';
        else if (i % 6 === 0) role = 'VIOLET';
        else role = i % 2 === 0 ? 'GOLD' : 'CYAN';

        this.filaments.push({
          x, y, z,
          baseLen: 0.56 + Math.random() * 0.46,
          phase: Math.random() * Math.PI * 2,
          speed: 0.8 + Math.random() * 1.9,
          role,
          thickness: 0.55 + Math.random() * 0.9
        });
      }

      this.packets = [];
      for (let v = 0; v < 5; v++) {
        for (let k = 0; k < 5; k++) {
          this.packets.push({
            venueIdx: v,
            strand: k % 3,
            t: Math.random(),
            speed: 0.0045 + Math.random() * 0.0055
          });
        }
      }

      this.shockwaves = [];
      this.dollarCoins = [];
      for (let i = 0; i < 6; i++) {
        this.dollarCoins.push({
          u: i / 6,
          strand: i % 2,
          speed: 0.0062 + (i % 3) * 0.0014,
          spin: Math.random() * Math.PI * 2,
          isBurst: false,
          label: null
        });
      }
      this.bagSparkles = [];
      this.bagPopups = [];
      this.bagBounce = 0;
      this.bagFlash = 0;
      this._bagHitbox = null;

      this._bindDrag();
    }

    _bindDrag() {
      this.canvas.addEventListener('mousedown', (e) => {
        this.dragging = true;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this._downX = e.clientX;
        this._downY = e.clientY;
      });
      window.addEventListener('mouseup', () => { this.dragging = false; });
      window.addEventListener('mousemove', (e) => {
        if (!this.dragging) return;
        const dx = e.clientX - this.lastX;
        const dy = e.clientY - this.lastY;
        this.rotY += dx * 0.007;
        this.rotX = Math.max(-1.1, Math.min(1.1, this.rotX + dy * 0.007));
        this.lastX = e.clientX;
        this.lastY = e.clientY;
      });
      this.canvas.addEventListener('click', (e) => {
        if (!this._bagHitbox) return;
        const distMoved = Math.hypot(e.clientX - this._downX, e.clientY - this._downY);
        if (distMoved > 5) return;
        const rect = this.canvas.getBoundingClientRect();
        const lx = e.clientX - rect.left;
        const ly = e.clientY - rect.top;
        const hb = this._bagHitbox;
        if (Math.hypot(lx - hb.x, ly - hb.y) <= hb.r) {
          this.triggerCoinBurst(5, null);
          this.triggerPulse('#fbbf24');
        }
      });

      this.canvas.addEventListener('touchstart', (e) => {
        if (!e.touches || e.touches.length !== 1) {
          this.dragging = false;
          return;
        }
        const touch = e.touches[0];
        this.dragging = true;
        this.lastX = touch.clientX;
        this.lastY = touch.clientY;
        this._downX = touch.clientX;
        this._downY = touch.clientY;
      }, { passive: true });

      this.canvas.addEventListener('touchmove', (e) => {
        if (!this.dragging || !e.touches || e.touches.length !== 1) return;
        e.preventDefault();
        const touch = e.touches[0];
        const dx = touch.clientX - this.lastX;
        const dy = touch.clientY - this.lastY;
        this.rotY += dx * 0.008;
        this.rotX = Math.max(-1.1, Math.min(1.1, this.rotX + dy * 0.008));
        this.lastX = touch.clientX;
        this.lastY = touch.clientY;
      }, { passive: false });

      this.canvas.addEventListener('touchend', (e) => {
        const wasDragging = this.dragging;
        this.dragging = false;
        if (!wasDragging || !this._bagHitbox || !e.changedTouches || !e.changedTouches.length) return;
        const touch = e.changedTouches[0];
        if (Math.hypot(touch.clientX - this._downX, touch.clientY - this._downY) > 8) return;
        const rect = this.canvas.getBoundingClientRect();
        const lx = touch.clientX - rect.left;
        const ly = touch.clientY - rect.top;
        const hb = this._bagHitbox;
        if (Math.hypot(lx - hb.x, ly - hb.y) <= hb.r * 1.25) {
          this.triggerCoinBurst(5, null);
          this.triggerPulse('#fbbf24');
        }
      }, { passive: true });
    }

    triggerPulse(color = '#00f0ff') {
      this.shockwaves.push({ r: 0.15, alpha: 0.95, color });
      if (this.shockwaves.length > 6) this.shockwaves.shift();
    }

    triggerLossPopup(label = '-$') {
      const x = this._bagHitbox ? this._bagHitbox.x : 58;
      const y = this._bagHitbox ? (this._bagHitbox.y - 20) : 160;
      this.bagPopups.push({
        x,
        y,
        vy: -0.55,
        alpha: 1,
        text: label,
        color: '#ff3b6b'
      });
      if (this.bagPopups.length > 8) this.bagPopups.shift();
      this.bagBounce = Math.min(1, this.bagBounce + 0.35);
    }

    triggerCoinBurst(count = 7, label = '+$') {
      const cap = Math.max(0, 36 - this.dollarCoins.length);
      const spawnN = Math.min(count, cap);
      for (let i = 0; i < spawnN; i++) {
        this.dollarCoins.push({
          u: -i * 0.09,
          strand: i % 2,
          speed: 0.011 + Math.random() * 0.004,
          spin: Math.random() * Math.PI * 2,
          isBurst: true,
          label: i === 0 ? label : null
        });
      }
    }

    render(timeMs) {
      const { ctx, w, h } = fitCanvas(this.canvas);
      const st = this.market.getSymbolState();
      const shock = this.market.shockIntensity;
      const t = timeMs * 0.001;

      if (!this.dragging) {
        this.rotY += 0.0036 + shock * 0.009;
      }

      ctx.clearRect(0, 0, w, h);

      const isMobileStacked = typeof document !== 'undefined' && (
        document.documentElement.classList.contains('mobile-viewport-mode') ||
        (w < 540 && !document.documentElement.classList.contains('desktop-viewport-mode'))
      );

      const rightPanelW = isMobileStacked ? 0 : (w < 620 ? 190 : 254);
      const availW = isMobileStacked ? w : Math.max(180, w - rightPanelW);
      const cx = isMobileStacked ? w * 0.65 : availW * 0.50;
      const cy = isMobileStacked ? h * 0.47 : h * 0.51;
      const radius = isMobileStacked
        ? Math.min(w * 0.29, h * 0.39)
        : Math.min(availW * 0.39, h * 0.43);

      const coreGlow = ctx.createRadialGradient(cx, cy, 4, cx, cy, radius * 1.2);
      if (shock > 0.25) {
        coreGlow.addColorStop(0, 'rgba(255, 59, 107, 0.32)');
        coreGlow.addColorStop(0.45, 'rgba(245, 158, 11, 0.14)');
        coreGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      } else {
        coreGlow.addColorStop(0, 'rgba(251, 191, 36, 0.24)');
        coreGlow.addColorStop(0.35, 'rgba(0, 240, 255, 0.10)');
        coreGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      }
      ctx.fillStyle = coreGlow;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 1.2, 0, Math.PI * 2);
      ctx.fill();

      ctx.save();
      ctx.strokeStyle = shock > 0.25 ? 'rgba(255, 59, 107, 0.18)' : 'rgba(56, 189, 248, 0.12)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 6]);
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 1.07, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 0.56, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      if (!isMobileStacked) {
        this._renderConduits(ctx, w, h, cx, cy, radius, rightPanelW, st, shock, t);
      }

      const cosY = Math.cos(this.rotY), sinY = Math.sin(this.rotY);
      const cosX = Math.cos(this.rotX), sinX = Math.sin(this.rotX);
      const projected = [];

      for (let i = 0; i < this.filaments.length; i++) {
        const f = this.filaments[i];
        const x1 = f.x * cosY - f.z * sinY;
        const z1 = f.x * sinY + f.z * cosY;
        const y2 = f.y * cosX - z1 * sinX;
        const z2 = f.y * sinX + z1 * cosX;

        const breath = 1 + Math.sin(t * f.speed + f.phase) * (0.09 + shock * 0.22);
        const len = f.baseLen * breath * (1 + (f.role === 'RED' ? shock * 0.35 : 0));

        const persp = 2.6 / (2.6 - z2 * 0.65);
        const px = cx + x1 * radius * len * persp;
        const py = cy + y2 * radius * len * persp;
        const innerX = cx + x1 * radius * 0.12 * persp;
        const innerY = cy + y2 * radius * 0.12 * persp;

        projected.push({ innerX, innerY, px, py, z: z2, f });
      }

      projected.sort((a, b) => a.z - b.z);

      const palette = {
        GOLD:   { line: 'rgba(251, 191, 36,', dot: '#fde68a' },
        CYAN:   { line: 'rgba(0, 240, 255,',  dot: '#67e8f9' },
        GREEN:  { line: 'rgba(52, 211, 153,', dot: '#6ee7b7' },
        RED:    { line: 'rgba(255, 59, 107,', dot: '#fda4af' },
        VIOLET: { line: 'rgba(167, 139, 250,',dot: '#ddd6fe' }
      };

      for (let i = 0; i < projected.length; i++) {
        const p = projected[i];
        const depthAlpha = Math.max(0.14, Math.min(0.92, (p.z + 1.2) * 0.44));
        const roleKey = (shock > 0.35 && i % 3 === 0) ? 'RED' : p.f.role;
        const pal = palette[roleKey];

        const grad = ctx.createLinearGradient(p.innerX, p.innerY, p.px, p.py);
        grad.addColorStop(0, `${pal.line} ${(depthAlpha * 0.12).toFixed(2)})`);
        grad.addColorStop(0.55, `${pal.line} ${(depthAlpha * 0.52).toFixed(2)})`);
        grad.addColorStop(1, `${pal.line} ${(depthAlpha * 0.95).toFixed(2)})`);

        ctx.strokeStyle = grad;
        ctx.lineWidth = p.f.thickness * (p.z > 0.2 ? 1.25 : 0.8);
        ctx.beginPath();
        ctx.moveTo(p.innerX, p.innerY);
        ctx.lineTo(p.px, p.py);
        ctx.stroke();

        const dotR = (1.15 + (p.z + 1) * 0.75) * (roleKey === 'GOLD' ? 1.15 : 0.95);
        ctx.fillStyle = pal.dot;
        ctx.globalAlpha = depthAlpha;
        ctx.beginPath();
        ctx.arc(p.px, p.py, dotR, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      const nucGrad = ctx.createRadialGradient(cx, cy, 1, cx, cy, 18);
      nucGrad.addColorStop(0, '#ffffff');
      nucGrad.addColorStop(0.35, shock > 0.3 ? '#ff3b6b' : '#fbbf24');
      nucGrad.addColorStop(1, 'rgba(0, 240, 255, 0)');
      ctx.fillStyle = nucGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, 18, 0, Math.PI * 2);
      ctx.fill();

      for (let i = this.shockwaves.length - 1; i >= 0; i--) {
        const sw = this.shockwaves[i];
        sw.r += 0.025;
        sw.alpha *= 0.94;
        ctx.strokeStyle = sw.color;
        ctx.globalAlpha = sw.alpha;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(cx, cy, radius * sw.r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
        if (sw.alpha < 0.03) this.shockwaves.splice(i, 1);
      }

      this._renderFortuneBag(ctx, w, h, cx, cy, radius, availW, shock, t);
    }

    _evalCubic(p0, p1, p2, p3, u) {
      const omt = 1 - u;
      return {
        x: omt * omt * omt * p0.x + 3 * omt * omt * u * p1.x + 3 * omt * u * u * p2.x + u * u * u * p3.x,
        y: omt * omt * omt * p0.y + 3 * omt * omt * u * p1.y + 3 * omt * u * u * p2.y + u * u * u * p3.y
      };
    }

    _drawRoundedRect(ctx, x, y, w, h, r) {
      const rr = Math.min(r, w * 0.5, h * 0.5);
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + w, y, x + w, y + h, rr);
      ctx.arcTo(x + w, y + h, x, y + h, rr);
      ctx.arcTo(x, y + h, x, y, rr);
      ctx.arcTo(x, y, x + w, y, rr);
      ctx.closePath();
    }

    _renderFortuneBag(ctx, w, h, cx, cy, radius, availW, shock, t) {
      if (h < 150 || availW < 180) {
        this._bagHitbox = null;
        return;
      }

      const isMobileStacked = typeof document !== 'undefined' && (
        document.documentElement.classList.contains('mobile-viewport-mode') ||
        (w < 540 && !document.documentElement.classList.contains('desktop-viewport-mode'))
      );

      const scale = isMobileStacked
        ? Math.max(0.98, Math.min(1.18, Math.min(h / 235, w / 330)))
        : Math.max(0.76, Math.min(1.06, Math.min(h / 250, availW / 360)));

      // Compute real-time realized + unrealized PnL directly from trading state
      let realized = 0;
      let unrealized = 0;
      let openCount = 0;
      let totalPnl = 0;
      if (this.trading) {
        realized = Number.isFinite(this.trading.realizedPnl) ? this.trading.realizedPnl : 0;
        const posList = Array.isArray(this.trading.positions) ? this.trading.positions : [];
        openCount = posList.length;
        for (let i = 0; i < posList.length; i++) {
          unrealized += Number.isFinite(posList[i].unrealizedPnl) ? posList[i].unrealizedPnl : 0;
        }
        const balance = Number.isFinite(this.trading.balance) ? this.trading.balance : 0;
        const equity = balance + unrealized;
        const baseEq = Number.isFinite(this.trading.dailyStartEquity)
          ? this.trading.dailyStartEquity
          : (Number.isFinite(this.trading.initialCapital) ? this.trading.initialCapital : equity);
        totalPnl = equity - baseEq;
      }

      const bagX = isMobileStacked
        ? Math.max(58, Math.min(82, w * 0.20))
        : Math.max(52, Math.min(76, availW * 0.155));
      const bagY = isMobileStacked
        ? h - (openCount > 0 ? 50 : 42) * scale
        : h - (openCount > 0 ? 45 : 39) * scale;
      const mouthX = bagX + 1;
      const mouthY = bagY - 17 * scale;
      this._bagHitbox = { x: bagX, y: bagY, r: 28 * scale };

      const sx0 = cx - radius * 0.62;
      const sy0 = cy + radius * 0.10;
      const sx1 = cx - radius * 0.56;
      const sy1 = cy - radius * 0.08;

      const strands = [
        {
          p0: { x: sx0, y: sy0 },
          p1: { x: sx0 - (sx0 - mouthX) * 0.45, y: Math.min(sy0, mouthY) - 24 * scale + Math.sin(t * 1.7) * 4 },
          p2: { x: mouthX + 12 * scale, y: mouthY - 30 * scale },
          p3: { x: mouthX, y: mouthY }
        },
        {
          p0: { x: sx1, y: sy1 },
          p1: { x: sx1 - (sx1 - mouthX) * 0.48, y: Math.min(sy1, mouthY) - 34 * scale + Math.cos(t * 1.4) * 5 },
          p2: { x: mouthX + 6 * scale, y: mouthY - 36 * scale },
          p3: { x: mouthX, y: mouthY }
        }
      ];

      ctx.save();
      strands.forEach((stCurve, idx) => {
        ctx.strokeStyle = idx === 0 ? 'rgba(251, 191, 36, 0.34)' : 'rgba(251, 191, 36, 0.18)';
        ctx.lineWidth = (idx === 0 ? 1.5 : 1.0) * scale;
        ctx.shadowColor = '#fbbf24';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.moveTo(stCurve.p0.x, stCurve.p0.y);
        ctx.bezierCurveTo(stCurve.p1.x, stCurve.p1.y, stCurve.p2.x, stCurve.p2.y, stCurve.p3.x, stCurve.p3.y);
        ctx.stroke();
      });
      ctx.restore();

      this.bagBounce *= 0.88;
      this.bagFlash *= 0.90;

      for (let i = this.dollarCoins.length - 1; i >= 0; i--) {
        const coin = this.dollarCoins[i];
        coin.u += coin.speed * (1 + shock * 0.9);
        coin.spin += 0.14;

        if (coin.u < 0) continue;

        if (coin.u >= 1) {
          this.bagBounce = Math.min(1, this.bagBounce + (coin.isBurst ? 0.48 : 0.22));
          this.bagFlash = Math.min(1, this.bagFlash + (coin.isBurst ? 0.75 : 0.32));

          const sparkCount = coin.isBurst ? 3 : 2;
          for (let s = 0; s < sparkCount; s++) {
            if (this.bagSparkles.length < 40) {
              this.bagSparkles.push({
                x: mouthX + (Math.random() - 0.5) * 14 * scale,
                y: mouthY + (Math.random() - 0.5) * 4 * scale,
                vx: (Math.random() - 0.5) * 1.1,
                vy: -0.6 - Math.random() * 1.1,
                r: (1.2 + Math.random() * 1.4) * scale,
                alpha: 1
              });
            }
          }

          if (coin.label) {
            this.bagPopups.push({
              x: bagX,
              y: mouthY - 4 * scale,
              vy: -0.55,
              alpha: 1,
              text: coin.label,
              color: '#34d399'
            });
            if (this.bagPopups.length > 8) this.bagPopups.shift();
          }

          if (coin.isBurst) {
            this.dollarCoins.splice(i, 1);
          } else {
            coin.u -= 1;
            coin.strand = Math.random() < 0.55 ? 0 : 1;
          }
          continue;
        }

        const curve = strands[coin.strand % strands.length];
        const pos = this._evalCubic(curve.p0, curve.p1, curve.p2, curve.p3, coin.u);
        const tailPos = this._evalCubic(curve.p0, curve.p1, curve.p2, curve.p3, Math.max(0, coin.u - 0.06));

        ctx.save();
        const tailGrad = ctx.createLinearGradient(tailPos.x, tailPos.y, pos.x, pos.y);
        tailGrad.addColorStop(0, 'rgba(251, 191, 36, 0)');
        tailGrad.addColorStop(1, coin.isBurst ? 'rgba(253, 224, 71, 0.75)' : 'rgba(251, 191, 36, 0.45)');
        ctx.strokeStyle = tailGrad;
        ctx.lineWidth = (coin.isBurst ? 2.4 : 1.7) * scale;
        ctx.beginPath();
        ctx.moveTo(tailPos.x, tailPos.y);
        ctx.lineTo(pos.x, pos.y);
        ctx.stroke();

        const r = (coin.isBurst ? 7.2 : 5.8) * scale;
        const spinFactor = 0.42 + 0.58 * Math.abs(Math.cos(coin.spin));
        const rx = r * spinFactor;
        const ry = r;

        const coinGrad = ctx.createRadialGradient(pos.x - rx * 0.25, pos.y - ry * 0.25, 0.5, pos.x, pos.y, r);
        coinGrad.addColorStop(0, '#fef08a');
        coinGrad.addColorStop(0.65, '#f59e0b');
        coinGrad.addColorStop(1, '#b45309');

        ctx.shadowColor = coin.isBurst ? '#fde047' : '#fbbf24';
        ctx.shadowBlur = coin.isBurst ? 12 : 7;
        ctx.fillStyle = coinGrad;
        ctx.strokeStyle = '#fffbeb';
        ctx.lineWidth = 0.9 * scale;
        ctx.beginPath();
        ctx.ellipse(pos.x, pos.y, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        if (spinFactor > 0.55) {
          ctx.shadowBlur = 0;
          ctx.fillStyle = '#451a03';
          ctx.font = `800 ${Math.max(7, Math.round(7.8 * scale))}px "JetBrains Mono", monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('$', pos.x, pos.y + 0.5);
        }
        ctx.restore();
      }

      // Draw Túi Thần Tài (Fortune Bag) with catch bounce
      const sxScale = 1 + this.bagBounce * 0.14;
      const syScale = 1 - this.bagBounce * 0.11;

      ctx.save();
      ctx.translate(bagX, bagY);
      ctx.scale(sxScale, syScale);

      const auraRadius = (30 + this.bagFlash * 10) * scale;
      const auraGrad = ctx.createRadialGradient(0, 0, 3 * scale, 0, 0, auraRadius);
      if (totalPnl > 0.005) {
        auraGrad.addColorStop(0, `rgba(52, 211, 153, ${(0.30 + this.bagFlash * 0.35).toFixed(2)})`);
        auraGrad.addColorStop(0.6, `rgba(251, 191, 36, ${(0.14 + this.bagFlash * 0.12).toFixed(2)})`);
      } else if (totalPnl < -0.005) {
        auraGrad.addColorStop(0, `rgba(255, 59, 107, ${(0.26 + this.bagFlash * 0.25).toFixed(2)})`);
        auraGrad.addColorStop(0.6, `rgba(239, 68, 68, ${(0.12 + this.bagFlash * 0.10).toFixed(2)})`);
      } else {
        auraGrad.addColorStop(0, `rgba(251, 191, 36, ${(0.28 + this.bagFlash * 0.35).toFixed(2)})`);
        auraGrad.addColorStop(0.6, `rgba(239, 68, 68, ${(0.12 + this.bagFlash * 0.12).toFixed(2)})`);
      }
      auraGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = auraGrad;
      ctx.beginPath();
      ctx.arc(0, 0, auraRadius, 0, Math.PI * 2);
      ctx.fill();

      // Ruffled crimson-gold top mouth
      const neckY = -12 * scale;
      ctx.fillStyle = '#dc2626';
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.9)';
      ctx.lineWidth = 1.2 * scale;
      ctx.beginPath();
      ctx.moveTo(-7.5 * scale, neckY);
      ctx.quadraticCurveTo(-13 * scale, -21 * scale, -7 * scale, -22 * scale);
      ctx.quadraticCurveTo(-2.5 * scale, -24.5 * scale, 0, -22.5 * scale);
      ctx.quadraticCurveTo(3.5 * scale, -24.5 * scale, 8 * scale, -22 * scale);
      ctx.quadraticCurveTo(13.5 * scale, -21 * scale, 7.5 * scale, neckY);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Glowing gold inner mouth opening
      const mouthGlow = ctx.createRadialGradient(0, -18 * scale, 1, 0, -18 * scale, 8 * scale);
      mouthGlow.addColorStop(0, '#fef9c3');
      mouthGlow.addColorStop(0.55, '#fbbf24');
      mouthGlow.addColorStop(1, 'rgba(180, 83, 9, 0.8)');
      ctx.fillStyle = mouthGlow;
      ctx.beginPath();
      ctx.ellipse(0, -17.5 * scale, 6.8 * scale, 2.7 * scale, 0, 0, Math.PI * 2);
      ctx.fill();

      // Plump crimson-gold bag belly
      const bellyGrad = ctx.createRadialGradient(-5 * scale, -2 * scale, 2 * scale, 0, 3 * scale, 22 * scale);
      bellyGrad.addColorStop(0, '#ef4444');
      bellyGrad.addColorStop(0.58, '#b91c1c');
      bellyGrad.addColorStop(1, '#7f1d1d');

      ctx.shadowColor = 'rgba(251, 191, 36, 0.35)';
      ctx.shadowBlur = 10;
      ctx.fillStyle = bellyGrad;
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.88)';
      ctx.lineWidth = 1.35 * scale;
      ctx.beginPath();
      ctx.moveTo(-7.5 * scale, neckY);
      ctx.bezierCurveTo(-21 * scale, -4 * scale, -21 * scale, 15 * scale, -10 * scale, 18 * scale);
      ctx.quadraticCurveTo(0, 20.5 * scale, 10 * scale, 18 * scale);
      ctx.bezierCurveTo(21 * scale, 15 * scale, 21 * scale, -4 * scale, 7.5 * scale, neckY);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Subtle silk sheen on the left belly
      ctx.fillStyle = 'rgba(254, 226, 226, 0.16)';
      ctx.beginPath();
      ctx.ellipse(-8.5 * scale, 2.5 * scale, 3.2 * scale, 7.2 * scale, -0.28, 0, Math.PI * 2);
      ctx.fill();

      // Cinched golden drawstring ribbon + dangling tassels
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 2.4 * scale;
      ctx.beginPath();
      ctx.moveTo(-8 * scale, neckY + 0.5 * scale);
      ctx.quadraticCurveTo(0, neckY + 2.5 * scale, 8 * scale, neckY + 0.5 * scale);
      ctx.stroke();

      ctx.lineWidth = 1.2 * scale;
      ctx.beginPath();
      ctx.moveTo(-2.5 * scale, neckY + 1.5 * scale);
      ctx.quadraticCurveTo(-7 * scale, neckY + 5.5 * scale, -9 * scale, neckY + 8.5 * scale);
      ctx.moveTo(2.5 * scale, neckY + 1.5 * scale);
      ctx.quadraticCurveTo(7 * scale, neckY + 5.5 * scale, 9 * scale, neckY + 8.5 * scale);
      ctx.stroke();

      // Gold center coin medallion + $ emblem
      const sealGrad = ctx.createRadialGradient(-2 * scale, 1.5 * scale, 1, 0, 3.5 * scale, 8.8 * scale);
      sealGrad.addColorStop(0, '#fef08a');
      sealGrad.addColorStop(0.65, '#f59e0b');
      sealGrad.addColorStop(1, '#b45309');
      ctx.fillStyle = sealGrad;
      ctx.strokeStyle = '#fde68a';
      ctx.lineWidth = 1.1 * scale;
      ctx.beginPath();
      ctx.arc(0, 3.5 * scale, 8.2 * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#451a03';
      ctx.font = `900 ${Math.max(10, Math.round(11.5 * scale))}px "JetBrains Mono", monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('$', 0, 4.2 * scale);

      ctx.restore();

      // Rising golden sparkles from mouth
      for (let i = this.bagSparkles.length - 1; i >= 0; i--) {
        const sp = this.bagSparkles[i];
        sp.x += sp.vx;
        sp.y += sp.vy;
        sp.alpha -= 0.032;
        if (sp.alpha <= 0) {
          this.bagSparkles.splice(i, 1);
          continue;
        }
        ctx.save();
        ctx.globalAlpha = sp.alpha;
        ctx.fillStyle = '#fef08a';
        ctx.shadowColor = '#fbbf24';
        ctx.shadowBlur = 6;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, sp.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // Floating profit / +$ popups
      for (let i = this.bagPopups.length - 1; i >= 0; i--) {
        const pop = this.bagPopups[i];
        pop.y += pop.vy;
        pop.alpha -= 0.016;
        if (pop.alpha <= 0) {
          this.bagPopups.splice(i, 1);
          continue;
        }
        ctx.save();
        ctx.globalAlpha = Math.min(1, pop.alpha * 1.2);
        ctx.font = `800 ${Math.max(9, Math.round(10 * scale))}px "JetBrains Mono", monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = 'rgba(2, 6, 23, 0.9)';
        ctx.strokeText(pop.text, pop.x, pop.y);
        ctx.fillStyle = pop.color || '#34d399';
        ctx.fillText(pop.text, pop.x, pop.y);
        ctx.restore();
      }

      // Crisp dark-glass pill showing live Profit/Loss beneath the Fortune Bag
      let pillText = 'HÒA $0.00';
      let pillColor = '#fbbf24';
      let pillBorder = 'rgba(251, 191, 36, 0.48)';
      if (totalPnl > 0.005) {
        pillText = `LỜI +$${totalPnl.toFixed(2)}`;
        pillColor = '#34d399';
        pillBorder = 'rgba(52, 211, 153, 0.6)';
      } else if (totalPnl < -0.005) {
        pillText = `LỖ -$${Math.abs(totalPnl).toFixed(2)}`;
        pillColor = '#ff3b6b';
        pillBorder = 'rgba(255, 59, 107, 0.6)';
      }

      const subText = openCount > 0
        ? `Chốt ${realized >= 0 ? '+' : '-'}$${Math.abs(realized).toFixed(2)}`
        : null;

      ctx.save();
      const mainFontPx = Math.max(8, Math.round(9 * scale));
      const subFontPx = Math.max(7, Math.round(7.6 * scale));
      ctx.font = `800 ${mainFontPx}px "JetBrains Mono", monospace`;
      const mainW = ctx.measureText(pillText).width;

      let subW = 0;
      if (subText) {
        ctx.font = `600 ${subFontPx}px "JetBrains Mono", monospace`;
        subW = ctx.measureText(subText).width;
      }

      const pw = Math.max(mainW, subW) + 12 * scale;
      const ph = (subText ? 22 : 15) * scale;
      const px = Math.max(6, bagX - pw * 0.5);
      const py = bagY + 20 * scale;
      const pillCx = px + pw * 0.5;

      this._drawRoundedRect(ctx, px, py, pw, ph, 4 * scale);
      ctx.fillStyle = 'rgba(4, 9, 20, 0.90)';
      ctx.fill();
      ctx.strokeStyle = pillBorder;
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `800 ${mainFontPx}px "JetBrains Mono", monospace`;
      ctx.fillStyle = pillColor;
      ctx.fillText(pillText, pillCx, subText ? py + 7.5 * scale : py + ph * 0.54);

      if (subText) {
        ctx.font = `600 ${subFontPx}px "JetBrains Mono", monospace`;
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(subText, pillCx, py + 16.5 * scale);
      }
      ctx.restore();
    }

    _renderConduits(ctx, w, h, cx, cy, radius, rightPanelW, st, shock, t) {
      const targetX = w - rightPanelW + 2;
      const exchanges = this.market.exchanges;
      const topPad = 8;
      const usableH = h - 16;
      const cardSlotH = usableH / exchanges.length;

      exchanges.forEach((ex, idx) => {
        const targetY = topPad + cardSlotH * (idx + 0.5);
        const isSelected = this.market.activeExchange === ex.id;
        const baseColor = shock > 0.35 ? '#ff3b6b' : ex.color;

        for (let s = 0; s < 3; s++) {
          const angleOffset = (idx - 2) * 0.24 + (s - 1) * 0.07;
          const startX = cx + Math.cos(angleOffset) * radius * 0.68;
          const startY = cy + Math.sin(angleOffset) * radius * 0.68;

          const cp1x = startX + (targetX - startX) * 0.42;
          const cp1y = startY + Math.sin(t * 1.4 + idx + s) * 8;
          const cp2x = targetX - (targetX - startX) * 0.34;
          const cp2y = targetY + (s - 1) * 6;

          ctx.save();
          ctx.strokeStyle = baseColor;
          ctx.globalAlpha = isSelected ? (s === 1 ? 0.85 : 0.42) : (s === 1 ? 0.52 : 0.22);
          ctx.lineWidth = isSelected ? (s === 1 ? 2.1 : 1.0) : (s === 1 ? 1.4 : 0.75);
          if (s === 1) {
            ctx.shadowColor = baseColor;
            ctx.shadowBlur = isSelected ? 10 : 5;
          }
          ctx.beginPath();
          ctx.moveTo(startX, startY);
          ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, targetX, targetY);
          ctx.stroke();
          ctx.restore();
        }

        ctx.fillStyle = baseColor;
        ctx.beginPath();
        ctx.arc(targetX, targetY, isSelected ? 3.5 : 2.4, 0, Math.PI * 2);
        ctx.fill();
      });

      for (const pk of this.packets) {
        pk.t += pk.speed * (1 + shock * 2.4);
        if (pk.t > 1) pk.t -= 1;

        const idx = pk.venueIdx;
        const ex = exchanges[idx];
        const targetY = topPad + cardSlotH * (idx + 0.5);
        const angleOffset = (idx - 2) * 0.24 + (pk.strand - 1) * 0.07;
        const x0 = cx + Math.cos(angleOffset) * radius * 0.68;
        const y0 = cy + Math.sin(angleOffset) * radius * 0.68;
        const x1 = x0 + (targetX - x0) * 0.42;
        const y1 = y0 + Math.sin(t * 1.4 + idx + pk.strand) * 8;
        const x2 = targetX - (targetX - x0) * 0.34;
        const y2 = targetY + (pk.strand - 1) * 6;

        const u = pk.t;
        const omt = 1 - u;
        const bx = omt * omt * omt * x0 + 3 * omt * omt * u * x1 + 3 * omt * u * u * x2 + u * u * u * targetX;
        const by = omt * omt * omt * y0 + 3 * omt * omt * u * y1 + 3 * omt * u * u * y2 + u * u * u * targetY;

        ctx.save();
        ctx.fillStyle = shock > 0.35 ? '#fecdd3' : '#ffffff';
        ctx.shadowColor = shock > 0.35 ? '#ff3b6b' : ex.color;
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(bx, by, 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  }

  class VolatilityRadarRenderer {
    constructor(canvas, market) {
      this.canvas = canvas;
      this.market = market;
      this.angle = 0;
    }

    render(timeMs) {
      const { ctx, w, h } = fitCanvas(this.canvas);
      const st = this.market.getSymbolState();
      const shock = this.market.shockIntensity;
      this.angle += 0.012 + shock * 0.03;

      ctx.clearRect(0, 0, w, h);

      const cx = w * 0.5;
      const cy = h * 0.5;
      const R = Math.min(w, h) * 0.39;
      const accent = shock > 0.3 ? '#ff3b6b' : '#22d3ee';

      ctx.strokeStyle = shock > 0.3 ? 'rgba(255, 59, 107, 0.28)' : 'rgba(56, 189, 248, 0.18)';
      ctx.lineWidth = 1;
      [1, 0.72, 0.44].forEach((scale) => {
        ctx.beginPath();
        ctx.arc(cx, cy, R * scale, 0, Math.PI * 2);
        ctx.stroke();
      });

      ctx.save();
      ctx.strokeStyle = shock > 0.3 ? 'rgba(255, 59, 107, 0.22)' : 'rgba(0, 240, 255, 0.16)';
      for (let i = 0; i < 4; i++) {
        const a = this.angle + (i * Math.PI) / 4;
        const rx = Math.abs(Math.cos(a)) * R;
        ctx.beginPath();
        ctx.ellipse(cx, cy, Math.max(2, rx), R, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.ellipse(cx, cy, R, R * 0.34, 0.25, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      const sweep = (timeMs * 0.0018) % (Math.PI * 2);
      const grad = ctx.createRadialGradient(cx, cy, 2, cx, cy, R);
      grad.addColorStop(0, shock > 0.3 ? 'rgba(255, 59, 107, 0.28)' : 'rgba(0, 240, 255, 0.22)');
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, sweep - 0.55, sweep);
      ctx.closePath();
      ctx.fill();

      const labels = ['VOL', 'SKEW', 'SPRD', 'LIQ', 'DPTH', 'GMA'];
      const axes = st.radarAxes;
      ctx.save();
      ctx.beginPath();
      axes.forEach((val, idx) => {
        const ang = -Math.PI / 2 + (idx * Math.PI * 2) / axes.length;
        const px = cx + Math.cos(ang) * R * val;
        const py = cy + Math.sin(ang) * R * val;
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.fillStyle = shock > 0.3 ? 'rgba(255, 59, 107, 0.28)' : 'rgba(251, 191, 36, 0.18)';
      ctx.strokeStyle = shock > 0.3 ? '#ff3b6b' : '#fbbf24';
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      ctx.font = '8.5px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      axes.forEach((val, idx) => {
        const ang = -Math.PI / 2 + (idx * Math.PI * 2) / axes.length;
        const lx = cx + Math.cos(ang) * (R + 12);
        const ly = cy + Math.sin(ang) * (R + 11) + 3;
        ctx.fillStyle = '#7f95b5';
        ctx.fillText(labels[idx], lx, ly);

        const bx = cx + Math.cos(ang) * R * val;
        const by = cy + Math.sin(ang) * R * val;
        ctx.fillStyle = val > 0.72 ? '#ff3b6b' : accent;
        ctx.beginPath();
        ctx.arc(bx, by, 2.5, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }

  class CvdAndSparkRenderer {
    constructor(cvdCanvas, sparkCanvas, market, trading) {
      this.cvdCanvas = cvdCanvas;
      this.sparkCanvas = sparkCanvas;
      this.market = market;
      this.trading = trading;
    }

    render() {
      this._renderCvd();
      this._renderEquitySpark();
    }

    _renderCvd() {
      const { ctx, w, h } = fitCanvas(this.cvdCanvas);
      const st = this.market.getSymbolState();
      const data = st.cvdHistory;
      if (data.length < 2) return;

      ctx.fillStyle = '#06090f';
      ctx.fillRect(0, 0, w, h);

      let min = Infinity, max = -Infinity;
      for (const v of data) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const absMax = Math.max(Math.abs(min), Math.abs(max), 1.5);
      const padY = 12;
      const midY = h * 0.5;

      ctx.strokeStyle = 'rgba(56, 189, 248, 0.2)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(8, midY);
      ctx.lineTo(w - 8, midY);
      ctx.stroke();
      ctx.setLineDash([]);

      const stepX = (w - 16) / (data.length - 1);

      for (let i = 1; i < data.length; i++) {
        const diff = data[i] - data[i - 1];
        const x = 8 + i * stepX;
        const barH = Math.min(h * 0.34, Math.abs(diff) * 26);
        ctx.fillStyle = diff >= 0 ? 'rgba(16, 185, 129, 0.45)' : 'rgba(255, 59, 107, 0.45)';
        ctx.fillRect(x - 1.5, diff >= 0 ? midY - barH : midY, 3, barH);
      }

      ctx.save();
      ctx.beginPath();
      data.forEach((v, i) => {
        const x = 8 + i * stepX;
        const y = midY - (v / absMax) * (h * 0.5 - padY);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      const lastVal = data[data.length - 1];
      ctx.strokeStyle = lastVal >= 0 ? '#00f0ff' : '#ff3b6b';
      ctx.lineWidth = 1.8;
      ctx.stroke();
      ctx.restore();
    }

    _renderEquitySpark() {
      const { ctx, w, h } = fitCanvas(this.sparkCanvas);
      const eq = this.trading.equityHistory;
      if (eq.length < 2) return;

      ctx.clearRect(0, 0, w, h);
      let min = Math.min(...eq);
      let max = Math.max(...eq);
      if (max - min < 10) { min -= 50; max += 50; }

      const last = eq[eq.length - 1];
      const col = last >= 100000 ? '#34d399' : '#ff3b6b';

      ctx.beginPath();
      eq.forEach((v, i) => {
        const x = (i / (eq.length - 1)) * w;
        const y = h - 3 - ((v - min) / (max - min)) * (h - 6);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
  }

  global.QuantumVisualizers = {
    CandlestickChartRenderer,
    RadialSphereAndConduitsRenderer,
    VolatilityRadarRenderer,
    CvdAndSparkRenderer
  };
})(window);
