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
    CvdAndSparkRenderer,
    invalidateCanvasSizes
  } = window.QuantumVisualizers;

  let selectedSide = 'LONG';
  let activeBlotterTab = 'positions';
  let pnlViewYear = new Date().getFullYear();
  let pnlViewMonth = new Date().getMonth() + 1;
  let pnlSelectedDateKey = null;
  let pnlBlotterView = 'month';
  let pnlRangeKey = '7d';
  let pnlModalTab = 'overview';
  let pnlDailyDisplay = 'calendar';
  let pnlHideAmounts = false;
  let pnlExtraExpanded = false;
  let lastPnlBlotterSig = '';
  let lastPnlModalSig = '';
  let lastVenueCardEx = '';
  let lastDemoCapTag = '';
  let lastDemoModeState = '';
  let lastRiskUiSig = '';
  let lastPosSig = '';
  let lastOrdSig = '';
  let lastHistSig = '';
  let lastLogSig = '';
  let lastOpenPosBarSig = '';
  let activeOtpChallengeId = null;
  let verified2faSession = null;
  let liveSyncTimer = null;
  let coinPickerVenue = 'ALL';
  let coinPickerSort = 'volume';
  let coinPickerQuery = '';
  let liveSessionCredentials = null; // Strict RAM-only; cleared on revoke or switch to DEMO
  let botAutoSwitchedChart = false;
  let botReturnBtcTimer = null;
  let botBadgeHideTimer = null;
  let userManualChartUntil = 0;

  const $ = (id) => document.getElementById(id);
  function isMobileTabLayout() {
    return typeof document !== 'undefined' &&
      !document.documentElement.classList.contains('desktop-viewport-mode') &&
      typeof window !== 'undefined' &&
      window.innerWidth <= 1024;
  }
  function isAnyBlockingModalOpen() {
    const ids = ['authGateOverlay', 'pnlCalendarModal', 'coinPickerModal', 'apiModal', 'accountModal'];
    for (let i = 0; i < ids.length; i++) {
      const el = $(ids[i]);
      if (el && !el.classList.contains('hidden')) return true;
    }
    return false;
  }
  function fmtSignedUsd(val, digits = 2) {
    const n = Number(val) || 0;
    return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(digits)}`;
  }
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

  const STORAGE_STATE_KEY = 'qc_terminal_state_v1';
  let lastSavedStateAt = 0;
  let lastPersistedOrderSig = '';

  function getPersistedOrderSignature() {
    const posIds = Array.isArray(trading.positions) ? trading.positions.map((p) => p.id).join(',') : '';
    const ordIds = Array.isArray(trading.limitOrders) ? trading.limitOrders.map((o) => o.id).join(',') : '';
    return `${trading.positions.length}|${trading.limitOrders.length}|${trading.history.length}|${posIds}|${ordIds}`;
  }

  function savePersistedState(force = false) {
    if (typeof localStorage === 'undefined' || trading.mode === 'LIVE') return;
    const now = Date.now();
    if (!force && (now - lastSavedStateAt) < 1200) return;
    lastSavedStateAt = now;
    lastPersistedOrderSig = getPersistedOrderSignature();
    try {
      const snap = trading.exportState();
      localStorage.setItem(STORAGE_STATE_KEY, JSON.stringify(snap));
    } catch (_) {}
  }

  function syncUIFromRestoredState() {
    const cap = trading.initialCapital || 100;
    document.querySelectorAll('#capPresets .cap-btn').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.cap) === cap);
    });
    document.querySelectorAll('#riskModeGroup .rmode-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.rmode === trading.riskMode);
    });
    document.querySelectorAll('#botDirGroup .bdir-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.dir === trading.botDirectionMode);
    });
    document.querySelectorAll('#botStrategies .strat-item').forEach((item) => {
      const inp = item.querySelector('input[type="radio"]');
      const match = Boolean(inp && inp.value === trading.botStrategy);
      if (inp) inp.checked = match;
      item.classList.toggle('active', match);
    });
    const tfBtns = document.querySelectorAll('#tfGroup .tf-btn');
    tfBtns.forEach((b) => b.classList.toggle('active', b.dataset.tf === market.timeframe));
    document.querySelectorAll('.ex-pill').forEach((p) => {
      p.classList.toggle('active', p.dataset.exchange === market.activeExchange);
    });
    const hrRow = $('highRiskLevRow');
    if (hrRow) {
      hrRow.classList.toggle('hidden', trading.riskMode !== 'HIGH_RISK');
      hrRow.querySelectorAll('.hrlev-btn').forEach((btn) => {
        btn.classList.toggle('active', Number(btn.dataset.hrlev) === (trading.highRiskLeverage || 10));
      });
    }
    const levEl = $('selLeverage');
    const restoredPlan = trading.getCapitalProfile();
    if (levEl && restoredPlan) {
      const optExists = Array.from(levEl.options).some((o) => Number(o.value) === restoredPlan.maxSafeLeverage);
      if (optExists) levEl.value = String(restoredPlan.maxSafeLeverage);
    }
    const setChk = (id, val) => { const el = $(id); if (el) el.checked = Boolean(val); };
    setChk('chkStrictSlTp', trading.strictSlTpOnly);
    setChk('chkDailyProfitLock', trading.dailyProfitLockEnabled);
    setChk('chkMtfFilter', market.mtfFilterEnabled);
    setChk('chkNewsSpikeFilter', market.newsSpikeFilterEnabled);
    setChk('chkAutoSize', trading.riskShield.autoSizeEnabled);
    setChk('chkPostOnly', trading.riskShield.postOnlyMaker);
    setChk('chkBnbFeeDiscount', market.binanceBnbDiscount);
    setChk('chkAutoBE', trading.riskShield.autoBreakeven);
    setChk('chkAutoFlatten', trading.autoFlattenOnBreak);
    updateVenueFeeBadge();
  }

  function updateVenueFeeBadge() {
    const el = $('venueFeeBadge');
    if (!el || typeof market.getVenueFeeSchedule !== 'function') return;
    const s = market.getVenueFeeSchedule(market.activeExchange);
    const srcTag = s.source === 'LIVE_API'
      ? 'Live API'
      : (s.source === 'BNB_-10%' ? 'BNB -10%' : 'Tier-0 chuẩn');
    el.textContent = `Phí ${s.venue}: Maker ${s.makerPct.toFixed(3)}% / Taker ${s.takerPct.toFixed(3)}% (${srcTag})`;
  }

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
    const feePct = (entryFeeBps + exitFeeBps) / 100;
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
    const feePct = (entryFeeBps + exitFeeBps) / 100;
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
        flEl.innerHTML = `Flow: <span class="${m >= 0 ? 'pos' : 'neg'}">${fmtSignedUsd(m, 2)}M</span>`;
      }
      if (scEl) scEl.textContent = score;
    });
    $('sphereWhale').textContent = topVenue;

    if (market.activeExchange !== lastVenueCardEx) {
      lastVenueCardEx = market.activeExchange;
      document.querySelectorAll('.venue-card').forEach((card) => {
        card.classList.toggle('selected', card.dataset.exchange === market.activeExchange);
      });
    }
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

  function renderActiveBlotterTab(force = false, positionsArg = null, ordersArg = null, historyArg = null) {
    const positions = positionsArg || trading.getPublicPositions();

    if (activeBlotterTab === 'positions') {
      const posSig = positions.length === 0
        ? 'empty'
        : `${market.activeSymbol}|${positions.map((p) => `${p.id}:${p.markPrice}:${p.unrealizedPnl.toFixed(2)}:${p.slPrice}:${p.tpPrice}:${p.beLocked ? 1 : 0}:${p.trailingActive ? 1 : 0}`).join(';')}`;
      if (force || posSig !== lastPosSig) {
        lastPosSig = posSig;
        if (positions.length === 0) {
          $('tblPositions').innerHTML = '<tr class="empty-row"><td colspan="8">Chưa có vị thế mở — Click trực tiếp trên biểu đồ nến hoặc bật Bot để giao dịch.</td></tr>';
        } else {
          $('tblPositions').innerHTML = positions
            .map((p) => {
              const pnlCls = p.unrealizedPnl >= 0 ? 'pos' : 'neg';
              const sign = p.unrealizedPnl >= 0 ? '+' : '';
              const isViewing = p.symbol === market.activeSymbol;
              const shieldBadge = p.trailingActive
                ? '<span class="be-tag">TRAIL 🔒</span>'
                : (p.beLocked ? '<span class="be-tag">SL=BE 🔒</span>' : (p.hedgeGroupId ? '<span class="arb-badge">HEDGE</span>' : ''));
              const slTpCell = p.hedgeGroupId
                ? `<span class="cyan">Delta-Neutral</span> <span class="muted">(F: ${fmtSignedUsd(p.accruedFundingUsd || 0, 2)})</span>`
                : `<span class="neg">${market.formatPrice(p.slPrice, p.symbol)}</span> / <span class="pos">${market.formatPrice(p.tpPrice, p.symbol)}</span>`;
              return `
                <tr class="clickable-row${isViewing ? ' viewing-chart' : ''}" data-view-symbol="${p.symbol}" data-view-exchange="${p.exchange}" title="Bấm để xem biểu đồ ${p.symbol}">
                  <td><span class="pos-sym-link"><span class="pos-chart-ico">📈</span><strong>${p.symbol}</strong> <span class="muted">${p.exchange.slice(0, 4)}</span>${shieldBadge}</span></td>
                  <td class="${p.side === 'LONG' ? 'pos' : 'neg'}"><strong>${p.side} ${p.leverage}x</strong></td>
                  <td>$${p.sizeUsd.toLocaleString()}</td>
                  <td>${market.formatPrice(p.entryPrice, p.symbol)}</td>
                  <td class="gold">${market.formatPrice(p.markPrice, p.symbol)}</td>
                  <td>${slTpCell}</td>
                  <td class="${pnlCls}"><strong>${fmtSignedUsd(p.unrealizedPnl, 2)}</strong> (${sign}${p.roePct.toFixed(1)}%)</td>
                  <td class="pos-actions-cell">
                    <button type="button" class="btn btn-xs btn-cyan-outline" data-view-chart="${p.symbol}" data-view-exchange="${p.exchange}" title="Mở biểu đồ ${p.symbol}">Biểu đồ</button>
                    <button type="button" class="btn btn-xs btn-danger-outline" data-close-pos="${p.id}">Đóng</button>
                  </td>
                </tr>`;
            })
            .join('');
        }
      }
      return;
    }

    if (activeBlotterTab === 'orders') {
      const orders = ordersArg || trading.getPublicOrders();
      const ordSig = orders.length === 0
        ? 'empty'
        : `${market.activeSymbol}|${orders.map((o) => `${o.id}:${o.entryPrice}:${o.slPrice}:${o.tpPrice}`).join(';')}`;
      if (force || ordSig !== lastOrdSig) {
        lastOrdSig = ordSig;
        if (orders.length === 0) {
          $('tblOrders').innerHTML = '<tr class="empty-row"><td colspan="7">Không có lệnh Limit đang chờ khớp.</td></tr>';
        } else {
          $('tblOrders').innerHTML = orders
            .map(
              (o) => `
              <tr class="clickable-row${o.symbol === market.activeSymbol ? ' viewing-chart' : ''}" data-view-symbol="${o.symbol}" data-view-exchange="${o.exchange}" title="Bấm để xem biểu đồ ${o.symbol}">
                <td><span class="pos-sym-link"><span class="pos-chart-ico">📈</span><strong>${o.symbol}</strong> <span class="muted">${o.exchange.slice(0, 4)}</span></span></td>
                <td class="${o.side === 'LONG' ? 'pos' : 'neg'}"><strong>${o.side} ${o.leverage}x</strong></td>
                <td>$${o.sizeUsd.toLocaleString()}</td>
                <td class="gold">${market.formatPrice(o.entryPrice, o.symbol)}</td>
                <td><span class="neg">${market.formatPrice(o.slPrice, o.symbol)}</span> / <span class="pos">${market.formatPrice(o.tpPrice, o.symbol)}</span></td>
                <td class="cyan">${o.source}</td>
                <td><button type="button" class="btn btn-xs btn-ghost" data-cancel-ord="${o.id}">Hủy</button></td>
              </tr>`
            )
            .join('');
        }
      }
      return;
    }

    if (activeBlotterTab === 'arb') {
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
              <tr class="clickable-row${o.symbol === market.activeSymbol ? ' viewing-chart' : ''}" data-view-symbol="${o.symbol}" data-view-exchange="ALL" title="Bấm để xem biểu đồ ${o.symbol}">
                <td><strong>${o.symbol}</strong></td>
                <td class="pos">${o.longVenue.slice(0, 5)} <span class="muted">${market.formatPrice(o.longPrice, o.symbol)}</span></td>
                <td class="neg">${o.shortVenue.slice(0, 5)} <span class="muted">${market.formatPrice(o.shortPrice, o.symbol)}</span></td>
                <td class="${o.basisBps >= 0 ? 'pos' : 'neg'}">${o.basisBps >= 0 ? '+' : ''}${o.basisBps.toFixed(2)} bps</td>
                <td class="${aprCls}"><strong>${o.netAprPct >= 0 ? '+' : ''}${o.netAprPct.toFixed(1)}%</strong></td>
                <td>${statusTxt}</td>
                <td><button type="button" class="btn btn-xs ${hasPair ? 'btn-ghost' : 'btn-cyan-outline'}" data-exec-arb="${o.symbol}" ${hasPair ? 'disabled' : ''}>${hasPair ? 'Đang chạy' : 'Hedge 2x'}</button></td>
              </tr>`;
          })
          .join('');
      }
      return;
    }

    if (activeBlotterTab === 'history') {
      const history = historyArg || trading.getPublicHistory();
      const histSig = history.length === 0
        ? 'empty'
        : `${market.activeSymbol}|${history.length}|${history[0]?.id || ''}|${history[0]?.pnl || 0}`;
      if (force || histSig !== lastHistSig) {
        lastHistSig = histSig;
        if (history.length === 0) {
          $('tblHistory').innerHTML = '<tr class="empty-row"><td colspan="6">Chưa có lệnh đã chốt.</td></tr>';
        } else {
          $('tblHistory').innerHTML = history
            .slice(0, 25)
            .map((h) => {
              const cls = h.pnl >= 0 ? 'pos' : 'neg';
              const fee = Number(h.feeUsd) || 0;
              const gross = Number.isFinite(Number(h.grossPnl)) ? Number(h.grossPnl) : (h.pnl + fee);
              return `
                <tr class="clickable-row${h.symbol === market.activeSymbol ? ' viewing-chart' : ''}" data-view-symbol="${h.symbol}" data-view-exchange="${h.exchange || 'ALL'}" title="Bấm để xem biểu đồ ${h.symbol}">
                  <td class="muted">${h.time}</td>
                  <td><span class="pos-sym-link"><span class="pos-chart-ico">📈</span><strong>${h.symbol}</strong> <span class="${h.side === 'LONG' ? 'pos' : 'neg'}">${h.side}</span></span></td>
                  <td>${market.formatPrice(h.entryPrice, h.symbol)} → ${market.formatPrice(h.exitPrice, h.symbol)}</td>
                  <td class="gold">${h.reason}</td>
                  <td class="muted" title="Lãi gộp (Gross): ${fmtSignedUsd(gross, 2)} | Phí sàn ${h.exchange || ''} (${((Number(h.entryFeeBps) || 0) / 100).toFixed(3)}% + ${((Number(h.exitFeeBps) || 0) / 100).toFixed(3)}%): -$${fee.toFixed(2)}">-$${fee.toFixed(2)}</td>
                  <td class="${cls}"><strong>${fmtSignedUsd(h.pnl, 2)}</strong></td>
                </tr>`;
            })
            .join('');
        }
      }
      return;
    }

    if (activeBlotterTab === 'logs') {
      const logs = trading.logs || [];
      const logSig = `${logs.length}|${logs[0]?.time || ''}|${logs[0]?.msg || ''}`;
      if (force || logSig !== lastLogSig) {
        lastLogSig = logSig;
        $('systemLogFeed').innerHTML = logs
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
    }
  }

  function renderTradingPanels(force = false) {
    const m = trading.getMetrics();
    const positions = trading.getPublicPositions();
    const orders = trading.getPublicOrders();
    const history = trading.getPublicHistory();

    $('kpiEquity').textContent = `$${m.equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const uSign = m.unrealizedPnl >= 0 ? '+' : '';
    const uEl = $('kpiUnrealized');
    uEl.textContent = `uPnL: ${fmtSignedUsd(m.unrealizedPnl, 2)} (${uSign}${m.unrealizedPct.toFixed(2)}%)`;
    uEl.className = `kpi-pnl ${m.unrealizedPnl >= 0 ? 'pos' : 'neg'}`;

    $('kpiDrawdown').textContent = `DD: ${m.drawdownPct.toFixed(2)}%`;
    $('kpiFreeMargin').textContent = `$${m.freeMargin.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const rEl = $('kpiRealized');
    rEl.textContent = fmtSignedUsd(m.realizedPnl, 2);
    rEl.className = `ms-val ${m.realizedPnl >= 0 ? 'pos' : 'neg'}`;

    $('kpiWinRate').textContent = `${m.winRate.toFixed(1)}% (${m.wins}/${m.wins + m.losses})`;

    const pnlReport = typeof trading.getPnlCalendarReport === 'function'
      ? trading.getPnlCalendarReport({ year: pnlViewYear, month: pnlViewMonth })
      : null;
    if (pnlReport) {
      updateKpiPeriodStrip(pnlReport);
      if (activeBlotterTab === 'pnl') {
        renderPnlBlotter(pnlReport, force);
      }
      renderPnlModal(pnlReport, force);
    }

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
      if (capTag !== lastDemoCapTag || trading.mode !== lastDemoModeState) {
        lastDemoCapTag = capTag;
        lastDemoModeState = trading.mode;
        const rstBtn = $('btnResetDemo');
        if (rstBtn) rstBtn.textContent = `Reset ${capTag}`;
        const modeDemoBtn = $('btnModeDemo');
        if (modeDemoBtn && trading.mode === 'DEMO') {
          modeDemoBtn.innerHTML = `<span class="mode-dot demo"></span> DEMO ${capTag}`;
        }
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
        const dpFmt = fmtSignedUsd(dp, 2);
        progEl.textContent = trading.dailyProfitLocked
          ? `🔒 ${dpFmt} / +$${dayPlan.dailyProfitLockUsd.toFixed(2)}`
          : `${dpFmt} / +$${dayPlan.dailyProfitLockUsd.toFixed(2)}`;
        progEl.className = `plan-prog-badge ${trading.dailyProfitLocked ? 'locked' : (dp >= 0 ? 'pos' : 'neg')}`;
      }

      const riskUiSig = `${trading.riskMode}|${trading.highRiskLeverage || 10}`;
      if (riskUiSig !== lastRiskUiSig) {
        lastRiskUiSig = riskUiSig;
        document.querySelectorAll('#riskModeGroup .rmode-btn').forEach((btn) => {
          btn.classList.toggle('active', btn.dataset.rmode === trading.riskMode);
        });
        const hrRow = $('highRiskLevRow');
        if (hrRow) {
          hrRow.classList.toggle('hidden', trading.riskMode !== 'HIGH_RISK');
          hrRow.querySelectorAll('.hrlev-btn').forEach((btn) => {
            btn.classList.toggle('active', Number(btn.dataset.hrlev) === (trading.highRiskLeverage || 10));
          });
        }
      }
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
      const dp = pnlReport ? pnlReport.today.totalPnl : (Number.isFinite(m.dailyPnlUsd) ? m.dailyPnlUsd : 0);
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

    const openPosBar = $('chartOpenPosBar');
    if (openPosBar) {
      const openBarSig = positions.length === 0
        ? 'empty'
        : `${market.activeSymbol}|${positions.map((p) => `${p.id}:${p.unrealizedPnl.toFixed(2)}`).join(';')}`;
      if (force || openBarSig !== lastOpenPosBarSig) {
        lastOpenPosBarSig = openBarSig;
        if (positions.length === 0) {
          openPosBar.classList.add('hidden');
          openPosBar.innerHTML = '';
        } else {
          openPosBar.classList.remove('hidden');
          openPosBar.innerHTML = `<span class="cop-lbl">ĐANG CÓ LỆNH (${positions.length}):</span>` + positions
            .map((p) => {
              const isViewing = p.symbol === market.activeSymbol;
              const pnlCls = p.unrealizedPnl >= 0 ? 'pos' : 'neg';
              const sideTag = p.side === 'LONG' ? 'L' : 'S';
              return `
                <button type="button" class="cop-pill ${p.side === 'LONG' ? 'long' : 'short'}${isViewing ? ' active' : ''}" data-view-symbol="${p.symbol}" data-view-exchange="${p.exchange}" title="Xem biểu đồ ${p.symbol}">
                  <strong>${p.symbol.replace('-PERP', '')}</strong>
                  <span class="cop-side">${sideTag}${p.leverage}x</span>
                  <span class="${pnlCls}">${fmtSignedUsd(p.unrealizedPnl, 2)}</span>
                </button>`;
            })
            .join('');
        }
      }
    }

    renderActiveBlotterTab(force, positions, orders, history);
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

  function switchMobileTab(tabKey) {
    const validTabs = ['chart', 'bot', 'blotter', 'book'];
    const targetTab = validTabs.includes(tabKey) ? tabKey : 'chart';
    document.documentElement.dataset.mobileTab = targetTab;
    document.querySelectorAll('#mobileBottomNav .mnav-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mtab === targetTab);
    });
    if (typeof window.scrollTo === 'function') window.scrollTo(0, 0);
    if (typeof invalidateCanvasSizes === 'function') invalidateCanvasSizes();
    const st = market.getSymbolState();
    if (targetTab === 'book' && st) {
      renderOrderbook(st);
      renderTape(st);
    } else if (targetTab === 'chart' && st) {
      updateVenueCards(st);
      renderChartForecastBar(st);
      if (cvdRenderer) cvdRenderer.render(true);
    } else if (targetTab === 'blotter') {
      if (activeBlotterTab === 'pnl' && typeof trading.getPnlCalendarReport === 'function') {
        renderPnlBlotter(trading.getPnlCalendarReport({ year: pnlViewYear, month: pnlViewMonth }), true);
      } else {
        renderActiveBlotterTab(true);
      }
    }
    window.dispatchEvent(new Event('resize'));
  }

  function selectDynamicCoin(sym, targetVenue = coinPickerVenue, silent = false) {
    const st = typeof market.ensureInstrument === 'function' ? market.ensureInstrument(sym) : market.getSymbolState(sym);
    if (!st) return;
    if (!silent) {
      if (botReturnBtcTimer) { clearTimeout(botReturnBtcTimer); botReturnBtcTimer = null; }
      botAutoSwitchedChart = false;
      userManualChartUntil = st.symbol === 'BTC-PERP' ? 0 : (Date.now() + 12000);
    }
    if (targetVenue && targetVenue !== market.activeExchange && market.venueCatalog?.[targetVenue]) {
      market.setExchange(targetVenue);
      document.querySelectorAll('.ex-pill').forEach((p) => p.classList.toggle('active', p.dataset.exchange === targetVenue));
    }
    selectSymbol(st.symbol);
    renderInstrumentButtons();
    closeCoinPickerModal();
    if (!silent) {
      showToast({
        type: 'cyan',
        title: `ĐÃ MỞ ${st.symbol}`,
        msg: `Đang tải biểu đồ & sổ lệnh theo giá thực trên ${market.activeExchange === 'ALL' ? '5 SÀN' : market.activeExchange}.`
      });
    }
  }

  function focusSymbolChart(sym, exchange) {
    if (!sym) return;
    if (botReturnBtcTimer) { clearTimeout(botReturnBtcTimer); botReturnBtcTimer = null; }
    botAutoSwitchedChart = false;
    userManualChartUntil = sym === 'BTC-PERP' ? 0 : (Date.now() + 12000);
    const targetVenue = market.activeExchange === 'ALL' ? 'ALL' : (exchange || market.activeExchange);
    selectDynamicCoin(sym, targetVenue, true);
    renderTradingPanels();
    const isDesktopMode = document.documentElement.classList.contains('desktop-viewport-mode');
    if (!isDesktopMode && window.innerWidth <= 1180) {
      switchMobileTab('chart');
    }
    const chartPanel = document.querySelector('.chart-panel');
    if (chartPanel && typeof chartPanel.scrollIntoView === 'function') {
      chartPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    if (typeof candleRenderer.draw === 'function') candleRenderer.draw();
    const openPos = trading.positions.find((p) => p.symbol === sym);
    showToast({
      type: 'cyan',
      title: `📈 BIỂU ĐỒ ${sym}`,
      msg: openPos
        ? `${openPos.side} ${openPos.leverage}x • Entry ${market.formatPrice(openPos.entryPrice, sym)} | SL ${market.formatPrice(openPos.slPrice, sym)} | TP ${market.formatPrice(openPos.tpPrice, sym)}`
        : `Đang hiển thị nến live & dự đoán AI cho ${sym}.`
    });
  }

  function setChartBotFocusBadge(text, modeClass, autoHideMs = 0) {
    const el = $('chartBotFocusBadge');
    if (!el) return;
    if (botBadgeHideTimer) { clearTimeout(botBadgeHideTimer); botBadgeHideTimer = null; }
    if (!text) {
      el.className = 'chart-bot-focus-badge hidden';
      el.textContent = '';
      return;
    }
    el.className = `chart-bot-focus-badge ${modeClass || 'entered'}`;
    el.textContent = text;
    if (autoHideMs > 0) {
      botBadgeHideTimer = setTimeout(() => {
        el.className = 'chart-bot-focus-badge hidden';
        el.textContent = '';
      }, autoHideMs);
    }
  }

  function scheduleReturnToBtc(delayMs = 4500) {
    if (botReturnBtcTimer) clearTimeout(botReturnBtcTimer);
    botReturnBtcTimer = setTimeout(() => {
      botReturnBtcTimer = null;
      if (!botAutoSwitchedChart) return;
      if (Date.now() < userManualChartUntil) return;
      if (trading.botFocusTarget && trading.botFocusTarget.phase === 'PREPARING') return;
      botAutoSwitchedChart = false;
      if (market.activeSymbol !== 'BTC-PERP') {
        selectDynamicCoin('BTC-PERP', market.activeExchange, true);
        renderTradingPanels();
        if (typeof candleRenderer.draw === 'function') candleRenderer.draw();
      }
      setChartBotFocusBadge('↩ Đã vào xong lệnh • Về lại BTC-PERP', 'returning', 2500);
    }, delayMs);
  }

  function handleBotFocusEvent(focus) {
    if (!focus || focus.phase === 'RETURN_BTC') {
      if (botAutoSwitchedChart) {
        scheduleReturnToBtc(focus?.immediate ? 300 : 1200);
      } else {
        setChartBotFocusBadge('', '');
      }
      return;
    }
    if (Date.now() < userManualChartUntil) return;

    if (focus.phase === 'PREPARING' && focus.symbol) {
      if (botReturnBtcTimer) { clearTimeout(botReturnBtcTimer); botReturnBtcTimer = null; }
      if (market.activeSymbol !== focus.symbol) {
        selectDynamicCoin(focus.symbol, market.activeExchange, true);
        botAutoSwitchedChart = true;
      } else if (focus.symbol !== 'BTC-PERP') {
        botAutoSwitchedChart = true;
      }
      setChartBotFocusBadge(
        `🤖 AI SẮP VÀO ${focus.side} ${focus.symbol} (${focus.streak || 1}/${focus.requiredStreak || 3} • ${focus.confidence || 70}%)`,
        'preparing'
      );
      renderTradingPanels();
      if (typeof candleRenderer.draw === 'function') candleRenderer.draw();
    } else if (focus.phase === 'ENTERED' && focus.symbol) {
      if (botReturnBtcTimer) { clearTimeout(botReturnBtcTimer); botReturnBtcTimer = null; }
      if (market.activeSymbol !== focus.symbol) {
        selectDynamicCoin(focus.symbol, market.activeExchange, true);
      }
      botAutoSwitchedChart = true;
      const doneAll = (focus.openCount || 1) >= (focus.maxCount || 1);
      setChartBotFocusBadge(
        `🤖 AI ĐÃ VÀO ${focus.side} ${focus.symbol}${doneAll ? ' • Đủ lệnh, về BTC sau 4s' : ' • Về BTC sau 4s'}`,
        'entered'
      );
      renderTradingPanels();
      if (typeof candleRenderer.draw === 'function') candleRenderer.draw();
      scheduleReturnToBtc(4500);
    }
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

    const mobileMode = isMobileTabLayout();
    const mobTab = document.documentElement.dataset.mobileTab || 'chart';
    if (!mobileMode || mobTab === 'chart') {
      updateVenueCards(st);
    }
    if (!mobileMode || mobTab === 'book') {
      renderOrderbook(st);
      renderTape(st);
    }
    updateSLTPPreview();
    renderChartForecastBar(st);
  }

  function renderChartForecastBar(st) {
    const bar = $('chartForecastBar');
    if (!bar) return;
    const enabled = Boolean(candleRenderer.showForecast);
    bar.classList.toggle('hidden', !enabled);
    if (!enabled || !st || typeof market.getTimeframeForecast !== 'function') return;

    const f = market.getTimeframeForecast(st.symbol, market.timeframe);
    const tfBadge = $('cfTfBadge');
    const dirBadge = $('cfDirBadge');
    const probFill = $('cfProbFillUp');
    const probTxt = $('cfProbText');
    const targetTxt = $('cfTargetText');
    const reasonTxt = $('cfReasonText');

    if (tfBadge) tfBadge.textContent = `KHUNG ${f.tfLabel}`;
    if (dirBadge) {
      let icon = '↔';
      let cls = 'sideways';
      if (f.direction === 'UP') { icon = '▲'; cls = 'up'; }
      else if (f.direction === 'DOWN') { icon = '▼'; cls = 'down'; }
      dirBadge.textContent = `${icon} ${f.directionLabel}`;
      dirBadge.className = `cf-dir-pill ${cls}`;
    }
    if (probFill) probFill.style.width = `${f.probabilityUp}%`;
    if (probTxt) {
      probTxt.innerHTML = `<span class="pos">Lên ${f.probabilityUp}%</span><span class="muted"> / </span><span class="neg">Xuống ${f.probabilityDown}%</span>`;
    }
    if (targetTxt) {
      const mvSign = f.targetMovePct >= 0 ? '+' : '';
      const mvCls = f.targetMovePct >= 0 ? 'pos' : 'neg';
      targetTxt.innerHTML = `Mục tiêu: <strong class="gold">$${market.formatPrice(f.targetPrice, st.symbol)}</strong> <span class="${mvCls}">(${mvSign}${f.targetMovePct.toFixed(2)}%)</span>`;
      targetTxt.title = `Hỗ trợ: $${market.formatPrice(f.supportPrice, st.symbol)} | Kháng cự: $${market.formatPrice(f.resistancePrice, st.symbol)}`;
    }
    if (reasonTxt) reasonTxt.textContent = f.summary;
  }

  function selectTimeframeUi(tf, notify = true) {
    document.querySelectorAll('#tfGroup .tf-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tf === tf);
    });
    market.setTimeframe(tf);
    candleRenderer._forecastCache.ts = 0;
    const st = market.getSymbolState();
    updateMarketHUD(st);
    if (typeof candleRenderer.draw === 'function') candleRenderer.draw();
    savePersistedState(true);
    if (notify && typeof market.getTimeframeForecast === 'function' && st) {
      const f = market.getTimeframeForecast(st.symbol, market.timeframe);
      const tType = f.direction === 'UP' ? 'pos' : (f.direction === 'DOWN' ? 'neg' : 'gold');
      const mvSign = f.targetMovePct >= 0 ? '+' : '';
      showToast({
        type: tType,
        title: `🔮 KHUNG ${f.tfLabel}: ${f.directionLabel}`,
        msg: `${st.symbol} • Lên ${f.probabilityUp}% / Xuống ${f.probabilityDown}% • Mục tiêu $${market.formatPrice(f.targetPrice, st.symbol)} (${mvSign}${f.targetMovePct.toFixed(2)}%)`
      });
    }
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
    updateSLTPPreview();
    updateVenueFeeBadge();
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

  function formatPnlStatus(status) {
    if (status === 'PROFIT') return 'LỜI';
    if (status === 'LOSS') return 'LỖ';
    if (status === 'FLAT') return 'HÒA';
    return '--';
  }

  function pnlStatusClass(status) {
    if (status === 'PROFIT') return 'is-profit';
    if (status === 'LOSS') return 'is-loss';
    if (status === 'FLAT') return 'is-flat';
    return 'is-none';
  }

  function pnlTextClass(val, status) {
    if (status === 'PROFIT' || val > 0.005) return 'pos';
    if (status === 'LOSS' || val < -0.005) return 'neg';
    return 'muted';
  }

  function formatCompactSignedUsd(val) {
    const n = Number(val) || 0;
    const abs = Math.abs(n);
    const sign = n > 0.005 ? '+' : (n < -0.005 ? '-' : '');
    if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
    if (abs >= 1000) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
    if (abs >= 100) return `${sign}$${abs.toFixed(0)}`;
    if (abs >= 0.01) return `${sign}$${abs.toFixed(2)}`;
    return '$0';
  }

  function formatDateKeyVN(dateKey) {
    if (!dateKey || typeof dateKey !== 'string') return '--';
    const parts = dateKey.split('-');
    if (parts.length !== 3) return dateKey;
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }

  function stepPnlMonth(delta) {
    let m = pnlViewMonth + delta;
    let y = pnlViewYear;
    while (m < 1) { m += 12; y -= 1; }
    while (m > 12) { m -= 12; y += 1; }
    pnlViewMonth = m;
    pnlViewYear = y;
    pnlSelectedDateKey = `${y}-${String(m).padStart(2, '0')}-01`;
  }

  function jumpPnlToToday() {
    const now = new Date();
    pnlViewYear = now.getFullYear();
    pnlViewMonth = now.getMonth() + 1;
    pnlSelectedDateKey = `${pnlViewYear}-${String(pnlViewMonth).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  function updateKpiPeriodStrip(report) {
    if (!report) return;
    const t = report.today;
    const m = report.month;
    const y = report.year;

    const applyCell = (valId, subId, focusName, val, status, subText) => {
      const valEl = $(valId);
      const subEl = $(subId);
      const cellEl = document.querySelector(`#kpiPeriodPnl [data-pnl-focus="${focusName}"]`);
      if (valEl) {
        valEl.textContent = Math.abs(val) < 0.005 ? '$0.00' : fmtSignedUsd(val, 2);
        valEl.className = `kpp-val ${pnlTextClass(val, status)}`;
      }
      if (subEl) {
        subEl.textContent = subText;
        subEl.className = `kpp-sub ${pnlTextClass(val, status)}`;
      }
      if (cellEl) {
        cellEl.classList.remove('is-profit', 'is-loss', 'is-flat', 'is-none');
        cellEl.classList.add(pnlStatusClass(status));
      }
    };

    const tLabel = t.status === 'NONE' ? 'CHƯA GD' : `${formatPnlStatus(t.status)}${t.trades > 0 ? ` • ${t.trades}L` : ''}`;
    applyCell('kpiPnlToday', 'kpiPnlTodaySub', 'today', t.totalPnl, t.status, tLabel);

    const mLabel = m.activeDays > 0
      ? `${formatPnlStatus(m.status)} • ${m.profitDays}W/${m.lossDays}L`
      : '0 ngày GD';
    applyCell('kpiPnlMonth', 'kpiPnlMonthSub', 'month', m.totalPnl, m.status, mLabel);

    const yLabel = y.activeMonths > 0
      ? `${formatPnlStatus(y.status)} • ${y.profitMonths}/${y.activeMonths}T`
      : '0 tháng GD';
    applyCell('kpiPnlYear', 'kpiPnlYearSub', 'year', y.totalPnl, y.status, yLabel);
  }

  function renderPnlBlotter(report, force = false) {
    if (activeBlotterTab !== 'pnl' || !report) return;
    const gridEl = $('pnlBlotterGrid');
    if (!gridEl) return;

    const sig = [
      pnlBlotterView,
      pnlViewYear,
      pnlViewMonth,
      report.todayKey,
      report.today.totalPnl.toFixed(2),
      report.month.totalPnl.toFixed(2),
      report.month.trades,
      report.year.totalPnl.toFixed(2),
      report.year.trades
    ].join('|');
    if (!force && sig === lastPnlBlotterSig) return;
    lastPnlBlotterSig = sig;

    const setMiniPill = (id, prefix, obj) => {
      const el = $(id);
      if (!el) return;
      const valTxt = Math.abs(obj.totalPnl) < 0.005 ? '$0.00' : fmtSignedUsd(obj.totalPnl, 2);
      const stTxt = obj.status === 'NONE' ? 'CHƯA GD' : formatPnlStatus(obj.status);
      el.textContent = `${prefix}: ${valTxt} (${stTxt})`;
      el.className = `pnl-mpill ${pnlStatusClass(obj.status)}`;
    };

    setMiniPill('blPnlToday', 'Hôm nay', report.today);
    setMiniPill('blPnlMonth', `T${report.month.month}`, report.month);
    setMiniPill('blPnlYear', `Năm ${report.year.year}`, report.year);

    const lblEl = $('blPnlPeriodLabel');
    if (lblEl) {
      lblEl.textContent = pnlBlotterView === 'month'
        ? `T${String(report.month.month).padStart(2, '0')}/${report.month.year}`
        : `Năm ${report.year.year}`;
    }

    document.querySelectorAll('#pnlBlotterSubviewGroup [data-pnl-subview]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.pnlSubview === pnlBlotterView);
    });

    if (pnlBlotterView === 'month') {
      const empties = Array.from({ length: report.month.firstWeekdaySun ?? report.month.firstWeekday }, () => '<div class="pnl-cell empty"></div>').join('');
      const dayCells = report.month.days.map((d) => {
        const cls = [
          'pnl-cell',
          'clean',
          'compact',
          pnlStatusClass(d.status),
          d.isToday ? 'is-today' : '',
          d.isFuture ? 'is-future' : ''
        ].filter(Boolean).join(' ');
        const hasVal = d.trades > 0 || (d.isToday && Math.abs(d.totalPnl) >= 0.005);
        const valTxt = hasVal ? formatCompactSignedUsd(d.totalPnl) : '';
        return `
          <button type="button" class="${cls}" data-pnl-day="${d.dateKey}" title="${formatDateKeyVN(d.dateKey)}: ${fmtSignedUsd(d.totalPnl, 2)} (${d.trades} lệnh)">
            <span class="pcell-day">${d.day}</span>
            ${valTxt ? `<span class="pcell-val ${pnlTextClass(d.totalPnl, d.status)}">${valTxt}</span>` : ''}
          </button>`;
      }).join('');
      gridEl.innerHTML = `
        <div class="pnl-cal-weekdays clean compact">
          <span>CN</span><span>T2</span><span>T3</span><span>T4</span><span>T5</span><span>T6</span><span>T7</span>
        </div>
        <div class="pnl-cal-grid clean compact">${empties}${dayCells}</div>`;
    } else {
      const monthCells = report.year.months.map((mm) => {
        const cls = [
          'pnl-month-tile',
          'clean',
          'compact',
          pnlStatusClass(mm.status),
          mm.isCurrentMonth ? 'is-current' : '',
          mm.isFuture ? 'is-future' : '',
          mm.month === report.month.month ? 'is-selected' : ''
        ].filter(Boolean).join(' ');
        const hasVal = mm.trades > 0 || (mm.isCurrentMonth && Math.abs(mm.totalPnl) >= 0.005);
        const valTxt = hasVal ? formatCompactSignedUsd(mm.totalPnl) : '--';
        return `
          <button type="button" class="${cls}" data-pnl-month="${mm.month}" title="Tháng ${mm.month}/${report.year.year}: ${fmtSignedUsd(mm.totalPnl, 2)} (${mm.trades} lệnh)">
            <div class="pmt-top">
              <strong>${mm.label}</strong>
              <span class="pmt-badge">${mm.status === 'NONE' ? '--' : formatPnlStatus(mm.status)}</span>
            </div>
            <div class="pmt-val ${pnlTextClass(mm.totalPnl, mm.status)}">${valTxt}</div>
            <div class="pmt-meta">${mm.activeDays} ngày • ${mm.trades} lệnh</div>
          </button>`;
      }).join('');
      gridEl.innerHTML = `<div class="pnl-months-grid clean compact">${monthCells}</div>`;
    }
  }

  function renderPnlModal(report, force = false) {
    const modalEl = $('pnlCalendarModal');
    if (!modalEl || modalEl.classList.contains('hidden')) return;

    const analytics = typeof trading.getPnlAnalytics === 'function'
      ? trading.getPnlAnalytics({ year: pnlViewYear, month: pnlViewMonth, range: pnlRangeKey })
      : null;
    if (!analytics) return;
    const cal = analytics.calendar || report;
    if (!cal) return;

    const selectedKey = pnlSelectedDateKey || cal.todayKey;
    const sig = [
      pnlViewYear,
      pnlViewMonth,
      pnlRangeKey,
      pnlModalTab,
      pnlDailyDisplay,
      pnlHideAmounts ? 1 : 0,
      pnlExtraExpanded ? 1 : 0,
      selectedKey,
      cal.todayKey,
      analytics.today.totalPnl.toFixed(2),
      analytics.selectedRange.totalPnl.toFixed(2),
      cal.month.totalPnl.toFixed(2),
      cal.month.trades,
      cal.year.totalPnl.toFixed(2),
      cal.year.trades,
      trading.mode
    ].join('|');
    if (!force && sig === lastPnlModalSig) return;
    lastPnlModalSig = sig;

    const mask = (str) => (pnlHideAmounts ? '••••••' : str);
    const fmtSignedPct = (pct) => {
      const n = Number(pct) || 0;
      return `${n > 0.005 ? '+' : (n < -0.005 ? '-' : '')}${Math.abs(n).toFixed(2)}%`;
    };
    const fmtCompactSignedNoDollar = (val) => {
      const n = Number(val) || 0;
      const abs = Math.abs(n);
      const sign = n > 0.005 ? '+' : (n < -0.005 ? '-' : '');
      if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
      if (abs >= 1000) return `${sign}${(abs / 1e3).toFixed(1)}K`;
      if (abs >= 100) return `${sign}${abs.toFixed(1)}`;
      return `${sign}${abs.toFixed(2)}`;
    };
    const fmtSignedUsdLabel = (val) => {
      const n = Number(val) || 0;
      const sign = n > 0.005 ? '+' : (n < -0.005 ? '-' : '');
      return `${sign}${Math.abs(n).toFixed(2)} USD`;
    };

    const modePill = $('pnlModalModePill');
    if (modePill) {
      modePill.textContent = trading.mode === 'LIVE' ? 'LIVE' : 'DEMO';
      modePill.className = `panel-tag ${trading.mode === 'LIVE' ? 'gold' : 'cyan'}`;
    }
    const dateMeta = $('pnlModalDateMeta');
    if (dateMeta) dateMeta.textContent = `Cập nhật ${formatDateKeyVN(cal.todayKey)}`;

    const eyeBtn = $('btnTogglePnlPrivacy');
    if (eyeBtn) eyeBtn.textContent = pnlHideAmounts ? '🙈' : '👁';

    // 1. Today Hero + 7d / 30d / Lifetime
    const t = analytics.today;
    const tCls = pnlTextClass(t.totalPnl, t.status);
    const todayPctEl = $('pnlTodayPct');
    const todayUsdEl = $('pnlTodayUsd');
    if (todayPctEl) {
      todayPctEl.textContent = mask(fmtSignedPct(t.pct));
      todayPctEl.className = `pnl-big-pct ${tCls === 'muted' ? '' : tCls}`;
    }
    if (todayUsdEl) {
      todayUsdEl.textContent = mask(`≈ ${fmtSignedUsdLabel(t.totalPnl)}`);
      todayUsdEl.className = `pnl-big-usd ${tCls === 'muted' ? 'muted' : tCls}`;
    }

    const r7 = analytics.rolling7d;
    const r30 = analytics.rolling30d;
    const life = analytics.lifetime;
    const setRoll = (pctId, usdId, obj, isLife = false) => {
      const pEl = $(pctId);
      const uEl = $(usdId);
      const cls = pnlTextClass(obj.totalPnl, obj.status);
      if (isLife) {
        if (pEl) {
          pEl.textContent = mask(`${obj.totalPnl > 0.005 ? '+' : (obj.totalPnl < -0.005 ? '-' : '')}${Math.abs(obj.totalPnl).toFixed(2)}`);
          pEl.className = `pr-pct ${cls}`;
        }
        if (uEl) {
          uEl.textContent = mask(`USD (${fmtSignedPct(obj.pct)})`);
          uEl.className = `pr-usd ${cls}`;
        }
      } else {
        if (pEl) {
          pEl.textContent = mask(fmtSignedPct(obj.pct));
          pEl.className = `pr-pct ${cls}`;
        }
        if (uEl) {
          uEl.textContent = mask(fmtSignedUsdLabel(obj.totalPnl));
          uEl.className = `pr-usd ${cls}`;
        }
      }
    };
    setRoll('pnl7dPct', 'pnl7dUsd', r7, false);
    setRoll('pnl30dPct', 'pnl30dUsd', r30, false);
    setRoll('pnlLifeUsd', 'pnlLifePct', life, true);

    // 2. Range pills & 3 summary rows
    document.querySelectorAll('#pnlRangeGroup [data-pnl-range]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.pnlRange === pnlRangeKey);
    });
    const sr = analytics.selectedRange;
    const profEl = $('pnlRangeProfit');
    const lossEl = $('pnlRangeLoss');
    const netEl = $('pnlRangeNet');
    if (profEl) {
      profEl.textContent = mask(`${sr.profitUsd.toFixed(2)} USD`);
      profEl.className = `psr-val ${sr.profitUsd > 0.005 ? 'pos' : ''}`;
    }
    if (lossEl) {
      lossEl.textContent = mask(`${sr.lossUsd.toFixed(2)} USD`);
      lossEl.className = `psr-val ${sr.lossUsd > 0.005 ? 'neg' : ''}`;
    }
    if (netEl) {
      netEl.textContent = mask(fmtSignedUsdLabel(sr.netPnl));
      netEl.className = `psr-val ${pnlTextClass(sr.netPnl, sr.status)}`;
    }
    const extraEl = $('pnlRangeExtra');
    const chevBtn = $('btnTogglePnlExtra');
    if (chevBtn) chevBtn.textContent = pnlExtraExpanded ? '⌃' : '⌄';
    if (extraEl) {
      extraEl.classList.toggle('hidden', !pnlExtraExpanded);
      if (pnlExtraExpanded) {
        extraEl.innerHTML = `
          <div class="pnl-sum-row"><span class="psr-lbl">Số lệnh / Win Rate</span><strong>${sr.trades} lệnh (${sr.winRate.toFixed(1)}%)</strong></div>
          <div class="pnl-sum-row"><span class="psr-lbl">Ngày lời / Ngày lỗ</span><strong><span class="pos">${sr.profitDays}W</span> / <span class="neg">${sr.lossDays}L</span> (${sr.activeDays} ngày)</strong></div>
          <div class="pnl-sum-row"><span class="psr-lbl">Tổng phí sàn</span><strong class="muted">-${mask(sr.feeUsd.toFixed(2))} USD</strong></div>`;
      }
    }

    // 3. Section Tabs
    document.querySelectorAll('#pnlModalSectionTabs [data-pnl-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.pnlTab === pnlModalTab);
    });
    $('pnlTabOverview')?.classList.toggle('active', pnlModalTab === 'overview');
    $('pnlTabDetail')?.classList.toggle('active', pnlModalTab === 'detail');
    $('pnlTabSymbols')?.classList.toggle('active', pnlModalTab === 'symbols');

    // 4. Overview: Daily Calendar / Chart + Monthly Tiles
    const m = cal.month;
    const y = cal.year;
    const mTitleEl = $('pnlModalMonthTitle');
    if (mTitleEl) mTitleEl.textContent = `${m.year}-${String(m.month).padStart(2, '0')}`;

    document.querySelectorAll('#pnlDailyModeToggle [data-pnl-display]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.pnlDisplay === pnlDailyDisplay);
    });
    const calWrap = $('pnlModalCalendarWrap');
    const chartWrap = $('pnlModalDailyChart');
    if (calWrap) calWrap.classList.toggle('hidden', pnlDailyDisplay !== 'calendar');
    if (chartWrap) chartWrap.classList.toggle('hidden', pnlDailyDisplay !== 'chart');

    const daysGridEl = $('pnlModalDaysGrid');
    if (daysGridEl && pnlDailyDisplay === 'calendar') {
      const empties = Array.from({ length: m.firstWeekdaySun ?? m.firstWeekday }, () => '<div class="pnl-cell empty"></div>').join('');
      const dayCells = m.days.map((d) => {
        const cls = [
          'pnl-cell',
          'clean',
          pnlStatusClass(d.status),
          d.isToday ? 'is-today' : '',
          d.isFuture ? 'is-future' : '',
          d.dateKey === selectedKey ? 'is-selected' : ''
        ].filter(Boolean).join(' ');
        const hasVal = d.trades > 0 || (d.isToday && Math.abs(d.totalPnl) >= 0.005);
        const valTxt = hasVal ? mask(fmtCompactSignedNoDollar(d.totalPnl)) : '';
        return `
          <button type="button" class="${cls}" data-pnl-day="${d.dateKey}">
            <span class="pcell-day">${d.day}</span>
            ${valTxt ? `<span class="pcell-val ${pnlTextClass(d.totalPnl, d.status)}">${valTxt}</span>` : ''}
          </button>`;
      }).join('');
      daysGridEl.innerHTML = `${empties}${dayCells}`;
    }

    if (chartWrap && pnlDailyDisplay === 'chart') {
      const maxAbs = Math.max(1, ...m.days.map((d) => Math.abs(d.totalPnl)));
      chartWrap.innerHTML = `
        <div class="pnl-bc-bars">
          ${m.days.map((d) => {
            const pctH = Math.min(100, Math.round((Math.abs(d.totalPnl) / maxAbs) * 100));
            const isPos = d.totalPnl >= 0;
            const hasVal = d.trades > 0 || (d.isToday && Math.abs(d.totalPnl) >= 0.005);
            const barStyle = hasVal ? `height:${Math.max(8, pctH)}%` : 'height:2px;opacity:0.25';
            const cls = hasVal ? (isPos ? 'pos-bar' : 'neg-bar') : 'flat-bar';
            return `
              <button type="button" class="pnl-bc-col${d.dateKey === selectedKey ? ' is-selected' : ''}" data-pnl-day="${d.dateKey}" title="${formatDateKeyVN(d.dateKey)}: ${fmtSignedUsdLabel(d.totalPnl)}">
                <div class="pnl-bc-slot">
                  <div class="pnl-bc-fill ${cls}" style="${barStyle}"></div>
                </div>
                <span class="pnl-bc-day">${d.day}</span>
              </button>`;
          }).join('')}
        </div>`;
    }

    const detailEl = $('pnlSelectedDayDetail');
    if (detailEl) {
      const selObj = m.days.find((d) => d.dateKey === selectedKey) || m.days.find((d) => d.isToday) || m.days[0];
      if (selObj) {
        const stTxt = selObj.status === 'NONE' ? 'Chưa giao dịch' : formatPnlStatus(selObj.status);
        const vCls = pnlTextClass(selObj.totalPnl, selObj.status);
        detailEl.innerHTML = `
          <span><strong>${formatDateKeyVN(selObj.dateKey)}</strong>${selObj.isToday ? ' <span class="cyan">(Hôm nay)</span>' : ''}</span>
          <span class="${vCls}"><strong>${stTxt} ${mask(fmtSignedUsdLabel(selObj.totalPnl))}</strong></span>
          <span class="muted">Đã chốt: ${mask(fmtSignedUsd(selObj.realizedPnl, 2))} • Đang chạy: ${mask(fmtSignedUsd(selObj.unrealizedPnl, 2))} • ${selObj.trades} lệnh (${selObj.wins}W/${selObj.losses}L)</span>`;
      }
    }

    const yTitleEl = $('pnlModalYearTitle');
    const yStatsEl = $('pnlModalYearStats');
    if (yTitleEl) yTitleEl.textContent = `${y.year}`;
    if (yStatsEl) {
      yStatsEl.textContent = `${y.profitMonths} tháng lời • ${y.lossMonths} tháng lỗ • Tổng ${mask(fmtSignedUsdLabel(y.totalPnl))} (${y.trades} lệnh)`;
    }

    const monthsGridEl = $('pnlModalMonthsGrid');
    if (monthsGridEl) {
      monthsGridEl.innerHTML = y.months.map((mm) => {
        const cls = [
          'pnl-month-tile',
          'clean',
          pnlStatusClass(mm.status),
          mm.isCurrentMonth ? 'is-current' : '',
          mm.isFuture ? 'is-future' : '',
          mm.month === m.month ? 'is-selected' : ''
        ].filter(Boolean).join(' ');
        const hasVal = mm.trades > 0 || (mm.isCurrentMonth && Math.abs(mm.totalPnl) >= 0.005);
        const valTxt = hasVal ? mask(fmtCompactSignedNoDollar(mm.totalPnl)) : '--';
        return `
          <button type="button" class="${cls}" data-pnl-month="${mm.month}">
            <div class="pmt-top">
              <strong>T${mm.month}</strong>
              <span class="pmt-badge">${mm.status === 'NONE' ? '--' : formatPnlStatus(mm.status)}</span>
            </div>
            <div class="pmt-val ${pnlTextClass(mm.totalPnl, mm.status)}">${valTxt}</div>
            <div class="pmt-meta">${mm.activeDays} ngày • ${mm.trades} lệnh</div>
          </button>`;
      }).join('');
    }

    // 5. Detail Tab Table
    const detailBody = $('pnlDetailBody');
    if (detailBody && pnlModalTab === 'detail') {
      if (!analytics.dailyEntries.length) {
        detailBody.innerHTML = '<tr class="empty-row"><td colspan="5">Chưa có dữ liệu lời/lỗ được ghi nhận.</td></tr>';
      } else {
        detailBody.innerHTML = analytics.dailyEntries.slice(0, 60).map((row) => {
          const cls = row.totalPnl > 0.005 ? 'pos' : (row.totalPnl < -0.005 ? 'neg' : 'muted');
          return `
            <tr>
              <td><strong>${formatDateKeyVN(row.dateKey)}</strong></td>
              <td>${row.trades}</td>
              <td><span class="pos">${row.wins}</span> / <span class="neg">${row.losses}</span></td>
              <td class="muted">-${mask(row.feeUsd.toFixed(2))}</td>
              <td class="${cls}"><strong>${mask(fmtSignedUsdLabel(row.totalPnl))}</strong></td>
            </tr>`;
        }).join('');
      }
    }

    // 6. Per-Symbol Analysis Tab
    const symList = $('pnlSymbolsList');
    if (symList && pnlModalTab === 'symbols') {
      if (!analytics.bySymbol.length) {
        symList.innerHTML = '<div class="muted" style="text-align:center;padding:18px;">Chưa có dữ liệu giao dịch theo từng mã.</div>';
      } else {
        const maxSymAbs = Math.max(1, ...analytics.bySymbol.map((s) => Math.abs(s.totalPnl)));
        symList.innerHTML = analytics.bySymbol.map((s) => {
          const cls = s.totalPnl > 0.005 ? 'pos' : (s.totalPnl < -0.005 ? 'neg' : 'muted');
          const barW = Math.min(100, Math.round((Math.abs(s.totalPnl) / maxSymAbs) * 100));
          return `
            <div class="pnl-sym-row">
              <div class="psr-top">
                <strong>${s.symbol}</strong>
                <span class="${cls}"><strong>${mask(fmtSignedUsdLabel(s.totalPnl))}</strong></span>
              </div>
              <div class="pnl-sym-bar-bg">
                <div class="pnl-sym-bar-fill ${s.totalPnl >= 0 ? 'pos' : 'neg'}" style="width:${Math.max(4, barW)}%"></div>
              </div>
              <div class="psr-bot muted">
                <span>${s.trades} lệnh • WR ${s.winRate.toFixed(0)}% (${s.wins}W/${s.losses}L)</span>
                <span>Phí: -${mask(s.feeUsd.toFixed(2))} USD</span>
              </div>
            </div>`;
        }).join('');
      }
    }
  }

  function openPnlCalendarModal(focus = 'month') {
    const modalEl = $('pnlCalendarModal');
    if (!modalEl || typeof trading.getPnlCalendarReport !== 'function') return;
    if (!pnlSelectedDateKey) {
      const now = new Date();
      pnlSelectedDateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    }
    const report = trading.getPnlCalendarReport({ year: pnlViewYear, month: pnlViewMonth });
    modalEl.classList.remove('hidden');
    renderPnlModal(report, true);
    motion.animateModalOpen(modalEl.querySelector('.modal-card'));

    const targetMap = {
      today: $('pnlModalHeroSection'),
      month: $('pnlModalMonthSection'),
      year: $('pnlModalYearSection')
    };
    const sec = targetMap[focus];
    if (sec && typeof sec.scrollIntoView === 'function') {
      setTimeout(() => sec.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 60);
    }
  }

  function closePnlCalendarModal() {
    $('pnlCalendarModal')?.classList.add('hidden');
  }

  function switchBlotterTab(tabKey) {
    activeBlotterTab = tabKey;
    document.querySelectorAll('.btab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabKey));
    const map = { positions: 'panePositions', orders: 'paneOrders', arb: 'paneArb', history: 'paneHistory', pnl: 'panePnl', logs: 'paneLogs' };
    Object.entries(map).forEach(([k, paneId]) => {
      const pane = $(paneId);
      if (pane) pane.classList.toggle('active', k === tabKey);
    });
    if (tabKey === 'pnl' && typeof trading.getPnlCalendarReport === 'function') {
      renderPnlBlotter(trading.getPnlCalendarReport({ year: pnlViewYear, month: pnlViewMonth }), true);
    } else {
      renderActiveBlotterTab(true);
    }
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
    if (typeof market.clearLiveVenueFeeRates === 'function') market.clearLiveVenueFeeRates();
    trading.setLiveExecutionAdapter(null);
    trading.revokeLiveSessions();
    updateVenueFeeBadge();
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
        const [chRes, spotRes, feeRes] = await Promise.all([
          fetch(apiUrl, { method: 'POST', headers, body: JSON.stringify({ type: 'clearinghouseState', user: targetAddr }) }),
          fetch(apiUrl, { method: 'POST', headers, body: JSON.stringify({ type: 'spotClearinghouseState', user: targetAddr }) }),
          fetch(apiUrl, { method: 'POST', headers, body: JSON.stringify({ type: 'userFees', user: targetAddr }) }).catch(() => null)
        ]);
        if (!chRes.ok) {
          const err = `Hyperliquid API trả lỗi HTTP ${chRes.status}`;
          $('hlConnStatus').innerHTML = `Trạng thái: <span class="neg">${err}</span>`;
          if (balEl) { balEl.className = 'neg'; balEl.textContent = err; }
          return { ok: false, error: err };
        }
        const ch = await chRes.json();
        const spot = spotRes.ok ? await spotRes.json() : {};
        let feeRates = { makerBps: 1.5, takerBps: 4.5, source: 'OFFICIAL_TIER0' };
        if (feeRes && feeRes.ok) {
          try {
            const uf = await feeRes.json();
            const addR = parseFloat(uf?.userAddRate);
            const crossR = parseFloat(uf?.userCrossRate);
            if (Number.isFinite(addR) && Number.isFinite(crossR) && addR >= 0 && crossR >= 0) {
              feeRates = {
                makerBps: Number((addR * 10000).toFixed(4)),
                takerBps: Number((crossR * 10000).toFixed(4)),
                source: 'LIVE_API'
              };
            }
          } catch (_) {}
        }
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
          spotUsdc: Number(spotUsdc.toFixed(4)),
          feeRates
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
      if (res.feeRates && typeof market.setLiveVenueFeeRates === 'function') {
        market.setLiveVenueFeeRates(res.venue, res.feeRates.makerBps, res.feeRates.takerBps, res.feeRates.source);
      }
      trading.syncLiveAccountBalance(res);
      syncAutoSize();
      updateSLTPPreview();
      updateVenueFeeBadge();
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
    if (!currentAuthUser) {
      openAuthGate('Tài khoản cần đăng nhập Gmail trước khi mở Trung Tâm Kết Nối Đa Sàn.');
      return;
    }
    syncApiModalAccess();
    $('apiModal').classList.remove('hidden');
    motion.animateModalOpen($('apiModal').querySelector('.modal-card'));
  }

  /* ==================== GMAIL OTP AUTH, 3-DEVICE TAKEOVER & ADMIN KEY CLIENT ==================== */
  const AUTH_DB_KEY = 'qc_auth_db_v1';
  const AUTH_SESSION_KEY = 'qc_auth_session_v1';
  const DEVICE_ID_KEY = 'qc_device_id_v1';
  const AuthMod = window.QuantumAccountAuth;
  const localAuthEngine = AuthMod ? new AuthMod() : null;
  const authBroadcast = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('qc_auth_sync') : null;

  let authBackendMode = 'LOCAL'; // 'REMOTE' | 'LOCAL'
  let authRemoteStatus = { mailServerConnected: false, multiDeviceDb: 'LOCAL' };
  let currentAuthSession = null; // { email, sessionToken, deviceId }
  let currentAuthUser = null;
  let activeAuthCaptchaId = null;
  let activeRegOtpChallengeId = null;
  let pendingConflictAction = null;
  let selectedHubVenue = 'BINANCE';

  function getOrCreateDeviceIdentity() {
    let devId = null;
    try { devId = localStorage.getItem(DEVICE_ID_KEY); } catch (_) {}
    if (!devId) {
      devId = AuthMod ? AuthMod.generateDeviceId() : `dev_${Math.random().toString(36).slice(2, 12)}`;
      try { localStorage.setItem(DEVICE_ID_KEY, devId); } catch (_) {}
    }
    const devLabel = AuthMod ? AuthMod.detectDeviceLabel() : '🌐 Thiết bị Web';
    return { deviceId: devId, deviceLabel: devLabel };
  }
  const currentDevice = getOrCreateDeviceIdentity();

  function loadLocalAuthDb() {
    if (!localAuthEngine) return;
    try {
      const raw = localStorage.getItem(AUTH_DB_KEY);
      if (raw) localAuthEngine.importDb(JSON.parse(raw));
    } catch (_) {}
  }

  function saveLocalAuthDb() {
    if (!localAuthEngine) return;
    try {
      localStorage.setItem(AUTH_DB_KEY, JSON.stringify(localAuthEngine.exportDb()));
      if (authBroadcast) authBroadcast.postMessage({ type: 'AUTH_DB_UPDATED', deviceId: currentDevice.deviceId });
    } catch (_) {}
  }

  function saveAuthSessionLocal(sess) {
    currentAuthSession = sess;
    try {
      if (sess) localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(sess));
      else localStorage.removeItem(AUTH_SESSION_KEY);
    } catch (_) {}
  }

  async function callAuthApi(action, payload = {}) {
    if (authBackendMode === 'REMOTE') {
      try {
        const res = await fetch('/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, ...payload })
        });
        const json = await res.json().catch(() => ({ ok: false, error: `Auth HTTP ${res.status}` }));
        return json;
      } catch (err) {
        return { ok: false, error: err?.message || 'Lỗi kết nối Auth Server.' };
      }
    }

    loadLocalAuthDb();
    let out = { ok: false, error: 'Auth engine unavailable' };
    if (!localAuthEngine) return out;

    if (action === 'captcha') {
      out = localAuthEngine.createMathCaptcha();
    } else if (action === 'register_otp') {
      out = await localAuthEngine.requestRegisterOtp(payload);
    } else if (action === 'verify_register') {
      out = await localAuthEngine.verifyRegisterAndActivate(payload);
    } else if (action === 'login') {
      out = await localAuthEngine.login(payload);
    } else if (action === 'session_check') {
      out = await localAuthEngine.validateSession(payload);
    } else if (action === 'logout') {
      out = await localAuthEngine.logout(payload);
    } else if (action === 'activate_live') {
      out = await localAuthEngine.activateLiveKey(payload);
    } else if (action === 'admin_issue_key') {
      out = await localAuthEngine.issueLiveActivationKey(payload);
    } else if (action === 'admin_list_keys') {
      out = await localAuthEngine.listAdminKeys(payload);
    } else if (action === 'admin_revoke_key') {
      out = await localAuthEngine.revokeLiveKey(payload);
    } else if (action === 'device_revoke') {
      out = await localAuthEngine.revokeDevice(payload);
    }
    saveLocalAuthDb();
    return out;
  }

  function showAuthError(msg) {
    const el = $('authErrorMsg');
    if (!el) return;
    if (!msg) {
      el.classList.add('hidden');
      el.textContent = '';
    } else {
      el.textContent = msg;
      el.classList.remove('hidden');
    }
  }

  async function refreshAuthCaptcha() {
    const res = await callAuthApi('captcha');
    if (res && res.ok) {
      activeAuthCaptchaId = res.captchaId;
      const box = $('authCaptchaExpr');
      if (box) box.textContent = res.expression;
      const inp = $('authCaptchaAns');
      if (inp) inp.value = '';
    }
  }

  function switchAuthTab(tabName) {
    const isReg = tabName !== 'login';
    $('authTabRegister')?.classList.toggle('active', isReg);
    $('authTabLogin')?.classList.toggle('active', !isReg);
    $('authRegPane')?.classList.toggle('active', isReg);
    $('authLoginPane')?.classList.toggle('active', !isReg);
    $('authConflictBox')?.classList.add('hidden');
    pendingConflictAction = null;
    showAuthError('');
  }

  function updateAccountTopbarUI() {
    const badge = $('accountRoleBadge');
    const lbl = $('accountEmailLabel');
    if (!badge || !lbl) return;
    if (!currentAuthUser) {
      badge.textContent = 'AUTH';
      badge.className = 'acc-role-dot';
      lbl.textContent = 'Đăng nhập';
      return;
    }
    const shortName = currentAuthUser.email.split('@')[0];
    lbl.textContent = shortName;
    if (currentAuthUser.isAdmin) {
      badge.textContent = 'ADMIN';
      badge.className = 'acc-role-dot admin';
    } else if (currentAuthUser.liveActivated) {
      badge.textContent = 'LIVE';
      badge.className = 'acc-role-dot live';
    } else {
      badge.textContent = 'DEMO';
      badge.className = 'acc-role-dot';
    }
  }

  function openAuthGate(errorBanner = '') {
    $('authDeviceLabel').textContent = currentDevice.deviceLabel;
    $('authDeviceId').textContent = `ID: ${currentDevice.deviceId.slice(0, 11)}...`;
    $('authConflictBox')?.classList.add('hidden');
    pendingConflictAction = null;
    showAuthError(errorBanner);
    $('authGateOverlay')?.classList.remove('hidden');
    refreshAuthCaptcha();
  }

  function completeAuthUnlock(authRes) {
    currentAuthUser = authRes.user;
    saveAuthSessionLocal({
      email: authRes.user.email,
      sessionToken: authRes.sessionToken,
      deviceId: authRes.deviceId || currentDevice.deviceId
    });
    $('authGateOverlay')?.classList.add('hidden');
    $('authConflictBox')?.classList.add('hidden');
    pendingConflictAction = null;
    showAuthError('');
    if ($('otpEmail')) $('otpEmail').value = currentAuthUser.email;
    updateAccountTopbarUI();
    syncApiModalAccess();
    showToast({
      type: currentAuthUser.liveActivated ? 'pos' : 'cyan',
      title: authRes.tookOver ? '✅ ĐÃ THOÁT THIẾT BỊ KIA & VÀO NGAY' : '✅ XÁC THỰC GMAIL THÀNH CÔNG',
      msg: `${currentAuthUser.email} • ${currentAuthUser.accountTierLabel} (${currentAuthUser.deviceCount}/3 thiết bị)`
    });
  }

  async function executeAuthWithConflictHandling(action, payload) {
    showAuthError('');
    const res = await callAuthApi(action, {
      ...payload,
      deviceId: currentDevice.deviceId,
      deviceLabel: currentDevice.deviceLabel
    });

    if (res.ok) {
      completeAuthUnlock(res);
      return res;
    }

    if (res.code === 'ACTIVE_SESSION_CONFLICT') {
      pendingConflictAction = { action, payload };
      const actDev = res.activeDevice;
      $('authConflictMsg').textContent =
        `Tài khoản đang hoạt động trên "${actDev?.deviceLabel || 'Thiết bị khác'}" (${actDev?.deviceId || ''}). Bạn có chắc chắn muốn thoát ở thiết bị kia để đăng nhập vào thiết bị này không?`;
      $('authConflictBox').classList.remove('hidden');
      motion.wiggleReject($('authConflictBox'));
      return res;
    }

    showAuthError(res.error || 'Đăng nhập thất bại.');
    if (action === 'register_otp' || res.code === 'INVALID_CAPTCHA') refreshAuthCaptcha();
    return res;
  }

  function renderHubVenues() {
    const grid = $('hubVenueCards');
    if (!grid) return;
    const isLiveLinked = Boolean(trading.mode === 'LIVE' && trading.liveConfig.connected);
    const venues = [
      { id: 'HYPERLIQUID', name: 'Hyperliquid', dot: '#34d399', mtab: 'hyperliquid' },
      { id: 'BINANCE', name: 'Binance', dot: '#fbbf24', mtab: 'cex' },
      { id: 'BYBIT', name: 'Bybit', dot: '#fb923c', mtab: 'cex' },
      { id: 'OKX', name: 'OKX', dot: '#60a5fa', mtab: 'cex' },
      { id: 'DERIBIT', name: 'Deribit', dot: '#c084fc', mtab: 'cex' }
    ];
    grid.innerHTML = venues.map((v) => {
      const linkedHere = isLiveLinked && trading.liveConfig.venueId === v.id;
      const isSelected = selectedHubVenue === v.id;
      return `
        <button type="button" class="hub-venue-chip${isSelected ? ' active' : ''}" data-hvenue="${v.id}" data-hmtab="${v.mtab}">
          <div class="hvc-top"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${v.dot};"></span>${v.name}</div>
          <div class="hvc-status ${linkedHere ? 'pos' : ''}">${linkedHere ? '● Đã liên kết' : '○ Chưa liên kết'}</div>
        </button>`;
    }).join('');

    const execLbl = $('hubExecVenueLabel');
    if (execLbl) {
      execLbl.textContent = market.activeExchange === 'ALL'
        ? '🌐 Đa sàn (5 sàn đồng thời)'
        : `🟡 ${market.activeExchange}`;
    }
  }

  function syncApiModalAccess() {
    renderHubVenues();
    const isLiveCapable = Boolean(currentAuthUser && currentAuthUser.liveActivated);
    const lockCard = $('demoLiveLockCard');
    const unlockedWrap = $('liveBridgeUnlockedWrap');
    const demoEmailSpan = $('demoLockEmailSpan');
    const adminBtn = $('btnOpenAdminFromApi');
    if (demoEmailSpan) demoEmailSpan.textContent = currentAuthUser ? currentAuthUser.email : 'Chưa đăng nhập';
    if (lockCard) lockCard.classList.toggle('hidden', isLiveCapable);
    if (unlockedWrap) unlockedWrap.classList.toggle('hidden', !isLiveCapable);
    if (adminBtn) adminBtn.classList.toggle('hidden', !Boolean(currentAuthUser && currentAuthUser.isAdmin));
    if (currentAuthUser && $('otpEmail')) $('otpEmail').value = currentAuthUser.email;
    const saveBtn = $('btnSaveLiveConn');
    if (saveBtn) saveBtn.disabled = !isLiveCapable || !verified2faSession;
  }

  async function renderAccountModal() {
    if (!currentAuthUser) return;
    $('accEmailDisplay').textContent = currentAuthUser.email;
    const tierEl = $('accTierBadge');
    tierEl.textContent = currentAuthUser.accountTierLabel;
    tierEl.className = `acc-tier-pill${currentAuthUser.liveActivated ? ' live' : ''}`;
    $('accountDeviceCount').textContent = `${currentAuthUser.deviceCount}/${currentAuthUser.maxDevices}`;

    const devList = $('accountDevicesList');
    devList.innerHTML = (currentAuthUser.devices || []).map((d) => {
      const isCur = d.deviceId === currentDevice.deviceId;
      return `
        <div class="acc-dev-row">
          <div>
            <strong>${d.deviceLabel}</strong> ${isCur ? '<span class="cyan">(Thiết bị này)</span>' : ''}
            <div class="muted" style="font-size:8.5px;">${d.deviceId} • ${d.active ? '<span class="pos">Đang hoạt động</span>' : 'Tạm ngưng'}</div>
          </div>
          ${!isCur ? `<button type="button" class="btn btn-xs btn-danger-outline" data-kick-dev="${d.deviceId}">Thoát thiết bị</button>` : '<span class="pos" style="font-size:9px;">● ACTIVE</span>'}
        </div>`;
    }).join('');

    const adminPanel = $('adminKeyPanel');
    if (currentAuthUser.isAdmin) {
      adminPanel.classList.remove('hidden');
      const keysRes = await callAuthApi('admin_list_keys', {
        adminEmail: currentAuthSession.email,
        adminSessionToken: currentAuthSession.sessionToken,
        adminDeviceId: currentDevice.deviceId
      });
      if (keysRes.ok) {
        const listEl = $('admKeysList');
        if (!keysRes.keys || keysRes.keys.length === 0) {
          listEl.innerHTML = '<div class="muted" style="font-size:9.5px;">Chưa cấp mã LIVE nào — nhập Gmail (hoặc để trống) rồi bấm "Tạo Mã LIVE".</div>';
        } else {
          listEl.innerHTML = keysRes.keys.slice(0, 10).map((k) => {
            const stTxt = k.revoked ? '<span class="neg">Đã thu hồi</span>' : (k.usedBy ? `<span class="pos">Đã kích hoạt (${k.usedBy})</span>` : '<span class="gold">Chưa dùng</span>');
            return `
              <div class="adm-key-row">
                <div>
                  <strong>${k.keyHint}</strong> • <span class="muted">${k.targetEmail === '*' ? 'Mọi Gmail' : k.targetEmail}</span>
                  <div>${stTxt}</div>
                </div>
                ${(!k.usedBy && !k.revoked) ? `<button type="button" class="btn btn-xs btn-danger-outline" data-rev-key="${k.id}">Thu hồi</button>` : ''}
              </div>`;
          }).join('');
        }
      }
    } else {
      adminPanel.classList.add('hidden');
    }
  }

  async function openAccountModal() {
    if (!currentAuthUser) {
      openAuthGate();
      return;
    }
    await renderAccountModal();
    $('accountModal').classList.remove('hidden');
    motion.animateModalOpen($('accountModal').querySelector('.modal-card'));
  }

  async function checkSessionHeartbeat() {
    if (!currentAuthSession || !currentAuthUser) return;
    const res = await callAuthApi('session_check', {
      email: currentAuthSession.email,
      sessionToken: currentAuthSession.sessionToken,
      deviceId: currentDevice.deviceId
    });
    if (res.ok && res.user) {
      currentAuthUser = res.user;
      updateAccountTopbarUI();
      return;
    }
    if (res.code === 'SESSION_KICKED' || res.code === 'SESSION_EXPIRED' || res.code === 'SESSION_INVALID') {
      if (trading.botRunning) trading.toggleBot();
      if (trading.mode === 'LIVE') {
        liveSessionCredentials = null;
        trading.setLiveExecutionAdapter(null);
        trading.revokeLiveSessions();
      }
      saveAuthSessionLocal(null);
      currentAuthUser = null;
      updateAccountTopbarUI();
      $('apiModal')?.classList.add('hidden');
      $('accountModal')?.classList.add('hidden');
      openAuthGate(res.error || 'Tài khoản đã đăng nhập trên thiết bị khác và tự động thoát ở đây.');
      showToast({
        type: 'neg',
        title: '⚠ ĐÃ ĐĂNG XUẤT TỰ ĐỘNG',
        msg: res.error || 'Tài khoản vừa đăng nhập ở thiết bị khác.'
      });
    }
  }

  async function initAccountAuthGate() {
    try {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 1800) : null;
      const r = await fetch('/api/auth?action=status', ctrl ? { signal: ctrl.signal } : undefined);
      if (timer) clearTimeout(timer);
      if (r.ok) {
        const j = await r.json();
        if (j && j.ok) {
          authBackendMode = 'REMOTE';
          authRemoteStatus = j;
        }
      }
    } catch (_) {
      authBackendMode = 'LOCAL';
    }

    const dotEl = $('authMailDot');
    const txtEl = $('authMailStatusText');
    if (txtEl) {
      if (authBackendMode === 'REMOTE' && authRemoteStatus.mailServerConnected) {
        txtEl.textContent = 'Đã kết nối Mail Server (Resend Gmail OTP)';
        if (dotEl) dotEl.className = 'status-dot live';
      } else if (authBackendMode === 'REMOTE') {
        txtEl.textContent = 'Auth Server Online (Sandbox OTP Preview — thêm RESEND_API_KEY để gửi Gmail thật)';
        if (dotEl) dotEl.className = 'status-dot live';
      } else {
        txtEl.textContent = 'Chế độ Xác thực Cục bộ (Đồng bộ đa tab • Deploy Vercel để đồng bộ đa thiết bị)';
        if (dotEl) dotEl.className = 'status-dot live';
      }
    }

    try {
      const savedRaw = localStorage.getItem(AUTH_SESSION_KEY);
      if (savedRaw) {
        const saved = JSON.parse(savedRaw);
        if (saved && saved.email && saved.sessionToken) {
          const check = await callAuthApi('session_check', {
            email: saved.email,
            sessionToken: saved.sessionToken,
            deviceId: currentDevice.deviceId
          });
          if (check.ok && check.user) {
            currentAuthSession = { email: saved.email, sessionToken: saved.sessionToken, deviceId: currentDevice.deviceId };
            currentAuthUser = check.user;
            $('authGateOverlay')?.classList.add('hidden');
            updateAccountTopbarUI();
            syncApiModalAccess();
            return;
          }
          saveAuthSessionLocal(null);
          openAuthGate(check.error || 'Phiên trước đã hết hạn hoặc bị đăng xuất từ thiết bị khác.');
          return;
        }
      }
    } catch (_) {}

    updateAccountTopbarUI();
    openAuthGate();
  }

  function bindAllEvents() {
    $('instrumentSelector').addEventListener('click', (e) => {
      const btn = e.target.closest('.inst-btn');
      if (btn) {
        if (botReturnBtcTimer) { clearTimeout(botReturnBtcTimer); botReturnBtcTimer = null; }
        botAutoSwitchedChart = false;
        userManualChartUntil = btn.dataset.symbol === 'BTC-PERP' ? 0 : (Date.now() + 12000);
        selectSymbol(btn.dataset.symbol);
      }
    });

    $('exchangePills').addEventListener('click', (e) => {
      const pill = e.target.closest('.ex-pill');
      if (pill) selectExchange(pill.dataset.exchange);
    });

    $('tfGroup').addEventListener('click', (e) => {
      const btn = e.target.closest('.tf-btn');
      if (!btn) return;
      selectTimeframeUi(btn.dataset.tf, true);
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
    const chkBnbFee = $('chkBnbFeeDiscount');
    if (chkBnbFee) {
      chkBnbFee.addEventListener('change', (e) => {
        if (typeof market.setBinanceBnbDiscount === 'function') {
          market.setBinanceBnbDiscount(e.target.checked);
        }
        syncAutoSize();
        updateSLTPPreview();
        updateVenueFeeBadge();
        savePersistedState(true);
      });
    }
    $('chkAutoBE').addEventListener('change', (e) => {
      trading.riskShield.autoBreakeven = e.target.checked;
      trading.riskShield.autoTrailing = e.target.checked;
      savePersistedState(true);
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
        return;
      }
      const pnlMod = $('pnlCalendarModal');
      if (pnlMod && !pnlMod.classList.contains('hidden') && e.key === 'Escape') {
        e.preventDefault();
        closePnlCalendarModal();
      }
    });

    const refreshPnlViews = () => {
      if (typeof trading.getPnlCalendarReport !== 'function') return;
      const rep = trading.getPnlCalendarReport({ year: pnlViewYear, month: pnlViewMonth });
      updateKpiPeriodStrip(rep);
      renderPnlBlotter(rep, true);
      renderPnlModal(rep, true);
    };

    $('kpiPeriodPnl')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pnl-focus]');
      if (btn) openPnlCalendarModal(btn.dataset.pnlFocus);
    });
    $('btnOpenPnlModalFromBlotter')?.addEventListener('click', () => {
      openPnlCalendarModal(pnlBlotterView === 'year' ? 'year' : 'month');
    });
    $('pnlBlotterSubviewGroup')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pnl-subview]');
      if (!btn) return;
      pnlBlotterView = btn.dataset.pnlSubview === 'year' ? 'year' : 'month';
      refreshPnlViews();
    });
    $('btnBlPnlPrev')?.addEventListener('click', () => {
      if (pnlBlotterView === 'year') pnlViewYear -= 1;
      else stepPnlMonth(-1);
      refreshPnlViews();
    });
    $('btnBlPnlNext')?.addEventListener('click', () => {
      if (pnlBlotterView === 'year') pnlViewYear += 1;
      else stepPnlMonth(1);
      refreshPnlViews();
    });
    $('btnBlPnlToday')?.addEventListener('click', () => {
      jumpPnlToToday();
      refreshPnlViews();
    });
    $('pnlBlotterGrid')?.addEventListener('click', (e) => {
      const dayBtn = e.target.closest('[data-pnl-day]');
      if (dayBtn) {
        pnlSelectedDateKey = dayBtn.dataset.pnlDay;
        openPnlCalendarModal('month');
        return;
      }
      const mBtn = e.target.closest('[data-pnl-month]');
      if (mBtn) {
        pnlViewMonth = parseInt(mBtn.dataset.pnlMonth, 10) || pnlViewMonth;
        pnlSelectedDateKey = `${pnlViewYear}-${String(pnlViewMonth).padStart(2, '0')}-01`;
        pnlBlotterView = 'month';
        refreshPnlViews();
      }
    });

    $('btnClosePnlModal')?.addEventListener('click', closePnlCalendarModal);
    $('pnlCalendarModal')?.addEventListener('click', (e) => {
      if (e.target === $('pnlCalendarModal')) closePnlCalendarModal();
    });
    $('btnPnlMonthPrev')?.addEventListener('click', () => { stepPnlMonth(-1); refreshPnlViews(); });
    $('btnPnlMonthNext')?.addEventListener('click', () => { stepPnlMonth(1); refreshPnlViews(); });
    $('btnPnlJumpToday')?.addEventListener('click', () => { jumpPnlToToday(); refreshPnlViews(); });
    $('btnPnlYearPrev')?.addEventListener('click', () => {
      pnlViewYear -= 1;
      pnlSelectedDateKey = `${pnlViewYear}-${String(pnlViewMonth).padStart(2, '0')}-01`;
      refreshPnlViews();
    });
    $('btnPnlYearNext')?.addEventListener('click', () => {
      pnlViewYear += 1;
      pnlSelectedDateKey = `${pnlViewYear}-${String(pnlViewMonth).padStart(2, '0')}-01`;
      refreshPnlViews();
    });
    $('pnlModalDaysGrid')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pnl-day]');
      if (!btn) return;
      pnlSelectedDateKey = btn.dataset.pnlDay;
      refreshPnlViews();
    });
    $('pnlModalDailyChart')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pnl-day]');
      if (!btn) return;
      pnlSelectedDateKey = btn.dataset.pnlDay;
      refreshPnlViews();
    });
    $('btnTogglePnlPrivacy')?.addEventListener('click', () => {
      pnlHideAmounts = !pnlHideAmounts;
      refreshPnlViews();
    });
    $('pnlRangeGroup')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pnl-range]');
      if (!btn) return;
      pnlRangeKey = btn.dataset.pnlRange || '7d';
      refreshPnlViews();
    });
    $('btnTogglePnlExtra')?.addEventListener('click', () => {
      pnlExtraExpanded = !pnlExtraExpanded;
      refreshPnlViews();
    });
    $('pnlModalSectionTabs')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pnl-tab]');
      if (!btn) return;
      pnlModalTab = btn.dataset.pnlTab || 'overview';
      refreshPnlViews();
    });
    $('pnlDailyModeToggle')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pnl-display]');
      if (!btn) return;
      pnlDailyDisplay = btn.dataset.pnlDisplay === 'chart' ? 'chart' : 'calendar';
      refreshPnlViews();
    });
    $('pnlModalMonthsGrid')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pnl-month]');
      if (!btn) return;
      const targetM = parseInt(btn.dataset.pnlMonth, 10);
      if (!targetM) return;
      pnlViewMonth = targetM;
      const rep = trading.getPnlCalendarReport({ year: pnlViewYear, month: pnlViewMonth });
      const activeDay = rep.month.days.find((d) => d.isToday) || rep.month.days.find((d) => d.trades > 0) || rep.month.days[0];
      pnlSelectedDateKey = activeDay ? activeDay.dateKey : `${pnlViewYear}-${String(pnlViewMonth).padStart(2, '0')}-01`;
      updateKpiPeriodStrip(rep);
      renderPnlBlotter(rep, true);
      renderPnlModal(rep, true);
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
      savePersistedState(true);
    };

    const riskModeGroup = $('riskModeGroup');
    if (riskModeGroup) {
      riskModeGroup.addEventListener('click', (e) => {
        const btn = e.target.closest('.rmode-btn');
        if (!btn) return;
        applyRiskMode(btn.dataset.rmode);
      });
    }

    const highRiskLevRow = $('highRiskLevRow');
    if (highRiskLevRow) {
      highRiskLevRow.addEventListener('click', (e) => {
        const btn = e.target.closest('.hrlev-btn');
        if (!btn) return;
        const lev = Math.max(10, parseInt(btn.dataset.hrlev, 10) || 10);
        const plan = trading.setHighRiskLeverage(lev);
        const levEl = $('selLeverage');
        if (levEl) {
          const optExists = Array.from(levEl.options).some((o) => Number(o.value) === lev);
          if (optExists) levEl.value = String(lev);
        }
        syncAutoSize();
        updateSLTPPreview();
        renderTradingPanels();
        savePersistedState(true);
        showToast({
          type: 'neg',
          title: `🔥 ĐÒN BẨY MẠO HIỂM: ${lev}x`,
          msg: `Size tối ưu ~$${plan.optimalSizeUsd} • Rủi ro ${plan.riskPerTradePct}% ($${plan.riskPerTradeUsd.toFixed(2)}/lệnh).`
        });
      });
    }

    const chkStrictSlTp = $('chkStrictSlTp');
    if (chkStrictSlTp) {
      chkStrictSlTp.addEventListener('change', (e) => {
        trading.setStrictSlTpOnly(e.target.checked);
        savePersistedState(true);
        showToast({
          type: e.target.checked ? 'pos' : 'gold',
          title: e.target.checked ? '🎯 GIỮ LỆNH CHUẨN TP/SL' : 'TẮT GIỮ LỆNH CHUẨN TP/SL',
          msg: e.target.checked
            ? 'Chỉ chốt khi chạm đúng TP / SL hoặc khi bạn tự bấm Đóng.'
            : 'AI được phép tự chốt đảo chiều hoặc cắt lỗ sớm.'
        });
      });
    }

    const chkDailyProfitLock = $('chkDailyProfitLock');
    if (chkDailyProfitLock) {
      chkDailyProfitLock.addEventListener('change', (e) => {
        trading.setDailyProfitLockEnabled(e.target.checked);
        savePersistedState(true);
      });
    }

    const chkMtfFilter = $('chkMtfFilter');
    if (chkMtfFilter) {
      chkMtfFilter.addEventListener('change', (e) => {
        market.mtfFilterEnabled = e.target.checked;
        savePersistedState(true);
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
        savePersistedState(true);
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

    const btnToggleForecast = $('btnToggleForecast');
    if (btnToggleForecast) {
      btnToggleForecast.addEventListener('click', () => {
        candleRenderer.showForecast = !candleRenderer.showForecast;
        btnToggleForecast.textContent = candleRenderer.showForecast ? '🔮 Dự đoán: ON' : '🔮 Dự đoán: OFF';
        btnToggleForecast.classList.toggle('btn-cyan-outline', candleRenderer.showForecast);
        btnToggleForecast.classList.toggle('btn-ghost', !candleRenderer.showForecast);
        renderChartForecastBar(market.getSymbolState());
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
      savePersistedState(true);
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

    $('btnToggleBot').addEventListener('click', () => { trading.toggleBot(); savePersistedState(true); });
    const topBotBtn = $('btnTopbarBot');
    if (topBotBtn) topBotBtn.addEventListener('click', () => { trading.toggleBot(); savePersistedState(true); });
    $('btnResetDemo').addEventListener('click', () => { trading.resetDemo(); savePersistedState(true); });

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
      const closeBtn = e.target.closest('[data-close-pos]');
      if (closeBtn) {
        trading.closePosition(closeBtn.dataset.closePos, 'MANUAL CLOSE');
        return;
      }
      const viewBtn = e.target.closest('[data-view-chart]');
      const row = e.target.closest('tr[data-view-symbol]');
      const target = viewBtn || row;
      if (target) {
        focusSymbolChart(target.dataset.viewChart || target.dataset.viewSymbol, target.dataset.viewExchange);
      }
    });
    $('tblOrders').addEventListener('click', (e) => {
      const cancelBtn = e.target.closest('[data-cancel-ord]');
      if (cancelBtn) {
        trading.cancelLimitOrder(cancelBtn.dataset.cancelOrd);
        return;
      }
      const row = e.target.closest('tr[data-view-symbol]');
      if (row) focusSymbolChart(row.dataset.viewSymbol, row.dataset.viewExchange);
    });
    $('tblHistory').addEventListener('click', (e) => {
      const row = e.target.closest('tr[data-view-symbol]');
      if (row) focusSymbolChart(row.dataset.viewSymbol, row.dataset.viewExchange);
    });
    const openPosBarEl = $('chartOpenPosBar');
    if (openPosBarEl) {
      openPosBarEl.addEventListener('click', (e) => {
        const pill = e.target.closest('[data-view-symbol]');
        if (pill) focusSymbolChart(pill.dataset.viewSymbol, pill.dataset.viewExchange);
      });
    }
    const tblArb = $('tblArb');
    if (tblArb) {
      tblArb.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-exec-arb]');
        if (btn) {
          const sym = btn.dataset.execArb;
          const opp = market.getArbitrageOpportunities().find((o) => o.symbol === sym);
          if (opp) {
            const ok = trading.executeDeltaNeutralArb(opp, 10000, 'ARB');
            if (ok) sphereRenderer.triggerPulse('#34d399');
          }
          return;
        }
        const row = e.target.closest('tr[data-view-symbol]');
        if (row) focusSymbolChart(row.dataset.viewSymbol, row.dataset.viewExchange);
      });
    }
    $('btnCloseAll').addEventListener('click', () => {
      trading.closeAll('CLOSE ALL');
      showToast({ type: 'gold', title: 'ĐÃ ĐÓNG TOÀN BỘ', msg: 'Đã đóng hết vị thế mở và hủy lệnh chờ.' });
    });

    $('btnToggleWs').addEventListener('click', () => {
      market.toggleLiveWebSocket(!market.wsEnabled);
    });

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
    const mobMiniPnl = $('mobMiniPnlWrap');
    if (mobMiniPnl) {
      mobMiniPnl.addEventListener('click', (e) => {
        e.stopPropagation();
        openPnlCalendarModal('today');
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
      if (typeof market.clearLiveVenueFeeRates === 'function') market.clearLiveVenueFeeRates();
      trading.setLiveExecutionAdapter(null);
      trading.setMode('DEMO');
      syncAutoSize();
      updateSLTPPreview();
      updateVenueFeeBadge();
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

    // Auth Gate Overlay Events (Gmail OTP + CAPTCHA + Active-Device Yes/No Takeover)
    $('authTabRegister')?.addEventListener('click', () => switchAuthTab('register'));
    $('authTabLogin')?.addEventListener('click', () => switchAuthTab('login'));
    $('btnRefreshCaptcha')?.addEventListener('click', refreshAuthCaptcha);

    $('btnSendRegOtp')?.addEventListener('click', async () => {
      showAuthError('');
      const email = $('authRegEmail').value.trim();
      const captchaAnswer = $('authCaptchaAns').value.trim();
      const res = await callAuthApi('register_otp', {
        email,
        captchaId: activeAuthCaptchaId,
        captchaAnswer,
        deviceId: currentDevice.deviceId,
        deviceLabel: currentDevice.deviceLabel
      });
      if (!res.ok) {
        showAuthError(res.error || 'Không gửi được OTP.');
        refreshAuthCaptcha();
        motion.wiggleReject($('authRegPane'));
        return;
      }
      activeRegOtpChallengeId = res.challengeId;
      $('authRegStep2')?.classList.remove('hidden');
      $('authRegOtpHint').innerHTML = res.mailSent
        ? `✉️ Đã gửi mã OTP 6 số thật tới <strong>${res.email}</strong> (hết hạn 10 phút).`
        : `🔐 Mã OTP xác thực <strong>${res.email}</strong>: <strong>${res.devPreviewOtp || '******'}</strong> (hết hạn 10 phút).`;
      showToast({
        type: 'gold',
        title: 'ĐÃ TẠO MÃ OTP GMAIL',
        msg: res.mailSent ? `Kiểm tra hộp thư ${res.email}` : `Sandbox OTP: ${res.devPreviewOtp}`
      });
    });

    $('btnConfirmRegOtp')?.addEventListener('click', async () => {
      await executeAuthWithConflictHandling('verify_register', {
        challengeId: activeRegOtpChallengeId,
        email: $('authRegEmail').value.trim(),
        otp: $('authRegOtp').value.trim(),
        password: $('authRegPassword').value
      });
    });

    $('btnSubmitLogin')?.addEventListener('click', async () => {
      await executeAuthWithConflictHandling('login', {
        email: $('authLoginEmail').value.trim(),
        password: $('authLoginPassword').value
      });
    });

    $('btnConflictNo')?.addEventListener('click', () => {
      $('authConflictBox')?.classList.add('hidden');
      pendingConflictAction = null;
      showAuthError('Đã hủy đăng nhập — giữ nguyên phiên đang chạy trên thiết bị kia.');
    });

    $('btnConflictYes')?.addEventListener('click', async () => {
      if (!pendingConflictAction) return;
      const { action, payload } = pendingConflictAction;
      await executeAuthWithConflictHandling(action, { ...payload, forceTakeover: true });
    });

    // Multi-Venue Hub + Demo Activation Key + Account/Admin Modal Events
    $('hubVenueCards')?.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-hvenue]');
      if (!chip) return;
      selectedHubVenue = chip.dataset.hvenue;
      const mtab = chip.dataset.hmtab;
      if (mtab === 'cex' && $('cexExchange')) {
        $('cexExchange').value = selectedHubVenue;
      }
      document.querySelectorAll('.mtab').forEach((b) => b.classList.toggle('active', b.dataset.mtab === mtab));
      $('mtabHyperliquid')?.classList.toggle('active', mtab === 'hyperliquid');
      $('mtabCex')?.classList.toggle('active', mtab === 'cex');
      renderHubVenues();
      updateLiveExecWarningUI();
    });

    $('btnHubSetPrimary')?.addEventListener('click', () => {
      selectExchange(selectedHubVenue);
      renderHubVenues();
      showToast({ type: 'gold', title: `SÀN CHÍNH: ${selectedHubVenue}`, msg: `Đã chọn ${selectedHubVenue} làm sàn thực thi chính.` });
    });

    $('btnHubMultiVenue')?.addEventListener('click', () => {
      selectExchange('ALL');
      renderHubVenues();
      showToast({ type: 'cyan', title: 'CHẾ ĐỘ ĐA SÀN (5 SÀN)', msg: 'Quét & đối chiếu chênh lệch 5 sàn đồng thời.' });
    });

    $('btnActivateLiveKey')?.addEventListener('click', async () => {
      const key = $('inpLiveActivationKey').value.trim();
      const msgEl = $('liveKeyStatusMsg');
      if (!currentAuthSession) {
        openAuthGate('Hãy đăng nhập Gmail trước khi kích hoạt mã LIVE.');
        return;
      }
      const res = await callAuthApi('activate_live', {
        email: currentAuthSession.email,
        sessionToken: currentAuthSession.sessionToken,
        deviceId: currentDevice.deviceId,
        activationKey: key
      });
      if (!res.ok) {
        if (msgEl) {
          msgEl.textContent = res.error || 'Kích hoạt thất bại.';
          msgEl.className = 'demo-lock-status';
        }
        motion.wiggleReject($('demoLiveLockCard'));
        return;
      }
      currentAuthUser = res.user;
      updateAccountTopbarUI();
      syncApiModalAccess();
      showToast({ type: 'pos', title: '🔓 ĐÃ MỞ KHÓA TÀI KHOẢN CHÍNH (LIVE)', msg: 'Bạn đã có quyền liên kết API sàn thật!' });
    });

    $('btnAccountMenu')?.addEventListener('click', openAccountModal);
    $('btnOpenAdminFromApi')?.addEventListener('click', openAccountModal);
    $('btnCloseAccountModal')?.addEventListener('click', () => $('accountModal').classList.add('hidden'));
    $('accountModal')?.addEventListener('click', (e) => {
      if (e.target === $('accountModal')) $('accountModal').classList.add('hidden');
    });
    $('btnOpenHubFromAccount')?.addEventListener('click', () => {
      $('accountModal').classList.add('hidden');
      openApiModal();
    });

    $('accountDevicesList')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-kick-dev]');
      if (!btn || !currentAuthSession) return;
      const res = await callAuthApi('device_revoke', {
        email: currentAuthSession.email,
        sessionToken: currentAuthSession.sessionToken,
        deviceId: currentDevice.deviceId,
        targetDeviceId: btn.dataset.kickDev
      });
      if (res.ok) {
        currentAuthUser = res.user;
        await renderAccountModal();
        showToast({ type: 'gold', title: 'ĐÃ THOÁT THIẾT BỊ', msg: `Đã gỡ thiết bị ${btn.dataset.kickDev} khỏi tài khoản.` });
      }
    });

    $('btnAdminIssueKey')?.addEventListener('click', async () => {
      if (!currentAuthSession) return;
      const targetEmail = $('admKeyTargetEmail').value.trim() || '*';
      const res = await callAuthApi('admin_issue_key', {
        adminEmail: currentAuthSession.email,
        adminSessionToken: currentAuthSession.sessionToken,
        adminDeviceId: currentDevice.deviceId,
        targetEmail
      });
      if (!res.ok) {
        showToast({ type: 'neg', title: 'LỖI CẤP MÃ LIVE', msg: res.error || 'Không có quyền Admin.' });
        return;
      }
      $('admGeneratedKeyVal').textContent = res.activationKey;
      $('admGeneratedKeyBox')?.classList.remove('hidden');
      await renderAccountModal();
      showToast({ type: 'pos', title: '🔑 ĐÃ TẠO MÃ KÍCH HOẠT LIVE', msg: res.activationKey });
    });

    $('btnCopyAdminKey')?.addEventListener('click', async () => {
      const code = $('admGeneratedKeyVal')?.textContent?.trim();
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code);
        showToast({ type: 'cyan', title: 'ĐÃ COPY MÃ', msg: code });
      } catch (_) {
        showToast({ type: 'gold', title: 'MÃ KÍCH HOẠT', msg: code });
      }
    });

    $('admKeysList')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-rev-key]');
      if (!btn || !currentAuthSession) return;
      const res = await callAuthApi('admin_revoke_key', {
        adminEmail: currentAuthSession.email,
        adminSessionToken: currentAuthSession.sessionToken,
        adminDeviceId: currentDevice.deviceId,
        keyId: btn.dataset.revKey
      });
      if (res.ok) await renderAccountModal();
    });

    $('btnLogoutAccount')?.addEventListener('click', async () => {
      if (currentAuthSession) {
        await callAuthApi('logout', {
          email: currentAuthSession.email,
          sessionToken: currentAuthSession.sessionToken,
          deviceId: currentDevice.deviceId
        });
      }
      if (trading.botRunning) trading.toggleBot();
      saveAuthSessionLocal(null);
      currentAuthUser = null;
      updateAccountTopbarUI();
      $('accountModal').classList.add('hidden');
      openAuthGate('Bạn đã đăng xuất khỏi thiết bị này.');
    });

    if (authBroadcast) {
      authBroadcast.addEventListener('message', (ev) => {
        if (ev?.data?.type === 'AUTH_DB_UPDATED' && ev.data.deviceId !== currentDevice.deviceId) {
          checkSessionHeartbeat();
        }
      });
    }
    window.addEventListener('storage', (ev) => {
      if (ev.key === AUTH_DB_KEY) checkSessionHeartbeat();
    });
    setInterval(checkSessionHeartbeat, 12000);

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
      if (!currentAuthUser || !currentAuthUser.liveActivated) {
        syncApiModalAccess();
        showToast({ type: 'neg', title: 'CẦN MÃ KÍCH HOẠT LIVE', msg: 'Tài khoản Demo chưa mở khóa LIVE. Nhập mã LIVE-XXXX-XXXX-XXXX từ Admin.' });
        return;
      }
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
      } else if (type === 'klinesUpdated' || type === 'timeframeChanged') {
        candleRenderer._forecastCache.ts = 0;
        updateMarketHUD(market.getSymbolState());
      } else if (type === 'tradePrint' && payload.print.whale) {
        sphereRenderer.triggerPulse('#fbbf24');
      }
    });

    trading.on((type, payload) => {
      if (type === 'toast') showToast(payload);
      else if (type === 'botFocus') handleBotFocusEvent(payload);
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
        savePersistedState(true);
      } else if (type === 'updated' || type === 'breakerTripped' || type === 'breakerReset') {
        renderTradingPanels();
        const curOrderSig = getPersistedOrderSignature();
        const orderChanged = curOrderSig !== lastPersistedOrderSig;
        if (orderChanged) lastPersistedOrderSig = curOrderSig;
        savePersistedState(type !== 'updated' || orderChanged);
      }
    });

    const persistOnLeave = () => savePersistedState(true);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        savePersistedState(true);
      } else if (document.visibilityState === 'visible') {
        if (typeof invalidateCanvasSizes === 'function') invalidateCanvasSizes();
        if (market.wsEnabled && typeof market._pollVenueLive === 'function') {
          market._pollVenueLive('ALL');
        }
        trading.onMarketTick();
        updateMarketHUD(market.getSymbolState());
        renderTradingPanels(true);
        cvdRenderer.render(true);
      }
    });
    window.addEventListener('pagehide', persistOnLeave);
    window.addEventListener('beforeunload', persistOnLeave);
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
        { label: '📅 Mở Thống Kê Lời / Lỗ (Hôm nay • Tháng • Năm)', category: 'CAPITAL', run: () => openPnlCalendarModal('today') },
        { label: '🔮 Khung nến 15m (Phân tích hướng Lên / Xuống)', category: 'CHART', run: () => selectTimeframeUi('15m', true) },
        { label: '🔮 Khung nến 30m (Phân tích hướng Lên / Xuống)', category: 'CHART', run: () => selectTimeframeUi('30m', true) },
        { label: '🔮 Khung nến 1h (Phân tích hướng Lên / Xuống)', category: 'CHART', run: () => selectTimeframeUi('1h', true) },
        { label: trading.botRunning ? 'Tạm dừng Bot tự động' : 'Chạy Bot tự động', category: 'BOT', run: () => trading.toggleBot() },
        { label: 'Chế độ rủi ro: 🛡 AN TOÀN (SAFE)', category: 'CAPITAL', run: () => trading.setRiskMode('SAFE') },
        { label: 'Chế độ rủi ro: ⚖️ CÂN BẰNG (BALANCED)', category: 'CAPITAL', run: () => trading.setRiskMode('BALANCED') },
        { label: 'Chế độ rủi ro: 🚀 SĂN MỤC TIÊU (AGGRESSIVE)', category: 'CAPITAL', run: () => trading.setRiskMode('AGGRESSIVE') },
        { label: 'Chế độ rủi ro: 🔥 MẠO HIỂM 10x+ (HIGH_RISK)', category: 'CAPITAL', run: () => trading.setRiskMode('HIGH_RISK') },
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
    if (!document.hidden && !isAnyBlockingModalOpen()) {
      candleRenderer.render(timeMs);
      sphereRenderer.render(timeMs);
      radarRenderer.render(timeMs);
    }
    requestAnimationFrame(animate);
  }

  // Bootstrap: Restore active Demo session/Bot state if saved, else default to $100 Demo
  let restoredSession = false;
  let parsedState = null;
  try {
    const rawState = localStorage.getItem(STORAGE_STATE_KEY);
    if (rawState) {
      parsedState = JSON.parse(rawState);
      restoredSession = trading.importState(parsedState);
    }
  } catch (_) {}

  if (!restoredSession) {
    market.timeframe = '1m';
    trading.setCapital(100);
    trading.strictSlTpOnly = true;
    trading.autoFlattenOnBreak = false;
    trading.riskShield.autoBreakeven = false;
    trading.riskShield.autoTrailing = false;
  } else if (!parsedState?.version || parsedState.version < 2) {
    // One-time v1 -> v2 migration: enforce strict TP/SL hold so Demo orders never auto-close unexpectedly
    trading.strictSlTpOnly = true;
    trading.autoFlattenOnBreak = false;
    trading.riskShield.autoBreakeven = false;
    trading.riskShield.autoTrailing = false;
    if (trading.breakerTripped && market.shockIntensity <= 0.15) {
      trading.resetCircuitBreaker(true);
    }
  }
  buildVenueCards();
  renderInstrumentButtons();
  bindAllEvents();
  syncUIFromRestoredState();
  if (restoredSession) {
    renderInstrumentButtons();
  }
  savePersistedState(true);
  syncAutoSize();
  updateClock();
  updateMarketHUD(market.getSymbolState());
  renderTradingPanels(true);
  cvdRenderer.render(true);
  motion.animateBoot();
  market.toggleLiveWebSocket(true);
  initAccountAuthGate();
  if (restoredSession && (trading.botRunning || trading.positions.length > 0)) {
    showToast({
      type: 'cyan',
      title: trading.botRunning ? '🔄 TIẾP TỤC AUTO-BOT' : '🔄 ĐÃ KHÔI PHỤC PHIÊN CŨ',
      msg: `Đang giữ nguyên ${trading.positions.length} vị thế mở • Số dư $${trading.balance.toFixed(2)} USDC.`
    });
  }

  setInterval(updateClock, 1000);
  setInterval(() => {
    market.tick();
    trading.onMarketTick();
    if (!document.hidden) {
      updateMarketHUD(market.getSymbolState());
      renderTradingPanels();
      cvdRenderer.render();
    }
    savePersistedState(false);
  }, 240);

  requestAnimationFrame(animate);
})();
