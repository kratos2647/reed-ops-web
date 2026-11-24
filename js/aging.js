/**
 * js/aging.js
 * Smart Aging, Status Classification & Dashboard Analytics Engine.
 * Supports:
 *  - Booked / Pickup (Load Sheet / Pickup Request Sent / Not Sent)
 *  - In Transit (0-4d Normal, 5-9d Warning, 10+d Critical Overdue)
 *  - Return In Transit (RTO / Being Return / Ready for Return)
 *  - Delivered
 *  - Returned & Verified
 *  - Cancelled
 */
(function (global) {
  const App = (global.DispatchApp = global.DispatchApp || {});

  function getTodayISO() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function offsetDateISO(daysDelta) {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() + daysDelta);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function parseLocalDate(isoStr) {
    if (!isoStr) return null;
    const match = String(isoStr).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (match) {
      return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    }
    const parsed = new Date(isoStr);
    if (isNaN(parsed.getTime())) return null;
    return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  }

  function daysElapsedSince(dispatchDateISO) {
    const start = parseLocalDate(dispatchDateISO);
    if (!start) return 0;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diffMs = today.getTime() - start.getTime();
    return Math.max(0, Math.floor(diffMs / 86400000));
  }

  function formatDisplayDate(isoStr) {
    const d = parseLocalDate(isoStr);
    if (!d) return isoStr || '—';
    return d.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
  }

  function formatShortDay(isoStr) {
    const d = parseLocalDate(isoStr);
    if (!d) return String(isoStr || '').slice(5);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  }

  function formatDateTime(isoTs) {
    if (!isoTs) return '—';
    const d = new Date(isoTs);
    if (isNaN(d.getTime())) return String(isoTs);
    return d.toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  }

  function isSameLocalDay(isoTs, targetISODate) {
    if (!isoTs) return false;
    const d = new Date(isoTs);
    if (isNaN(d.getTime())) return false;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}` === (targetISODate || getTodayISO());
  }

  function evaluateParcel(parcel) {
    const days = daysElapsedSince(parcel.dispatchDate);
    const st = String(parcel.status || 'In Transit');

    if (st === 'Delivered') {
      return {
        days,
        tier: 'delivered',
        badgeClass: 'badge-blue',
        badgeText: 'Delivered',
        shortLabel: 'Delivered',
        rowClass: '',
        hitsDay5Today: false,
        hitsDay10Today: false
      };
    }

    if (st === 'Returned & Verified') {
      return {
        days,
        tier: 'returned',
        badgeClass: 'badge-purple',
        badgeText: 'Returned & Verified',
        shortLabel: 'Returned',
        rowClass: '',
        hitsDay5Today: false,
        hitsDay10Today: false
      };
    }

    if (st === 'Cancelled') {
      return {
        days,
        tier: 'cancelled',
        badgeClass: 'badge-neutral',
        badgeText: 'Cancelled',
        shortLabel: 'Cancelled',
        rowClass: '',
        hitsDay5Today: false,
        hitsDay10Today: false
      };
    }

    if (st === 'Booked / Pickup') {
      return {
        days,
        tier: 'booked',
        badgeClass: 'badge-amber',
        badgeText: 'Booked / Pickup Pending',
        shortLabel: 'Booked',
        rowClass: '',
        hitsDay5Today: false,
        hitsDay10Today: false
      };
    }

    if (st === 'Return In Transit') {
      return {
        days,
        tier: 'rto',
        badgeClass: 'badge-purple',
        badgeText: 'Return In Transit',
        shortLabel: 'RTO',
        rowClass: '',
        hitsDay5Today: false,
        hitsDay10Today: false
      };
    }

    // Active In Transit aging rules
    if (days >= 10) {
      return {
        days,
        tier: 'critical10',
        badgeClass: 'badge-red-flashing',
        badgeText: `10+ Days Overdue - Must Return (Day ${days})`,
        shortLabel: `Day ${days} Critical`,
        rowClass: 'row-critical',
        hitsDay5Today: false,
        hitsDay10Today: days === 10
      };
    }

    if (days >= 5) {
      return {
        days,
        tier: 'warning5',
        badgeClass: 'badge-orange',
        badgeText: `5+ Days Pending - Follow Up (Day ${days})`,
        shortLabel: `Day ${days} Pending`,
        rowClass: 'row-warning',
        hitsDay5Today: days === 5,
        hitsDay10Today: false
      };
    }

    return {
      days,
      tier: 'normal',
      badgeClass: 'badge-green',
      badgeText: `In Transit (Day ${days})`,
      shortLabel: `Day ${days} Normal`,
      rowClass: '',
      hitsDay5Today: false,
      hitsDay10Today: false
    };
  }

  function summarize(parcels) {
    const today = getTodayISO();
    const summary = {
      totalDispatched: parcels.length,
      booked: 0,
      rto: 0,
      cancelled: 0,
      delivered: 0,
      inTransitNormal: 0,
      warning5: 0,
      critical10: 0,
      returnedVerified: 0,
      returnedToday: 0,
      leopardsCount: 0,
      traxCount: 0,
      otherCount: 0,
      totalCodAmount: 0,
      deliveredCodAmount: 0,
      hittingDay5Today: [],
      hittingDay10Today: [],
      allWarning5: [],
      allCritical10: [],
      dailySeries: []
    };

    const byDate = {};

    parcels.forEach((p) => {
      const ev = evaluateParcel(p);
      const cod = Number(p.codAmount) || 0;
      const cLow = String(p.courier || '').toLowerCase();
      if (cLow.includes('leopard')) summary.leopardsCount += 1;
      else if (cLow.includes('trax')) summary.traxCount += 1;
      else summary.otherCount += 1;

      if (ev.tier !== 'cancelled') {
        summary.totalCodAmount += cod;
        const dKey = String(p.dispatchDate || today).slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(dKey)) {
          byDate[dKey] = (byDate[dKey] || 0) + 1;
        }
      }

      if (ev.tier === 'delivered') {
        summary.delivered += 1;
        summary.deliveredCodAmount += cod;
      } else if (ev.tier === 'returned') {
        summary.returnedVerified += 1;
        if (isSameLocalDay(p.returnedAt, today)) {
          summary.returnedToday += 1;
        }
      } else if (ev.tier === 'booked') {
        summary.booked += 1;
      } else if (ev.tier === 'rto') {
        summary.rto += 1;
      } else if (ev.tier === 'cancelled') {
        summary.cancelled += 1;
      } else if (ev.tier === 'normal') {
        summary.inTransitNormal += 1;
      } else if (ev.tier === 'warning5') {
        summary.warning5 += 1;
        summary.allWarning5.push({ parcel: p, eval: ev });
        if (ev.hitsDay5Today) summary.hittingDay5Today.push({ parcel: p, eval: ev });
      } else if (ev.tier === 'critical10') {
        summary.critical10 += 1;
        summary.allCritical10.push({ parcel: p, eval: ev });
        if (ev.hitsDay10Today) summary.hittingDay10Today.push({ parcel: p, eval: ev });
      }
    });

    // Build last 7 active booking dates for the Dashboard bar chart
    const sortedDates = Object.keys(byDate).sort().slice(-7);
    summary.dailySeries = sortedDates.map((date) => ({
      date,
      label: formatShortDay(date),
      count: byDate[date]
    }));

    summary.allCritical10.sort((a, b) => b.eval.days - a.eval.days);
    summary.allWarning5.sort((a, b) => b.eval.days - a.eval.days);

    summary.todayAlertsCount = summary.hittingDay5Today.length + summary.hittingDay10Today.length;
    summary.totalActionNeeded = summary.warning5 + summary.critical10;

    return summary;
  }

  App.Aging = {
    getTodayISO,
    offsetDateISO,
    parseLocalDate,
    daysElapsedSince,
    formatDisplayDate,
    formatShortDay,
    formatDateTime,
    isSameLocalDay,
    evaluateParcel,
    summarize
  };
})(window);
