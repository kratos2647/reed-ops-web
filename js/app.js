/**
 * js/app.js
 * MM VIRSA — Warm Editorial Operations Portal Controller
 * Features:
 *  - Dedicated Visual Dashboard (Greeting, 4 KPI Cards, Semi-Circular Arc Gauge, Orders Bar Chart)
 *  - Clean Keitoto Orders Table (All, Booked, Transit, 5d, 10d, RTO, Delivered, Returned)
 *  - Dedicated CSV & Excel (.csv / .xlsx / .xls) Upload Sheet (Auto, Load Sheet, Receiving Sheet)
 *  - Warm Luxury Return Scanner (1080p 20 FPS + BarcodeDetector + Torch/Zoom + USB Wedge)
 *  - 5-Day & 10-Day SLA Escalations + Trax Sonic v2.0 & Leopards Live Tracking Drawer
 *  - Continuous Cloud Sync (Zero topbar timer, Zero form-input overwrite bug!)
 */
(function (global) {
  const App = (global.DispatchApp = global.DispatchApp || {});

  const VIEW_TITLES = {
    dashboard: 'Dashboard',
    overview: 'Orders',
    upload: 'Upload Sheet',
    returns: 'Scanner',
    alerts: 'Alerts',
    reports: 'Reports',
    settings: 'Settings'
  };

  const SHEET_MODE_HINTS = {
    auto: 'Auto-detects Trax Sonic & Leopards columns, exact status, COD amount, destination city & phone.',
    load_sheet: 'Load Sheet Mode: Marks booked / pickup-request parcels as "Booked / Pickup" until handed over.',
    receiving_sheet: 'Receiving Sheet Mode: Marks parcels as "In Transit" & automatically upgrades Booked parcels to Dispatched.'
  };

  const ui = {
    activeView: 'dashboard',
    dashMode: 'dispatch_returns', // 'dispatch_returns' | 'overall'
    dateFrom: '',
    dateTo: '',
    selectedBarDate: '',
    statusTab: 'all',
    page: 1,
    pageSize: 50,
    gateOpen: false,
    gateMode: 'dispatch', // 'dispatch' | 'booked' | 'return'
    gateManualCourier: false,
    scannerMode: 'dispatch', // 'dispatch' | 'return'
    sheetMode: 'auto', // 'auto' | 'load_sheet' | 'receiving_sheet'
    pendingCSVRows: [],
    pendingCSVFormat: '',
    alertTab: 'critical10',
    alertCourier: 'All',
    activeDrawerCN: '',
    activeDrawerCourier: '',
    lastDupCN: '',
    pendingUnknownCN: '',
    pendingAdminAction: null,
    isSyncing: false,
    intakeFeed: [],
    session: { valid: 0, dup: 0, leopards: 0, trax: 0, log: [] }
  };

  function $(id) {
    return document.getElementById(id);
  }

  function esc(str) {
    return String(str === null || str === undefined ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function toast(msg, type) {
    const box = $('toast-container');
    if (!box) return;
    const el = document.createElement('div');
    el.className = `toast ${type || 'success'}`;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.2s';
      setTimeout(() => el.remove(), 220);
    }, 3200);
  }

  function flashScreen(cls) {
    const el = $('screen-flash');
    if (!el) return;
    el.className = 'screen-flash';
    void el.offsetWidth;
    el.classList.add(cls);
  }

  function nowClock() {
    return new Date().toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  }

  // =========================================================================
  // View Navigation & Quick Gate Toggle
  // =========================================================================
  function setGateDrawerOpen(open, focusInput) {
    ui.gateOpen = Boolean(open);
    const box = $('gate-drawer-box');
    if (box) box.classList.toggle('open', ui.gateOpen);
    const lbl = $('btn-toggle-gate-label');
    if (lbl) lbl.textContent = ui.gateOpen ? 'Close' : 'New Order';
    if (ui.gateOpen && focusInput) {
      setTimeout(() => {
        const inp = $('inp-gate-cn');
        if (inp) inp.focus();
      }, 45);
    }
  }

  function setStatusTab(tab) {
    ui.statusTab = tab || 'all';
    ui.page = 1;
    document.querySelectorAll('#status-underline-tabs [data-status-tab]').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-status-tab') === ui.statusTab);
    });
    document.querySelectorAll('[data-kpi-filter]').forEach((k) => {
      k.classList.toggle('is-selected', k.getAttribute('data-kpi-filter') === ui.statusTab);
    });
    renderLedger(App.Storage.getParcels());
  }

  function applyRolePermissions() {
    if (!App.Security || !App.Security.hasPermission) return;
    const canIntake = App.Security.hasPermission('canIntake');
    const canReturn = App.Security.hasPermission('canReturnScan');
    const canEdit = App.Security.hasPermission('canEditOrders');
    const canReports = App.Security.hasPermission('canViewReports');
    const canSettings = App.Security.hasPermission('canManageSettings');

    const navAllowed = {
      dashboard: canReports || canIntake || canReturn,
      overview: canIntake || canEdit || canReports,
      upload: canIntake,
      returns: canReturn,
      reports: canReports,
      settings: canSettings
    };

    document.querySelectorAll('[data-nav]').forEach((btn) => {
      const target = btn.getAttribute('data-nav');
      const ok = navAllowed[target] !== false;
      btn.style.display = ok ? '' : 'none';
    });

    if ($('btn-bulk-delete')) $('btn-bulk-delete').style.display = canEdit ? '' : 'none';
    if ($('btn-drawer-delete')) $('btn-drawer-delete').style.display = canEdit ? '' : 'none';
    if ($('btn-clear-all')) $('btn-clear-all').style.display = canEdit ? '' : 'none';
    if ($('btn-gate-submit')) $('btn-gate-submit').disabled = !canIntake;
  }

  async function switchView(viewName) {
    if (App.Security && App.Security.hasPermission) {
      const checks = {
        upload: 'canIntake',
        returns: 'canReturnScan',
        reports: 'canViewReports',
        settings: 'canManageSettings'
      };
      const reqPerm = checks[viewName];
      if (reqPerm && !App.Security.hasPermission(reqPerm)) {
        toast('Access denied for your current role.', 'error');
        return;
      }
    }
    if (ui.activeView !== viewName) {
      await App.Scanner.stop();
      updateReturnCamUI(false);
    }
    ui.activeView = viewName;
    document.querySelectorAll('.view-section').forEach((s) => {
      s.classList.toggle('active', s.id === `view-${viewName}`);
    });
    document.querySelectorAll('[data-nav]').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-nav') === viewName);
    });
    const bc = $('breadcrumb-current');
    if (bc) bc.textContent = VIEW_TITLES[viewName] || 'Dashboard';

    $('notif-dropdown').classList.remove('open');
    renderAll();

    if (viewName === 'returns') {
      setTimeout(() => $('inp-return-scan').focus(), 60);
    } else if (viewName === 'overview' && ui.gateOpen) {
      setTimeout(() => $('inp-gate-cn').focus(), 60);
    }
    global.scrollTo({ top: 0, behavior: 'instant' });
  }

  // =========================================================================
  // Couriers & Dropdowns
  // =========================================================================
  function getCouriers() {
    return App.Couriers.getCouriers(App.Storage.getState().customCouriers);
  }

  function syncCourierControls() {
    const list = getCouriers();
    const sig = list.map((c) => c.name).join('|');

    const fSel = $('filter-courier');
    if (fSel && fSel.dataset.sig !== sig) {
      const prevF = fSel.value || 'All';
      fSel.innerHTML =
        `<option value="All">All Couriers</option>` +
        list.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
      if ([...fSel.options].some((o) => o.value === prevF)) fSel.value = prevF;
      fSel.dataset.sig = sig;
    }

    ['inp-gate-courier', 'edit-courier', 'inp-unknown-courier'].forEach((id) => {
      const sel = $(id);
      if (!sel || sel.dataset.sig === sig) return;
      const prev = sel.value;
      sel.innerHTML = list.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
      if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
      sel.dataset.sig = sig;
    });

    const names = ['All', ...list.map((c) => c.name)];
    $('alerts-courier-pills').innerHTML = names
      .map(
        (n) =>
          `<button type="button" class="seg-btn ${ui.alertCourier === n ? 'active' : ''}" data-alert-courier="${esc(n)}">${esc(n)}</button>`
      )
      .join('');

    $('courier-list-chips').innerHTML = list
      .map((c) => {
        const del = c.builtIn
          ? ''
          : `<button type="button" data-remove-courier="${esc(c.name)}" style="border:none;background:none;color:var(--red-text);font-weight:700;padding:0 0 0 4px;">&times;</button>`;
        return `<span class="chip chip-neutral">${esc(c.name)}${del}</span>`;
      })
      .join('');
  }

  // =========================================================================
  // Dashboard Renderer (KPI Cards, Semi-Circular Arc & Orders Dynamics Chart)
  // =========================================================================
  function filterParcelsByDateRange(parcels) {
    const from = ui.dateFrom || '';
    const to = ui.dateTo || '';
    if (!from && !to) return parcels;
    return (parcels || []).filter((p) => {
      const d = String(p.dispatchDate || '').slice(0, 10);
      if (!d) return false;
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
  }

  function renderDashboard(sum, scopedParcels) {
    const totalCount = sum.totalDispatched;
    const overdueCount = sum.warning5 + sum.critical10;
    const activeCount = sum.inTransitNormal + overdueCount;
    const transitPct = totalCount > 0 ? Math.round((activeCount / totalCount) * 100) : 0;
    const deliveredPct = totalCount > 0 ? Math.round((sum.delivered / totalCount) * 100) : 0;
    const returnPct = totalCount > 0 ? Math.round((sum.returnedVerified / totalCount) * 100) : 0;
    const rtoPct = totalCount > 0 ? Math.round((sum.rto / totalCount) * 100) : 0;
    const activePct = totalCount > 0 ? Math.round(((activeCount + sum.booked) / totalCount) * 100) : 0;

    const listForCod = scopedParcels || [];
    const sumCod = (fn) => listForCod.reduce((acc, p) => (fn(p) ? acc + (Number(p.codAmount) || 0) : acc), 0);
    const fmtCod = (v) => `Rs. ${Math.round(v).toLocaleString()}`;
    const codTotal = sumCod(() => true);
    const codBooked = sumCod((p) => p.status === 'Booked / Pickup');
    const codTransit = sumCod((p) => p.status === 'In Transit');
    const codDelivered = sumCod((p) => p.status === 'Delivered');
    const codReturned = sumCod((p) => p.status === 'Returned & Verified');
    const codRto = sumCod((p) => p.status === 'Return In Transit');

    if (ui.dashMode === 'dispatch_returns') {
      if ($('dkpi-lbl-1')) $('dkpi-lbl-1').textContent = 'Pending (Load Sheet)';
      if ($('dkpi-card-1')) $('dkpi-card-1').setAttribute('data-jump-status', 'booked');
      $('dkpi-total').textContent = sum.booked.toLocaleString();
      $('dkpi-pill-total').textContent = sum.booked > 0 ? 'To Scan' : 'Clear';
      if ($('dkpi-cod-1')) $('dkpi-cod-1').textContent = fmtCod(codBooked);

      if ($('dkpi-lbl-2')) $('dkpi-lbl-2').textContent = 'Dispatched (In Transit)';
      if ($('dkpi-card-2')) $('dkpi-card-2').setAttribute('data-jump-status', 'normal');
      $('dkpi-transit').textContent = activeCount.toLocaleString();
      $('dkpi-pill-transit').textContent = `${transitPct}%`;
      if ($('dkpi-cod-2')) $('dkpi-cod-2').textContent = fmtCod(codTransit);

      if ($('dkpi-lbl-3')) $('dkpi-lbl-3').textContent = 'Returns Verified';
      if ($('dkpi-card-3')) $('dkpi-card-3').setAttribute('data-jump-status', 'returned');
      $('dkpi-booked').textContent = sum.returnedVerified.toLocaleString();
      $('dkpi-pill-booked').textContent = `${returnPct}%`;
      if ($('dkpi-cod-3')) $('dkpi-cod-3').textContent = fmtCod(codReturned);

      if ($('dkpi-lbl-4')) $('dkpi-lbl-4').textContent = 'RTO / Return Transit';
      if ($('dkpi-card-4')) $('dkpi-card-4').setAttribute('data-jump-status', 'rto');
      $('dkpi-delivered').textContent = sum.rto.toLocaleString();
      $('dkpi-pill-delivered').textContent = `${rtoPct}%`;
      if ($('dkpi-cod-4')) $('dkpi-cod-4').textContent = fmtCod(codRto);
    } else {
      if ($('dkpi-lbl-1')) $('dkpi-lbl-1').textContent = 'Total orders';
      if ($('dkpi-card-1')) $('dkpi-card-1').setAttribute('data-jump-status', 'all');
      $('dkpi-total').textContent = totalCount.toLocaleString();
      $('dkpi-pill-total').textContent = sum.returnedVerified > 0 ? `${sum.returnedVerified} ret` : 'Live';
      if ($('dkpi-cod-1')) $('dkpi-cod-1').textContent = fmtCod(codTotal);

      if ($('dkpi-lbl-2')) $('dkpi-lbl-2').textContent = 'In transit';
      if ($('dkpi-card-2')) $('dkpi-card-2').setAttribute('data-jump-status', 'normal');
      $('dkpi-transit').textContent = sum.inTransitNormal.toLocaleString();
      $('dkpi-pill-transit').textContent = `${transitPct}%`;
      if ($('dkpi-cod-2')) $('dkpi-cod-2').textContent = fmtCod(codTransit);

      if ($('dkpi-lbl-3')) $('dkpi-lbl-3').textContent = 'Pending (Load)';
      if ($('dkpi-card-3')) $('dkpi-card-3').setAttribute('data-jump-status', 'booked');
      $('dkpi-booked').textContent = sum.booked.toLocaleString();
      $('dkpi-pill-booked').textContent = sum.booked > 0 ? 'Pending' : 'Clear';
      if ($('dkpi-cod-3')) $('dkpi-cod-3').textContent = fmtCod(codBooked);

      if ($('dkpi-lbl-4')) $('dkpi-lbl-4').textContent = 'Delivered';
      if ($('dkpi-card-4')) $('dkpi-card-4').setAttribute('data-jump-status', 'delivered');
      $('dkpi-delivered').textContent = sum.delivered.toLocaleString();
      $('dkpi-pill-delivered').textContent = `${deliveredPct}%`;
      if ($('dkpi-cod-4')) $('dkpi-cod-4').textContent = fmtCod(codDelivered);
    }

    // Live Semi-Circular Arc Gauge
    const ARC_LEN = 276.46;
    const primaryArc = totalCount > 0 ? ((activeCount + sum.booked) / totalCount) * ARC_LEN : 0;
    const combinedArc = totalCount > 0 ? ((activeCount + sum.booked + sum.delivered) / totalCount) * ARC_LEN : 0;
    $('arc-active-pct').textContent = `${activePct}%`;
    $('arc-total').textContent = totalCount.toLocaleString();
    $('arc-transit').textContent = sum.inTransitNormal.toLocaleString();
    $('arc-overdue').textContent = overdueCount.toLocaleString();
    $('arc-delivered').textContent = sum.delivered.toLocaleString();
    $('arc-seg-transit').setAttribute('stroke-dasharray', `${combinedArc.toFixed(1)} 280`);
    $('arc-seg-delivered').setAttribute('stroke-dasharray', `${primaryArc.toFixed(1)} 280`);

    // Orders Dynamics Vertical Bar Chart (Every Pillar Clickable!)
    const chartBox = $('dash-bar-chart');
    const detailBox = $('dash-bar-detail');
    if (chartBox) {
      const series = sum.dailySeries || [];
      if (series.length === 0) {
        chartBox.innerHTML = `<div class="empty-state" style="width:100%; padding:28px 0;">Upload a Trax or Leopards sheet to see volume dynamics</div>`;
        if (detailBox) detailBox.innerHTML = `<span>No parcel data in selected date range.</span>`;
      } else {
        const maxVal = Math.max(1, ...series.map((d) => d.count));
        let activeIdx = series.findIndex((d) => d.date === ui.selectedBarDate);
        if (activeIdx < 0) {
          activeIdx = series.length - 1;
          series.forEach((d, idx) => {
            if (d.count >= series[activeIdx].count) activeIdx = idx;
          });
        }

        chartBox.innerHTML = series
          .map((d, idx) => {
            const pct = Math.max(14, Math.round((d.count / maxVal) * 100));
            const isSelected = idx === activeIdx;
            return `
              <div class="bar-col ${isSelected ? 'is-peak' : ''}" data-bar-date="${esc(d.date)}" style="cursor:pointer;" title="Click to inspect ${esc(d.label)} (${d.count} orders)">
                <div class="bar-track">
                  <div class="bar-fill" style="height:${pct}%;">
                    <span class="bar-val-pill" style="${isSelected ? '' : 'opacity:0.72; font-size:10px;'}">${d.count}</span>
                  </div>
                </div>
                <span class="bar-lbl">${esc(d.label)}</span>
              </div>
            `;
          })
          .join('');

        const sel = series[activeIdx];
        if (detailBox && sel) {
          const dayParcels = (scopedParcels || []).filter((p) => String(p.dispatchDate || '').slice(0, 10) === sel.date);
          const dayBooked = dayParcels.filter((p) => p.status === 'Booked / Pickup').length;
          const dayDisp = dayParcels.filter((p) => p.status === 'In Transit').length;
          const dayRet = dayParcels.filter((p) => p.status === 'Returned & Verified' || p.status === 'Return In Transit').length;
          const dayDel = dayParcels.filter((p) => p.status === 'Delivered').length;
          const dayCod = dayParcels.reduce((a, p) => a + (Number(p.codAmount) || 0), 0);
          detailBox.innerHTML = `
            <span><strong>${esc(sel.label)}:</strong> <strong class="mono">${sel.count}</strong> Total • <strong class="mono">${dayBooked}</strong> Pending • <strong class="mono">${dayDisp}</strong> Dispatched • <strong class="mono">${dayRet}</strong> Returns • <strong class="mono">${dayDel}</strong> Delivered${dayCod ? ' • Rs. ' + dayCod.toLocaleString() : ''}</span>
            <button type="button" class="btn btn-sm" data-open-bar-date="${esc(sel.date)}" style="height:26px; padding:0 10px; font-size:11.5px;">View ${esc(sel.label)} Orders</button>
          `;
        }
      }
    }

    const codTxt = sum.totalCodAmount > 0 ? `COD Value: Rs. ${sum.totalCodAmount.toLocaleString()}` : 'Trax & Leopards volume';
    $('dash-cod-summary').textContent = codTxt;
    $('dash-split-leopards').textContent = `Leopards: ${sum.leopardsCount}`;
    $('dash-split-trax').textContent = `Trax: ${sum.traxCount}`;
    $('dash-split-rto').textContent = `RTO: ${sum.rto}`;

    $('dquick-booked').textContent = sum.booked.toLocaleString();
    $('dquick-rto').textContent = sum.rto.toLocaleString();
    $('dquick-overdue').textContent = overdueCount.toLocaleString();
  }

  // =========================================================================
  // Master Render (Never Overwrites User Form Inputs!)
  // =========================================================================
  function renderAll() {
    const state = App.Storage.getState();
    const parcels = state.parcels;
    const scopedParcels = filterParcelsByDateRange(parcels);
    const sum = App.Aging.summarize(scopedParcels);

    $('demo-banner').style.display = state.isSampleData ? 'flex' : 'none';
    syncCourierControls();
    renderDashboard(sum, scopedParcels);

    // Orders View KPI Strip
    const totalCount = sum.totalDispatched;
    const overdueCount = sum.warning5 + sum.critical10;
    const transitPct = totalCount > 0 ? Math.round((sum.inTransitNormal / totalCount) * 100) : 0;
    const deliveredPct = totalCount > 0 ? Math.round((sum.delivered / totalCount) * 100) : 0;

    $('kpi-total').textContent = totalCount.toLocaleString();
    $('kpi-normal').textContent = sum.inTransitNormal.toLocaleString();
    $('kpi-overdue').textContent = overdueCount.toLocaleString();
    $('kpi-delivered').textContent = sum.delivered.toLocaleString();

    if ($('kpi-pill-total')) $('kpi-pill-total').textContent = sum.returnedVerified > 0 ? `${sum.returnedVerified} ret` : 'Live';
    if ($('kpi-pill-transit')) $('kpi-pill-transit').textContent = `${transitPct}%`;
    if ($('kpi-pill-overdue')) $('kpi-pill-overdue').textContent = overdueCount > 0 ? `${overdueCount} due` : 'Clear';
    if ($('kpi-pill-delivered')) $('kpi-pill-delivered').textContent = `${deliveredPct}%`;

    // Underline Tab Counts
    $('utab-all').textContent = sum.totalDispatched;
    $('utab-booked').textContent = sum.booked;
    $('utab-normal').textContent = sum.inTransitNormal;
    $('utab-warning5').textContent = sum.warning5;
    $('utab-critical10').textContent = sum.critical10;
    $('utab-rto').textContent = sum.rto;
    $('utab-delivered').textContent = sum.delivered;
    $('utab-returned').textContent = sum.returnedVerified;

    // Show 1-click Confirm bar for courier-reported "Delivered to Shipper" returns awaiting confirmation
    const shipperBar = $('shipper-returns-confirm-bar');
    if (shipperBar && App.Storage.getUnconfirmedShipperReturns) {
      const pendingShipper = App.Storage.getUnconfirmedShipperReturns();
      if (pendingShipper.length > 0) {
        shipperBar.style.display = 'flex';
        if ($('shipper-returns-count')) $('shipper-returns-count').textContent = pendingShipper.length;
        if ($('shipper-returns-btn-cnt')) $('shipper-returns-btn-cnt').textContent = pendingShipper.length;
      } else {
        shipperBar.style.display = 'none';
      }
    }

    document.querySelectorAll('[data-kpi-filter]').forEach((k) => {
      k.classList.toggle('is-selected', k.getAttribute('data-kpi-filter') === ui.statusTab);
    });

    // Nav & Bell Counts
    $('nav-count-returns').textContent = sum.returnedVerified;
    $('nav-count-alerts').textContent = sum.totalActionNeeded;
    const bBot = $('bottom-badge-alerts');
    bBot.textContent = sum.totalActionNeeded;
    bBot.classList.toggle('hidden', sum.totalActionNeeded === 0);

    const bellCnt = sum.todayAlertsCount > 0 ? sum.todayAlertsCount : sum.totalActionNeeded;
    const bellEl = $('bell-badge');
    bellEl.textContent = bellCnt;
    bellEl.classList.toggle('hidden', bellCnt === 0);

    renderNotifications(sum);
    renderIntakeFeed(parcels);
    renderReportsExtras(parcels);
    renderLedger(parcels);
    renderAlertsView(sum);
    renderApiAndSecurity();
  }

  function renderNotifications(sum) {
    $('notif-d5').textContent = sum.warning5;
    $('notif-d10').textContent = sum.critical10;
    const items = [...sum.allCritical10.slice(0, 4), ...sum.allWarning5.slice(0, 3)];
    const list = $('notif-list');
    if (items.length === 0) {
      list.innerHTML = `<div style="font-size:12px; color:var(--text-muted); text-align:center; padding:12px;">No SLA breaches today.</div>`;
      return;
    }
    list.innerHTML = items
      .map(
        ({ parcel, eval: ev }) => `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 10px; border:1px solid var(--border-subtle); border-radius:8px; cursor:pointer;" data-action="track" data-cn="${esc(parcel.trackingNumber)}" data-courier="${esc(parcel.courier)}">
        <div>
          <div class="mono" style="font-weight:600; font-size:12px;">${esc(parcel.trackingNumber)}</div>
          <div style="font-size:11px; color:var(--text-muted);">${esc(parcel.courier)} • ${esc(parcel.orderId || '—')}</div>
        </div>
        <span class="chip ${ev.tier === 'critical10' ? 'chip-red' : 'chip-amber'}">Day ${ev.days}</span>
      </div>
    `
      )
      .join('');
  }

  function pushIntakeEvent(ev) {
    ui.intakeFeed.unshift(ev);
    if (ui.intakeFeed.length > 25) ui.intakeFeed.pop();
  }

  function renderIntakeFeed(parcels) {
    const box = $('live-intake-feed');
    if (!box) return;
    const items =
      ui.intakeFeed.length > 0
        ? ui.intakeFeed.slice(0, 3)
        : parcels.slice(0, 3).map((p) => ({
            cn: p.trackingNumber,
            courier: p.courier,
            sub: `${p.customerName || p.orderId || 'Manifest'} • ${App.Aging.formatDisplayDate(p.dispatchDate)}`,
            status: p.status === 'Returned & Verified' ? 'Returned' : p.status === 'Delivered' ? 'Delivered' : p.status === 'Booked / Pickup' ? 'Booked' : 'Dispatched',
            chipCls: p.status === 'Returned & Verified' ? 'chip-purple' : p.status === 'Delivered' ? 'chip-green' : p.status === 'Booked / Pickup' ? 'chip-amber' : 'chip-blue',
            time: App.Aging.formatDisplayDate(p.dispatchDate),
            isDup: false
          }));

    if (items.length === 0) {
      box.innerHTML = `<div class="empty-state" style="padding:14px;">Recent scans will appear here.</div>`;
      return;
    }

    box.innerHTML = items
      .map(
        (it) => `
      <div class="feed-row ${it.isDup ? 'is-dup' : ''}">
        <div style="min-width:0;">
          <div style="display:flex; align-items:center; gap:6px;">
            <button type="button" class="cn-btn mono" data-action="track" data-cn="${esc(it.cn)}" data-courier="${esc(it.courier)}">${esc(it.cn)}</button>
            <span class="chip chip-neutral" style="font-size:10.5px;">${esc(it.courier)}</span>
          </div>
          <div style="font-size:11.5px; color:${it.isDup ? 'var(--red-text)' : 'var(--text-muted)'}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(it.sub)}</div>
        </div>
        <div style="text-align:right; flex-shrink:0;">
          <span class="chip ${it.chipCls}">${esc(it.status)}</span>
          <div class="mono" style="font-size:10.5px; color:var(--text-muted); margin-top:2px;">${esc(it.time)}</div>
        </div>
      </div>
    `
      )
      .join('');
  }

  function getFilteredParcels(parcels) {
    const q = ($('filter-search').value || '').trim().toLowerCase();
    const courier = $('filter-courier').value || 'All';
    const status = ui.statusTab || 'all';
    return filterParcelsByDateRange(parcels).filter((p) => {
      if (courier !== 'All' && p.courier.toLowerCase() !== courier.toLowerCase()) return false;
      const ev = App.Aging.evaluateParcel(p);
      if (status === 'booked' && ev.tier !== 'booked') return false;
      if (status === 'normal' && ev.tier !== 'normal') return false;
      if (status === 'overdue' && ev.tier !== 'warning5' && ev.tier !== 'critical10') return false;
      if (status === 'warning5' && ev.tier !== 'warning5') return false;
      if (status === 'critical10' && ev.tier !== 'critical10') return false;
      if (status === 'rto' && ev.tier !== 'rto') return false;
      if (status === 'delivered' && ev.tier !== 'delivered') return false;
      if (status === 'returned' && ev.tier !== 'returned') return false;
      if (q) {
        const hay = `${p.trackingNumber} ${p.orderId} ${p.itemDescription || ''} ${p.customerName} ${p.customerPhone} ${p.destinationCity || ''} ${p.courier} ${p.courierStatus || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function courierThumbHTML(courierName) {
    const low = String(courierName || '').toLowerCase();
    if (low.includes('leopard')) return `<div class="courier-thumb leopards">LP</div>`;
    if (low.includes('trax')) return `<div class="courier-thumb trax">TX</div>`;
    const initials = String(courierName || 'CR').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'CR';
    return `<div class="courier-thumb">${esc(initials)}</div>`;
  }

  function ageTagHTML(ev) {
    if (ev.tier === 'delivered' || ev.tier === 'returned' || ev.tier === 'cancelled' || ev.tier === 'booked') return '';
    const cls = ev.tier === 'critical10' ? 'red' : ev.tier === 'warning5' ? 'amber' : '';
    return `<span class="age-tag ${cls}">${ev.days}d</span>`;
  }

  function statusChipHTML(ev) {
    if (ev.tier === 'critical10') return `<span class="chip chip-red">10d Overdue</span>`;
    if (ev.tier === 'warning5') return `<span class="chip chip-amber">5d Alert</span>`;
    if (ev.tier === 'booked') return `<span class="chip chip-yellow">Pending</span>`;
    if (ev.tier === 'rto') return `<span class="chip chip-purple">Returning</span>`;
    if (ev.tier === 'delivered') return `<span class="chip chip-green">Delivered</span>`;
    if (ev.tier === 'returned') return `<span class="chip chip-purple">Returned</span>`;
    if (ev.tier === 'cancelled') return `<span class="chip chip-neutral">Cancelled</span>`;
    return `<span class="chip chip-blue">Processing</span>`;
  }

  function renderPagination(totalItems) {
    const infoEl = $('pagination-info');
    const ctrlEl = $('pagination-controls');
    if (!infoEl || !ctrlEl) return;

    const totalPages = Math.max(1, Math.ceil(totalItems / ui.pageSize));
    if (ui.page > totalPages) ui.page = totalPages;

    if (totalItems === 0) {
      infoEl.textContent = 'Showing 0 orders';
      ctrlEl.innerHTML = '';
      return;
    }

    const start = (ui.page - 1) * ui.pageSize + 1;
    const end = Math.min(totalItems, ui.page * ui.pageSize);
    infoEl.textContent = `Showing ${start}–${end} of ${totalItems} orders`;

    const pages = [];
    if (totalPages <= 5) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (ui.page > 3) pages.push('...');
      const from = Math.max(2, ui.page - 1);
      const to = Math.min(totalPages - 1, ui.page + 1);
      for (let i = from; i <= to; i++) pages.push(i);
      if (ui.page < totalPages - 2) pages.push('...');
      pages.push(totalPages);
    }

    let html = `<button type="button" class="page-btn" data-page="${ui.page - 1}" ${ui.page <= 1 ? 'disabled' : ''}>‹ Previous</button>`;
    pages.forEach((p) => {
      if (p === '...') html += `<span style="padding:0 4px; color:var(--text-muted);">…</span>`;
      else html += `<button type="button" class="page-btn ${p === ui.page ? 'active' : ''}" data-page="${p}">${p}</button>`;
    });
    html += `<button type="button" class="page-btn" data-page="${ui.page + 1}" ${ui.page >= totalPages ? 'disabled' : ''}>Next ›</button>`;
    ctrlEl.innerHTML = html;
  }

  function renderLedger(allParcels) {
    const allFiltered = getFilteredParcels(allParcels);
    const totalPages = Math.max(1, Math.ceil(allFiltered.length / ui.pageSize));
    if (ui.page > totalPages) ui.page = totalPages;

    const startIdx = (ui.page - 1) * ui.pageSize;
    const rows = allFiltered.slice(startIdx, startIdx + ui.pageSize);

    const tbody = $('ledger-tbody');
    const mob = $('ledger-mobile');
    renderPagination(allFiltered.length);

    if (rows.length === 0) {
      const empty = `<div class="empty-state">No orders found.</div>`;
      tbody.innerHTML = `<tr><td colspan="6">${empty}</td></tr>`;
      mob.innerHTML = empty;
      return;
    }

    tbody.innerHTML = rows
      .map((p) => {
        const ev = App.Aging.evaluateParcel(p);
        const destTxt = p.customerName || p.destinationCity || p.courier;
        const citySub = p.destinationCity && p.customerName ? ` • ${p.destinationCity}` : '';
        const orderLabel = p.orderId ? (String(p.orderId).startsWith('#') ? p.orderId : `#${p.orderId}`) : p.courier;
        const prodTxt = p.itemDescription || p.notes || '—';

        return `
          <tr>
            <td>
              <div class="shipment-cell">
                ${courierThumbHTML(p.courier)}
                <div style="min-width:0;">
                  <button type="button" class="cn-btn mono" data-action="track" data-cn="${esc(p.trackingNumber)}" data-courier="${esc(p.courier)}">${esc(p.trackingNumber)}</button>
                  <div style="font-size:12px; color:var(--text-muted); margin-top:1px;">${esc(orderLabel)}${p.codAmount ? ' • Rs. ' + Number(p.codAmount).toLocaleString() : ''}</div>
                </div>
              </div>
            </td>
            <td style="color:var(--text-primary);">
              <div style="max-width:220px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:12.5px;" title="${esc(prodTxt)}">${esc(prodTxt)}</div>
            </td>
            <td style="color:var(--text-primary); font-weight:500;">
              <div style="max-width:200px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(destTxt)}<span style="color:var(--text-muted); font-weight:400;">${esc(citySub)}</span></div>
            </td>
            <td>${statusChipHTML(ev)}</td>
            <td class="mono" style="font-size:12.5px; color:var(--text-secondary); white-space:nowrap;">${esc(p.dispatchDate || '')}${ageTagHTML(ev)}</td>
            <td style="text-align:right; white-space:nowrap;">
              <button type="button" class="row-icon-btn" title="Live Track" data-action="track" data-cn="${esc(p.trackingNumber)}" data-courier="${esc(p.courier)}">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
              </button>
              <button type="button" class="row-icon-btn" title="Edit Order" data-action="edit" data-id="${esc(p.id)}">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
              </button>
            </td>
          </tr>
        `;
      })
      .join('');

    mob.innerHTML = rows
      .map((p) => {
        const ev = App.Aging.evaluateParcel(p);
        const destTxt = p.customerName || p.destinationCity || p.courier;
        const orderLabel = p.orderId ? (String(p.orderId).startsWith('#') ? p.orderId : `#${p.orderId}`) : p.courier;
        const prodLine = p.itemDescription
          ? `<div style="font-size:11.5px; color:var(--text-secondary); margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;"><strong>Product:</strong> ${esc(p.itemDescription)}</div>`
          : '';
        return `
          <div class="mobile-row">
            <div class="mob-card-top">
              <div class="shipment-cell" style="min-width:0;">
                ${courierThumbHTML(p.courier)}
                <div style="min-width:0;">
                  <button type="button" class="cn-btn mono" data-action="track" data-cn="${esc(p.trackingNumber)}" data-courier="${esc(p.courier)}">${esc(p.trackingNumber)}</button>
                  <div style="font-size:11.5px; color:var(--text-muted); margin-top:1px;">${esc(orderLabel)}${p.codAmount ? ' • Rs. ' + Number(p.codAmount).toLocaleString() : ''}</div>
                </div>
              </div>
              ${statusChipHTML(ev)}
            </div>
            ${prodLine}
            <div class="mob-card-bottom">
              <div style="min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                <span style="color:var(--text-primary); font-weight:500;">${esc(destTxt)}</span>
                <span style="margin:0 5px; opacity:0.4;">•</span>
                <span class="mono">${esc(p.dispatchDate || '')}</span>${ageTagHTML(ev)}
              </div>
              <div style="display:inline-flex; align-items:center; gap:2px; flex-shrink:0;">
                <button type="button" class="row-icon-btn" title="Live Track" data-action="track" data-cn="${esc(p.trackingNumber)}" data-courier="${esc(p.courier)}">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
                <button type="button" class="row-icon-btn" title="Edit Order" data-action="edit" data-id="${esc(p.id)}">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
                </button>
              </div>
            </div>
          </div>
        `;
      })
      .join('');
  }

  function renderAlertsView(sum) {
    const filterFn = (x) => ui.alertCourier === 'All' || x.parcel.courier.toLowerCase() === ui.alertCourier.toLowerCase();
    const list10 = sum.allCritical10.filter(filterFn);
    const list5 = sum.allWarning5.filter(filterFn);
    $('tab-count-10d').textContent = list10.length;
    $('tab-count-5d').textContent = list5.length;

    const activeList = ui.alertTab === 'critical10' ? list10 : list5;
    const container = $('alerts-list-container');
    if (activeList.length === 0) {
      container.innerHTML = `<div class="empty-state">No parcels in this SLA alert tier.</div>`;
      return;
    }

    container.innerHTML = activeList
      .map(({ parcel: p, eval: ev }) => {
        const digits = String(p.customerPhone || '').replace(/[^\d]/g, '');
        const waNum = digits ? (digits.startsWith('0') ? '92' + digits.slice(1) : digits) : '';
        const waMsg = encodeURIComponent(
          `Assalam o Alaikum ${p.customerName || ''}, aapka REED order ${p.orderId || ''}${p.itemDescription ? ' (' + p.itemDescription + ')' : ''} via ${p.courier} (CN: ${p.trackingNumber}) delivery ke liye pending hai. Kindly rider ki call receive kar lein. Shukriya!`
        );
        const waBtn = waNum
          ? `<a href="https://wa.me/${esc(waNum)}?text=${waMsg}" target="_blank" rel="noopener noreferrer" class="btn btn-sm" style="background:var(--green-bg); color:var(--green-text); border-color:var(--green-border);">WhatsApp</a>`
          : '';
        return `
      <div class="feed-row">
        <div style="min-width:0;">
          <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
            <button type="button" class="cn-btn mono" data-action="track" data-cn="${esc(p.trackingNumber)}" data-courier="${esc(p.courier)}">${esc(p.trackingNumber)}</button>
            <span class="chip chip-neutral">${esc(p.courier)}</span>
            ${statusChipHTML(ev)}
            <span class="mono" style="font-size:11px; color:var(--text-muted);">Day ${ev.days}</span>
          </div>
          <div style="font-size:12px; color:var(--text-secondary); margin-top:3px;">
            ${esc(p.orderId || '—')} • ${esc(p.customerName || 'No Name')}${p.itemDescription ? ' • ' + esc(p.itemDescription) : ''} ${p.destinationCity ? '• ' + esc(p.destinationCity) : ''} • ${esc(App.Aging.formatDisplayDate(p.dispatchDate))}
          </div>
        </div>
        <div class="btn-group">
          ${waBtn}
          <button type="button" class="btn btn-sm" data-action="track" data-cn="${esc(p.trackingNumber)}" data-courier="${esc(p.courier)}">Live Track</button>
          <button type="button" class="btn btn-sm" data-action="deliver" data-id="${esc(p.id)}">Delivered</button>
          <button type="button" class="btn btn-sm btn-primary" data-action="verify-return" data-id="${esc(p.id)}">Verify Return</button>
        </div>
      </div>
    `;
      })
      .join('');
  }

  function renderReportsExtras(parcels) {
    const codBody = $('cod-recon-tbody');
    if (codBody) {
      const byCourier = {};
      (parcels || []).forEach((p) => {
        const c = p.courier || 'Other';
        if (!byCourier[c]) {
          byCourier[c] = { delivered: 0, deliveredCod: 0, transitCod: 0, returns: 0, claimVal: 0, claimCnt: 0 };
        }
        const row = byCourier[c];
        const amt = Number(p.codAmount) || 0;
        if (p.status === 'Delivered') {
          row.delivered++;
          row.deliveredCod += amt;
        } else if (p.status === 'In Transit' || p.status === 'Return In Transit') {
          row.transitCod += amt;
        } else if (p.status === 'Returned & Verified') {
          row.returns++;
          if (p.claimStatus && p.claimStatus !== 'None') {
            row.claimCnt++;
            row.claimVal += amt;
          }
        }
      });
      const keys = Object.keys(byCourier);
      codBody.innerHTML = keys.length
        ? keys
            .map((c) => {
              const r = byCourier[c];
              return `<tr>
                <td><strong>${esc(c)}</strong></td>
                <td class="mono">${r.delivered}</td>
                <td class="mono" style="color:var(--green-text); font-weight:600;">Rs. ${r.deliveredCod.toLocaleString()}</td>
                <td class="mono">Rs. ${r.transitCod.toLocaleString()}</td>
                <td class="mono">${r.returns}</td>
                <td class="mono" style="color:${r.claimCnt ? 'var(--red-text)' : 'var(--text-muted)'}; font-weight:${r.claimCnt ? '600' : '400'};">${r.claimCnt} (Rs. ${r.claimVal.toLocaleString()})</td>
              </tr>`;
            })
            .join('')
        : '<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:16px;">No COD records yet.</td></tr>';
    }

    const perfBox = $('staff-perf-body');
    if (perfBox && App.Security && App.Security.getAuditLog) {
      const today = App.Aging.getTodayISO();
      if ($('staff-perf-date-chip')) $('staff-perf-date-chip').textContent = App.Aging.formatDisplayDate(today);
      const logs = App.Security.getAuditLog().filter((l) => App.Aging.isSameLocalDay(l.ts, today));
      const counts = {};
      logs.forEach((l) => {
        const actor = l.actor || 'Station';
        if (!counts[actor]) counts[actor] = { dispatch: 0, returns: 0 };
        if (l.type === 'DISPATCH' || l.type === 'DISPATCH_SCAN') counts[actor].dispatch++;
        if (l.type === 'RETURN_OK') counts[actor].returns++;
      });
      const actors = Object.keys(counts);
      perfBox.innerHTML = actors.length
        ? actors
            .map(
              (a) => `<div style="padding:10px 14px; border-radius:12px; border:1px solid var(--border-subtle); background:var(--surface-muted); min-width:190px;">
                <div style="font-weight:600; font-size:13px;">${esc(a)}</div>
                <div style="font-size:12px; color:var(--text-muted); margin-top:3px;">Dispatched: <strong class="mono">${counts[a].dispatch}</strong> • Returns: <strong class="mono">${counts[a].returns}</strong></div>
              </div>`
            )
            .join('')
        : '<div style="font-size:12.5px; color:var(--text-muted);">No staff scan activity logged today yet.</div>';
    }
  }

  function compressImageToDataURL(file, maxSide, quality) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, (maxSide || 640) / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', quality || 0.72));
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function printHandoverSlip(type) {
    const today = App.Aging.getTodayISO();
    const all = App.Storage.getParcels();
    const list =
      type === 'returns'
        ? all.filter((p) => p.status === 'Returned & Verified' && App.Aging.isSameLocalDay(p.returnedAt, today))
        : all.filter((p) => p.status === 'In Transit' && (p.dispatchDate === today || App.Aging.isSameLocalDay(p.dispatchedAt, today)));
    const title = type === 'returns' ? 'REED — Return Receiving Slip' : 'REED — Rider Dispatch Handover Slip';
    const totalCod = list.reduce((acc, p) => acc + (Number(p.codAmount) || 0), 0);
    const rowsHtml = list.length
      ? list
          .map(
            (p, idx) => `<tr>
              <td>${idx + 1}</td>
              <td style="font-family:monospace; font-weight:600;">${esc(p.trackingNumber)}</td>
              <td>${esc(p.orderId || '—')}</td>
              <td>${esc(p.courier)}</td>
              <td>${esc(p.itemDescription || '—')}</td>
              <td>${esc(p.customerName || '—')}</td>
              <td>${p.codAmount ? 'Rs. ' + Number(p.codAmount).toLocaleString() : '—'}</td>
              <td>${type === 'returns' ? esc(p.returnReason || 'Sealed / Intact') : esc(p.destinationCity || '—')}</td>
            </tr>`
          )
          .join('')
      : `<tr><td colspan="8" style="text-align:center; padding:18px;">No ${type === 'returns' ? 'returns' : 'dispatches'} recorded today (${today}).</td></tr>`;

    const win = global.open('', '_blank', 'width=900,height=700');
    if (!win) return toast('Allow pop-ups to print slip.', 'warning');
    win.document.write(`<!DOCTYPE html><html><head><title>${title}</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 24px; color: #1c1917; }
        h1 { margin: 0 0 4px; font-size: 20px; }
        .meta { font-size: 12px; color: #57534e; margin-bottom: 16px; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th, td { border: 1px solid #d6d3d1; padding: 6px 8px; text-align: left; }
        th { background: #f5f5f4; }
        .sigs { display: flex; justify-content: space-between; margin-top: 42px; font-size: 12px; }
        .sig-box { width: 220px; border-top: 1px solid #1c1917; padding-top: 6px; text-align: center; }
      </style></head><body>
      <h1>${title}</h1>
      <div class="meta">Date: <strong>${today}</strong> • Total Parcels: <strong>${list.length}</strong> • Total COD: <strong>Rs. ${totalCod.toLocaleString()}</strong></div>
      <table>
        <thead><tr><th>#</th><th>Tracking CN</th><th>Order ID</th><th>Courier</th><th>Product</th><th>Customer</th><th>COD</th><th>${type === 'returns' ? 'Condition / Claim' : 'City'}</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <div class="sigs">
        <div class="sig-box">Warehouse Staff Signature</div>
        <div class="sig-box">Courier Rider Name &amp; Signature</div>
        <div class="sig-box">Date &amp; Stamp</div>
      </div>
      <script>window.onload = function(){ window.print(); };</script>
      </body></html>`);
    win.document.close();
  }

  // =========================================================================
  // Settings Form Hydration (Called ONLY on Init & Explicit Save — NEVER on 8s Poll!)
  // =========================================================================
  function hydrateSettingsForms() {
    const apiCfg = App.TrackingAPI.loadConfig();
    $('inp-trax-key').value = apiCfg.traxApiKey || '';
    $('inp-trax-env').value = apiCfg.traxEnv || 'live';
    $('inp-api-proxy').value = apiCfg.corsProxyUrl || '';
    $('inp-lcs-key').value = apiCfg.leopardsApiKey || '';
    $('inp-lcs-pass').value = apiCfg.leopardsApiPassword || '';
    $('chk-auto-deliver').checked = Boolean(apiCfg.autoMarkDeliveredOnSync);
    if ($('chk-auto-live-track')) $('chk-auto-live-track').checked = Boolean(apiCfg.autoLiveTrackEnabled);

    if (App.CloudSync) {
      const sc = App.CloudSync.loadConfig();
      if ($('inp-sync-account')) $('inp-sync-account').value = sc.accountLabel || '';
      $('inp-sync-provider').value = sc.provider || 'google_sheets';
      $('inp-sync-url').value = sc.endpointUrl || '';
      $('inp-sync-secret').value = sc.secretToken || '';
      $('chk-cloud-sync-enabled').checked = Boolean(sc.enabled);
    }

    const sec = App.Security.loadConfig();
    $('inp-sec-autolock').value = String(sec.autoLockMinutes || 0);
    $('inp-sec-operator').value = sec.operatorName || 'VIRSA Station';
  }

  function renderApiAndSecurity() {
    const apiCfg = App.TrackingAPI.loadConfig();
    const traxOk = App.TrackingAPI.hasLiveCredentials('Trax', apiCfg);
    const lcsOk = App.TrackingAPI.hasLiveCredentials('Leopards', apiCfg);
    const localProxy = App.TrackingAPI.isLocalProxyActive();

    $('local-proxy-banner').style.display = localProxy ? 'none' : 'flex';
    $('proxy-status-badge').textContent = localProxy ? 'Zero-CORS Proxy ON' : 'Direct Mode';
    $('proxy-status-badge').className = localProxy ? 'chip chip-green' : 'chip chip-amber';
    $('trax-cred-badge').textContent = traxOk ? 'Live Key Saved' : 'Not Set';
    $('trax-cred-badge').className = traxOk ? 'chip chip-green' : 'chip chip-neutral';
    $('leopards-cred-badge').textContent = lcsOk ? 'Live Key Saved' : 'Not Set';
    $('leopards-cred-badge').className = lcsOk ? 'chip chip-green' : 'chip chip-neutral';

    // Clean Topbar Sync Label — ZERO clock/timer!
    const scTop = App.CloudSync ? App.CloudSync.loadConfig() : null;
    const isCloudBusy = ui.isSyncing || (App.CloudSync && App.CloudSync.isSyncing());
    const cloudActive = Boolean(scTop && scTop.enabled && scTop.endpointUrl && !scTop.lastError);
    $('topbar-sync-label').textContent = isCloudBusy ? 'Syncing' : cloudActive ? 'Synced' : 'Sync';

    const sideSync = $('sidebar-sync-status');
    if (sideSync) {
      const dotColor = scTop && scTop.enabled && scTop.lastError ? 'var(--red-solid)' : 'var(--green-text)';
      const lbl =
        scTop && scTop.enabled
          ? scTop.lastError
            ? 'Sync Error'
            : 'Cloud Sync ON'
          : localProxy
          ? 'Local Disk ON'
          : 'Live Ready';
      sideSync.innerHTML = `<span class="live-dot" style="background:${dotColor};"></span>${lbl}`;
    }

    if (App.CloudSync) {
      const sc = App.CloudSync.loadConfig();
      const hasDisk = App.CloudSync.hasLocalDiskBackend();
      $('disk-db-badge').textContent = hasDisk ? 'Local Disk DB: ACTIVE' : 'Web IndexedDB: ACTIVE';
      $('disk-db-badge').className = 'chip chip-green';
      if ($('btn-host-erase-all')) {
        const canErase = !App.Security.hasPermission || App.Security.hasPermission('canManageSettings');
        $('btn-host-erase-all').style.display = canErase ? 'inline-flex' : 'none';
      }

      const cloudOn = Boolean(sc.enabled && sc.endpointUrl);
      $('cloud-sync-badge').textContent = App.CloudSync.isSyncing()
        ? 'Syncing...'
        : cloudOn
        ? sc.lastError
          ? 'Sync Error'
          : 'Cloud Synced'
        : 'Cloud Off';
      $('cloud-sync-badge').className = cloudOn
        ? sc.lastError
          ? 'chip chip-red'
          : 'chip chip-green'
        : 'chip chip-neutral';

      if (sc.lastError) {
        $('cloud-sync-meta').innerHTML = `<span style="color:var(--red-text); font-weight:600;">Last Cloud Sync Error: ${esc(sc.lastError)}</span>`;
      } else if (sc.lastCloudSyncAt) {
        $('cloud-sync-meta').textContent = `Continuous two-way cloud sync active • Last synced ${App.Aging.formatDateTime(sc.lastCloudSyncAt)}`;
      }
    }

    const sec = App.Security.loadConfig();
    const curStaff = App.Security.getCurrentStaff ? App.Security.getCurrentStaff() : null;
    const roleMeta = curStaff && App.Security.ROLE_PRESETS[curStaff.role] ? App.Security.ROLE_PRESETS[curStaff.role].label : '';
    const opName = curStaff ? `${curStaff.name} • ${roleMeta}` : sec.operatorName || 'VIRSA Station';
    $('sidebar-operator-name').textContent = opName;
    if ($('dash-hello-name')) $('dash-hello-name').textContent = (curStaff ? curStaff.name : opName).split(/\s+/)[0] || 'VIRSA';

    const authOn = App.Security.isAuthRequired ? App.Security.isAuthRequired() : sec.pinEnabled;
    $('btn-lock-app').style.display = authOn ? 'inline-flex' : 'none';
    if ($('btn-sidebar-logout')) $('btn-sidebar-logout').style.display = authOn ? 'block' : 'none';
    $('btn-sec-lock-now').style.display = authOn ? 'inline-flex' : 'none';
    $('btn-sec-disable-pin').style.display = sec.pinEnabled ? 'inline-flex' : 'none';
    $('sec-pin-status-badge').textContent = sec.pinEnabled ? 'PIN Protected' : 'PIN Off';
    $('sec-pin-status-badge').className = sec.pinEnabled ? 'chip chip-green' : 'chip chip-neutral';

    // Staff Accounts Table
    if ($('staff-list-body') && App.Security.getStaffList) {
      const staff = App.Security.getStaffList();
      if ($('staff-count-badge')) $('staff-count-badge').textContent = `${staff.length} Staff`;
      $('staff-list-body').innerHTML = staff.length
        ? staff
            .map((emp) => {
              const rLabel = (App.Security.ROLE_PRESETS[emp.role] && App.Security.ROLE_PRESETS[emp.role].label) || emp.role;
              const p = emp.permissions || {};
              const perms = [
                p.canIntake ? 'Intake' : '',
                p.canReturnScan ? 'Scan' : '',
                p.canEditOrders ? 'Edit/Del' : '',
                p.canViewReports ? 'Reports' : '',
                p.canManageSettings ? 'Admin' : ''
              ]
                .filter(Boolean)
                .join(', ');
              return `<tr>
                <td><strong>${esc(emp.name)}</strong><div class="mono" style="font-size:11px; color:var(--text-muted);">@${esc(emp.id)}${emp.phone ? ' • ' + esc(emp.phone) : ''}</div></td>
                <td><span class="chip chip-blue">${esc(rLabel)}</span></td>
                <td style="font-size:11.5px; color:var(--text-muted);">${esc(perms || 'None')}</td>
                <td><span class="chip ${emp.active ? 'chip-green' : 'chip-red'}">${emp.active ? 'Active' : 'Disabled'}</span></td>
                <td style="text-align:right; white-space:nowrap;">
                  <button type="button" class="btn btn-sm" data-staff-edit="${esc(emp.id)}">Edit</button>
                  <button type="button" class="btn btn-sm" data-staff-toggle="${esc(emp.id)}">${emp.active ? 'Disable' : 'Enable'}</button>
                  <button type="button" class="btn btn-sm btn-danger" data-staff-del="${esc(emp.id)}">Del</button>
                </td>
              </tr>`;
            })
            .join('')
        : '<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:16px;">No staff accounts yet. Add an Admin account first to enable ID &amp; Password login.</td></tr>';
    }

    applyRolePermissions();

    const logs = App.Security.getAuditLog();
    $('audit-count-pill').textContent = logs.length;
    $('audit-log-box').innerHTML = logs.length
      ? logs
          .slice(0, 40)
          .map(
            (r) => `
        <div class="audit-row">
          <div><span class="chip ${/FAIL|DUP|DELETE|CLEAR/.test(r.type) ? 'chip-red' : 'chip-neutral'}" style="margin-right:6px;">${esc(r.type)}</span>${esc(r.detail)}</div>
          <span class="mono" style="color:var(--text-muted); font-size:10.5px; flex-shrink:0;">${esc(App.Aging.formatDateTime(r.ts))}</span>
        </div>
      `
          )
          .join('')
      : `<div class="empty-state" style="padding:16px;">No audit events yet.</div>`;
  }

  // =========================================================================
  // Upload Sheet Preview Renderer (CSV & Excel — Trax / Leopards)
  // =========================================================================
  function renderCSVPreview() {
    if (!ui.pendingCSVRows.length) {
      $('csv-preview-panel').style.display = 'none';
      return;
    }

    const updateExisting = $('chk-csv-update-existing').checked;
    const skipCancelled = $('chk-csv-skip-cancelled').checked;
    const existingMap = new Map();
    App.Storage.getParcels().forEach((p) => {
      existingMap.set(App.Couriers.normalizeTracking(p.trackingNumber), p);
    });
    const seen = new Set();

    let newCnt = 0;
    let updCnt = 0;
    let skipCnt = 0;
    const previewRows = [];

    ui.pendingCSVRows.forEach((r) => {
      const cn = App.Couriers.normalizeTracking(r.trackingNumber);
      let effectiveStatus = r.status || 'In Transit';
      if (ui.sheetMode === 'load_sheet' && !['Delivered', 'Cancelled', 'Returned & Verified'].includes(effectiveStatus)) {
        effectiveStatus = 'Booked / Pickup';
      } else if (ui.sheetMode === 'receiving_sheet' && !['Delivered', 'Cancelled', 'Returned & Verified'].includes(effectiveStatus)) {
        effectiveStatus = 'In Transit';
      }

      let actionTag = 'New';
      let actionCls = 'chip-green';

      if (!cn || seen.has(cn) || (skipCancelled && effectiveStatus === 'Cancelled')) {
        skipCnt++;
        actionTag = skipCancelled && effectiveStatus === 'Cancelled' ? 'Skip Cancel' : 'Skip Dup';
        actionCls = 'chip-neutral';
      } else {
        seen.add(cn);
        const ex = existingMap.get(cn);
        if (ex) {
          if (updateExisting) {
            updCnt++;
            actionTag = 'Update';
            actionCls = 'chip-blue';
          } else {
            skipCnt++;
            actionTag = 'Skip Dup';
            actionCls = 'chip-amber';
          }
        } else {
          newCnt++;
        }
      }

      if (previewRows.length < 60) {
        previewRows.push({ r, effectiveStatus, actionTag, actionCls });
      }
    });

    $('csv-detected-format').textContent = ui.pendingCSVFormat || 'Sheet Ready';
    $('csv-preview-summary').textContent = `+${newCnt} new • ${updCnt} update • ${skipCnt} skipped (${ui.pendingCSVRows.length} rows)`;

    const extraNote =
      ui.pendingCSVRows.length > 60
        ? `<tr><td colspan="7" style="text-align:center; font-size:12px; color:var(--text-muted); padding:12px;">Showing first 60 of ${ui.pendingCSVRows.length} rows — click Import Sheet to process all.</td></tr>`
        : '';

    $('csv-preview-tbody').innerHTML =
      previewRows
        .map(
          ({ r, effectiveStatus, actionTag, actionCls }) => `
        <tr>
          <td><span class="chip ${actionCls}">${esc(actionTag)}</span></td>
          <td>
            <div class="mono" style="font-weight:600; font-size:12.5px;">${esc(r.trackingNumber)}</div>
            <div style="font-size:11px; color:var(--text-muted);">${esc(r.orderId || '—')}</div>
          </td>
          <td><span class="chip ${r.courier === 'Trax' ? 'chip-blue' : 'chip-amber'}">${esc(r.courier)}</span></td>
          <td>
            <div style="font-size:12px; max-width:190px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${esc(r.itemDescription || '')}">${esc(r.itemDescription || '—')}</div>
          </td>
          <td>
            <div style="font-size:12.5px; max-width:170px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(r.customerName || '—')}</div>
            <div style="font-size:11px; color:var(--text-muted);">${esc(r.destinationCity || '')}</div>
          </td>
          <td><span class="chip chip-neutral">${esc(effectiveStatus)}</span></td>
          <td class="mono" style="font-size:12px;">${r.codAmount ? 'Rs. ' + Number(r.codAmount).toLocaleString() : '—'}</td>
          <td class="mono" style="font-size:12px;">${esc(r.dispatchDate)}</td>
        </tr>
      `
        )
        .join('') + extraNote;

    $('csv-preview-panel').style.display = 'block';
  }

  // =========================================================================
  // Quick Gate Intake
  // =========================================================================
  function updateGateInputFeedback() {
    const raw = $('inp-gate-cn').value;
    const cn = App.Couriers.normalizeTracking(raw);
    const shell = $('gate-awb-shell');
    const chip = $('gate-status-chip');
    const sel = $('inp-gate-courier');

    const existing = cn.length >= 5 ? App.Storage.findByTracking(cn) : null;

    if (ui.gateMode === 'dispatch' && existing && existing.status === 'Booked / Pickup') {
      shell.classList.remove('dup-error');
      chip.className = 'chip chip-green';
      chip.textContent = 'Pending → Scan to Process';
      $('gate-detect-hint').textContent = 'Booked in Load Sheet — scan/save to move into Processing';
      if ([...sel.options].some((o) => o.value === existing.courier)) sel.value = existing.courier;
      return;
    }

    if ((ui.gateMode === 'dispatch' || ui.gateMode === 'booked') && existing) {
      shell.classList.add('dup-error');
      chip.className = 'chip chip-red';
      chip.textContent = `DUPLICATE (${existing.status})`;
      $('gate-detect-hint').textContent = `Already logged on ${App.Aging.formatDisplayDate(existing.dispatchDate)}`;
      return;
    }

    if (ui.gateMode === 'return' && existing && existing.status === 'Returned & Verified') {
      shell.classList.add('dup-error');
      chip.className = 'chip chip-red';
      chip.textContent = 'ALREADY RETURNED!';
      $('gate-detect-hint').textContent = `Scanned on ${App.Aging.formatDateTime(existing.returnedAt)}`;
      return;
    }

    shell.classList.remove('dup-error');
    const det = App.Couriers.detectCourier(cn, App.Storage.getState().customCouriers);
    if (det.confidence === 'none') {
      chip.className = 'chip chip-blue';
      chip.textContent = 'Auto';
      $('gate-detect-hint').textContent = 'Auto-detect courier';
      return;
    }

    if (!ui.gateManualCourier && det.courier && [...sel.options].some((o) => o.value === det.courier)) {
      sel.value = det.courier;
    }
    chip.className = 'chip chip-blue';
    chip.textContent = `Detected: ${sel.value}`;
    $('gate-detect-hint').textContent = det.reason;
  }

  function showGateDupBanner(title, sub, cn) {
    ui.lastDupCN = cn;
    $('gate-dup-title').textContent = title;
    $('gate-dup-sub').textContent = sub;
    $('gate-dup-banner').style.display = 'flex';
  }

  function processGateSubmit(e) {
    if (e) e.preventDefault();
    const raw = $('inp-gate-cn').value.trim();
    if (!raw) return;

    if (ui.gateMode === 'return') {
      handleReturnScan(raw, true);
      $('inp-gate-cn').value = '';
      updateGateInputFeedback();
      $('inp-gate-cn').focus();
      return;
    }

    const targetStatus = ui.gateMode === 'booked' ? 'Booked / Pickup' : 'In Transit';
    const res = App.Storage.addParcel({
      trackingNumber: raw,
      courier: $('inp-gate-courier').value,
      orderId: $('inp-gate-order').value,
      dispatchDate: $('inp-gate-date').value || App.Aging.getTodayISO(),
      customerName: $('inp-gate-customer').value,
      customerPhone: $('inp-gate-phone').value,
      itemDescription: $('inp-gate-product') ? $('inp-gate-product').value : '',
      status: targetStatus
    });

    if (!res.ok) {
      App.Audio.playDuplicateBuzz();
      flashScreen('flash-red');
      if (res.duplicate && res.existing) {
        const ex = res.existing;
        showGateDupBanner(
          `DOUBLE ENTRY BLOCKED (${ex.trackingNumber})`,
          `Already logged on ${App.Aging.formatDisplayDate(ex.dispatchDate)} • Status: ${ex.status} (Attempt #${res.attemptCount})`,
          ex.trackingNumber
        );
        pushIntakeEvent({
          cn: ex.trackingNumber,
          courier: ex.courier,
          sub: `Duplicate blocked (Attempt #${res.attemptCount})`,
          status: 'Duplicate',
          chipCls: 'chip-red',
          time: nowClock(),
          isDup: true
        });
      }
      toast(res.error, 'error');
      $('inp-gate-cn').select();
      renderAll();
      return;
    }

    $('gate-dup-banner').style.display = 'none';
    App.Audio.playDispatchTick();
    flashScreen('flash-green');
    const feedStatus = res.promotedFromBooked
      ? 'Processing'
      : targetStatus === 'Booked / Pickup'
      ? 'Pending'
      : 'Processing';
    const feedSub = res.promotedFromBooked
      ? `${res.parcel.customerName || res.parcel.orderId} • Load Sheet → Processing`
      : `${res.parcel.customerName || res.parcel.orderId} • ${targetStatus === 'Booked / Pickup' ? 'Pending Load' : 'Processing'}`;
    pushIntakeEvent({
      cn: res.parcel.trackingNumber,
      courier: res.parcel.courier,
      sub: feedSub,
      status: feedStatus,
      chipCls: targetStatus === 'Booked / Pickup' ? 'chip-amber' : 'chip-green',
      time: nowClock(),
      isDup: false
    });
    toast(
      res.promotedFromBooked
        ? `Moved to Processing: ${res.parcel.trackingNumber}`
        : `${targetStatus === 'Booked / Pickup' ? 'Pending' : 'Processing'}: ${res.parcel.trackingNumber}`,
      'success'
    );
    autoTrackParcelInBackground(res.parcel);

    $('inp-gate-cn').value = '';
    $('inp-gate-order').value = '';
    $('inp-gate-customer').value = '';
    $('inp-gate-phone').value = '';
    ui.gateManualCourier = false;
    ui.page = 1;
    updateGateInputFeedback();
    renderAll();
    $('inp-gate-cn').focus();
  }

  // =========================================================================
  // Return Scanner
  // =========================================================================
  function updateReturnCamUI(running, caps) {
    $('btn-start-return-cam').style.display = running ? 'none' : 'inline-flex';
    $('btn-stop-return-cam').style.display = running ? 'inline-flex' : 'none';
    $('return-camera-placeholder').style.display = running ? 'none' : 'flex';
    $('return-camera-stage').classList.toggle('active', running);

    const c = caps || App.Scanner.getCapabilities();
    $('btn-return-torch').style.display = running && c.torchSupported ? 'inline-flex' : 'none';
    $('btn-return-torch').textContent = c.torchOn ? 'Flash ON' : 'Flash';
    $('btn-return-zoom').style.display = running && c.zoomSupported ? 'inline-flex' : 'none';
    $('btn-return-zoom').textContent = `${c.currentZoom || 1}x`;
    const mode = App.Scanner.getScanMode ? App.Scanner.getScanMode() : 'auto';
    const facing = App.Scanner.getCameraFacing ? App.Scanner.getCameraFacing() : 'environment';
    const modeLbl = mode === 'qr' ? 'QR' : mode === 'barcode' ? '1D' : 'QR+1D';
    const facingLbl = facing === 'user' ? 'Cam: Front' : 'Cam: Back';
    if ($('btn-return-scan-mode')) $('btn-return-scan-mode').textContent = modeLbl;
    if ($('btn-gate-scan-mode')) $('btn-gate-scan-mode').textContent = modeLbl;
    if ($('btn-return-cam-facing')) $('btn-return-cam-facing').textContent = facingLbl;
    if ($('btn-gate-cam-facing')) $('btn-gate-cam-facing').textContent = facingLbl;
    $('scanner-engine-lbl').textContent = running
      ? c.nativeAccelerated
        ? `FAST-${modeLbl} • 25 FPS`
        : `LIVE ${modeLbl} • 720P 25 FPS`
      : `READY • ${modeLbl} OPTICAL`;
  }

  function renderReturnSession() {
    $('sess-valid').textContent = ui.session.valid;
    if ($('live-scan-count')) $('live-scan-count').textContent = ui.session.valid;
    $('sess-dup').textContent = ui.session.dup;
    $('sess-leopards').textContent = ui.session.leopards;
    $('sess-trax').textContent = ui.session.trax;
    const box = $('return-scan-stream');
    if (ui.session.log.length === 0) return;
    box.innerHTML = ui.session.log
      .map(
        (it) => `
      <div class="feed-row ${it.isDup ? 'is-dup' : ''}">
        <div style="min-width:0;">
          <div class="mono" style="font-weight:600;">${esc(it.cn)}</div>
          <div style="font-size:11.5px; color:${it.isDup ? 'var(--red-text)' : 'var(--text-muted)'};">${esc(it.detail)}</div>
        </div>
        <div style="text-align:right; flex-shrink:0;">
          <span class="chip ${it.chipCls}">${esc(it.tag)}</span>
          <div class="mono" style="font-size:10.5px; color:var(--text-muted); margin-top:2px;">${esc(it.time)}</div>
        </div>
      </div>
    `
      )
      .join('');
  }

  function handleReturnScan(rawCode, fromOverviewGate) {
    const condEl = $('inp-return-condition');
    const returnReason = condEl ? condEl.value : 'Sealed / Intact Return';
    const res = App.Storage.processReturnScan(rawCode, {
      returnReason,
      returnPhoto: ui.pendingReturnPhoto || ''
    });
    if (res.outcome === 'empty') return;
    const t = nowClock();
    const fbCard = $('scan-feedback-card');

    if (res.outcome === 'valid') {
      const p = res.parcel;
      ui.pendingReturnPhoto = '';
      if ($('return-photo-preview')) $('return-photo-preview').style.display = 'none';
      if ($('return-photo-lbl')) $('return-photo-lbl').textContent = 'Attach Proof Photo';
      if ($('inp-return-photo')) $('inp-return-photo').value = '';
      App.Audio.playSuccess();
      flashScreen('flash-green');
      $('gate-dup-banner').style.display = 'none';
      ui.session.valid++;
      if (p.courier.toLowerCase().includes('leopard')) ui.session.leopards++;
      if (p.courier.toLowerCase().includes('trax')) ui.session.trax++;

      fbCard.className = 'scan-feedback-card valid';
      $('scan-fb-title').textContent = `VALID RETURN — ${p.trackingNumber}`;
      $('scan-fb-sub').textContent = `${p.courier} • ${p.orderId || 'N/A'}${p.itemDescription ? ' • ' + p.itemDescription : ''} • ${p.returnReason || 'Sealed'}`;

      ui.session.log.unshift({ cn: p.trackingNumber, detail: `${p.courier} • ${p.returnReason || 'Verified Return'}`, tag: p.claimStatus && p.claimStatus !== 'None' ? 'CLAIM' : 'OK', chipCls: p.claimStatus && p.claimStatus !== 'None' ? 'chip-red' : 'chip-green', time: t, isDup: false });
      pushIntakeEvent({ cn: p.trackingNumber, courier: p.courier, sub: `${p.returnReason || 'Physical return verified'}`, status: 'Returned', chipCls: 'chip-purple', time: t, isDup: false });
      if (fromOverviewGate) toast(`Return Verified: ${p.trackingNumber}`, 'success');
      renderReturnSession();
      renderAll();
    } else if (res.outcome === 'duplicate') {
      const p = res.parcel;
      const when = App.Aging.formatDateTime(p.returnedAt);
      App.Audio.playDuplicateBuzz();
      flashScreen('flash-red');
      ui.session.dup++;

      fbCard.className = 'scan-feedback-card duplicate';
      $('scan-fb-title').textContent = `ALREADY SCANNED on ${when} (Attempt #${res.attemptCount || 2})`;
      $('scan-fb-sub').textContent = `DUPLICATE RETURN BLOCKED: ${p.trackingNumber} (${p.courier})`;

      if (fromOverviewGate) {
        showGateDupBanner(`DUPLICATE RETURN SCAN (${p.trackingNumber})`, `ALREADY SCANNED on ${when} (Attempt #${res.attemptCount || 2})`, p.trackingNumber);
      }
      ui.session.log.unshift({ cn: p.trackingNumber, detail: `Duplicate! Already scanned ${when}`, tag: 'DUPLICATE', chipCls: 'chip-red', time: t, isDup: true });
      pushIntakeEvent({ cn: p.trackingNumber, courier: p.courier, sub: `Already scanned on ${when}`, status: 'Duplicate', chipCls: 'chip-red', time: t, isDup: true });
      toast(`ALREADY SCANNED on ${when}`, 'error');
      renderReturnSession();
      renderAll();
    } else if (res.outcome === 'unknown') {
      App.Audio.playUnknownChime();
      flashScreen('flash-yellow');
      fbCard.className = 'scan-feedback-card unknown';
      $('scan-fb-title').textContent = `UNKNOWN PARCEL — ${res.trackingNumber}`;
      $('scan-fb-sub').textContent = 'Not found in ledger. Confirm popup to log as unrecorded return.';

      ui.pendingUnknownCN = res.trackingNumber;
      $('unknown-tracking-display').textContent = res.trackingNumber;
      syncCourierControls();
      if (res.detectedCourier) $('inp-unknown-courier').value = res.detectedCourier;
      $('inp-unknown-order').value = '';
      $('modal-unknown-parcel').classList.add('open');
    }
  }

  function handleDispatchScan(rawCode) {
    const res = App.Storage.processDispatchScan(rawCode);
    if (res.outcome === 'empty') return;
    const t = nowClock();
    const fbCard = $('scan-feedback-card');

    if (res.outcome === 'valid') {
      const p = res.parcel;
      App.Audio.playDispatchTick();
      flashScreen('flash-green');
      ui.session.valid++;
      if (p.courier.toLowerCase().includes('leopard')) ui.session.leopards++;
      if (p.courier.toLowerCase().includes('trax')) ui.session.trax++;

      fbCard.className = 'scan-feedback-card valid';
      $('scan-fb-title').textContent = `PROCESSING — ${p.trackingNumber}`;
      $('scan-fb-sub').textContent = `Load Sheet → Processing • ${p.courier} • ${p.orderId || 'N/A'}`;

      ui.session.log.unshift({ cn: p.trackingNumber, detail: `${p.courier} • Load → Processing`, tag: 'PROCESSING', chipCls: 'chip-green', time: t, isDup: false });
      pushIntakeEvent({ cn: p.trackingNumber, courier: p.courier, sub: 'Load Sheet → Processing', status: 'Processing', chipCls: 'chip-green', time: t, isDup: false });
      renderReturnSession();
      renderAll();
      autoTrackParcelInBackground(p);
    } else if (res.outcome === 'duplicate') {
      const p = res.parcel;
      App.Audio.playDuplicateBuzz();
      flashScreen('flash-red');
      ui.session.dup++;

      fbCard.className = 'scan-feedback-card duplicate';
      $('scan-fb-title').textContent = `ALREADY ${String(p.status || 'DISPATCHED').toUpperCase()} — ${p.trackingNumber}`;
      $('scan-fb-sub').textContent = `Duplicate dispatch scan blocked (${p.courier})`;

      ui.session.log.unshift({ cn: p.trackingNumber, detail: `Already ${p.status}`, tag: 'DUPLICATE', chipCls: 'chip-red', time: t, isDup: true });
      toast(`Already ${p.status}: ${p.trackingNumber}`, 'error');
      renderReturnSession();
      renderAll();
    } else if (res.outcome === 'unknown') {
      App.Audio.playUnknownChime();
      flashScreen('flash-yellow');
      fbCard.className = 'scan-feedback-card unknown';
      $('scan-fb-title').textContent = `NOT IN LOAD SHEET — ${res.trackingNumber}`;
      $('scan-fb-sub').textContent = 'Upload Load Sheet first or add via Orders → New Order.';
      toast(`Not in Load Sheet: ${res.trackingNumber}`, 'warning');
    }
  }

  function handleScannerCapture(rawCode) {
    if (ui.scannerMode === 'dispatch') handleDispatchScan(rawCode);
    else handleReturnScan(rawCode, false);
  }

  function autoTrackParcelInBackground(parcel) {
    if (!parcel || !App.TrackingAPI || !App.TrackingAPI.hasLiveCredentials(parcel.courier)) return;
    if (!App.TrackingAPI.loadConfig().autoLiveTrackEnabled) return;
    if (!['In Transit', 'Return In Transit'].includes(parcel.status)) return;
    App.TrackingAPI.trackParcel(parcel.trackingNumber, parcel.courier, parcel)
      .then((r) => {
        if (r && r.ok) renderAll();
      })
      .catch(() => {});
  }

  // =========================================================================
  // Slide-Over Live Tracking & Inspection Drawer
  // =========================================================================
  function renderTimeline(checkpoints) {
    if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
      return `<div style="font-size:12px; color:var(--text-muted);">No live checkpoints available yet.</div>`;
    }
    return checkpoints
      .map(
        (cp) => `
      <div class="timeline-step">
        <span class="timeline-dot"></span>
        <div style="display:flex; justify-content:space-between; gap:8px;">
          <strong style="font-size:12.5px;">${esc(cp.status)}</strong>
          <span class="mono" style="font-size:11px; color:var(--text-muted); flex-shrink:0;">${esc(cp.timestamp || '')}</span>
        </div>
        <div style="font-size:11.5px; color:var(--text-secondary); margin-top:2px;">${esc(cp.location || '')}${cp.detail ? ' — ' + esc(cp.detail) : ''}</div>
      </div>
    `
      )
      .join('');
  }

  async function openTrackingDrawer(rawCN, courierHint) {
    const cn = App.Couriers.normalizeTracking(rawCN);
    if (!cn) return;
    const p = App.Storage.findByTracking(cn);
    const courier =
      courierHint ||
      (p && p.courier) ||
      App.Couriers.detectCourier(cn, App.Storage.getState().customCouriers).courier ||
      'Trax';

    ui.activeDrawerCN = cn;
    ui.activeDrawerCourier = courier;

    $('drawer-cn').textContent = cn;
    $('drawer-courier-chip').textContent = courier;
    $('drawer-route-tag').textContent = p && p.destinationCity ? `Faisalabad → ${p.destinationCity}` : 'Syncing...';
    $('drawer-client-name').textContent = (p && p.customerName) || 'Fetching live details...';
    $('drawer-client-sub').textContent = p
      ? [p.orderId, p.customerPhone, p.address || p.destinationCity].filter(Boolean).join(' • ')
      : 'External CN lookup';

    // Show local contact buttons + sheet COD/Status pills immediately!
    const localDigits = String((p && p.customerPhone) || '').replace(/[^\d]/g, '');
    if (localDigits) {
      const wa = localDigits.startsWith('0') ? '92' + localDigits.slice(1) : localDigits;
      const waText = encodeURIComponent(
        `Assalam o Alaikum ${(p && p.customerName) || ''}, aapka REED order ${(p && p.orderId) || ''}${p && p.itemDescription ? ' (' + p.itemDescription + ')' : ''} via ${courier} (CN: ${cn}) ke baray mein follow-up hai. Shukriya!`
      );
      $('drawer-contact-btns').innerHTML = `
        <a href="tel:${esc(localDigits)}" class="btn btn-sm">Call</a>
        <a href="https://wa.me/${esc(wa)}?text=${waText}" target="_blank" rel="noopener noreferrer" class="btn btn-sm btn-primary">WhatsApp</a>
      `;
    } else {
      $('drawer-contact-btns').innerHTML = '';
    }

    const initPills = [];
    if (p && p.itemDescription) initPills.push(`<span class="chip chip-green">${esc(p.itemDescription)}</span>`);
    if (p && p.codAmount) initPills.push(`<span class="chip chip-blue">COD Rs. ${Number(p.codAmount).toLocaleString()}</span>`);
    if (p && p.courierStatus) initPills.push(`<span class="chip chip-neutral">${esc(p.courierStatus)}</span>`);
    if (p && p.returnReason) {
      const isClaim = p.claimStatus && p.claimStatus !== 'None';
      initPills.push(`<span class="chip ${isClaim ? 'chip-red' : 'chip-purple'}">${esc(p.returnReason)}${isClaim ? ' • ' + esc(p.claimStatus) : ''}</span>`);
    }
    if (p && p.returnPhoto) {
      initPills.push(`<a href="${p.returnPhoto}" target="_blank" rel="noopener noreferrer" style="display:inline-flex; align-items:center; gap:5px; font-size:11.5px; font-weight:600; color:var(--blue-text);"><img src="${p.returnPhoto}" alt="Claim Proof" style="width:26px; height:26px; border-radius:6px; object-fit:cover; border:1px solid var(--border-subtle);" /> View Claim Photo</a>`);
    }
    if (initPills.length) {
      $('drawer-fin-strip').style.display = 'flex';
      $('drawer-fin-strip').innerHTML = initPills.join('');
    } else {
      $('drawer-fin-strip').style.display = 'none';
    }

    $('drawer-error-banner').style.display = 'none';
    $('drawer-trax-actions').style.display = 'none';
    $('drawer-timeline').innerHTML = `<div style="font-size:12px; color:var(--text-muted);">Querying ${esc(courier)} Live API...</div>`;
    $('drawer-official-link').href = App.TrackingAPI.getOfficialPortalUrl(courier, cn);

    const canAct = Boolean(p && ['Booked / Pickup', 'In Transit', 'Return In Transit'].includes(p.status));
    $('btn-drawer-deliver').style.display = canAct ? 'inline-flex' : 'none';
    $('btn-drawer-return').style.display = canAct ? 'inline-flex' : 'none';

    $('tracking-drawer').classList.add('open');

    const res = await App.TrackingAPI.trackParcel(cn, courier, p);

    if (!res.ok) {
      $('drawer-route-tag').textContent = (p && p.destinationCity) ? `→ ${p.destinationCity}` : res.missingCredentials ? 'API Key Needed' : 'API Notice';
      $('drawer-error-banner').style.display = 'flex';
      $('drawer-error-banner').innerHTML = `
        <span>${esc(res.error)}</span>
        <button type="button" class="btn btn-sm btn-primary" id="btn-drawer-api-setup">Settings</button>
      `;
      const btn = $('btn-drawer-api-setup');
      if (btn) btn.addEventListener('click', () => { closeDrawer(); switchView('settings'); });

      if (p && p.liveSource === 'live' && Array.isArray(p.trackingHistory) && p.trackingHistory.length) {
        $('drawer-timeline').innerHTML = renderTimeline(p.trackingHistory);
      } else {
        $('drawer-timeline').innerHTML = `<div style="font-size:12px; color:var(--text-muted);">Sheet Status: <strong>${esc((p && (p.courierStatus || p.status)) || 'Saved locally')}</strong></div>`;
      }
      return;
    }

    const d = res.data;
    $('drawer-route-tag').textContent = `${d.origin} → ${d.destination}`;
    $('drawer-client-name').textContent = d.consignee || (p && p.customerName) || 'Consignee';
    $('drawer-client-sub').textContent = [d.orderId || (p && p.orderId), d.consigneePhone || (p && p.customerPhone), d.consigneeAddress || (p && p.address)].filter(Boolean).join(' • ');

    const digits = String(d.consigneePhone || (p && p.customerPhone) || '').replace(/[^\d]/g, '');
    if (digits) {
      const wa = digits.startsWith('0') ? '92' + digits.slice(1) : digits;
      $('drawer-contact-btns').innerHTML = `
        <a href="tel:${esc(digits)}" class="btn btn-sm">Call</a>
        <a href="https://wa.me/${esc(wa)}" target="_blank" rel="noopener noreferrer" class="btn btn-sm btn-primary">WhatsApp</a>
      `;
    }

    const pills = [];
    if (d.codAmount) pills.push(`<span class="chip chip-blue">${esc(d.codAmount)}</span>`);
    else if (p && p.codAmount) pills.push(`<span class="chip chip-blue">COD Rs. ${Number(p.codAmount).toLocaleString()}</span>`);
    if (d.shippingMode) pills.push(`<span class="chip chip-neutral">${esc(d.shippingMode)}</span>`);
    if (d.paymentStatus) pills.push(`<span class="chip chip-green">${esc(d.paymentStatus)}</span>`);
    if (d.charges && d.charges.total_charges) pills.push(`<span class="chip chip-neutral">Charges: Rs. ${esc(d.charges.total_charges)}</span>`);
    if (pills.length) {
      $('drawer-fin-strip').style.display = 'flex';
      $('drawer-fin-strip').innerHTML = pills.join('');
    }

    if (d.courier.toLowerCase().includes('trax') && App.TrackingAPI.hasLiveCredentials('Trax')) {
      $('drawer-trax-actions').style.display = 'block';
    }

    $('drawer-timeline').innerHTML = renderTimeline(d.checkpoints);
    renderAll();
  }

  function closeDrawer() {
    $('tracking-drawer').classList.remove('open');
  }

  async function runBulkLiveSync() {
    if (ui.isSyncing) return;
    ui.isSyncing = true;
    $('topbar-sync-icon').classList.add('spin');
    $('topbar-sync-label').textContent = 'Syncing';

    let cloudMsg = '';
    if (App.CloudSync) {
      const sc = App.CloudSync.loadConfig();
      if (sc.enabled && sc.endpointUrl) {
        const cRes = await App.CloudSync.syncWithCloud('manual');
        cloudMsg = cRes.ok ? `Cloud synced (${cRes.count})` : `Cloud error: ${cRes.error}`;
      } else if (App.CloudSync.hasLocalDiskBackend()) {
        await App.CloudSync.saveToLocalDisk();
      }
    }

    const res = await App.TrackingAPI.syncAllInTransit();
    ui.isSyncing = false;
    $('topbar-sync-icon').classList.remove('spin');
    renderAll();

    if (res.corsError) toast('Launch MM-VIRSA-Ops.exe for zero-CORS live sync!', 'error');
    else if (res.synced > 0) toast(`Live Synced ${res.synced}/${res.total} shipments${cloudMsg ? ' • ' + cloudMsg : ''}`, 'success');
    else if (cloudMsg) toast(cloudMsg, cloudMsg.includes('error') ? 'error' : 'success');
    else if (res.total === 0) toast('Synced cleanly.', 'success');
    else if (res.skippedNoKey > 0) {
      toast('Add your Trax / Leopards API Key in Settings to live-track couriers.', 'warning');
      switchView('settings');
    } else toast(res.lastError || 'Sync completed.', 'error');
  }

  // =========================================================================
  // Admin PIN Guard & Edit Modal
  // =========================================================================
  function requireAdminPin(label, fn) {
    if (!App.Security || !App.Security.needsAdminVerification()) return fn();
    ui.pendingAdminAction = fn;
    $('admin-pin-prompt-text').textContent = `Enter Admin PIN to confirm: ${label}`;
    $('admin-pin-error').textContent = '';
    $('inp-admin-verify-pin').value = '';
    $('modal-admin-pin').classList.add('open');
    setTimeout(() => $('inp-admin-verify-pin').focus(), 50);
  }

  function openEditModal(id) {
    const p = App.Storage.findById(id);
    if (!p) return;
    syncCourierControls();
    $('edit-parcel-id').value = p.id;
    $('edit-tracking').value = p.trackingNumber;
    $('edit-order-id').value = p.orderId || '';
    $('edit-courier').value = p.courier;
    $('edit-dispatch-date').value = p.dispatchDate;
    $('edit-status').value = p.status;
    $('edit-customer-name').value = p.customerName || '';
    $('edit-customer-phone').value = p.customerPhone || '';
    $('edit-cod-amount').value = p.codAmount || '';
    if ($('edit-product')) $('edit-product').value = p.itemDescription || p.notes || '';
    $('edit-notes').value = p.notes || '';
    $('modal-edit-parcel').classList.add('open');
  }

  // =========================================================================
  // Event Binding
  // =========================================================================
  function bindEvents() {
    document.querySelectorAll('[data-nav]').forEach((b) =>
      b.addEventListener('click', () => switchView(b.getAttribute('data-nav')))
    );
    document.querySelectorAll('[data-nav-jump]').forEach((b) =>
      b.addEventListener('click', () => switchView(b.getAttribute('data-nav-jump')))
    );
    document.querySelectorAll('[data-jump-status]').forEach((b) =>
      b.addEventListener('click', () => {
        const st = b.getAttribute('data-jump-status');
        switchView('overview');
        setStatusTab(st);
      })
    );
    $('btn-dash-new-order').addEventListener('click', () => {
      switchView('overview');
      setGateDrawerOpen(true, true);
    });

    // Smooth Topbar Refresh
    $('btn-topbar-refresh').addEventListener('click', async () => {
      const btn = $('btn-topbar-refresh');
      const bar = $('refresh-progress-bar');
      const main = document.querySelector('.main-content');
      if (btn.classList.contains('is-refreshing')) return;

      btn.classList.add('is-refreshing');
      if (bar) bar.classList.add('active');
      if (main) {
        main.classList.remove('is-refreshing');
        void main.offsetWidth;
        main.classList.add('is-refreshing');
      }

      const startTs = Date.now();
      try {
        if (App.CloudSync) {
          if (App.CloudSync.hasLocalDiskBackend()) await App.CloudSync.loadFromLocalDisk();
          const sc = App.CloudSync.loadConfig();
          if (sc.enabled && sc.endpointUrl) await App.CloudSync.syncWithCloud('refresh');
        }
        App.Storage.load();
        renderAll();
      } catch (_) {}

      const wait = Math.max(0, 620 - (Date.now() - startTs));
      setTimeout(() => {
        btn.classList.remove('is-refreshing');
        if (bar) bar.classList.remove('active');
        toast('Refreshed', 'success');
      }, wait);
    });

    $('btn-topbar-sync').addEventListener('click', runBulkLiveSync);

    // Bell Dropdown
    $('btn-notif-bell').addEventListener('click', (e) => {
      e.stopPropagation();
      $('notif-dropdown').classList.toggle('open');
    });
    $('btn-close-notif').addEventListener('click', () => $('notif-dropdown').classList.remove('open'));
    $('btn-goto-alerts-bell').addEventListener('click', () => switchView('alerts'));
    document.addEventListener('click', (e) => {
      const dd = $('notif-dropdown');
      if (dd.classList.contains('open') && !dd.contains(e.target) && !e.target.closest('#btn-notif-bell')) {
        dd.classList.remove('open');
      }
    });

    // Demo strip
    $('btn-dismiss-demo').addEventListener('click', () => { App.Storage.dismissSampleFlag(); renderAll(); });
    $('btn-clear-demo').addEventListener('click', () => { App.Storage.clearAllData(); renderAll(); toast('Cleared sample data.'); });

    // Orders KPI & Underline Tabs
    document.querySelectorAll('[data-kpi-filter]').forEach((c) =>
      c.addEventListener('click', () => setStatusTab(c.getAttribute('data-kpi-filter')))
    );
    $('status-underline-tabs').addEventListener('click', (e) => {
      const tab = e.target.closest('[data-status-tab]');
      if (!tab) return;
      setStatusTab(tab.getAttribute('data-status-tab'));
    });

    if ($('btn-view-shipper-returns')) {
      $('btn-view-shipper-returns').addEventListener('click', () => setStatusTab('rto'));
    }
    if ($('btn-confirm-shipper-returns')) {
      $('btn-confirm-shipper-returns').addEventListener('click', () => {
        const list = App.Storage.getUnconfirmedShipperReturns ? App.Storage.getUnconfirmedShipperReturns() : [];
        if (!list.length) return toast('No pending Delivered-to-Shipper returns found.', 'info');
        if (!global.confirm(`Confirm ${list.length} courier "Delivered to Shipper" returns as Returned & Verified?\n\n(Nayi aane wali returns hamesha Return Scanner se scan hongi.)`)) {
          return;
        }
        const res = App.Storage.confirmDeliveredToShipperReturns();
        renderAll();
        toast(`Confirmed ${res.count} Delivered-to-Shipper returns as Verified!`, 'success');
      });
    }

    // Pagination
    $('pagination-controls').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-page]');
      if (!btn || btn.disabled) return;
      const next = parseInt(btn.getAttribute('data-page'), 10);
      if (!isNaN(next) && next >= 1) {
        ui.page = next;
        renderLedger(App.Storage.getParcels());
        global.scrollTo({ top: 180, behavior: 'smooth' });
      }
    });

    // Quick Gate Drawer Toggle
    $('btn-toggle-gate').addEventListener('click', () => setGateDrawerOpen(!ui.gateOpen, true));
    $('btn-close-gate-box').addEventListener('click', () => setGateDrawerOpen(false, false));

    document.querySelectorAll('[data-gate-mode]').forEach((b) =>
      b.addEventListener('click', () => {
        ui.gateMode = b.getAttribute('data-gate-mode');
        document.querySelectorAll('[data-gate-mode]').forEach((x) => x.classList.toggle('active', x === b));
        $('gate-submit-label').textContent = ui.gateMode === 'return' ? 'Verify' : ui.gateMode === 'booked' ? 'Book' : 'Save';
        $('inp-gate-cn').placeholder =
          ui.gateMode === 'return' ? 'Scan Return CN...' : ui.gateMode === 'booked' ? 'Scan Booked / Load CN...' : 'Scan or type Tracking CN...';
        updateGateInputFeedback();
        $('inp-gate-cn').focus();
      })
    );

    $('inp-gate-date').value = App.Aging.getTodayISO();
    $('inp-gate-cn').addEventListener('input', () => {
      if (!$('inp-gate-cn').value.trim()) ui.gateManualCourier = false;
      updateGateInputFeedback();
    });
    $('inp-gate-courier').addEventListener('change', () => {
      ui.gateManualCourier = true;
      updateGateInputFeedback();
    });
    $('btn-toggle-extra-fields').addEventListener('click', () => {
      const el = $('gate-extra-fields');
      const open = el.style.display === 'none';
      el.style.display = open ? 'block' : 'none';
      $('btn-toggle-extra-fields').textContent = open ? '− Details' : '+ Details';
    });
    $('gate-form').addEventListener('submit', processGateSubmit);
    $('btn-gate-dup-close').addEventListener('click', () => ($('gate-dup-banner').style.display = 'none'));
    $('btn-gate-dup-inspect').addEventListener('click', () => { if (ui.lastDupCN) openTrackingDrawer(ui.lastDupCN); });

    // Gate Camera Modal
    const startGateCam = async () => {
      $('gate-camera-error').textContent = '';
      await App.Scanner.start(
        'gate-camera-reader',
        async (code) => {
          await App.Scanner.stop();
          $('modal-gate-camera').classList.remove('open');
          $('inp-gate-cn').value = code;
          ui.gateManualCourier = false;
          updateGateInputFeedback();
          processGateSubmit();
        },
        (err) => ($('gate-camera-error').textContent = err),
        { cooldownMs: 1200 }
      );
    };
    $('btn-gate-camera').addEventListener('click', async () => {
      updateReturnCamUI(false);
      $('modal-gate-camera').classList.add('open');
      await startGateCam();
    });
    const cycleScanMode = () => {
      const cur = App.Scanner.getScanMode();
      const next = cur === 'auto' ? 'barcode' : cur === 'barcode' ? 'qr' : 'auto';
      App.Scanner.setScanMode(next);
    };
    const toggleCamFacing = () => {
      const next = App.Scanner.getCameraFacing() === 'user' ? 'environment' : 'user';
      App.Scanner.setCameraFacing(next);
    };
    $('btn-gate-scan-mode').addEventListener('click', async () => {
      cycleScanMode();
      updateReturnCamUI(false);
      if ($('modal-gate-camera').classList.contains('open')) {
        await startGateCam();
      }
    });
    $('btn-gate-cam-facing').addEventListener('click', async () => {
      toggleCamFacing();
      updateReturnCamUI(false);
      if ($('modal-gate-camera').classList.contains('open')) {
        await startGateCam();
      }
    });
    $('btn-close-gate-camera').addEventListener('click', async () => {
      await App.Scanner.stop();
      $('modal-gate-camera').classList.remove('open');
    });

    // Orders Search, Date Range, Page Size, Courier Filter & Export
    const applyDateRangeUI = (from, to) => {
      ui.dateFrom = from || '';
      ui.dateTo = to || '';
      ui.page = 1;
      if ($('dash-date-from')) $('dash-date-from').value = ui.dateFrom;
      if ($('dash-date-to')) $('dash-date-to').value = ui.dateTo;
      if ($('filter-date-from')) $('filter-date-from').value = ui.dateFrom;
      if ($('filter-date-to')) $('filter-date-to').value = ui.dateTo;
      renderAll();
    };

    document.querySelectorAll('[data-dash-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        ui.dashMode = btn.getAttribute('data-dash-mode') || 'dispatch_returns';
        document.querySelectorAll('[data-dash-mode]').forEach((b) => b.classList.toggle('active', b === btn));
        renderAll();
      });
    });

    document.querySelectorAll('[data-date-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const preset = btn.getAttribute('data-date-preset');
        const today = App.Aging.getTodayISO();
        if (preset === 'all') return applyDateRangeUI('', '');
        if (preset === 'today') return applyDateRangeUI(today, today);
        const days = preset === '7d' ? 6 : 29;
        const d = new Date();
        d.setDate(d.getDate() - days);
        const fromIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        applyDateRangeUI(fromIso, today);
      });
    });

    ['dash-date-from', 'filter-date-from'].forEach((id) => {
      if ($(id)) $(id).addEventListener('change', (e) => applyDateRangeUI(e.target.value, ui.dateTo));
    });
    ['dash-date-to', 'filter-date-to'].forEach((id) => {
      if ($(id)) $(id).addEventListener('change', (e) => applyDateRangeUI(ui.dateFrom, e.target.value));
    });

    if ($('dash-bar-chart')) {
      $('dash-bar-chart').addEventListener('click', (e) => {
        const col = e.target.closest('[data-bar-date]');
        if (!col) return;
        ui.selectedBarDate = col.getAttribute('data-bar-date') || '';
        renderAll();
      });
    }
    if ($('dash-bar-detail')) {
      $('dash-bar-detail').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-open-bar-date]');
        if (!btn) return;
        const dt = btn.getAttribute('data-open-bar-date');
        applyDateRangeUI(dt, dt);
        ui.statusTab = 'all';
        switchView('overview');
      });
    }
    if ($('filter-page-size')) {
      $('filter-page-size').addEventListener('change', (e) => {
        ui.pageSize = Number(e.target.value) || 50;
        ui.page = 1;
        renderLedger(App.Storage.getParcels());
      });
    }

    if ($('btn-close-audit-box')) {
      $('btn-close-audit-box').addEventListener('click', () => {
        if ($('dash-courier-audit-box')) $('dash-courier-audit-box').style.display = 'none';
      });
    }

    if ($('btn-dash-verify-courier')) {
      $('btn-dash-verify-courier').addEventListener('click', async () => {
        if (!App.TrackingAPI || !App.TrackingAPI.verifyCourierScans) return;
        const btn = $('btn-dash-verify-courier');
        const lbl = $('lbl-dash-verify-courier');
        btn.disabled = true;
        if (lbl) lbl.textContent = 'Checking Courier...';
        try {
          const res = await App.TrackingAPI.verifyCourierScans((done, total) => {
            if (lbl) lbl.textContent = `Checking ${done}/${total}...`;
          });
          if (!res.ok) {
            toast(res.error || 'Verification failed.', 'warning');
          } else {
            renderAll();
            const box = $('dash-courier-audit-box');
            const sumEl = $('dash-audit-summary');
            const chipsEl = $('dash-audit-chips');
            const listEl = $('dash-audit-list');
            if (box && chipsEl && listEl) {
              if (sumEl) {
                sumEl.textContent = `Checked ${res.checked} parcels against Courier API${res.skippedNoKey ? ' • ' + res.skippedNoKey + ' skipped (API key missing)' : ''}`;
              }
              chipsEl.innerHTML = `
                <span class="chip chip-green">Courier Updated: ${res.updated}</span>
                <span class="chip ${res.ourEndIssues.length ? 'chip-amber' : 'chip-neutral'}">Our End / Handover Gap: ${res.ourEndIssues.length}</span>
                <span class="chip ${res.courierEndIssues.length ? 'chip-red' : 'chip-neutral'}">Courier Issues: ${res.courierEndIssues.length}</span>
                <span class="chip ${res.missedLocalScans.length ? 'chip-blue' : 'chip-neutral'}">Missed Local Scan: ${res.missedLocalScans.length}</span>
              `;
              const allIssues = [
                ...res.ourEndIssues.map((x) => ({ ...x, cls: 'chip-amber' })),
                ...res.courierEndIssues.map((x) => ({ ...x, cls: 'chip-red' })),
                ...res.missedLocalScans.map((x) => ({ ...x, cls: 'chip-blue' }))
              ];
              listEl.innerHTML = allIssues.length
                ? allIssues
                    .map(
                      (it) => `<div class="feed-row">
                        <div style="min-width:0;">
                          <div style="display:flex; align-items:center; gap:7px; flex-wrap:wrap;">
                            <button type="button" class="cn-btn mono" data-action="track" data-cn="${esc(it.parcel.trackingNumber)}" data-courier="${esc(it.parcel.courier)}">${esc(it.parcel.trackingNumber)}</button>
                            <span class="chip ${it.cls}">${esc(it.side)}</span>
                            <span class="chip chip-neutral">${esc(it.parcel.courier)}</span>
                          </div>
                          <div style="font-size:12px; color:var(--text-secondary); margin-top:3px;">${esc(it.detail)}${it.parcel.itemDescription ? ' • ' + esc(it.parcel.itemDescription) : ''}</div>
                        </div>
                        <button type="button" class="btn btn-sm" data-action="track" data-cn="${esc(it.parcel.trackingNumber)}" data-courier="${esc(it.parcel.courier)}">Inspect</button>
                      </div>`
                    )
                    .join('')
                : '<div style="font-size:12.5px; color:var(--green-text); font-weight:600; padding:10px 4px;">All clear! Zero handover or courier issues found.</div>';
              box.style.display = 'block';
            }
            toast(`Verified ${res.checked} parcels (${res.updated} updated, ${res.ourEndIssues.length + res.courierEndIssues.length} issues)`, 'success');
          }
        } finally {
          btn.disabled = false;
          if (lbl) lbl.textContent = 'Verify Courier Scans';
        }
      });
    }

    $('filter-search').addEventListener('input', () => {
      ui.page = 1;
      renderLedger(App.Storage.getParcels());
    });
    $('filter-search').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const q = $('filter-search').value.trim();
        if (q.length >= 6) {
          e.preventDefault();
          openTrackingDrawer(q);
        }
      }
    });
    $('filter-courier').addEventListener('change', () => {
      ui.page = 1;
      renderLedger(App.Storage.getParcels());
    });
    $('btn-top-export-all').addEventListener('click', () => {
      const list = getFilteredParcels(App.Storage.getParcels());
      const res = App.CSV.exportReportCSV(list.length ? list : App.Storage.getParcels(), {
        courier: $('filter-courier').value || 'All',
        reportType: 'orders_export'
      });
      toast(res.ok ? `Exported ${res.count} orders` : 'No orders to export.', res.ok ? 'success' : 'warning');
    });

    // Delegated Actions
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const act = btn.getAttribute('data-action');
      const id = btn.getAttribute('data-id');
      if (act === 'track') {
        openTrackingDrawer(btn.getAttribute('data-cn'), btn.getAttribute('data-courier'));
      } else if (act === 'deliver' && id) {
        const p = App.Storage.updateParcelStatus(id, 'Delivered');
        if (p) { App.Audio.playDispatchTick(); toast(`Delivered: ${p.trackingNumber}`); renderAll(); }
      } else if (act === 'verify-return' && id) {
        const p = App.Storage.updateParcelStatus(id, 'Returned & Verified');
        if (p) { App.Audio.playSuccess(); toast(`Return Verified: ${p.trackingNumber}`); renderAll(); }
      } else if (act === 'edit' && id) {
        openEditModal(id);
      }
    });

    // Dedicated CSV & Excel Sheet Uploader
    $('upload-mode-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-sheet-mode]');
      if (!btn) return;
      ui.sheetMode = btn.getAttribute('data-sheet-mode');
      $('upload-mode-tabs').querySelectorAll('[data-sheet-mode]').forEach((x) => x.classList.toggle('active', x === btn));
      $('upload-mode-hint').textContent = SHEET_MODE_HINTS[ui.sheetMode] || SHEET_MODE_HINTS.auto;
      if (ui.pendingCSVRows.length) renderCSVPreview();
    });

    const dz = $('csv-dropzone');
    const fi = $('csv-file-input');
    const handleSheetFile = async (file) => {
      if (!file) return;
      toast(`Reading ${file.name}...`, 'success');
      const parsed = await App.CSV.parseSpreadsheetFile(file, App.Storage.getState().customCouriers);
      if (parsed.error) return toast(parsed.error, 'error');
      ui.pendingCSVRows = parsed.rows;
      ui.pendingCSVFormat = parsed.format || 'Courier Sheet';
      $('upload-format-badge').textContent = ui.pendingCSVFormat;
      renderCSVPreview();
    };

    dz.addEventListener('click', () => fi.click());
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('dragover'); handleSheetFile(e.dataTransfer.files[0]); });
    fi.addEventListener('change', () => { handleSheetFile(fi.files[0]); fi.value = ''; });
    $('chk-csv-update-existing').addEventListener('change', () => { if (ui.pendingCSVRows.length) renderCSVPreview(); });
    $('chk-csv-skip-cancelled').addEventListener('change', () => { if (ui.pendingCSVRows.length) renderCSVPreview(); });
    $('btn-sample-trax').addEventListener('click', () => App.CSV.downloadTraxSampleCSV());
    $('btn-sample-leopards').addEventListener('click', () => App.CSV.downloadLeopardsSampleCSV());
    $('btn-cancel-csv').addEventListener('click', () => {
      ui.pendingCSVRows = [];
      ui.pendingCSVFormat = '';
      $('csv-preview-panel').style.display = 'none';
      $('upload-format-badge').textContent = 'CSV • XLSX • XLS';
    });
    $('btn-confirm-csv-import').addEventListener('click', () => {
      const r = App.Storage.bulkAddParcels(ui.pendingCSVRows, {
        sheetMode: ui.sheetMode,
        updateExisting: $('chk-csv-update-existing').checked,
        skipCancelled: $('chk-csv-skip-cancelled').checked
      });
      ui.pendingCSVRows = [];
      ui.pendingCSVFormat = '';
      $('csv-preview-panel').style.display = 'none';
      $('upload-format-badge').textContent = 'CSV • XLSX • XLS';
      App.Audio.playSuccess();
      renderAll();
      toast(`Sheet imported: +${r.added.length} new, ${r.updated.length} updated, ${r.skipped.length} skipped`, 'success');
    });

    // Return / Dispatch Scanner Controls
    if ($('scanner-mode-tabs')) {
      $('scanner-mode-tabs').addEventListener('click', (e) => {
        const b = e.target.closest('[data-scanner-mode]');
        if (!b) return;
        ui.scannerMode = b.getAttribute('data-scanner-mode');
        $('scanner-mode-tabs').querySelectorAll('[data-scanner-mode]').forEach((x) => x.classList.toggle('active', x === b));
        const fbCard = $('scan-feedback-card');
        fbCard.className = 'scan-feedback-card';
        if (ui.scannerMode === 'dispatch') {
          $('scan-fb-title').textContent = 'Dispatch Scan (Load Sheet → Processing)';
          $('scan-fb-sub').textContent = 'Scan Pending load-sheet parcels to move them into Processing';
        } else {
          $('scan-fb-title').textContent = 'Ready to scan returns';
          $('scan-fb-sub').textContent = 'Start camera or use USB barcode gun';
        }
        $('inp-return-scan').focus();
      });
    }

    $('return-scan-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const inp = $('inp-return-scan');
      const v = inp.value.trim();
      inp.value = '';
      if (v) handleScannerCapture(v);
      inp.focus();
    });
    $('btn-toggle-sound').addEventListener('click', () => {
      const next = !App.Audio.isMuted();
      App.Audio.setMuted(next);
      $('btn-toggle-sound').textContent = next ? 'Sound: OFF' : 'Sound: ON';
    });
    let camHistoryPushed = false;
    const stopReturnCam = async (fromPopState) => {
      // Close UI immediately (0ms) so mobile HUD responds instantly on tap
      updateReturnCamUI(false);
      if (camHistoryPushed) {
        camHistoryPushed = false;
        if (!fromPopState) {
          try {
            if (global.history && global.history.state && global.history.state.reedLiveCam) {
              global.history.back();
            }
          } catch (_) {}
        }
      }
      try {
        await App.Scanner.stop();
      } catch (_) {}
      updateReturnCamUI(false);
    };

    const startReturnCam = async () => {
      $('return-camera-error').style.display = 'none';
      App.Scanner.resetCameraCooldown();
      updateReturnCamUI(true);
      if (!camHistoryPushed) {
        try {
          if (global.history && global.history.pushState) {
            global.history.pushState({ reedLiveCam: true }, '');
            camHistoryPushed = true;
          }
        } catch (_) {}
      }
      const r = await App.Scanner.start(
        'return-camera-reader',
        (code) => handleScannerCapture(code),
        (err) => {
          stopReturnCam(false);
          $('return-camera-error').textContent = err;
          $('return-camera-error').style.display = 'block';
        },
        { cooldownMs: 1500 }
      );
      if (!r.ok) stopReturnCam(false);
      else updateReturnCamUI(true, r.capabilities);
    };
    $('btn-start-return-cam').addEventListener('click', startReturnCam);
    $('btn-return-scan-mode').addEventListener('click', async () => {
      cycleScanMode();
      if (App.Scanner.isActive('return-camera-reader')) {
        await startReturnCam();
      } else {
        updateReturnCamUI(false);
      }
    });
    $('btn-return-cam-facing').addEventListener('click', async () => {
      toggleCamFacing();
      if (App.Scanner.isActive('return-camera-reader')) {
        await startReturnCam();
      } else {
        updateReturnCamUI(false);
      }
    });
    $('btn-stop-return-cam').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); stopReturnCam(false); });
    if ($('btn-live-cam-back')) $('btn-live-cam-back').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); stopReturnCam(false); });
    if ($('btn-live-cam-done')) $('btn-live-cam-done').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); stopReturnCam(false); });

    // Mobile Back gesture / browser Back button closes live camera back to Scanner home
    global.addEventListener('popstate', () => {
      const stage = $('return-camera-stage');
      if (stage && stage.classList.contains('active')) {
        stopReturnCam(true);
      }
    });

    // Android APK MainActivity hardware/gesture Back hook
    global.__reedHandleBack = function () {
      const stage = $('return-camera-stage');
      if (stage && stage.classList.contains('active')) {
        stopReturnCam(true);
        return 'handled';
      }
      return '';
    };
    $('btn-return-torch').addEventListener('click', async () => {
      const r = await App.Scanner.toggleTorch();
      $('btn-return-torch').textContent = r.torchOn ? 'Flash ON' : 'Flash';
    });
    $('btn-return-zoom').addEventListener('click', async () => {
      const r = await App.Scanner.cycleZoom();
      $('btn-return-zoom').textContent = `${r.currentZoom}x`;
    });

    if ($('inp-return-photo')) {
      $('inp-return-photo').addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          const dataUrl = await compressImageToDataURL(file, 640, 0.72);
          ui.pendingReturnPhoto = dataUrl;
          if ($('return-photo-preview')) {
            $('return-photo-preview').src = dataUrl;
            $('return-photo-preview').style.display = 'inline-block';
          }
          if ($('return-photo-lbl')) $('return-photo-lbl').textContent = 'Photo Ready ✓';
          toast('Claim proof photo attached for next return scan.');
        } catch (_) {
          toast('Could not read photo.', 'error');
        }
      });
    }
    if ($('btn-print-return-slip')) $('btn-print-return-slip').addEventListener('click', () => printHandoverSlip('returns'));
    if ($('btn-print-return-slip-rep')) $('btn-print-return-slip-rep').addEventListener('click', () => printHandoverSlip('returns'));
    if ($('btn-print-dispatch-slip')) $('btn-print-dispatch-slip').addEventListener('click', () => printHandoverSlip('dispatch'));

    // Global USB Barcode Gun Wedge
    App.Scanner.attachUsbWedge((code) => {
      if (App.Security && App.Security.isLocked()) return;
      if (ui.activeView === 'returns') {
        handleScannerCapture(code);
      } else if (ui.activeView === 'overview' || ui.activeView === 'dashboard') {
        if (ui.activeView === 'dashboard') switchView('overview');
        if (!ui.gateOpen) setGateDrawerOpen(true, false);
        $('inp-gate-cn').value = code;
        ui.gateManualCourier = false;
        updateGateInputFeedback();
        processGateSubmit();
      }
    });

    // Alerts Tabs & Courier Filter
    document.querySelectorAll('[data-alert-tab]').forEach((b) =>
      b.addEventListener('click', () => {
        ui.alertTab = b.getAttribute('data-alert-tab');
        document.querySelectorAll('[data-alert-tab]').forEach((x) => x.classList.toggle('active', x === b));
        renderAlertsView(App.Aging.summarize(App.Storage.getParcels()));
      })
    );
    $('alerts-courier-pills').addEventListener('click', (e) => {
      const b = e.target.closest('[data-alert-courier]');
      if (!b) return;
      ui.alertCourier = b.getAttribute('data-alert-courier');
      syncCourierControls();
      renderAlertsView(App.Aging.summarize(App.Storage.getParcels()));
    });

    // Complaint & Report CSV Export Buttons
    document.querySelectorAll('[data-export-complaint]').forEach((b) =>
      b.addEventListener('click', () => {
        const c = b.getAttribute('data-export-complaint');
        const r = App.CSV.exportReportCSV(App.Storage.getParcels(), { courier: c, reportType: 'complaint_all' });
        toast(r.ok ? `Exported ${c} complaint list (${r.count})` : `No 5+ day overdue parcels for ${c}.`, r.ok ? 'success' : 'warning');
      })
    );
    document.querySelectorAll('[data-export-returns-today]').forEach((b) =>
      b.addEventListener('click', () => {
        const c = b.getAttribute('data-export-returns-today');
        const r = App.CSV.exportReportCSV(App.Storage.getParcels(), { courier: c, reportType: 'returns_today' });
        toast(r.ok ? `Exported ${r.count} ${c} returns today` : `No ${c} returns scanned today.`, r.ok ? 'success' : 'warning');
      })
    );
    document.querySelectorAll('[data-report-courier]').forEach((b) =>
      b.addEventListener('click', () => {
        const r = App.CSV.exportReportCSV(App.Storage.getParcels(), {
          courier: b.getAttribute('data-report-courier'),
          reportType: b.getAttribute('data-report-type')
        });
        toast(r.ok ? `Exported ${r.count} rows` : 'No matching rows for this report.', r.ok ? 'success' : 'warning');
      })
    );

    // Custom Couriers
    $('add-courier-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const r = App.Storage.addCustomCourier($('inp-new-courier-name').value, $('inp-new-courier-prefixes').value);
      if (!r.ok) return toast(r.error, 'error');
      $('inp-new-courier-name').value = '';
      $('inp-new-courier-prefixes').value = '';
      renderAll();
      toast('Courier added.');
    });
    $('courier-list-chips').addEventListener('click', (e) => {
      const b = e.target.closest('[data-remove-courier]');
      if (!b) return;
      App.Storage.removeCustomCourier(b.getAttribute('data-remove-courier'));
      renderAll();
    });

    // Backups & Restore
    $('btn-export-json').addEventListener('click', () => {
      App.CSV.triggerDownload(`virsa_backup_${App.Aging.getTodayISO()}.json`, App.Storage.exportBackupJSON(), 'application/json');
      toast('JSON backup downloaded.');
    });
    $('btn-export-encrypted').addEventListener('click', async () => {
      if (!App.Security.isCryptoAvailable()) return toast('AES-256 requires MM-VIRSA-Ops.exe (localhost) or HTTPS.', 'warning');
      const pass = global.prompt('Set encryption password (min 6 chars):');
      if (!pass) return;
      try {
        const enc = await App.Security.encryptBackup(App.Storage.exportBackupJSON(), pass);
        App.CSV.triggerDownload(`virsa_aes_backup_${App.Aging.getTodayISO()}.json`, enc, 'application/json');
        toast('AES-256 encrypted backup downloaded.');
      } catch (err) { toast(err.message, 'error'); }
    });
    $('btn-restore-merge').addEventListener('click', () => $('json-restore-input').click());
    $('json-restore-input').addEventListener('change', () => {
      const f = $('json-restore-input').files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        try {
          const r = App.Storage.importBackupJSON(rd.result, 'merge');
          renderAll();
          toast(`Restored ${r.addedCount} parcels (${r.skippedCount} skipped).`);
        } catch (err) { toast(err.message, 'error'); }
      };
      rd.readAsText(f);
      $('json-restore-input').value = '';
    });
    $('btn-restore-encrypted').addEventListener('click', () => $('enc-restore-input').click());
    $('enc-restore-input').addEventListener('change', () => {
      const f = $('enc-restore-input').files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = async () => {
        const pass = global.prompt('Enter decryption password:');
        if (!pass) return;
        try {
          const plain = await App.Security.decryptBackup(rd.result, pass);
          const r = App.Storage.importBackupJSON(plain, 'merge');
          renderAll();
          toast(`Decrypted & restored ${r.addedCount} parcels.`);
        } catch (err) { toast(err.message, 'error'); }
      };
      rd.readAsText(f);
      $('enc-restore-input').value = '';
    });
    $('btn-load-sample').addEventListener('click', () => {
      if (global.confirm('Load 12 sample parcels?')) { App.Storage.resetToSampleData(); renderAll(); }
    });
    $('btn-clear-all-data').addEventListener('click', () => {
      requireAdminPin('Delete all stored parcels', async () => {
        if (!global.confirm('Delete ALL stored parcels permanently across this device, Local DB, Supabase & Google Sheet?')) return;
        if (App.CloudSync && App.CloudSync.hostEraseAllData) {
          const r = await App.CloudSync.hostEraseAllData();
          renderAll();
          toast(r.ok && r.cloudSynced ? 'All data permanently wiped across Local & Cloud!' : 'All local data wiped.', 'warning');
        } else {
          App.Storage.clearAllData();
          renderAll();
          toast('All data cleared.', 'warning');
        }
      });
    });

    // Live API & Cloud Sync Forms
    $('api-config-form').addEventListener('submit', (e) => {
      e.preventDefault();
      App.TrackingAPI.saveConfig({
        traxApiKey: $('inp-trax-key').value.trim(),
        traxEnv: $('inp-trax-env').value,
        corsProxyUrl: $('inp-api-proxy').value.trim(),
        leopardsApiKey: $('inp-lcs-key').value.trim(),
        leopardsApiPassword: $('inp-lcs-pass').value.trim(),
        autoMarkDeliveredOnSync: $('chk-auto-deliver').checked,
        autoLiveTrackEnabled: $('chk-auto-live-track') ? $('chk-auto-live-track').checked : false
      });
      if (App.CloudSync && App.CloudSync.markSettingsChanged) App.CloudSync.markSettingsChanged();
      hydrateSettingsForms();
      renderApiAndSecurity();
      toast('Live API keys saved.');
    });
    $('btn-test-api').addEventListener('click', () => {
      const cn = global.prompt('Enter a REAL Trax or Leopards Tracking CN to test:', '');
      if (cn && cn.trim()) openTrackingDrawer(cn.trim());
    });

    if ($('inp-sync-provider')) {
      $('inp-sync-provider').addEventListener('change', () => {
        if (!App.CloudSync || !App.CloudSync.getProviderDefaults) return;
        const defs = App.CloudSync.getProviderDefaults($('inp-sync-provider').value);
        $('inp-sync-url').value = defs.endpointUrl || '';
        $('inp-sync-secret').value = defs.secretToken || '';
      });
    }

    $('cloud-sync-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const accountLabel = $('inp-sync-account') ? $('inp-sync-account').value.trim() : '';
      const url = $('inp-sync-url').value.trim();
      const enabled = $('chk-cloud-sync-enabled').checked;
      if (enabled && !url) return toast('Open Advanced Cloud Endpoint to enter your Sync URL first.', 'error');
      App.CloudSync.saveConfig({
        accountLabel,
        provider: $('inp-sync-provider').value,
        endpointUrl: url,
        secretToken: $('inp-sync-secret').value.trim(),
        enabled
      });
      if (App.CloudSync.markSettingsChanged) App.CloudSync.markSettingsChanged();
      hydrateSettingsForms();
      renderApiAndSecurity();
      toast('Sync settings saved.');
      if (enabled && url) {
        const res = await App.CloudSync.syncWithCloud('manual');
        if (res.skipped) return;
        if (res.ok) hydrateSettingsForms();
        renderAll();
        toast(res.ok ? `Cloud Sync active (${res.count} parcels)!` : `Sync failed: ${res.error || 'Unknown error'}`, res.ok ? 'success' : 'error');
      }
    });

    $('btn-cloud-sync-now').addEventListener('click', async () => {
      const res = await App.CloudSync.syncWithCloud('manual');
      if (res.skipped) return;
      if (res.ok && (!document.activeElement || !document.activeElement.closest('#api-config-form, #security-pin-form, #cloud-sync-form'))) {
        hydrateSettingsForms();
      }
      renderAll();
      toast(res.ok ? `Cloud synced (${res.count} parcels)` : res.error || 'Enable Cloud Sync first.', res.ok ? 'success' : 'warning');
    });

    if ($('btn-host-erase-all')) {
      $('btn-host-erase-all').addEventListener('click', () => {
        if (!App.CloudSync || !App.CloudSync.hostEraseAllData) {
          return toast('Cloud Sync module unavailable.', 'error');
        }
        if (!global.confirm('ERASE ALL DATA?\n\nThis will permanently delete ALL parcels on this device, Local DB, and Cloud Sync (all connected phones, web & desktop devices).\n\nYour API keys, Sync URL & Staff accounts will be kept.')) {
          return;
        }
        const checkWord = global.prompt('Type ERASE to permanently delete all parcel data:');
        if (!checkWord || checkWord.trim().toUpperCase() !== 'ERASE') {
          return toast('Erase cancelled.', 'warning');
        }
        const runErase = async () => {
          const r = await App.CloudSync.hostEraseAllData();
          if (!r.ok) return toast(r.error || 'Erase failed.', 'error');
          renderAll();
          toast(
            r.cloudSynced
              ? 'All parcel data erased across device & Cloud Sync!'
              : r.cloudError
              ? `Erased locally, but Cloud Sync failed: ${r.cloudError}`
              : 'All parcel data erased!',
            r.cloudError ? 'warning' : 'success'
          );
        };
        if (App.Security && App.Security.loadConfig().pinEnabled) {
          requireAdminPin('Erase All Data', runErase);
        } else {
          runErase();
        }
      });
    }

    // Drawer Controls + Direct Trax Sonic Escalation APIs
    $('btn-close-drawer').addEventListener('click', closeDrawer);
    $('tracking-drawer').addEventListener('click', (e) => { if (e.target === $('tracking-drawer')) closeDrawer(); });
    $('btn-drawer-refresh').addEventListener('click', () => openTrackingDrawer(ui.activeDrawerCN, ui.activeDrawerCourier));
    $('btn-drawer-deliver').addEventListener('click', () => {
      const p = App.Storage.findByTracking(ui.activeDrawerCN);
      if (p) { App.Storage.updateParcelStatus(p.id, 'Delivered'); toast('Marked Delivered.'); openTrackingDrawer(p.trackingNumber, p.courier); }
    });
    $('btn-drawer-return').addEventListener('click', () => {
      const p = App.Storage.findByTracking(ui.activeDrawerCN);
      if (p) { App.Storage.updateParcelStatus(p.id, 'Returned & Verified'); App.Audio.playSuccess(); toast('Return Verified.'); openTrackingDrawer(p.trackingNumber, p.courier); }
    });
    $('btn-trax-reattempt').addEventListener('click', async () => {
      const remarks = global.prompt(`Trax Re-Attempt remarks for ${ui.activeDrawerCN}:`, 'Please re-attempt delivery and call customer');
      if (remarks === null) return;
      const r = await App.TrackingAPI.sendTraxRcpRequest(ui.activeDrawerCN, 2, remarks);
      toast(r.ok ? r.message : r.error, r.ok ? 'success' : 'error');
    });
    $('btn-trax-return-confirm').addEventListener('click', async () => {
      const remarks = global.prompt(`Confirm Trax RTS Return for ${ui.activeDrawerCN}:`, 'Return confirmed by MM VIRSA');
      if (remarks === null) return;
      const r = await App.TrackingAPI.sendTraxRcpRequest(ui.activeDrawerCN, 1, remarks);
      toast(r.ok ? r.message : r.error, r.ok ? 'success' : 'error');
    });
    $('btn-trax-crm-delay').addEventListener('click', async () => {
      const desc = global.prompt(`Log Trax CRM Delay Complaint for ${ui.activeDrawerCN}:`, 'Urgent delivery delay escalation');
      if (desc === null) return;
      const r = await App.TrackingAPI.sendTraxCrmComplaint(ui.activeDrawerCN, 2, desc);
      toast(r.ok ? `${r.message} (#${r.id || ''})` : r.error, r.ok ? 'success' : 'error');
    });

    // Security PIN, Staff Login & Role Management
    if ($('btn-toggle-auth-mode')) {
      $('btn-toggle-auth-mode').addEventListener('click', () => {
        configureLockOverlay(lockForcePinMode === false);
      });
    }

    $('btn-lock-app').addEventListener('click', () => App.Security.lockNow());
    if ($('btn-sidebar-logout')) $('btn-sidebar-logout').addEventListener('click', () => App.Security.logoutStaff());
    $('btn-sec-lock-now').addEventListener('click', () => App.Security.lockNow());
    $('lock-unlock-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!lockForcePinMode && App.Security.getStaffList && App.Security.getStaffList().length > 0) {
        const uid = $('inp-login-id').value;
        const upass = $('inp-login-pass').value;
        let r = await App.Security.loginWithCredentials(uid, upass);
        if (!r.ok && !r.locked && App.CloudSync) {
          $('lock-error-msg').textContent = 'Verifying credentials...';
          let synced = false;
          if (App.CloudSync.fetchStaffFromSupabase) {
            const sbRes = await App.CloudSync.fetchStaffFromSupabase();
            if (sbRes && sbRes.ok && sbRes.count > 0) synced = true;
          }
          if (!synced) {
            await App.CloudSync.syncWithCloud('manual');
          }
          r = await App.Security.loginWithCredentials(uid, upass);
        }
        if (r.ok) {
          $('lock-overlay').classList.remove('open');
          $('inp-login-pass').value = '';
          renderAll();
          toast(`Welcome, ${r.staff.name}!`);
        } else {
          App.Audio.playDuplicateBuzz();
          $('lock-error-msg').textContent = r.error;
          $('inp-login-pass').value = '';
        }
        return;
      }
      const r = await App.Security.verifyPin($('inp-lock-pin').value);
      if (r.ok) { $('lock-overlay').classList.remove('open'); renderAll(); }
      else { App.Audio.playDuplicateBuzz(); $('lock-error-msg').textContent = r.error; $('inp-lock-pin').value = ''; }
    });

    // Staff Account Form & Directory Actions
    if ($('inp-emp-role')) {
      $('inp-emp-role').addEventListener('change', () => {
        const preset = App.Security.ROLE_PRESETS[$('inp-emp-role').value] || App.Security.ROLE_PRESETS.scanner;
        $('perm-intake').checked = Boolean(preset.canIntake);
        $('perm-return').checked = Boolean(preset.canReturnScan);
        $('perm-edit').checked = Boolean(preset.canEditOrders);
        $('perm-reports').checked = Boolean(preset.canViewReports);
        $('perm-settings').checked = Boolean(preset.canManageSettings);
      });
    }
    const resetStaffForm = () => {
      if (!$('staff-account-form')) return;
      $('staff-account-form').reset();
      $('inp-emp-role').value = 'scanner';
      $('chk-emp-active').checked = true;
      $('inp-emp-role').dispatchEvent(new Event('change'));
    };
    if ($('btn-emp-reset')) $('btn-emp-reset').addEventListener('click', resetStaffForm);
    if ($('staff-account-form')) {
      $('staff-account-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const r = await App.Security.saveStaffMember({
          id: $('inp-emp-id').value,
          name: $('inp-emp-name').value,
          phone: $('inp-emp-phone').value,
          role: $('inp-emp-role').value,
          password: $('inp-emp-pass').value,
          active: $('chk-emp-active').checked,
          permissions: {
            canIntake: $('perm-intake').checked,
            canReturnScan: $('perm-return').checked,
            canEditOrders: $('perm-edit').checked,
            canViewReports: $('perm-reports').checked,
            canManageSettings: $('perm-settings').checked
          }
        });
        if (!r.ok) return toast(r.error, 'error');
        let sbWarn = '';
        if (App.CloudSync && App.CloudSync.upsertStaffToSupabase) {
          const sbUp = await App.CloudSync.upsertStaffToSupabase(r.member);
          if (sbUp && !sbUp.ok) sbWarn = ` (Supabase: ${sbUp.error || 'run schema.sql'})`;
        }
        if (App.CloudSync && App.CloudSync.markSettingsChanged) App.CloudSync.markSettingsChanged();
        resetStaffForm();
        renderApiAndSecurity();
        toast(`Saved staff @${r.member.id} (${r.member.name})${sbWarn}`, sbWarn ? 'warning' : 'success');
      });
    }
    if ($('staff-list-body')) {
      $('staff-list-body').addEventListener('click', async (e) => {
        const editId = e.target.getAttribute('data-staff-edit');
        const toggleId = e.target.getAttribute('data-staff-toggle');
        const delId = e.target.getAttribute('data-staff-del');
        if (editId) {
          const emp = App.Security.getStaffList().find((u) => u.id === editId);
          if (!emp) return;
          $('inp-emp-id').value = emp.id;
          $('inp-emp-name').value = emp.name;
          $('inp-emp-phone').value = emp.phone || '';
          $('inp-emp-role').value = emp.role || 'scanner';
          $('inp-emp-pass').value = '';
          $('chk-emp-active').checked = emp.active !== false;
          const p = emp.permissions || {};
          $('perm-intake').checked = Boolean(p.canIntake);
          $('perm-return').checked = Boolean(p.canReturnScan);
          $('perm-edit').checked = Boolean(p.canEditOrders);
          $('perm-reports').checked = Boolean(p.canViewReports);
          $('perm-settings').checked = Boolean(p.canManageSettings);
          $('inp-emp-name').focus();
        } else if (toggleId) {
          const emp = App.Security.getStaffList().find((u) => u.id === toggleId);
          if (!emp) return;
          const upd = await App.Security.saveStaffMember(Object.assign({}, emp, { active: !emp.active }));
          if (upd.ok && App.CloudSync && App.CloudSync.upsertStaffToSupabase) App.CloudSync.upsertStaffToSupabase(upd.member);
          if (App.CloudSync && App.CloudSync.markSettingsChanged) App.CloudSync.markSettingsChanged();
          renderApiAndSecurity();
          toast(`${emp.name} ${!emp.active ? 'activated' : 'disabled'}.`);
        } else if (delId) {
          if (!global.confirm(`Remove staff account @${delId}?`)) return;
          const r = App.Security.deleteStaffMember(delId);
          if (r.ok) {
            if (App.CloudSync && App.CloudSync.deleteStaffFromSupabase) {
              await App.CloudSync.deleteStaffFromSupabase(delId);
            }
            if (App.CloudSync && App.CloudSync.markSettingsChanged) {
              App.CloudSync.markSettingsChanged();
              App.CloudSync.syncWithCloud('manual');
            }
            renderApiAndSecurity();
            toast(`Removed staff @${delId}`, 'warning');
          }
        }
      });
    }
    $('btn-cancel-admin-pin').addEventListener('click', () => { $('modal-admin-pin').classList.remove('open'); ui.pendingAdminAction = null; });
    $('admin-pin-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await App.Security.verifyPin($('inp-admin-verify-pin').value);
      if (r.ok) {
        const fn = ui.pendingAdminAction;
        $('modal-admin-pin').classList.remove('open');
        ui.pendingAdminAction = null;
        if (fn) fn();
      } else { App.Audio.playDuplicateBuzz(); $('admin-pin-error').textContent = r.error; }
    });
    $('security-pin-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pin = $('inp-sec-pin').value.trim();
      const autoLock = $('inp-sec-autolock').value;
      const op = $('inp-sec-operator').value.trim();
      const cfg = App.Security.loadConfig();
      if (!pin) {
        App.Security.updateAutoLock(autoLock);
        const upd = App.Security.loadConfig();
        upd.operatorName = App.Security.sanitizeText(op, 40) || 'VIRSA Station';
        global.localStorage.setItem('virsa_ops_security_v1', JSON.stringify(upd));
        if (App.CloudSync && App.CloudSync.markSettingsChanged) App.CloudSync.markSettingsChanged();
        hydrateSettingsForms();
        renderApiAndSecurity();
        return toast('Staff & security settings saved.');
      }
      const saveFn = async () => {
        const r = await App.Security.setPin(pin, autoLock, op);
        if (!r.ok) return toast(r.error, 'error');
        if (App.CloudSync && App.CloudSync.upsertStaffToSupabase) App.CloudSync.upsertStaffToSupabase(r.member);
        if (App.CloudSync && App.CloudSync.markSettingsChanged) App.CloudSync.markSettingsChanged();
        $('inp-sec-pin').value = '';
        hydrateSettingsForms();
        renderApiAndSecurity();
        toast('Admin PIN & staff settings saved.');
      };
      if (cfg.pinEnabled) requireAdminPin('Change Admin PIN', saveFn);
      else await saveFn();
    });
    $('btn-sec-disable-pin').addEventListener('click', async () => {
      const cur = global.prompt('Enter current Admin PIN to disable:');
      if (!cur) return;
      const r = await App.Security.disablePin(cur);
      if (r.ok && App.CloudSync && App.CloudSync.markSettingsChanged) App.CloudSync.markSettingsChanged();
      toast(r.ok ? 'PIN Lock disabled.' : r.error, r.ok ? 'warning' : 'error');
      hydrateSettingsForms();
      renderApiAndSecurity();
    });
    $('btn-export-audit').addEventListener('click', () => {
      const r = App.CSV.exportAuditLogCSV(App.Security.getAuditLog());
      toast(r.ok ? `Exported ${r.count} audit entries.` : 'Audit log is empty.', r.ok ? 'success' : 'warning');
    });

    // Unknown Parcel Modal
    const closeUnk = () => { $('modal-unknown-parcel').classList.remove('open'); ui.pendingUnknownCN = ''; };
    $('btn-cancel-unknown').addEventListener('click', closeUnk);
    $('btn-dismiss-unknown').addEventListener('click', closeUnk);
    $('unknown-parcel-form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (!ui.pendingUnknownCN) return closeUnk();
      const r = App.Storage.logUnrecordedReturn({
        trackingNumber: ui.pendingUnknownCN,
        courier: $('inp-unknown-courier').value,
        orderId: $('inp-unknown-order').value
      });
      closeUnk();
      if (r.ok) { App.Audio.playSuccess(); flashScreen('flash-green'); toast(`Logged unrecorded return ${r.parcel.trackingNumber}`); renderAll(); }
    });

    // Edit Parcel Modal
    const closeEd = () => $('modal-edit-parcel').classList.remove('open');
    $('btn-close-edit-modal').addEventListener('click', closeEd);
    $('btn-cancel-edit').addEventListener('click', closeEd);
    $('edit-parcel-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const id = $('edit-parcel-id').value;
      const cn = App.Couriers.normalizeTracking($('edit-tracking').value);
      const conflict = App.Storage.findByTracking(cn);
      if (conflict && conflict.id !== id) return toast(`Tracking ${cn} already exists.`, 'error');
      App.Storage.updateParcel(id, {
        trackingNumber: cn,
        orderId: $('edit-order-id').value.trim(),
        courier: $('edit-courier').value,
        dispatchDate: $('edit-dispatch-date').value,
        customerName: $('edit-customer-name').value.trim(),
        customerPhone: $('edit-customer-phone').value.trim(),
        codAmount: Number($('edit-cod-amount').value) || 0,
        itemDescription: $('edit-product') ? $('edit-product').value.trim() : '',
        notes: $('edit-notes').value.trim()
      });
      App.Storage.updateParcelStatus(id, $('edit-status').value);
      closeEd();
      renderAll();
      toast('Shipment updated.');
    });
    $('btn-delete-in-modal').addEventListener('click', () => {
      const id = $('edit-parcel-id').value;
      requireAdminPin('Delete shipment', () => {
        if (global.confirm('Delete this parcel permanently?')) {
          App.Storage.deleteParcel(id);
          closeEd();
          renderAll();
          toast('Parcel deleted.', 'warning');
        }
      });
    });
  }

  let lockForcePinMode = false;
  function configureLockOverlay(preferPin) {
    const staffCount = App.Security.getStaffList ? App.Security.getStaffList().length : 0;
    const pinOn = App.Security.loadConfig().pinEnabled;
    // Always default to Host PIN first (with Staff Login button below) whenever PIN is enabled
    const defaultToPin = preferPin === true || (pinOn && preferPin !== false);
    const useStaff = staffCount > 0 && !(defaultToPin && pinOn);
    lockForcePinMode = !useStaff;

    if ($('lock-staff-fields')) $('lock-staff-fields').style.display = useStaff ? 'flex' : 'none';
    if ($('lock-pin-fields')) $('lock-pin-fields').style.display = useStaff ? 'none' : 'block';
    if ($('inp-lock-pin')) $('inp-lock-pin').required = !useStaff;
    if ($('inp-login-id')) $('inp-login-id').required = useStaff;
    if ($('inp-login-pass')) $('inp-login-pass').required = useStaff;
    if ($('lock-title')) $('lock-title').textContent = useStaff ? 'REED Staff Login' : 'REED Host Unlock';
    if ($('lock-subtitle')) {
      $('lock-subtitle').textContent = useStaff
        ? 'Enter your Employee Staff ID & Password.'
        : 'Enter your Host Security PIN to unlock.';
    }
    if ($('btn-lock-submit')) $('btn-lock-submit').textContent = useStaff ? 'Sign In' : 'Unlock';
    if ($('lock-default-hint')) {
      const list = App.Security.getStaffList ? App.Security.getStaffList() : [];
      const showDefault = useStaff && list.length === 1 && list[0].isDefaultSeed;
      $('lock-default-hint').style.display = showDefault ? 'block' : 'none';
    }
    if ($('btn-toggle-auth-mode')) {
      $('btn-toggle-auth-mode').style.display = staffCount > 0 && pinOn ? 'inline-flex' : 'none';
      $('btn-toggle-auth-mode').textContent = useStaff ? 'Use Host PIN instead' : 'Staff Login';
    }
    $('lock-error-msg').textContent = '';
  }

  async function init() {
    App.Storage.load();
    if (App.Security && App.Security.ensureDefaultHostPin) {
      await App.Security.ensureDefaultHostPin();
    }
    if (App.Security && App.Security.ensureDefaultAdmin) {
      await App.Security.ensureDefaultAdmin();
    }
    bindEvents();
    hydrateSettingsForms();
    renderAll();

    // Open Host PIN (on PC) or Staff Login (on Web/Mobile) directly on startup
    App.Security.initIdleMonitor(() => {
      configureLockOverlay(undefined);
      if ($('inp-lock-pin')) $('inp-lock-pin').value = '';
      if ($('inp-login-pass')) $('inp-login-pass').value = '';
      $('lock-overlay').classList.add('open');
      setTimeout(() => {
        if (!lockForcePinMode && $('inp-login-id')) $('inp-login-id').focus();
        else if ($('inp-lock-pin')) $('inp-lock-pin').focus();
      }, 50);
    });

    // Pre-fetch Supabase staff table immediately (~150ms) so mobile/web login is instant
    if (App.CloudSync && App.CloudSync.fetchStaffFromSupabase) {
      App.CloudSync.fetchStaffFromSupabase().then((sr) => {
        if (sr && sr.ok && sr.count > 0 && $('lock-overlay') && $('lock-overlay').classList.contains('open')) {
          configureLockOverlay(undefined);
        }
      });
    }

    // Hydrate from permanent Local Disk Database when running in MM-VIRSA-Ops.exe
    if (App.CloudSync) {
      const safeHydrate = () => {
        if (!document.activeElement || !document.activeElement.closest('#api-config-form, #security-pin-form, #cloud-sync-form')) {
          hydrateSettingsForms();
        }
      };

      const diskRes = await App.CloudSync.loadFromLocalDisk();
      if (diskRes.ok) {
        safeHydrate();
        renderAll();
      }

      App.CloudSync.startAutoSyncLoop((dataChanged) => {
        if (dataChanged) {
          safeHydrate();
          renderAll();
        } else {
          renderApiAndSecurity();
        }
      });

      const sc = App.CloudSync.loadConfig();
      if (sc.enabled && sc.endpointUrl) {
        App.CloudSync.syncWithCloud('startup').then((r) => {
          if (r.ok) {
            safeHydrate();
            renderAll();
          }
        });
      }
    }

    // Automatic timely Live Courier Tracking (startup + every 5 minutes when API keys are set)
    if (App.TrackingAPI && App.TrackingAPI.startTimelyTrackingLoop) {
      App.TrackingAPI.startTimelyTrackingLoop(() => renderAll());
    }

    if ('serviceWorker' in navigator && global.location && global.location.protocol === 'https:') {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }

    if (global.location && (global.location.hostname === '127.0.0.1' || global.location.hostname === 'localhost') && global.location.port === '8787') {
      const sendPing = () => fetch('/api/ping', { method: 'GET', cache: 'no-store' }).catch(() => {});
      sendPing();
      setInterval(sendPing, 3500);
      global.addEventListener('beforeunload', () => {
        if (navigator.sendBeacon) {
          try { navigator.sendBeacon('/api/bye'); } catch (_) {}
        }
      });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})(window);
