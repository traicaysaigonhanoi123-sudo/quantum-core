/* ==========================================================================
   QUANTUM CORE // Application Controller
   Wires MarketEngine, TradingEngine, 60FPS Visualizers, DOM & Live API Modal
   ========================================================================== */

(function () {
  'use strict';

  const market = new window.QuantumMarketEngine();
  const trading = new window.QuantumTradingEngine(market);
  const {
    CandlestickChartRenderer,
    RadialSphereAndConduitsRenderer,
    VolatilityRadarRenderer,
    CvdAndSparkRenderer
  } = window.QuantumVisualizers;

  // UI State
  let selectedSide = 'LONG';
  let activeBlotterTab = 'positions';

  // DOM helpers
  const $ = (id) => document.getElementById(id);

  // Instantiate 60FPS Visualizers
  const candleRenderer = new CandlestickChartRenderer(
    $('candleChartCanvas'),
    market,
    trading,
    (clickedPrice) => handleChartClickOrder(clickedPrice)
  );
  const sphereRenderer = new RadialSphereAndConduitsRenderer($('sphereCanvas'), market);
  const radarRenderer = new VolatilityRadarRenderer($('radarCanvas'), market);
  const cvdRenderer = new CvdAndSparkRenderer($('cvdCanvas'), $('kpiSparkCanvas'), market, trading);

  /* ==================== TOAST NOTIFICATIONS ==================== */
  function showToast({ type = 'cyan', title, msg }) {
    const stack = $('toastStack');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<div class="toast-title">${title}</div><div>${msg}</div>`;
    stack.prepend(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(20px)';
      el.style.transition = 'all 0.25s ease';
      setTimeout(() => el.remove(), 260);
    }, 3800);
  }

  /* ==================== CLICK-ON-CHART LIMIT ORDER ==================== */
  function handleChartClickOrder(price) {
    const dec = market.getDecimals();
    const roundedPx = Number(price.toFixed(dec));
    $('inpEntry').value = roundedPx;
    updateSLTPPreview();

    const sizeUsd = parseFloat($('inpSize').value) || 5000;
    const slPct = parseFloat($('inpSlPct').value) || 0.8;
    const tpPct = parseFloat($('inpTpPct').value) || 1.8;
    const leverage = parseInt($('selLeverage').value, 10) || 5;

    const placed = trading.placeLimitOrder({
      symbol: market.activeSymbol,
      exchange: market.activeExchange,
      side: selectedSide,
      entryPrice: roundedPx,
      sizeUsd,
      leverage,
      slPct,
      tpPct,
      source: 'CHART CLICK'
    });

    if (placed) {
      sphereRenderer.triggerPulse(selectedSide === 'LONG' ? '#34d399' : '#ff3b6b');
    }
  }

  /* ==================== SL / TP / NET R:R PREVIEW & AUTO-SIZING ==================== */
  function syncAutoSize() {
    if (!trading.riskShield.autoSizeEnabled) return;
    const slPct = parseFloat($('inpSlPct').value) || 0.8;
    const optSize = trading.calculateOptimalSize({
      symbol: market.activeSymbol,
      exchange: market.activeExchange,
      slPct,
      isMaker: trading.riskShield.postOnlyMaker
    });
    $('inpSize').value = optSize;
  }

  function updateSLTPPreview() {
    const sym = market.activeSymbol;
    const refPx = parseFloat($('inpEntry').value) || market.getPrice(sym);
    const slPct = parseFloat($('inpSlPct').value) || 0.8;
    const tpPct = parseFloat($('inpTpPct').value) || 1.8;
    const sizeUsd = parseFloat($('inpSize').value) || 5000;
    const leverage = parseInt($('selLeverage').value, 10) || 5;
    const dir = selectedSide === 'LONG' ? 1 : -1;

    const slPx = refPx * (1 - dir * (slPct / 100));
    const tpPx = refPx * (1 + dir * (tpPct / 100));

    // Evaluate true fee-adjusted Net R:R via Risk Shield
    const ex = market.activeExchange === 'ALL' ? 'HYPERLIQUID' : market.activeExchange;
    const entryFeeBps = market.getVenueFeeBps(ex, trading.riskShield.postOnlyMaker);
    const exitFeeBps = market.getVenueFeeBps(ex, false);
    const feePct = (entryFeeBps + exitFeeBps + 0.35) / 100;
    const netRR = (tpPct - feePct) / Math.max(0.05, slPct + feePct);
    const maxLossUsd = sizeUsd * ((slPct + feePct) / 100);

    $('previewSL').textContent = market.formatPrice(slPx, sym);
    $('previewTP').textContent = market.formatPrice(tpPx, sym);

    const rrEl = $('previewRR');
    rrEl.textContent = `1 : ${Math.max(0, netRR).toFixed(2)}`;
    rrEl.className = netRR >= trading.riskShield.minNetRR ? 'pos' : 'neg';

    const riskEl = $('previewMaxLoss');
    if (riskEl) riskEl.textContent = `-$${maxLossUsd.toFixed(0)}`;

    // Cap leverage selector visually if Risk Shield is active
    if (trading.riskShield.enabled && leverage > trading.riskShield.maxSafeLeverage) {
      $('selLeverage').title = `Risk Shield giới hạn đòn bẩy an toàn tối đa ${trading.riskShield.maxSafeLeverage}x`;
    }

    candleRenderer.selectedSide = selectedSide;
    candleRenderer.slPct = slPct;
    candleRenderer.tpPct = tpPct;
  }

  /* ==================== VENUE CARDS STACK (CONNECTED TO SPHERE CONDUITS) ==================== */
  function buildVenueCards() {
    const stack = $('venueCardsStack');
    stack.innerHTML = '';
    market.exchanges.forEach((ex) => {
      const card = document.createElement('div');
      card.className = 'venue-card';
      card.dataset.exchange = ex.id;
      card.style.borderLeftColor = ex.color;
      card.innerHTML = `
        <div class="vc-left">
          <div class="vc-name-row">
            <span class="vc-name">${ex.name}</span>
            <span class="vc-type">${ex.tag}</span>
          </div>
          <div class="vc-price" id="vcPx_${ex.id}">--</div>
          <div class="vc-meta" id="vcFlow_${ex.id}">Flow: --</div>
        </div>
        <div class="vc-score-box">
          <div class="vc-score" id="vcScore_${ex.id}" style="color:${ex.color}">--</div>
          <div class="vc-score-lbl">LIQ SCORE</div>
        </div>
      `;
      card.addEventListener('click', () => {
        const nextEx = market.activeExchange === ex.id ? 'ALL' : ex.id;
        selectExchange(nextEx);
      });
      stack.appendChild(card);
    });
  }

  function updateVenueCards(st) {
    let topVenue = 'HYPERLIQUID';
    let topScore = -1;
    market.exchanges.forEach((ex) => {
      const px = st.venuePrices[ex.id];
      const flow = st.venueFlow[ex.id];
      const score = st.venueScores[ex.id];
      if (score > topScore) { topScore = score; topVenue = ex.name; }

      const pxEl = $(`vcPx_${ex.id}`);
      const flEl = $(`vcFlow_${ex.id}`);
      const scEl = $(`vcScore_${ex.id}`);
      if (pxEl) pxEl.textContent = `$${market.formatPrice(px, st.symbol)}`;
      if (flEl) {
        const m = flow / 1e6;
        flEl.innerHTML = `Flow: <span class="${m >= 0 ? 'pos' : 'neg'}">${m >= 0 ? '+' : ''}$${m.toFixed(2)}M</span>`;
      }
      if (scEl) scEl.textContent = score;
    });
    $('sphereWhale').textContent = topVenue;

    document.querySelectorAll('.venue-card').forEach((card) => {
      card.classList.toggle('selected', card.dataset.exchange === market.activeExchange);
    });
  }

  /* ==================== ORDERBOOK & LIVE TAPE ==================== */
  function renderOrderbook(st) {
    const ob = st.orderbook;
    const sym = st.symbol;
    const bidPct = Math.round(ob.bidRatio * 100);
    const askPct = 100 - bidPct;

    $('obImbBid').style.width = `${bidPct}%`;
    $('obImbAsk').style.width = `${askPct}%`;
    $('obBidPct').textContent = `BID ${bidPct}%`;
    $('obAskPct').textContent = `${askPct}% ASK`;
    $('obVenueTag').textContent = market.activeExchange === 'ALL' ? 'AGGREGATED' : market.activeExchange;

    const mid = market.getPrice(sym, market.activeExchange);
    $('obMidPrice').textContent = `$${market.formatPrice(mid, sym)}`;
    $('obSpreadVal').textContent = `Spread: ${ob.spreadBps.toFixed(1)} bps`;

    const buildRows = (rows, type) =>
      rows
        .map(
          (r) => `
          <div class="ob-row ${type}" data-price="${r.price.toFixed(market.getDecimals(sym))}">
            <div class="ob-depth-bg" style="width:${r.pct.toFixed(1)}%"></div>
            <span class="${type === 'ask' ? 'neg' : 'pos'}">${market.formatPrice(r.price, sym)}</span>
            <span>${r.qty.toFixed(sym === 'BTC-PERP' ? 2 : 1)}</span>
            <span class="muted">$${(r.totalUsd / 1000).toFixed(0)}k</span>
          </div>`
        )
        .join('');

    $('obAsks').innerHTML = buildRows(ob.asks, 'ask');
    $('obBids').innerHTML = buildRows(ob.bids, 'bid');
  }

  function renderTape(st) {
    const html = st.tape
      .slice(0, 22)
      .map(
        (tr) => `
        <div class="tape-row ${tr.whale ? 'whale' : ''}">
          <span class="tape-ex">${tr.shortEx}</span>
          <span class="${tr.side === 'BUY' ? 'pos' : 'neg'}">${market.formatPrice(tr.price, st.symbol)}</span>
          <span class="${tr.whale ? 'gold' : ''}">$${tr.usdSize >= 100000 ? (tr.usdSize / 1000).toFixed(0) + 'K 🐋' : (tr.usdSize / 1000).toFixed(1) + 'K'}</span>
          <span class="muted">${tr.time}</span>
        </div>`
      )
      .join('');
    $('tapeList').innerHTML = html;
  }

  /* ==================== BLOTTER TABLES & ACCOUNT HUD ==================== */
  function renderTradingPanels() {
    const m = trading.getMetrics();

    $('kpiEquity').textContent = `$${m.equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const uSign = m.unrealizedPnl >= 0 ? '+' : '';
    const uEl = $('kpiUnrealized');
    uEl.textContent = `uPnL: ${uSign}$${m.unrealizedPnl.toFixed(2)} (${uSign}${m.unrealizedPct.toFixed(2)}%)`;
    uEl.className = `kpi-pnl ${m.unrealizedPnl >= 0 ? 'pos' : 'neg'}`;

    $('kpiDrawdown').textContent = `DD: ${m.drawdownPct.toFixed(2)}%`;
    $('kpiFreeMargin').textContent = `$${m.freeMargin.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const rSign = m.realizedPnl >= 0 ? '+' : '';
    const rEl = $('kpiRealized');
    rEl.textContent = `${rSign}$${m.realizedPnl.toFixed(2)}`;
    rEl.className = `ms-val ${m.realizedPnl >= 0 ? 'pos' : 'neg'}`;

    $('kpiWinRate').textContent = `${m.winRate.toFixed(1)}% (${m.wins}/${m.wins + m.losses})`;

    // Counts
    $('cntPos').textContent = trading.positions.length;
    $('cntOrd').textContent = trading.limitOrders.length;
    $('cntHist').textContent = trading.history.length;

    // Bot Pill & Button
    const botPill = $('botStatePill');
    const botBtn = $('btnToggleBot');
    if (trading.breakerTripped) {
      botPill.textContent = 'TRIPPED';
      botPill.className = 'bot-state-pill tripped';
      botBtn.textContent = '⛔ ĐÃ NGẮT BẢO VỆ';
      botBtn.classList.remove('running');
    } else if (trading.botRunning) {
      botPill.textContent = `ACTIVE: ${trading.botStrategy}`;
      botPill.className = 'bot-state-pill running';
      botBtn.textContent = '⏸ TẠM DỪNG BOT';
      botBtn.classList.add('running');
    } else {
      botPill.textContent = 'IDLE';
      botPill.className = 'bot-state-pill idle';
      botBtn.textContent = '▶ CHẠY BOT TỰ ĐỘNG';
      botBtn.classList.remove('running');
    }

    // Circuit Breaker HUD Indicators
    const stripB = $('stripBreaker');
    if (trading.breakerTripped) {
      stripB.textContent = 'TRIPPED ⚠';
      stripB.className = 'sm-val tripped';
      $('breakerBanner').classList.remove('hidden');
      $('breakerReason').textContent = trading.breakerReason;
      $('shockVignette').classList.add('active');
    } else {
      stripB.textContent = 'ARMED ●';
      stripB.className = 'sm-val armed';
      $('breakerBanner').classList.add('hidden');
      if (market.shockIntensity < 0.2) $('shockVignette').classList.remove('active');
    }

    // Positions Table
    if (trading.positions.length === 0) {
      $('tblPositions').innerHTML = `<tr class="empty-row"><td colspan="8">Chưa có vị thế mở — Click trực tiếp trên biểu đồ nến hoặc bật Bot để giao dịch.</td></tr>`;
    } else {
      $('tblPositions').innerHTML = trading.positions
        .map((p) => {
          const pnlCls = p.unrealizedPnl >= 0 ? 'pos' : 'neg';
          const sign = p.unrealizedPnl >= 0 ? '+' : '';
          const shieldBadge = p.trailingActive
            ? `<span class="be-tag">TRAIL 🔒</span>`
            : (p.beLocked ? `<span class="be-tag">SL=BE 🔒</span>` : (p.hedgeGroupId ? `<span class="arb-badge">HEDGE</span>` : ''));
          const slTpCell = p.hedgeGroupId
            ? `<span class="cyan">Delta-Neutral</span> <span class="muted">(F: ${(p.accruedFundingUsd || 0) >= 0 ? '+' : ''}$${(p.accruedFundingUsd || 0).toFixed(2)})</span>`
            : `<span class="neg">${market.formatPrice(p.slPrice, p.symbol)}</span> / <span class="pos">${market.formatPrice(p.tpPrice, p.symbol)}</span>`;
          return `
            <tr>
              <td><strong>${p.symbol}</strong> <span class="muted">${p.exchange.slice(0, 4)}</span>${shieldBadge}</td>
              <td class="${p.side === 'LONG' ? 'pos' : 'neg'}"><strong>${p.side} ${p.leverage}x</strong></td>
              <td>$${p.sizeUsd.toLocaleString()}</td>
              <td>${market.formatPrice(p.entryPrice, p.symbol)}</td>
              <td class="gold">${market.formatPrice(p.markPrice, p.symbol)}</td>
              <td>${slTpCell}</td>
              <td class="${pnlCls}"><strong>${sign}$${p.unrealizedPnl.toFixed(2)}</strong> (${sign}${p.roePct.toFixed(1)}%)</td>
              <td><button class="btn btn-xs btn-danger-outline" data-close-pos="${p.id}">Đóng</button></td>
            </tr>`;
        })
        .join('');
    }

    // Delta-Neutral Funding Arbitrage Scanner Table
    const arbEl = $('tblArb');
    if (arbEl) {
      const opps = market.getArbitrageOpportunities();
      arbEl.innerHTML = opps
        .map((o) => {
          const hasPair = trading.positions.some((p) => p.hedgeGroupId && p.symbol === o.symbol);
          const aprCls = o.netAprPct >= 10 ? 'pos' : (o.netAprPct > 0 ? 'gold' : 'neg');
          const statusTxt = hasPair
            ? `<span class="cyan">ĐANG HEDGE</span>`
            : (o.actionable ? `<span class="pos">KHẢ DỤNG (+EV)</span>` : `<span class="muted">CHỜ SPREAD</span>`);
          return `
            <tr>
              <td><strong>${o.symbol}</strong></td>
              <td class="pos">${o.longVenue.slice(0, 5)} <span class="muted">${market.formatPrice(o.longPrice, o.symbol)}</span></td>
              <td class="neg">${o.shortVenue.slice(0, 5)} <span class="muted">${market.formatPrice(o.shortPrice, o.symbol)}</span></td>
              <td class="${o.basisBps >= 0 ? 'pos' : 'neg'}">${o.basisBps >= 0 ? '+' : ''}${o.basisBps.toFixed(2)} bps</td>
              <td class="${aprCls}"><strong>${o.netAprPct >= 0 ? '+' : ''}${o.netAprPct.toFixed(1)}%</strong></td>
              <td>${statusTxt}</td>
              <td><button class="btn btn-xs ${hasPair ? 'btn-ghost' : 'btn-cyan-outline'}" data-exec-arb="${o.symbol}" ${hasPair ? 'disabled' : ''}>${hasPair ? 'Đang chạy' : 'Hedge 2x'}</button></td>
            </tr>`;
        })
        .join('');
    }

    // Limit Orders Table
    if (trading.limitOrders.length === 0) {
      $('tblOrders').innerHTML = `<tr class="empty-row"><td colspan="7">Không có lệnh Limit đang chờ khớp.</td></tr>`;
    } else {
      $('tblOrders').innerHTML = trading.limitOrders
        .map(
          (o) => `
          <tr>
            <td><strong>${o.symbol}</strong> <span class="muted">${o.exchange.slice(0, 4)}</span></td>
            <td class="${o.side === 'LONG' ? 'pos' : 'neg'}"><strong>${o.side} ${o.leverage}x</strong></td>
            <td>$${o.sizeUsd.toLocaleString()}</td>
            <td class="gold">${market.formatPrice(o.entryPrice, o.symbol)}</td>
            <td><span class="neg">${market.formatPrice(o.slPrice, o.symbol)}</span> / <span class="pos">${market.formatPrice(o.tpPrice, o.symbol)}</span></td>
            <td class="cyan">${o.source}</td>
            <td><button class="btn btn-xs btn-ghost" data-cancel-ord="${o.id}">Hủy</button></td>
          </tr>`
        )
        .join('');
    }

    // History Table
    if (trading.history.length === 0) {
      $('tblHistory').innerHTML = `<tr class="empty-row"><td colspan="5">Chưa có lệnh đã chốt.</td></tr>`;
    } else {
      $('tblHistory').innerHTML = trading.history
        .slice(0, 25)
        .map((h) => {
          const cls = h.pnl >= 0 ? 'pos' : 'neg';
          const sign = h.pnl >= 0 ? '+' : '';
          return `
            <tr>
              <td class="muted">${h.time}</td>
              <td><strong>${h.symbol}</strong> <span class="${h.side === 'LONG' ? 'pos' : 'neg'}">${h.side}</span></td>
              <td>${market.formatPrice(h.entryPrice, h.symbol)} → ${market.formatPrice(h.exitPrice, h.symbol)}</td>
              <td class="gold">${h.reason}</td>
              <td class="${cls}"><strong>${sign}$${h.pnl.toFixed(2)}</strong></td>
            </tr>`;
        })
        .join('');
    }

    // System Logs
    $('systemLogFeed').innerHTML = trading.logs
      .slice(0, 35)
      .map(
        (l) => `
        <div class="log-line">
          <span class="log-time">[${l.time}]</span>
          <span class="log-tag ${l.tag}">${l.tag}</span>
          <span>${l.msg}</span>
        </div>`
      )
      .join('');
  }

  /* ==================== HEADER & TELEMETRY REFRESH ==================== */
  function updateMarketHUD(st) {
    // Top instrument bar
    Object.keys(market.instruments).forEach((sym) => {
      const s = market.getSymbolState(sym);
      const shortKey = sym.split('-')[0];
      const pxEl = $(`hdrPx${shortKey}`);
      const chgEl = $(`hdrChg${shortKey}`);
      const chgPct = ((s.price - s.open24h) / s.open24h) * 100;
      if (pxEl) pxEl.textContent = market.formatPrice(s.price, sym);
      if (chgEl) {
        chgEl.textContent = `${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(2)}%`;
        chgEl.className = `inst-chg ${chgPct >= 0 ? 'pos' : 'neg'}`;
      }
    });

    // Exchange strip
    const activePx = market.getPrice(st.symbol, market.activeExchange);
    $('stripMark').textContent = `$${market.formatPrice(activePx, st.symbol)}`;
    $('stripFunding').textContent = `${st.funding8h >= 0 ? '+' : ''}${st.funding8h.toFixed(4)}%`;
    $('stripFunding').className = `sm-val ${st.funding8h >= 0 ? 'pos' : 'neg'}`;
    $('stripOI').textContent = `$${st.oiBillions.toFixed(2)}B`;
    $('stripSpread').textContent = `${st.orderbook.spreadBps.toFixed(1)} bps`;

    // Chart header OHLC
    const c = st.currentCandle;
    $('chartTitle').textContent = `${st.symbol} // ${market.activeExchange === 'ALL' ? 'MULTI-EXCHANGE' : market.activeExchange} ORDERFLOW CHART`;
    $('chartOhlc').textContent = `O:${market.formatPrice(c.o, st.symbol)} H:${market.formatPrice(c.h, st.symbol)} L:${market.formatPrice(c.l, st.symbol)} C:${market.formatPrice(c.c, st.symbol)}`;

    // KPI Orderflow Index & Sphere HUD
    $('kpiFlowIdx').textContent = st.orderflowIndex.toLocaleString('en-US');
    const nf = st.netFlowPerSec;
    const nfEl = $('sphereNetFlow');
    nfEl.textContent = `${nf >= 0 ? '+' : ''}$${nf.toFixed(2)}M`;
    nfEl.className = `sh-val ${nf >= 0 ? 'pos' : 'neg'}`;

    // CVD readout
    $('cvdReadout').textContent = `CVD: ${st.cvd >= 0 ? '+' : ''}$${st.cvd.toFixed(2)}M`;

    // Radar Regime metrics
    $('radVol').textContent = `${st.realizedVol.toFixed(1)}%`;
    $('radShock').textContent = `${st.shockSigma.toFixed(2)}σ`;
    const regBadge = $('regimeBadge');
    const liqRisk = $('radLiqRisk');
    if (st.shockSigma >= 1.8 || market.shockIntensity > 0.3) {
      regBadge.textContent = 'SHOCK / HIGH VOL';
      regBadge.className = 'regime-badge shock';
      liqRisk.textContent = 'CRITICAL';
      liqRisk.className = 'neg';
      $('feedDot').classList.add('shock');
    } else if (st.realizedVol > 52) {
      regBadge.textContent = 'ELEVATED';
      regBadge.className = 'regime-badge elevated';
      liqRisk.textContent = 'MEDIUM';
      liqRisk.className = 'gold';
      $('feedDot').classList.remove('shock');
    } else {
      regBadge.textContent = 'CALM';
      regBadge.className = 'regime-badge calm';
      liqRisk.textContent = 'LOW';
      liqRisk.className = 'pos';
      $('feedDot').classList.remove('shock');
    }

    updateVenueCards(st);
    renderOrderbook(st);
    renderTape(st);
    updateSLTPPreview();
  }

  /* ==================== SELECTORS & EVENT WIRING ==================== */
  function selectSymbol(sym) {
    market.setSymbol(sym);
    document.querySelectorAll('.inst-btn').forEach((b) => b.classList.toggle('active', b.dataset.symbol === sym));
    $('inpEntry').value = '';
    syncAutoSize();
    updateMarketHUD(market.getSymbolState());
    sphereRenderer.triggerPulse('#fbbf24');
  }

  function selectExchange(exId) {
    market.setExchange(exId);
    document.querySelectorAll('.ex-pill').forEach((p) => p.classList.toggle('active', p.dataset.exchange === exId));
    updateMarketHUD(market.getSymbolState());
    sphereRenderer.triggerPulse('#00f0ff');
  }

  function setSide(side) {
    selectedSide = side;
    $('btnSideLong').classList.toggle('active', side === 'LONG');
    $('btnSideShort').classList.toggle('active', side === 'SHORT');
    $('btnPlaceLimit').classList.toggle('short-mode', side === 'SHORT');
    $('chartClickBadge').textContent = `CLICK CHART: ${side}`;
    $('chartClickBadge').className = `panel-tag ${side === 'LONG' ? 'cyan' : 'neg'}`;
    updateSLTPPreview();
  }

  function bindAllEvents() {
    // Instrument switcher
    $('instrumentSelector').addEventListener('click', (e) => {
      const btn = e.target.closest('.inst-btn');
      if (btn) selectSymbol(btn.dataset.symbol);
    });

    // Exchange filter strip
    $('exchangePills').addEventListener('click', (e) => {
      const pill = e.target.closest('.ex-pill');
      if (pill) selectExchange(pill.dataset.exchange);
    });

    // Timeframe buttons
    $('tfGroup').addEventListener('click', (e) => {
      const btn = e.target.closest('.tf-btn');
      if (!btn) return;
      document.querySelectorAll('.tf-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      market.setTimeframe(btn.dataset.tf);
    });

    // Side & Ticket controls
    $('btnSideLong').addEventListener('click', () => setSide('LONG'));
    $('btnSideShort').addEventListener('click', () => setSide('SHORT'));
    $('chkChartClick').addEventListener('change', (e) => {
      candleRenderer.clickEnabled = e.target.checked;
    });
    $('chkAutoSize').addEventListener('change', (e) => {
      trading.riskShield.autoSizeEnabled = e.target.checked;
      if (e.target.checked) syncAutoSize();
      updateSLTPPreview();
    });
    $('chkPostOnly').addEventListener('change', (e) => {
      trading.riskShield.postOnlyMaker = e.target.checked;
      syncAutoSize();
      updateSLTPPreview();
    });
    $('chkAutoBE').addEventListener('change', (e) => {
      trading.riskShield.autoBreakeven = e.target.checked;
      trading.riskShield.autoTrailing = e.target.checked;
    });
    $('inpSlPct').addEventListener('input', () => {
      syncAutoSize();
      updateSLTPPreview();
    });
    ['inpEntry', 'inpTpPct', 'inpSize', 'selLeverage'].forEach((id) => {
      $(id).addEventListener('input', updateSLTPPreview);
      $(id).addEventListener('change', updateSLTPPreview);
    });

    // Place Limit Button
    $('btnPlaceLimit').addEventListener('click', () => {
      const sym = market.activeSymbol;
      const entry = parseFloat($('inpEntry').value) || market.getPrice(sym) * (selectedSide === 'LONG' ? 0.9985 : 1.0015);
      handleChartClickOrder(entry);
    });

    // Place Market Button
    $('btnPlaceMarket').addEventListener('click', () => {
      const placed = trading.placeMarketOrder({
        symbol: market.activeSymbol,
        exchange: market.activeExchange,
        side: selectedSide,
        sizeUsd: parseFloat($('inpSize').value) || 5000,
        leverage: parseInt($('selLeverage').value, 10) || 5,
        slPct: parseFloat($('inpSlPct').value) || 0.8,
        tpPct: parseFloat($('inpTpPct').value) || 1.8,
        source: 'MANUAL'
      });
      if (placed) sphereRenderer.triggerPulse(selectedSide === 'LONG' ? '#34d399' : '#ff3b6b');
    });

    // Click Orderbook price level to fill Entry input
    ['obAsks', 'obBids'].forEach((id) => {
      $(id).addEventListener('click', (e) => {
        const row = e.target.closest('.ob-row');
        if (row && row.dataset.price) {
          $('inpEntry').value = row.dataset.price;
          updateSLTPPreview();
        }
      });
    });

    // Bot strategies radio
    $('botStrategies').addEventListener('change', (e) => {
      if (e.target.name === 'botStrategy') {
        document.querySelectorAll('.strat-item').forEach((el) => el.classList.remove('active'));
        e.target.closest('.strat-item').classList.add('active');
        trading.setBotStrategy(e.target.value);
      }
    });

    $('chkAutoFlatten').addEventListener('change', (e) => {
      trading.autoFlattenOnBreak = e.target.checked;
    });

    $('btnToggleBot').addEventListener('click', () => trading.toggleBot());
    $('btnResetDemo').addEventListener('click', () => trading.resetDemo());

    // Volatility Shock Test Button!
    $('btnTriggerShock').addEventListener('click', () => {
      market.triggerShock(-1);
      $('shockVignette').classList.add('active');
      sphereRenderer.triggerPulse('#ff3b6b');
      showToast({
        type: 'neg',
        title: '⚡ KÍCH HOẠT SỐC BIẾN ĐỘNG (FLASH CRASH)',
        msg: market.shockHeadline
      });
    });

    // Reset Circuit Breaker
    $('btnResetBreaker').addEventListener('click', () => trading.resetCircuitBreaker());

    // Blotter tabs
    $('blotterTabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.btab');
      if (!btn) return;
      activeBlotterTab = btn.dataset.tab;
      document.querySelectorAll('.btab').forEach((b) => b.classList.toggle('active', b === btn));
      const map = { positions: 'panePositions', orders: 'paneOrders', arb: 'paneArb', history: 'paneHistory', logs: 'paneLogs' };
      Object.entries(map).forEach(([k, paneId]) => {
        const pane = $(paneId);
        if (pane) pane.classList.toggle('active', k === activeBlotterTab);
      });
    });

    // Delegated table close/cancel/arb actions
    $('tblPositions').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-close-pos]');
      if (btn) trading.closePosition(parseInt(btn.dataset.closePos, 10), 'MANUAL CLOSE');
    });
    $('tblOrders').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cancel-ord]');
      if (btn) trading.cancelLimitOrder(parseInt(btn.dataset.cancelOrd, 10));
    });
    const tblArb = $('tblArb');
    if (tblArb) {
      tblArb.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-exec-arb]');
        if (!btn) return;
        const sym = btn.dataset.execArb;
        const opp = market.getArbitrageOpportunities().find((o) => o.symbol === sym);
        if (opp) {
          const ok = trading.executeDeltaNeutralArb(opp, 10000, 'ARB');
          if (ok) sphereRenderer.triggerPulse('#34d399');
        }
      });
    }
    $('btnCloseAll').addEventListener('click', () => {
      trading.closeAll('CLOSE ALL');
      showToast({ type: 'gold', title: 'ĐÃ ĐÓNG TOÀN BỘ', msg: 'Đã đóng hết vị thế mở và hủy lệnh chờ.' });
    });

    // Live Public WebSocket Toggle
    $('btnToggleWs').addEventListener('click', () => {
      market.toggleLiveWebSocket(!market.wsEnabled);
    });

    // Mode switch & API Modal
    $('btnModeDemo').addEventListener('click', () => {
      trading.setMode('DEMO');
      $('btnModeDemo').classList.add('active');
      $('btnModeLive').classList.remove('active');
      $('walletModeTag').textContent = 'DEMO USDC';
      showToast({ type: 'cyan', title: 'CHẾ ĐỘ DEMO $100K', msg: 'Đang sử dụng ví mô phỏng khớp lệnh theo giá thực.' });
    });
    $('btnModeLive').addEventListener('click', () => openApiModal());
    $('btnOpenApiModal').addEventListener('click', () => openApiModal());
    $('btnCloseApiModal').addEventListener('click', () => $('apiModal').classList.add('hidden'));
    $('btnSwitchBackDemo').addEventListener('click', () => {
      $('apiModal').classList.add('hidden');
      $('btnModeDemo').click();
    });

    // Modal Tabs
    $('apiModalTabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.mtab');
      if (!btn) return;
      document.querySelectorAll('.mtab').forEach((b) => b.classList.toggle('active', b === btn));
      $('mtabHyperliquid').classList.toggle('active', btn.dataset.mtab === 'hyperliquid');
      $('mtabCex').classList.toggle('active', btn.dataset.mtab === 'cex');
    });

    // Test Connection
    $('btnTestConn').addEventListener('click', () => {
      const isHL = $('mtabHyperliquid').classList.contains('active');
      if (isHL) {
        const addr = $('hlAddress').value.trim();
        if (!addr || !addr.startsWith('0x') || addr.length < 12) {
          $('hlConnStatus').innerHTML = `Trạng thái: <span class="neg">Địa chỉ ví Hyperliquid chưa hợp lệ (phải bắt đầu bằng 0x...).</span>`;
          return;
        }
        $('hlConnStatus').innerHTML = `Trạng thái: <span class="pos">Định dạng ví hợp lệ (${addr.slice(0, 8)}...${addr.slice(-4)}) • Mạng ${$('hlNetwork').value} sẵn sàng.</span>`;
      } else {
        const key = $('cexApiKey').value.trim();
        const sec = $('cexApiSecret').value.trim();
        if (key.length < 8 || sec.length < 8) {
          $('cexConnStatus').innerHTML = `Trạng thái: <span class="neg">Vui lòng nhập đầy đủ API Key &amp; Secret (tối thiểu 8 ký tự).</span>`;
          return;
        }
        $('cexConnStatus').innerHTML = `Trạng thái: <span class="pos">API ${$('cexExchange').value} đã xác thực cấu trúc (${$('cexPerm').value}) — Lưu RAM phiên.</span>`;
      }
    });

    // Save Live Connection
    $('btnSaveLiveConn').addEventListener('click', () => {
      if (!$('chkSecurityAck').checked) {
        showToast({ type: 'neg', title: 'CHƯA XÁC NHẬN BẢO MẬT', msg: 'Vui lòng tick xác nhận không cấp quyền rút tiền trước khi kích hoạt.' });
        return;
      }
      const isHL = $('mtabHyperliquid').classList.contains('active');
      if (isHL) {
        const addr = $('hlAddress').value.trim() || '0x71C9...Agent';
        trading.configureLiveBridge({ venue: 'HYPERLIQUID DEX', network: $('hlNetwork').value, walletAddress: addr });
      } else {
        const ex = $('cexExchange').value;
        trading.configureLiveBridge({ venue: ex, network: $('cexPerm').value, apiKeyMasked: $('cexApiKey').value.slice(0, 6) + '***' });
      }
      $('btnModeLive').classList.add('active');
      $('btnModeDemo').classList.remove('active');
      $('walletModeTag').textContent = `LIVE: ${trading.liveConfig.venue}`;
      $('apiModal').classList.add('hidden');
      showToast({
        type: 'gold',
        title: `ĐÃ KẾT NỐI ${trading.liveConfig.venue}`,
        msg: 'Khóa chỉ lưu tạm trong RAM phiên hiện tại. Khuyến nghị test lệnh nhỏ trước.'
      });
    });

    // Engine callbacks
    market.on((type, payload) => {
      if (type === 'wsStatus') {
        const btn = $('btnToggleWs');
        btn.innerHTML = `<span class="ws-indicator ${payload.connected ? 'on' : ''}" id="wsIndicator"></span> ${payload.text}`;
        $('feedStatusText').textContent = payload.connected
          ? 'FEED: BINANCE LIVE WS + MULTI-EXCHANGE BRIDGE'
          : 'FEED: MULTI-VENUE SYNTH + WS READY';
      } else if (type === 'tradePrint' && payload.print.whale) {
        sphereRenderer.triggerPulse('#fbbf24');
      }
    });

    trading.on((type, payload) => {
      if (type === 'toast') showToast(payload);
      else if (type === 'updated' || type === 'breakerTripped' || type === 'breakerReset') {
        renderTradingPanels();
      }
    });
  }

  function openApiModal() {
    $('apiModal').classList.remove('hidden');
  }

  /* ==================== CLOCK & MAIN LOOPS ==================== */
  function updateClock() {
    const now = new Date();
    $('utcClock').textContent = now.toISOString().substr(11, 8);
    const shockBoost = Math.round(market.shockIntensity * 45);
    const lats = [
      ['latHL', 10 + Math.floor(Math.random() * 5) + shockBoost],
      ['latBN', 13 + Math.floor(Math.random() * 5) + shockBoost],
      ['latBB', 17 + Math.floor(Math.random() * 6) + shockBoost],
      ['latOKX', 19 + Math.floor(Math.random() * 7) + shockBoost],
      ['latDB', 22 + Math.floor(Math.random() * 7) + shockBoost]
    ];
    lats.forEach(([id, ms]) => {
      const el = $(id);
      if (el) el.textContent = `${ms}ms`;
    });
    const rateEl = $('tapeRate');
    if (rateEl) {
      const tps = 14 + Math.floor(Math.random() * 12) + Math.round(market.shockIntensity * 68);
      rateEl.textContent = `${tps} tx/s`;
    }
  }

  function animate(timeMs) {
    candleRenderer.render();
    sphereRenderer.render(timeMs);
    radarRenderer.render(timeMs);
    cvdRenderer.render();
    requestAnimationFrame(animate);
  }

  // Bootstrap
  buildVenueCards();
  bindAllEvents();
  syncAutoSize();
  updateClock();
  updateMarketHUD(market.getSymbolState());
  renderTradingPanels();

  setInterval(updateClock, 1000);
  setInterval(() => {
    market.tick();
    trading.onMarketTick();
    updateMarketHUD(market.getSymbolState());
    renderTradingPanels();
  }, 240);

  requestAnimationFrame(animate);
})();
