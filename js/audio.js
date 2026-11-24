/**
 * js/audio.js
 * Warehouse scanner audio feedback synthesizer using Web Audio API.
 * Zero external sound files needed; works 100% offline.
 */
(function (global) {
  const App = (global.DispatchApp = global.DispatchApp || {});

  let audioCtx = null;
  let muted = false;

  function ensureContext() {
    if (muted) return null;
    try {
      if (!audioCtx) {
        const Ctx = global.AudioContext || global.webkitAudioContext;
        if (!Ctx) return null;
        audioCtx = new Ctx();
      }
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      return audioCtx;
    } catch (e) {
      return null;
    }
  }

  function playTone(freq, durationSec, type, startDelaySec, gainValue) {
    const ctx = ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime + (startDelaySec || 0);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, now);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(gainValue || 0.28, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, now + durationSec);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + durationSec + 0.02);
  }

  // Crisp ascending scanner success beep
  function playSuccess() {
    playTone(980, 0.11, 'sine', 0, 0.3);
    playTone(1480, 0.16, 'sine', 0.1, 0.32);
    if (navigator.vibrate) {
      try { navigator.vibrate(70); } catch (_) {}
    }
  }

  // Harsh double buzz for duplicate scans
  function playDuplicateBuzz() {
    playTone(170, 0.2, 'sawtooth', 0, 0.34);
    playTone(145, 0.28, 'sawtooth', 0.24, 0.36);
    if (navigator.vibrate) {
      try { navigator.vibrate([120, 60, 180]); } catch (_) {}
    }
  }

  // Attention chime for unknown parcel
  function playUnknownChime() {
    playTone(620, 0.14, 'triangle', 0, 0.3);
    playTone(460, 0.22, 'triangle', 0.16, 0.3);
    if (navigator.vibrate) {
      try { navigator.vibrate([80, 50, 80]); } catch (_) {}
    }
  }

  // Light confirmation click for dispatch logging
  function playDispatchTick() {
    playTone(1120, 0.09, 'sine', 0, 0.2);
  }

  function setMuted(isMuted) {
    muted = Boolean(isMuted);
  }

  function isMuted() {
    return muted;
  }

  App.Audio = {
    playSuccess,
    playDuplicateBuzz,
    playUnknownChime,
    playDispatchTick,
    setMuted,
    isMuted
  };
})(window);
