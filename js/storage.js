/**
 * js/storage.js
 * LocalStorage persistence layer with clean document schema
 * structured for easy future migration to Firebase Firestore or Google Sheets.
 */
(function (global) {
  const App = (global.DispatchApp = global.DispatchApp || {});

  const STORAGE_KEY = 'virsa_ops_data_v1';
  const LEGACY_KEY = 'dispatchflow_ops_data_v1';
  const SCHEMA_VERSION = 1;

  function cleanStr(val, maxLen) {
    if (App.Security && App.Security.sanitizeText) {
      return App.Security.sanitizeText(val, maxLen);
    }
    return String(val || '').trim().slice(0, maxLen || 200);
  }

  function audit(type, detail) {
    if (App.Security && App.Security.logAudit) {
      App.Security.logAudit(type, detail);
    }
  }

  function uid() {
    return 'pcl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  function createEmptyState() {
    return {
      version: SCHEMA_VERSION,
      isSampleData: false,
      settings: {
        bilingualUr: false,
        browserNotifEnabled: false
      },
      customCouriers: [],
      deletedIds: [],
      parcels: []
    };
  }

  /**
   * Generates realistic warehouse demo data spanning 0-4 days, Day 5 (today),
   * Day 7, Day 10 (today), Day 13, Delivered, and Returned & Verified.
   */
  function buildSampleData() {
    const off = App.Aging.offsetDateISO;
    const nowISO = new Date().toISOString();
    const earlierToday = new Date(Date.now() - 1000 * 60 * 52).toISOString();
    const yesterdayISO = new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString();

    const rows = [
      {
        trackingNumber: 'KI784512369',
        orderId: 'ORD-5104',
        courier: 'Leopards',
        customerName: 'Bilal Ahmed',
        customerPhone: '0300-4451290',
        dispatchDate: off(0),
        status: 'In Transit',
        notes: 'COD Rs. 3,450'
      },
      {
        trackingNumber: 'TRX902145678',
        orderId: 'ORD-5105',
        courier: 'Trax',
        customerName: 'Ayesha Siddiqui',
        customerPhone: '0321-8892311',
        dispatchDate: off(-2),
        status: 'In Transit',
        notes: 'Lahore DHA Phase 5'
      },
      {
        trackingNumber: 'LH654321987',
        orderId: 'ORD-5092',
        courier: 'Leopards',
        customerName: 'Usman Tariq',
        customerPhone: '0333-2190445',
        dispatchDate: off(-5),
        status: 'In Transit',
        notes: 'Hitting Day 5 today — call customer'
      },
      {
        trackingNumber: '302145678912',
        orderId: 'ORD-5088',
        courier: 'Trax',
        customerName: 'Sana Fatima',
        customerPhone: '0345-7710293',
        dispatchDate: off(-5),
        status: 'In Transit',
        notes: 'Hitting Day 5 today — rider attempt pending'
      },
      {
        trackingNumber: 'IS441902387',
        orderId: 'ORD-5071',
        courier: 'Leopards',
        customerName: 'Hamza Raza',
        customerPhone: '0301-9928374',
        dispatchDate: off(-7),
        status: 'In Transit',
        notes: 'Consignee phone powered off'
      },
      {
        trackingNumber: 'TRX887612340',
        orderId: 'ORD-5064',
        courier: 'Trax',
        customerName: 'Zainab Malik',
        customerPhone: '0312-5567812',
        dispatchDate: off(-8),
        status: 'In Transit',
        notes: 'Address incomplete — follow up'
      },
      {
        trackingNumber: 'KI992341876',
        orderId: 'ORD-5039',
        courier: 'Leopards',
        customerName: 'Kamran Qureshi',
        customerPhone: '0300-7123498',
        dispatchDate: off(-10),
        status: 'In Transit',
        notes: 'Hitting Day 10 today — demand immediate return or POD'
      },
      {
        trackingNumber: '700192837465',
        orderId: 'ORD-5032',
        courier: 'Trax',
        customerName: 'Mahnoor Iqbal',
        customerPhone: '0322-6619044',
        dispatchDate: off(-12),
        status: 'In Transit',
        notes: 'Stuck at Karachi hub — escalate to Trax KAM'
      },
      {
        trackingNumber: 'LH881122334',
        orderId: 'ORD-5021',
        courier: 'Leopards',
        customerName: 'Faisal Mahmood',
        customerPhone: '0334-1182930',
        dispatchDate: off(-14),
        status: 'In Transit',
        notes: 'Critical overdue — physical return required'
      },
      {
        trackingNumber: 'TRX774455112',
        orderId: 'ORD-5080',
        courier: 'Trax',
        customerName: 'Hira Nawaz',
        customerPhone: '0306-4411229',
        dispatchDate: off(-6),
        status: 'Delivered',
        deliveredAt: yesterdayISO,
        notes: 'POD verified'
      },
      {
        trackingNumber: 'KI551029384',
        orderId: 'ORD-5048',
        courier: 'Leopards',
        customerName: 'Saad Ullah',
        customerPhone: '0315-9081726',
        dispatchDate: off(-9),
        status: 'Returned & Verified',
        returnedAt: earlierToday,
        notes: 'Refused at doorstep — box intact'
      },
      {
        trackingNumber: '302199887766',
        orderId: 'ORD-5041',
        courier: 'Trax',
        customerName: 'Nadia Parveen',
        customerPhone: '0302-3349182',
        dispatchDate: off(-11),
        status: 'Returned & Verified',
        returnedAt: earlierToday,
        notes: 'Scanned in morning return batch'
      }
    ];

    return {
      version: SCHEMA_VERSION,
      isSampleData: true,
      settings: {
        bilingualUr: false,
        browserNotifEnabled: false
      },
      customCouriers: [],
      parcels: rows.map((r, idx) => ({
        id: 'pcl_demo_' + (idx + 1),
        trackingNumber: App.Couriers.normalizeTracking(r.trackingNumber),
        orderId: r.orderId,
        courier: r.courier,
        customerName: r.customerName || '',
        customerPhone: r.customerPhone || '',
        dispatchDate: r.dispatchDate,
        status: r.status || 'In Transit',
        returnedAt: r.returnedAt || null,
        deliveredAt: r.deliveredAt || null,
        unrecordedReturn: false,
        notes: r.notes || '',
        createdAt: nowISO,
        updatedAt: nowISO
      }))
    };
  }

  let state = null;

  // Enforce warehouse rule: returns are ONLY 'Returned & Verified' if physically scanned
  // (returnScanned === true, returnReason set by scanner, or unrecordedReturn === true).
  // Any older CSV/API-imported 'Returned & Verified' records auto-heal to 'Return In Transit' (RTO).
  function enforceManualReturnRule(parcels) {
    if (!Array.isArray(parcels)) return false;
    let changed = false;
    const nowISO = new Date().toISOString();
    for (let i = 0; i < parcels.length; i++) {
      const p = parcels[i];
      if (!p) continue;
      if (p.status === 'Returned & Verified' && !p.returnScanned && !p.returnReason && !p.unrecordedReturn) {
        p.status = 'Return In Transit';
        p.returnedAt = null;
        p.updatedAt = nowISO;
        changed = true;
      }
    }
    return changed;
  }

  function load() {
    try {
      let raw = global.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        // Seamless one-time migration from legacy key if present
        raw = global.localStorage.getItem(LEGACY_KEY);
      }
      if (!raw) {
        state = createEmptyState();
        save();
        return state;
      }
      const parsed = App.Security ? App.Security.safeJSONParse(raw) : JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.parcels)) {
        state = createEmptyState();
      } else {
        state = {
          version: SCHEMA_VERSION,
          isSampleData: Boolean(parsed.isSampleData),
          settings: Object.assign({ bilingualUr: false, browserNotifEnabled: false }, parsed.settings || {}),
          customCouriers: Array.isArray(parsed.customCouriers) ? parsed.customCouriers : [],
          deletedIds: Array.isArray(parsed.deletedIds) ? parsed.deletedIds : [],
          parcels: parsed.parcels
        };
        if (enforceManualReturnRule(state.parcels)) {
          save();
        }
      }
    } catch (e) {
      console.error('Failed to read localStorage:', e);
      state = createEmptyState();
    }
    return state;
  }

  function save(skipSyncNotify) {
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.error('Failed to persist localStorage:', e);
    }
    if (!skipSyncNotify && App.CloudSync && App.CloudSync.notifyLocalMutation) {
      App.CloudSync.notifyLocalMutation();
    }
  }

  function applySyncedState(patch) {
    const s = getState();
    let healed = false;
    if (Array.isArray(patch.parcels)) {
      healed = enforceManualReturnRule(patch.parcels);
      s.parcels = patch.parcels;
    }
    if (Array.isArray(patch.customCouriers)) s.customCouriers = patch.customCouriers;
    if (Array.isArray(patch.deletedIds)) s.deletedIds = patch.deletedIds;
    if (patch.isSampleData !== undefined) s.isSampleData = Boolean(patch.isSampleData);
    save(!healed);
    return s;
  }

  function getState() {
    if (!state) load();
    return state;
  }

  function getParcels() {
    return getState().parcels;
  }

  function findByTracking(trackingRaw) {
    const norm = App.Couriers.normalizeTracking(trackingRaw);
    if (!norm) return null;
    return getParcels().find((p) => App.Couriers.normalizeTracking(p.trackingNumber) === norm) || null;
  }

  function findById(id) {
    return getParcels().find((p) => p.id === id) || null;
  }

  function addParcel(input) {
    const s = getState();
    const trackingNumber = App.Couriers.normalizeTracking(input.trackingNumber);
    if (!trackingNumber) {
      return { ok: false, error: 'Tracking number is required.' };
    }
    const existing = findByTracking(trackingNumber);
    if (existing) {
      // Load Sheet -> Processing: if parcel is Pending ('Booked / Pickup') and scanned in Dispatch mode, move it to Processing ('In Transit')
      if (existing.status === 'Booked / Pickup' && (!input.status || input.status === 'In Transit')) {
        const nowISO = new Date().toISOString();
        existing.status = 'In Transit';
        existing.dispatchDate = cleanStr(input.dispatchDate, 20) || App.Aging.getTodayISO();
        existing.dispatchedAt = nowISO;
        existing.courierStatus = 'Dispatched / Processing';
        existing.updatedAt = nowISO;
        if (input.orderId && (!existing.orderId || existing.orderId.startsWith('ORD-'))) {
          existing.orderId = cleanStr(input.orderId, 40);
        }
        if (input.customerName && !existing.customerName) existing.customerName = cleanStr(input.customerName, 80);
        if (input.customerPhone && !existing.customerPhone) existing.customerPhone = cleanStr(input.customerPhone, 30);
        if (input.itemDescription && !existing.itemDescription) existing.itemDescription = cleanStr(input.itemDescription, 240);
        save();
        audit('DISPATCH_SCAN', `Load Sheet -> Processing: ${trackingNumber} (${existing.courier})`);
        return { ok: true, promotedFromBooked: true, parcel: existing };
      }

      existing.duplicateDispatchAttempts = (existing.duplicateDispatchAttempts || 0) + 1;
      existing.lastDuplicateAttemptAt = new Date().toISOString();
      save();
      audit(
        'DUP_DISPATCH',
        `Blocked double dispatch #${existing.duplicateDispatchAttempts} for ${trackingNumber} (already logged on ${existing.dispatchDate})`
      );
      return {
        ok: false,
        duplicate: true,
        attemptCount: existing.duplicateDispatchAttempts,
        error: `DOUBLE DISPATCH BLOCKED: ${trackingNumber} was already logged on ${App.Aging.formatDisplayDate(existing.dispatchDate)} (Order ${existing.orderId || 'N/A'} • Status: ${existing.status}).`,
        existing
      };
    }

    const nowISO = new Date().toISOString();
    const detected = App.Couriers.detectCourier(trackingNumber, s.customCouriers);
    const courier = (input.courier || detected.courier || 'Leopards').trim();

    const record = {
      id: uid(),
      trackingNumber: cleanStr(trackingNumber, 40),
      orderId: cleanStr(input.orderId, 40) || ('ORD-' + trackingNumber.slice(-5)),
      courier: cleanStr(courier, 40),
      customerName: cleanStr(input.customerName, 80),
      customerPhone: cleanStr(input.customerPhone, 30),
      destinationCity: cleanStr(input.destinationCity, 60),
      address: cleanStr(input.address, 240),
      itemDescription: cleanStr(input.itemDescription || input.productDescription || '', 240),
      codAmount: Number(input.codAmount) || 0,
      courierStatus: cleanStr(input.courierStatus, 80),
      dispatchDate: cleanStr(input.dispatchDate, 20) || App.Aging.getTodayISO(),
      status: input.status || 'In Transit',
      returnedAt: input.returnedAt || null,
      deliveredAt: input.deliveredAt || null,
      unrecordedReturn: Boolean(input.unrecordedReturn),
      notes: cleanStr(input.notes, 240),
      createdAt: nowISO,
      updatedAt: nowISO
    };

    s.parcels.unshift(record);
    s.isSampleData = false;
    save();
    audit('DISPATCH', `Logged ${record.trackingNumber} (${record.courier}, ${record.status})`);
    return { ok: true, parcel: record };
  }

  function resolveSheetStatus(rowStatus, sheetMode) {
    if (sheetMode === 'load_sheet') {
      if (rowStatus === 'Delivered' || rowStatus === 'Cancelled' || rowStatus === 'Returned & Verified') return rowStatus;
      return 'Booked / Pickup';
    }
    if (sheetMode === 'receiving_sheet') {
      if (rowStatus === 'Delivered' || rowStatus === 'Cancelled' || rowStatus === 'Returned & Verified') return rowStatus;
      return 'In Transit';
    }
    return rowStatus || 'In Transit';
  }

  function bulkAddParcels(rows, options) {
    const opts = options || {};
    const sheetMode = opts.sheetMode || 'auto'; // 'auto' | 'load_sheet' | 'receiving_sheet'
    const updateExisting = Boolean(opts.updateExisting);
    const skipCancelled = Boolean(opts.skipCancelled);

    const s = getState();
    const existingMap = new Map();
    s.parcels.forEach((p) => {
      existingMap.set(App.Couriers.normalizeTracking(p.trackingNumber), p);
    });
    const seenInBatch = new Set();
    const added = [];
    const updated = [];
    const skipped = [];
    const nowISO = new Date().toISOString();

    rows.forEach((row) => {
      const trackingNumber = App.Couriers.normalizeTracking(row.trackingNumber);
      if (!trackingNumber) {
        skipped.push({ row, reason: 'Missing tracking number' });
        return;
      }
      if (seenInBatch.has(trackingNumber)) {
        skipped.push({ row, reason: 'Duplicate in sheet' });
        return;
      }
      seenInBatch.add(trackingNumber);

      const finalStatus = resolveSheetStatus(row.status, sheetMode);
      if (skipCancelled && finalStatus === 'Cancelled') {
        skipped.push({ row, reason: 'Cancelled skipped' });
        return;
      }

      const existing = existingMap.get(trackingNumber);
      if (existing) {
        if (!updateExisting) {
          skipped.push({ row, reason: 'Duplicate tracking number' });
          return;
        }
        let changed = false;
        // Never downgrade a physically scanned Returned & Verified parcel
        if (existing.status !== 'Returned & Verified' && finalStatus && existing.status !== finalStatus) {
          existing.status = finalStatus;
          if (finalStatus === 'Delivered') existing.deliveredAt = existing.deliveredAt || nowISO;
          else if (finalStatus === 'Returned & Verified') existing.returnedAt = existing.returnedAt || nowISO;
          else if (finalStatus === 'In Transit' && sheetMode === 'receiving_sheet') {
            existing.dispatchDate = row.dispatchDate || App.Aging.getTodayISO();
          }
          changed = true;
        }
        if (row.courierStatus && existing.courierStatus !== row.courierStatus) {
          existing.courierStatus = cleanStr(row.courierStatus, 80);
          changed = true;
        }
        const cod = Number(row.codAmount) || 0;
        if (cod > 0 && existing.codAmount !== cod) {
          existing.codAmount = cod;
          changed = true;
        }
        if (row.destinationCity && !existing.destinationCity) {
          existing.destinationCity = cleanStr(row.destinationCity, 60);
          changed = true;
        }
        if (row.customerName && !existing.customerName) {
          existing.customerName = cleanStr(row.customerName, 80);
          changed = true;
        }
        if (row.customerPhone && !existing.customerPhone) {
          existing.customerPhone = cleanStr(row.customerPhone, 30);
          changed = true;
        }
        if (row.address && !existing.address) {
          existing.address = cleanStr(row.address, 240);
          changed = true;
        }
        if (row.itemDescription && !existing.itemDescription) {
          existing.itemDescription = cleanStr(row.itemDescription, 240);
          changed = true;
        }
        if (row.orderId && (!existing.orderId || existing.orderId.startsWith('ORD-'))) {
          existing.orderId = cleanStr(row.orderId, 40);
          changed = true;
        }
        if (changed) {
          existing.updatedAt = nowISO;
          updated.push(existing);
        } else {
          skipped.push({ row, reason: 'Already up to date' });
        }
        return;
      }

      const detected = App.Couriers.detectCourier(trackingNumber, s.customCouriers);
      const courier = (row.courier || detected.courier || 'Leopards').trim();

      const record = {
        id: uid(),
        trackingNumber: cleanStr(trackingNumber, 40),
        orderId: cleanStr(row.orderId, 40) || ('ORD-' + trackingNumber.slice(-5)),
        courier: cleanStr(courier, 40),
        customerName: cleanStr(row.customerName, 80),
        customerPhone: cleanStr(row.customerPhone, 30),
        destinationCity: cleanStr(row.destinationCity, 60),
        address: cleanStr(row.address, 240),
        itemDescription: cleanStr(row.itemDescription || row.productDescription || '', 240),
        codAmount: Number(row.codAmount) || 0,
        courierStatus: cleanStr(row.courierStatus, 80),
        dispatchDate: cleanStr(row.dispatchDate, 20) || App.Aging.getTodayISO(),
        status: finalStatus === 'Returned & Verified' ? 'Return In Transit' : finalStatus,
        returnedAt: null,
        returnScanned: false,
        deliveredAt: finalStatus === 'Delivered' ? (row.deliveredAt || nowISO) : null,
        unrecordedReturn: Boolean(row.unrecordedReturn),
        notes: cleanStr(row.notes, 240),
        createdAt: nowISO,
        updatedAt: nowISO
      };
      existingMap.set(trackingNumber, record);
      added.push(record);
    });

    if (added.length || updated.length) {
      if (added.length) s.parcels = [...added, ...s.parcels];
      s.isSampleData = false;
      save();
      audit(
        'BULK_IMPORT',
        `Sheet (${sheetMode}): +${added.length} new, ${updated.length} updated, ${skipped.length} skipped`
      );
    }
    return { added, updated, skipped };
  }

  function updateParcelStatus(id, newStatus) {
    const p = findById(id);
    if (!p) return null;
    const prev = p.status;
    const nowISO = new Date().toISOString();
    p.status = newStatus;
    if (newStatus === 'Delivered') {
      p.deliveredAt = nowISO;
    } else if (newStatus === 'Returned & Verified') {
      p.returnedAt = p.returnedAt || nowISO;
      p.returnScanned = true;
      if (!p.returnReason) p.returnReason = 'Confirmed Return';
    } else if (newStatus === 'In Transit') {
      p.deliveredAt = null;
      p.returnedAt = null;
      p.returnScanned = false;
    }
    p.updatedAt = nowISO;
    save();
    if (prev !== newStatus) {
      audit('STATUS', `${p.trackingNumber}: ${prev} -> ${newStatus}`);
    }
    return p;
  }

  function updateParcel(id, patch) {
    const p = findById(id);
    if (!p) return null;
    Object.assign(p, patch, { updatedAt: new Date().toISOString() });
    save();
    audit('EDIT', `Edited parcel ${p.trackingNumber}`);
    return p;
  }

  function deleteParcel(id) {
    const s = getState();
    const target = findById(id);
    const before = s.parcels.length;
    s.parcels = s.parcels.filter((p) => p.id !== id);
    if (s.parcels.length !== before) {
      if (!Array.isArray(s.deletedIds)) s.deletedIds = [];
      s.deletedIds.push(id);
      if (target && target.trackingNumber) {
        s.deletedIds.push(App.Couriers.normalizeTracking(target.trackingNumber));
      }
      if (s.deletedIds.length > 400) s.deletedIds = s.deletedIds.slice(-400);
      save();
      audit('DELETE', `Deleted parcel ${target ? target.trackingNumber : id}`);
      return true;
    }
    return false;
  }

  /**
   * Processes a Dispatch Scan (Load Sheet Pending -> Processing / In Transit).
   * Outcomes:
   *  - 'valid': Pending ('Booked / Pickup') parcel moved to 'In Transit' (Processing)
   *  - 'duplicate': Parcel was already Dispatched / Delivered / Returned
   *  - 'unknown': Tracking number not found in load sheet
   */
  function processDispatchScan(trackingRaw) {
    const code = App.Couriers.normalizeTracking(trackingRaw);
    if (!code) return { outcome: 'empty', trackingNumber: '' };

    const parcel = findByTracking(code);
    if (!parcel) {
      return {
        outcome: 'unknown',
        trackingNumber: code,
        detectedCourier: App.Couriers.detectCourier(code, getState().customCouriers).courier || 'Leopards'
      };
    }

    if (parcel.status === 'Booked / Pickup') {
      const nowISO = new Date().toISOString();
      parcel.status = 'In Transit';
      parcel.dispatchDate = App.Aging.getTodayISO();
      parcel.dispatchedAt = nowISO;
      parcel.courierStatus = 'Dispatched / Processing';
      parcel.updatedAt = nowISO;
      save();
      audit('DISPATCH_SCAN', `Load Sheet -> Processing: ${code} (${parcel.courier})`);
      return { outcome: 'valid', trackingNumber: code, parcel };
    }

    parcel.duplicateDispatchAttempts = (parcel.duplicateDispatchAttempts || 0) + 1;
    parcel.lastDuplicateAttemptAt = new Date().toISOString();
    save();
    audit('DUP_DISPATCH', `Duplicate dispatch scan #${parcel.duplicateDispatchAttempts} blocked: ${code}`);
    return {
      outcome: 'duplicate',
      trackingNumber: code,
      attemptCount: parcel.duplicateDispatchAttempts,
      parcel
    };
  }

  /**
   * Processes an inward physical return barcode scan.
   * Outcomes:
   *  - 'valid': matched parcel updated to "Returned & Verified" with timestamp
   *  - 'duplicate': parcel was already scanned as Returned & Verified
   *  - 'unknown': tracking number not found in dispatch ledger
   */
  function processReturnScan(trackingRaw, returnMeta) {
    const code = App.Couriers.normalizeTracking(trackingRaw);
    if (!code) return { outcome: 'empty', trackingNumber: '' };

    const parcel = findByTracking(code);
    if (!parcel) {
      return {
        outcome: 'unknown',
        trackingNumber: code,
        detectedCourier: App.Couriers.detectCourier(code, getState().customCouriers).courier || 'Leopards'
      };
    }

    if (parcel.status === 'Returned & Verified') {
      parcel.duplicateReturnAttempts = (parcel.duplicateReturnAttempts || 0) + 1;
      parcel.lastDuplicateReturnAt = new Date().toISOString();
      save();
      audit('DUP_SCAN', `Duplicate return scan #${parcel.duplicateReturnAttempts} blocked: ${code}`);
      return {
        outcome: 'duplicate',
        trackingNumber: code,
        attemptCount: parcel.duplicateReturnAttempts,
        parcel
      };
    }

    const meta = returnMeta || {};
    const reason = cleanStr(meta.returnReason || 'Sealed / Intact Return', 100);
    const isClaimEligible = Boolean(reason && reason !== 'Sealed / Intact Return');
    const previousStatus = parcel.status;
    const previousEval = App.Aging.evaluateParcel(parcel);
    const nowISO = new Date().toISOString();
    parcel.status = 'Returned & Verified';
    parcel.returnedAt = nowISO;
    parcel.returnScanned = true;
    parcel.returnReason = reason;
    parcel.claimStatus = isClaimEligible ? (meta.claimStatus || 'Claim Pending') : 'None';
    if (meta.returnPhoto) {
      parcel.returnPhoto = String(meta.returnPhoto);
    }
    parcel.updatedAt = nowISO;
    save();
    audit('RETURN_OK', `Verified return: ${code} (${parcel.courier}) • ${reason}`);

    return {
      outcome: 'valid',
      trackingNumber: code,
      parcel,
      previousStatus,
      previousDays: previousEval.days
    };
  }

  function logUnrecordedReturn({ trackingNumber, courier, orderId, notes }) {
    const nowISO = new Date().toISOString();
    return addParcel({
      trackingNumber,
      orderId: orderId || 'UNREC-' + App.Couriers.normalizeTracking(trackingNumber).slice(-5),
      courier: courier || 'Leopards',
      dispatchDate: App.Aging.getTodayISO(),
      status: 'Returned & Verified',
      returnedAt: nowISO,
      unrecordedReturn: true,
      notes: notes || 'Logged as unrecorded physical return'
    });
  }

  function addCustomCourier(name, prefixesStr) {
    const s = getState();
    const cleanName = String(name || '').trim();
    if (!cleanName) return { ok: false, error: 'Courier name is required.' };
    const all = App.Couriers.getCouriers(s.customCouriers);
    if (all.some((c) => c.name.toLowerCase() === cleanName.toLowerCase())) {
      return { ok: false, error: `Courier "${cleanName}" already exists.` };
    }
    const prefixes = String(prefixesStr || '')
      .split(',')
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean);
    s.customCouriers.push({ name: cleanName, prefixes });
    save();
    return { ok: true };
  }

  function removeCustomCourier(name) {
    const s = getState();
    s.customCouriers = s.customCouriers.filter((c) => c.name.toLowerCase() !== String(name).toLowerCase());
    save();
  }

  function updateSettings(patch) {
    const s = getState();
    s.settings = Object.assign({}, s.settings, patch);
    save();
    return s.settings;
  }

  function exportBackupJSON() {
    const s = getState();
    audit('BACKUP', `Exported JSON backup (${s.parcels.length} parcels)`);
    return JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        app: 'VIRSA-Ops',
        version: SCHEMA_VERSION,
        customCouriers: s.customCouriers,
        settings: s.settings,
        parcels: s.parcels
      },
      null,
      2
    );
  }

  function importBackupJSON(jsonText, mode) {
    const parsed = App.Security ? App.Security.safeJSONParse(jsonText) : JSON.parse(jsonText);
    const incomingParcels = Array.isArray(parsed) ? parsed : parsed.parcels;
    if (!Array.isArray(incomingParcels)) {
      throw new Error('Invalid JSON backup: missing "parcels" array.');
    }

    // Validate & sanitize imported records
    const validStatuses = ['Booked / Pickup', 'In Transit', 'Return In Transit', 'Delivered', 'Returned & Verified', 'Cancelled'];
    const sanitized = incomingParcels
      .filter((p) => p && typeof p === 'object' && p.trackingNumber)
      .map((p) => ({
        id: cleanStr(p.id, 40) || uid(),
        trackingNumber: App.Couriers.normalizeTracking(cleanStr(p.trackingNumber, 40)),
        orderId: cleanStr(p.orderId, 40),
        courier: cleanStr(p.courier, 40) || 'Leopards',
        customerName: cleanStr(p.customerName, 80),
        customerPhone: cleanStr(p.customerPhone, 30),
        destinationCity: cleanStr(p.destinationCity, 60),
        address: cleanStr(p.address, 240),
        codAmount: Number(p.codAmount) || 0,
        courierStatus: cleanStr(p.courierStatus, 80),
        dispatchDate: cleanStr(p.dispatchDate, 20) || App.Aging.getTodayISO(),
        status: validStatuses.includes(p.status) ? p.status : 'In Transit',
        returnedAt: p.returnedAt || null,
        deliveredAt: p.deliveredAt || null,
        unrecordedReturn: Boolean(p.unrecordedReturn),
        notes: cleanStr(p.notes, 240),
        createdAt: p.createdAt || new Date().toISOString(),
        updatedAt: p.updatedAt || new Date().toISOString()
      }));

    const s = getState();
    if (mode === 'replace') {
      s.parcels = sanitized;
      if (Array.isArray(parsed.customCouriers)) {
        s.customCouriers = parsed.customCouriers;
      }
      s.isSampleData = false;
      save();
      audit('RESTORE', `Replaced database with ${sanitized.length} parcels from JSON`);
      return { addedCount: sanitized.length, skippedCount: 0, mode: 'replace' };
    }

    // Merge mode
    if (Array.isArray(parsed.customCouriers)) {
      parsed.customCouriers.forEach((c) => {
        if (c && c.name) addCustomCourier(c.name, (c.prefixes || []).join(','));
      });
    }
    const res = bulkAddParcels(sanitized);
    s.isSampleData = false;
    save();
    audit('RESTORE', `Merged ${res.added.length} parcels from JSON (${res.skipped.length} skipped)`);
    return { addedCount: res.added.length, skippedCount: res.skipped.length, mode: 'merge' };
  }

  function clearAllData() {
    const s = getState();
    const keepSettings = s.settings;
    const keepCouriers = s.customCouriers;
    state = createEmptyState();
    state.settings = keepSettings;
    state.customCouriers = keepCouriers;
    state.isSampleData = false;
    save();
    audit('CLEAR_ALL', 'Cleared all stored parcel records');
  }

  function resetToSampleData() {
    const keepSettings = getState().settings;
    state = buildSampleData();
    state.settings = keepSettings;
    save();
  }

  function dismissSampleFlag() {
    const s = getState();
    s.isSampleData = false;
    save();
  }

  /**
   * Future Cloud Sync Adapter Placeholder (Firebase Firestore / Google Sheets)
   * Implement pushParcel / pullAll using your Firestore SDK or Apps Script Web App URL.
   */
  const SyncAdapter = {
    provider: 'localStorage',
    readyForCloud: true,
    getCollectionPayload: () => ({
      collection: 'dispatches',
      documents: getParcels()
    })
  };

  function isCourierDeliveredToShipper(p) {
    if (!p || p.status !== 'Return In Transit') return false;
    const raw = `${p.courierStatus || ''} ${p.liveCheckpoint || ''}`.toLowerCase();
    return /delivered\s+to\s+shipper|returned\s+to\s+shipper|replacement\s*-\s*delivered\s+to\s+shipper/.test(raw);
  }

  function getUnconfirmedShipperReturns() {
    return getParcels().filter(isCourierDeliveredToShipper);
  }

  function confirmDeliveredToShipperReturns() {
    const targets = getUnconfirmedShipperReturns();
    if (!targets.length) return { count: 0 };
    const nowISO = new Date().toISOString();
    targets.forEach((p) => {
      p.status = 'Returned & Verified';
      p.returnedAt = nowISO;
      p.returnScanned = true;
      p.returnReason = 'Confirmed (Delivered to Shipper)';
      p.updatedAt = nowISO;
    });
    save();
    audit('CONFIRM_SHIPPER_RETURNS', `Confirmed ${targets.length} courier-delivered-to-shipper returns as Verified`);
    return { count: targets.length };
  }

  App.Storage = {
    load,
    save,
    applySyncedState,
    getState,
    getParcels,
    findByTracking,
    findById,
    addParcel,
    bulkAddParcels,
    updateParcelStatus,
    updateParcel,
    deleteParcel,
    processDispatchScan,
    processReturnScan,
    logUnrecordedReturn,
    getUnconfirmedShipperReturns,
    confirmDeliveredToShipperReturns,
    addCustomCourier,
    removeCustomCourier,
    updateSettings,
    exportBackupJSON,
    importBackupJSON,
    clearAllData,
    resetToSampleData,
    dismissSampleFlag,
    SyncAdapter
  };
})(window);
