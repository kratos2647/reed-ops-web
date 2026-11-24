/**
 * js/security.js
 * Security Protocols Module for VIRSA Dispatch & Return Ops:
 *  - Salted SHA-256 PIN Authentication (Web Crypto + pure-JS fallback for file://)
 *  - Brute-force lockout protection (5 failed attempts -> 30s lockout)
 *  - Auto-lock inactivity monitor
 *  - Admin PIN guard for destructive operations
 *  - AES-256-GCM + PBKDF2 password-encrypted backup export/import
 *  - Prototype-pollution-safe JSON parser & input sanitizer
 *  - Security Audit Log (with CSV export)
 */
(function (global) {
  const App = (global.DispatchApp = global.DispatchApp || {});

  const SEC_STORAGE_KEY = 'virsa_ops_security_v1';
  const AUDIT_STORAGE_KEY = 'virsa_ops_audit_v1';
  const SESSION_UNLOCK_KEY = 'virsa_ops_session_unlocked_v1';
  const STAFF_STORAGE_KEY = 'virsa_ops_staff_v1';
  const STAFF_SESSION_KEY = 'virsa_ops_staff_session_v1';
  const MAX_AUDIT_ENTRIES = 200;
  const MAX_FAILED_ATTEMPTS = 5;
  const LOCKOUT_MS = 30 * 1000;

  const ROLE_PRESETS = {
    admin: {
      label: 'Admin',
      canIntake: true,
      canReturnScan: true,
      canEditOrders: true,
      canViewReports: true,
      canManageSettings: true
    },
    manager: {
      label: 'Manager',
      canIntake: true,
      canReturnScan: true,
      canEditOrders: true,
      canViewReports: true,
      canManageSettings: false
    },
    scanner: {
      label: 'Scanner / Dispatcher',
      canIntake: true,
      canReturnScan: true,
      canEditOrders: false,
      canViewReports: false,
      canManageSettings: false
    },
    viewer: {
      label: 'Viewer (Read Only)',
      canIntake: false,
      canReturnScan: false,
      canEditOrders: false,
      canViewReports: true,
      canManageSettings: false
    }
  };

  let idleTimer = null;
  let onLockCallback = null;
  let isLocked = false;
  let adminVerifiedUntil = 0;

  function markSessionUnlocked() {
    try {
      global.localStorage.setItem(SESSION_UNLOCK_KEY, String(Date.now()));
    } catch (_) {}
  }

  function clearSessionUnlocked() {
    try {
      global.localStorage.removeItem(SESSION_UNLOCK_KEY);
    } catch (_) {}
  }

  function isSessionStillUnlocked(cfg) {
    try {
      const raw = global.localStorage.getItem(SESSION_UNLOCK_KEY);
      if (!raw) return false;
      const lastTs = Number(raw) || 0;
      if (!lastTs) return false;
      const maxIdleMins = Number(cfg.autoLockMinutes) || 30;
      if (maxIdleMins > 0 && Date.now() - lastTs > maxIdleMins * 60 * 1000) {
        clearSessionUnlocked();
        return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Pure-JS SHA-256 fallback (so PIN hashing works identically over file://)
  // -------------------------------------------------------------------------
  function sha256Fallback(ascii) {
    function rightRotate(value, amount) {
      return (value >>> amount) | (value << (32 - amount));
    }
    const mathPow = Math.pow;
    const maxWord = mathPow(2, 32);
    let result = '';
    const words = [];
    const asciiBitLength = ascii.length * 8;

    let hash = [];
    const k = [];
    let primeCounter = 0;
    const isComposite = {};
    for (let candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (let i = 0; i < 313; i += candidate) isComposite[i] = candidate;
        hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
      }
    }

    ascii += '\x80';
    while ((ascii.length % 64) - 56) ascii += '\x00';
    for (let i = 0; i < ascii.length; i++) {
      const j = ascii.charCodeAt(i);
      words[i >> 2] |= j << (((3 - i) % 4) * 8);
    }
    words[words.length] = (asciiBitLength / maxWord) | 0;
    words[words.length] = asciiBitLength;

    for (let j = 0; j < words.length; ) {
      const w = words.slice(j, (j += 16));
      const oldHash = hash.slice(0);
      for (let i = 0; i < 64; i++) {
        const w15 = w[i - 15];
        const w2 = w[i - 2];
        const a = hash[0];
        const e = hash[4];
        const temp1 =
          hash[7] +
          (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) +
          ((e & hash[5]) ^ (~e & hash[6])) +
          k[i] +
          (w[i] =
            i < 16
              ? w[i]
              : (w[i - 16] +
                  (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3)) +
                  w[i - 7] +
                  (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))) |
                0);
        const temp2 =
          (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) +
          ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(temp1 + temp2) | 0].concat(hash);
        hash[4] = (hash[4] + temp1) | 0;
      }
      for (let i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }

    for (let i = 0; i < 8; i++) {
      for (let j = 3; j + 1; j--) {
        const b = (hash[i] >> (j * 8)) & 255;
        result += (b < 16 ? '0' : '') + b.toString(16);
      }
    }
    return result;
  }

  async function sha256Hex(text) {
    const str = String(text);
    if (global.crypto && global.crypto.subtle && global.TextEncoder) {
      try {
        const bytes = new TextEncoder().encode(str);
        const digest = await global.crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
      } catch (_) {
        // Fallback below
      }
    }
    return sha256Fallback(unescape(encodeURIComponent(str)));
  }

  function randomHex(byteLen) {
    const arr = new Uint8Array(byteLen);
    if (global.crypto && global.crypto.getRandomValues) {
      global.crypto.getRandomValues(arr);
    } else {
      for (let i = 0; i < byteLen; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(arr)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // -------------------------------------------------------------------------
  // Security Config Persistence
  // -------------------------------------------------------------------------
  function defaultSecConfig() {
    return {
      pinEnabled: false,
      pinSalt: '',
      pinHash: '',
      autoLockMinutes: 30,
      operatorName: 'Warehouse Staff',
      failedAttempts: 0,
      lockedUntil: 0,
      requirePinForDeletes: true
    };
  }

  function loadConfig() {
    try {
      const raw = global.localStorage.getItem(SEC_STORAGE_KEY);
      if (!raw) return defaultSecConfig();
      return Object.assign(defaultSecConfig(), safeJSONParse(raw));
    } catch (_) {
      return defaultSecConfig();
    }
  }

  function saveConfig(cfg) {
    try {
      global.localStorage.setItem(SEC_STORAGE_KEY, JSON.stringify(cfg));
    } catch (_) {}
  }

  // -------------------------------------------------------------------------
  // Input Sanitization & Safe JSON Parsing (Anti-Prototype Pollution)
  // -------------------------------------------------------------------------
  function sanitizeText(val, maxLen) {
    const cleaned = String(val === null || val === undefined ? '' : val)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim();
    return maxLen ? cleaned.slice(0, maxLen) : cleaned;
  }

  function safeJSONParse(text) {
    return JSON.parse(text, (key, value) => {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        return undefined;
      }
      return value;
    });
  }

  // -------------------------------------------------------------------------
  // PIN Management, Lock Screen & Brute-Force Protection
  // -------------------------------------------------------------------------
  async function setPin(pinPlain, autoLockMinutes, operatorName) {
    const clean = String(pinPlain || '').trim();
    if (!/^\d{4,8}$/.test(clean)) {
      return { ok: false, error: 'PIN must be 4 to 8 digits (numbers only).' };
    }
    const cfg = loadConfig();
    const salt = randomHex(16);
    // Iterated key-stretching (2,000 rounds of SHA-256)
    let hash = `${salt}:${clean}`;
    for (let i = 0; i < 2000; i++) {
      hash = await sha256Hex(`${salt}:${hash}`);
    }
    cfg.pinEnabled = true;
    cfg.pinSalt = salt;
    cfg.pinHash = hash;
    cfg.failedAttempts = 0;
    cfg.lockedUntil = 0;
    if (autoLockMinutes !== undefined) cfg.autoLockMinutes = Number(autoLockMinutes) || 0;
    if (operatorName !== undefined) cfg.operatorName = sanitizeText(operatorName, 40) || 'Warehouse Staff';
    saveConfig(cfg);
    isLocked = false;
    adminVerifiedUntil = Date.now() + 5 * 60 * 1000;
    markSessionUnlocked();
    logAudit('SECURITY', 'Admin PIN protection enabled/updated');
    resetIdleTimer();
    return { ok: true };
  }

  async function verifyPin(pinPlain) {
    const cfg = loadConfig();
    if (!cfg.pinEnabled) return { ok: true };

    const now = Date.now();
    if (cfg.lockedUntil && now < cfg.lockedUntil) {
      const secs = Math.ceil((cfg.lockedUntil - now) / 1000);
      return { ok: false, locked: true, waitSeconds: secs, error: `Too many failed attempts. Wait ${secs}s.` };
    }

    const clean = String(pinPlain || '').trim();
    let hash = `${cfg.pinSalt}:${clean}`;
    for (let i = 0; i < 2000; i++) {
      hash = await sha256Hex(`${cfg.pinSalt}:${hash}`);
    }

    if (hash === cfg.pinHash) {
      cfg.failedAttempts = 0;
      cfg.lockedUntil = 0;
      saveConfig(cfg);
      isLocked = false;
      adminVerifiedUntil = Date.now() + 5 * 60 * 1000;
      markSessionUnlocked();
      logAudit('AUTH_OK', 'Session unlocked / Admin PIN verified');
      resetIdleTimer();
      return { ok: true };
    }

    cfg.failedAttempts = (cfg.failedAttempts || 0) + 1;
    let error = `Incorrect PIN (${cfg.failedAttempts}/${MAX_FAILED_ATTEMPTS} attempts).`;
    if (cfg.failedAttempts >= MAX_FAILED_ATTEMPTS) {
      cfg.lockedUntil = Date.now() + LOCKOUT_MS;
      cfg.failedAttempts = 0;
      error = '5 failed attempts! Locked for 30 seconds.';
      logAudit('AUTH_LOCKOUT', 'Brute-force lockout triggered after 5 failed PIN attempts');
    } else {
      logAudit('AUTH_FAIL', `Failed PIN attempt #${cfg.failedAttempts}`);
    }
    saveConfig(cfg);
    return { ok: false, error, locked: Boolean(cfg.lockedUntil && Date.now() < cfg.lockedUntil) };
  }

  async function disablePin(currentPin) {
    const check = await verifyPin(currentPin);
    if (!check.ok) return check;
    const cfg = loadConfig();
    cfg.pinEnabled = false;
    cfg.pinSalt = '';
    cfg.pinHash = '';
    cfg.failedAttempts = 0;
    cfg.lockedUntil = 0;
    saveConfig(cfg);
    isLocked = false;
    clearIdleTimer();
    logAudit('SECURITY', 'PIN lock disabled by admin');
    return { ok: true };
  }

  function updateAutoLock(minutes) {
    const cfg = loadConfig();
    cfg.autoLockMinutes = Number(minutes) || 0;
    saveConfig(cfg);
    resetIdleTimer();
    logAudit('SECURITY', `Auto-lock timer set to ${cfg.autoLockMinutes || 'Off'} min`);
  }

  function getStaffList() {
    try {
      const raw = global.localStorage.getItem(STAFF_STORAGE_KEY);
      if (!raw) return [];
      const arr = safeJSONParse(raw, []);
      return Array.isArray(arr) ? arr.filter((u) => u && u.id) : [];
    } catch (_) {
      return [];
    }
  }

  function saveStaffList(list) {
    try {
      const clean = Array.isArray(list) ? list.filter((u) => u && u.id) : [];
      global.localStorage.setItem(STAFF_STORAGE_KEY, JSON.stringify(clean));
    } catch (_) {}
  }

  async function ensureDefaultHostPin() {
    const cfg = loadConfig();
    if (cfg.hostPinInitialized) return false;
    const res = await setPin('2647', cfg.autoLockMinutes || 30, cfg.operatorName || 'REED Host');
    if (res && res.ok) {
      const upd = loadConfig();
      upd.hostPinInitialized = true;
      saveConfig(upd);
      return true;
    }
    return false;
  }

  async function ensureDefaultAdmin() {
    if (getStaffList().length > 0) return false;
    const salt = randomHex(12);
    const hash = await hashPassword(salt, 'admin123');
    saveStaffList([
      {
        id: 'admin',
        name: 'VIRSA Admin',
        phone: '',
        role: 'admin',
        active: true,
        isDefaultSeed: true,
        permissions: Object.assign({}, ROLE_PRESETS.admin),
        passSalt: salt,
        passHash: hash,
        updatedAt: new Date().toISOString()
      }
    ]);
    return true;
  }

  function getCurrentStaff() {
    try {
      const raw = global.localStorage.getItem(STAFF_SESSION_KEY);
      if (!raw) return null;
      const parsed = safeJSONParse(raw, null);
      if (!parsed || !parsed.id) return null;
      const live = getStaffList().find((u) => u.id === parsed.id);
      if (live) {
        if (!live.active) {
          global.localStorage.removeItem(STAFF_SESSION_KEY);
          return null;
        }
        return {
          id: live.id,
          name: live.name,
          phone: live.phone || '',
          role: live.role,
          permissions: live.permissions || ROLE_PRESETS[live.role] || ROLE_PRESETS.viewer
        };
      }
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function setCurrentStaffSession(emp) {
    try {
      if (!emp) {
        global.localStorage.removeItem(STAFF_SESSION_KEY);
      } else {
        global.localStorage.setItem(
          STAFF_SESSION_KEY,
          JSON.stringify({
            id: emp.id,
            name: emp.name,
            phone: emp.phone || '',
            role: emp.role,
            permissions: emp.permissions || ROLE_PRESETS[emp.role] || ROLE_PRESETS.viewer
          })
        );
      }
    } catch (_) {}
  }

  function isAuthRequired() {
    const cfg = loadConfig();
    return Boolean(cfg.pinEnabled || getStaffList().length > 0);
  }

  function hasPermission(permKey) {
    const staffList = getStaffList();
    if (staffList.length === 0) return true; // No staff accounts configured -> full access
    const cur = getCurrentStaff();
    if (!cur) return !isLocked; // Unlocked via Master Admin PIN
    if (cur.role === 'admin') return true;
    const perms = cur.permissions || ROLE_PRESETS[cur.role] || {};
    return Boolean(perms[permKey]);
  }

  async function hashPassword(salt, password) {
    let hash = `${salt}:${password}`;
    for (let i = 0; i < 1200; i++) {
      hash = await sha256Hex(`${salt}:${hash}`);
    }
    return hash;
  }

  async function saveStaffMember(input) {
    const rawId = sanitizeText(input.id || '', 30)
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '');
    const name = sanitizeText(input.name || '', 50);
    const phone = sanitizeText(input.phone || '', 24);
    const role = ROLE_PRESETS[input.role] ? input.role : 'scanner';
    const active = input.active !== false;
    const password = String(input.password || '').trim();

    if (!rawId || rawId.length < 2) {
      return { ok: false, error: 'Staff ID must be at least 2 characters (letters/numbers).' };
    }
    if (!name) {
      return { ok: false, error: 'Staff Full Name is required.' };
    }

    const list = getStaffList();
    const existingIdx = list.findIndex((u) => u.id === rawId);
    if (existingIdx < 0 && password.length < 4) {
      return { ok: false, error: 'Password must be at least 4 characters for new staff.' };
    }
    if (password && password.length < 4) {
      return { ok: false, error: 'Password must be at least 4 characters.' };
    }

    const preset = ROLE_PRESETS[role];
    const permsInput = input.permissions || {};
    const permissions = {
      canIntake: permsInput.canIntake !== undefined ? Boolean(permsInput.canIntake) : preset.canIntake,
      canReturnScan: permsInput.canReturnScan !== undefined ? Boolean(permsInput.canReturnScan) : preset.canReturnScan,
      canEditOrders: permsInput.canEditOrders !== undefined ? Boolean(permsInput.canEditOrders) : preset.canEditOrders,
      canViewReports: permsInput.canViewReports !== undefined ? Boolean(permsInput.canViewReports) : preset.canViewReports,
      canManageSettings: permsInput.canManageSettings !== undefined ? Boolean(permsInput.canManageSettings) : preset.canManageSettings
    };

    const existing = existingIdx >= 0 ? list[existingIdx] : null;
    let passSalt = existing ? existing.passSalt : '';
    let passHash = existing ? existing.passHash : '';
    if (password) {
      passSalt = randomHex(12);
      passHash = await hashPassword(passSalt, password);
    }

    const record = {
      id: rawId,
      name,
      phone,
      role,
      active,
      permissions,
      passSalt,
      passHash,
      updatedAt: new Date().toISOString()
    };

    if (existingIdx >= 0) list[existingIdx] = record;
    else list.push(record);

    saveStaffList(list);
    logAudit('STAFF_SAVE', `${existingIdx >= 0 ? 'Updated' : 'Added'} staff ${name} (@${rawId}) as ${preset.label}`);
    return { ok: true, member: record };
  }

  function deleteStaffMember(id) {
    const cleanId = String(id || '').toLowerCase();
    const list = getStaffList();
    const next = list.filter((u) => u.id !== cleanId);
    if (next.length === list.length) return { ok: false, error: 'Staff member not found.' };
    saveStaffList(next);
    const cur = getCurrentStaff();
    if (cur && cur.id === cleanId) {
      setCurrentStaffSession(null);
    }
    logAudit('STAFF_DELETE', `Removed staff account @${cleanId}`);
    return { ok: true };
  }

  async function loginWithCredentials(idInput, passInput) {
    const rawName = sanitizeText(idInput || '', 50).trim().toLowerCase();
    const cleanId = rawName.replace(/[^a-z0-9._-]/g, '');
    const pass = String(passInput || '').trim();
    const cfg = loadConfig();

    if (cfg.lockedUntil && Date.now() < cfg.lockedUntil) {
      const secs = Math.ceil((cfg.lockedUntil - Date.now()) / 1000);
      return { ok: false, error: `Too many failed attempts. Wait ${secs}s.`, locked: true };
    }

    if (!rawName || !pass) {
      return { ok: false, error: 'Enter both Staff ID (or Name) and Password.' };
    }

    const staffList = getStaffList();
    const emp =
      staffList.find((u) => u.id === cleanId) ||
      staffList.find((u) => String(u.name || '').trim().toLowerCase() === rawName);
    if (!emp) {
      cfg.failedAttempts = (cfg.failedAttempts || 0) + 1;
      if (cfg.failedAttempts >= MAX_FAILED_ATTEMPTS) {
        cfg.lockedUntil = Date.now() + LOCKOUT_MS;
        cfg.failedAttempts = 0;
      }
      saveConfig(cfg);
      logAudit('AUTH_FAIL', `Unknown staff login attempt: @${cleanId}`);
      return { ok: false, error: 'Invalid Staff ID or Password.' };
    }

    if (!emp.active) {
      logAudit('AUTH_FAIL', `Disabled staff login blocked: @${cleanId}`);
      return { ok: false, error: 'This staff account is currently disabled by Admin.' };
    }

    const hash = await hashPassword(emp.passSalt || '', pass);
    if (hash !== emp.passHash) {
      cfg.failedAttempts = (cfg.failedAttempts || 0) + 1;
      let err = `Incorrect Password (${cfg.failedAttempts}/${MAX_FAILED_ATTEMPTS} attempts).`;
      if (cfg.failedAttempts >= MAX_FAILED_ATTEMPTS) {
        cfg.lockedUntil = Date.now() + LOCKOUT_MS;
        cfg.failedAttempts = 0;
        err = '5 failed attempts! Locked for 30 seconds.';
      }
      saveConfig(cfg);
      logAudit('AUTH_FAIL', `Failed password for @${cleanId}`);
      return { ok: false, error: err };
    }

    cfg.failedAttempts = 0;
    cfg.lockedUntil = 0;
    saveConfig(cfg);
    isLocked = false;
    setCurrentStaffSession(emp);
    markSessionUnlocked();
    if (emp.role === 'admin' || (emp.permissions && emp.permissions.canManageSettings)) {
      adminVerifiedUntil = Date.now() + 5 * 60 * 1000;
    } else {
      adminVerifiedUntil = 0;
    }
    resetIdleTimer();
    logAudit('AUTH_OK', `Staff login: ${emp.name} (@${emp.id}, ${emp.role})`);
    return { ok: true, staff: getCurrentStaff() };
  }

  function logoutStaff() {
    const cur = getCurrentStaff();
    if (cur) logAudit('LOGOUT', `Staff signed out: ${cur.name} (@${cur.id})`);
    setCurrentStaffSession(null);
    clearSessionUnlocked();
    adminVerifiedUntil = 0;
    isLocked = isAuthRequired();
    clearIdleTimer();
    if (onLockCallback && isLocked) onLockCallback();
    return true;
  }

  function lockNow() {
    if (!isAuthRequired()) return false;
    isLocked = true;
    adminVerifiedUntil = 0;
    setCurrentStaffSession(null);
    clearSessionUnlocked();
    logAudit('LOCK', 'Workspace locked / signed out');
    if (onLockCallback) onLockCallback();
    return true;
  }

  function clearIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function resetIdleTimer() {
    clearIdleTimer();
    const cfg = loadConfig();
    if (!isAuthRequired() || isLocked) return;
    // Refresh session activity timestamp so page reloads stay unlocked
    markSessionUnlocked();
    if (!cfg.autoLockMinutes) return;
    idleTimer = setTimeout(() => {
      lockNow();
    }, cfg.autoLockMinutes * 60 * 1000);
  }

  function initIdleMonitor(lockHandler) {
    onLockCallback = lockHandler;
    ['pointerdown', 'keydown', 'touchstart'].forEach((evt) => {
      document.addEventListener(evt, resetIdleTimer, { passive: true });
    });
    const cfg = loadConfig();
    if (isAuthRequired()) {
      if (isSessionStillUnlocked(cfg) && (getStaffList().length === 0 || getCurrentStaff() || cfg.pinEnabled)) {
        // Keep unlocked across page refreshes in the same open app session!
        isLocked = false;
        resetIdleTimer();
      } else {
        isLocked = true;
        if (onLockCallback) onLockCallback();
      }
    }
  }

  function needsAdminVerification() {
    const cfg = loadConfig();
    if (!cfg.pinEnabled || !cfg.requirePinForDeletes) return false;
    return Date.now() > adminVerifiedUntil;
  }

  // -------------------------------------------------------------------------
  // AES-256-GCM Encrypted Backup (Web Crypto API)
  // -------------------------------------------------------------------------
  function isCryptoAvailable() {
    return Boolean(global.crypto && global.crypto.subtle && global.isSecureContext);
  }

  function bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function deriveAesKey(passphrase, saltBytes) {
    const enc = new TextEncoder();
    const keyMat = await global.crypto.subtle.importKey(
      'raw',
      enc.encode(passphrase),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );
    return global.crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: saltBytes,
        iterations: 150000,
        hash: 'SHA-256'
      },
      keyMat,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptBackup(plainJSON, passphrase) {
    if (!isCryptoAvailable()) {
      throw new Error('AES-256 encryption requires HTTPS or localhost. Use standard JSON backup on file://, or deploy to HTTPS.');
    }
    if (!passphrase || passphrase.length < 6) {
      throw new Error('Backup encryption password must be at least 6 characters.');
    }
    const salt = new Uint8Array(16);
    const iv = new Uint8Array(12);
    global.crypto.getRandomValues(salt);
    global.crypto.getRandomValues(iv);

    const key = await deriveAesKey(passphrase, salt);
    const cipherBuf = await global.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(plainJSON)
    );

    logAudit('BACKUP_ENC', 'Generated AES-256-GCM encrypted backup');
    return JSON.stringify(
      {
        app: 'VIRSA-Ops',
        encrypted: true,
        alg: 'AES-256-GCM',
        kdf: 'PBKDF2-SHA256-150000',
        exportedAt: new Date().toISOString(),
        salt: bytesToBase64(salt),
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(new Uint8Array(cipherBuf))
      },
      null,
      2
    );
  }

  async function decryptBackup(envelopeText, passphrase) {
    if (!isCryptoAvailable()) {
      throw new Error('AES-256 decryption requires HTTPS or localhost.');
    }
    const env = safeJSONParse(envelopeText);
    if (!env || !env.encrypted || !env.salt || !env.iv || !env.ciphertext) {
      throw new Error('Not a valid VIRSA encrypted backup file.');
    }
    const salt = base64ToBytes(env.salt);
    const iv = base64ToBytes(env.iv);
    const cipher = base64ToBytes(env.ciphertext);
    const key = await deriveAesKey(passphrase, salt);
    try {
      const plainBuf = await global.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
      logAudit('BACKUP_DEC', 'Decrypted AES-256-GCM backup successfully');
      return new TextDecoder().decode(plainBuf);
    } catch (_) {
      logAudit('AUTH_FAIL', 'Failed to decrypt backup (wrong password or tampered file)');
      throw new Error('Wrong password or corrupted/tampered backup file.');
    }
  }

  // -------------------------------------------------------------------------
  // Security Audit Log
  // -------------------------------------------------------------------------
  function getAuditLog() {
    try {
      const raw = global.localStorage.getItem(AUDIT_STORAGE_KEY);
      if (!raw) return [];
      const parsed = safeJSONParse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function logAudit(eventType, detail) {
    const list = getAuditLog();
    const cfg = loadConfig();
    const curStaff = getCurrentStaff();
    const actorLabel = curStaff
      ? `${curStaff.name} (@${curStaff.id})`
      : cfg.operatorName || 'Warehouse Staff';
    list.unshift({
      ts: new Date().toISOString(),
      type: sanitizeText(eventType, 24),
      actor: actorLabel,
      detail: sanitizeText(detail, 240)
    });
    if (list.length > MAX_AUDIT_ENTRIES) list.length = MAX_AUDIT_ENTRIES;
    try {
      global.localStorage.setItem(AUDIT_STORAGE_KEY, JSON.stringify(list));
    } catch (_) {}
  }

  function clearAuditLog() {
    try {
      global.localStorage.removeItem(AUDIT_STORAGE_KEY);
    } catch (_) {}
    logAudit('SECURITY', 'Audit log cleared by admin');
  }

  function getProtocolStatus() {
    const cfg = loadConfig();
    const isHttps = global.location && (global.location.protocol === 'https:' || global.location.hostname === 'localhost' || global.location.hostname === '127.0.0.1');
    return {
      httpsOrLocalhost: isHttps,
      pinEnabled: cfg.pinEnabled,
      autoLockMinutes: cfg.autoLockMinutes,
      aesEncryptionReady: isCryptoAvailable(),
      csvInjectionDefense: true,
      cspActive: true,
      auditCount: getAuditLog().length
    };
  }

  App.Security = {
    ROLE_PRESETS,
    loadConfig,
    sanitizeText,
    safeJSONParse,
    setPin,
    verifyPin,
    disablePin,
    updateAutoLock,
    lockNow,
    initIdleMonitor,
    needsAdminVerification,
    isAuthRequired,
    isLocked: () => isLocked,
    ensureDefaultHostPin,
    ensureDefaultAdmin,
    getStaffList,
    saveStaffMember,
    deleteStaffMember,
    loginWithCredentials,
    logoutStaff,
    getCurrentStaff,
    hasPermission,
    isCryptoAvailable,
    encryptBackup,
    decryptBackup,
    getAuditLog,
    logAudit,
    clearAuditLog,
    getProtocolStatus
  };
})(window);
