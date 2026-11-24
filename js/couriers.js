/**
 * js/couriers.js
 * Courier registry (Leopards, Trax, + custom couriers) and
 * automatic tracking-number pattern detection with manual override.
 */
(function (global) {
  const App = (global.DispatchApp = global.DispatchApp || {});

  const DEFAULT_COURIERS = [
    {
      name: 'Leopards',
      builtIn: true,
      prefixes: ['KI', 'LH', 'IS', 'RW', 'FS', 'ML', 'PE', 'QT', 'HY', 'GU', 'SK', 'BH', 'MR', 'AB', 'SW', 'LCS', 'LE', 'LP'],
      patternHint: 'City prefix + 7–11 digits (e.g. KI784512369, LH1234567890) or 10-digit CN'
    },
    {
      name: 'Trax',
      builtIn: true,
      prefixes: ['TRX', 'TR', 'TX'],
      patternHint: 'TRX/TR prefix (e.g. TRX987654321) or 11–13 digit numeric tracking'
    }
  ];

  // Leopards commonly uses 2-letter Pakistani city hub codes + 7-11 digits (e.g., KI784512369, LH90123456)
  // or 9-10 digit numeric CNs starting with 7/8/9.
  const LEOPARDS_PREFIX_REGEX = /^(KI|LH|IS|RW|FS|ML|PE|QT|HY|GU|SK|BH|MR|AB|SW|MY|DG|SI|OK|SA|NW|LCS|LE|LP)[A-Z0-9-]*\d{6,12}$/i;
  const LEOPARDS_NUMERIC_REGEX = /^[789]\d{8,9}$/;

  // Trax commonly uses TRX/TR prefix or 11-16 digit numeric tracking numbers (e.g., 14418870840451, 144680570829522)
  const TRAX_PREFIX_REGEX = /^(TRX|TR|TX)[A-Z0-9-]*\d{5,14}$/i;
  const TRAX_NUMERIC_REGEX = /^\d{11,16}$/;

  function normalizeTracking(raw) {
    return String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  }

  function getCouriers(customCouriers) {
    const customs = Array.isArray(customCouriers) ? customCouriers : [];
    const seen = new Set(DEFAULT_COURIERS.map((c) => c.name.toLowerCase()));
    const merged = [...DEFAULT_COURIERS];
    customs.forEach((c) => {
      if (c && c.name && !seen.has(c.name.toLowerCase())) {
        seen.add(c.name.toLowerCase());
        merged.push({
          name: c.name.trim(),
          builtIn: false,
          prefixes: Array.isArray(c.prefixes) ? c.prefixes : [],
          patternHint: c.prefixes && c.prefixes.length ? `Prefix: ${c.prefixes.join(', ')}` : 'Manual selection'
        });
      }
    });
    return merged;
  }

  /**
   * Auto-detect courier from a tracking number.
   * Returns { courier: string, confidence: 'auto' | 'fallback', reason: string }
   */
  function detectCourier(trackingRaw, customCouriers) {
    const code = normalizeTracking(trackingRaw);
    if (!code || code.length < 4) {
      return { courier: '', confidence: 'none', reason: '' };
    }

    // 1. Check custom couriers with explicit prefixes first
    const customs = Array.isArray(customCouriers) ? customCouriers : [];
    for (const c of customs) {
      if (!c || !Array.isArray(c.prefixes)) continue;
      for (const p of c.prefixes) {
        const cleanP = String(p || '').trim().toUpperCase();
        if (cleanP && code.startsWith(cleanP) && code.length > cleanP.length + 2) {
          return {
            courier: c.name,
            confidence: 'auto',
            reason: `Matched custom prefix "${cleanP}"`
          };
        }
      }
    }

    // 2. Trax explicit prefix
    if (TRAX_PREFIX_REGEX.test(code)) {
      return {
        courier: 'Trax',
        confidence: 'auto',
        reason: 'Matched Trax prefix (TRX/TR/TX)'
      };
    }

    // 3. Leopards city/hub prefix
    if (LEOPARDS_PREFIX_REGEX.test(code)) {
      return {
        courier: 'Leopards',
        confidence: 'auto',
        reason: 'Matched Leopards city/CN prefix'
      };
    }

    // 4. Trax 11-14 digit numeric tracking number
    if (TRAX_NUMERIC_REGEX.test(code)) {
      return {
        courier: 'Trax',
        confidence: 'auto',
        reason: `Matched Trax ${code.length}-digit numeric pattern`
      };
    }

    // 5. Leopards 9-10 digit numeric CN
    if (LEOPARDS_NUMERIC_REGEX.test(code)) {
      return {
        courier: 'Leopards',
        confidence: 'auto',
        reason: `Matched Leopards ${code.length}-digit CN pattern`
      };
    }

    // 6. Generic 8-10 digit numeric fallback -> Trax if starts with 1-6, Leopards otherwise
    if (/^\d{8,10}$/.test(code)) {
      const first = code[0];
      if (first >= '1' && first <= '6') {
        return {
          courier: 'Trax',
          confidence: 'auto',
          reason: 'Matched Trax numeric range'
        };
      }
      return {
        courier: 'Leopards',
        confidence: 'auto',
        reason: 'Matched Leopards numeric range'
      };
    }

    // 7. Generic 2-letter + digits -> likely Leopards hub code
    if (/^[A-Z]{2}\d{6,}$/.test(code)) {
      return {
        courier: 'Leopards',
        confidence: 'auto',
        reason: 'Matched 2-letter hub + digits pattern'
      };
    }

    return {
      courier: 'Leopards',
      confidence: 'fallback',
      reason: 'Defaulted to Leopards (select manually if needed)'
    };
  }

  function courierBadgeClass(courierName) {
    const key = String(courierName || '').trim().toLowerCase();
    if (key.includes('leopard')) return 'badge-courier leopards';
    if (key.includes('trax')) return 'badge-courier trax';
    return 'badge-courier';
  }

  App.Couriers = {
    DEFAULT_COURIERS,
    normalizeTracking,
    getCouriers,
    detectCourier,
    courierBadgeClass
  };
})(window);
