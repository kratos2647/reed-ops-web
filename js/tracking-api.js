/**
 * js/tracking-api.js
 * Official Trax (Sonic API v2.0) & Leopards Courier (LCS) Live Tracking Engine.
 * Built strictly against Official Sonic API Documentation v2.0:
 *  - GET  /api/shipment/track            (Full CN tracking + origin/destination/consignee/history)
 *  - GET  /api/shipment/track/order_id   (Track by Order ID)
 *  - GET  /api/shipment/status           (Current status)
 *  - GET  /api/shipment/payment_status   (COD payment status)
 *  - GET  /api/shipment/charges          (Shipping charges & net payable)
 *  - POST /api/request/rcp               (Return Confirm type=1 / Re-Attempt Request type=2)
 *  - POST /api/request/crm               (CRM Complaint: Delay=2, Return=5)
 */
(function (global) {
  const App = (global.DispatchApp = global.DispatchApp || {});

  const API_CFG_KEY = 'virsa_ops_api_config_v2';

  const DEFAULT_ENDPOINTS = {
    leopardsApiUrl: 'https://merchantapi.leopardscourier.com/api/trackBookedPacket/format/json/',
    traxLiveBase: 'https://sonic.pk',
    traxTestBase: 'https://app.sonic.pk',
    leopardsWebUrl: 'https://www.leopardscourier.com/leopards-tracking?track_number=',
    traxWebUrl: 'https://trax.pk/tracking/?tracking_number='
  };

  function defaultApiConfig() {
    return {
      mode: 'live', // Always default to real LIVE API (no fake dummy Lahore fallback!)
      traxEnv: 'live', // 'live' (sonic.pk) | 'testing' (app.sonic.pk)
      leopardsApiKey: '',
      leopardsApiPassword: '',
      traxApiKey: '',
      corsProxyUrl: '',
      autoMarkDeliveredOnSync: true,
      autoLiveTrackEnabled: false,
      lastSyncedAt: null
    };
  }

  function loadConfig() {
    try {
      const raw = global.localStorage.getItem(API_CFG_KEY) || global.localStorage.getItem('virsa_ops_api_config_v1');
      if (!raw) return defaultApiConfig();
      const parsed = App.Security ? App.Security.safeJSONParse(raw) : JSON.parse(raw);
      return Object.assign(defaultApiConfig(), parsed, { mode: 'live' });
    } catch (_) {
      return defaultApiConfig();
    }
  }

  function saveConfig(patch) {
    const curr = loadConfig();
    const next = Object.assign({}, curr, patch, { mode: 'live' });
    try {
      global.localStorage.setItem(API_CFG_KEY, JSON.stringify(next));
    } catch (_) {}
    if (App.Security) {
      App.Security.logAudit('API_CONFIG', `Updated Courier API config (Trax env: ${next.traxEnv})`);
    }
    return next;
  }

  function isLocalProxyActive() {
    return Boolean(
      global.location &&
        (global.location.hostname === 'localhost' || global.location.hostname === '127.0.0.1') &&
        global.location.port === '8787'
    );
  }

  function getTraxBaseUrl(cfg) {
    return cfg && cfg.traxEnv === 'testing' ? DEFAULT_ENDPOINTS.traxTestBase : DEFAULT_ENDPOINTS.traxLiveBase;
  }

  function hasLiveCredentials(courierName, cfg) {
    const c = cfg || loadConfig();
    const key = String(courierName || '').toLowerCase();
    if (key.includes('leopard')) {
      return Boolean(c.leopardsApiKey && c.leopardsApiPassword);
    }
    if (key.includes('trax')) {
      return Boolean(c.traxApiKey);
    }
    return false;
  }

  function getOfficialPortalUrl(courierName, trackingNumber) {
    const tn = encodeURIComponent(App.Couriers.normalizeTracking(trackingNumber));
    const key = String(courierName || '').toLowerCase();
    if (key.includes('trax')) return DEFAULT_ENDPOINTS.traxWebUrl + tn;
    return DEFAULT_ENDPOINTS.leopardsWebUrl + tn;
  }

  /**
   * Executes HTTP requests through:
   *  1. Built-in VIRSA Local Proxy (/api/proxy on localhost:8787 — zero CORS!)
   *  2. User-configured CORS Proxy URL if set
   *  3. Direct browser fetch (works in Desktop .exe or CORS-enabled endpoints)
   */
  async function courierFetch(targetUrl, options, cfg) {
    const opts = options || {};
    const method = (opts.method || 'GET').toUpperCase();
    const headers = Object.assign({}, opts.headers || {});
    const body = opts.body;

    if (isLocalProxyActive()) {
      const proxyRes = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: targetUrl,
          method,
          headers,
          body: body || null
        })
      });
      const text = await proxyRes.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (_) {
        throw new Error(`Invalid response from courier server (HTTP ${proxyRes.status}).`);
      }
      if (!proxyRes.ok && json && json.proxyError) {
        throw new Error(json.proxyError);
      }
      return { ok: proxyRes.ok, status: proxyRes.status, data: json };
    }

    const customProxy = String((cfg && cfg.corsProxyUrl) || '').trim();
    const finalUrl = customProxy
      ? customProxy.includes('{url}')
        ? customProxy.replace('{url}', encodeURIComponent(targetUrl))
        : customProxy + encodeURIComponent(targetUrl)
      : targetUrl;

    const res = await fetch(finalUrl, {
      method,
      headers,
      body: method === 'GET' ? undefined : body
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {
      throw new Error(`Courier API returned non-JSON response (HTTP ${res.status}).`);
    }
    return { ok: res.ok, status: res.status, data: json };
  }

  function classifyCourierStatus(statusText) {
    const s = String(statusText || '').toLowerCase();
    if (/delivered|pod|cash collected/.test(s) && !/undelivered|not delivered|unsuccessful|return/.test(s)) {
      return 'delivered';
    }
    if (/returned to shipper|return confirm|rts|return to origin|returned/.test(s)) {
      return 'rts';
    }
    if (
      /booked|order placed|pickup request|ready for pickup|information received|shipment created|manifested|not received|awaiting pickup/.test(s) &&
      !/picked up|arrived|in transit|dispatched|out for delivery|delivered/.test(s)
    ) {
      return 'booked';
    }
    if (/unsuccessful|refused|unreachable|failed|hold|pending|incomplete|closed|re-attempt/.test(s)) {
      return 'exception';
    }
    return 'in_transit';
  }

  // -------------------------------------------------------------------------
  // Exact Official Trax Sonic API v2.0 Parser (Pages 21–25 & 38–39)
  // -------------------------------------------------------------------------
  function parseSonicShipmentDetails(details, extraMeta) {
    const pickup = details.pickup || {};
    const shipper = details.shipper || {};
    const consignee = details.consignee || {};
    const orderInfo = details.order_information || {};
    const history = Array.isArray(details.tracking_history) ? details.tracking_history : [];

    const origin = pickup.origin || shipper.city || 'Origin';
    const destination = consignee.destination || 'Destination';

    const checkpoints = history.map((h) => ({
      status: h.status || 'Shipment Event',
      location: /origin|booked|service center/i.test(h.status || '') ? origin : destination,
      timestamp: h.date_time || (h.timestamp ? App.Aging.formatDateTime(h.timestamp * 1000) : ''),
      detail: h.status_reason ? `Reason: ${h.status_reason}` : ''
    }));

    const latestStatus = (checkpoints[0] && checkpoints[0].status) || 'Booked';
    const latestReason = history[0] && history[0].status_reason ? history[0].status_reason : '';
    const amountNum = orderInfo.amount !== undefined && orderInfo.amount !== null ? Number(orderInfo.amount) : null;
    const itemSummary = Array.isArray(orderInfo.items)
      ? orderInfo.items.map((it) => `${it.description || it.product_type || 'Item'} (x${it.quantity || 1})`).join(', ')
      : '';

    return {
      source: 'live',
      courier: 'Trax',
      trackingNumber: String(details.tracking_number || ''),
      orderId: details.order_id || '',
      liveStatus: latestReason ? `${latestStatus} (${latestReason})` : latestStatus,
      normalizedState: classifyCourierStatus(latestStatus),
      origin,
      destination,
      codAmount: amountNum !== null && !isNaN(amountNum) ? `Rs. ${amountNum.toLocaleString()}` : '',
      weight: orderInfo.weight ? `${orderInfo.weight} kg` : '',
      shippingMode: orderInfo.shipping_mode || '',
      itemSummary,
      consignee: consignee.name || '',
      consigneePhone: consignee.phone_number_1 || '',
      consigneeAddress: consignee.address || '',
      paymentStatus: (extraMeta && extraMeta.paymentStatus) || '',
      charges: (extraMeta && extraMeta.charges) || null,
      syncedAt: new Date().toISOString(),
      checkpoints: checkpoints.length
        ? checkpoints
        : [{ status: latestStatus, location: destination, timestamp: new Date().toISOString(), detail: 'Synced from Trax Sonic API' }]
    };
  }

  async function fetchTraxLive(trackingNumber, cfg) {
    const base = getTraxBaseUrl(cfg);
    // Endpoint 6: Tracking of a Shipment (Sonic PDF Page 21) — type=0 for Shipper tracking
    const trackUrl = `${base}/api/shipment/track?tracking_number=${encodeURIComponent(trackingNumber)}&type=0`;
    const headers = {
      Authorization: cfg.traxApiKey,
      Accept: 'application/json'
    };

    const res = await courierFetch(trackUrl, { method: 'GET', headers }, cfg);
    const data = res.data || {};

    // Sonic API: status === 0 is SUCCESS; status !== 0 is ERROR
    if (data.status !== 0 || !data.details) {
      throw new Error(data.message || `Trax Sonic API error (status ${data.status}). Check Tracking Number & API Key.`);
    }

    // Also fetch Payment Status (Page 27) & Charges (Page 26) in parallel (best-effort)
    const extraMeta = {};
    try {
      const [payRes, chgRes] = await Promise.allSettled([
        courierFetch(`${base}/api/shipment/payment_status?Tracking_number=${encodeURIComponent(trackingNumber)}&tracking_number=${encodeURIComponent(trackingNumber)}`, { method: 'GET', headers }, cfg),
        courierFetch(`${base}/api/shipment/charges?tracking_number=${encodeURIComponent(trackingNumber)}`, { method: 'GET', headers }, cfg)
      ]);
      if (payRes.status === 'fulfilled' && payRes.value.data && payRes.value.data.status === 0) {
        extraMeta.paymentStatus = payRes.value.data.current_payment_status || '';
      }
      if (chgRes.status === 'fulfilled' && chgRes.value.data && chgRes.value.data.status === 0 && chgRes.value.data.charges) {
        extraMeta.charges = chgRes.value.data.charges;
      }
    } catch (_) {}

    return parseSonicShipmentDetails(data.details, extraMeta);
  }

  // Endpoint 16: Order ID Tracking (Sonic PDF Page 38-39)
  async function fetchTraxByOrderId(orderId, cfg) {
    const c = cfg || loadConfig();
    if (!hasLiveCredentials('Trax', c)) {
      return { ok: false, missingCredentials: true, error: 'Enter your Trax Sonic API Key in API Settings first.' };
    }
    const base = getTraxBaseUrl(c);
    const url = `${base}/api/shipment/track/order_id?order_id=${encodeURIComponent(orderId)}&type=0`;
    try {
      const res = await courierFetch(
        url,
        { method: 'GET', headers: { Authorization: c.traxApiKey, Accept: 'application/json' } },
        c
      );
      const data = res.data || {};
      if (data.status !== 0 || !Array.isArray(data.details) || data.details.length === 0) {
        return { ok: false, error: data.message || `No Trax shipments found for Order ID "${orderId}".` };
      }
      return {
        ok: true,
        shipments: data.details.map((d) => parseSonicShipmentDetails(d))
      };
    } catch (err) {
      return formatFetchError(err);
    }
  }

  // Endpoints 18 & 19: Return Confirm (type=1) / Re-Attempt Request (type=2) (Sonic PDF Pages 41-42 & Appendix J)
  async function sendTraxRcpRequest(trackingNumber, typeCode, remarks) {
    const cfg = loadConfig();
    if (!hasLiveCredentials('Trax', cfg)) {
      return { ok: false, error: 'Trax Sonic API Key is not configured.' };
    }
    const base = getTraxBaseUrl(cfg);
    const url = `${base}/api/request/rcp`;
    try {
      const res = await courierFetch(
        url,
        {
          method: 'POST',
          headers: {
            Authorization: cfg.traxApiKey,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: JSON.stringify({
            tracking_number: App.Couriers.normalizeTracking(trackingNumber),
            type: Number(typeCode), // 1 = Return Confirm, 2 = Re-Attempt Request
            remarks: String(remarks || '').trim()
          })
        },
        cfg
      );
      const data = res.data || {};
      if (data.status !== 0) {
        return { ok: false, error: data.message || 'Trax request rejected.' };
      }
      if (App.Security) {
        App.Security.logAudit('TRAX_RCP', `CN ${trackingNumber}: type=${typeCode} (${data.message || 'Success'})`);
      }
      return { ok: true, message: data.message || 'Trax request submitted successfully.' };
    } catch (err) {
      return formatFetchError(err);
    }
  }

  // Endpoint 21: CRM Complaint (Sonic PDF Page 45 & Appendix H/I)
  // case_nature_id: 1 = Complaint | case_nature_type_id: 2 = Delay in Delivery, 5 = Return
  async function sendTraxCrmComplaint(trackingNumber, caseNatureTypeId, description) {
    const cfg = loadConfig();
    if (!hasLiveCredentials('Trax', cfg)) {
      return { ok: false, error: 'Trax Sonic API Key is not configured.' };
    }
    const base = getTraxBaseUrl(cfg);
    const url = `${base}/api/request/crm`;
    try {
      const res = await courierFetch(
        url,
        {
          method: 'POST',
          headers: {
            Authorization: cfg.traxApiKey,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: JSON.stringify({
            case_nature_id: 1,
            tracking_number: App.Couriers.normalizeTracking(trackingNumber),
            case_nature_type_id: Number(caseNatureTypeId || 2),
            description: String(description || 'Urgent delivery/return escalation from VIRSA Ops').trim()
          })
        },
        cfg
      );
      const data = res.data || {};
      if (data.status !== 0) {
        return { ok: false, error: data.message || 'Trax CRM complaint failed.' };
      }
      if (App.Security) {
        App.Security.logAudit('TRAX_CRM', `Complaint #${data.id || ''} logged for CN ${trackingNumber}`);
      }
      return { ok: true, id: data.id, message: data.message || 'CRM Complaint submitted.' };
    } catch (err) {
      return formatFetchError(err);
    }
  }

  // -------------------------------------------------------------------------
  // Official Leopards Courier (LCS) API Adapter
  // -------------------------------------------------------------------------
  async function fetchLeopardsLive(trackingNumber, cfg) {
    const res = await courierFetch(
      DEFAULT_ENDPOINTS.leopardsApiUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          api_key: cfg.leopardsApiKey,
          api_password: cfg.leopardsApiPassword,
          track_numbers: trackingNumber
        })
      },
      cfg
    );

    const data = res.data || {};
    if (data.status !== 1 || !Array.isArray(data.packet_list) || data.packet_list.length === 0) {
      throw new Error(data.error || 'Tracking number not found in Leopards API.');
    }

    const pkt = data.packet_list[0];
    const rawDetail = Array.isArray(pkt['Tracking Detail']) ? pkt['Tracking Detail'] : [];
    const checkpoints = rawDetail.map((step) => ({
      status: step.Status || 'Update',
      location: step.Origin || step.Destination || pkt.destination_city_name || 'Pakistan Hub',
      timestamp: step.Activity_datetime || step.Activity_Date || '',
      detail: step.Reason || ''
    }));

    const latestStatus = pkt.booked_packet_status || (checkpoints[0] && checkpoints[0].status) || 'In Transit';
    return {
      source: 'live',
      courier: 'Leopards',
      trackingNumber,
      orderId: pkt.booked_packet_order_id || '',
      liveStatus: latestStatus,
      normalizedState: classifyCourierStatus(latestStatus),
      origin: pkt.origin_city_name || 'Origin',
      destination: pkt.destination_city_name || 'Destination',
      codAmount: pkt.booked_packet_collect_amount ? `Rs. ${pkt.booked_packet_collect_amount}` : '',
      weight: pkt.booked_packet_weight ? `${pkt.booked_packet_weight}g` : '',
      shippingMode: pkt.shipment_type || '',
      consignee: pkt.consignment_name_eng || '',
      consigneePhone: pkt.consignment_phone || '',
      consigneeAddress: pkt.consignment_address || '',
      syncedAt: new Date().toISOString(),
      checkpoints: checkpoints.length
        ? checkpoints
        : [{ status: latestStatus, location: pkt.destination_city_name || 'Hub', timestamp: new Date().toISOString(), detail: 'Latest status from Leopards API' }]
    };
  }

  function formatFetchError(err) {
    const isCors = err && (err.name === 'TypeError' || /failed to fetch|cors|network/i.test(err.message));
    return {
      ok: false,
      corsBlocked: isCors,
      error: isCors
        ? 'Browser blocked direct API call (CORS). Double-click "Start-VIRSA-Portal.bat" in your project folder to launch on http://localhost:8787 with built-in zero-CORS Live API proxy!'
        : (err && err.message) || 'Live courier API request failed.'
    };
  }

  /**
   * Tracks a single parcel against the REAL Live Courier API.
   * NEVER returns fake/hardcoded "Lahore" dummy results!
   */
  async function trackParcel(trackingRaw, courierHint, parcelRef) {
    const trackingNumber = App.Couriers.normalizeTracking(trackingRaw);
    const p = parcelRef || App.Storage.findByTracking(trackingNumber);
    const courier =
      courierHint ||
      (p && p.courier) ||
      App.Couriers.detectCourier(trackingNumber, App.Storage.getState().customCouriers).courier ||
      'Trax';

    const cfg = loadConfig();

    if (!hasLiveCredentials(courier, cfg)) {
      return {
        ok: false,
        missingCredentials: true,
        courier,
        trackingNumber,
        error: `${courier} Live API Key is not configured yet. Go to "Live Tracking & API" → enter your ${courier} API credentials and click Save (on Sonic Portal: Profile → API Key at bottom).`
      };
    }

    try {
      let result;
      if (courier.toLowerCase().includes('trax')) {
        result = await fetchTraxLive(trackingNumber, cfg);
      } else if (courier.toLowerCase().includes('leopard')) {
        result = await fetchLeopardsLive(trackingNumber, cfg);
      } else {
        return {
          ok: false,
          courier,
          trackingNumber,
          error: `Live API integration is currently configured for Trax (Sonic) and Leopards (LCS). Use Official Portal link for ${courier}.`
        };
      }
      persistTrackingSnapshot(p, result, cfg);
      return { ok: true, data: result };
    } catch (err) {
      return Object.assign({ courier, trackingNumber }, formatFetchError(err));
    }
  }

  function persistTrackingSnapshot(parcel, trackingData, cfg) {
    if (!parcel || !trackingData) return;
    // Ignore pre-transit / booked-only API responses; track only once parcel is In Transit
    if (parcel.status === 'Booked / Pickup' || trackingData.normalizedState === 'booked') return;
    const patch = {
      liveCheckpoint: trackingData.liveStatus,
      courierStatus: trackingData.liveStatus,
      liveLocation: `${trackingData.origin} → ${trackingData.destination}`,
      liveSyncedAt: trackingData.syncedAt,
      liveSource: 'live',
      trackingHistory: trackingData.checkpoints.slice(0, 15)
    };
    if (!parcel.customerName && trackingData.consignee) patch.customerName = trackingData.consignee;
    if (!parcel.customerPhone && trackingData.consigneePhone) patch.customerPhone = trackingData.consigneePhone;
    if (!parcel.destinationCity && trackingData.destination) patch.destinationCity = trackingData.destination;
    if (!parcel.codAmount && trackingData.codAmount) {
      const n = parseFloat(String(trackingData.codAmount).replace(/[^\d.]/g, ''));
      if (!isNaN(n) && n > 0) patch.codAmount = Math.round(n);
    }
    if ((!parcel.orderId || parcel.orderId.startsWith('ORD-')) && trackingData.orderId) {
      patch.orderId = trackingData.orderId;
    }

    App.Storage.updateParcel(parcel.id, patch);

    if (
      cfg &&
      cfg.autoMarkDeliveredOnSync &&
      trackingData.normalizedState === 'delivered' &&
      (parcel.status === 'In Transit' || parcel.status === 'Booked / Pickup')
    ) {
      App.Storage.updateParcelStatus(parcel.id, 'Delivered');
    } else if ((trackingData.normalizedState === 'returned' || trackingData.normalizedState === 'rts') && parcel.status === 'In Transit') {
      // Never auto-verify returns from courier API; keep as Return In Transit until physically scanned
      App.Storage.updateParcelStatus(parcel.id, 'Return In Transit');
    }
  }

  let autoTrackTimer = null;
  let autoTrackBusy = false;

  async function syncAllInTransit(onProgress, options) {
    const opts = options || {};
    const st = App.Storage.getState();
    if (!st || st.isSampleData || !Array.isArray(st.parcels) || st.parcels.length === 0) {
      return { total: 0, synced: 0, failed: 0, skippedNoKey: 0, autoDelivered: 0, corsError: false, lastError: '' };
    }
    const minAgeMs = Number(opts.minAgeMs || 0);
    const now = Date.now();

    const active = App.Storage.getParcels().filter((p) => {
      if (!['In Transit', 'Return In Transit'].includes(p.status)) return false;
      if (minAgeMs > 0 && p.liveSyncedAt) {
        const last = Date.parse(p.liveSyncedAt);
        if (!isNaN(last) && now - last < minAgeMs) return false;
      }
      return true;
    });

    const cfg = loadConfig();
    let synced = 0;
    let failed = 0;
    let skippedNoKey = 0;
    let autoDelivered = 0;
    let corsError = false;
    let lastError = '';

    for (let i = 0; i < active.length; i++) {
      const p = active[i];
      if (!hasLiveCredentials(p.courier, cfg)) {
        skippedNoKey++;
        if (onProgress) onProgress(i + 1, active.length, p);
        continue;
      }
      const beforeStatus = p.status;
      const res = await trackParcel(p.trackingNumber, p.courier, p);
      if (res.ok) {
        synced++;
        const updated = App.Storage.findById(p.id);
        if (beforeStatus !== 'Delivered' && updated && updated.status === 'Delivered') {
          autoDelivered++;
        }
      } else {
        failed++;
        lastError = res.error || '';
        if (res.corsBlocked) {
          corsError = true;
          break;
        }
      }
      if (onProgress) onProgress(i + 1, active.length, p);
    }

    if (synced > 0) saveConfig({ lastSyncedAt: new Date().toISOString() });
    if (App.Security && !opts.silent) {
      App.Security.logAudit('LIVE_SYNC', `Live synced ${synced}/${active.length} parcels (${failed} failed, ${skippedNoKey} missing key)`);
    }

    return { total: active.length, synced, failed, skippedNoKey, autoDelivered, corsError, lastError };
  }

  /**
   * Automatically tracks active parcels in the background every 5 minutes
   * (plus once shortly after startup) whenever Courier API keys are configured.
   */
  function startTimelyTrackingLoop(onUpdated) {
    if (autoTrackTimer) clearInterval(autoTrackTimer);
    const runTick = async () => {
      if (autoTrackBusy) return;
      const st = App.Storage.getState();
      if (!st || st.isSampleData || !Array.isArray(st.parcels) || st.parcels.length === 0) return;
      const cfg = loadConfig();
      if (!cfg.autoLiveTrackEnabled) return;
      if (!hasLiveCredentials('Trax', cfg) && !hasLiveCredentials('Leopards', cfg)) return;
      autoTrackBusy = true;
      try {
        const res = await syncAllInTransit(null, { minAgeMs: 4 * 60 * 1000, silent: true });
        if (res.synced > 0 && typeof onUpdated === 'function') onUpdated(res);
      } catch (_) {}
      autoTrackBusy = false;
    };

    setTimeout(runTick, 4500);
    autoTrackTimer = setInterval(runTick, 5 * 60 * 1000);
  }

  /**
   * On-demand Dashboard Courier Scan Audit:
   *  - Updates parcels confirmed scanned/delivered/RTO by Trax or Leopards API
   *  - Flags OUR-end mismatches (we marked In Transit, but courier still says Booked / Not Received)
   *  - Flags COURIER-end issues (exceptions, refused, hold, failed attempts, API not found)
   *  - Flags Missed Local Scans (still Pending/Booked in app, but courier already picked up / scanned)
   */
  async function verifyCourierScans(onProgress) {
    const st = App.Storage.getState();
    if (!st || st.isSampleData || !Array.isArray(st.parcels) || st.parcels.length === 0) {
      return { ok: false, error: 'No parcels in app yet. Upload a sheet or add parcels first.' };
    }
    const cfg = loadConfig();
    const candidates = st.parcels.filter((p) =>
      ['Booked / Pickup', 'In Transit', 'Return In Transit'].includes(p.status)
    );
    if (candidates.length === 0) {
      return { ok: true, checked: 0, updated: 0, ourEndIssues: [], courierEndIssues: [], missedLocalScans: [], skippedNoKey: 0 };
    }

    let checked = 0;
    let updated = 0;
    let skippedNoKey = 0;
    const ourEndIssues = [];
    const courierEndIssues = [];
    const missedLocalScans = [];

    for (let i = 0; i < candidates.length; i++) {
      const p = candidates[i];
      if (!hasLiveCredentials(p.courier, cfg)) {
        skippedNoKey++;
        if (onProgress) onProgress(i + 1, candidates.length, p);
        continue;
      }
      checked++;
      const prevStatus = p.status;
      const res = await trackParcel(p.trackingNumber, p.courier, p);
      if (!res.ok) {
        courierEndIssues.push({
          parcel: p,
          side: 'Courier / API',
          detail: res.error || 'Tracking number not found at courier'
        });
        if (res.corsBlocked) break;
      } else {
        const d = res.data;
        const norm = d.normalizedState;
        if (norm === 'booked') {
          if (prevStatus === 'In Transit') {
            ourEndIssues.push({
              parcel: p,
              side: 'Our End / Handover',
              detail: `Marked Dispatched by us, but ${p.courier} still shows "${d.liveStatus}" (not scanned by courier yet)`
            });
          }
        } else {
          // Courier HAS scanned this parcel (in_transit, delivered, rts, or exception)
          if (prevStatus === 'Booked / Pickup') {
            const target =
              norm === 'delivered' && cfg.autoMarkDeliveredOnSync
                ? 'Delivered'
                : (norm === 'rts' || norm === 'returned')
                ? 'Return In Transit'
                : 'In Transit';
            App.Storage.updateParcel(p.id, {
              liveCheckpoint: d.liveStatus,
              courierStatus: d.liveStatus,
              liveLocation: `${d.origin} → ${d.destination}`,
              liveSyncedAt: d.syncedAt,
              liveSource: 'live',
              trackingHistory: (d.checkpoints || []).slice(0, 15)
            });
            App.Storage.updateParcelStatus(p.id, target);
            updated++;
            missedLocalScans.push({
              parcel: App.Storage.findById(p.id) || p,
              side: 'Missed Our Scan',
              detail: `Updated to ${target} — ${p.courier} already scanned ("${d.liveStatus}")`
            });
          } else {
            updated++;
          }
          if (norm === 'exception' || norm === 'rts') {
            courierEndIssues.push({
              parcel: App.Storage.findById(p.id) || p,
              side: 'Courier End',
              detail: `${p.courier}: ${d.liveStatus}`
            });
          }
        }
      }
      if (onProgress) onProgress(i + 1, candidates.length, p);
    }

    if (checked > 0) saveConfig({ lastSyncedAt: new Date().toISOString() });
    if (App.Security) {
      App.Security.logAudit(
        'COURIER_VERIFY',
        `Verified ${checked} parcels: ${updated} updated, ${ourEndIssues.length} handover gaps, ${courierEndIssues.length} courier issues`
      );
    }
    return { ok: true, checked, updated, ourEndIssues, courierEndIssues, missedLocalScans, skippedNoKey };
  }

  App.TrackingAPI = {
    DEFAULT_ENDPOINTS,
    loadConfig,
    saveConfig,
    isLocalProxyActive,
    hasLiveCredentials,
    getOfficialPortalUrl,
    trackParcel,
    fetchTraxByOrderId,
    sendTraxRcpRequest,
    sendTraxCrmComplaint,
    syncAllInTransit,
    verifyCourierScans,
    startTimelyTrackingLoop
  };
})(window);
