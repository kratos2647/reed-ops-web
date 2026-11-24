/**
 * js/csv.js
 * Complete Offline CSV + Excel (.xlsx / .xls) Importer & Exporter
 * Tailored for exact Trax Sonic & Leopards Courier sheets (Load Sheet, Receiving Sheet & Order Details).
 */
(function (global) {
  const App = (global.DispatchApp = global.DispatchApp || {});

  // =========================================================================
  // 1. Delimited Text Parser (RFC-4180 CSV & TSV)
  // =========================================================================
  function parseDelimitedText(text, forcedDelim) {
    const clean = String(text || '').replace(/^\uFEFF/, '');
    const firstLines = clean.split(/\r?\n/).slice(0, 5).join('\n');
    const delim = forcedDelim || ((firstLines.match(/\t/g) || []).length > (firstLines.match(/,/g) || []).length ? '\t' : ',');

    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < clean.length; i++) {
      const ch = clean[i];
      const next = clean[i + 1];

      if (inQuotes) {
        if (ch === '"' && next === '"') {
          field += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          field += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === delim) {
          row.push(field.trim());
          field = '';
        } else if (ch === '\r' && next === '\n') {
          row.push(field.trim());
          if (row.some((cell) => cell !== '')) rows.push(row);
          row = [];
          field = '';
          i++;
        } else if (ch === '\n' || ch === '\r') {
          row.push(field.trim());
          if (row.some((cell) => cell !== '')) rows.push(row);
          row = [];
          field = '';
        } else {
          field += ch;
        }
      }
    }
    row.push(field.trim());
    if (row.some((cell) => cell !== '')) rows.push(row);
    return rows;
  }

  // =========================================================================
  // 2. HTML-Table .xls Parser (Common in Pakistani Courier Portals)
  // =========================================================================
  function parseHTMLTable(htmlText) {
    const doc = new DOMParser().parseFromString(htmlText, 'text/html');
    const trs = doc.querySelectorAll('tr');
    const matrix = [];
    trs.forEach((tr) => {
      const cells = [...tr.querySelectorAll('th, td')].map((td) => String(td.textContent || '').replace(/\s+/g, ' ').trim());
      if (cells.some((c) => c !== '')) matrix.push(cells);
    });
    return matrix;
  }

  // =========================================================================
  // 3. Pure-JS Offline Excel (.xlsx OOXML ZIP) Reader
  // =========================================================================
  async function inflateRawBytes(u8) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser does not support built-in .xlsx unzipping. Save the Excel file as CSV and upload.');
    }
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(u8);
    writer.close();
    const out = await new Response(ds.readable).arrayBuffer();
    return new Uint8Array(out);
  }

  function colLettersToIndex(letters) {
    let idx = 0;
    const s = String(letters || '').toUpperCase();
    for (let i = 0; i < s.length; i++) {
      idx = idx * 26 + (s.charCodeAt(i) - 64);
    }
    return Math.max(0, idx - 1);
  }

  async function extractZipEntries(arrayBuffer) {
    const u8 = new Uint8Array(arrayBuffer);
    const dv = new DataView(arrayBuffer);
    // Find End of Central Directory (0x06054b50) scanning backwards
    let eocdOffset = -1;
    const minStart = Math.max(0, u8.length - 65557);
    for (let i = u8.length - 22; i >= minStart; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset === -1) throw new Error('Invalid .xlsx file (ZIP directory not found).');

    const totalEntries = dv.getUint16(eocdOffset + 10, true);
    let offset = dv.getUint32(eocdOffset + 16, true);
    const decoder = new TextDecoder('utf-8');
    const entries = {};

    for (let n = 0; n < totalEntries; n++) {
      if (offset + 46 > u8.length || dv.getUint32(offset, true) !== 0x02014b50) break;
      const compression = dv.getUint16(offset + 10, true);
      const compSize = dv.getUint32(offset + 20, true);
      const nameLen = dv.getUint16(offset + 28, true);
      const extraLen = dv.getUint16(offset + 30, true);
      const commentLen = dv.getUint16(offset + 32, true);
      const localHeaderOffset = dv.getUint32(offset + 42, true);
      const name = decoder.decode(u8.subarray(offset + 46, offset + 46 + nameLen));
      offset += 46 + nameLen + extraLen + commentLen;

      entries[name] = { compression, compSize, localHeaderOffset };
    }

    async function readTextEntry(entryName) {
      const info = entries[entryName];
      if (!info) return null;
      const lh = info.localHeaderOffset;
      const lNameLen = dv.getUint16(lh + 26, true);
      const lExtraLen = dv.getUint16(lh + 28, true);
      const dataStart = lh + 30 + lNameLen + lExtraLen;
      const slice = u8.subarray(dataStart, dataStart + info.compSize);
      if (info.compression === 0) return decoder.decode(slice);
      if (info.compression === 8) {
        const inflated = await inflateRawBytes(slice);
        return decoder.decode(inflated);
      }
      throw new Error('Unsupported .xlsx compression method.');
    }

    return { entries, readTextEntry };
  }

  async function parseXLSXArrayBuffer(arrayBuffer) {
    const zip = await extractZipEntries(arrayBuffer);
    const sharedStrings = [];

    const ssXml = await zip.readTextEntry('xl/sharedStrings.xml');
    if (ssXml) {
      const ssDoc = new DOMParser().parseFromString(ssXml, 'application/xml');
      const sis = ssDoc.getElementsByTagName('si');
      for (let i = 0; i < sis.length; i++) {
        const ts = sis[i].getElementsByTagName('t');
        let txt = '';
        for (let j = 0; j < ts.length; j++) txt += ts[j].textContent || '';
        sharedStrings.push(txt);
      }
    }

    // Pick sheet1.xml or the first worksheet found
    let sheetName = 'xl/worksheets/sheet1.xml';
    if (!zip.entries[sheetName]) {
      sheetName = Object.keys(zip.entries).find((k) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k));
    }
    if (!sheetName) throw new Error('No worksheet found inside .xlsx file.');

    const sheetXml = await zip.readTextEntry(sheetName);
    const sheetDoc = new DOMParser().parseFromString(sheetXml, 'application/xml');
    const rowNodes = sheetDoc.getElementsByTagName('row');
    const matrix = [];

    for (let r = 0; r < rowNodes.length; r++) {
      const cNodes = rowNodes[r].getElementsByTagName('c');
      const rowArr = [];
      for (let c = 0; c < cNodes.length; c++) {
        const cell = cNodes[c];
        const ref = cell.getAttribute('r') || '';
        const colMatch = ref.match(/^([A-Z]+)/i);
        const colIdx = colMatch ? colLettersToIndex(colMatch[1]) : c;
        const type = cell.getAttribute('t') || '';
        let val = '';

        if (type === 'inlineStr') {
          const ts = cell.getElementsByTagName('t');
          for (let j = 0; j < ts.length; j++) val += ts[j].textContent || '';
        } else {
          const vNode = cell.getElementsByTagName('v')[0];
          const rawV = vNode ? vNode.textContent || '' : '';
          if (type === 's') {
            val = sharedStrings[parseInt(rawV, 10)] || '';
          } else {
            val = rawV;
          }
        }
        rowArr[colIdx] = String(val || '').trim();
      }
      for (let k = 0; k < rowArr.length; k++) {
        if (rowArr[k] === undefined) rowArr[k] = '';
      }
      if (rowArr.some((x) => x !== '')) matrix.push(rowArr);
    }

    return matrix;
  }

  // =========================================================================
  // 4. Smart Trax Sonic & Leopards Sheet Column + Status Mapper
  // =========================================================================
  function findHeaderIndex(headers, patterns) {
    const lower = headers.map((h) => String(h || '').toLowerCase().replace(/\s+/g, ' ').trim());
    for (const pat of patterns) {
      const idx = lower.findIndex((h) => pat.test(h));
      if (idx !== -1) return idx;
    }
    return -1;
  }

  function excelSerialToISO(num) {
    // Excel epoch (Dec 30, 1899)
    const utcMs = Math.round((num - 25569) * 86400 * 1000);
    const d = new Date(utcMs);
    if (isNaN(d.getTime())) return App.Aging.getTodayISO();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function normalizeDateCell(raw) {
    const val = String(raw || '').trim();
    if (!val) return App.Aging.getTodayISO();
    // Excel serial date (e.g. 46347 or 46347.7713)
    if (/^\d{5}(\.\d+)?$/.test(val)) {
      const num = parseFloat(val);
      if (num > 30000 && num < 70000) return excelSerialToISO(num);
    }
    const isoMatch = val.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (isoMatch) {
      return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(2, '0')}`;
    }
    const dmy = val.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (dmy) {
      const a = Number(dmy[1]);
      const b = Number(dmy[2]);
      const y = dmy[3];
      const day = b > 12 ? b : a;
      const month = b > 12 ? a : b;
      return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    const parsed = new Date(val);
    if (!isNaN(parsed.getTime())) {
      const y = parsed.getFullYear();
      const m = String(parsed.getMonth() + 1).padStart(2, '0');
      const d = String(parsed.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    return App.Aging.getTodayISO();
  }

  function cleanAmount(raw) {
    const num = parseFloat(String(raw || '').replace(/[^\d.]/g, ''));
    return isNaN(num) ? 0 : Math.round(num);
  }

  function decodeHtmlEntities(str) {
    return String(str || '')
      .replace(/&#039;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }

  /**
   * Maps exact Trax Sonic & Leopards status strings into MM VIRSA statuses.
   */
  function mapCourierStatus(rawStatus) {
    const s = String(rawStatus || '').trim();
    const low = s.toLowerCase();
    if (!low) return 'In Transit';

    if (/cancel/.test(low)) return 'Cancelled';

    // Courier-reported return statuses ALWAYS stay 'Return In Transit' (RTO)
    // until physically scanned & verified by staff in Return Scanner!
    if (/delivered\s+to\s+shipper|returned\s+to\s+shipper|replacement\s*-\s*delivered\s+to\s+shipper/.test(low)) {
      return 'Return In Transit';
    }

    // Delivered to customer
    if (/^delivered$|shipment\s*-\s*delivered/.test(low)) {
      return 'Delivered';
    }

    // Return in progress / waiting to arrive back at warehouse
    if (/return|being\s+return|ready\s+for\s+return|rto/.test(low)) {
      return 'Return In Transit';
    }

    // Load Sheet / Booked / Pickup Pending (Not handed over / picked up yet)
    if (/booked|pickup\s*request/.test(low)) {
      return 'Booked / Pickup';
    }

    // Active transit (Dispatched, In Transit, Out for Delivery, Arrived, Misrouted, On Hold, Pending, Assign to Courier, Shipper Advise, Re-Attempt)
    return 'In Transit';
  }

  function parseMatrixToParcels(matrix, customCouriers) {
    if (!Array.isArray(matrix) || matrix.length < 2) {
      return { rows: [], format: 'Unknown', error: 'File must contain a header row and at least one parcel row.' };
    }

    // Scan first 10 rows to find the real header row (automatically skips Trax "Order Details" banner row!)
    const trackingPatterns = [/^tracking\s*no\.?$/, /tracking/, /^cn$/, /\bcn\b/, /consignment/, /awb/, /barcode/, /waybill/];
    let headerRowIdx = -1;
    let trackingIdx = -1;

    const maxScan = Math.min(10, matrix.length);
    for (let r = 0; r < maxScan; r++) {
      const idx = findHeaderIndex(matrix[r], trackingPatterns);
      if (idx !== -1) {
        headerRowIdx = r;
        trackingIdx = idx;
        break;
      }
    }

    if (headerRowIdx === -1 || trackingIdx === -1) {
      return {
        rows: [],
        format: 'Unknown',
        error: 'Could not find a Tracking No. / CN column. Upload a Trax, Leopards, or Shopify CSV/Excel sheet.'
      };
    }

    const headers = matrix[headerRowIdx];
    const headerJoined = headers.join('|').toLowerCase();

    // Detect exact courier format from column signature
    let detectedFormat = 'Standard Sheet';
    let sheetCourierHint = '';
    if (headerJoined.includes('tracking no.') || headerJoined.includes('collection amount') || headerJoined.includes('booking channel')) {
      detectedFormat = 'Trax Sonic Sheet';
      sheetCourierHint = 'Trax';
    } else if (/\bcn\b/.test(headerJoined) && (headerJoined.includes('shipment type') || headerJoined.includes('cod amount') || headerJoined.includes('destination city'))) {
      detectedFormat = 'Leopards Sheet';
      sheetCourierHint = 'Leopards';
    }

    const orderIdx = findHeaderIndex(headers, [/^order\s*id$/, /order\s*(id|no|num|#)/, /^name$/, /reference/, /\border\b/, /ref\s*#/]);
    const courierIdx = findHeaderIndex(headers, [/^courier$/, /carrier/, /tracking\s*company/, /fulfillment\s*service/, /shipping\s*company/]);
    const customerIdx = findHeaderIndex(headers, [/^consignee\s*name$/, /^consignee$/, /customer\s*name/, /shipping\s*name/, /recipient/, /buyer/, /customer/]);
    const phoneIdx = findHeaderIndex(headers, [/^consignee\s*contact$/, /^consignee\s*phone$/, /phone/, /mobile/, /contact/, /cell/, /whatsapp/]);
    const cityIdx = findHeaderIndex(headers, [/^destination\s*city$/, /^destination$/, /city/]);
    const addressIdx = findHeaderIndex(headers, [/consignee\s*address/, /address/]);
    const codIdx = findHeaderIndex(headers, [/collection\s*amount/, /cod\s*amount/, /\bcod\b/, /^amount$/]);
    const dateIdx = findHeaderIndex(headers, [/^booking\s*date$/, /dispatch\s*date/, /booking\s*date/, /fulfilled\s*at/, /ship\s*date/, /created\s*at/, /\bdate\b/]);
    const statusIdx = findHeaderIndex(headers, [/^status$/, /parcel\s*status/, /shipment\s*status/]);
    const reasonIdx = findHeaderIndex(headers, [/^reason$/, /cancellation\s*remarks/]);
    const productIdx = findHeaderIndex(headers, [
      /item\s*description/,
      /product\s*description/,
      /order\s*description/,
      /product\s*name/,
      /lineitem\s*name/,
      /packet\s*detail/,
      /parcel\s*detail/,
      /^product(s)?$/,
      /^item(s)?$/,
      /^description$/,
      /goods/,
      /contents?/,
      /^sku$/
    ]);
    const remarksIdx = findHeaderIndex(headers, [/^remarks?$/, /^notes?$/, /instructions/]);

    const rows = [];
    for (let i = headerRowIdx + 1; i < matrix.length; i++) {
      const cells = matrix[i];
      if (!cells || cells.length === 0) continue;
      let rawTracking = String(cells[trackingIdx] || '').trim();
      // Handle Excel scientific notation if a 14-digit CN got stored as float
      if (/^\d+(\.\d+)?e\+\d+$/i.test(rawTracking)) {
        rawTracking = Number(rawTracking).toFixed(0);
      }
      const trackingNumber = App.Couriers.normalizeTracking(rawTracking);
      if (!trackingNumber || trackingNumber.length < 5) continue;

      let courier = courierIdx !== -1 ? String(cells[courierIdx] || '').trim() : '';
      if (/leopard|lcs/i.test(courier)) courier = 'Leopards';
      else if (/trax|sonic/i.test(courier)) courier = 'Trax';
      else if (!courier || /^manual$/i.test(courier)) {
        const det = App.Couriers.detectCourier(trackingNumber, customCouriers);
        courier = (det.confidence === 'auto' && det.courier) ? det.courier : (sheetCourierHint || det.courier || 'Leopards');
      }

      const rawStatus = statusIdx !== -1 ? decodeHtmlEntities(cells[statusIdx] || '').trim() : '';
      const status = mapCourierStatus(rawStatus);

      const reason = reasonIdx !== -1 ? decodeHtmlEntities(cells[reasonIdx] || '').trim() : '';
      const remark = remarksIdx !== -1 ? decodeHtmlEntities(cells[remarksIdx] || '').trim() : '';
      const cleanRemark = /^(-|null|0)$/i.test(remark) ? '' : remark;
      const cleanReason = /^(-|null|0)$/i.test(reason) ? '' : reason;
      const notes = [cleanReason, cleanRemark].filter(Boolean).join(' • ').slice(0, 220);

      const rawProduct = productIdx !== -1 ? decodeHtmlEntities(cells[productIdx] || '').trim() : '';
      const cleanProduct = /^(-|null|0)$/i.test(rawProduct) ? '' : rawProduct;
      // Leopards sheets often put "0" in Product Description and the real product text in Remarks
      const itemDescription = (cleanProduct || cleanRemark).slice(0, 240);

      rows.push({
        trackingNumber,
        orderId: orderIdx !== -1 ? decodeHtmlEntities(cells[orderIdx] || '').trim() : '',
        courier,
        customerName: customerIdx !== -1 ? decodeHtmlEntities(cells[customerIdx] || '').trim() : '',
        customerPhone: phoneIdx !== -1 ? String(cells[phoneIdx] || '').trim() : '',
        destinationCity: cityIdx !== -1 ? decodeHtmlEntities(cells[cityIdx] || '').trim() : '',
        address: addressIdx !== -1 ? decodeHtmlEntities(cells[addressIdx] || '').trim() : '',
        itemDescription,
        codAmount: codIdx !== -1 ? cleanAmount(cells[codIdx]) : 0,
        courierStatus: rawStatus,
        dispatchDate: dateIdx !== -1 ? normalizeDateCell(cells[dateIdx]) : App.Aging.getTodayISO(),
        status,
        notes
      });
    }

    if (rows.length === 0) {
      return { rows: [], format: detectedFormat, error: 'No valid tracking numbers found in this sheet.' };
    }

    return { rows, format: detectedFormat, error: null };
  }

  function parseDispatchCSV(csvText, customCouriers) {
    const trimmed = String(csvText || '').trim();
    const matrix = /<table[\s>]|<tr[\s>]/i.test(trimmed.slice(0, 1500))
      ? parseHTMLTable(trimmed)
      : parseDelimitedText(trimmed);
    return parseMatrixToParcels(matrix, customCouriers);
  }

  /**
   * Async universal importer supporting .csv, .tsv, .xls (HTML/CSV), and .xlsx (Excel OOXML).
   */
  async function parseSpreadsheetFile(file, customCouriers) {
    if (!file) return { rows: [], format: 'Unknown', error: 'No file selected.' };
    const name = String(file.name || '').toLowerCase();

    try {
      const buf = await file.arrayBuffer();
      const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
      const isZip = head.length >= 2 && head[0] === 0x50 && head[1] === 0x4b; // 'PK' (.xlsx)
      const isOle2 = head.length >= 4 && head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0;

      if (isZip || name.endsWith('.xlsx')) {
        if (!isZip) {
          // Sometimes portals name a CSV or HTML table as .xlsx
          const txt = new TextDecoder('utf-8').decode(buf);
          return parseDispatchCSV(txt, customCouriers);
        }
        const matrix = await parseXLSXArrayBuffer(buf);
        return parseMatrixToParcels(matrix, customCouriers);
      }

      if (isOle2) {
        return {
          rows: [],
          format: 'Legacy XLS',
          error: 'Old binary Excel 97-2003 (.xls) detected. In Excel, click Save As → CSV or Excel Workbook (.xlsx) and upload.'
        };
      }

      const txt = new TextDecoder('utf-8').decode(buf);
      return parseDispatchCSV(txt, customCouriers);
    } catch (err) {
      return {
        rows: [],
        format: 'Error',
        error: err && err.message ? err.message : 'Could not read this file. Try saving as .xlsx or .csv.'
      };
    }
  }

  // =========================================================================
  // 5. UTF-8 BOM Excel-Friendly CSV Exporter & Exact Courier Templates
  // =========================================================================
  function escapeCSVCell(val) {
    let str = val === null || val === undefined ? '' : String(val);
    if (/^[=+\-@\t\r]/.test(str)) {
      str = "'" + str;
    }
    if (/[",\n\r]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  function toCSVString(headers, rowArrays) {
    const lines = [headers.map(escapeCSVCell).join(',')];
    rowArrays.forEach((r) => {
      lines.push(r.map(escapeCSVCell).join(','));
    });
    return '\uFEFF' + lines.join('\r\n');
  }

  function triggerDownload(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType || 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 150);
  }

  function exportReportCSV(parcels, options) {
    const opts = options || {};
    const courierFilter = opts.courier || 'All';
    const reportType = opts.reportType || 'all';
    const today = App.Aging.getTodayISO();

    const filtered = parcels.filter((p) => {
      if (courierFilter !== 'All' && p.courier.toLowerCase() !== courierFilter.toLowerCase()) {
        return false;
      }
      const ev = App.Aging.evaluateParcel(p);
      if (reportType === 'returns_today') {
        return p.status === 'Returned & Verified' && App.Aging.isSameLocalDay(p.returnedAt, today);
      }
      if (reportType === 'claims') {
        return p.status === 'Returned & Verified' && p.claimStatus && p.claimStatus !== 'None';
      }
      if (reportType === 'cod_recon') {
        return p.status === 'Delivered' || p.status === 'In Transit' || p.status === 'Returned & Verified';
      }
      if (reportType === 'returns_all') return p.status === 'Returned & Verified';
      if (reportType === 'overdue_10') return ev.tier === 'critical10';
      if (reportType === 'followup_5') return ev.tier === 'warning5';
      if (reportType === 'complaint_all') return ev.tier === 'critical10' || ev.tier === 'warning5';
      if (reportType === 'booked') return ev.tier === 'booked';
      return true;
    });

    if (filtered.length === 0) return { ok: false, count: 0 };

    const headers = [
      'Tracking Number',
      'Order ID',
      'Courier',
      'Dispatch Date',
      'Days Elapsed',
      'Status',
      'Courier Status',
      'Destination City',
      'Product / Description',
      'COD Amount',
      'Customer Name',
      'Customer Phone',
      'Return Verified At',
      'Return Condition',
      'Claim Status',
      'Notes'
    ];

    const rows = filtered.map((p) => {
      const ev = App.Aging.evaluateParcel(p);
      return [
        p.trackingNumber,
        p.orderId,
        p.courier,
        p.dispatchDate,
        ev.days,
        p.status,
        p.courierStatus || '',
        p.destinationCity || '',
        p.itemDescription || '',
        p.codAmount || 0,
        p.customerName || '',
        p.customerPhone || '',
        p.returnedAt ? App.Aging.formatDateTime(p.returnedAt) : '',
        p.returnReason || '',
        p.claimStatus || 'None',
        p.notes || ''
      ];
    });

    const slugCourier = courierFilter.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const filename = `virsa_${slugCourier}_${reportType}_${today}.csv`;
    triggerDownload(filename, toCSVString(headers, rows), 'text/csv;charset=utf-8;');
    if (App.Security) App.Security.logAudit('EXPORT', `Exported ${filtered.length} rows (${filename})`);
    return { ok: true, count: filtered.length, filename };
  }

  function exportAuditLogCSV(auditRows) {
    if (!Array.isArray(auditRows) || auditRows.length === 0) return { ok: false, count: 0 };
    const today = App.Aging.getTodayISO();
    const headers = ['Timestamp', 'Event Type', 'Operator', 'Details'];
    const rows = auditRows.map((a) => [
      App.Aging.formatDateTime(a.ts),
      a.type || '',
      a.actor || '',
      a.detail || ''
    ]);
    const filename = `virsa_security_audit_log_${today}.csv`;
    triggerDownload(filename, toCSVString(headers, rows), 'text/csv;charset=utf-8;');
    return { ok: true, count: auditRows.length, filename };
  }

  function downloadTraxSampleCSV() {
    const today = App.Aging.getTodayISO();
    const headers = [
      'S.No', 'Tracking No.', 'Business Category', 'Order ID', 'Shipper', 'Booked By',
      'Service Type', 'Booking Channel', 'Status', 'Reason', 'Payment Status', 'Origin',
      'Destination', 'Consignee Name', 'Consignee Contact', 'Consignee Address',
      'Collection Amount', 'Booking Date', 'Instructions', 'Cancellation Remarks', 'Payment Mode'
    ];
    const sampleRows = [
      ['1', '14418870840451', 'Domestic', '#13981', 'MM VIRSA', '-', 'Regular', 'Shopify', 'Shipment - In Transit', '', '', 'Faisalabad', 'Jhang', 'Mian Muhammad Arshad', '0332-2686666', 'Shorkot District Jhang', '3500', `${today} 18:30:41`, 'NULL', '-', 'COD'],
      ['2', '14431170832893', 'Domestic', 'whatsapp', 'MM VIRSA', 'Main User', 'Regular', 'Sonic', 'Shipment - Booked', '', '', 'Faisalabad', 'Sheikhupura', 'Shafy Mustafa', '0321-8359545', 'Ghang Road Sheikhupura', '3799', `${today} 16:45:29`, '', '-', 'COD'],
      ['3', '14425170749525', 'Domestic', '#14446', 'MM VIRSA', '-', 'Regular', 'Shopify', 'Shipment - Delivered', '', 'Payment - Paid', 'Faisalabad', 'Multan', 'Irfan Rajput', '0333-1617306', 'Al Jalan Town Multan', '6998', `${today} 14:11:01`, 'NULL', '-', 'COD']
    ];
    const content = '\uFEFF' + 'Order Details,,,,,,,,,,,,,,,,,,,,\r\n' +
      [headers.map(escapeCSVCell).join(','), ...sampleRows.map((r) => r.map(escapeCSVCell).join(','))].join('\r\n');
    triggerDownload(`mm_virsa_trax_sample_${today}.csv`, content, 'text/csv;charset=utf-8;');
  }

  function downloadLeopardsSampleCSV() {
    const today = App.Aging.getTodayISO();
    const headers = [
      'Status', 'Order Id', 'Shipment Type', 'CN', 'Origin City', 'Destination City',
      'Shipper Name', 'Consignee', 'Consignee Phone', 'Booking Date', 'COD Amount',
      'Product Description', 'Remarks'
    ];
    const sampleRows = [
      ['Dispatched', '#14461', 'OVERNIGHT', 'FS7549623285', 'Faisalabad', 'Hyderabad', 'MM VIRSA', 'MUKHTIAR HUSSAIN', '03332524349', today, '3499.00', '0', 'Lawrencepur Coconut Wool'],
      ['Pickup Request not Send', '#14480', 'OVERNIGHT', 'FS7549623359', 'Faisalabad', 'Dera Ghazi Khan', 'MM VIRSA', 'MUHAMMAD RIAZ', '03166732247', today, '3980.00', '0', 'Gul Ahmed Cotton Qty=2'],
      ['Delivered', '#13626', 'OVERNIGHT', 'FS7547931274', 'Faisalabad', 'Karachi', 'MM VIRSA', 'ASIF KHAN', '923423023681', today, '1990.00', '0', 'Gul Ahmed Cotton Pure White']
    ];
    triggerDownload(`mm_virsa_leopards_sample_${today}.csv`, toCSVString(headers, sampleRows), 'text/csv;charset=utf-8;');
  }

  App.CSV = {
    parseCSVText: parseDelimitedText,
    parseDispatchCSV,
    parseSpreadsheetFile,
    exportReportCSV,
    exportAuditLogCSV,
    downloadSampleTemplateCSV: downloadTraxSampleCSV,
    downloadTraxSampleCSV,
    downloadLeopardsSampleCSV,
    triggerDownload
  };
})(window);
