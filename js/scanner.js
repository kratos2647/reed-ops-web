/**
 * js/scanner.js
 * Ultra-Fast 360° Full-Frame Warehouse Barcode & QR Scanner Engine:
 *  - Direct Native Hardware BarcodeDetector on <video> (ML Kit / OS GPU accelerated):
 *      * 100% Full-Frame (NO restrictive qrbox area — scans anywhere in view!)
 *      * 360° Any-Angle (horizontal, vertical, diagonal, upside-down)
 *      * Zero canvas copy overhead (~20-50ms instant detection)
 *      * Tap-to-focus + Continuous Autofocus + Auto-Exposure + 1080p Full HD
 *  - Automatic Full-Frame html5-qrcode fallback on browsers without BarcodeDetector
 *  - Explicit Back/Front camera selection + Flash (Torch) + Digital Zoom
 *  - Global USB Handheld Scanner Wedge listener
 */
(function (global) {
  const App = (global.DispatchApp = global.DispatchApp || {});

  // Native engine state
  let nativeStream = null;
  let nativeTrack = null;
  let nativeVideoEl = null;
  let nativeLoopTimer = null;
  let nativeRunning = false;
  let nativeDetecting = false;

  // Fallback html5-qrcode state
  let activeScanner = null;

  let activeElementId = null;
  let lastCameraCode = '';
  let lastCameraTime = 0;
  let torchOn = false;
  let currentZoom = 1;
  let zoomRange = null;
  let torchSupported = false;
  let currentScanMode = 'auto'; // 'auto' (QR + 1D) | 'barcode' | 'qr'
  let currentFacing = 'environment'; // 'environment' (back) | 'user' (front)

  const MIN_BARCODE_LEN = 6;

  function getScanMode() {
    return currentScanMode;
  }

  function setScanMode(mode) {
    currentScanMode = mode === 'qr' || mode === 'barcode' ? mode : 'auto';
    return currentScanMode;
  }

  function getCameraFacing() {
    return currentFacing;
  }

  function setCameraFacing(facing) {
    currentFacing = facing === 'user' ? 'user' : 'environment';
    return currentFacing;
  }

  function isLibraryLoaded() {
    return hasNativeBarcodeDetector() || typeof global.Html5Qrcode !== 'undefined';
  }

  function hasNativeBarcodeDetector() {
    return typeof global.BarcodeDetector !== 'undefined';
  }

  function getCapabilities() {
    return {
      torchSupported,
      torchOn,
      zoomSupported: Boolean(zoomRange && zoomRange.max > 1),
      currentZoom,
      nativeAccelerated: hasNativeBarcodeDetector()
    };
  }

  async function applyTrackEnhancements(track, applyFn) {
    torchSupported = false;
    torchOn = false;
    zoomRange = null;
    currentZoom = 1;
    try {
      const caps = track && track.getCapabilities ? track.getCapabilities() : null;
      if (!caps) return getCapabilities();
      if (caps.torch) torchSupported = true;
      if (caps.zoom && caps.zoom.max > 1) {
        zoomRange = {
          min: caps.zoom.min || 1,
          max: Math.min(caps.zoom.max, 3.0)
        };
      }
      const trackConstraints = {};
      if (caps.width && caps.width.max) {
        trackConstraints.width = { ideal: Math.min(caps.width.max, 1920) };
      }
      if (caps.height && caps.height.max) {
        trackConstraints.height = { ideal: Math.min(caps.height.max, 1080) };
      }
      if (caps.frameRate && caps.frameRate.max) {
        trackConstraints.frameRate = { ideal: Math.min(caps.frameRate.max, 30) };
      }
      const adv = {};
      if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
        adv.focusMode = 'continuous';
      }
      if (Array.isArray(caps.exposureMode) && caps.exposureMode.includes('continuous')) {
        adv.exposureMode = 'continuous';
      }
      if (Array.isArray(caps.whiteBalanceMode) && caps.whiteBalanceMode.includes('continuous')) {
        adv.whiteBalanceMode = 'continuous';
      }
      if (Object.keys(adv).length > 0) {
        trackConstraints.advanced = [adv];
      }
      if (Object.keys(trackConstraints).length > 0 && applyFn) {
        await applyFn(trackConstraints);
      }
    } catch (_) {}
    return getCapabilities();
  }

  async function triggerTapFocus() {
    if (!nativeTrack || !nativeTrack.getCapabilities || !nativeTrack.applyConstraints) return;
    try {
      const caps = nativeTrack.getCapabilities();
      if (caps && Array.isArray(caps.focusMode)) {
        if (caps.focusMode.includes('single-shot')) {
          await nativeTrack.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] });
          setTimeout(() => {
            if (nativeTrack && caps.focusMode.includes('continuous')) {
              nativeTrack.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
            }
          }, 450);
        } else if (caps.focusMode.includes('continuous')) {
          await nativeTrack.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
        }
      }
    } catch (_) {}
  }

  async function applyActiveConstraints(constraints) {
    if (nativeTrack && nativeTrack.applyConstraints) {
      await nativeTrack.applyConstraints(constraints);
      return true;
    }
    if (activeScanner && activeScanner.applyVideoConstraints) {
      await activeScanner.applyVideoConstraints(constraints);
      return true;
    }
    return false;
  }

  async function toggleTorch() {
    if (!torchSupported) return { ok: false, torchOn: false };
    try {
      const next = !torchOn;
      await applyActiveConstraints({ advanced: [{ torch: next }] });
      torchOn = next;
      return { ok: true, torchOn };
    } catch (_) {
      return { ok: false, torchOn };
    }
  }

  async function cycleZoom() {
    if (!zoomRange) return { ok: false, currentZoom: 1 };
    const steps = [1, 1.5, 2.0, 2.5].filter((z) => z <= zoomRange.max + 0.05);
    if (steps.length < 2) steps.push(Number(zoomRange.max.toFixed(1)));
    const idx = steps.findIndex((z) => Math.abs(z - currentZoom) < 0.15);
    const nextZoom = steps[(idx + 1) % steps.length];
    try {
      await applyActiveConstraints({ advanced: [{ zoom: nextZoom }] });
      currentZoom = nextZoom;
      return { ok: true, currentZoom };
    } catch (_) {
      return { ok: false, currentZoom };
    }
  }

  async function stop() {
    torchOn = false;
    torchSupported = false;
    zoomRange = null;
    currentZoom = 1;

    // Stop Native BarcodeDetector engine
    nativeRunning = false;
    nativeDetecting = false;
    if (nativeLoopTimer) {
      clearTimeout(nativeLoopTimer);
      nativeLoopTimer = null;
    }
    if (nativeStream) {
      try {
        nativeStream.getTracks().forEach((t) => t.stop());
      } catch (_) {}
      nativeStream = null;
      nativeTrack = null;
    }
    if (nativeVideoEl) {
      try {
        nativeVideoEl.srcObject = null;
        nativeVideoEl.remove();
      } catch (_) {}
      nativeVideoEl = null;
    }

    // Stop html5-qrcode fallback if running
    if (activeScanner) {
      const scannerRef = activeScanner;
      activeScanner = null;
      try {
        if (scannerRef.isScanning) await scannerRef.stop();
        await scannerRef.clear();
      } catch (_) {}
    }

    if (activeElementId) {
      const host = document.getElementById(activeElementId);
      if (host) host.innerHTML = '';
    }
    activeElementId = null;
  }

  async function buildNativeDetector(mode) {
    if (!hasNativeBarcodeDetector()) return null;
    const wanted =
      mode === 'qr'
        ? ['qr_code']
        : mode === 'barcode'
        ? ['code_128', 'code_39', 'itf', 'codabar', 'ean_13', 'upc_a']
        : ['code_128', 'code_39', 'itf', 'qr_code', 'codabar', 'ean_13', 'upc_a'];
    try {
      if (typeof global.BarcodeDetector.getSupportedFormats === 'function') {
        const supported = await global.BarcodeDetector.getSupportedFormats();
        const filtered = wanted.filter((f) => supported.includes(f));
        if (filtered.length === 0) return null;
        return new global.BarcodeDetector({ formats: filtered });
      }
      return new global.BarcodeDetector({ formats: wanted });
    } catch (_) {
      try {
        return new global.BarcodeDetector();
      } catch (__) {
        return null;
      }
    }
  }

  async function openCameraStream(facing) {
    const tries = [
      {
        video: {
          facingMode: { exact: facing },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 }
        },
        audio: false
      },
      {
        video: {
          facingMode: facing,
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 }
        },
        audio: false
      },
      {
        video: {
          facingMode: facing,
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      },
      { video: true, audio: false }
    ];

    let lastErr = null;
    for (let i = 0; i < tries.length; i++) {
      try {
        return await navigator.mediaDevices.getUserMedia(tries[i]);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('Camera unavailable');
  }

  /**
   * Starts 360° full-frame camera barcode & QR scanning inside target elementId.
   */
  async function start(elementId, onDecode, onError, options) {
    const opts = options || {};
    await stop();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const msg =
        'Camera requires HTTPS or localhost. Launch MM-VIRSA-Ops.exe on PC, or open over HTTPS on mobile.';
      if (onError) onError(msg);
      return { ok: false, error: msg };
    }

    const host = document.getElementById(elementId);
    if (!host) {
      const msg = 'Scanner container not found.';
      if (onError) onError(msg);
      return { ok: false, error: msg };
    }

    const mode = opts.scanMode ? setScanMode(opts.scanMode) : currentScanMode;
    const facing = opts.facingMode ? setCameraFacing(opts.facingMode) : currentFacing;
    const cooldownMs = opts.cooldownMs !== undefined ? opts.cooldownMs : 1200;

    const handleSuccess = (decodedText) => {
      const clean = App.Couriers.normalizeTracking(decodedText);
      if (!clean || clean.length < MIN_BARCODE_LEN) return;
      const now = Date.now();
      if (clean === lastCameraCode && now - lastCameraTime < cooldownMs) {
        return;
      }
      lastCameraCode = clean;
      lastCameraTime = now;
      if (onDecode) onDecode(clean);
    };

    try {
      // 1. PRIMARY ENGINE: Direct Native Hardware BarcodeDetector (360° Full-Frame, Zero Crop, <40ms!)
      const detector = await buildNativeDetector(mode);
      if (detector) {
        const stream = await openCameraStream(facing);
        nativeStream = stream;
        nativeTrack = stream.getVideoTracks()[0] || null;
        activeElementId = elementId;

        host.innerHTML = '';
        const video = document.createElement('video');
        video.setAttribute('autoplay', '');
        video.setAttribute('playsinline', '');
        video.setAttribute('muted', '');
        video.muted = true;
        video.playsInline = true;
        video.style.width = '100%';
        video.style.height = '100%';
        video.style.objectFit = 'cover';
        video.style.cursor = 'pointer';
        video.title = 'Tap to focus';
        video.addEventListener('click', triggerTapFocus);
        video.srcObject = stream;
        host.appendChild(video);
        nativeVideoEl = video;

        await video.play();
        const caps = await applyTrackEnhancements(nativeTrack, (c) => nativeTrack.applyConstraints(c));

        nativeRunning = true;
        const scanTick = async () => {
          if (!nativeRunning || !nativeVideoEl) return;
          if (!nativeDetecting && nativeVideoEl.readyState >= 2 && nativeVideoEl.videoWidth > 0) {
            nativeDetecting = true;
            try {
              const results = await detector.detect(nativeVideoEl);
              if (Array.isArray(results) && results.length > 0) {
                for (let i = 0; i < results.length; i++) {
                  const raw = results[i] && results[i].rawValue;
                  if (raw) handleSuccess(raw);
                }
              }
            } catch (_) {}
            nativeDetecting = false;
          }
          if (nativeRunning) {
            nativeLoopTimer = setTimeout(scanTick, 45);
          }
        };
        scanTick();
        return { ok: true, capabilities: caps };
      }

      // 2. FALLBACK ENGINE: Full-Frame html5-qrcode (NO qrbox cropping, scans entire view!)
      if (typeof global.Html5Qrcode === 'undefined') {
        const msg =
          'Camera barcode library is not loaded offline. You can still use a USB barcode scanner or type tracking numbers directly.';
        if (onError) onError(msg);
        return { ok: false, error: msg };
      }

      const F = global.Html5QrcodeSupportedFormats;
      const formats = F
        ? mode === 'qr'
          ? [F.QR_CODE]
          : mode === 'barcode'
          ? [F.CODE_128, F.CODE_39, F.ITF, F.EAN_13, F.CODABAR]
          : [F.CODE_128, F.CODE_39, F.ITF, F.QR_CODE]
        : undefined;

      const scanner = new global.Html5Qrcode(elementId, {
        formatsToSupport: formats,
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
        verbose: false
      });

      activeScanner = scanner;
      activeElementId = elementId;

      const config = {
        fps: 25,
        // NO qrbox -> scans 100% of visible camera frame at any position!
        disableFlip: false,
        videoConstraints: {
          facingMode: { exact: facing },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
        }
      };

      try {
        await scanner.start({ facingMode: { exact: facing } }, config, handleSuccess, () => {});
      } catch (_) {
        config.videoConstraints = {
          facingMode: facing,
          width: { ideal: 1280 },
          height: { ideal: 720 }
        };
        try {
          await scanner.start({ facingMode: facing }, config, handleSuccess, () => {});
        } catch (__) {
          delete config.videoConstraints;
          await scanner.start({ facingMode: facing }, config, handleSuccess, () => {});
        }
      }

      let caps = getCapabilities();
      try {
        const rawCaps = scanner.getRunningTrackCapabilities ? scanner.getRunningTrackCapabilities() : null;
        if (rawCaps) {
          caps = await applyTrackEnhancements(
            { getCapabilities: () => rawCaps },
            (c) => scanner.applyVideoConstraints(c)
          );
        }
      } catch (_) {}
      return { ok: true, capabilities: caps };
    } catch (err) {
      await stop();
      const msg =
        err && err.message
          ? `Camera could not start: ${err.message}`
          : 'Camera permission denied or no camera detected.';
      if (onError) onError(msg);
      return { ok: false, error: msg };
    }
  }

  function isActive(elementId) {
    if (!nativeRunning && !activeScanner) return false;
    if (elementId) return activeElementId === elementId;
    return true;
  }

  function resetCameraCooldown() {
    lastCameraCode = '';
    lastCameraTime = 0;
  }

  /**
   * Global USB Handheld Barcode Gun Wedge Listener
   */
  function attachUsbWedge(onScanCallback) {
    let buffer = '';
    let lastKeyTs = 0;

    document.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      const now = Date.now();
      if (now - lastKeyTs > 80) {
        buffer = '';
      }
      lastKeyTs = now;

      if (e.key === 'Enter') {
        const clean = App.Couriers.normalizeTracking(buffer);
        buffer = '';
        if (clean.length >= MIN_BARCODE_LEN && typeof onScanCallback === 'function') {
          e.preventDefault();
          onScanCallback(clean);
        }
      } else if (e.key && e.key.length === 1) {
        buffer += e.key;
      }
    });
  }

  App.Scanner = {
    isLibraryLoaded,
    hasNativeBarcodeDetector,
    getScanMode,
    setScanMode,
    getCameraFacing,
    setCameraFacing,
    getCapabilities,
    toggleTorch,
    cycleZoom,
    start,
    stop,
    isActive,
    resetCameraCooldown,
    attachUsbWedge
  };
})(window);
