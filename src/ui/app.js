/* ==========================================================================
   QUANTUM CORE // Standardized Application Controller
   - Uses UUID v4 string IDs (no sequential IDs or parseInt)
   - Integrates Zero-Trust 2FA HMAC OTP Gate (HTTP /api/v1/auth/* + file:// fallback)
   - Integrates GSAP MotionController & WAI-ARIA Ctrl+K Command Palette
   ========================================================================== */

(function () {
  'use strict';

  const market = new window.QuantumMarketEngine();
  const trading = new window.QuantumTradingEngine(market);
  const motion = new window.QuantumMotionController();
  const {
    CandlestickChartRenderer,
    RadialSphereAndConduitsRenderer,
    VolatilityRadarRenderer,
    CvdAndSparkRenderer
  } = window.QuantumVisualizers;

  let selectedSide = 'LONG';
  let activeBlotterTab = 'positions';
  let activeOtpChallengeId = null;
  let verified2faSession = null;
  let liveSyncTimer = null;
  let coinPickerVenue = 'ALL';
  let coinPickerSort = 'volume';
  let coinPickerQuery = '';
  let liveSessionCredentials = null; // Strict RAM-only; cleared on revoke or switch to DEMO

  const $ = (id) => document.getElementById(id);
  const isHttpOrigin = typeof window !== 'undefined' && window.location.protocol.startsWith('http');
  const isLocalSignerOrigin = isHttpOrigin && (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost');

  const candleRenderer = new CandlestickChartRenderer(
    $('candleChartCanvas'),
    market,
    trading,
    (clickedPrice) => handleChartClickOrder(clickedPrice)
  );
  const sphereRenderer = new RadialSphereAndConduitsRenderer($('sphereCanvas'), market, trading);
  const radarRenderer = new VolatilityRadarRenderer($('radarCanvas'), market);
  const cvdRenderer = new CvdAndSparkRenderer($('cvdCanvas'), $('kpiSparkCanvas'), market, trading);

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

  function submitManualLimitOrder(entryPrice, source = 'MANUAL') {
    const dec = market.getDecimals();
    const roundedPx = Number(Number(entryPrice).toFixed(dec));
    if (!Number.isFinite(roundedPx) || roundedPx <= 0) {
      motion.wiggleReject($('ticketPanel'));
      return null;
    }

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
      source
    });

    if (placed) {
      sphereRenderer.triggerPulse(selectedSide === 'LONG' ? '#34d399' : '#ff3b6b');
    } else {
      motion.wiggleReject($('ticketPanel'));
    }
    return placed;
  }

  function refreshChartConfirmModal() {
    const sym = market.activeSymbol;
    const dec = market.getDecimals(sym);
    const entryVal = parseFloat($('cfmInpEntry').value) || parseFloat($('inpEntry').value) || market.getPrice(sym);
    const roundedPx = Number(entryVal.toFixed(dec));
    const slPct = parseFloat($('inpSlPct').value) || 0.8;
    const tpPct = parseFloat($('inpTpPct').value) || 1.8;
    const sizeUsd = parseFloat($('inpSize').value) || 5000;
    const leverage = parseInt($('selLeverage').value, 10) || 5;
    const dir = selectedSide === 'LONG' ? 1 : -1;

    const slPrice = roundedPx * (1 - dir * (slPct / 100));
    const tpPrice = roundedPx * (1 + dir * (tpPct / 100));
    const ex = market.activeExchange === 'ALL' ? 'HYPERLIQUID' : market.activeExchange;
    const makerNote = trading.riskShield.postOnlyMaker ? 'Post-Only Maker' : 'Limit';
    const entryFeeBps = market.getVenueFeeBps(ex, trading.riskShield.postOnlyMaker);
    const exitFeeBps = market.getVenueFeeBps(ex, false);
    const feePct = (entryFeeBps + exitFeeBps + 0.35) / 100;
    const netRR = (tpPct - feePct) / Math.max(0.05, slPct + feePct);
    const maxLossUsd = sizeUsd * ((slPct + feePct) / 100);

    $('cfmSideLong').classList.toggle('active', selectedSide === 'LONG');
    $('cfmSideShort').classList.toggle('active', selectedSide === 'SHORT');
    $('cfmSymVenue').textContent = `${sym} • ${ex} (${makerNote})`;
    $('cfmSizeLev').textContent = `$${Math.round(sizeUsd).toLocaleString('en-US')} USDC • ${leverage}x`;
    $('cfmSlVal').textContent = `${market.formatPrice(slPrice, sym)} (-${slPct.toFixed(2)}%)`;
    $('cfmTpVal').textContent = `${market.formatPrice(tpPrice, sym)} (+${tpPct.toFixed(2)}%)`;
    $('cfmRiskRR').textContent = `Risk tối đa: -$${maxLossUsd.toFixed(0)} • Net R:R 1 : ${Math.max(0, netRR).toFixed(2)}`;

    const confirmBtn = $('btnConfirmChartOrder');
    confirmBtn.textContent = `CÓ — ĐẶT ${selectedSide} LIMIT (ENTER)`;
    confirmBtn.classList.toggle('short-mode', selectedSide === 'SHORT');

    candleRenderer.pendingDraftOrder = {
      symbol: sym,
      side: selectedSide,
      entryPrice: roundedPx,
      slPrice,
      tpPrice,
      sizeUsd
    };
  }

  function openChartConfirmModal(entryPrice) {
    const dec = market.getDecimals();
    const roundedPx = Number(Number(entryPrice).toFixed(dec));
    $('cfmInpEntry').step = String(market.instruments[market.activeSymbol]?.tick || 0.01);
    $('cfmInpEntry').value = roundedPx;
    $('chkModalSkipConfirm').checked = !$('chkConfirmChartClick').checked;
    refreshChartConfirmModal();
    $('chartOrderConfirmModal').classList.remove('hidden');
    motion.animateModalOpen($('chartOrderConfirmModal').querySelector('.modal-card'));
  }

  function closeChartConfirmModal() {
    $('chartOrderConfirmModal').classList.add('hidden');
    candleRenderer.pendingDraftOrder = null;
  }

  function confirmChartOrderNow() {
    const dec = market.getDecimals();
    const entryPrice = Number((parseFloat($('cfmInpEntry').value) || parseFloat($('inpEntry').value) || 0).toFixed(dec));
    const skipConfirm = $('chkModalSkipConfirm').checked;
    $('chkConfirmChartClick').checked = !skipConfirm;
    closeChartConfirmModal();
    if (entryPrice > 0) {
      $('inpEntry').value = entryPrice;
      updateSLTPPreview();
      submitManualLimitOrder(entryPrice, 'CHART CLICK');
    }
  }

  function handleChartClickOrder(price) {
    const dec = market.getDecimals();
    const roundedPx = Number(price.toFixed(dec));
    $('inpEntry').value = roundedPx;
    updateSLTPPreview();

    if ($('chkConfirmChartClick').checked) {
      openChartConfirmModal(roundedPx);
      return;
    }
    submitManualLimitOrder(roundedPx, 'CHART CLICK');
  }

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

    if (trading.riskShield.enabled && leverage > trading.riskShield.maxSafeLeverage) {
      $('selLeverage').title = `Risk Shield giới hạn đòn bẩy an toàn tối đa ${trading.riskShield.maxSafeLeverage}x`;
    }

    candleRenderer.selectedSide = selectedSide;
    candleRenderer.slPct = slPct;
    candleRenderer.tpPct = tpPct;
  }

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
        .map((r) => {
          const totalLabel = r.totalUsd >= 1e6
            ? `$${(r.totalUsd / 1e6).toFixed(2)}M`
            : `$${(r.totalUsd / 1000).toFixed(0)}K`;
          return `
          <div class="ob-row ${type}" data-price="${r.price.toFixed(market.getDecimals(sym))}">
            <div class="ob-depth-bg" style="width:${r.pct.toFixed(1)}%"></div>
            <span class="${type === 'ask' ? 'neg' : 'pos'}">${market.formatPrice(r.price, sym)}</span>
            <span>${r.qty.toFixed(sym === 'BTC-PERP' ? 2 : 1)}</span>
            <span class="muted">${totalLabel}</span>
          </div>`;
        })
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
          <span class="${tr.whale ? 'gold' : ''}">$${tr.usdSize >= 100000 ? (tr.usdSize / 1000).toFixed(0) + 'K ★' : (tr.usdSize / 1000).toFixed(1) + 'K'}</span>
          <span class="muted">${tr.time}</span>
        </div>`
      )
      .join('');
    $('tapeList').innerHTML = html;
  }

  function renderTradingPanels() {
    const m = trading.getMetrics();
    const positions = trading.getPublicPositions();
    const orders = trading.getPublicOrders();
    const history = trading.getPublicHistory();

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

    if (typeof trading.computeCapitalPlan === 'function') {
      const capProf = trading.computeCapitalPlan(m.equity);
      const badgeEl = $('capitalTierBadge');
      const guideEl = $('capitalTierGuide');
      if (badgeEl) {
        badgeEl.textContent = capProf.label;
        const badgeCls = (capProf.tier === 'MICRO' || capProf.tier === 'INSUFFICIENT')
          ? 'micro'
          : ((capProf.tier === 'SMALL' || capProf.tier === 'GROWTH') ? 'small' : '');
        badgeEl.className = `cap-tier-badge ${badgeCls}`;
      }
      if (guideEl) guideEl.textContent = capProf.guide;
      const brkLbl = $('breakerThresholdLabel');
      if (brkLbl) brkLbl.textContent = `${trading.maxDrawdownPct.toFixed(1)}% Daily DD / ${trading.maxShockSigma}σ`;
      const capTag = trading.initialCapital >= 1000
        ? `$${Math.round(trading.initialCapital / 1000)}K`
        : `$${trading.initialCapital}`;
      const rstBtn = $('btnResetDemo');
      if (rstBtn) rstBtn.textContent = `Reset ${capTag}`;
      const modeDemoBtn = $('btnModeDemo');
      if (modeDemoBtn && trading.mode === 'DEMO') {
        modeDemoBtn.innerHTML = `<span class="mode-dot demo"></span> DEMO ${capTag}`;
      }
      const isLive = trading.mode === 'LIVE';
      const demoRow = $('capDemoRow');
      const liveRow = $('capLiveRow');
      const liveLbl = $('capLiveVenueLbl');
      if (demoRow) demoRow.classList.toggle('hidden', isLive);
      if (liveRow) liveRow.classList.toggle('hidden', !isLive);
      if (liveLbl && isLive) {
        const venueLabel = trading.liveConfig.venueId || 'LIVE';
        liveLbl.textContent = `🟢 VÍ THỰC ${venueLabel}: $${m.equity.toFixed(2)} USDC`;
      }

      // Adaptive Capital Plan Telemetry & Risk Mode Selector
      const dayBaseEq = (Number.isFinite(trading.dailyStartEquity) && trading.dailyStartEquity > 0)
        ? trading.dailyStartEquity
        : m.equity;
      const dayPlan = trading.computeCapitalPlan(dayBaseEq);
      const riskValEl = $('planRiskVal');
      const sizeValEl = $('planSizeVal');
      const targetValEl = $('planTargetVal');
      const stopValEl = $('planStopVal');
      const progEl = $('dailyPnlProgressBadge');
      const autoSizeLbl = $('autoSizeRiskLabel');
      const unlockBtn = $('btnUnlockProfitLock');
      const lockChk = $('chkDailyProfitLock');

      if (riskValEl) riskValEl.textContent = `$${capProf.riskPerTradeUsd.toFixed(2)} (${capProf.riskPerTradePct}%)`;
      if (sizeValEl) sizeValEl.textContent = `$${capProf.optimalSizeUsd} • ${capProf.maxSafeLeverage}x`;
      if (targetValEl) targetValEl.textContent = `+$${dayPlan.dailyProfitLockUsd.toFixed(2)}`;
      if (stopValEl) stopValEl.textContent = `-$${dayPlan.dailyStopLossUsd.toFixed(2)}`;
      if (autoSizeLbl) autoSizeLbl.textContent = `Auto Size (Rủi ro tối đa ${capProf.riskPerTradePct}% vốn/lệnh • ${capProf.riskModeLabel})`;
      if (unlockBtn) unlockBtn.classList.toggle('hidden', !trading.dailyProfitLocked);
      if (lockChk) lockChk.checked = Boolean(trading.dailyProfitLockEnabled);

      if (progEl) {
        const dp = Number.isFinite(m.dailyPnlUsd) ? m.dailyPnlUsd : 0;
        const dpSign = dp >= 0 ? '+' : '';
        progEl.textContent = trading.dailyProfitLocked
          ? `🔒 ${dpSign}$${dp.toFixed(2)} / +$${dayPlan.dailyProfitLockUsd.toFixed(2)}`
          : `${dpSign}$${dp.toFixed(2)} / +$${dayPlan.dailyProfitLockUsd.toFixed(2)}`;
        progEl.className = `plan-prog-badge ${trading.dailyProfitLocked ? 'locked' : (dp >= 0 ? 'pos' : 'neg')}`;
      }

      document.querySelectorAll('#riskModeGroup .rmode-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.rmode === trading.riskMode);
      });
    }

    $('cntPos').textContent = positions.length;
    $('cntOrd').textContent = orders.length;
    $('cntHist').textContent = history.length;

    const botPill = $('botStatePill');
    const botBtn = $('btnToggleBot');
    const topBotBtn = $('btnTopbarBot');
    if (trading.breakerTripped) {
      botPill.textContent = 'TRIPPED';
      botPill.className = 'bot-state-pill tripped';
      botBtn.textContent = '⛔ ĐÃ NGẮT BẢO VỆ';
      botBtn.classList.remove('running');
      if (topBotBtn) {
        topBotBtn.textContent = '⛔ BOT KHÓA';
        topBotBtn.classList.remove('running');
      }
    } else if (trading.dailyProfitLocked) {
      botPill.textContent = 'PROFIT LOCKED 🎯';
      botPill.className = 'bot-state-pill locked';
      botBtn.textContent = '🎯 ĐÃ KHÓA LÃI NGÀY';
      botBtn.classList.remove('running');
      if (topBotBtn) {
        topBotBtn.textContent = '🎯 LOCKED';
        topBotBtn.classList.remove('running');
      }
    } else if (trading.botRunning) {
      botPill.textContent = `ACTIVE: ${trading.botStrategy}`;
      botPill.className = 'bot-state-pill running';
      botBtn.textContent = `⏸ TẠM DỪNG BOT (${trading.botDirectionMode})`;
      botBtn.classList.add('running');
      if (topBotBtn) {
        topBotBtn.textContent = `⏸ BOT: ON (${trading.botDirectionMode})`;
        topBotBtn.classList.add('running');
      }
    } else {
      botPill.textContent = 'IDLE';
      botPill.className = 'bot-state-pill idle';
      botBtn.textContent = '▶ BẬT BOT TỰ CHẠY (AUTO)';
      botBtn.classList.remove('running');
      if (topBotBtn) {
        topBotBtn.textContent = '▶ BOT AUTO';
        topBotBtn.classList.remove('running');
      }
    }

    const mobEq = $('mobMiniEq');
    if (mobEq) mobEq.textContent = `$${m.equity.toFixed(2)}`;
    const mobPnl = $('mobMiniPnl');
    if (mobPnl) {
      const dp = Number.isFinite(m.dailyPnlUsd) ? m.dailyPnlUsd : 0;
      mobPnl.textContent = dp > 0.005
        ? `LỜI +$${dp.toFixed(2)}`
        : (dp < -0.005 ? `LỖ -$${Math.abs(dp).toFixed(2)}` : '$0.00');
      mobPnl.className = `mmk-val ${dp > 0.005 ? 'pos' : (dp < -0.005 ? 'neg' : 'gold')}`;
    }
    const mobBot = $('mobMiniBot');
    if (mobBot) {
      mobBot.textContent = botPill.textContent;
      mobBot.className = botPill.className;
    }
    const mobBadge = $('mobNavPosBadge');
    if (mobBadge) {
      mobBadge.textContent = String(positions.length);
      mobBadge.classList.toggle('hidden', positions.length === 0);
    }

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

    if (positions.length === 0) {
      $('tblPositions').innerHTML = '<tr class="empty-row"><td colspan="8">Chưa có vị thế mở — Click trực tiếp trên biểu đồ nến hoặc bật Bot để giao dịch.</td></tr>';
    } else {
      $('tblPositions').innerHTML = positions
        .map((p) => {
          const pnlCls = p.unrealizedPnl >= 0 ? 'pos' : 'neg';
          const sign = p.unrealizedPnl >= 0 ? '+' : '';
          const shieldBadge = p.trailingActive
            ? '<span class="be-tag">TRAIL 🔒</span>'
            : (p.beLocked ? '<span class="be-tag">SL=BE 🔒</span>' : (p.hedgeGroupId ? '<span class="arb-badge">HEDGE</span>' : ''));
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

    if (orders.length === 0) {
      $('tblOrders').innerHTML = '<tr class="empty-row"><td colspan="7">Không có lệnh Limit đang chờ khớp.</td></tr>';
    } else {
      $('tblOrders').innerHTML = orders
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

    const arbEl = $('tblArb');
    if (arbEl) {
      const opps = market.getArbitrageOpportunities();
      arbEl.innerHTML = opps
        .map((o) => {
          const hasPair = positions.some((p) => p.hedgeGroupId && p.symbol === o.symbol);
          const aprCls = o.netAprPct >= 10 ? 'pos' : (o.netAprPct > 0 ? 'gold' : 'neg');
          const statusTxt = hasPair
            ? '<span class="cyan">ĐANG HEDGE</span>'
            : (o.actionable ? '<span class="pos">KHẢ DỤNG (+EV)</span>' : '<span class="muted">CHỜ SPREAD</span>');
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

    if (history.length === 0) {
      $('tblHistory').innerHTML = '<tr class="empty-row"><td colspan="6">Chưa có lệnh đã chốt.</td></tr>';
    } else {
      $('tblHistory').innerHTML = history
        .slice(0, 25)
        .map((h) => {
          const cls = h.pnl >= 0 ? 'pos' : 'neg';
          const sign = h.pnl >= 0 ? '+' : '';
          const fee = Number(h.feeUsd) || 0;
          const gross = Number.isFinite(Number(h.grossPnl)) ? Number(h.grossPnl) : (h.pnl + fee);
          const grossSign = gross >= 0 ? '+' : '';
          return `
            <tr>
              <td class="muted">${h.time}</td>
              <td><strong>${h.symbol}</strong> <span class="${h.side === 'LONG' ? 'pos' : 'neg'}">${h.side}</span></td>
              <td>${market.formatPrice(h.entryPrice, h.symbol)} → ${market.formatPrice(h.exitPrice, h.symbol)}</td>
              <td class="gold">${h.reason}</td>
              <td class="muted" title="Lãi gộp (Gross): ${grossSign}$${gross.toFixed(2)} | Phí 2 chiều + trượt giá: -$${fee.toFixed(2)}">-$${fee.toFixed(2)}</td>
              <td class="${cls}"><strong>${sign}$${h.pnl.toFixed(2)}</strong></td>
            </tr>`;
        })
        .join('');
    }

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

  function formatCompactUsd(val) {
    const n = Number(val) || 0;
    if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
    return `$${n.toFixed(0)}`;
  }

  function formatCatalogPrice(px) {
    const dec = typeof market._inferPrecision === 'function' ? market._inferPrecision(px).decimals : 2;
    return `$${Number(px).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;
  }

  function updateCoinCatalogBadge() {
    const cntEl = $('coinCatalogCount');
    if (cntEl && typeof market.getVenueCatalog === 'function') {
      const cat = market.getVenueCatalog(market.activeExchange);
      cntEl.textContent = cat.length > 0 ? cat.length : Object.keys(market.instruments).length;
    }
  }

  function renderCoinPickerModal() {
    const listEl = $('coinPickerList');
    if (!listEl || typeof market.getVenueCatalog !== 'function') return;

    const fullCatalog = market.getVenueCatalog(coinPickerVenue);
    const titleEl = $('coinPickerTitle');
    const subEl = $('coinPickerSub');
    if (titleEl) {
      titleEl.textContent = `DANH SÁCH COIN TRỰC TIẾP — ${coinPickerVenue} (${fullCatalog.length} mã)`;
    }
    if (subEl) {
      subEl.textContent = coinPickerVenue === 'ALL'
        ? `Tổng hợp ${fullCatalog.length} hợp đồng Perp realtime từ 5 sàn — Click mã bất kỳ để mở biểu đồ & đặt lệnh`
        : `${fullCatalog.length} hợp đồng Perp trực tiếp trên ${coinPickerVenue} — Click mã bất kỳ để giao dịch`;
    }

    document.querySelectorAll('#coinPickerVenueTabs .cp-vtab').forEach((btn) => {
      const vId = btn.dataset.cvenue;
      btn.classList.toggle('active', vId === coinPickerVenue);
      const vLen = market.getVenueCatalog(vId).length;
      btn.textContent = vLen > 0 ? `${vId} (${vLen})` : vId;
    });

    const q = coinPickerQuery.trim().toUpperCase();
    let rows = fullCatalog;
    if (q) {
      rows = rows.filter((item) =>
        item.symbol.includes(q) ||
        item.baseCoin.includes(q) ||
        String(item.venueSymbol || '').toUpperCase().includes(q)
      );
    }

    const sorted = rows.slice();
    if (coinPickerSort === 'gainers') {
      sorted.sort((a, b) => (Number(b.change24hPct) || -999) - (Number(a.change24hPct) || -999));
    } else if (coinPickerSort === 'losers') {
      sorted.sort((a, b) => (Number(a.change24hPct) || 999) - (Number(b.change24hPct) || 999));
    } else if (coinPickerSort === 'name') {
      sorted.sort((a, b) => a.symbol.localeCompare(b.symbol));
    } else {
      sorted.sort((a, b) => (b.volume24hUsd || 0) - (a.volume24hUsd || 0));
    }

    const visible = sorted.slice(0, 200);
    if (visible.length === 0) {
      listEl.innerHTML = '<tr class="empty-row"><td colspan="6">Không tìm thấy coin khớp từ khóa hoặc đang tải từ sàn...</td></tr>';
      return;
    }

    listEl.innerHTML = visible
      .map((item) => {
        const isActive = item.symbol === market.activeSymbol;
        const chg = Number(item.change24hPct);
        const chgTxt = Number.isFinite(chg) ? `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%` : '--';
        const chgCls = Number.isFinite(chg) ? (chg >= 0 ? 'pos' : 'neg') : 'muted';
        const fund = Number(item.funding8h);
        const fundTxt = Number.isFinite(fund) ? `${fund >= 0 ? '+' : ''}${fund.toFixed(4)}%` : '--';
        const fundCls = Number.isFinite(fund) ? (fund >= 0 ? 'pos' : 'neg') : 'muted';
        const tag = item.venueSymbol || item.venue;
        return `
          <tr class="cp-row${isActive ? ' selected' : ''}" data-cpsym="${item.symbol}">
            <td><strong>${item.baseCoin}</strong><span class="cp-venue-tag">${tag}</span></td>
            <td class="gold"><strong>${formatCatalogPrice(item.price)}</strong></td>
            <td class="${chgCls}">${chgTxt}</td>
            <td class="${fundCls}">${fundTxt}</td>
            <td class="muted">${formatCompactUsd(item.volume24hUsd)}</td>
            <td><button type="button" class="btn btn-xs ${isActive ? 'btn-cyan' : 'btn-cyan-outline'}">${isActive ? 'Đang xem' : 'Chọn'}</button></td>
          </tr>`;
      })
      .join('');
  }

  function openCoinPickerModal() {
    coinPickerVenue = market.activeExchange || 'ALL';
    renderCoinPickerModal();
    $('coinPickerModal').classList.remove('hidden');
    motion.animateModalOpen($('coinPickerModal').querySelector('.modal-card'));
    setTimeout(() => $('inpCoinSearch')?.focus(), 40);
  }

  function closeCoinPickerModal() {
    $('coinPickerModal').classList.add('hidden');
  }

  function selectDynamicCoin(sym, targetVenue = coinPickerVenue) {
    const st = typeof market.ensureInstrument === 'function' ? market.ensureInstrument(sym) : market.getSymbolState(sym);
    if (!st) return;
    if (targetVenue && targetVenue !== market.activeExchange && market.venueCatalog?.[targetVenue]) {
      market.setExchange(targetVenue);
      document.querySelectorAll('.ex-pill').forEach((p) => p.classList.toggle('active', p.dataset.exchange === targetVenue));
    }
    selectSymbol(st.symbol);
    renderInstrumentButtons();
    closeCoinPickerModal();
    showToast({
      type: 'cyan',
      title: `ĐÃ MỞ ${st.symbol}`,
      msg: `Đang tải biểu đồ & sổ lệnh theo giá thực trên ${market.activeExchange === 'ALL' ? '5 SÀN' : market.activeExchange}.`
    });
  }

  function renderInstrumentButtons() {
    const container = $('instrumentSelector');
    if (!container) return;
    const syms = typeof market.getVenueSymbols === 'function'
      ? market.getVenueSymbols(market.activeExchange)
      : Object.keys(market.instruments);

    container.innerHTML = syms
      .map((sym) => {
        const shortKey = sym.split('-')[0];
        const px = market.getPrice(sym, market.activeExchange);
        const chgPct = typeof market.getChange24hPct === 'function'
          ? market.getChange24hPct(sym, market.activeExchange)
          : 0;
        const activeCls = sym === market.activeSymbol ? ' active' : '';
        const chgCls = chgPct >= 0 ? 'pos' : 'neg';
        const sign = chgPct >= 0 ? '+' : '';
        return `
          <button class="inst-btn${activeCls}" data-symbol="${sym}">
            <span class="inst-sym">${shortKey}</span>
            <span class="inst-px" id="hdrPx${shortKey}">${market.formatPrice(px, sym)}</span>
            <span class="inst-chg ${chgCls}" id="hdrChg${shortKey}">${sign}${chgPct.toFixed(2)}%</span>
          </button>`;
      })
      .join('');
    updateCoinCatalogBadge();
  }

  function updateMarketHUD(st) {
    const syms = typeof market.getVenueSymbols === 'function'
      ? market.getVenueSymbols(market.activeExchange)
      : Object.keys(market.instruments);

    syms.forEach((sym) => {
      const vPx = market.getPrice(sym, market.activeExchange);
      const shortKey = sym.split('-')[0];
      const pxEl = $(`hdrPx${shortKey}`);
      const chgEl = $(`hdrChg${shortKey}`);
      const chgPct = typeof market.getChange24hPct === 'function'
        ? market.getChange24hPct(sym, market.activeExchange)
        : 0;
      if (pxEl) pxEl.textContent = market.formatPrice(vPx, sym);
      if (chgEl) {
        chgEl.textContent = `${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(2)}%`;
        chgEl.className = `inst-chg ${chgPct >= 0 ? 'pos' : 'neg'}`;
      }
    });

    const activePx = market.getPrice(st.symbol, market.activeExchange);
    const activeFund = typeof market.getFunding8h === 'function'
      ? market.getFunding8h(st.symbol, market.activeExchange)
      : st.funding8h;
    $('stripMark').textContent = `$${market.formatPrice(activePx, st.symbol)}`;
    $('stripFunding').textContent = `${activeFund >= 0 ? '+' : ''}${activeFund.toFixed(4)}%`;
    $('stripFunding').className = `sm-val ${activeFund >= 0 ? 'pos' : 'neg'}`;
    $('stripOI').textContent = `$${st.oiBillions.toFixed(2)}B`;
    $('stripSpread').textContent = `${st.orderbook.spreadBps.toFixed(1)} bps`;

    const venueCandles = typeof market.getVenueCandles === 'function'
      ? market.getVenueCandles(st.symbol, market.activeExchange)
      : st.candles;
    const c = venueCandles[venueCandles.length - 1] || st.currentCandle;
    $('chartTitle').textContent = `${st.symbol} // ${market.activeExchange === 'ALL' ? 'MULTI-EXCHANGE' : market.activeExchange} ORDERFLOW CHART`;
    $('chartOhlc').textContent = `O:${market.formatPrice(c.o, st.symbol)} H:${market.formatPrice(c.h, st.symbol)} L:${market.formatPrice(c.l, st.symbol)} C:${market.formatPrice(c.c, st.symbol)}`;

    $('kpiFlowIdx').textContent = st.orderflowIndex.toLocaleString('en-US');
    const nf = st.netFlowPerSec;
    const nfEl = $('sphereNetFlow');
    nfEl.textContent = `${nf >= 0 ? '+' : ''}$${nf.toFixed(2)}M`;
    nfEl.className = `sh-val ${nf >= 0 ? 'pos' : 'neg'}`;

    $('cvdReadout').textContent = `CVD: ${st.cvd >= 0 ? '+' : ''}$${st.cvd.toFixed(2)}M`;

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

    // Live AI Signal Meter
    const sigEl = $('botSignalText');
    if (sigEl && typeof market.getDirectionalSignal === 'function') {
      const sig = market.getDirectionalSignal(st.symbol);
      if (sig.spikeBlocked) {
        sigEl.innerHTML = `<span class="neg">⚡ LỌC TIN MẠNH — ĐỨNG NGOÀI</span> <span class="muted">(${sig.spikeReason})</span>`;
      } else if (sig.side === 'LONG') {
        sigEl.innerHTML = `<span class="pos">🟢 AI: LONG ${sig.confidence}%</span> <span class="muted">(${sig.reasons})</span>`;
      } else if (sig.side === 'SHORT') {
        sigEl.innerHTML = `<span class="neg">🔴 AI: SHORT ${sig.confidence}%</span> <span class="muted">(${sig.reasons})</span>`;
      } else {
        sigEl.innerHTML = `<span class="gold">⚪ AI: LỌC NHIỄU (${sig.confidence}%)</span> <span class="muted">(${sig.reasons})</span>`;
      }
    }

    updateVenueCards(st);
    renderOrderbook(st);
    renderTape(st);
    updateSLTPPreview();
  }

  function selectSymbol(sym) {
    market.setSymbol(sym);
    document.querySelectorAll('.inst-btn').forEach((b) => b.classList.toggle('active', b.dataset.symbol === sym));
    $('inpEntry').value = '';
    $('inpEntry').step = String(market.instruments[sym]?.tick || 0.01);
    syncAutoSize();
    updateMarketHUD(market.getSymbolState());
    sphereRenderer.triggerPulse('#fbbf24');
  }

  function selectExchange(exId) {
    market.setExchange(exId);
    document.querySelectorAll('.ex-pill').forEach((p) => p.classList.toggle('active', p.dataset.exchange === exId));
    renderInstrumentButtons();
    syncAutoSize();
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

  function switchBlotterTab(tabKey) {
    activeBlotterTab = tabKey;
    document.querySelectorAll('.btab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabKey));
    const map = { positions: 'panePositions', orders: 'paneOrders', arb: 'paneArb', history: 'paneHistory', logs: 'paneLogs' };
    Object.entries(map).forEach(([k, paneId]) => {
      const pane = $(paneId);
      if (pane) pane.classList.toggle('active', k === tabKey);
    });
  }

  /* ==================== ZERO-TRUST 2FA HMAC OTP & LIVE ORDER ADAPTER ==================== */
  function getSignerBaseUrl() {
    if (isLocalSignerOrigin) return '';
    return ($('cexProxy')?.value?.trim() || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  }

  function resolveVenueSymbolForOrder(sym, venue) {
    const cfg = market.instruments[sym];
    if (!cfg) return undefined;
    if (venue === 'BINANCE') return cfg.wsBinance ? cfg.wsBinance.toUpperCase() : undefined;
    if (venue === 'BYBIT') return cfg.bybitSym || undefined;
    if (venue === 'OKX') return cfg.okxInst || undefined;
    if (venue === 'DERIBIT') return cfg.deribitInst || undefined;
    if (venue === 'HYPERLIQUID') return cfg.hlCoin || undefined;
    return undefined;
  }

  function buildServerOrderAdapter() {
    const postOrderApi = async (routePath, payload) => {
      if (!liveSessionCredentials || !verified2faSession?.sessionId) {
        return { ok: false, error: 'Phiên xác thực Live chưa sẵn sàng trong RAM.' };
      }
      const base = getSignerBaseUrl();
      const bodyPayload = {
        ...liveSessionCredentials,
        ...payload,
        sessionId: verified2faSession.sessionId,
        venueSymbol: payload.venueSymbol || resolveVenueSymbolForOrder(payload.symbol, payload.venue)
      };
      const res = await fetch(`${base}${routePath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload)
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) {
        return { ok: false, error: json?.error || `Local Signer HTTP ${res.status}` };
      }
      return json;
    };

    return {
      placeOrder: (p) => postOrderApi('/api/v1/exchange/order/place', p),
      modifyStopLoss: (p) => postOrderApi('/api/v1/exchange/order/modify-sl', p),
      cancelOrder: (p) => postOrderApi('/api/v1/exchange/order/cancel', p),
      closePosition: (p) => postOrderApi('/api/v1/exchange/order/close', p),
      fetchPositions: (p) => postOrderApi('/api/v1/exchange/positions', p)
    };
  }

  function updateLiveExecWarningUI() {
    const box = $('liveExecConfigBox');
    const warnEl = $('liveExecWarnText');
    const modeSel = $('selLiveExecMode');
    if (!box || !warnEl || !modeSel) return;
    const isLiveExec = modeSel.value === 'LIVE_EXEC';
    const isHL = $('mtabHyperliquid')?.classList.contains('active');
    const net = (isHL ? $('hlNetwork')?.value : $('cexNetwork')?.value) || 'TESTNET';

    box.classList.remove('armed-live', 'armed-mainnet');
    if (!isLiveExec) {
      warnEl.className = 'live-exec-warn';
      warnEl.textContent = `🛡 Chế độ Chạy Bóng (${net}): Đọc số dư & giá thật, thuật toán chạy đúng Demo nhưng CHƯA đẩy lệnh thật lên sàn.`;
    } else if (net === 'MAINNET') {
      box.classList.add('armed-mainnet');
      warnEl.className = 'live-exec-warn neg';
      warnEl.textContent = '🚨 CẢNH BÁO MAINNET (TIỀN THẬT): Mọi lệnh tay & Auto-Bot sẽ ký và ĐẨY THẬT qua Local Signer (127.0.0.1:8787)!';
    } else {
      box.classList.add('armed-live');
      warnEl.className = 'live-exec-warn gold';
      warnEl.textContent = '⚡ LIVE TESTNET: Mọi lệnh tay & Auto-Bot sẽ được đẩy lên sàn Testnet (tiền giả lập của sàn) qua Local Signer.';
    }
  }

  async function requestOtpFlow() {
    const email = $('otpEmail').value.trim();
    const base = getSignerBaseUrl();
    let res;
    try {
      const r = await fetch(`${base}/api/v1/auth/otp/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      res = await r.json();
    } catch (_) {
      res = await trading.securityGate.requestOtp({ email, ip: '127.0.0.1' });
    }

    if (!res.ok) {
      $('otpStatusText').innerHTML = `<span class="neg">${res.error}</span>`;
      motion.wiggleReject($('otpGateBox'));
      return;
    }

    activeOtpChallengeId = res.challengeId;
    $('otpStatusText').innerHTML = `<span class="gold">Đã tạo Challenge #${window.QuantumUUID.shortId(res.challengeId)} (Sandbox OTP: <strong>${res.devPreviewOtp}</strong> — Hết hạn 10 phút)</span>`;
    showToast({ type: 'cyan', title: 'ĐÃ GỬI MÃ OTP 2FA', msg: `Sandbox Preview OTP: ${res.devPreviewOtp}` });
  }

  async function verifyOtpFlow() {
    const otp = $('inpOtpCode').value.trim();
    if (!activeOtpChallengeId) {
      $('otpStatusText').innerHTML = '<span class="neg">Hãy bấm "Gửi OTP" trước.</span>';
      motion.wiggleReject($('otpGateBox'));
      return;
    }

    const base = getSignerBaseUrl();
    let res;
    try {
      const r = await fetch(`${base}/api/v1/auth/otp/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeId: activeOtpChallengeId, otp })
      });
      res = await r.json();
    } catch (_) {
      res = await trading.securityGate.verifyOtp({ challengeId: activeOtpChallengeId, otp, ip: '127.0.0.1' });
    }

    if (!res.ok) {
      $('otpStatusText').innerHTML = `<span class="neg">${res.error}</span>`;
      motion.wiggleReject($('otpGateBox'));
      return;
    }

    verified2faSession = res.session;
    $('btnSaveLiveConn').disabled = false;
    $('otpStatusText').innerHTML = `<span class="pos">✓ Đã xác thực 2FA (${res.session.role} • Session #${window.QuantumUUID.shortId(res.session.sessionId)})</span>`;
    showToast({ type: 'pos', title: '2FA XÁC THỰC THÀNH CÔNG', msg: 'Bạn đã có quyền kích hoạt Live Bridge.' });
  }

  async function revokeAllSessionsFlow() {
    if (liveSyncTimer) {
      clearInterval(liveSyncTimer);
      liveSyncTimer = null;
    }
    const base = getSignerBaseUrl();
    try {
      await fetch(`${base}/api/v1/auth/sessions/revoke`, { method: 'POST' });
    } catch (_) {}
    liveSessionCredentials = null;
    trading.setLiveExecutionAdapter(null);
    trading.revokeLiveSessions();
    verified2faSession = null;
    activeOtpChallengeId = null;
    $('btnSaveLiveConn').disabled = true;
    $('btnModeDemo').classList.add('active');
    $('btnModeLive').classList.remove('active');
    $('walletModeTag').textContent = 'DEMO USDC';
    $('otpStatusText').innerHTML = '<span class="gold">Đã thu hồi toàn bộ phiên & xóa API Key khỏi RAM.</span>';
  }

  async function fetchRealBalanceFromVenue({ silent = false, forceTab = null } = {}) {
    const isHL = forceTab === 'HYPERLIQUID'
      ? true
      : (forceTab === 'CEX' ? false : $('mtabHyperliquid').classList.contains('active'));
    const balEl = $('liveFetchedBalanceVal');
    if (!silent && balEl) {
      balEl.className = 'gold';
      balEl.textContent = 'Đang truy vấn số dư trực tiếp từ sàn...';
    }

    if (isHL) {
      const walletAddress = $('hlAddress').value.trim();
      const vaultAddress = $('hlVault').value.trim();
      const targetAddr = (vaultAddress || walletAddress).trim();
      const network = $('hlNetwork').value || 'TESTNET';
      if (!/^0x[a-fA-F0-9]{40}$/.test(targetAddr)) {
        const err = 'Địa chỉ ví Hyperliquid chưa hợp lệ (phải là 0x + 40 ký tự hex).';
        $('hlConnStatus').innerHTML = `Trạng thái: <span class="neg">${err}</span>`;
        if (balEl) {
          balEl.className = 'neg';
          balEl.textContent = err;
        }
        return { ok: false, error: err };
      }

      const apiUrl = network === 'MAINNET'
        ? 'https://api.hyperliquid.xyz/info'
        : 'https://api.hyperliquid-testnet.xyz/info';

      try {
        const headers = { 'Content-Type': 'application/json' };
        const [chRes, spotRes] = await Promise.all([
          fetch(apiUrl, { method: 'POST', headers, body: JSON.stringify({ type: 'clearinghouseState', user: targetAddr }) }),
          fetch(apiUrl, { method: 'POST', headers, body: JSON.stringify({ type: 'spotClearinghouseState', user: targetAddr }) })
        ]);
        if (!chRes.ok) {
          const err = `Hyperliquid API trả lỗi HTTP ${chRes.status}`;
          $('hlConnStatus').innerHTML = `Trạng thái: <span class="neg">${err}</span>`;
          if (balEl) { balEl.className = 'neg'; balEl.textContent = err; }
          return { ok: false, error: err };
        }
        const ch = await chRes.json();
        const spot = spotRes.ok ? await spotRes.json() : {};
        const perpEq = parseFloat(ch?.marginSummary?.accountValue ?? ch?.crossMarginSummary?.accountValue) || 0;
        const marginUsed = parseFloat(ch?.marginSummary?.totalMarginUsed ?? ch?.crossMarginSummary?.totalMarginUsed) || 0;
        const withdrawable = ch?.withdrawable !== undefined ? (parseFloat(ch.withdrawable) || 0) : Math.max(0, perpEq - marginUsed);

        let spotUsdc = 0;
        let spotHold = 0;
        for (const b of (Array.isArray(spot?.balances) ? spot.balances : [])) {
          if (String(b?.coin || '').toUpperCase().startsWith('USDC')) {
            spotUsdc += parseFloat(b.total) || 0;
            spotHold += parseFloat(b.hold) || 0;
          }
        }
        const equityUsd = perpEq > 0 ? perpEq : spotUsdc;
        const freeMarginUsd = perpEq > 0 ? Math.max(0, withdrawable) : Math.max(0, spotUsdc - spotHold);

        $('hlConnStatus').innerHTML = `Trạng thái: <span class="pos">Đã kết nối ví ${targetAddr.slice(0, 8)}...${targetAddr.slice(-4)} (${network}) • Số dư: $${equityUsd.toFixed(2)} USDC</span>`;
        if (balEl) {
          balEl.className = equityUsd > 0 ? 'pos' : 'gold';
          balEl.textContent = `$${equityUsd.toFixed(2)} USDC (Khả dụng: $${freeMarginUsd.toFixed(2)} USDC • Hyperliquid ${network})`;
        }
        return {
          ok: true,
          venue: 'HYPERLIQUID',
          network,
          equityUsd: Number(equityUsd.toFixed(4)),
          freeMarginUsd: Number(freeMarginUsd.toFixed(4)),
          perpEquityUsd: Number(perpEq.toFixed(4)),
          spotUsdc: Number(spotUsdc.toFixed(4))
        };
      } catch (e) {
        const err = `Không thể kết nối Hyperliquid API (${e?.message || 'Network error'}).`;
        $('hlConnStatus').innerHTML = `Trạng thái: <span class="neg">${err}</span>`;
        if (balEl) { balEl.className = 'neg'; balEl.textContent = err; }
        return { ok: false, error: err };
      }
    }

    const venue = $('cexExchange').value;
    const network = $('cexNetwork')?.value || 'TESTNET';
    const apiKey = $('cexApiKey').value.trim();
    const apiSecret = $('cexApiSecret').value.trim();
    const passphrase = $('cexPassphrase').value.trim();
    const proxyBase = ($('cexProxy').value.trim() || 'http://127.0.0.1:8787').replace(/\/+$/, '');

    if (apiKey.length < 8 || apiSecret.length < 8) {
      const err = 'Vui lòng nhập đầy đủ API Key & Secret (tối thiểu 8 ký tự).';
      $('cexConnStatus').innerHTML = `Trạng thái: <span class="neg">${err}</span>`;
      if (balEl) { balEl.className = 'neg'; balEl.textContent = err; }
      return { ok: false, error: err };
    }
    if (venue === 'OKX' && !passphrase) {
      const err = 'Sàn OKX bắt buộc nhập Passphrase API.';
      $('cexConnStatus').innerHTML = `Trạng thái: <span class="neg">${err}</span>`;
      if (balEl) { balEl.className = 'neg'; balEl.textContent = err; }
      return { ok: false, error: err };
    }

    const endpoint = isHttpOrigin ? '/api/v1/exchange/balance' : `${proxyBase}/api/v1/exchange/balance`;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ venue, network, apiKey, apiSecret, passphrase })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        const err = data?.error || `Lỗi sàn ${venue} (HTTP ${res.status})`;
        $('cexConnStatus').innerHTML = `Trạng thái: <span class="neg">${err}</span>`;
        if (balEl) { balEl.className = 'neg'; balEl.textContent = err; }
        return { ok: false, error: err };
      }

      const eq = Number(data.equityUsd) || 0;
      const free = Number(data.freeMarginUsd) || 0;
      $('cexConnStatus').innerHTML = `Trạng thái: <span class="pos">Đã đọc số dư thật ${venue}: $${eq.toFixed(2)} USDC (Khả dụng: $${free.toFixed(2)})</span>`;
      if (balEl) {
        balEl.className = eq > 0 ? 'pos' : 'gold';
        balEl.textContent = `$${eq.toFixed(2)} USDC (Khả dụng: $${free.toFixed(2)} USDC • ${venue})`;
      }
      return { ok: true, ...data };
    } catch (_) {
      const err = 'Không kết nối được Local Signer (127.0.0.1:8787). Hãy chạy start-terminal.bat để đọc số dư CEX thật.';
      $('cexConnStatus').innerHTML = `Trạng thái: <span class="neg">${err}</span>`;
      if (balEl) { balEl.className = 'neg'; balEl.textContent = err; }
      return { ok: false, error: err };
    }
  }

  async function syncConnectedLiveBalance({ silent = false } = {}) {
    if (trading.mode !== 'LIVE' || !trading.liveConfig.connected) return null;
    const forceTab = trading.liveConfig.venueId === 'HYPERLIQUID' ? 'HYPERLIQUID' : 'CEX';
    const res = await fetchRealBalanceFromVenue({ silent, forceTab });
    if (res.ok) {
      trading.syncLiveAccountBalance(res);
      syncAutoSize();
      updateSLTPPreview();
      if (!silent) {
        showToast({
          type: 'pos',
          title: `ĐÃ ĐỒNG BỘ SỐ DƯ ${res.venue}`,
          msg: `Equity: $${res.equityUsd.toFixed(2)} USDC | Khả dụng: $${res.freeMarginUsd.toFixed(2)} USDC`
        });
      }
    } else if (!silent) {
      showToast({ type: 'neg', title: 'ĐỒNG BỘ SỐ DƯ THẤT BẠI', msg: res.error });
    }
    return res;
  }

  function openApiModal() {
    $('apiModal').classList.remove('hidden');
    $('btnSaveLiveConn').disabled = !verified2faSession;
    motion.animateModalOpen($('apiModal').querySelector('.modal-card'));
  }

  function bindAllEvents() {
    $('instrumentSelector').addEventListener('click', (e) => {
      const btn = e.target.closest('.inst-btn');
      if (btn) selectSymbol(btn.dataset.symbol);
    });

    $('exchangePills').addEventListener('click', (e) => {
      const pill = e.target.closest('.ex-pill');
      if (pill) selectExchange(pill.dataset.exchange);
    });

    $('tfGroup').addEventListener('click', (e) => {
      const btn = e.target.closest('.tf-btn');
      if (!btn) return;
      document.querySelectorAll('.tf-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      market.setTimeframe(btn.dataset.tf);
    });

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

    $('btnPlaceLimit').addEventListener('click', () => {
      const sym = market.activeSymbol;
      const entry = parseFloat($('inpEntry').value) || market.getPrice(sym) * (selectedSide === 'LONG' ? 0.9985 : 1.0015);
      submitManualLimitOrder(entry, 'MANUAL');
    });

    $('chkConfirmChartClick').addEventListener('change', (e) => {
      $('chkModalSkipConfirm').checked = !e.target.checked;
    });
    $('btnCancelChartOrder').addEventListener('click', closeChartConfirmModal);
    $('btnCloseConfirmModal').addEventListener('click', closeChartConfirmModal);
    $('btnConfirmChartOrder').addEventListener('click', confirmChartOrderNow);
    $('chartOrderConfirmModal').addEventListener('click', (e) => {
      if (e.target === $('chartOrderConfirmModal')) closeChartConfirmModal();
    });
    $('cfmSideLong').addEventListener('click', () => {
      setSide('LONG');
      refreshChartConfirmModal();
    });
    $('cfmSideShort').addEventListener('click', () => {
      setSide('SHORT');
      refreshChartConfirmModal();
    });
    $('cfmInpEntry').addEventListener('input', () => {
      $('inpEntry').value = $('cfmInpEntry').value;
      updateSLTPPreview();
      refreshChartConfirmModal();
    });
    document.addEventListener('keydown', (e) => {
      const cmdOpen = !$('cmdPaletteBackdrop').classList.contains('hidden');
      if (cmdOpen) return;
      const modal = $('chartOrderConfirmModal');
      if (modal && !modal.classList.contains('hidden')) {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeChartConfirmModal();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          confirmChartOrderNow();
        }
        return;
      }
      const apiMod = $('apiModal');
      if (apiMod && !apiMod.classList.contains('hidden') && e.key === 'Escape') {
        e.preventDefault();
        apiMod.classList.add('hidden');
        return;
      }
      const coinMod = $('coinPickerModal');
      if (coinMod && !coinMod.classList.contains('hidden') && e.key === 'Escape') {
        e.preventDefault();
        closeCoinPickerModal();
      }
    });

    $('btnOpenCoinPicker').addEventListener('click', openCoinPickerModal);
    $('btnCloseCoinPicker').addEventListener('click', closeCoinPickerModal);
    $('coinPickerModal').addEventListener('click', (e) => {
      if (e.target === $('coinPickerModal')) closeCoinPickerModal();
    });
    $('btnRefreshCatalog').addEventListener('click', () => {
      if (!market.wsEnabled) market.toggleLiveWebSocket(true);
      else market.refreshVenueNow(coinPickerVenue);
      showToast({ type: 'cyan', title: 'ĐANG LÀM MỚI DANH SÁCH COIN', msg: `Đang tải danh sách mã mới nhất từ ${coinPickerVenue}...` });
    });
    $('coinPickerVenueTabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.cp-vtab');
      if (!btn) return;
      coinPickerVenue = btn.dataset.cvenue;
      if (market.wsEnabled) market._pollVenueLive(coinPickerVenue);
      renderCoinPickerModal();
    });
    $('coinPickerSortGroup').addEventListener('click', (e) => {
      const btn = e.target.closest('.cp-sort-btn');
      if (!btn) return;
      coinPickerSort = btn.dataset.sort;
      document.querySelectorAll('#coinPickerSortGroup .cp-sort-btn').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      renderCoinPickerModal();
    });
    $('inpCoinSearch').addEventListener('input', (e) => {
      coinPickerQuery = e.target.value;
      renderCoinPickerModal();
    });
    $('coinPickerList').addEventListener('click', (e) => {
      const row = e.target.closest('.cp-row');
      if (row && row.dataset.cpsym) {
        selectDynamicCoin(row.dataset.cpsym, coinPickerVenue);
      }
    });

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
      else motion.wiggleReject($('ticketPanel'));
    });

    ['obAsks', 'obBids'].forEach((id) => {
      $(id).addEventListener('click', (e) => {
        const row = e.target.closest('.ob-row');
        if (row && row.dataset.price) {
          $('inpEntry').value = row.dataset.price;
          updateSLTPPreview();
        }
      });
    });

    // Bot direction mode selector + 1-click AI entry + Reset Zoom
    const syncStrategyRadios = () => {
      document.querySelectorAll('#botStrategies input[name="botStrategy"]').forEach((inp) => {
        const match = inp.value === trading.botStrategy;
        inp.checked = match;
        inp.closest('.strat-item').classList.toggle('active', match);
      });
      document.querySelectorAll('#botDirGroup .bdir-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.dir === trading.botDirectionMode);
      });
    };

    const botDirGroup = $('botDirGroup');
    if (botDirGroup) {
      botDirGroup.addEventListener('click', (e) => {
        const btn = e.target.closest('.bdir-btn');
        if (!btn) return;
        trading.setBotDirectionMode(btn.dataset.dir);
        syncStrategyRadios();
      });
    }

    const applyRiskMode = (rmode) => {
      const plan = trading.setRiskMode(rmode);
      const levEl = $('selLeverage');
      if (levEl) {
        const optExists = Array.from(levEl.options).some((o) => Number(o.value) === plan.maxSafeLeverage);
        if (optExists) levEl.value = String(plan.maxSafeLeverage);
      }
      const tpEl = $('inpTpPct');
      if (tpEl && (parseFloat(tpEl.value) || 0) < plan.minTpPct) {
        tpEl.value = String(plan.minTpPct);
      }
      syncAutoSize();
      updateSLTPPreview();
      renderTradingPanels();
    };

    const riskModeGroup = $('riskModeGroup');
    if (riskModeGroup) {
      riskModeGroup.addEventListener('click', (e) => {
        const btn = e.target.closest('.rmode-btn');
        if (!btn) return;
        applyRiskMode(btn.dataset.rmode);
      });
    }

    const chkDailyProfitLock = $('chkDailyProfitLock');
    if (chkDailyProfitLock) {
      chkDailyProfitLock.addEventListener('change', (e) => {
        trading.setDailyProfitLockEnabled(e.target.checked);
      });
    }

    const chkMtfFilter = $('chkMtfFilter');
    if (chkMtfFilter) {
      chkMtfFilter.addEventListener('change', (e) => {
        market.mtfFilterEnabled = e.target.checked;
        showToast({
          type: e.target.checked ? 'cyan' : 'gold',
          title: e.target.checked ? 'BẬT LỌC KHUNG 5M' : 'TẮT LỌC KHUNG 5M',
          msg: e.target.checked ? 'AI chỉ vào lệnh thuận xu hướng 5m.' : 'AI chỉ lọc theo nến 1m + Orderflow.'
        });
      });
    }

    const chkNewsSpikeFilter = $('chkNewsSpikeFilter');
    if (chkNewsSpikeFilter) {
      chkNewsSpikeFilter.addEventListener('change', (e) => {
        market.newsSpikeFilterEnabled = e.target.checked;
        showToast({
          type: e.target.checked ? 'cyan' : 'gold',
          title: e.target.checked ? 'BẬT LỌC TIN / NẾN GIẬT' : 'TẮT LỌC TIN / NẾN GIẬT',
          msg: e.target.checked ? 'Tự đứng ngoài khi nến giật >= 2.8x ATR hoặc quét râu 2 đầu.' : 'Bot vẫn có thể vào lệnh khi nến biến động mạnh.'
        });
      });
    }

    const btnUnlockProfitLock = $('btnUnlockProfitLock');
    if (btnUnlockProfitLock) {
      btnUnlockProfitLock.addEventListener('click', () => {
        trading.unlockDailyProfitLock(true);
      });
    }

    const btnAiQuick = $('btnAiQuickTrade');
    if (btnAiQuick) {
      btnAiQuick.addEventListener('click', () => {
        const res = trading.executeAiSignalOrder({ symbol: market.activeSymbol, forceEntry: true, source: 'AI_1CLICK' });
        if (res) sphereRenderer.triggerPulse('#00f0ff');
      });
    }

    const btnResetZoom = $('btnResetZoom');
    if (btnResetZoom) {
      btnResetZoom.addEventListener('click', () => {
        candleRenderer.visibleCount = 48;
      });
    }

    $('botStrategies').addEventListener('change', (e) => {
      if (e.target.name === 'botStrategy') {
        trading.setBotStrategy(e.target.value);
        syncStrategyRadios();
      }
    });

    $('chkAutoFlatten').addEventListener('change', (e) => {
      trading.autoFlattenOnBreak = e.target.checked;
    });

    const leftDeckTabs = $('leftDeckTabs');
    if (leftDeckTabs) {
      leftDeckTabs.addEventListener('click', (e) => {
        const tab = e.target.closest('.deck-tab');
        if (!tab) return;
        const target = tab.dataset.dtab;
        leftDeckTabs.querySelectorAll('.deck-tab').forEach((b) => {
          const isMatch = b === tab;
          b.classList.toggle('active', isMatch);
          b.setAttribute('aria-selected', String(isMatch));
        });
        $('botPanel').classList.toggle('active', target === 'bot');
        $('ticketPanel').classList.toggle('active', target === 'manual');
      });
    }

    $('btnToggleBot').addEventListener('click', () => trading.toggleBot());
    const topBotBtn = $('btnTopbarBot');
    if (topBotBtn) topBotBtn.addEventListener('click', () => trading.toggleBot());
    $('btnResetDemo').addEventListener('click', () => trading.resetDemo());

    const applyCapitalPreset = (capVal) => {
      const cap = Math.max(10, Number(capVal) || 100);
      const prof = trading.setCapital(cap);
      document.querySelectorAll('#capPresets .cap-btn').forEach((b) => {
        b.classList.toggle('active', Number(b.dataset.cap) === cap);
      });
      $('inpCustomCapital').value = '';
      const levEl = $('selLeverage');
      if (levEl) {
        const optExists = Array.from(levEl.options).some((o) => Number(o.value) === prof.maxSafeLeverage);
        if (optExists) levEl.value = String(prof.maxSafeLeverage);
      }
      const tpEl = $('inpTpPct');
      if (tpEl && (parseFloat(tpEl.value) || 0) < prof.minTpPct) {
        tpEl.value = String(prof.minTpPct);
      }
      syncAutoSize();
      updateSLTPPreview();
      renderTradingPanels();
      showToast({
        type: 'cyan',
        title: `ĐÃ ĐẶT VỐN $${cap.toLocaleString('en-US')} [${prof.label}]`,
        msg: prof.guide
      });
    };

    $('capPresets').addEventListener('click', (e) => {
      const btn = e.target.closest('.cap-btn');
      if (!btn) return;
      applyCapitalPreset(parseFloat(btn.dataset.cap));
    });

    $('btnApplyCapital').addEventListener('click', () => {
      const val = parseFloat($('inpCustomCapital').value);
      if (!Number.isFinite(val) || val < 10) {
        showToast({ type: 'neg', title: 'VỐN TỐI THIỂU $10', msg: 'Vui lòng nhập số vốn từ $10 USDC trở lên.' });
        return;
      }
      applyCapitalPreset(val);
    });

    $('inpCustomCapital').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        $('btnApplyCapital').click();
      }
    });

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

    $('btnResetBreaker').addEventListener('click', () => trading.resetCircuitBreaker());

    $('blotterTabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.btab');
      if (btn) switchBlotterTab(btn.dataset.tab);
    });

    // UUID string IDs (no parseInt!)
    $('tblPositions').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-close-pos]');
      if (btn) trading.closePosition(btn.dataset.closePos, 'MANUAL CLOSE');
    });
    $('tblOrders').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cancel-ord]');
      if (btn) trading.cancelLimitOrder(btn.dataset.cancelOrd);
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

    $('btnToggleWs').addEventListener('click', () => {
      market.toggleLiveWebSocket(!market.wsEnabled);
    });

    const switchMobileTab = (tabKey) => {
      const validTabs = ['chart', 'sphere', 'bot', 'blotter', 'book'];
      const targetTab = validTabs.includes(tabKey) ? tabKey : 'chart';
      document.documentElement.dataset.mobileTab = targetTab;
      document.querySelectorAll('#mobileBottomNav .mnav-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.mtab === targetTab);
      });
      if (typeof window.scrollTo === 'function') window.scrollTo(0, 0);
      window.dispatchEvent(new Event('resize'));
    };

    const applyMobileViewMode = (mode, notify = false) => {
      const meta = $('viewportMeta');
      const btnView = $('btnToggleViewMode');
      const isDesktopMode = mode === 'DESKTOP';
      if (meta) {
        meta.setAttribute('content', isDesktopMode
          ? 'width=1366, user-scalable=yes'
          : 'width=device-width, initial-scale=1.0, maximum-scale=3.0, user-scalable=yes');
      }
      document.documentElement.classList.toggle('desktop-viewport-mode', isDesktopMode);
      document.documentElement.classList.toggle('mobile-viewport-mode', !isDesktopMode);
      if (!isDesktopMode && !document.documentElement.dataset.mobileTab) {
        switchMobileTab('chart');
      }
      try { localStorage.setItem('qc_view_mode_v2', isDesktopMode ? 'DESKTOP' : 'MOBILE'); } catch (_) {}
      if (btnView) {
        btnView.textContent = isDesktopMode ? '📱 ĐT' : '🖥 PC';
        btnView.title = isDesktopMode ? 'Chuyển sang giao diện App Điện thoại' : 'Chuyển sang giao diện Máy tính (PC 3 cột)';
      }
      window.dispatchEvent(new Event('resize'));
      if (notify) {
        showToast({
          type: 'cyan',
          title: isDesktopMode ? '🖥 GIAO DIỆN MÁY TÍNH (PC 3 CỘT)' : '📱 GIAO DIỆN APP ĐIỆN THOẠI',
          msg: isDesktopMode
            ? 'Đã bật bố cục đầy đủ 1366px giống PC (xoay ngang đt hoặc zoom 2 ngón).'
            : 'Đã bật giao diện App 5 tab gọn đẹp, chữ to rõ nét cho điện thoại.'
        });
      }
    };

    const viewBtn = $('btnToggleViewMode');
    if (viewBtn) {
      const initIsDesktop = document.documentElement.classList.contains('desktop-viewport-mode');
      viewBtn.textContent = initIsDesktop ? '📱 ĐT' : '🖥 PC';
      viewBtn.addEventListener('click', () => {
        const curDesktop = document.documentElement.classList.contains('desktop-viewport-mode');
        applyMobileViewMode(curDesktop ? 'MOBILE' : 'DESKTOP', true);
      });
    }

    const mobNav = $('mobileBottomNav');
    if (mobNav) {
      mobNav.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-mtab]');
        if (btn) switchMobileTab(btn.dataset.mtab);
      });
    }
    const mobMini = $('mobileMiniKpi');
    if (mobMini) {
      mobMini.addEventListener('click', () => switchMobileTab('bot'));
    }

    $('btnModeDemo').addEventListener('click', () => {
      if (liveSyncTimer) {
        clearInterval(liveSyncTimer);
        liveSyncTimer = null;
      }
      liveSessionCredentials = null;
      trading.setLiveExecutionAdapter(null);
      trading.setMode('DEMO');
      syncAutoSize();
      updateSLTPPreview();
      $('btnModeDemo').classList.add('active');
      $('btnModeLive').classList.remove('active');
      $('walletModeTag').textContent = 'DEMO USDC';
      showToast({ type: 'cyan', title: 'CHẾ ĐỘ DEMO', msg: 'Đã ngắt đẩy lệnh thật & quay về ví mô phỏng theo giá thực.' });
    });
    $('btnModeLive').addEventListener('click', openApiModal);
    $('btnOpenApiModal').addEventListener('click', openApiModal);
    $('btnCloseApiModal').addEventListener('click', () => $('apiModal').classList.add('hidden'));
    $('apiModal').addEventListener('click', (e) => {
      if (e.target === $('apiModal')) $('apiModal').classList.add('hidden');
    });
    $('btnSwitchBackDemo').addEventListener('click', () => {
      $('apiModal').classList.add('hidden');
      $('btnModeDemo').click();
    });

    $('btnSendOtp').addEventListener('click', requestOtpFlow);
    $('btnVerifyOtp').addEventListener('click', verifyOtpFlow);
    $('btnRevokeSessions').addEventListener('click', revokeAllSessionsFlow);

    $('apiModalTabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.mtab');
      if (!btn) return;
      document.querySelectorAll('.mtab').forEach((b) => b.classList.toggle('active', b === btn));
      $('mtabHyperliquid').classList.toggle('active', btn.dataset.mtab === 'hyperliquid');
      $('mtabCex').classList.toggle('active', btn.dataset.mtab === 'cex');
      updateLiveExecWarningUI();
    });
    ['selLiveExecMode', 'hlNetwork', 'cexNetwork'].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener('change', updateLiveExecWarningUI);
    });

    $('btnTestConn').addEventListener('click', () => fetchRealBalanceFromVenue({ silent: false }));
    $('btnFetchBalanceNow').addEventListener('click', () => fetchRealBalanceFromVenue({ silent: false }));
    $('btnSyncRealBalance').addEventListener('click', () => syncConnectedLiveBalance({ silent: false }));

    $('btnSaveLiveConn').addEventListener('click', async () => {
      if (!verified2faSession) {
        showToast({ type: 'neg', title: 'YÊU CẦU XÁC THỰC 2FA', msg: 'Vui lòng xác minh mã OTP HMAC trước khi mở Live Bridge.' });
        motion.wiggleReject($('otpGateBox'));
        return;
      }
      if (!$('chkSecurityAck').checked) {
        showToast({ type: 'neg', title: 'CHƯA XÁC NHẬN BẢO MẬT', msg: 'Vui lòng tick xác nhận không cấp quyền rút tiền.' });
        return;
      }

      const isHL = $('mtabHyperliquid').classList.contains('active');
      const execMode = $('selLiveExecMode')?.value === 'LIVE_EXEC' ? 'LIVE_EXEC' : 'SHADOW';
      const maxLiveNotionalUsd = Math.max(5, Math.min(500000, parseFloat($('inpMaxLiveNotional')?.value) || 500));
      const network = (isHL ? $('hlNetwork').value : ($('cexNetwork')?.value || 'TESTNET'));

      if (execMode === 'LIVE_EXEC') {
        if (isHL && !$('hlAgentKey').value.trim()) {
          showToast({ type: 'neg', title: 'THIẾU AGENT PRIVATE KEY', msg: 'Đẩy lệnh thật Hyperliquid cần Agent Private Key 0x... trong RAM.' });
          return;
        }
        if (!isHL && $('cexPerm').value === 'READ_ONLY') {
          showToast({ type: 'neg', title: 'KEY ĐANG Ở CHẾ ĐỘ READ-ONLY', msg: 'Hãy đổi quyền truy cập sang "Trade Only (Cấm rút tiền)" để đẩy lệnh thật.' });
          return;
        }
        try {
          const hRes = await fetch(`${getSignerBaseUrl()}/api/v1/health`);
          if (!hRes.ok) throw new Error('Signer offline');
        } catch (_) {
          showToast({
            type: 'neg',
            title: 'CẦN BẬT LOCAL SIGNER (127.0.0.1:8787)',
            msg: 'Hãy chạy start-terminal.bat để kích hoạt bộ ký lệnh Local Signer an toàn.'
          });
          return;
        }
      }

      const saveBtn = $('btnSaveLiveConn');
      const prevTxt = saveBtn.textContent;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Đang lấy số dư thực...';

      let balRes;
      try {
        balRes = await fetchRealBalanceFromVenue({ silent: false });
      } finally {
        saveBtn.disabled = !verified2faSession;
        saveBtn.textContent = prevTxt;
      }

      if (!balRes || !balRes.ok) {
        showToast({
          type: 'neg',
          title: 'KHÔNG LẤY ĐƯỢC SỐ DƯ SÀN',
          msg: balRes?.error || 'Kiểm tra lại địa chỉ ví / API Key trước khi kích hoạt Live.'
        });
        return;
      }

      const cfg = isHL
        ? {
            venue: 'HYPERLIQUID DEX',
            network,
            execMode,
            maxLiveNotionalUsd,
            walletAddress: $('hlAddress').value.trim() || '0x71C9...Agent'
          }
        : {
            venue: $('cexExchange').value,
            network,
            perm: $('cexPerm').value,
            execMode,
            maxLiveNotionalUsd,
            apiKeyMasked: $('cexApiKey').value.slice(0, 6) + '***'
          };

      if (execMode === 'LIVE_EXEC') {
        liveSessionCredentials = isHL
          ? {
              venue: 'HYPERLIQUID',
              network,
              walletAddress: $('hlAddress').value.trim(),
              vaultAddress: $('hlVault').value.trim(),
              agentKey: $('hlAgentKey').value.trim()
            }
          : {
              venue: $('cexExchange').value,
              network,
              apiKey: $('cexApiKey').value.trim(),
              apiSecret: $('cexApiSecret').value.trim(),
              passphrase: $('cexPassphrase').value.trim()
            };
        trading.setLiveExecutionAdapter(buildServerOrderAdapter());
      } else {
        liveSessionCredentials = null;
        trading.setLiveExecutionAdapter(null);
      }

      const res = trading.configureLiveBridge(cfg, verified2faSession.sessionId, '127.0.0.1', verified2faSession);
      if (!res.ok) return;

      const linkedVenueId = res.config?.venueId || (isHL ? 'HYPERLIQUID' : $('cexExchange').value);
      selectExchange(linkedVenueId);
      if (!market.wsEnabled) {
        market.toggleLiveWebSocket(true);
      }

      trading.syncLiveAccountBalance(balRes);
      syncAutoSize();
      updateSLTPPreview();

      if (liveSyncTimer) clearInterval(liveSyncTimer);
      liveSyncTimer = setInterval(() => {
        syncConnectedLiveBalance({ silent: true });
      }, 15000);

      $('btnModeLive').classList.add('active');
      $('btnModeDemo').classList.remove('active');
      $('walletModeTag').textContent = execMode === 'LIVE_EXEC'
        ? `⚡ LIVE EXEC (${linkedVenueId} ${network})`
        : `🛡 LIVE SHADOW: ${linkedVenueId}`;
      $('apiModal').classList.add('hidden');
      showToast({
        type: execMode === 'LIVE_EXEC' && network === 'MAINNET' ? 'neg' : 'gold',
        title: `ĐÃ LIÊN KẾT ${linkedVenueId} ($${balRes.equityUsd.toFixed(2)} USDC)`,
        msg: execMode === 'LIVE_EXEC'
          ? `Đã BẬT ĐẨY LỆNH THẬT (${network}, trần $${maxLiveNotionalUsd}/lệnh) qua Local Signer!`
          : `Số dư thực đã đồng bộ tự động (Chạy bóng an toàn • Khả dụng: $${balRes.freeMarginUsd.toFixed(2)} USDC).`
      });
    });

    market.on((type, payload) => {
      if (type === 'wsStatus') {
        const btn = $('btnToggleWs');
        btn.innerHTML = `<span class="ws-indicator ${payload.connected ? 'on' : ''}" id="wsIndicator"></span> ${payload.text}`;
        $('feedStatusText').textContent = payload.connected
          ? 'MULTI-VENUE LIVE FEED (5 SÀN)'
          : 'MULTI-VENUE SYNTH + WS';
      } else if (type === 'catalogUpdated') {
        updateCoinCatalogBadge();
        const coinMod = $('coinPickerModal');
        if (coinMod && !coinMod.classList.contains('hidden')) {
          renderCoinPickerModal();
        }
      } else if (type === 'tradePrint' && payload.print.whale) {
        sphereRenderer.triggerPulse('#fbbf24');
      }
    });

    trading.on((type, payload) => {
      if (type === 'toast') showToast(payload);
      else if (type === 'tradeClosed' && payload) {
        if (payload.pnl > 0) {
          const burstCount = Math.min(12, Math.max(5, Math.round(5 + payload.pnl * 2)));
          sphereRenderer.triggerCoinBurst(burstCount, `+$${payload.pnl.toFixed(2)}`);
          sphereRenderer.triggerPulse('#fbbf24');
        } else if (payload.pnl < 0) {
          sphereRenderer.triggerLossPopup(`-$${Math.abs(payload.pnl).toFixed(2)}`);
          sphereRenderer.triggerPulse('#ff3b6b');
        }
      } else if (type === 'profitLocked') {
        sphereRenderer.triggerCoinBurst(12, 'CHỐT LÃI!');
        sphereRenderer.triggerPulse('#34d399');
        renderTradingPanels();
      } else if (type === 'updated' || type === 'breakerTripped' || type === 'breakerReset') {
        renderTradingPanels();
      }
    });
  }

  // Command Palette (Ctrl+K / Cmd+K)
  const cmdPalette = new window.QuantumCommandPalette({
    backdropEl: $('cmdPaletteBackdrop'),
    inputEl: $('cmdPaletteInput'),
    listEl: $('cmdPaletteList'),
    motion,
    getCommands: () => {
      const catCoins = typeof market.getVenueCatalog === 'function'
        ? market.getVenueCatalog(market.activeExchange).slice(0, 60)
        : Object.keys(market.instruments).map((sym) => ({ symbol: sym, baseCoin: sym.split('-')[0] }));
      const coinCmds = catCoins.map((item) => ({
        label: `Chuyển sang ${item.symbol}${Number.isFinite(Number(item.price)) ? ` (${formatCatalogPrice(item.price)})` : ''}`,
        category: 'INSTRUMENT',
        run: () => selectDynamicCoin(item.symbol, market.activeExchange)
      }));
      return [
        ...coinCmds,
        { label: 'Mở danh sách toàn bộ Coin theo sàn (Tìm kiếm Live)', category: 'INSTRUMENT', run: openCoinPickerModal },
        { label: 'Lọc sàn: Hyperliquid DEX', category: 'VENUE', run: () => selectExchange('HYPERLIQUID') },
        { label: 'Lọc sàn: Binance Futures', category: 'VENUE', run: () => selectExchange('BINANCE') },
        { label: 'Lọc sàn: Bybit Linear', category: 'VENUE', run: () => selectExchange('BYBIT') },
        { label: 'Lọc sàn: OKX Swap', category: 'VENUE', run: () => selectExchange('OKX') },
        { label: 'Lọc sàn: Deribit Perp', category: 'VENUE', run: () => selectExchange('DERIBIT') },
        { label: 'Hiển thị tất cả 5 sàn (Aggregated)', category: 'VENUE', run: () => selectExchange('ALL') },
        { label: 'Mở Tab ⚡ Săn Funding Arbitrage (Delta-Neutral)', category: 'ARBITRAGE', run: () => switchBlotterTab('arb') },
        { label: trading.botRunning ? 'Tạm dừng Bot tự động' : 'Chạy Bot tự động', category: 'BOT', run: () => trading.toggleBot() },
        { label: 'Chế độ rủi ro: 🛡 AN TOÀN (SAFE)', category: 'CAPITAL', run: () => trading.setRiskMode('SAFE') },
        { label: 'Chế độ rủi ro: ⚖️ CÂN BẰNG (BALANCED)', category: 'CAPITAL', run: () => trading.setRiskMode('BALANCED') },
        { label: 'Chế độ rủi ro: 🚀 SĂN MỤC TIÊU (AGGRESSIVE)', category: 'CAPITAL', run: () => trading.setRiskMode('AGGRESSIVE') },
        { label: '🔓 Mở khóa Daily Profit Lock (chạy phiên mới)', category: 'CAPITAL', run: () => trading.unlockDailyProfitLock(true) },
        { label: 'Bật / Tắt dữ liệu giá Live WebSocket', category: 'FEED', run: () => market.toggleLiveWebSocket(!market.wsEnabled) },
        { label: 'Mở Cửa Sổ Kết Nối Live API / Ví DEX (2FA)', category: 'SECURITY', run: openApiModal },
        { label: 'Thu hồi toàn bộ phiên 2FA trên mọi thiết bị', category: 'SECURITY', run: revokeAllSessionsFlow },
        { label: '⚡ Test Sốc Biến Động (Flash Crash / Circuit Breaker)', category: 'RISK', run: () => $('btnTriggerShock').click() },
        { label: 'Reset Ví Demo', category: 'DEMO', run: () => trading.resetDemo() }
      ];
    }
  });

  $('btnCmdPalette').addEventListener('click', () => cmdPalette.open());

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

  // Bootstrap ($100+ Demo Capital + Auto Live Prices across all 5 exchanges)
  market.timeframe = '1m';
  trading.setCapital(100);
  buildVenueCards();
  renderInstrumentButtons();
  bindAllEvents();
  syncAutoSize();
  updateClock();
  updateMarketHUD(market.getSymbolState());
  renderTradingPanels();
  motion.animateBoot();
  market.toggleLiveWebSocket(true);

  setInterval(updateClock, 1000);
  setInterval(() => {
    market.tick();
    trading.onMarketTick();
    updateMarketHUD(market.getSymbolState());
    renderTradingPanels();
  }, 240);

  requestAnimationFrame(animate);
})();
