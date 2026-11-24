/**
 * js/cloud-sync.js
 * Dual-Layer Persistence & Multi-Device Sync Engine for MM VIRSA Ops:
 *  Layer 1 (Always-On Local Disk DB):
 *    When running inside MM-VIRSA-Ops.exe (or Start-VIRSA-Portal.bat), mirrors every change
 *    to %LOCALAPPDATA%\MM-VIRSA-Ops\virsa-database.json + automatic daily rolling backups.
 *  Layer 2 (Two-Way Cloud Sync — Desktop .exe <-> Mobile Phones):
 *    Supports Google Sheets Web App (free) OR Firebase Realtime Database REST URL.
 *    Uses timestamp-based merge (updatedAt) so desktop & mobile never overwrite each other.
 */
(function (global) {
  const App = (global.DispatchApp = global.DispatchApp || {});

  const SYNC_CFG_KEY = 'virsa_ops_cloud_sync_v1';
  const SETTINGS_TS_KEY = 'virsa_ops_settings_ts_v1';
  const WIPED_AT_KEY = 'virsa_ops_wiped_at_v1';
  const DEFAULT_SUPABASE_URL = 'https://fhugtaqdzsbuhhymkctf.supabase.co';
  const DEFAULT_SUPABASE_KEY = 'sb_publishable_O4fKVTPCWKC0YGKIa1aNhg_V3bvNPqr';
  const DEFAULT_VIRSA_SHEETS_URL =
    'https://script.google.com/macros/s/AKfycbxJdx28hpXXkFv6W-mcdwxDYX85u5RU27KOoKV4fG7bQWUO1gEkcXygB-c4hkf0Y_x6/exec';

  function supabaseHeaders(key, extra) {
    const k = String(key || '').trim();
    const h = Object.assign({ apikey: k }, extra || {});
    if (k.startsWith('eyJ')) h.Authorization = `Bearer ${k}`;
    return h;
  }

  function getSupabaseBase(cfg) {
    const c = cfg || loadConfig();
    const raw = (c.provider === 'supabase' && c.endpointUrl) ? c.endpointUrl : DEFAULT_SUPABASE_URL;
    return String(raw).trim().replace(/\/+$/, '').replace(/\/rest\/v1\/[a-z0-9_]+$/i, '');
  }

  function getSupabaseKey(cfg) {
    const c = cfg || loadConfig();
    return String((c.provider === 'supabase' && c.secretToken) ? c.secretToken : DEFAULT_SUPABASE_KEY).trim();
  }
  let pushTimer = null;
  let pullInterval = null;
  let isSyncingNow = false;
  let hasPendingLocalChanges = false;
  let lifecycleBound = false;
  let onStatusChange = null;

  function getWipedAt() {
    try {
      return Number(global.localStorage.getItem(WIPED_AT_KEY) || 0) || 0;
    } catch (_) {
      return 0;
    }
  }

  function setWipedAt(ts) {
    try {
      global.localStorage.setItem(WIPED_AT_KEY, String(ts || Date.now()));
    } catch (_) {}
  }

  function getSettingsUpdatedAt() {
    try {
      return Number(global.localStorage.getItem(SETTINGS_TS_KEY) || 0) || 0;
    } catch (_) {
      return 0;
    }
  }

  function setSettingsUpdatedAt(ts) {
    try {
      global.localStorage.setItem(SETTINGS_TS_KEY, String(ts || Date.now()));
    } catch (_) {}
  }

  function getLocalSharedSettings() {
    const apiCfg = App.TrackingAPI ? App.TrackingAPI.loadConfig() : null;
    const secCfg = App.Security ? App.Security.loadConfig() : null;
    const staffList = App.Security && App.Security.getStaffList ? App.Security.getStaffList() : [];
    const syncCfg = loadConfig();
    return {
      updatedAt: getSettingsUpdatedAt(),
      wipedAt: getWipedAt(),
      syncAccountLabel: syncCfg.accountLabel || '',
      apiConfig: apiCfg
        ? {
            traxEnv: apiCfg.traxEnv || 'live',
            traxApiKey: apiCfg.traxApiKey || '',
            leopardsApiKey: apiCfg.leopardsApiKey || '',
            leopardsApiPassword: apiCfg.leopardsApiPassword || '',
            corsProxyUrl: apiCfg.corsProxyUrl || '',
            autoMarkDeliveredOnSync: Boolean(apiCfg.autoMarkDeliveredOnSync)
          }
        : null,
      securityConfig: secCfg
        ? {
            pinEnabled: Boolean(secCfg.pinEnabled),
            pinSalt: secCfg.pinSalt || '',
            pinHash: secCfg.pinHash || '',
            autoLockMinutes: Number(secCfg.autoLockMinutes) || 0,
            operatorName: secCfg.operatorName || 'VIRSA Station'
          }
        : null,
      staffAccounts: staffList
    };
  }

  function applyRemoteSharedSettings(remoteShared) {
    if (!remoteShared || typeof remoteShared !== 'object') return false;
    const localTs = getSettingsUpdatedAt();
    const remoteTs = Number(remoteShared.updatedAt) || 0;

    // Also pull if local device has no API keys or staff accounts yet while remote has them
    const localApi = App.TrackingAPI ? App.TrackingAPI.loadConfig() : {};
    const remoteApi = remoteShared.apiConfig || {};
    const localHasKeys = Boolean(localApi.traxApiKey || localApi.leopardsApiKey);
    const remoteHasKeys = Boolean(remoteApi.traxApiKey || remoteApi.leopardsApiKey);
    const localStaff = App.Security && App.Security.getStaffList ? App.Security.getStaffList() : [];
    const remoteStaff = Array.isArray(remoteShared.staffAccounts) ? remoteShared.staffAccounts : [];
    const localOnlyDefaultSeed =
      localTs === 0 && (localStaff.length === 0 || localStaff.every((u) => u && u.isDefaultSeed));

    if (
      remoteTs <= localTs &&
      !(remoteHasKeys && !localHasKeys) &&
      !(remoteStaff.length > 0 && localOnlyDefaultSeed)
    ) {
      return false;
    }

    let changed = false;
    if (remoteShared.apiConfig && App.TrackingAPI) {
      App.TrackingAPI.saveConfig({
        traxEnv: remoteApi.traxEnv || 'live',
        traxApiKey: remoteApi.traxApiKey || '',
        leopardsApiKey: remoteApi.leopardsApiKey || '',
        leopardsApiPassword: remoteApi.leopardsApiPassword || '',
        corsProxyUrl: remoteApi.corsProxyUrl || '',
        autoMarkDeliveredOnSync: Boolean(remoteApi.autoMarkDeliveredOnSync)
      });
      changed = true;
    }

    if (remoteShared.securityConfig) {
      const rSec = remoteShared.securityConfig;
      const curSec = App.Security ? App.Security.loadConfig() : {};
      const nextSec = Object.assign({}, curSec, {
        pinEnabled: Boolean(rSec.pinEnabled),
        pinSalt: rSec.pinSalt || '',
        pinHash: rSec.pinHash || '',
        autoLockMinutes: Number(rSec.autoLockMinutes) || 0,
        operatorName: rSec.operatorName || curSec.operatorName || 'VIRSA Station'
      });
      try {
        global.localStorage.setItem('virsa_ops_security_v1', JSON.stringify(nextSec));
        changed = true;
      } catch (_) {}
    }

    if (Array.isArray(remoteShared.staffAccounts)) {
      try {
        global.localStorage.setItem('virsa_ops_staff_v1', JSON.stringify(remoteShared.staffAccounts));
        changed = true;
      } catch (_) {}
    }

    if (typeof remoteShared.syncAccountLabel === 'string' && remoteShared.syncAccountLabel.trim()) {
      saveConfig({ accountLabel: remoteShared.syncAccountLabel.trim() });
      changed = true;
    }

    if (changed) {
      setSettingsUpdatedAt(remoteTs || Date.now());
    }
    return changed;
  }

  function markSettingsChanged() {
    setSettingsUpdatedAt(Date.now());
    notifyLocalMutation();
  }

  function computeFingerprint(parcels, deletedIds, customCouriers, sharedSettings) {
    const pSig = (Array.isArray(parcels) ? parcels : [])
      .map((p) => `${p.trackingNumber}|${p.status}|${p.updatedAt || ''}|${p.returnedAt || ''}|${p.notes || ''}`)
      .sort()
      .join(';');
    const dSig = (Array.isArray(deletedIds) ? deletedIds : []).slice().sort().join(',');
    const cSig = (Array.isArray(customCouriers) ? customCouriers : []).map((c) => c.name).sort().join(',');
    const sTs = sharedSettings ? String(sharedSettings.updatedAt || 0) : '0';
    return `${pSig}#${dSig}#${cSig}#${sTs}`;
  }

  function defaultSyncConfig() {
    return {
      enabled: true,
      provider: 'supabase', // 'supabase' | 'google_sheets' | 'firebase'
      endpointUrl: DEFAULT_SUPABASE_URL,
      secretToken: DEFAULT_SUPABASE_KEY,
      sheetsMirrorUrl: DEFAULT_VIRSA_SHEETS_URL,
      autoSync: true,
      lastCloudSyncAt: null,
      lastDiskSaveAt: null,
      lastError: ''
    };
  }

  function loadConfig() {
    try {
      const raw = global.localStorage.getItem(SYNC_CFG_KEY);
      if (!raw) return defaultSyncConfig();
      const parsed = App.Security ? App.Security.safeJSONParse(raw) : JSON.parse(raw);
      const merged = Object.assign(defaultSyncConfig(), parsed);
      // Auto-upgrade empty or legacy old MM-VIRSA sheet URLs to REED Supabase + Sheets Hybrid
      if (!merged.endpointUrl || merged.endpointUrl.includes('AKfycbxpROCBmg_m892lKf')) {
        merged.provider = 'supabase';
        merged.endpointUrl = DEFAULT_SUPABASE_URL;
        merged.secretToken = DEFAULT_SUPABASE_KEY;
        merged.sheetsMirrorUrl = DEFAULT_VIRSA_SHEETS_URL;
        merged.enabled = true;
      }
      return merged;
    } catch (_) {
      return defaultSyncConfig();
    }
  }

  function saveConfig(patch) {
    const next = Object.assign({}, loadConfig(), patch);
    try {
      global.localStorage.setItem(SYNC_CFG_KEY, JSON.stringify(next));
    } catch (_) {}
    if (onStatusChange) onStatusChange();
    return next;
  }

  function hasLocalDiskBackend() {
    return Boolean(
      global.location &&
        (global.location.hostname === 'localhost' || global.location.hostname === '127.0.0.1') &&
        global.location.port === '8787'
    );
  }

  // -------------------------------------------------------------------------
  // Smart Conflict-Free Merge (Preserves newest update per parcel + deletions)
  // -------------------------------------------------------------------------
  function mergeParcelLists(localList, remoteList, deletedIdsSet) {
    const map = new Map();
    const deleted = deletedIdsSet || new Set();

    const ingest = (item) => {
      if (!item || !item.trackingNumber) return;
      const key = App.Couriers.normalizeTracking(item.trackingNumber);
      if (deleted.has(item.id) || deleted.has(key)) return;

      const prev = map.get(key);
      if (!prev) {
        map.set(key, item);
        return;
      }
      const prevTs = Date.parse(prev.updatedAt || prev.createdAt || 0) || 0;
      const currTs = Date.parse(item.updatedAt || item.createdAt || 0) || 0;
      if (currTs >= prevTs) {
        // Keep the newer version, preserving non-empty fields from older if newer lacks them
        map.set(key, Object.assign({}, prev, item));
      }
    };

    (Array.isArray(localList) ? localList : []).forEach(ingest);
    (Array.isArray(remoteList) ? remoteList : []).forEach(ingest);

    return Array.from(map.values()).sort((a, b) => {
      const ta = Date.parse(a.createdAt || a.updatedAt || 0) || 0;
      const tb = Date.parse(b.createdAt || b.updatedAt || 0) || 0;
      return tb - ta;
    });
  }

  function mergeCouriers(localC, remoteC) {
    const seen = new Set();
    const out = [];
    [...(localC || []), ...(remoteC || [])].forEach((c) => {
      if (!c || !c.name) return;
      const k = c.name.trim().toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        out.push(c);
      }
    });
    return out;
  }

  // -------------------------------------------------------------------------
  // Layer 1B: Web App & Mobile IndexedDB Database (MM_VIRSA_DB)
  // -------------------------------------------------------------------------
  function openWebDB() {
    return new Promise((resolve, reject) => {
      if (!global.indexedDB) return reject(new Error('IndexedDB unavailable'));
      const req = global.indexedDB.open('MM_VIRSA_DB', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbReadPayload() {
    try {
      const db = await openWebDB();
      return await new Promise((resolve) => {
        const tx = db.transaction('kv', 'readonly');
        const req = tx.objectStore('kv').get('virsa_db_v1');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch (_) {
      return null;
    }
  }

  async function idbWritePayload(payload) {
    try {
      const db = await openWebDB();
      return await new Promise((resolve) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(payload, 'virsa_db_v1');
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch (_) {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Layer 1: Local Disk Database (/api/db on Desktop .exe) OR Web IndexedDB
  // -------------------------------------------------------------------------
  async function loadFromLocalDisk() {
    if (!hasLocalDiskBackend()) {
      const idbData = await idbReadPayload();
      if (idbData && idbData.state && Array.isArray(idbData.state.parcels)) {
        const localState = App.Storage.getState();
        if (!idbData.state.isSampleData || localState.isSampleData || localState.parcels.length === 0) {
          const mergedParcels =
            localState.isSampleData && !idbData.state.isSampleData
              ? idbData.state.parcels
              : mergeParcelLists(localState.parcels, idbData.state.parcels, new Set(idbData.state.deletedIds || []));
          App.Storage.applySyncedState({
            parcels: mergedParcels,
            customCouriers: mergeCouriers(localState.customCouriers, idbData.state.customCouriers),
            deletedIds: Array.from(new Set([...(localState.deletedIds || []), ...(idbData.state.deletedIds || [])])).slice(-300),
            isSampleData: Boolean(idbData.state.isSampleData && localState.isSampleData)
          });
        }
        if (idbData.sharedSettings) {
          applyRemoteSharedSettings(idbData.sharedSettings);
        }
        saveConfig({ lastDiskSaveAt: idbData.savedAt || new Date().toISOString() });
        return { ok: true, dbPath: 'Web IndexedDB (MM_VIRSA_DB)' };
      }
      await saveToLocalDisk();
      return { ok: true, dbPath: 'Web IndexedDB (MM_VIRSA_DB)', initialized: true };
    }
    try {
      const res = await fetch('/api/db', { method: 'GET', cache: 'no-store' });
      if (!res.ok) return { ok: false };
      const data = await res.json();
      if (data && data.exists && data.state && Array.isArray(data.state.parcels)) {
        const localState = App.Storage.getState();
        // If local disk has real data (not sample) or browser storage was cleared/sample, restore from disk!
        if (!data.state.isSampleData || localState.isSampleData || localState.parcels.length === 0) {
          const mergedParcels =
            localState.isSampleData && !data.state.isSampleData
              ? data.state.parcels
              : mergeParcelLists(localState.parcels, data.state.parcels, new Set(data.state.deletedIds || []));
          App.Storage.applySyncedState({
            parcels: mergedParcels,
            customCouriers: mergeCouriers(localState.customCouriers, data.state.customCouriers),
            deletedIds: Array.from(new Set([...(localState.deletedIds || []), ...(data.state.deletedIds || [])])).slice(-300),
            isSampleData: Boolean(data.state.isSampleData && localState.isSampleData)
          });
        }
        if (data.sharedSettings) {
          applyRemoteSharedSettings(data.sharedSettings);
        }
        saveConfig({ lastDiskSaveAt: data.savedAt || new Date().toISOString() });
        return { ok: true, dbPath: data.dbPath || '' };
      } else {
        // First run: persist current state to disk immediately
        await saveToLocalDisk();
        return { ok: true, initialized: true };
      }
    } catch (_) {
      return { ok: false };
    }
  }

  async function saveToLocalDisk() {
    const payload = {
      app: 'MM-VIRSA-Ops',
      savedAt: new Date().toISOString(),
      state: App.Storage.getState(),
      sharedSettings: getLocalSharedSettings()
    };
    if (!hasLocalDiskBackend()) {
      const ok = await idbWritePayload(payload);
      if (ok) saveConfig({ lastDiskSaveAt: payload.savedAt });
      return { ok };
    }
    try {
      const res = await fetch('/api/db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        saveConfig({ lastDiskSaveAt: payload.savedAt });
        return { ok: true };
      }
      return { ok: false };
    } catch (_) {
      return { ok: false };
    }
  }

  // -------------------------------------------------------------------------
  // Layer 2: Two-Way Cloud Sync (Google Sheets Web App / Firebase RTDB)
  // -------------------------------------------------------------------------
  async function cloudFetchOnce(url, options) {
    const opts = options || {};
    const method = (opts.method || 'GET').toUpperCase();
    if (hasLocalDiskBackend()) {
      const proxyRes = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          method,
          headers: opts.headers || {},
          body: opts.body || null
        })
      });
      const text = await proxyRes.text();
      return { ok: proxyRes.ok, status: proxyRes.status, text };
    }
    const res = await fetch(url, {
      method,
      headers: opts.headers || {},
      body: method === 'GET' ? undefined : opts.body
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  }

  // Automatic single retry after 500ms for Google Apps Script cold-starts / transient redirects
  async function cloudFetch(url, options) {
    try {
      const first = await cloudFetchOnce(url, options);
      if (first.ok) return first;
      await new Promise((r) => setTimeout(r, 500));
      return await cloudFetchOnce(url, options);
    } catch (err) {
      await new Promise((r) => setTimeout(r, 500));
      return await cloudFetchOnce(url, options);
    }
  }

  function buildFirebaseUrl(baseUrl, secretToken) {
    let url = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!url.endsWith('.json')) {
      url += '/virsa_ops_ledger.json';
    }
    if (secretToken) {
      url += (url.includes('?') ? '&' : '?') + 'auth=' + encodeURIComponent(secretToken);
    }
    return url;
  }

  function buildGoogleSheetsUrl(baseUrl, secretToken, action) {
    const url = String(baseUrl || '').trim();
    const sep = url.includes('?') ? '&' : '?';
    let full = `${url}${sep}action=${encodeURIComponent(action || 'pull')}`;
    const cleanTok = String(secretToken || '').trim();
    if (cleanTok) {
      full += `&token=${encodeURIComponent(cleanTok)}`;
    }
    return full;
  }

  async function syncWithCloud(reason) {
    const cfg = loadConfig();
    if (!cfg.enabled || !cfg.endpointUrl) {
      return { ok: false, skipped: true, error: 'Cloud Sync is not enabled yet.' };
    }
    if (isSyncingNow) {
      if (reason === 'manual') {
        // Wait up to 4.5s for any in-flight poll to finish before running manual sync
        const deadline = Date.now() + 4500;
        while (isSyncingNow && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 150));
        }
      }
      if (isSyncingNow) {
        if (reason === 'auto_push' || reason === 'manual') hasPendingLocalChanges = true;
        return { ok: false, skipped: true };
      }
    }
    isSyncingNow = true;
    const pushedOnEntry = hasPendingLocalChanges;
    hasPendingLocalChanges = false;
    if (onStatusChange) onStatusChange(false);

    try {
      const localState = App.Storage.getState();
      const localShared = getLocalSharedSettings();
      const localFpBefore = computeFingerprint(localState.parcels, localState.deletedIds, localState.customCouriers, localShared);
      let remoteState = null;

      // 1. PULL remote cloud state first
      if (cfg.provider === 'supabase') {
        const sbKey = getSupabaseKey(cfg);
        if (!sbKey) throw new Error('Enter your Supabase publishable/anon key in Sync Secret / Auth Token.');
        const sbBase = `${getSupabaseBase(cfg)}/rest/v1/reed_sync_state`;
        const pullRes = await cloudFetch(`${sbBase}?id=eq.main&select=payload`, {
          method: 'GET',
          headers: supabaseHeaders(sbKey, { Accept: 'application/json' })
        });
        if (!pullRes.ok) throw new Error(`Supabase Pull HTTP ${pullRes.status}: ${pullRes.text.slice(0, 120)}`);
        const rows = App.Security.safeJSONParse(pullRes.text);
        if (Array.isArray(rows) && rows[0] && rows[0].payload && Array.isArray(rows[0].payload.parcels)) {
          remoteState = rows[0].payload;
        }
      } else if (cfg.provider === 'firebase') {
        const url = buildFirebaseUrl(cfg.endpointUrl, cfg.secretToken);
        const pullRes = await cloudFetch(url, { method: 'GET' });
        if (!pullRes.ok) throw new Error(`Firebase Pull HTTP ${pullRes.status}`);
        const parsed = pullRes.text && pullRes.text !== 'null' ? App.Security.safeJSONParse(pullRes.text) : null;
        if (parsed && Array.isArray(parsed.parcels)) remoteState = parsed;
      } else {
        // Google Sheets Apps Script Web App
        const pullUrl = buildGoogleSheetsUrl(cfg.endpointUrl, cfg.secretToken, 'pull');
        const pullRes = await cloudFetch(pullUrl, { method: 'GET' });
        if (!pullRes.ok) throw new Error(`Google Sheets Pull HTTP ${pullRes.status}`);
        let parsed = null;
        try {
          parsed = App.Security.safeJSONParse(pullRes.text);
        } catch (parseErr) {
          // If remote sheet JSON was truncated/corrupted in a chunk, heal it by pushing valid local state
          if (localState.parcels.length > 0 && !localState.isSampleData) {
            parsed = null;
          } else {
            throw parseErr;
          }
        }
        if (parsed && parsed.error) throw new Error(parsed.error);
        if (parsed && Array.isArray(parsed.parcels)) remoteState = parsed;
      }

      const remoteFp = remoteState
        ? computeFingerprint(remoteState.parcels, remoteState.deletedIds, remoteState.customCouriers, remoteState.sharedSettings)
        : '';

      // 2. MERGE local + remote safely using updatedAt, deletedIds & host wipedAt
      const remoteWipedAt = Number(remoteState && remoteState.sharedSettings && remoteState.sharedSettings.wipedAt) || 0;
      const effectiveWipedAt = Math.max(getWipedAt(), remoteWipedAt);
      if (effectiveWipedAt > getWipedAt()) setWipedAt(effectiveWipedAt);

      const mergedDeleted =
        reason === 'host_wipe'
          ? []
          : Array.from(
              new Set([...(localState.deletedIds || []), ...((remoteState && remoteState.deletedIds) || [])])
            ).slice(-400);
      const delSet = new Set(mergedDeleted);

      let mergedParcels;
      if (reason === 'host_wipe') {
        mergedParcels = [];
      } else if (remoteState && remoteState.parcels.length > 0 && localState.isSampleData && !remoteState.isSampleData) {
        mergedParcels = remoteState.parcels.filter((p) => !delSet.has(p.id));
      } else {
        mergedParcels = mergeParcelLists(localState.parcels, remoteState ? remoteState.parcels : [], delSet);
      }

      if (effectiveWipedAt > 0 && reason !== 'host_wipe') {
        mergedParcels = mergedParcels.filter((p) => {
          const ts = Date.parse(p.createdAt || p.updatedAt || 0) || 0;
          return ts >= effectiveWipedAt;
        });
      }

      const mergedCouriers = mergeCouriers(localState.customCouriers, remoteState ? remoteState.customCouriers : []);
      const isStillSample = reason === 'host_wipe' ? false : Boolean(localState.isSampleData && (!remoteState || remoteState.isSampleData));
      const settingsChanged =
        reason === 'host_wipe'
          ? false
          : remoteState && remoteState.sharedSettings
          ? applyRemoteSharedSettings(remoteState.sharedSettings)
          : false;
      const mergedShared = getLocalSharedSettings();
      const mergedFp = computeFingerprint(mergedParcels, mergedDeleted, mergedCouriers, mergedShared);
      const localParcelsChanged = mergedFp !== localFpBefore;
      const localChanged = localParcelsChanged || settingsChanged;

      if (localParcelsChanged) {
        App.Storage.applySyncedState({
          parcels: mergedParcels,
          customCouriers: mergedCouriers,
          deletedIds: mergedDeleted,
          isSampleData: isStillSample
        });
      }

      // 3. SMART PUSH: Only write to Google Sheet / Firebase when remote differs or manual push requested
      const needsRemotePush =
        !remoteState ||
        mergedFp !== remoteFp ||
        pushedOnEntry ||
        reason === 'manual' ||
        reason === 'auto_push' ||
        reason === 'host_wipe';

      const syncedNowISO = new Date().toISOString();

      if (needsRemotePush) {
        const pushPayload = {
          app: 'MM-VIRSA-Ops',
          token: String(cfg.secretToken || '').trim(),
          syncedAt: syncedNowISO,
          isSampleData: isStillSample,
          customCouriers: mergedCouriers,
          deletedIds: mergedDeleted,
          sharedSettings: mergedShared,
          parcels: mergedParcels
        };

        if (cfg.provider === 'supabase') {
          const sbKey = getSupabaseKey(cfg);
          const sbBase = `${getSupabaseBase(cfg)}/rest/v1/reed_sync_state`;
          const pushRes = await cloudFetch(`${sbBase}?on_conflict=id`, {
            method: 'POST',
            headers: supabaseHeaders(sbKey, {
              'Content-Type': 'application/json',
              Prefer: 'resolution=merge-duplicates,return=minimal'
            }),
            body: JSON.stringify({
              id: 'main',
              payload: pushPayload,
              updated_at: syncedNowISO
            })
          });
          if (!pushRes.ok) throw new Error(`Supabase Push HTTP ${pushRes.status}: ${pushRes.text.slice(0, 120)}`);

          // Hybrid Background Mirror to REED Google Sheet (non-blocking)
          const mirrorUrl = cfg.sheetsMirrorUrl || DEFAULT_VIRSA_SHEETS_URL;
          if (mirrorUrl) {
            const mirrorPushUrl = buildGoogleSheetsUrl(mirrorUrl, '', 'push');
            cloudFetchOnce(mirrorPushUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'text/plain;charset=utf-8' },
              body: JSON.stringify(Object.assign({}, pushPayload, { token: '' }))
            }).catch(() => {});
          }
        } else if (cfg.provider === 'firebase') {
          const url = buildFirebaseUrl(cfg.endpointUrl, cfg.secretToken);
          const pushRes = await cloudFetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pushPayload)
          });
          if (!pushRes.ok) throw new Error(`Firebase Push HTTP ${pushRes.status}`);
        } else {
          const pushUrl = buildGoogleSheetsUrl(cfg.endpointUrl, cfg.secretToken, 'push');
          const pushRes = await cloudFetch(pushUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(pushPayload)
          });
          if (!pushRes.ok) throw new Error(`Google Sheets Push HTTP ${pushRes.status}`);
          const parsed = App.Security.safeJSONParse(pushRes.text);
          if (parsed && parsed.error) throw new Error(parsed.error);
        }
      }

      if (localChanged || needsRemotePush) {
        await saveToLocalDisk();
      }
      saveConfig({ lastCloudSyncAt: syncedNowISO, lastError: '' });
      if (App.Security && reason === 'manual') {
        App.Security.logAudit('CLOUD_SYNC', `Two-way synced ${mergedParcels.length} parcels (${cfg.provider})`);
      }

      isSyncingNow = false;
      if (onStatusChange) onStatusChange(localChanged);

      // If another scan happened while this sync was running, push it immediately!
      if (hasPendingLocalChanges) {
        setTimeout(() => syncWithCloud('auto_push'), 250);
      }

      return { ok: true, count: mergedParcels.length, changed: localChanged };
    } catch (err) {
      let msg = (err && err.message) || 'Cloud sync failed.';
      if (/invalid sync secret token|unauthorized/i.test(msg)) {
        msg = 'Secret Token mismatch! Enter the exact same password you wrote in Google Apps Script (var SYNC_SECRET) inside Sync Secret Token above and click Save — OR set var SYNC_SECRET = "" in Apps Script and Deploy -> Manage deployments -> New version.';
      }
      if (pushedOnEntry) hasPendingLocalChanges = true;
      saveConfig({ lastError: msg });
      isSyncingNow = false;
      if (onStatusChange) onStatusChange(false);
      return { ok: false, error: msg };
    }
  }

  /**
   * Called automatically whenever App.Storage saves any change.
   * Immediately writes to Local Disk DB and pushes to Cloud within 600ms!
   */
  function notifyLocalMutation() {
    hasPendingLocalChanges = true;
    saveToLocalDisk();
    const cfg = loadConfig();
    if (!cfg.enabled || !cfg.autoSync || !cfg.endpointUrl) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      syncWithCloud('auto_push');
    }, 600);
  }

  function startAutoSyncLoop(statusHandler) {
    onStatusChange = statusHandler;
    if (pullInterval) clearInterval(pullInterval);

    // Continuous lightweight sync every 8 seconds while app is open & visible
    pullInterval = setInterval(() => {
      const cfg = loadConfig();
      if (cfg.enabled && cfg.autoSync && cfg.endpointUrl && !document.hidden) {
        syncWithCloud('auto_poll');
      }
    }, 8000);

    // Instant sync when returning to tab, focusing app window, or coming back online
    if (!lifecycleBound) {
      lifecycleBound = true;
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
          const cfg = loadConfig();
          if (cfg.enabled && cfg.autoSync && cfg.endpointUrl) syncWithCloud('visibility');
        }
      });
      global.addEventListener('focus', () => {
        const cfg = loadConfig();
        if (cfg.enabled && cfg.autoSync && cfg.endpointUrl) syncWithCloud('focus');
      });
      global.addEventListener('online', () => {
        const cfg = loadConfig();
        if (cfg.enabled && cfg.autoSync && cfg.endpointUrl) syncWithCloud('online');
      });
    }
  }

  async function hostEraseAllData() {
    const now = Date.now();
    setWipedAt(now);
    setSettingsUpdatedAt(now);
    const cur = App.Storage.getState();
    App.Storage.applySyncedState({
      parcels: [],
      customCouriers: cur.customCouriers || [],
      deletedIds: [],
      isSampleData: false
    });
    await saveToLocalDisk();
    if (App.Security && App.Security.logAudit) {
      App.Security.logAudit('ERASE_ALL', 'Permanently erased all parcel data');
    }
    const cfg = loadConfig();
    if (cfg.enabled && cfg.endpointUrl) {
      const res = await syncWithCloud('host_wipe');
      return { ok: true, cloudSynced: Boolean(res && res.ok), cloudError: res && !res.ok ? res.error : '' };
    }
    return { ok: true, cloudSynced: false };
  }

  // -------------------------------------------------------------------------
  // Instant Direct Supabase Staff Auth Table (reed_staff — ~150ms, zero wait)
  // -------------------------------------------------------------------------
  async function fetchStaffFromSupabase() {
    try {
      const cfg = loadConfig();
      const sbKey = getSupabaseKey(cfg);
      const url = `${getSupabaseBase(cfg)}/rest/v1/reed_staff?select=*`;
      const res = await cloudFetchOnce(url, {
        method: 'GET',
        headers: supabaseHeaders(sbKey, { Accept: 'application/json' })
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const rows = App.Security.safeJSONParse(res.text);
      if (!Array.isArray(rows)) return { ok: false };
      if (rows.length > 0) {
        const mapped = rows.map((r) => ({
          id: r.id,
          name: r.name,
          phone: r.phone || '',
          role: r.role || 'scanner',
          active: r.active !== false,
          permissions: r.permissions || {},
          passSalt: r.pass_salt || '',
          passHash: r.pass_hash || '',
          updatedAt: r.updated_at || new Date().toISOString()
        }));
        global.localStorage.setItem('virsa_ops_staff_v1', JSON.stringify(mapped));
        return { ok: true, count: mapped.length };
      }
      return { ok: true, count: 0 };
    } catch (e) {
      return { ok: false, error: e && e.message };
    }
  }

  async function upsertStaffToSupabase(member) {
    if (!member || !member.id) return { ok: false };
    try {
      const cfg = loadConfig();
      const sbKey = getSupabaseKey(cfg);
      const url = `${getSupabaseBase(cfg)}/rest/v1/reed_staff?on_conflict=id`;
      const res = await cloudFetchOnce(url, {
        method: 'POST',
        headers: supabaseHeaders(sbKey, {
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal'
        }),
        body: JSON.stringify({
          id: member.id,
          name: member.name,
          phone: member.phone || '',
          role: member.role || 'scanner',
          active: member.active !== false,
          permissions: member.permissions || {},
          pass_salt: member.passSalt || '',
          pass_hash: member.passHash || '',
          updated_at: member.updatedAt || new Date().toISOString()
        })
      });
      return { ok: res.ok, error: res.ok ? '' : `HTTP ${res.status}: ${(res.text || '').slice(0, 100)}` };
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'Network error' };
    }
  }

  async function deleteStaffFromSupabase(id) {
    if (!id) return { ok: false };
    try {
      const cfg = loadConfig();
      const sbKey = getSupabaseKey(cfg);
      const url = `${getSupabaseBase(cfg)}/rest/v1/reed_staff?id=eq.${encodeURIComponent(id)}`;
      const res = await cloudFetchOnce(url, {
        method: 'DELETE',
        headers: supabaseHeaders(sbKey, { Prefer: 'return=minimal' })
      });
      return { ok: res.ok, error: res.ok ? '' : `HTTP ${res.status}: ${(res.text || '').slice(0, 100)}` };
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'Network error' };
    }
  }

  function getProviderDefaults(provider) {
    if (provider === 'google_sheets') {
      return { endpointUrl: DEFAULT_VIRSA_SHEETS_URL, secretToken: '' };
    }
    if (provider === 'supabase') {
      return { endpointUrl: DEFAULT_SUPABASE_URL, secretToken: DEFAULT_SUPABASE_KEY };
    }
    return { endpointUrl: '', secretToken: '' };
  }

  App.CloudSync = {
    loadConfig,
    saveConfig,
    getProviderDefaults,
    hasLocalDiskBackend,
    loadFromLocalDisk,
    saveToLocalDisk,
    syncWithCloud,
    hostEraseAllData,
    fetchStaffFromSupabase,
    upsertStaffToSupabase,
    deleteStaffFromSupabase,
    notifyLocalMutation,
    markSettingsChanged,
    startAutoSyncLoop,
    isSyncing: () => isSyncingNow
  };
})(window);
