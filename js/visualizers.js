/* ==========================================================================
   QUANTUM CORE // 60FPS HiDPI Canvas Visualizers
   1. Interactive Candlestick Chart (Click-to-place Limit + Entry/SL/TP overlays)
   2. 3D Liquidity & Orderflow Radial Sphere + Sweeping Bezier Venue Conduits
   3. 3D Volatility & Regime Wireframe Radar Sphere
   4. CVD Orderflow Waterfall & KPI Equity Sparkline
   ========================================================================== */

(function (global) {
  'use strict';

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

  /* ========================================================================
     1. INTERACTIVE CANDLESTICK CHART WITH CLICK-TO-PLACE LIMIT + SL/TP
     ======================================================================== */
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

      this.priceMin = 0;
      this.priceMax = 1;
      this.pad = { top: 14, right: 72, bottom: 22, left: 10 };

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

    render() {
      const { ctx, w, h } = fitCanvas(this.canvas);
      const st = this.market.getSymbolState();
      const candles = st.candles.slice(-78);
      if (candles.length < 2) return;

      // Clear
      ctx.fillStyle = '#050a14';
      ctx.fillRect(0, 0, w, h);

      // Compute price bounds including active orders/positions for active symbol
      let lo = Infinity, hi = -Infinity, maxVol = 1;
      for (const c of candles) {
        if (c.l < lo) lo = c.l;
        if (c.h > hi) hi = c.h;
        if (c.v > maxVol) maxVol = c.v;
      }

      const symOrders = this.trading.limitOrders.filter((o) => o.symbol === st.symbol);
      const symPos = this.trading.positions.filter((p) => p.symbol === st.symbol);
      for (const o of [...symOrders, ...symPos]) {
        if (o.entryPrice) { lo = Math.min(lo, o.entryPrice); hi = Math.max(hi, o.entryPrice); }
        if (o.slPrice) { lo = Math.min(lo, o.slPrice); hi = Math.max(hi, o.slPrice); }
        if (o.tpPrice) { lo = Math.min(lo, o.tpPrice); hi = Math.max(hi, o.tpPrice); }
      }

      const span = Math.max(hi - lo, st.price * 0.0025);
      this.priceMin = lo - span * 0.14;
      this.priceMax = hi + span * 0.14;

      const plotW = w - this.pad.left - this.pad.right;
      const plotH = h - this.pad.top - this.pad.bottom;

      // Tactical gridlines
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

      const stepX = plotW / candles.length;
      const bodyW = Math.max(2.5, stepX * 0.62);

      // Volume bars + glowing area fill under close curve
      const areaGrad = ctx.createLinearGradient(0, this.pad.top, 0, h - this.pad.bottom);
      areaGrad.addColorStop(0, this.market.shockIntensity > 0.2 ? 'rgba(255, 59, 107, 0.18)' : 'rgba(0, 240, 255, 0.13)');
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

      // Volume Histogram + Candlesticks
      let ema = candles[0].c;
      const emaPts = [];
      let vwapSumPV = 0, vwapSumV = 0;
      const vwapPts = [];

      candles.forEach((c, idx) => {
        const x = this.pad.left + idx * stepX + stepX * 0.5;
        const isUp = c.c >= c.o;

        // Volume bar
        const volH = (c.v / maxVol) * (plotH * 0.2);
        ctx.fillStyle = isUp ? 'rgba(16, 185, 129, 0.22)' : 'rgba(255, 59, 107, 0.22)';
        ctx.fillRect(x - bodyW * 0.5, h - this.pad.bottom - volH, bodyW, volH);

        // Wick
        const yH = this.priceToY(c.h, h);
        const yL = this.priceToY(c.l, h);
        const yO = this.priceToY(c.o, h);
        const yC = this.priceToY(c.c, h);
        const col = isUp ? '#22d3ee' : '#ff3b6b';

        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, yH);
        ctx.lineTo(x, yL);
        ctx.stroke();

        // Body
        const top = Math.min(yO, yC);
        const bh = Math.max(1.5, Math.abs(yC - yO));
        ctx.fillStyle = isUp ? '#10b981' : '#f43f5e';
        ctx.fillRect(x - bodyW * 0.5, top, bodyW, bh);

        // EMA & VWAP
        ema = ema * 0.82 + c.c * 0.18;
        emaPts.push({ x, y: this.priceToY(ema, h) });

        vwapSumPV += ((c.h + c.l + c.c) / 3) * c.v;
        vwapSumV += c.v;
        vwapPts.push({ x, y: this.priceToY(vwapSumPV / vwapSumV, h) });
      });

      // Glowing EMA line (Cyan)
      ctx.save();
      ctx.strokeStyle = '#00f0ff';
      ctx.lineWidth = 1.4;
      ctx.shadowColor = '#00f0ff';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      emaPts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
      ctx.restore();

      // Glowing VWAP line (Gold)
      ctx.save();
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      vwapPts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
      ctx.restore();

      // Draw Open Limit Orders (Entry + SL + TP)
      symOrders.forEach((o) => {
        this._drawPriceLine(ctx, w, h, o.entryPrice, '#fbbf24', `LIMIT ${o.side} $${(o.sizeUsd / 1000).toFixed(1)}k`, [5, 4]);
        if (o.slPrice) this._drawPriceLine(ctx, w, h, o.slPrice, 'rgba(255,59,107,0.75)', `SL`, [2, 3]);
        if (o.tpPrice) this._drawPriceLine(ctx, w, h, o.tpPrice, 'rgba(52,211,153,0.75)', `TP`, [2, 3]);
      });

      // Draw Active Positions (Entry + SL + TP + Live PnL)
      symPos.forEach((p) => {
        const pnlStr = `${p.unrealizedPnl >= 0 ? '+' : ''}$${p.unrealizedPnl.toFixed(0)}`;
        const col = p.side === 'LONG' ? '#00f0ff' : '#fb7185';
        this._drawPriceLine(ctx, w, h, p.entryPrice, col, `POS ${p.side} ${pnlStr}`, []);
        if (p.slPrice) this._drawPriceLine(ctx, w, h, p.slPrice, '#ff3b6b', `SL ${this.market.formatPrice(p.slPrice, st.symbol)}`, [4, 3]);
        if (p.tpPrice) this._drawPriceLine(ctx, w, h, p.tpPrice, '#34d399', `TP ${this.market.formatPrice(p.tpPrice, st.symbol)}`, [4, 3]);
      });

      // Current Mark Price Tag on Right Axis
      const curY = this.priceToY(st.price, h);
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
      ctx.fillText(this.market.formatPrice(st.price, st.symbol), w - this.pad.right + 5, curY + 3);

      // Interactive Hover Crosshair + Click-to-Limit SL/TP Ghost Preview!
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

          // Ghost risk/reward zones
          ctx.fillStyle = 'rgba(255, 59, 107, 0.08)';
          ctx.fillRect(this.pad.left, Math.min(this.mouse.y, ySL), plotW, Math.abs(ySL - this.mouse.y));
          ctx.fillStyle = 'rgba(16, 185, 129, 0.08)';
          ctx.fillRect(this.pad.left, Math.min(this.mouse.y, yTP), plotW, Math.abs(yTP - this.mouse.y));

          // Ghost SL & TP lines
          this._drawPriceLine(ctx, w, h, prevSL, 'rgba(255, 59, 107, 0.7)', `PREVIEW SL (-${this.slPct}%)`, [2, 2]);
          this._drawPriceLine(ctx, w, h, prevTP, 'rgba(52, 211, 153, 0.7)', `PREVIEW TP (+${this.tpPct}%)`, [2, 2]);

          // Click Action Pill
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
      const y = this.priceToY(price, h);
      if (y < this.pad.top - 4 || y > h - this.pad.bottom + 4) return;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.1;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(this.pad.left, y);
      ctx.lineTo(w - this.pad.right, y);
      ctx.stroke();

      ctx.setLineDash([]);
      ctx.font = 'bold 9px "JetBrains Mono", monospace';
      const tw = ctx.measureText(label).width + 8;
      ctx.fillStyle = 'rgba(5, 10, 20, 0.9)';
      ctx.fillRect(this.pad.left + 4, y - 7, tw, 13);
      ctx.strokeStyle = color;
      ctx.strokeRect(this.pad.left + 4, y - 7, tw, 13);
      ctx.fillStyle = color;
      ctx.fillText(label, this.pad.left + 8, y + 2.5);
      ctx.restore();
    }
  }

  /* ========================================================================
     2. 3D LIQUIDITY & ORDERFLOW RADIAL SPHERE + BEZIER VENUE CONDUITS
        (Hero centerpiece modeled directly after the reference video!)
     ======================================================================== */
  class RadialSphereAndConduitsRenderer {
    constructor(canvas, market) {
      this.canvas = canvas;
      this.market = market;
      this.rotY = 0.25;
      this.rotX = 0.18;
      this.dragging = false;
      this.lastX = 0;
      this.lastY = 0;
      this.pulsePhase = 0;

      // Build 312 Fibonacci-sphere radial filaments
      this.filaments = [];
      const N = 312;
      const goldenAngle = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < N; i++) {
        const y = 1 - (i / (N - 1)) * 2;
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        const theta = goldenAngle * i;
        const x = Math.cos(theta) * r;
        const z = Math.sin(theta) * r;

        // Assign semantic venue & color cluster matching video aesthetic (warm gold core + cyan/emerald/violet/crimson)
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
          venueIdx: i % 5,
          thickness: 0.55 + Math.random() * 0.9
        });
      }

      // Animated data packets streaming along Bezier conduits to the 5 venue cards
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
      this._bindDrag();
    }

    _bindDrag() {
      this.canvas.addEventListener('mousedown', (e) => {
        this.dragging = true;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
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
    }

    triggerPulse(color = '#00f0ff') {
      this.shockwaves.push({ r: 0.15, alpha: 0.95, color });
      if (this.shockwaves.length > 6) this.shockwaves.shift();
    }

    render(timeMs) {
      const { ctx, w, h } = fitCanvas(this.canvas);
      const st = this.market.getSymbolState();
      const shock = this.market.shockIntensity;
      const t = timeMs * 0.001;

      if (!this.dragging) {
        this.rotY += 0.0032 + shock * 0.009;
      }

      ctx.clearRect(0, 0, w, h);

      // Determine Sphere center (left-of-center to leave room for glowing Bezier conduits -> right cards)
      const rightPanelW = w < 620 ? 190 : 254;
      const availW = Math.max(180, w - rightPanelW);
      const cx = availW * 0.50;
      const cy = h * 0.51;
      const radius = Math.min(availW * 0.39, h * 0.43);

      // Ambient Core Glow behind sphere
      const coreGlow = ctx.createRadialGradient(cx, cy, 4, cx, cy, radius * 1.25);
      if (shock > 0.25) {
        coreGlow.addColorStop(0, 'rgba(255, 59, 107, 0.34)');
        coreGlow.addColorStop(0.45, 'rgba(245, 158, 11, 0.14)');
        coreGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      } else {
        coreGlow.addColorStop(0, 'rgba(251, 191, 36, 0.26)');
        coreGlow.addColorStop(0.35, 'rgba(0, 240, 255, 0.11)');
        coreGlow.addColorStop(0.7, 'rgba(56, 189, 248, 0.03)');
        coreGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      }
      ctx.fillStyle = coreGlow;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 1.25, 0, Math.PI * 2);
      ctx.fill();

      // Subtle concentric HUD rings around sphere
      ctx.save();
      ctx.strokeStyle = shock > 0.25 ? 'rgba(255, 59, 107, 0.18)' : 'rgba(56, 189, 248, 0.11)';
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

      // Draw Sweeping Bezier Conduit Curves connecting Sphere -> 5 Right-Side Venue Cards
      this._renderConduits(ctx, w, h, cx, cy, radius, rightPanelW, st, shock, t);

      // Project & sort 3D radial filaments back-to-front
      const cosY = Math.cos(this.rotY), sinY = Math.sin(this.rotY);
      const cosX = Math.cos(this.rotX), sinX = Math.sin(this.rotX);
      const projected = [];

      for (let i = 0; i < this.filaments.length; i++) {
        const f = this.filaments[i];
        // Rotate Y then X
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

        projected.push({
          innerX, innerY, px, py, z: z2, f, persp
        });
      }

      projected.sort((a, b) => a.z - b.z);

      const palette = {
        GOLD:   { line: 'rgba(251, 191, 36,', dot: '#fde68a' },
        CYAN:   { line: 'rgba(0, 240, 255,',  dot: '#67e8f9' },
        GREEN:  { line: 'rgba(52, 211, 153,', dot: '#6ee7b7' },
        RED:    { line: 'rgba(255, 59, 107,', dot: '#fda4af' },
        VIOLET: { line: 'rgba(167, 139, 250,',dot: '#ddd6fe' }
      };

      // Render Radial Starburst Filaments + Luminous Tip Nodes
      for (let i = 0; i < projected.length; i++) {
        const p = projected[i];
        const depthAlpha = Math.max(0.14, Math.min(0.92, (p.z + 1.2) * 0.44));
        const roleKey = (shock > 0.35 && i % 3 === 0) ? 'RED' : p.f.role;
        const pal = palette[roleKey];

        // Tapered filament ray
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

        // Bright terminal node dot
        const dotR = (1.15 + (p.z + 1) * 0.75) * (roleKey === 'GOLD' ? 1.15 : 0.95);
        ctx.fillStyle = pal.dot;
        ctx.globalAlpha = depthAlpha;
        ctx.beginPath();
        ctx.arc(p.px, p.py, dotR, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // Glowing Central Nucleus
      const nucGrad = ctx.createRadialGradient(cx, cy, 1, cx, cy, 18);
      nucGrad.addColorStop(0, '#ffffff');
      nucGrad.addColorStop(0.35, shock > 0.3 ? '#ff3b6b' : '#fbbf24');
      nucGrad.addColorStop(1, 'rgba(0, 240, 255, 0)');
      ctx.fillStyle = nucGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, 18, 0, Math.PI * 2);
      ctx.fill();

      // Expanding Shockwaves on Trade Executions / Whale Alerts
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

        // Draw 3 graceful layered Bezier fibers per exchange (just like the video's flowing ribbons)
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
          ctx.globalAlpha = isSelected ? (s === 1 ? 0.85 : 0.42) : (s === 1 ? 0.48 : 0.2);
          ctx.lineWidth = isSelected ? (s === 1 ? 2.1 : 1.0) : (s === 1 ? 1.35 : 0.75);
          if (s === 1) {
            ctx.shadowColor = baseColor;
            ctx.shadowBlur = isSelected ? 12 : 6;
          }
          ctx.beginPath();
          ctx.moveTo(startX, startY);
          ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, targetX, targetY);
          ctx.stroke();
          ctx.restore();
        }

        // Terminal connector glow dot right at the left edge of each venue card
        ctx.fillStyle = baseColor;
        ctx.beginPath();
        ctx.arc(targetX, targetY, isSelected ? 3.5 : 2.4, 0, Math.PI * 2);
        ctx.fill();
      });

      // Animate luminous orderflow packets travelling along the Bezier splines
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
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(bx, by, 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  }

  /* ========================================================================
     3. 3D VOLATILITY & REGIME WIREFRAME RADAR SPHERE
     ======================================================================== */
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

      // Outer compass rings
      ctx.strokeStyle = shock > 0.3 ? 'rgba(255, 59, 107, 0.28)' : 'rgba(56, 189, 248, 0.18)';
      ctx.lineWidth = 1;
      [1, 0.72, 0.44].forEach((scale) => {
        ctx.beginPath();
        ctx.arc(cx, cy, R * scale, 0, Math.PI * 2);
        ctx.stroke();
      });

      // Rotating 3D wireframe meridians & latitudes (matching top-right globe in reference video)
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

      // Sweeping radar beam
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

      // 6-Axis Volatility Surface Polygon
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

      // Axis labels & glowing blips
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

  /* ========================================================================
     4. CVD ORDERFLOW WATERFALL + KPI EQUITY SPARKLINE
     ======================================================================== */
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

      ctx.fillStyle = '#050a14';
      ctx.fillRect(0, 0, w, h);

      let min = Infinity, max = -Infinity;
      for (const v of data) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const absMax = Math.max(Math.abs(min), Math.abs(max), 1.5);
      const padY = 12;
      const midY = h * 0.5;

      // Zero line
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.2)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(8, midY);
      ctx.lineTo(w - 8, midY);
      ctx.stroke();
      ctx.setLineDash([]);

      const stepX = (w - 16) / (data.length - 1);

      // Delta impulse histogram bars
      for (let i = 1; i < data.length; i++) {
        const diff = data[i] - data[i - 1];
        const x = 8 + i * stepX;
        const barH = Math.min(h * 0.34, Math.abs(diff) * 26);
        ctx.fillStyle = diff >= 0 ? 'rgba(16, 185, 129, 0.45)' : 'rgba(255, 59, 107, 0.45)';
        ctx.fillRect(x - 1.5, diff >= 0 ? midY - barH : midY, 3, barH);
      }

      // Glowing CVD Line
      ctx.save();
      ctx.beginPath();
      data.forEach((v, i) => {
        const x = 8 + i * stepX;
        const y = midY - (v / absMax) * (h * 0.5 - padY);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      const lastVal = data[data.length - 1];
      const lineColor = lastVal >= 0 ? '#00f0ff' : '#ff3b6b';
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 1.8;
      ctx.shadowColor = lineColor;
      ctx.shadowBlur = 8;
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
