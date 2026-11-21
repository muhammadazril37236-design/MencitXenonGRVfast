/* ==========================================================================
   CLEAN DIGITAL LABORATORY - WEB AUDIO SFX ENGINE
   Zero-dependency, zero-latency, auto-ducking with TTS
   ========================================================================== */
/* ============================================================================
   AUDIO_MANAGER — Unified Web Audio Procedural Engine (v6.0)
   Mengelola 4 Bus Volume Real-Time, Loop Lingkungan, Anti-Overlap & Lifecycle
   ============================================================================ */
const AUDIO_MANAGER = (() => {
  let ctx = null;
  let masterGain = null;
  let duckingGain = null;
  const buses = { ui: null, ambience: null, movement: null, simulation: null };

  // State Penyimpanan & Volume
 // State Penyimpanan & Volume
  let isMuted = localStorage.getItem('vmd_sfx_muted') === 'true';
  const volumes = {
    ui: parseFloat(localStorage.getItem('vmd_vol_ui') ?? '0.95'),
    ambience: parseFloat(localStorage.getItem('vmd_vol_ambience') ?? '0.8'),
    movement: parseFloat(localStorage.getItem('vmd_vol_movement') ?? '0.95'),
    simulation: parseFloat(localStorage.getItem('vmd_vol_simulation') ?? '1.0')
  };

  // Anti-Overlap & Active Loop Trackers
  const lastPlayed = {};
  let noiseBuffer = null;
  let cageAmbienceNode = null;
  let labAmbienceNode = null;
  let hayRustleTimer = null;
  let activeHoldInterval = null;
  let duckMonitorInterval = null;

  function ensureContext() {
    if (!ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      ctx = new AudioCtx();

     masterGain = ctx.createGain();
    duckingGain = ctx.createGain();

    masterGain.gain.value = isMuted ? 0 : 1.8;

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -12;
    compressor.knee.value = 10;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.15;

    duckingGain.gain.value = 1;

    duckingGain.connect(masterGain);
    masterGain.connect(compressor);
    compressor.connect(ctx.destination);

    // Inisialisasi 4 Bus Kategori
      // Inisialisasi 4 Bus Kategori
      Object.keys(buses).forEach((key) => {
        const g = ctx.createGain();
        g.gain.value = isNaN(volumes[key]) ? 0.75 : volumes[key];
        g.connect(duckingGain);
        buses[key] = g;
      });

      // Buat 2 detik Pink Noise Buffer sekali saja untuk jerami, ambient & sayatan
      const sampleRate = ctx.sampleRate;
      const length = sampleRate * 2;
      noiseBuffer = ctx.createBuffer(1, length, sampleRate);
      const data = noiseBuffer.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < length; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.04;
        b6 = white * 0.115926;
      }

      startDuckingMonitor();
    }
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    return ctx;
  }

  // Otomatis meredupkan SFX ke 25% saat narasi suara (TTS) sedang berbicara
  function startDuckingMonitor() {
    if (duckMonitorInterval) return;
    duckMonitorInterval = setInterval(() => {
      if (!ctx || !duckingGain) return;
      const ttsSpeaking =
        (window.speechSynthesis && window.speechSynthesis.speaking) ||
        (typeof ttsAudioPlayer !== 'undefined' && ttsAudioPlayer && !ttsAudioPlayer.paused);
      const targetDuck = ttsSpeaking ? 0.25 : 1.0;
      duckingGain.gain.setTargetAtTime(targetDuck, ctx.currentTime, 0.08);
    }, 150);
  }

  function canPlay(id, cooldownMs) {
    const now = performance.now();
    if (lastPlayed[id] && now - lastPlayed[id] < cooldownMs) return false;
    lastPlayed[id] = now;
    return true;
  }

  // Helper Pembangkit Nada Oscillator Halus
  function triggerTone(busName, { type = 'sine', fStart, fEnd, duration = 0.08, gain = 0.2, delay = 0 }) {
    const ac = ensureContext();
    if (!ac || isMuted || !buses[busName]) return;
    const t0 = ac.currentTime + delay;
    const osc = ac.createOscillator();
    const env = ac.createGain();
    const filter = ac.createBiquadFilter();

    osc.type = type;
    osc.frequency.setValueAtTime(fStart, t0);
    if (fEnd && fEnd !== fStart) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, fEnd), t0 + duration);
    }

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2600, t0);

    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(gain, t0 + Math.min(0.012, duration * 0.25));
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

    osc.connect(filter);
    filter.connect(env);
    env.connect(buses[busName]);

    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  // Helper Pembangkit Tekstur Noise (Jerami, Gesekan, Uap)
  function triggerNoise(busName, { filterType = 'bandpass', freq = 1600, q = 1.5, duration = 0.15, gain = 0.15 }) {
    const ac = ensureContext();
    if (!ac || isMuted || !noiseBuffer || !buses[busName]) return;
    const t0 = ac.currentTime;
    const src = ac.createBufferSource();
    src.buffer = noiseBuffer;

    const filter = ac.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(freq, t0);
    filter.Q.setValueAtTime(q, t0);

    const env = ac.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(gain, t0 + duration * 0.3);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

    src.connect(filter);
    filter.connect(env);
    env.connect(buses[busName]);

    const offset = Math.random() * 1.2;
    src.start(t0, offset, duration + 0.05);
  }

  // Daftar 19 Aset Suara Terstruktur
  function play(id, param = null) {
    if (isMuted) return;

    switch (id) {
      /* --- BUS 1: UI & NAVIGASI --- */
      case 'ui_button_tap':
        if (!canPlay(id, 65)) return;
        triggerTone('ui', { type: 'sine', fStart: 540, fEnd: 390, duration: 0.05, gain: 0.16 });
        break;

      case 'ui_tool_select':
        if (!canPlay(id, 80)) return;
        triggerTone('ui', { type: 'triangle', fStart: 620, fEnd: 860, duration: 0.085, gain: 0.18 });
        break;

      case 'ui_card_open':
        if (!canPlay(id, 120)) return;
        triggerTone('ui', { type: 'sine', fStart: 360, fEnd: 560, duration: 0.12, gain: 0.16 });
        break;

      case 'ui_card_close':
        if (!canPlay(id, 120)) return;
        triggerTone('ui', { type: 'sine', fStart: 500, fEnd: 320, duration: 0.10, gain: 0.14 });
        break;

      case 'ui_toast_alert':
        if (!canPlay(id, 300)) return;
        triggerTone('ui', { type: 'triangle', fStart: 740, fEnd: 740, duration: 0.06, gain: 0.15, delay: 0 });
        triggerTone('ui', { type: 'triangle', fStart: 580, fEnd: 560, duration: 0.09, gain: 0.14, delay: 0.075 });
        break;

      case 'ui_spotlight_step':
        if (!canPlay(id, 90)) return;
        triggerTone('ui', { type: 'sine', fStart: 680, fEnd: 920, duration: 0.075, gain: 0.15 });
        break;

      /* --- BUS 2: AMBIENCE & KANDANG --- */
      case 'amb_hay_rustle':
        if (!canPlay(id, 900)) return;
        triggerNoise('ambience', {
          filterType: 'bandpass',
          freq: 1400 + Math.random() * 700,
          q: 1.8,
          duration: 0.2 + Math.random() * 0.12,
          gain: 0.14
        });
        break;

      /* --- BUS 3: MOVEMENT & INTERAKSI KANDANG --- */
      case 'mov_mouse_step': {
        const speed = typeof param === 'number' ? param : 1;
        const dynamicCd = Math.max(125, Math.min(260, 280 - speed * 55));
        if (!canPlay(id, dynamicCd)) return;
        const jitter = 0.9 + Math.random() * 0.22;
        triggerTone('movement', {
          type: 'sine',
          fStart: 270 * jitter,
          fEnd: 150 * jitter,
          duration: 0.028,
          gain: 0.11
        });
        break;
      }

      case 'mov_mouse_scurry':
        if (!canPlay(id, 85)) return;
        triggerTone('movement', {
          type: 'triangle',
          fStart: 360 + Math.random() * 80,
          fEnd: 210,
          duration: 0.035,
          gain: 0.13
        });
        triggerNoise('movement', {
          filterType: 'bandpass',
          freq: 1900,
          q: 2.0,
          duration: 0.055,
          gain: 0.12
        });
        break;

      case 'mov_hold_progress':
        if (!canPlay(id, 280)) return;
        triggerTone('movement', { type: 'sine', fStart: 440, fEnd: 520, duration: 0.065, gain: 0.12 });
        break;

      case 'mov_hold_confirm':
        if (!canPlay(id, 250)) return;
        triggerTone('movement', { type: 'sine', fStart: 523.25, fEnd: 523.25, duration: 0.09, gain: 0.18, delay: 0 });
        triggerTone('movement', { type: 'sine', fStart: 659.25, fEnd: 659.25, duration: 0.09, gain: 0.18, delay: 0.07 });
        triggerTone('movement', { type: 'sine', fStart: 783.99, fEnd: 783.99, duration: 0.16, gain: 0.20, delay: 0.14 });
        break;

      case 'mov_hold_cancel':
        if (!canPlay(id, 180)) return;
        triggerTone('movement', { type: 'sine', fStart: 350, fEnd: 210, duration: 0.13, gain: 0.15 });
        break;

      /* --- BUS 4: SIMULASI PRAKTIKUM & BEDAH --- */
      case 'sim_anesthesia_tick':
        if (!canPlay(id, 260)) return;
        triggerNoise('simulation', { filterType: 'bandpass', freq: 850, q: 1.4, duration: 0.14, gain: 0.11 });
        triggerTone('simulation', { type: 'sine', fStart: 390, fEnd: 430, duration: 0.09, gain: 0.08 });
        break;

      case 'sim_marker_place':
        if (!canPlay(id, 80)) return;
        triggerTone('simulation', { type: 'triangle', fStart: 740, fEnd: 980, duration: 0.085, gain: 0.19 });
        break;

      case 'sim_incision_slide':
        if (!canPlay(id, 110)) return;
        triggerNoise('simulation', {
          filterType: 'highpass',
          freq: 2400 + Math.random() * 400,
          q: 1.2,
          duration: 0.075,
          gain: 0.12
        });
        break;

      case 'sim_organ_pick_dock':
        if (!canPlay(id, 90)) return;
        if (param === 'pick') {
          triggerTone('simulation', { type: 'sine', fStart: 440, fEnd: 660, duration: 0.11, gain: 0.17 });
        } else {
          triggerTone('simulation', { type: 'sine', fStart: 640, fEnd: 460, duration: 0.12, gain: 0.19 });
        }
        break;

      case 'sim_stage_complete':
        if (!canPlay(id, 350)) return;
        if (param === 'final') {
          [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
            triggerTone('simulation', {
              type: 'triangle',
              fStart: freq,
              fEnd: freq,
              duration: i === 3 ? 0.28 : 0.11,
              gain: 0.2,
              delay: i * 0.09
            });
          });
        } else {
          [493.88, 587.33, 739.99].forEach((freq, i) => {
            triggerTone('simulation', {
              type: 'sine',
              fStart: freq,
              fEnd: freq,
              duration: i === 2 ? 0.18 : 0.09,
              gain: 0.18,
              delay: i * 0.075
            });
          });
        }
        break;
    }
  }

  /* ==========================================================
     KONTROL LOOP LINGKUNGAN (KANDANG & LABORATORIUM)
     ========================================================== */

let cageActivityTimer = null;

function playCageRustleAndSqueak(ac) {
  if (!ac || ac.state !== 'running' || !buses.ambience) return;
  const now = ac.currentTime;

  // 1. Suara Gresek-Gresek Alas Kandang (85% peluang muncul tiap interval)
  if (noiseBuffer && Math.random() < 0.85) {
    const duration = 0.08 + Math.random() * 0.09;
    const rustleSrc = ac.createBufferSource();
    rustleSrc.buffer = noiseBuffer;

    // Filter bandpass agar terdengar seperti gesekan serbuk kayu/kertas kering
    const filter = ac.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1500 + Math.random() * 1400, now);
    filter.Q.setValueAtTime(2.0, now);

    const gain = ac.createGain();
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.045, now + duration * 0.3);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    rustleSrc.connect(filter);
    filter.connect(gain);
    gain.connect(buses.ambience);

    // Mulai dari titik acak di dalam noiseBuffer agar bunyi gesekannya bervariasi
    const maxOffset = Math.max(0, noiseBuffer.duration - duration - 0.05);
    rustleSrc.start(now, Math.random() * maxOffset, duration);
  }

  // 2. Suara "Cit-Cit" Pelan (18% peluang muncul sesekali)
  if (Math.random() < 0.18) {
    const squeakCount = Math.random() > 0.45 ? 2 : 1; // Kadang 1x "cit", kadang 2x "cit-cit"
    for (let i = 0; i < squeakCount; i++) {
      const startTime = now + i * 0.11;
      const duration = 0.065;

      const osc = ac.createOscillator();
      const gain = ac.createGain();

      osc.type = 'sine';
      const baseFreq = 3300 + Math.random() * 900; // Frekuensi tinggi khas mencit
      osc.frequency.setValueAtTime(baseFreq, startTime);
      osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.25, startTime + duration * 0.4);
      osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.85, startTime + duration);

      gain.gain.setValueAtTime(0.0001, startTime);
      gain.gain.linearRampToValueAtTime(0.025, startTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

      osc.connect(gain);
      gain.connect(buses.ambience);

      osc.start(startTime);
      osc.stop(startTime + duration);
    }
  }
}

function startCageAmbience() {
  const ac = ensureContext();
  if (!ac || cageAmbienceNode || !noiseBuffer || !buses.ambience) return;

  // Suara latar lembut kandang bawaan
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;

  const filter = ac.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 320;

  const gain = ac.createGain();
  gain.gain.setValueAtTime(0.001, ac.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.025, ac.currentTime + 0.8);

  src.connect(filter);
  filter.connect(gain);
  gain.connect(buses.ambience);
  src.start();

  cageAmbienceNode = { src, gain };

  // Jalankan efek gresek-gresek & cit-cit berkala selama mencit di kandang
  if (cageActivityTimer) clearInterval(cageActivityTimer);
  cageActivityTimer = setInterval(() => {
    playCageRustleAndSqueak(ac);
  }, 320);
}

function stopCageAmbience() {
  if (cageActivityTimer) {
    clearInterval(cageActivityTimer);
    cageActivityTimer = null;
  }
  if (!cageAmbienceNode) return;
  try {
    const ac = audioCtx;
    if (ac && cageAmbienceNode.gain) {
      cageAmbienceNode.gain.gain.setTargetAtTime(0.0001, ac.currentTime, 0.15);
    }
    setTimeout(() => {
      try { cageAmbienceNode?.src?.stop(); } catch (_) {}
      cageAmbienceNode = null;
    }, 300);
  } catch (_) {
    cageAmbienceNode = null;
  }
}

  function startLabAmbience() {
    const ac = ensureContext();
    if (!ac || labAmbienceNode || !buses.ambience) return;

    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 110;

    const gain = ac.createGain();
    gain.gain.setValueAtTime(0.0001, ac.currentTime);
    gain.gain.linearRampToValueAtTime(0.025, ac.currentTime + 0.5);

    osc.connect(gain);
    gain.connect(buses.ambience);
    osc.start();

    labAmbienceNode = { osc, gain };
  }

  function stopLabAmbience() {
    if (labAmbienceNode && ctx) {
      const { osc, gain } = labAmbienceNode;
      labAmbienceNode = null;
      try {
        gain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.15);
        setTimeout(() => { try { osc.stop(); } catch (e) {} }, 400);
      } catch (e) {}
    }
  }

  /* ==========================================================
     KONTROL HOLD LOOP (TAHAN 3 DETIK & ANESTESI)
     ========================================================== */
  function startHoldPulse(soundId = 'mov_hold_progress', intervalMs = 340) {
    stopHoldPulse();
    play(soundId);
    activeHoldInterval = setInterval(() => play(soundId), intervalMs);
  }

  function stopHoldPulse() {
    if (activeHoldInterval) {
      clearInterval(activeHoldInterval);
      activeHoldInterval = null;
    }
  }

  /* ==========================================================
     PENGATURAN VOLUME, MUTE & LIFECYCLE
     ========================================================== */
  function setCategoryVolume(category, val) {
    const clamped = Math.max(0, Math.min(1, parseFloat(val)));
    volumes[category] = clamped;
    localStorage.setItem(`vmd_vol_${category}`, String(clamped));
    if (ctx && buses[category]) {
      buses[category].gain.setTargetAtTime(clamped, ctx.currentTime, 0.03);
    }
  }

  function getCategoryVolume(category) {
    return volumes[category] ?? 0.8;
  }

 function toggleMute() {
    ensureContext();
    isMuted = !isMuted;
    localStorage.setItem('vmd_sfx_muted', String(isMuted));
    if (ctx && masterGain) {
      masterGain.gain.setTargetAtTime(isMuted ? 0 : 1.8, ctx.currentTime, 0.03);
    }
    updateMuteButtonUI();
    if (!isMuted) play('ui_button_tap');
  }

  function updateMuteButtonUI() {
    const btn = document.getElementById('btn-sfx-toggle');
    const icon = document.getElementById('sfx-icon');
    const label = document.getElementById('sfx-label');
    if (icon) icon.textContent = isMuted ? '🔇' : '🔊';
    if (label) label.textContent = isMuted ? 'Suara Mati' : 'Suara Aktif';
    if (btn) {
      btn.classList.toggle('muted', isMuted);
      btn.classList.toggle('is-muted', isMuted);
    }
  }

  function stopAllTransientAudio() {
    stopHoldPulse();
    stopCageAmbience();
  }

 return {
    playBeddingRustle() {
      if (isMuted || !audioCtx || volumes.ambience <= 0) return;
      if (audioCtx.state === 'suspended') audioCtx.resume();

      const now = audioCtx.currentTime;
      const duration = 0.08 + Math.random() * 0.07;

      const bufferSize = Math.floor(audioCtx.sampleRate * duration);
      const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.sin((i / bufferSize) * Math.PI);
      }

      const noise = audioCtx.createBufferSource();
      noise.buffer = buffer;

      const filter = audioCtx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(1400 + Math.random() * 1200, now);
      filter.Q.setValueAtTime(1.8, now);

      const gain = audioCtx.createGain();
      const vol = 0.035 * volumes.ambience;
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(vol, now + duration * 0.3);
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

      noise.connect(filter);
      filter.connect(gain);
      gain.connect(audioCtx.destination);

      noise.start(now);
      noise.stop(now + duration);
    },

    playMouseSqueak() {
      if (isMuted || !audioCtx || volumes.ambience <= 0) return;
      if (audioCtx.state === 'suspended') audioCtx.resume();

      const now = audioCtx.currentTime;
      const count = Math.random() > 0.45 ? 2 : 1;

      for (let i = 0; i < count; i++) {
        const startTime = now + i * 0.11;
        const duration = 0.065;

        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();

        osc.type = 'sine';
        const baseFreq = 3200 + Math.random() * 900;
        osc.frequency.setValueAtTime(baseFreq, startTime);
        osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.25, startTime + duration * 0.4);
        osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.85, startTime + duration);

        const vol = 0.025 * volumes.ambience;
        gain.gain.setValueAtTime(0.0001, startTime);
        gain.gain.linearRampToValueAtTime(vol, startTime + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

        osc.connect(gain);
        gain.connect(audioCtx.destination);

        osc.start(startTime);
        osc.stop(startTime + duration);
      }
    },


    ensureContext,
    play,
    startCageAmbience,
    stopCageAmbience,
    startLabAmbience,
    stopLabAmbience,
    startHoldPulse,
    stopHoldPulse,
    setCategoryVolume,
    getCategoryVolume,
    toggleMute,
    updateMuteButtonUI,
    stopAllTransientAudio
  };
})();
const ORGANS = [
  {
    id: 'heart',
    color: '#e11d48',
    name: { id: 'Jantung', en: 'Heart' },
    latin: 'Cor',
    iconSvg: `<svg viewBox="0 0 64 54" width="52" height="44">
      <path d="M32 14 C40 4 54 13 49 28 C44 39 32 47 32 47 C32 47 20 39 15 28 C10 13 24 4 32 14 Z" fill="#e11d48" stroke="#9f1239" stroke-width="2"/>
      <path d="M27 11 L24 4 M35 10 L37 3" stroke="#be123c" stroke-width="3.5" stroke-linecap="round"/>
    </svg>`,
    description: {
      id: 'Organ otot berongga yang terbagi menjadi empat ruang, yaitu atrium kanan, ventrikel kanan, atrium kiri, dan ventrikel kiri, serta dibungkus selaput perikardium.',
      en: 'Hollow muscular organ divided into four chambers: right atrium, right ventricle, left atrium, and left ventricle, enclosed by the pericardial sac.'
    },
    howItWorks: {
      id: 'Atrium kanan menerima darah dari seluruh tubuh lalu mengalirkannya ke ventrikel kanan untuk dipompa menuju paru-paru. Darah dari paru-paru masuk ke atrium kiri lalu ke ventrikel kiri untuk dipompa ke seluruh tubuh melalui aorta.',
      en: 'The right atrium receives blood from the body and sends it to the right ventricle to be pumped to the lungs. Blood from the lungs enters the left atrium and then the left ventricle to be pumped throughout the body via the aorta.'
    },
    func: {
      id: 'Memompa darah secara terus-menerus untuk mengedarkan oksigen, zat gizi, dan hormon ke seluruh jaringan tubuh mencit (denyut jantung diperkirakan sekitar 500–600 kali per menit dan dapat berubah sesuai kondisi fisiologis maupun lingkungan).',
      en: 'Pumps blood continuously to deliver oxygen, nutrients, and hormones throughout the mouse body (heart rate is estimated at around 500–600 beats per minute and may vary depending on physiological and environmental conditions).'
    },
    location: {
      id: 'Rongga dada (cavum thoracis) bagian tengah (mediastinum), di antara paru-paru kanan dan kiri serta tepat di atas diafragma.',
      en: 'Middle mediastinum of the thoracic cavity, positioned between the right and left lungs directly above the diaphragm.'
    },
    mechanismCaption: {
      id: 'Sirkulasi Jantung 4 Ruang: Atrium kanan → Ventrikel kanan → Paru-paru → Atrium kiri → Ventrikel kiri → Seluruh tubuh.',
      en: '4-Chamber Cardiac Circulation: Right atrium → Right ventricle → Lungs → Left atrium → Left ventricle → Body.'
    },
    mechanismSvg: `<svg viewBox="0 0 280 150">
      <rect x="4" y="4" width="272" height="142" rx="8" fill="#fff1f2"/>
      <!-- Pembuluh Vena & Arteri -->
      <path d="M18 32 L106 32 L106 46" fill="none" stroke="#2563eb" stroke-width="6" stroke-linecap="round"/>
      <path d="M106 86 L62 114 L18 114" fill="none" stroke="#3b82f6" stroke-width="5.5" stroke-linecap="round"/>
      <path d="M262 32 L174 32 L174 46" fill="none" stroke="#ef4444" stroke-width="6" stroke-linecap="round"/>
      <path d="M174 86 L218 114 L262 114" fill="none" stroke="#dc2626" stroke-width="5.5" stroke-linecap="round"/>
      <!-- Aliran Partikel Darah -->
      <path d="M22 32 L106 32" class="mech-flow" stroke="#bfdbfe" stroke-width="2.5"/>
      <path d="M106 86 L62 114 L22 114" class="mech-flow" stroke="#bfdbfe" stroke-width="2.5"/>
      <path d="M258 32 L174 32" class="mech-flow" stroke="#fecaca" stroke-width="2.5"/>
      <path d="M174 86 L218 114 L258 114" class="mech-flow" stroke="#fecaca" stroke-width="2.5"/>
      <!-- 4 Ruang Jantung -->
      <g class="mech-atria">
        <rect x="92" y="38" width="46" height="26" rx="7" fill="#3b82f6" stroke="#1e3a8a" stroke-width="1.8"/>
        <rect x="142" y="38" width="46" height="26" rx="7" fill="#ef4444" stroke="#7f1d1d" stroke-width="1.8"/>
        <text x="115" y="54" text-anchor="middle" font-size="8" font-weight="700" fill="#fff">Atrium Kanan</text>
        <text x="165" y="54" text-anchor="middle" font-size="8" font-weight="700" fill="#fff">Atrium Kiri</text>
      </g>
      <g class="mech-ventricle">
        <path d="M92 66 L138 66 L138 106 Q112 104 92 84 Z" fill="#1d4ed8" stroke="#1e3a8a" stroke-width="1.8"/>
        <path d="M142 66 L188 66 L188 84 Q168 104 142 106 Z" fill="#b91c1c" stroke="#7f1d1d" stroke-width="1.8"/>
        <text x="116" y="84" text-anchor="middle" font-size="8" font-weight="700" fill="#fff">Ventrikel Kanan</text>
        <text x="164" y="84" text-anchor="middle" font-size="8" font-weight="700" fill="#fff">Ventrikel Kiri</text>
      </g>
      <!-- Katup Trikuspid & Bikuspid -->
      <line x1="104" y1="65" x2="126" y2="65" stroke="#facc15" stroke-width="3"/>
      <line x1="154" y1="65" x2="176" y2="65" stroke="#facc15" stroke-width="3"/>
      <!-- Label -->
      <text x="16" y="21" font-size="8.5" font-weight="700" fill="#1d4ed8">1. Vena Kava (CO₂)</text>
      <text x="16" y="128" font-size="8.5" font-weight="700" fill="#1d4ed8">2. Arteri Pulmonalis</text>
      <text x="182" y="21" font-size="8.5" font-weight="700" fill="#b91c1c">3. Vena Pulmonalis (O₂)</text>
      <text x="192" y="128" font-size="8.5" font-weight="700" fill="#b91c1c">4. Aorta ke Seluruh Tubuh</text>
      <text x="140" y="140" text-anchor="middle" font-size="8.5" font-weight="800" fill="#881337">Katup Trikuspid & Mitral Mencegah Arus Balik</text>
    </svg>`
  },
  {
    id: 'lungs',
    color: '#fb7185',
    name: { id: 'Paru-paru', en: 'Lungs' },
    latin: 'Pulmo',
    iconSvg: `<svg viewBox="0 0 64 54" width="52" height="44">
      <path d="M32 6 L32 18" stroke="#94a3b8" stroke-width="4" stroke-linecap="round"/>
      <path d="M28 16 C14 16 9 32 12 46 C20 48 27 45 28 41 Z" fill="#fb7185" stroke="#be123c" stroke-width="1.8"/>
      <path d="M36 16 C50 16 55 32 52 46 C44 48 37 45 36 41 Z" fill="#fb7185" stroke="#be123c" stroke-width="1.8"/>
    </svg>`,
    description: {
      id: 'Sepasang organ pernapasan bertekstur spons elastis di rongga dada yang tersusun atas saluran bronkus hingga kantong-kantong kecil bernama alveolus.',
      en: 'Paired elastic, spongy respiratory organs in the thoracic cavity composed of bronchial airways terminating in tiny sacs called alveoli.'
    },
    howItWorks: {
      id: 'Gerakan diafragma dan otot dada mengalirkan udara keluar-masuk menuju alveolus. Di alveolus terjadi pertukaran gas: oksigen (O₂) berdifusi ke dalam darah dan diikat oleh hemoglobin (protein di dalam sel darah merah), sedangkan karbon dioksida (CO₂) dilepaskan untuk dikeluarkan saat mengembuskan napas.',
      en: 'Movements of the diaphragm and chest muscles move air in and out of the alveoli. Gas exchange occurs in the alveoli: oxygen (O₂) diffuses into the blood and is bound by hemoglobin (a protein inside red blood cells), while carbon dioxide (CO₂) is released during exhalation.'
    },
    func: {
      id: 'Menjadi tempat pertukaran gas oksigen (O₂) dan karbon dioksida (CO₂) antara udara pernapasan dan aliran darah.',
      en: 'Serves as the site of gas exchange for oxygen (O₂) and carbon dioxide (CO₂) between inhaled air and the bloodstream.'
    },
    location: {
      id: 'Rongga dada (cavum thoracis) sisi kanan dan kiri, terlindungi tulang rusuk serta berada di atas diafragma.',
      en: 'Left and right sides of the thoracic cavity, protected by the rib cage and resting above the diaphragm.'
    },
    mechanismCaption: {
      id: 'Pertukaran Gas di Alveolus: Oksigen masuk ke darah dan diikat hemoglobin sel darah merah, sedangkan karbon dioksida dikeluarkan.',
      en: 'Alveolar Gas Exchange: Oxygen enters the blood and binds hemoglobin in red blood cells, while carbon dioxide is expelled.'
    },
    mechanismSvg: `<svg viewBox="0 0 280 150">
      <rect x="4" y="4" width="272" height="142" rx="8" fill="#f0f9ff"/>
      <!-- Trakea & Alveolus Mengembang-Mengempis -->
      <rect x="76" y="10" width="12" height="22" fill="#cbd5e1" stroke="#64748b" stroke-width="1.5"/>
      <g class="mech-lung-sac">
        <circle cx="82" cy="64" r="36" fill="#ffe4e6" stroke="#fb7185" stroke-width="2.5"/>
        <text x="82" y="42" text-anchor="middle" font-size="8.5" font-weight="800" fill="#be123c">Alveolus</text>
        <text x="82" y="53" text-anchor="middle" font-size="7.5" font-weight="600" fill="#9f1239">(pO₂ Tinggi)</text>
      </g>
      <!-- Otot Diafragma Bergerak Naik-Turun -->
      <path class="mech-diaphragm" d="M32 114 Q82 98 132 114" fill="none" stroke="#be185d" stroke-width="4" stroke-linecap="round"/>
      <text x="82" y="136" text-anchor="middle" font-size="8.5" font-weight="700" fill="#831843">Diafragma (Kontraksi ↔ Relaksasi)</text>
      <!-- Kapiler Darah & Sel Darah Merah -->
      <path d="M152 14 Q134 64 152 122 L192 122 Q174 64 192 14 Z" fill="#fee2e2" stroke="#ef4444" stroke-width="2"/>
      <ellipse cx="164" cy="46" rx="9" ry="5" fill="#dc2626"/>
      <text x="164" y="49" text-anchor="middle" font-size="6.5" font-weight="700" fill="#fff">HbO₂</text>
      <ellipse cx="166" cy="88" rx="9" ry="5" fill="#2563eb"/>
      <text x="166" y="91" text-anchor="middle" font-size="6.5" font-weight="700" fill="#fff">CO₂</text>
      <!-- Partikel Difusi O2 dan CO2 -->
      <g class="mech-o2">
        <circle cx="102" cy="54" r="6.5" fill="#ef4444"/>
        <text x="102" y="57" text-anchor="middle" font-size="7" font-weight="700" fill="#fff">O₂</text>
      </g>
      <g class="mech-co2">
        <circle cx="154" cy="82" r="6.5" fill="#2563eb"/>
        <text x="154" y="85" text-anchor="middle" font-size="6.5" font-weight="700" fill="#fff">CO₂</text>
      </g>
      <text x="234" y="42" text-anchor="middle" font-size="8.5" font-weight="700" fill="#b91c1c">O₂ → Sel Darah Merah</text>
      <text x="234" y="56" text-anchor="middle" font-size="8" font-weight="600" fill="#475569">diikat hemoglobin</text>
      <text x="234" y="82" text-anchor="middle" font-size="8.5" font-weight="700" fill="#1d4ed8">CO₂ → Alveolus</text>
      <text x="234" y="96" text-anchor="middle" font-size="8" font-weight="600" fill="#475569">dibuang ekspirasi</text>
    </svg>`
  },
  {
    id: 'liver',
    color: '#b91c1c',
    name: { id: 'Hati', en: 'Liver' },
    latin: 'Hepar',
    iconSvg: `<svg viewBox="0 0 64 54" width="52" height="44">
      <path d="M8 24 C15 12 31 14 32 27 C33 14 49 12 56 24 C57 40 43 46 32 38 C21 46 7 40 8 24 Z" fill="#b91c1c" stroke="#7f1d1d" stroke-width="1.8"/>
      <line x1="32" y1="18" x2="32" y2="38" stroke="#7f1d1d" stroke-width="2"/>
    </svg>`,
    description: {
      id: 'Organ kelenjar besar berwarna merah kecokelatan gelap di bagian atas rongga perut yang terdiri atas beberapa lobus dan terhubung dengan kantung empedu.',
      en: 'Large dark reddish-brown glandular organ in the upper abdominal cavity divided into multiple lobes and associated with the gallbladder.'
    },
    howItWorks: {
      id: 'Menerima darah dari saluran pencernaan melalui vena porta untuk memproses zat gizi, menyimpan glukosa dalam bentuk glikogen, mengubah amonia menjadi urea, serta mengolah zat berbahaya agar dapat dikeluarkan tubuh. Hati juga menghasilkan empedu yang disimpan di dalam kantung empedu sebelum dialirkan ke duodenum untuk mengemulsikan lemak.',
      en: 'Receives blood from the digestive tract via the portal vein to process nutrients, store glucose as glycogen, convert ammonia into urea, and process harmful substances for elimination. The liver also produces bile, which is stored in the gallbladder before entering the duodenum to emulsify fats.'
    },
    func: {
      id: 'Mengatur metabolisme zat gizi, menyimpan glikogen, membentuk urea dari amonia, mengolah zat berbahaya, serta menghasilkan empedu (yang disimpan oleh kantung empedu).',
      en: 'Regulates nutrient metabolism, stores glycogen, converts ammonia to urea, processes harmful substances, and produces bile (stored by the gallbladder).'
    },
    location: {
      id: 'Rongga perut (cavum abdominis) bagian atas, menempel tepat di bawah diafragma.',
      en: 'Upper abdominal cavity, positioned immediately beneath the diaphragm.'
    },
    mechanismCaption: {
      id: 'Peran Hati & Kantung Empedu: Pengolahan zat gizi, glikogen, urea, serta produksi dan penyimpanan empedu untuk mengemulsikan lemak.',
      en: 'Liver & Gallbladder Functions: Nutrient processing, glycogen storage, urea formation, plus bile production and storage to emulsify fats.'
    },
    mechanismSvg: `<svg viewBox="0 0 280 150">
      <rect x="4" y="4" width="272" height="142" rx="8" fill="#fef2f2"/>
      <!-- Jalur Atas: Vena Porta -> Hepatosit -> Glikogen & Urea -->
      <path d="M14 34 L72 34" stroke="#7c3aed" stroke-width="4.5" stroke-linecap="round"/>
      <path d="M14 34 L72 34" class="mech-flow" stroke="#ddd6fe" stroke-width="2"/>
      <text x="43" y="23" text-anchor="middle" font-size="8" font-weight="700" fill="#5b21b6">Vena Porta</text>
      <!-- Organ Hepar -->
      <path d="M74 30 C88 14 124 14 138 30 C142 58 114 68 106 56 C98 68 70 58 74 30 Z" fill="#b91c1c" stroke="#7f1d1d" stroke-width="1.5"/>
      <text x="106" y="40" text-anchor="middle" font-size="9" font-weight="800" fill="#fff">HEPAR</text>
      <text x="106" y="75" text-anchor="middle" font-size="7.5" font-weight="700" fill="#7f1d1d">Kantung empedu menyimpan empedu</text>
      <!-- Output Metabolisme -->
      <rect x="156" y="14" width="112" height="36" rx="6" fill="#ffffff" stroke="#fca5a5"/>
      <text x="212" y="28" text-anchor="middle" font-size="8" font-weight="700" fill="#991b1b">• Glukosa → Glikogen</text>
      <text x="212" y="42" text-anchor="middle" font-size="8" font-weight="700" fill="#991b1b">Pengolahan zat & pembentukan urea</text>
      <!-- Jalur Bawah: Duktus Koledukus -> Emulsifikasi Lemak -->
      <path d="M106 82 L106 112 L152 112" fill="none" stroke="#16a34a" stroke-width="4.5" stroke-linecap="round"/>
      <path d="M106 82 L106 112 L152 112" fill="none" class="mech-flow" stroke="#bbf7d0" stroke-width="2"/>
      <text x="72" y="106" text-anchor="middle" font-size="8" font-weight="700" fill="#15803d">Garam Empedu</text>
      <text x="72" y="117" text-anchor="middle" font-size="7.5" font-weight="600" fill="#166534">→ Duodenum</text>
      <circle cx="174" cy="112" r="14" fill="#facc15" stroke="#ca8a04" stroke-width="1.5"/>
      <text x="174" y="115" text-anchor="middle" font-size="7.5" font-weight="800" fill="#854d0e">Lemak</text>
      <path d="M192 112 L212 112" stroke="#64748b" stroke-width="2"/>
      <g class="mech-pump" style="transform-origin: 236px 112px;">
        <circle cx="228" cy="103" r="5.5" fill="#fde047" stroke="#ca8a04" stroke-width="1.2"/>
        <circle cx="244" cy="105" r="5.5" fill="#fde047" stroke="#ca8a04" stroke-width="1.2"/>
        <circle cx="235" cy="121" r="5.5" fill="#fde047" stroke="#ca8a04" stroke-width="1.2"/>
      </g>
      <text x="236" y="138" text-anchor="middle" font-size="8" font-weight="700" fill="#854d0e">Garam empedu mengemulsikan lemak</text>
    </svg>`
  },
  {
    id: 'stomach',
    color: '#f472b6',
    name: { id: 'Lambung', en: 'Stomach' },
    latin: 'Ventriculus / Gaster',
    iconSvg: `<svg viewBox="0 0 64 54" width="52" height="44">
      <path d="M24 10 C44 8 52 28 38 40 C24 48 14 36 18 22 Z" fill="#f472b6" stroke="#be185d" stroke-width="2"/>
    </svg>`,
    description: {
      id: 'Kantong pencernaan berotot yang pada mencit terbagi menjadi bagian nonglandular (tanpa kelenjar) yang disebut forestomach serta bagian glandular (berkelenjar) yang mencakup corpus dan antrum.',
      en: 'Muscular digestive sac divided in mice into a nonglandular region called the forestomach and a glandular region comprising the corpus and antrum.'
    },
    howItWorks: {
      id: 'Makanan ditampung dari esofagus lalu diremas oleh dinding otot lambung sambil bercampur dengan getah kelenjar dari bagian corpus dan antrum. Asam klorida (HCl) menciptakan suasana asam yang membantu mengaktifkan pepsinogen menjadi enzim pepsin untuk mulai memecah protein.',
      en: 'Food enters from the esophagus and is churned by muscular contractions while mixing with secretions from the glandular corpus and antrum. Hydrochloric acid (HCl) creates an acidic environment that helps activate pepsinogen into pepsin to digest proteins.'
    },
    func: {
      id: 'Menampung dan mengaduk makanan, menciptakan lingkungan asam melalui asam klorida (HCl) untuk aktivasi enzim serta pertahanan awal terhadap mikroorganisme, dan membantu pencernaan protein oleh pepsin.',
      en: 'Stores and mixes food, establishes an acidic environment via hydrochloric acid (HCl) for enzyme activation and microbial defense, and initiates protein digestion via pepsin.'
    },
    location: {
      id: 'Rongga perut bagian kiri atas, berada di bawah diafragma dan di sebelah kiri hati.',
      en: 'Upper-left abdominal cavity, beneath the diaphragm and to the left of the liver.'
    },
    mechanismCaption: {
      id: 'Zona Lambung Mencit: Forestomach (nonglandular) dan Corpus–Antrum (glandular) yang menyekresikan HCl serta pepsinogen → pepsin.',
      en: 'Mouse Stomach Zones: Nonglandular forestomach and glandular corpus–antrum secreting HCl and pepsinogen → pepsin.'
    },
    mechanismSvg: `<svg viewBox="0 0 280 150">
      <rect x="4" y="4" width="272" height="142" rx="8" fill="#fdf2f8"/>
      <!-- Lambung 2 Zona Mencit -->
      <g class="mech-stomach-churn">
        <path d="M68 18 L68 34 C118 28 138 72 108 102 C78 122 52 94 62 56 Z" fill="#f9a8d4" stroke="#be185d" stroke-width="2.5"/>
        <line x1="63" y1="62" x2="118" y2="62" stroke="#9d174d" stroke-width="1.5" stroke-dasharray="4 3"/>
        <text x="90" y="50" text-anchor="middle" font-size="7.5" font-weight="800" fill="#831843">Forestomach</text>
        <text x="90" y="88" text-anchor="middle" font-size="7.5" font-weight="800" fill="#831843">Corpus</text>
      </g>
      <!-- Bolus Bergerak -->
      <circle class="mech-bolus" cx="84" cy="70" r="10" fill="#fbbf24" stroke="#b45309" stroke-width="1.5"/>
      <text x="84" y="73" text-anchor="middle" font-size="6.5" font-weight="800" fill="#78350f">Bolus</text>
      <!-- Panel Reaksi Kimiawi -->
      <rect x="144" y="18" width="124" height="114" rx="8" fill="#ffffff" stroke="#f9a8d4"/>
      <text x="206" y="36" text-anchor="middle" font-size="9" font-weight="800" fill="#9d174d">Kelenjar Corpus & Antrum</text>
      <text x="206" y="54" text-anchor="middle" font-size="8" font-weight="700" fill="#be185d">1. Sel Parietal → HCl (pH 2)</text>
      <text x="206" y="67" text-anchor="middle" font-size="7.5" font-weight="600" fill="#475569">Suasana asam & aktivasi enzim</text>
      <text x="206" y="86" text-anchor="middle" font-size="8" font-weight="700" fill="#be185d">2. Sel Chief → Pepsinogen</text>
      <text x="206" y="99" text-anchor="middle" font-size="7.5" font-weight="600" fill="#475569">HCl + Pepsinogen → Pepsin</text>
      <text x="206" y="118" text-anchor="middle" font-size="8.5" font-weight="800" fill="#0369a1">Pepsin membantu mencerna protein</text>
    </svg>`
  },
  {
    id: 'small_intestine',
    color: '#fbbf24',
    name: { id: 'Usus Halus', en: 'Small Intestine' },
    latin: 'Intestinum tenue',
    iconSvg: `<svg viewBox="0 0 64 54" width="52" height="44">
      <path d="M16 14 C48 12 50 24 16 26 C48 28 48 40 18 42" fill="none" stroke="#fbbf24" stroke-width="7" stroke-linecap="round"/>
      <path d="M16 14 C48 12 50 24 16 26 C48 28 48 40 18 42" fill="none" stroke="#b45309" stroke-width="1.2" stroke-linecap="round"/>
    </svg>`,
    description: {
      id: 'Saluran pencernaan panjang dan berkelok yang terdiri atas tiga bagian utama, yaitu duodenum, jejunum, dan ileum, dengan permukaan dalam berlipat membentuk vili dan mikrovili.',
      en: 'Long, coiled digestive tube consisting of three main segments—duodenum, jejunum, and ileum—lined with folds forming villi and microvilli.'
    },
    howItWorks: {
      id: 'Enzim pencernaan dan empedu memecah makanan menjadi molekul kecil, sementara vili dan mikrovili memperluas bidang penyerapan. Glukosa dan asam amino diserap menuju pembuluh darah, sedangkan sebagian besar lemak rantai panjang dikemas kembali menjadi kilomikron sebelum masuk ke pembuluh limfa (lakteal).',
      en: 'Digestive enzymes and bile break food into absorbable molecules while villi and microvilli expand the absorptive surface area. Glucose and amino acids are absorbed into blood capillaries, whereas most long-chain lipids are packaged into chylomicrons and enter lymphatic vessels (lacteals).'
    },
    func: {
      id: 'Menyelesaikan pencernaan zat gizi dan menyerap hasil pencernaan menuju sistem peredaran darah dan pembuluh limfa.',
      en: 'Completes nutrient digestion and absorbs digested nutrients into the bloodstream and lymphatic system.'
    },
    location: {
      id: 'Mengisi sebagian besar bagian tengah hingga bawah rongga perut (cavum abdominis).',
      en: 'Occupies most of the central and lower regions of the abdominal cavity.'
    },
    mechanismCaption: {
      id: 'Penyerapan di Vili & Mikrovili: Glukosa dan asam amino masuk ke kapiler darah; lemak rantai panjang dikemas menjadi kilomikron menuju pembuluh limfa.',
      en: 'Villi & Microvilli Absorption: Glucose and amino acids enter blood capillaries; long-chain fats are packaged into chylomicrons for lymphatic uptake.'
    },
    mechanismSvg: `<svg viewBox="0 0 280 150">
      <rect x="4" y="4" width="272" height="142" rx="8" fill="#fffbeb"/>
      <!-- Struktur Vili Usus dengan Kapiler & Limfa -->
      <path d="M18 130 L18 52 Q42 18 66 52 L66 115 L84 115 L84 52 Q108 18 132 52 L132 130 Z" fill="#fde68a" stroke="#d97706" stroke-width="2"/>
      <!-- Kapiler Darah & Limfa di dalam Vili -->
      <path d="M32 128 L32 58 Q42 40 52 58 L52 128" fill="none" stroke="#ef4444" stroke-width="3"/>
      <line x1="42" y1="48" x2="42" y2="128" stroke="#16a34a" stroke-width="3.5"/>
      <path d="M98 128 L98 58 Q108 40 118 58 L118 128" fill="none" stroke="#ef4444" stroke-width="3"/>
      <line x1="108" y1="48" x2="108" y2="128" stroke="#16a34a" stroke-width="3.5"/>
      <!-- Partikel Nutrisi Turun -->
      <g class="mech-drop">
        <circle cx="32" cy="18" r="4.5" fill="#ef4444"/>
        <circle cx="42" cy="14" r="4.5" fill="#16a34a"/>
        <circle cx="98" cy="18" r="4.5" fill="#2563eb"/>
        <circle cx="108" cy="14" r="4.5" fill="#16a34a"/>
      </g>
      <!-- Legenda Jalur Penyerapan -->
      <rect x="146" y="18" width="122" height="114" rx="8" fill="#ffffff" stroke="#fcd34d"/>
      <text x="207" y="36" text-anchor="middle" font-size="9" font-weight="800" fill="#b45309">2 Jalur Penyerapan Vili</text>
      <circle cx="158" cy="54" r="4" fill="#ef4444"/>
      <text x="166" y="57" font-size="8" font-weight="700" fill="#991b1b">Kapiler Darah:</text>
      <text x="207" y="70" text-anchor="middle" font-size="7.5" font-weight="600" fill="#475569">Glukosa & Asam Amino</text>
      <circle cx="158" cy="90" r="4" fill="#16a34a"/>
      <text x="166" y="93" font-size="8" font-weight="700" fill="#15803d">Pembuluh Limfa:</text>
      <text x="207" y="106" text-anchor="middle" font-size="7.5" font-weight="600" fill="#475569">Lemak → Kilomikron</text>
      <text x="207" y="124" text-anchor="middle" font-size="7.5" font-weight="800" fill="#b45309">Vili & mikrovili perluas serapan</text>
    </svg>`
  },
  {
    id: 'large_intestine',
    color: '#d97706',
    name: { id: 'Usus Besar & Sekum', en: 'Large Intestine & Cecum' },
    latin: 'Intestinum crassum & Caecum',
    iconSvg: `<svg viewBox="0 0 64 54" width="52" height="44">
      <path d="M18 14 Q12 36 32 40 Q46 42 46 48" fill="none" stroke="#d97706" stroke-width="9" stroke-linecap="round"/>
      <path d="M18 14 Q12 36 32 40 Q46 42 46 48" fill="none" stroke="#fef3c7" stroke-width="1.5" stroke-dasharray="3 4"/>
    </svg>`,
    description: {
      id: 'Bagian akhir saluran pencernaan yang berdiameter lebih lebar daripada usus halus dan memiliki kantong sekum (caecum) yang relatif besar di pangkalnya.',
      en: 'Terminal segment of the digestive tract with a wider diameter than the small intestine, featuring a relatively large cecum at its proximal end.'
    },
    howItWorks: {
      id: 'Sisa makanan yang tidak tercerna masuk ke sekum untuk difermentasi oleh mikroorganisme simbion (menghasilkan asam lemak rantai pendek serta beberapa vitamin seperti vitamin K dan B). Selanjutnya, dinding usus besar menyerap air dan elektrolit sehingga sisa pencernaan memadat membentuk feses dan bergerak menuju rektum.',
      en: 'Undigested food residues enter the cecum for fermentation by symbiotic microorganisms (producing short-chain fatty acids and certain vitamins such as vitamin K and B vitamins). The colon then absorbs water and electrolytes, compacting the remaining material into feces that move toward the rectum.'
    },
    func: {
      id: 'Menyerap kembali air dan elektrolit, menjadi lokasi fermentasi bahan yang tidak tercerna di sekum, serta membentuk dan mendorong feses keluar dari tubuh.',
      en: 'Reabsorbs water and electrolytes, hosts microbial fermentation of undigested material in the cecum, and forms and propels feces for elimination.'
    },
    location: {
      id: 'Rongga perut bagian bawah dan sisi kiri-kanan mengelilingi lipatan usus halus hingga berakhir di rektum.',
      en: 'Lower and lateral abdominal cavity surrounding the coiled small intestine and terminating at the rectum.'
    },
    mechanismCaption: {
      id: 'Proses Sekum & Kolon: Fermentasi mikroorganisme di sekum, penyerapan air dan elektrolit di kolon, serta pembentukan feses.',
      en: 'Cecum & Colon Processes: Microbial fermentation in the cecum, water and electrolyte absorption in the colon, and feces formation.'
    },
    mechanismSvg: `<svg viewBox="0 0 280 150">
      <rect x="4" y="4" width="272" height="142" rx="8" fill="#fff7ed"/>
      <!-- Kantong Sekum + Saluran Kolon -->
      <path d="M46 44 Q18 44 18 76 Q18 106 48 106 L146 106 L146 66 L46 66 Z" fill="#fed7aa" stroke="#c2410c" stroke-width="2.5"/>
      <text x="42" y="88" text-anchor="middle" font-size="8" font-weight="800" fill="#9a3412">Sekum</text>
      <!-- Massa Feses Memadat -->
      <circle class="mech-bolus" cx="88" cy="86" r="12" fill="#9a3412"/>
      <!-- Air & Elektrolit Diserap ke Atas -->
      <g class="mech-co2">
        <circle cx="96" cy="54" r="5" fill="#0284c7"/>
        <circle cx="118" cy="54" r="5" fill="#0ea5e9"/>
        <text x="108" y="34" text-anchor="middle" font-size="8.5" font-weight="800" fill="#0369a1">H₂O + Na⁺ Diserap</text>
      </g>
      <!-- Panel Keterangan -->
      <rect x="160" y="18" width="108" height="114" rx="8" fill="#ffffff" stroke="#fdba74"/>
      <text x="214" y="36" text-anchor="middle" font-size="9" font-weight="800" fill="#9a3412">Proses Kolon & Sekum</text>
      <text x="214" y="54" text-anchor="middle" font-size="7.5" font-weight="700" fill="#c2410c">1. Fermentasi Sekum:</text>
      <text x="214" y="67" text-anchor="middle" font-size="7.5" font-weight="600" fill="#475569">Fermentasi bahan tak tercerna</text>
      <text x="214" y="86" text-anchor="middle" font-size="7.5" font-weight="700" fill="#0369a1">2. Penyerapan Kolon:</text>
      <text x="214" y="99" text-anchor="middle" font-size="7.5" font-weight="600" fill="#475569">Air & elektrolit diserap</text>
      <text x="214" y="118" text-anchor="middle" font-size="8" font-weight="800" fill="#7c2d12">3. Pembentukan Feses</text>
    </svg>`
  },
  {
    id: 'kidneys',
    color: '#991b1b',
    name: { id: 'Ginjal', en: 'Kidneys' },
    latin: 'Ren',
    iconSvg: `<svg viewBox="0 0 64 54" width="52" height="44">
      <ellipse cx="21" cy="27" rx="9" ry="15" fill="#991b1b" stroke="#fca5a5" stroke-width="1.5"/>
      <ellipse cx="43" cy="27" rx="9" ry="15" fill="#991b1b" stroke="#fca5a5" stroke-width="1.5"/>
    </svg>`,
    description: {
      id: 'Sepasang organ ekskresi berbentuk menyerupai biji kacang berwarna merah tua yang tersusun atas tiga bagian utama: korteks di luar, medula di tengah, dan pelvis renalis di bagian dalam.',
      en: 'Paired dark-red bean-shaped excretory organs organized into three main regions: the outer cortex, middle medulla, and inner renal pelvis.'
    },
    howItWorks: {
      id: 'Satuan kerja nefron menyaring darah di glomerulus (filtrasi), menyerap kembali air, glukosa, dan zat berguna di sepanjang segmen tubulus tertentu (reabsorpsi), serta menambahkan zat sisa dari darah ke cairan tubulus pada beberapa segmen tubulus (sekresi tubulus) hingga terbentuk urine yang mengalir ke pelvis renalis dan ureter.',
      en: 'Nephron units filter blood at the glomerulus (filtration), reclaim water, glucose, and useful solutes along specific tubular segments (reabsorption), and transport additional wastes from blood into the filtrate across multiple tubular segments (tubular secretion) to form urine draining into the renal pelvis and ureter.'
    },
    func: {
      id: 'Mengeluarkan zat sisa metabolisme dalam bentuk urine serta mengatur keseimbangan air dan elektrolit dalam tubuh.',
      en: 'Eliminates metabolic waste products as urine and regulates water and electrolyte balance in the body.'
    },
    location: {
      id: 'Dinding belakang (dorsal) rongga perut di sisi kanan dan kiri tulang belakang.',
      en: 'Dorsal wall of the abdominal cavity flanking the vertebral column on the right and left sides.'
    },
    mechanismCaption: {
      id: '3 Proses Nefron: (1) Filtrasi di glomerulus, (2) Reabsorpsi di segmen tubulus, (3) Sekresi tubulus menuju pelvis renalis.',
      en: '3 Nephron Processes: (1) Filtration at glomerulus, (2) Reabsorption along tubule segments, (3) Tubular secretion toward renal pelvis.'
    },
    mechanismSvg: `<svg viewBox="0 0 280 150">
      <rect x="4" y="4" width="272" height="142" rx="8" fill="#fef2f2"/>
      <!-- Kapsula Bowman + Glomerulus + Tubulus Kontortus + Lengkung Henle -->
      <path d="M58 26 C26 26 26 76 58 76 L88 76 L98 124 L112 124 L122 66 L146 66 L146 132" fill="none" stroke="#f59e0b" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="58" cy="51" r="15" fill="#dc2626" stroke="#7f1d1d" stroke-width="2"/>
      <text x="58" y="54" text-anchor="middle" font-size="6.5" font-weight="800" fill="#fff">Glomerulus</text>
      <!-- Tetesan Filtrat & Urine -->
      <g class="mech-drop">
        <circle cx="76" cy="56" r="4" fill="#eab308"/>
        <circle cx="105" cy="96" r="4" fill="#ca8a04"/>
        <circle cx="146" cy="98" r="4.5" fill="#eab308"/>
      </g>
      <text x="105" y="138" text-anchor="middle" font-size="7.5" font-weight="700" fill="#92400e">Lengkung Henle</text>
      <!-- Panel 3 Tahap -->
      <rect x="160" y="16" width="108" height="118" rx="8" fill="#ffffff" stroke="#fca5a5"/>
      <text x="214" y="34" text-anchor="middle" font-size="9" font-weight="800" fill="#991b1b">3 Tahap Nefron</text>
      <text x="214" y="52" text-anchor="middle" font-size="7.5" font-weight="700" fill="#b91c1c">1. Filtrasi (Glomerulus)</text>
      <text x="214" y="64" text-anchor="middle" font-size="7" font-weight="600" fill="#475569">Hasilkan Urine Primer</text>
      <text x="214" y="81" text-anchor="middle" font-size="7.5" font-weight="700" fill="#0369a1">2. Reabsorpsi (Tubulus)</text>
      <text x="214" y="93" text-anchor="middle" font-size="7" font-weight="600" fill="#475569">Serap Glukosa & H₂O</text>
      <text x="214" y="110" text-anchor="middle" font-size="7.5" font-weight="700" fill="#15803d">3. Sekresi tubulus</text>
      <text x="214" y="122" text-anchor="middle" font-size="7" font-weight="600" fill="#475569">Zat sisa & keseimbangan air</text>
    </svg>`
  },
  {
    id: 'reproductive',
    color: '#f43f5e',
    name: { id: 'Sistem Reproduksi', en: 'Reproductive System' },
    latin: 'Systema genitale',
    iconSvg: `<svg viewBox="0 0 64 54" width="52" height="44">
      <path d="M32 46 L32 32 Q18 22 14 12 M32 32 Q46 22 50 12" fill="none" stroke="#f472b6" stroke-width="5" stroke-linecap="round"/>
      <circle cx="13" cy="10" r="4" fill="#e11d48"/>
      <circle cx="51" cy="10" r="4" fill="#e11d48"/>
    </svg>`,
    description: { id: '', en: '' },
    howItWorks: { id: '', en: '' },
    func: { id: '', en: '' },
    location: { id: '', en: '' },
    mechanismCaption: { id: '', en: '' },
    mechanismSvg: ''
  }
];

;

const REPRODUCTIVE_BY_SEX = {
  male: {
    id: 'reproductive',
    color: '#0284c7',
    name: { id: 'Sistem Reproduksi Jantan', en: 'Male Reproductive System' },
    latin: 'Testis, Epididymis, Ductus deferens & Glandulae accessoriae',
    iconSvg: `<svg viewBox="0 0 64 54" width="52" height="44">
      <!-- Vesikula Seminalis Melengkung -->
      <path d="M30 22 C20 18 14 10 17 5 C20 2 26 6 28 13 Z" fill="#fef3c7" stroke="#d97706" stroke-width="1.3"/>
      <path d="M34 22 C44 18 50 10 47 5 C44 2 38 6 36 13 Z" fill="#fef3c7" stroke="#d97706" stroke-width="1.3"/>
      <!-- Vas Deferens & Uretra -->
      <path d="M21 36 Q20 26 30 23 M43 36 Q44 26 34 23 M32 23 L32 48" fill="none" stroke="#f472b6" stroke-width="2.2" stroke-linecap="round"/>
      <!-- Sepasang Testis & Epididimis -->
      <ellipse cx="20" cy="40" rx="6.5" ry="9" fill="#fb7185" stroke="#9f1239" stroke-width="1.5"/>
      <ellipse cx="44" cy="40" rx="6.5" ry="9" fill="#fb7185" stroke="#9f1239" stroke-width="1.5"/>
      <path d="M14 33 C11 37 11 44 16 48 M50 33 C53 37 53 44 48 48" fill="none" stroke="#fda4af" stroke-width="2.4" stroke-linecap="round"/>
    </svg>`,
    description: {
      id: 'Tersusun atas sepasang (2 buah) testis berbentuk oval yang didampingi epididimis (kaput, korpus, kauda), saluran vas deferens, uretra pelvis, serta kelenjar aksesori khas mencit: vesikula seminalis berpasangan yang melengkung besar seperti tanduk domba, kelenjar koagulasi (prostat anterior), dan lobus prostat.',
      en: 'Consists of a single pair (2) of oval testes accompanied by the epididymis (caput, corpus, cauda), vas deferens, pelvic urethra, and prominent murine accessory glands: large curved paired seminal vesicles, coagulating glands (anterior prostate), and prostate lobes.'
    },
    howItWorks: {
      id: 'FSH merangsang spermatogenesis di tubulus seminiferus testis, sedangkan LH merangsang sel Leydig menghasilkan testosteron. Spermatozoa dimatangkan motilitasnya di epididimis, lalu dialirkan melalui vas deferens menuju uretra pelvis sambil bercampur dengan sekret fruktosa dari vesikula seminalis serta enzim kelenjar koagulasi & prostat pembentuk sumbat kopulasi.',
      en: 'FSH stimulates spermatogenesis in the testicular seminiferous tubules while LH drives Leydig cells to secrete testosterone. Sperm mature in the epididymis and travel via the vas deferens into the pelvic urethra, mixing with seminal vesicle fluid and coagulating/prostate gland secretions.'
    },
    func: {
      id: 'Menghasilkan sel gamet jantan (spermatozoa haploid), menyekresikan hormon androgen (testosteron) yang mengatur ciri kelamin sekunder (seperti jarak anogenital panjang), serta memproduksi cairan semen nutrisi dan pembentuk sumbat kopulasi.',
      en: 'Produces male gametes (haploid spermatozoa), secretes testosterone governing male secondary traits (such as longer anogenital distance), and produces seminal fluid and copulatory plug components.'
    },
    location: {
      id: 'Sepasang testis berada di dalam kantong skrotum regio inguinal/perineal (dapat tertarik ke rongga abdomen kaudal karena kanalis inguinalis mencit tetap terbuka), sedangkan vesikula seminalis, kelenjar koagulasi, dan prostat berada di rongga pelvis dorsal terhadap kandung kemih.',
      en: 'Paired testes reside within the inguinal/perineal scrotal sacs (retractable into the caudal abdomen due to open inguinal canals), while seminal vesicles, coagulating glands, and prostate sit in the pelvic cavity dorsal to the urinary bladder.'
    },
    mechanismCaption: {
      id: 'Jalur Reproduksi Jantan: (1) Spermatogenesis di Testis → (2) Pematangan di Epididimis → (3) Transpor Vas Deferens + Sekret Vesikula Seminalis & Prostat ke Uretra.',
      en: 'Male Reproductive Pathway: (1) Spermatogenesis in Testes → (2) Maturation in Epididymis → (3) Vas Deferens Transport + Seminal Vesicle & Prostate Secretions to Urethra.'
    },
    mechanismSvg: `<svg viewBox="0 0 280 150">
      <rect x="4" y="4" width="272" height="142" rx="8" fill="#f0f9ff"/>
      <!-- Vesikula Seminalis & Prostat -->
      <path d="M74 62 C56 56 44 38 49 26 C53 18 64 23 68 35 Z" fill="#fef3c7" stroke="#d97706" stroke-width="1.6"/>
      <path d="M84 62 C102 56 114 38 109 26 C105 18 94 23 90 35 Z" fill="#fef3c7" stroke="#d97706" stroke-width="1.6"/>
      <ellipse cx="79" cy="67" rx="11" ry="6" fill="#fdba74" stroke="#c2410c" stroke-width="1.4"/>
      <text x="79" y="17" text-anchor="middle" font-size="7.5" font-weight="800" fill="#b45309">Vesikula Seminalis & Prostat</text>
      <!-- Vas Deferens & Uretra -->
      <path d="M52 98 Q50 76 74 67" fill="none" stroke="#0284c7" stroke-width="2.5" stroke-linecap="round"/>
      <path d="M106 98 Q108 76 84 67" fill="none" stroke="#0284c7" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="79" y1="73" x2="79" y2="132" stroke="#e11d48" stroke-width="4" stroke-linecap="round"/>
      <text x="98" y="128" font-size="7.5" font-weight="800" fill="#9f1239">Uretra</text>
      <!-- Sepasang Testis & Epididimis -->
      <ellipse cx="48" cy="108" rx="12" ry="16" fill="#fb7185" stroke="#9f1239" stroke-width="1.8"/>
      <ellipse cx="110" cy="108" rx="12" ry="16" fill="#fb7185" stroke="#9f1239" stroke-width="1.8"/>
      <path d="M38 95 C32 102 32 115 41 122" fill="none" stroke="#fda4af" stroke-width="3.5" stroke-linecap="round"/>
      <path d="M120 95 C126 102 126 115 117 122" fill="none" stroke="#fda4af" stroke-width="3.5" stroke-linecap="round"/>
      <text x="48" y="136" text-anchor="middle" font-size="7.5" font-weight="800" fill="#881337">Testis Ki</text>
      <text x="110" y="136" text-anchor="middle" font-size="7.5" font-weight="800" fill="#881337">Testis Ka</text>
      <!-- Spermatozoa Bergerak -->
      <g class="mech-gamete">
        <circle cx="54" cy="86" r="4" fill="#0284c7" stroke="#ffffff" stroke-width="1"/>
      </g>
      <!-- Panel Tahapan Jantan -->
      <rect x="148" y="14" width="122" height="122" rx="8" fill="#ffffff" stroke="#7dd3fc"/>
      <text x="209" y="31" text-anchor="middle" font-size="8.5" font-weight="800" fill="#0369a1">Fisiologi Jantan</text>
      <text x="209" y="48" text-anchor="middle" font-size="7.5" font-weight="700" fill="#be123c">1. Testis (FSH & LH):</text>
      <text x="209" y="60" text-anchor="middle" font-size="7" font-weight="600" fill="#475569">Spermatogenesis & Testosteron</text>
      <text x="209" y="77" text-anchor="middle" font-size="7.5" font-weight="700" fill="#0369a1">2. Epididimis & Vas Deferens:</text>
      <text x="209" y="89" text-anchor="middle" font-size="7" font-weight="600" fill="#475569">Pematangan & Transpor Sperma</text>
      <text x="209" y="106" text-anchor="middle" font-size="7.5" font-weight="700" fill="#b45309">3. Kelenjar Aksesori:</text>
      <text x="209" y="118" text-anchor="middle" font-size="7" font-weight="600" fill="#475569">Semen & Sumbat Kopulasi</text>
    </svg>`
  },
  female: {
    id: 'reproductive',
    color: '#e11d48',
    name: { id: 'Sistem Reproduksi Betina', en: 'Female Reproductive System' },
    latin: 'Ovarium, Oviductus, Uterus bicornis, Cervix & Vagina',
    iconSvg: `<svg viewBox="0 0 64 54" width="52" height="44">
      <path d="M32 46 L32 32 Q18 22 14 12 M32 32 Q46 22 50 12" fill="none" stroke="#f472b6" stroke-width="5" stroke-linecap="round"/>
      <circle cx="13" cy="10" r="4.2" fill="#e11d48"/>
      <circle cx="51" cy="10" r="4.2" fill="#e11d48"/>
      <line x1="28" y1="35" x2="36" y2="35" stroke="#9d174d" stroke-width="2"/>
    </svg>`,
    description: {
      id: 'Tersusun atas sepasang ovarium kecil di dekat kutub kaudal ginjal, oviduk (tuba uterina) yang berkelok halus, uterus bikornuata (uterus bicornis) bercabang dua tanduk panjang berbentuk huruf Y, serviks, vagina, serta didukung 5 pasang kelenjar mammae ventral untuk menyusui.',
      en: 'Consists of paired small ovaries near the caudal renal poles, finely coiled oviducts (uterine tubes), a Y-shaped bicornuate uterus (uterus bicornis) with two elongated uterine horns, cervix, vagina, and 5 pairs of ventral mammary glands for lactation.'
    },
    howItWorks: {
      id: 'Berlangsung dalam siklus estrus 4–5 hari di bawah kendali FSH dan LH. Folikel ovarium matang menyekresikan estrogen, diikuti ovulasi oosit ke oviduk sebagai tempat fertilisasi. Zigot berkembang menjadi blastokista dan berimplantasi di sepanjang kedua tanduk uterus bikornuata (masa kebuntingan ±19–21 hari), sementara progesteron dan prolaktin menyiapkan laktasi pada 5 pasang kelenjar mammae.',
      en: 'Operates on a 4–5 day estrous cycle regulated by FSH and LH. Maturing ovarian follicles secrete estrogen, followed by ovulation into the coiled oviduct where fertilization occurs. Embryos implant along both uterine horns (±19–21 days gestation), while progesterone and prolactin prepare the 5 pairs of mammary glands for lactation.'
    },
    func: {
      id: 'Menghasilkan sel gamet betina (ovum haploid), menyekresikan hormon steroid estrogen dan progesteron, menjadi tempat fertilisasi di oviduk, serta menampung perkembangan banyak embrio sekaligus di kedua tanduk uterus.',
      en: 'Produces female gametes (haploid ova), secretes estrogen and progesterone, provides the site for fertilization in the oviduct, and supports multifetal gestation across both uterine horns.'
    },
    location: {
      id: 'Rongga perut bagian kaudal hingga rongga pelvis di dorsal kandung kemih; kedua tanduk uterus memanjang ke arah kranial-lateral menuju kutub kaudal ginjal kiri dan kanan, sedangkan 5 pasang kelenjar mammae tersebar di jaringan subkutan ventral toraks–abdomen.',
      en: 'Caudal abdominal to pelvic cavity dorsal to the urinary bladder; both uterine horns extend craniolaterally toward the caudal poles of the left and right kidneys, while 5 pairs of mammary glands lie subcutaneously along the ventral thorax and abdomen.'
    },
    mechanismCaption: {
      id: 'Jalur Reproduksi Betina: (1) Ovulasi di Ovarium → (2) Fertilisasi di Oviduk → (3) Implantasi Embrio di Uterus Bikornuata → Serviks & Vagina.',
      en: 'Female Reproductive Pathway: (1) Ovulation in Ovary → (2) Fertilization in Oviduct → (3) Embryo Implantation in Bicornuate Uterus → Cervix & Vagina.'
    },
    mechanismSvg: `<svg viewBox="0 0 280 150">
      <rect x="4" y="4" width="272" height="142" rx="8" fill="#fff1f2"/>
      <!-- Uterus Bikornuata, Serviks, Vagina & Ovarium -->
      <path d="M84 130 L84 88 Q44 66 34 36 M84 88 Q124 66 134 36" fill="none" stroke="#f472b6" stroke-width="8.5" stroke-linecap="round"/>
      <line x1="76" y1="96" x2="92" y2="96" stroke="#9d174d" stroke-width="2.5"/>
      <text x="108" y="100" font-size="7" font-weight="800" fill="#9d174d">Serviks</text>
      <text x="108" y="124" font-size="7" font-weight="800" fill="#881337">Vagina</text>
      <circle cx="30" cy="29" r="7.5" fill="#e11d48" stroke="#881337" stroke-width="1.5"/>
      <circle cx="138" cy="29" r="7.5" fill="#e11d48" stroke="#881337" stroke-width="1.5"/>
      <text x="30" y="16" text-anchor="middle" font-size="7.5" font-weight="800" fill="#9f1239">Ovarium</text>
      <text x="138" y="16" text-anchor="middle" font-size="7.5" font-weight="800" fill="#9f1239">Ovarium</text>
      <!-- Titik Implantasi pada Tanduk Uterus -->
      <circle cx="52" cy="64" r="3.2" fill="#fde047" stroke="#b45309" stroke-width="1"/>
      <circle cx="116" cy="64" r="3.2" fill="#fde047" stroke="#b45309" stroke-width="1"/>
      <!-- Ovum Bergerak di Oviduk -->
      <g class="mech-gamete">
        <circle cx="38" cy="40" r="4" fill="#facc15" stroke="#ca8a04" stroke-width="1.2"/>
      </g>
      <!-- Panel Tahapan Betina -->
      <rect x="154" y="14" width="116" height="122" rx="8" fill="#ffffff" stroke="#fda4af"/>
      <text x="212" y="31" text-anchor="middle" font-size="8.5" font-weight="800" fill="#be123c">Fisiologi Betina</text>
      <text x="212" y="48" text-anchor="middle" font-size="7.5" font-weight="700" fill="#9f1239">1. Ovarium & Oviduk:</text>
      <text x="212" y="60" text-anchor="middle" font-size="7" font-weight="600" fill="#475569">Siklus Estrus 4–5 Hari & Fertilisasi</text>
      <text x="212" y="77" text-anchor="middle" font-size="7.5" font-weight="700" fill="#be123c">2. Uterus Bikornuata:</text>
      <text x="212" y="89" text-anchor="middle" font-size="7" font-weight="600" fill="#475569">Implantasi di 2 Tanduk Rahim</text>
      <text x="212" y="106" text-anchor="middle" font-size="7.5" font-weight="700" fill="#0369a1">3. Gestasi & Mammae:</text>
      <text x="212" y="118" text-anchor="middle" font-size="7" font-weight="600" fill="#475569">Bunting 19–21 Hari & Laktasi</text>
    </svg>`
  }
};

function getOrganData(orgId) {
  if (orgId === 'reproductive') {
    const activeSex = (STATE.selectedSpecimen && STATE.selectedSpecimen.sex)
      ? STATE.selectedSpecimen.sex
      : STATE.sex;
    return activeSex === 'male' ? REPRODUCTIVE_BY_SEX.male : REPRODUCTIVE_BY_SEX.female;
  }
  return ORGANS.find(o => o.id === orgId);
}

/*
  STEP FLOW:
  1: Pin 4 paws (pins)
  2: Full top-to-bottom skin cut (scalpel)
  3: Retract skin flaps (forceps)
  4: Pin retracted skin flaps (pins)
  5: Full top-to-bottom muscle cut (scissors)
  6: Retract muscle flaps (forceps)
  7: Organ exploration & transfer to white box (forceps) + option to suture
  8: Simple Interrupted Muscle Suturing (Absorbable 5-0 / 6-0, 5 stitches, short tail 1-2 mm)
  9: Simple Interrupted Skin Suturing (Non-absorbable 4-0 / 5-0 Nylon/Polypropylene, 6 stitches, 3-5mm spacing, 3-4mm tails, slight eversion)
  10: Dissection & Suturing Complete
*/

/* === MODUL PENYIMPANAN OTOMATIS & VALIDASI SESI (TAHAP 5) === */
const PRACTICUM_STORAGE = {
  KEY: 'biolab_mouse_dissection_session_v1',
  SCHEMA_VERSION: 1,
  DEBOUNCE_MS: 450,
  available: false,
  isRestoring: false,
  saveTimer: null
};

function updateStorageStatusBadge(status, detailMsg) {
  const badge = document.getElementById('storage-status-badge');
  const textEl = document.getElementById('storage-status-text');
  if (!badge || !textEl) return;

  badge.classList.remove('status-saved', 'status-saving', 'status-unavailable');

  if (status === 'saving') {
    badge.classList.add('status-saving');
    textEl.textContent = 'Menyimpan...';
    badge.title = detailMsg || 'Menyimpan perkembangan praktikum di peramban...';
  } else if (status === 'saved') {
    badge.classList.add('status-saved');
    textEl.textContent = 'Tersimpan';
    badge.title = detailMsg || 'Sesi praktikum tersimpan otomatis di peramban.';
  } else {
    badge.classList.add('status-unavailable');
    textEl.textContent = 'Tidak tersimpan';
    badge.title = detailMsg || 'Penyimpanan otomatis diblokir atau tidak tersedia pada peramban ini.';
  }
}

function checkLocalStorageAvailability() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      PRACTICUM_STORAGE.available = false;
      updateStorageStatusBadge('unavailable');
      return false;
    }
    const probeKey = '__biolab_storage_probe__';
    window.localStorage.setItem(probeKey, '1');
    const val = window.localStorage.getItem(probeKey);
    window.localStorage.removeItem(probeKey);
    PRACTICUM_STORAGE.available = (val === '1');
    updateStorageStatusBadge(PRACTICUM_STORAGE.available ? 'saved' : 'unavailable');
    return PRACTICUM_STORAGE.available;
  } catch (err) {
    PRACTICUM_STORAGE.available = false;
    updateStorageStatusBadge('unavailable', 'Penyimpanan diblokir oleh kebijakan browser / iframe.');
    return false;
  }
}

function buildSerializableSessionPayload() {
  const activeSex = (STATE.selectedSpecimen && STATE.selectedSpecimen.sex)
    ? STATE.selectedSpecimen.sex
    : STATE.sex;

  return {
    schemaVersion: PRACTICUM_STORAGE.SCHEMA_VERSION,
    savedAt: Date.now(),
    data: {
      lang: STATE.lang === 'en' ? 'en' : 'id',
      sex: activeSex === 'male' ? 'male' : 'female',
      step: Number.isInteger(STATE.step) ? STATE.step : 0,
      activeTool: typeof STATE.activeTool === 'string' ? STATE.activeTool : 'chloroform',
      anesthesiaProgress: Number(STATE.anesthesiaProgress) || 0,
      anesthetized: Boolean(STATE.anesthetized),
      cageCapacity: Number(STATE.cageCapacity) || 10,
      cageSpecimens: Array.isArray(STATE.cageSpecimens)
        ? STATE.cageSpecimens.map(s => ({
            id: String(s.id),
            index: Number(s.index),
            sex: s.sex === 'male' ? 'male' : 'female',
            color: String(s.color || '#f8fafc')
          }))
        : [],
      selectedSpecimen: STATE.selectedSpecimen && typeof STATE.selectedSpecimen === 'object'
        ? {
            id: String(STATE.selectedSpecimen.id),
            index: Number(STATE.selectedSpecimen.index),
            sex: STATE.selectedSpecimen.sex === 'male' ? 'male' : 'female'
          }
        : null,
      pins: {
        fl: Boolean(STATE.pins.fl),
        fr: Boolean(STATE.pins.fr),
        bl: Boolean(STATE.pins.bl),
        br: Boolean(STATE.pins.br),
        sl: Boolean(STATE.pins.sl),
        sr: Boolean(STATE.pins.sr)
      },
      skinCutProgress: Number(STATE.skinCutProgress) || 0,
      skinCut: Boolean(STATE.skinCut),
      skinRetracted: {
        left: Boolean(STATE.skinRetracted.left),
        right: Boolean(STATE.skinRetracted.right)
      },
      skinClosed: {
        left: Boolean(STATE.skinClosed.left),
        right: Boolean(STATE.skinClosed.right)
      },
      muscleCutProgress: Number(STATE.muscleCutProgress) || 0,
      muscleCut: Boolean(STATE.muscleCut),
      muscleRetracted: {
        left: Boolean(STATE.muscleRetracted.left),
        right: Boolean(STATE.muscleRetracted.right)
      },
      muscleClosed: {
        left: Boolean(STATE.muscleClosed.left),
        right: Boolean(STATE.muscleClosed.right)
      },
      intestineShifted: Boolean(STATE.intestineShifted),
      extractedOrgans: Array.isArray(STATE.extractedOrgans) ? [...STATE.extractedOrgans] : [],
      sutureModeActive: Boolean(STATE.sutureModeActive),
      inspectionOnlyMode: Boolean(STATE.inspectionOnlyMode),
      muscleStitches: Array.isArray(STATE.muscleStitches) && STATE.muscleStitches.length === 5
        ? STATE.muscleStitches.map(Boolean)
        : [false, false, false, false, false],
      skinStitches: Array.isArray(STATE.skinStitches) && STATE.skinStitches.length === 6
        ? STATE.skinStitches.map(Boolean)
        : [false, false, false, false, false, false]
    }
  };
}

function saveSessionNow() {
  if (PRACTICUM_STORAGE.isRestoring) return false;
  if (!PRACTICUM_STORAGE.available && !checkLocalStorageAvailability()) {
    updateStorageStatusBadge('unavailable');
    return false;
  }

  try {
    const payload = buildSerializableSessionPayload();
    window.localStorage.setItem(PRACTICUM_STORAGE.KEY, JSON.stringify(payload));
    updateStorageStatusBadge('saved');
    return true;
  } catch (err) {
    PRACTICUM_STORAGE.available = false;
    updateStorageStatusBadge('unavailable', 'Gagal menyimpan sesi ke localStorage.');
    return false;
  }
}

function scheduleAutoSave() {
  if (PRACTICUM_STORAGE.isRestoring) return;
  if (!PRACTICUM_STORAGE.available) {
    updateStorageStatusBadge('unavailable');
    return;
  }

  updateStorageStatusBadge('saving');
  clearTimeout(PRACTICUM_STORAGE.saveTimer);
  PRACTICUM_STORAGE.saveTimer = setTimeout(() => {
    saveSessionNow();
  }, PRACTICUM_STORAGE.DEBOUNCE_MS);
}

function clearSavedSession() {
  clearTimeout(PRACTICUM_STORAGE.saveTimer);
  PRACTICUM_STORAGE.saveTimer = null;
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem(PRACTICUM_STORAGE.KEY);
    }
    if (PRACTICUM_STORAGE.available) {
      updateStorageStatusBadge('saved');
    }
  } catch (err) {
    PRACTICUM_STORAGE.available = false;
    updateStorageStatusBadge('unavailable');
  }
}

function validateAndReadSavedSession() {
  if (!checkLocalStorageAvailability()) {
    return { status: 'unavailable', data: null };
  }

  let raw = null;
  try {
    raw = window.localStorage.getItem(PRACTICUM_STORAGE.KEY);
  } catch (err) {
    PRACTICUM_STORAGE.available = false;
    updateStorageStatusBadge('unavailable');
    return { status: 'unavailable', data: null };
  }

  if (!raw) {
    return { status: 'empty', data: null };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { status: 'corrupt', data: null };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { status: 'corrupt', data: null };
  }

  if (parsed.schemaVersion !== PRACTICUM_STORAGE.SCHEMA_VERSION) {
    return { status: 'version_mismatch', data: null };
  }

  const d = parsed.data;
  if (!d || typeof d !== 'object') {
    return { status: 'corrupt', data: null };
  }

  const validStep = Number.isInteger(d.step) && d.step >= 0 && d.step <= 13;
  const validSex = d.sex === 'male' || d.sex === 'female';
  const validPins = d.pins && typeof d.pins === 'object';
  const validArrays = Array.isArray(d.extractedOrgans)
    && Array.isArray(d.muscleStitches) && d.muscleStitches.length === 5
    && Array.isArray(d.skinStitches) && d.skinStitches.length === 6;

  if (!validStep || !validSex || !validPins || !validArrays) {
    return { status: 'corrupt', data: null };
  }

  if (d.selectedSpecimen !== null) {
    if (
      typeof d.selectedSpecimen !== 'object' ||
      !d.selectedSpecimen.id ||
      (d.selectedSpecimen.sex !== 'male' && d.selectedSpecimen.sex !== 'female')
    ) {
      return { status: 'corrupt', data: null };
    }
  }

  return { status: 'valid', data: d };
}

const STATE = {
  lang: 'id',
  sex: 'female',
  step: 0, // 0: Anesthesia, 1: Paw Pins, 2: Skin Cut, 3: Retract Skin, 4: Pin Skin Flaps, 5: Muscle Cut, 6: Retract Muscle, 7: Organ Inspection, 8: Close Muscle (Forceps), 9: Suture Muscle, 10: Remove Skin Pins, 11: Close Skin (Forceps), 12: Suture Skin, 13: Complete
  activeTool: 'chloroform',
 anesthesiaProgress: 0,
  anesthetized: false,
  cageCapacity: 10,
  cageSpecimens: [],
  selectedSpecimen: null,
  cageLocked: false,
  pins: { fl: false, fr: false, bl: false, br: false, sl: false, sr: false },
  skinCutProgress: 0,
  skinCut: false,
  skinRetracted: { left: false, right: false },
  skinClosed: { left: false, right: false },
  muscleCutProgress: 0,
  muscleCut: false,
  muscleRetracted: { left: false, right: false },
  muscleClosed: { left: false, right: false },
  intestineShifted: false,
  extractedOrgans: [],
  popupOrganId: null,
  sutureModeActive: false,
  inspectionOnlyMode: false,
  muscleStitches: [false, false, false, false, false], // 5 simple interrupted absorbable stitches
  skinStitches: [false, false, false, false, false, false], // 6 simple interrupted non-absorbable stitches
  zoom: 1,
  drag: {
    active: false,
    mode: null,
    startX: 0,
    startY: 0,
    moved: false,
    organId: null,
    incisionStartedTop: false,
    incisionMaxY: 155
  }
};

const I18N = {
  id: {
    title: 'Simulasi Pembedahan & Anatomi Mencit (<em>Mus musculus</em>)',
    leftTitle: 'Daftar Alat Bedah',
    rightTitle: 'Wadah Organ',
    boxHint: 'Seret organ menggunakan <strong>Pinset</strong> ke kotak putih ini, lalu klik gambar organ untuk melihat atau menutup penjelasannya.',
    tts: '🔊 Dengarkan',
    guide: 'Panduan',
    shiftBtn: 'Geser Usus',
    sutureBtn: 'Jahit Mencit',
    finishBtn: 'Selesai & Lepas Jarum',
    stepPrefix: 'TAHAP',
    instructionLabel: 'Instruksi:',
    tools: {
      chloroform: ['Kapas Kloroform', 'Bius hidung mencit hingga pingsan'],
      pins: ['Jarum Pentul', 'Tahan kaki & lipatan kulit'],
      scalpel: ['Skalpel', 'Sayat kulit penuh atas → bawah'],
      scissors: ['Gunting Bedah', 'Sayat otot penuh atas → bawah'],
      forceps: ['Pinset', 'Buka/tutup lapisan & angkat organ'],
      suture_abs: ['Benang Jahit Serap (5-0/6-0)', 'Jahit tunggal terputus lapisan otot'],
      suture_nonabs: ['Benang Jahit Tidak Serap (4-0/5-0)', 'Nylon/Polypropylene untuk kulit']
    },
    steps: [
      {
        num: 0,
        name: 'Pembiusan Mencit',
        desc: 'Menidurkan mencit menggunakan kapas kloroform.',
        instruction: 'Pilih Kapas Kloroform, lalu tempelkan dan tahan pada area hidung mencit hingga tertidur (100%).'
      },
      {
        num: 1,
        name: 'Posisi Model',
        desc: 'Menahan posisi keempat kaki mencit.',
        instruction: 'Pilih Jarum Pentul, lalu taruh pada 4 titik telapak kaki mencit.'
      },
      {
        num: 2,
        name: 'Struktur Kulit',
        desc: 'Membuka lapisan kulit terluar mencit.',
        instruction: 'Pilih Skalpel, lalu tarik garis dari titik atas ke titik bawah pada garis panduan kulit.'
      },
      {
        num: 3,
        name: 'Lapisan di Bawah Kulit',
        desc: 'Membuka lipatan kulit ke samping.',
        instruction: 'Pilih Pinset, lalu tarik lipatan kulit kiri dan kanan ke arah luar.'
      },
      {
        num: 4,
        name: 'Posisi Lapisan Kulit',
        desc: 'Menahan lipatan kulit agar tetap terbuka.',
        instruction: 'Pilih Jarum Pentul, lalu sematkan pada lipatan kulit kiri dan kanan.'
      },
      {
        num: 5,
        name: 'Struktur Otot',
        desc: 'Membuka lapisan otot dinding perut.',
        instruction: 'Pilih Gunting Bedah, lalu tarik dari titik atas ke titik bawah pada garis lapisan otot.'
      },
      {
        num: 6,
        name: 'Rongga Perut',
        desc: 'Membuka dinding otot untuk melihat rongga perut.',
        instruction: 'Pilih Pinset, lalu tarik dinding otot kiri dan kanan ke samping.'
      },
      {
        num: 7,
        name: 'Pengamatan Organ',
        desc: 'Mengamati susunan dan letak organ dalam rongga perut.',
        instruction: 'Pindahkan organ menggunakan Pinset ke kotak putih di kanan untuk melihat penjelasannya, atau tekan Jahit Mencit.'
      },
      {
        num: 8,
        name: 'Lapisan Otot',
        desc: 'Merapatkan kembali dinding otot perut.',
        instruction: 'Pilih Pinset, lalu rapatkan kembali dinding otot kiri dan kanan ke garis tengah.'
      },
      {
        num: 9,
        name: 'Penutupan Lapisan Otot',
        desc: 'Menutup lapisan otot dengan benang jahit serap.',
        instruction: 'Pilih Benang Jahit Serap (5-0/6-0), lalu klik pada 5 titik garis tengah lapisan otot.'
      },
      {
        num: 10,
        name: 'Penanda Lapisan Kulit',
        desc: 'Melepas jarum pentul pada lipatan kulit.',
        instruction: 'Pilih Jarum Pentul atau Pinset, lalu lepas 2 jarum pentul pada lipatan kulit kiri dan kanan.'
      },
      {
        num: 11,
        name: 'Posisi Lapisan Kulit',
        desc: 'Merapatkan kembali lapisan kulit terluar.',
        instruction: 'Pilih Pinset, lalu rapatkan kembali lipatan kulit kiri dan kanan ke garis tengah.'
      },
      {
        num: 12,
        name: 'Penutupan Lapisan Kulit',
        desc: 'Menutup lapisan kulit dengan benang jahit tidak serap.',
        instruction: 'Pilih Benang Jahit Tidak Serap (4-0/5-0), lalu klik pada 6 titik garis tengah lapisan kulit.'
      },
      {
        num: 13,
        name: 'Simulasi Selesai',
        desc: 'Menyelesaikan seluruh tahapan simulasi anatomi mencit.',
        instruction: 'Semua lapisan telah ditutup; tekan tombol Selesai & Lepas Jarum untuk melihat ringkasan hasil.'
      }
    ],
    fields: {
      name: '1. Nama Organ (Indonesia / Inggris / Latin)',
      desc: '2. Deskripsi Organ',
      work: '3. Cara Kerja',
      func: '4. Fungsi',
      loc: '5. Letak Organ',
      mech: '6. Gambar Cara Kerja',
      emptySlot: 'Wadah Kosong'
    },
	
	closing: {
      badge: 'SIMULASI PEMBELAJARAN SELESAI • 100% TUNTAS',
      title: 'Selamat! Anda telah menyelesaikan simulasi pembelajaran anatomi mencit (<em>Mus musculus</em>).',
      subtitle: 'Selamat! Anda telah menyelesaikan simulasi pembelajaran anatomi mencit (<em>Mus musculus</em>). Anda telah mengenal susunan organ, letak, dan fungsi berbagai sistem organ melalui model virtual.',
      reflectionHeading: "Refleksi Pembelajaran — QS. Ali 'Imran Ayat 191",
      reflectionText: '<strong>Refleksi:</strong> Melalui pembelajaran anatomi, kita dapat memahami keteraturan struktur dan fungsi tubuh makhluk hidup. Pengetahuan ini mengajak kita untuk bersyukur, menghargai kehidupan, dan memperlakukan makhluk hidup secara bertanggung jawab serta etis.',
      objectsTitle: 'Pengenalan Objek Virtual dan Fungsinya',
      objects: [
        ['1. Kapas Kloroform (Representasi Virtual)', 'Representasi virtual agen anestetik di dalam simulasi. Kloroform merupakan bahan kimia berbahaya yang berisiko bagi kesehatan dan tidak untuk digunakan secara mandiri.'],
        ['2. Jarum Pentul (Representasi Virtual)', 'Objek virtual berbentuk jarum berkepala bulat yang digunakan dalam simulasi sebagai penanda posisi untuk menjaga tampilan model tetap stabil saat diamati.'],
        ['3. Skalpel (Representasi Virtual)', 'Objek virtual berbentuk pisau tipis dengan bilah kecil yang merepresentasikan instrumen pengamatan lapisan permukaan pada model simulasi.'],
        ['4. Gunting Bedah (Representasi Virtual)', 'Objek virtual berbentuk gunting berujung ramping yang merepresentasikan instrumen pemisah lapisan pada model anatomi digital.'],
        ['5. Pinset Anatomis (Representasi Virtual)', 'Objek virtual berbentuk penjepit dua bilah yang digunakan untuk menggeser tampilan lapisan dan memindahkan ikon organ ke wadah pengamatan virtual.'],
        ['6. Benang Jahit yang Dapat Diserap Tubuh (Representasi Virtual)', 'Representasi virtual bahan benang medis yang dirancang agar dapat terurai atau diserap oleh jaringan tubuh dalam kondisi tertentu.'],
        ['7. Benang Jahit yang Tidak Dapat Diserap Tubuh (Representasi Virtual)', 'Representasi virtual bahan benang sintetis yang tidak dirancang untuk terurai secara alami di dalam tubuh sehingga mempertahankan kekuatannya dalam jangka waktu lama.']
      ]
    }
	
  },
  en: {
    title: 'Mouse Dissection Virtual Lab (<em>Mus musculus</em>)',
    leftTitle: 'Instrument Tray',
    rightTitle: 'Organ Specimen Box',
    boxHint: 'Drag organs with <strong>Forceps</strong> into this white box, then click an organ image to toggle its description card.',
    tts: '🔊 Audio',
    guide: 'Guide',
    shiftBtn: 'Shift Intestine',
    sutureBtn: 'Suture Mouse',
    finishBtn: 'Finish & Unpin',
    stepPrefix: 'STEP',
    instructionLabel: 'Instruction:',
    tools: {
      chloroform: ['Chloroform Cotton', 'Anesthetize mouse snout until unconscious'],
      pins: ['Dissecting Pins', 'Pin paws, pin & remove skin flap pins'],
      scalpel: ['Scalpel', 'Full top-to-bottom skin cut'],
      scissors: ['Surgical Scissors', 'Full top-to-bottom muscle cut'],
      forceps: ['Forceps', 'Open/close flaps & extract organs'],
      suture_abs: ['Absorbable Suture (5-0/6-0)', 'Simple interrupted muscle closure'],
      suture_nonabs: ['Non-Absorbable Suture (4-0/5-0)', 'Nylon/Polypropylene skin closure']
    },
    steps: [
      {
        num: 0,
        name: 'Mouse Anesthesia',
        desc: 'Putting the mouse to sleep using chloroform cotton.',
        instruction: 'Select Chloroform Cotton, then hold it over the mouse snout until asleep (100%).'
      },
      {
        num: 1,
        name: 'Model Position',
        desc: 'Securing the position of all four mouse paws.',
        instruction: 'Select Dissecting Pins, then place pins on the 4 paw points of the mouse.'
      },
      {
        num: 2,
        name: 'Skin Structure',
        desc: 'Opening the outer skin layer of the mouse.',
        instruction: 'Select Scalpel, then drag continuously from the top point to the bottom point along the skin guide line.'
      },
      {
        num: 3,
        name: 'Subcutaneous Layer',
        desc: 'Opening the skin flaps outward.',
        instruction: 'Select Forceps, then pull the left and right skin flaps outward.'
      },
      {
        num: 4,
        name: 'Skin Layer Position',
        desc: 'Holding the skin flaps open.',
        instruction: 'Select Dissecting Pins, then place pins on the left and right skin flaps.'
      },
      {
        num: 5,
        name: 'Muscle Structure',
        desc: 'Opening the abdominal wall muscle layer.',
        instruction: 'Select Surgical Scissors, then drag from the top point to the bottom point along the muscle line.'
      },
      {
        num: 6,
        name: 'Abdominal Cavity',
        desc: 'Opening the muscle wall to view the abdominal cavity.',
        instruction: 'Select Forceps, then pull the left and right muscle walls outward.'
      },
      {
        num: 7,
        name: 'Organ Observation',
        desc: 'Observing the arrangement and location of organs in the abdominal cavity.',
        instruction: 'Move organs using Forceps into the white box on the right to view details, or click Suture Mouse.'
      },
      {
        num: 8,
        name: 'Muscle Layer',
        desc: 'Bringing the abdominal muscle walls back together.',
        instruction: 'Select Forceps, then bring the left and right muscle walls back to the midline.'
      },
      {
        num: 9,
        name: 'Muscle Layer Closure',
        desc: 'Closing the muscle layer with absorbable suture.',
        instruction: 'Select Absorbable Suture (5-0/6-0), then click the 5 points along the muscle midline.'
      },
      {
        num: 10,
        name: 'Skin Layer Markers',
        desc: 'Removing pins from the skin flaps.',
        instruction: 'Select Dissecting Pins or Forceps, then remove the 2 pins from the left and right skin flaps.'
      },
      {
        num: 11,
        name: 'Skin Layer Position',
        desc: 'Bringing the outer skin flaps back together.',
        instruction: 'Select Forceps, then bring the left and right skin flaps back to the midline.'
      },
      {
        num: 12,
        name: 'Skin Layer Closure',
        desc: 'Closing the skin layer with non-absorbable suture.',
        instruction: 'Select Non-Absorbable Suture (4-0/5-0), then click the 6 points along the skin midline.'
      },
      {
        num: 13,
        name: 'Simulation Complete',
        desc: 'Completing all stages of the mouse anatomy simulation.',
        instruction: 'All layers are closed; click Finish & Unpin to view the final summary.'
      }
    ],
    fields: {
      name: '1. Organ Name (Indo / Eng / Latin)',
      desc: '2. Organ Description',
      work: '3. How It Works',
      func: '4. Function',
      loc: '5. Anatomical Location',
      mech: '6. Mechanism Visualization',
      emptySlot: 'Empty Slot'
    },
	
	closing: {
      badge: 'LEARNING SIMULATION COMPLETE • 100%',
      title: 'Congratulations! You have completed the virtual mouse anatomy learning simulation (<em>Mus musculus</em>).',
      subtitle: 'Congratulations! You have completed the virtual mouse anatomy learning simulation (<em>Mus musculus</em>). You have explored the structure, location, and functions of various organ systems through a virtual model.',
      reflectionHeading: "Learning Reflection — QS. Ali 'Imran Verse 191",
      reflectionText: '<strong>Reflection:</strong> Learning anatomy helps us understand the organized structure and functions of living organisms. This knowledge encourages gratitude, respect for life, and responsible and ethical treatment of living things.',
      objectsTitle: 'Virtual Objects and Their Functions',
      objects: [
        ['1. Chloroform Cotton (Virtual Representation)', 'Virtual representation of an anesthetic agent in the simulation. Chloroform is a hazardous chemical with health risks and must never be used independently.'],
        ['2. Dissecting Pins (Virtual Representation)', 'Virtual round-headed pin objects used in the simulation as position markers to keep the model view stable during observation.'],
        ['3. Scalpel (Virtual Representation)', 'Virtual thin-bladed instrument representing a surface-layer observation marker in the digital model.'],
        ['4. Surgical Scissors (Virtual Representation)', 'Virtual slender-tipped scissors representing a layer-separation instrument in the digital anatomy model.'],
        ['5. Anatomical Forceps (Virtual Representation)', 'Virtual two-pronged grasping object used to part layer views and move organ icons into the virtual observation tray.'],
        ['6. Absorbable Suture Thread (Virtual Representation)', 'Virtual representation of medical thread material designed to break down or be absorbed by body tissues under specific conditions.'],
        ['7. Non-Absorbable Suture Thread (Virtual Representation)', 'Virtual representation of synthetic thread material not designed to degrade naturally in the body, maintaining tensile strength over time.']
      ]
    }
	
  }
};

/* ONBOARDING SCREEN 1: TV MERAH PUTIH 3-SECOND TOUCH HOLD */
(function initTouchScanner() {
  const box = document.getElementById('touch-scanner-box');
  const handPad = box ? box.querySelector('.hand-pad') : null;
  const fill = document.getElementById('scan-progress-fill');
  const statusText = document.getElementById('scan-status-text');
  const handSvg = document.getElementById('hand-svg');
  const rippleEl = document.getElementById('hand-ripple-wave');
  const authModal = document.getElementById('touch-auth-modal');

  if (!box || !handPad) return;

  let rafId = null;
  let startTime = 0;
  let isHolding = false;
  let isCompleted = false;
  let activePointerId = null;
  const targetMs = 3000;
  const shrinkDelayMs = 1000;

  function triggerLightRippleAndTransition() {
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const padRect = handPad.getBoundingClientRect();
  const centerX = padRect.left + padRect.width / 2;
  const centerY = padRect.top + padRect.height / 2;

  if (rippleEl && !prefersReduced) {
    rippleEl.style.left = `${centerX}px`;
    rippleEl.style.top = `${centerY}px`;
    rippleEl.classList.remove('expand');
    void rippleEl.offsetWidth; // Force reflow agar animasi berjalan 1x bersih
    rippleEl.classList.add('expand');
  }

  // Tutup modal intro
  authModal.classList.remove('open');

  const transitionDelay = prefersReduced ? 0 : 600;

  setTimeout(() => {
    if (rippleEl) {
      rippleEl.classList.remove('expand');
    }

    // Pastikan tidak ada modal lain yang tersisa terbuka
    document.querySelectorAll('.modal-backdrop.open').forEach(el => {
      el.classList.remove('open');
    });

    if (typeof SPOTLIGHT_TUTORIAL !== 'undefined' && typeof SPOTLIGHT_TUTORIAL.startWelcomeFlow === 'function') {
      SPOTLIGHT_TUTORIAL.startWelcomeFlow(() => {
        openWanderingMiceCage();
      });
    } else if (typeof SPOTLIGHT_TUTORIAL !== 'undefined' && typeof SPOTLIGHT_TUTORIAL.start === 'function') {
      SPOTLIGHT_TUTORIAL.startWelcomeFlow(() => {
        openWanderingMiceCage();
      });
    } else {
      openWanderingMiceCage();
    }
  }, transitionDelay);
}

  function updateHoldFrame(now) {
    if (!isHolding || isCompleted) return;
    const elapsed = now - startTime;

    // Setelah 1 detik, tombol mengecil sedikit secara halus
    if (elapsed >= shrinkDelayMs && !box.classList.contains('shrink-active')) {
      box.classList.add('shrink-active');
    }

    const clamped = Math.min(targetMs, elapsed);
    const pct = (clamped / targetMs) * 100;
    fill.style.width = `${pct}%`;
    statusText.textContent = `Memindai Sentuhan... (${(clamped / 1000).toFixed(1)} / 3.0 dtk)`;

    if (elapsed >= targetMs) {
      isCompleted = true;
      isHolding = false;
      activePointerId = null;
      rafId = null;
      triggerLightRippleAndTransition();
      return;
    }

    rafId = requestAnimationFrame(updateHoldFrame);
  }

  /* === MODUL FULLSCREEN LINTAS PERANGKAT & FULL-SCREEN LAYOUT === */
const FULLSCREEN_MANAGER = {
  autoAttempted: false,
  isSupported() {
    const doc = document;
    const el = doc.documentElement;
    return Boolean(
      doc.fullscreenEnabled ||
      doc.webkitFullscreenEnabled ||
      doc.msFullscreenEnabled ||
      el.requestFullscreen ||
      el.webkitRequestFullscreen ||
      el.msRequestFullscreen
    );
  },
  getFullscreenElement() {
    return (
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.msFullscreenElement ||
      null
    );
  },
  syncViewportHeight() {
    const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    if (vh && vh > 0) {
      document.documentElement.style.setProperty('--app-height', `${Math.round(vh)}px`);
    }
  },
  updateButtonState() {
    const btn = document.getElementById('btn-fullscreen');
    if (!btn) return;
    const isFull = Boolean(this.getFullscreenElement());
    const isEn = typeof STATE !== 'undefined' && STATE.lang === 'en';
    if (!this.isSupported()) {
      btn.textContent = isEn ? '⛶ Fit Screen' : '⛶ Layar Penuh';
      btn.title = isEn
        ? 'Browser fullscreen API not supported; using full-screen layout'
        : 'Mode layar penuh browser tidak didukung perangkat ini; tampilan sudah disesuaikan ke seluruh layar';
      return;
    }
    if (isFull) {
      btn.textContent = isEn ? '✕ Exit Fullscreen' : '✕ Keluar Layar Penuh';
      btn.classList.add('btn-primary');
    } else {
      btn.textContent = isEn ? '⛶ Fullscreen' : '⛶ Layar Penuh';
      btn.classList.remove('btn-primary');
    }
  },
  async enter(silent = false) {
    this.syncViewportHeight();
    if (!this.isSupported() || this.getFullscreenElement()) {
      this.updateButtonState();
      return false;
    }
    const el = document.documentElement;
    try {
      const req = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
      if (req) {
        const res = req.call(el, { navigationUI: 'hide' });
        if (res && typeof res.then === 'function') {
          await res;
        }
      }
      this.updateButtonState();
      return true;
    } catch (err) {
      this.updateButtonState();
      if (!silent && typeof showToast === 'function') {
        showToast('Browser membatasi mode layar penuh penuh-jendela; tampilan tetap disesuaikan ke seluruh area layar.');
      }
      return false;
    }
  },
  async exit() {
    const doc = document;
    if (!this.getFullscreenElement()) {
      this.updateButtonState();
      return;
    }
    try {
      const exitFn = doc.exitFullscreen || doc.webkitExitFullscreen || doc.msExitFullscreen;
      if (exitFn) {
        const res = exitFn.call(doc);
        if (res && typeof res.then === 'function') {
          await res;
        }
      }
    } catch (err) {
      // Abaikan jika sudah keluar dari fullscreen
    }
    this.updateButtonState();
  },
  toggle() {
    if (this.getFullscreenElement()) {
      this.exit();
    } else {
      this.enter(false);
    }
  },
  init() {
    this.syncViewportHeight();
    this.updateButtonState();

    window.addEventListener('resize', () => this.syncViewportHeight());
    window.addEventListener('orientationchange', () => {
      setTimeout(() => this.syncViewportHeight(), 120);
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => this.syncViewportHeight());
    }

    ['fullscreenchange', 'webkitfullscreenchange', 'msfullscreenchange'].forEach(evt => {
      document.addEventListener(evt, () => {
        this.syncViewportHeight();
        this.updateButtonState();
      });
    });

    const btnFs = document.getElementById('btn-fullscreen');
    if (btnFs) {
      btnFs.addEventListener('click', e => {
        e.stopPropagation();
        this.autoAttempted = true;
        this.toggle();
      });
    }

    // Pemicu fullscreen langsung pada interaksi sentuh/klik pertama yang valid
    const triggerFirstInteractionFs = () => {
      if (this.autoAttempted) return;
      this.autoAttempted = true;
      this.enter(true);
    };
    document.addEventListener('pointerdown', triggerFirstInteractionFs, { once: true, capture: true });
  }
};

FULLSCREEN_MANAGER.init();

  function startHold(e) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    if (!FULLSCREEN_MANAGER.autoAttempted) {
      FULLSCREEN_MANAGER.autoAttempted = true;
      FULLSCREEN_MANAGER.enter(true);
    }
    if (isHolding || isCompleted) return;

    isHolding = true;
    activePointerId = e.pointerId;
    startTime = performance.now();

    box.classList.add('scanning');
    box.classList.remove('shrink-active');
    handSvg.setAttribute('stroke', '#16a34a');

    rafId = requestAnimationFrame(updateHoldFrame);
  }

  function cancelHold(e) {
    if (!isHolding || isCompleted) return;
    if (e && activePointerId !== null && e.pointerId !== undefined && e.pointerId !== activePointerId) {
      return;
    }

    isHolding = false;
    activePointerId = null;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }

    box.classList.remove('scanning', 'shrink-active');
    handSvg.setAttribute('stroke', '#ef4444');
    fill.style.width = '0%';
    statusText.textContent = 'Tempel & Tahan di Sini (0.0 / 3.0 dtk)';
  }

window.resetTouchScannerModal = function() {
    isHolding = false;
    isCompleted = false;
    activePointerId = null;
    startTime = 0;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    box.classList.remove('scanning', 'shrink-active');
    handSvg.setAttribute('stroke', '#ef4444');
    fill.style.width = '0%';
    statusText.textContent = 'Tempel & Tahan di Sini (0.0 / 3.0 dtk)';
  };

  box.addEventListener('pointerdown', startHold);
  box.addEventListener('pointerleave', cancelHold);
  box.addEventListener('pointerup', cancelHold);
  box.addEventListener('pointercancel', cancelHold);
})();

/* ONBOARDING SCREEN 2: SEX SELECTION -> OPEN WANDERING MICE CAGE */
document.querySelectorAll('.sex-option-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.sex-option-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    STATE.sex = card.dataset.sex;
  });
});

function openPracticumObjectivesModal() {
  const introModal = document.getElementById('intro-setup-modal');
  const manualPicker = document.getElementById('manual-sex-picker-wrap');
  const specBox = document.getElementById('intro-selected-specimen-box');
  const specIdEl = document.getElementById('intro-spec-id');
  const specSexEl = document.getElementById('intro-spec-sex');

  if (STATE.selectedSpecimen) {
    if (manualPicker) manualPicker.style.display = 'none';
    if (specBox) specBox.style.display = 'block';
    if (specIdEl) specIdEl.textContent = STATE.selectedSpecimen.id;
    if (specSexEl) {
      specSexEl.textContent = STATE.selectedSpecimen.sex === 'female' ? 'Betina (Female)' : 'Jantan (Male)';
    }
  } else {
    if (manualPicker) manualPicker.style.display = 'block';
    if (specBox) specBox.style.display = 'none';
  }

  if (introModal) introModal.classList.add('open');
}

document.getElementById('btn-start-practicum').addEventListener('click', () => {
  // Tutup modal Tujuan Praktikum & pastikan tidak ada modal lain yang terbuka
  const introModal = document.getElementById('intro-setup-modal');
  if (introModal) introModal.classList.remove('open');
  document.querySelectorAll('.modal-backdrop.open').forEach(el => el.classList.remove('open'));

  // Munculkan kembali gambar mencit di baki pembedahan
  document.body.classList.remove('specimen-hidden-on-reset');

  // Terapkan jenis kelamin spesimen terpilih & mulai Tahap 0 (Pembiusan)
  applySpecimenSex();
  STATE.step = 0;
  STATE.anesthesiaProgress = 0;
  STATE.anesthetized = false;
  setTool('chloroform');
  updateUI();
  saveSessionNow();
  showToast('Praktikum dimulai! Pilih Kapas Kloroform dan tahan di hidung mencit.');
});


/* WANDERING MICE CAGE SIMULATION (HOLD 3 SECONDS + CONFIRMATION MODAL) */
let cageAnimId = null;
let cageMice = [];
let heldMouseIdx = -1;
let holdMouseElapsed = 0;
let holdMouseInterval = null;
let activeCagePointerId = null;
let confirmModalListenersBound = false;
let cageGlobalListenersBound = false;

function initCageSpecimensSession(forceNew = false) {
  if (!forceNew && Array.isArray(STATE.cageSpecimens) && STATE.cageSpecimens.length > 0) {
    return STATE.cageSpecimens;
  }

  const total = Math.max(2, Number(STATE.cageCapacity) || 6);
  const half = Math.floor(total / 2);
  const remainder = total % 2;
  const extraSex = remainder === 1 ? (Math.random() < 0.5 ? 'male' : 'female') : null;

  const genderPool = [];
  for (let i = 0; i < half; i++) {
    genderPool.push('male');
    genderPool.push('female');
  }
  if (extraSex) {
    genderPool.push(extraSex);
  }

  for (let i = genderPool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [genderPool[i], genderPool[j]] = [genderPool[j], genderPool[i]];
  }

  const furPalette = ['#f8fafc', '#f1f5f9', '#e2e8f0', '#f8fafc', '#f1f5f9', '#e2e8f0'];
  STATE.cageSpecimens = genderPool.map((sex, idx) => {
    const num = String(idx + 1).padStart(2, '0');
    return {
      id: `Mencit #${num}`,
      index: idx + 1,
      sex: sex,
      color: furPalette[idx % furPalette.length]
    };
  });

  return STATE.cageSpecimens;
}

function createMouseSpriteSvg(colorBody) {
  return `
    <svg viewBox="0 0 80 50" width="68" height="44" aria-hidden="true">
      <path d="M12 26 Q2 20 0 30" fill="none" stroke="#f472b6" stroke-width="3" stroke-linecap="round"/>
      <ellipse cx="38" cy="26" rx="22" ry="13" fill="${colorBody}" stroke="#64748b" stroke-width="1.8"/>
      <circle cx="56" cy="20" r="6" fill="#e2e8f0" stroke="#94a3b8" stroke-width="1.4"/>
      <circle cx="56" cy="32" r="6" fill="#e2e8f0" stroke="#94a3b8" stroke-width="1.4"/>
      <circle cx="66" cy="26" r="3.5" fill="#f472b6"/>
      <circle cx="60" cy="22" r="2" fill="#0f172a"/>
      <circle cx="60" cy="30" r="2" fill="#0f172a"/>
    </svg>
  `;
}

function hideCageTooltip() {
  const tooltip = document.getElementById('cage-specimen-tooltip');
  if (!tooltip) return;
  tooltip.classList.remove('visible');
  tooltip.setAttribute('aria-hidden', 'true');
}

function showCageTooltipForMouse(mouseObj, arena) {
  const tooltip = document.getElementById('cage-specimen-tooltip');
  if (!tooltip || !arena || !mouseObj) return;

  const genderLabel = mouseObj.specimen.sex === 'female' ? 'Betina' : 'Jantan';
  tooltip.textContent = `Memilih ${mouseObj.specimen.id} (${genderLabel})...`;
  tooltip.classList.add('visible');
  tooltip.setAttribute('aria-hidden', 'false');

  const arenaW = arena.clientWidth;
  const arenaH = arena.clientHeight;
  const tipW = tooltip.offsetWidth || 160;
  const tipH = tooltip.offsetHeight || 28;
  const objW = 68;
  const objH = 44;
  const margin = 8;

  let tipX = mouseObj.x + objW / 2 - tipW / 2;
  tipX = Math.max(margin, Math.min(arenaW - tipW - margin, tipX));

  let tipY = mouseObj.y - tipH - 18;
  if (tipY < margin) {
    tipY = Math.min(arenaH - tipH - margin, mouseObj.y + objH + 8);
  }

  tooltip.style.transform = `translate(${tipX.toFixed(1)}px, ${tipY.toFixed(1)}px)`;
}

function clearHoldTimerAndTooltip() {
  if (holdMouseInterval) {
    clearInterval(holdMouseInterval);
    holdMouseInterval = null;
  }
  hideCageTooltip();
}

function cancelActiveMouseHold(reasonText) {
  if (STATE.cageLocked) return;
  const fill = document.getElementById('capture-progress-fill');
  const statusEl = document.getElementById('capture-status-text');
  const timerEl = document.getElementById('capture-timer-label');

  if (heldMouseIdx !== -1 && cageMice[heldMouseIdx]) {
    cageMice[heldMouseIdx].el.classList.remove('holding');
  }

  heldMouseIdx = -1;
  activeCagePointerId = null;
  holdMouseElapsed = 0;
  clearHoldTimerAndTooltip();

  if (fill) fill.style.width = '0%';
  if (timerEl) timerEl.textContent = '0.0 / 3.0 dtk';
  if (statusEl && reasonText) {
    statusEl.textContent = reasonText;
  }
}

function releaseHeldMouse(e) {
  if (STATE.cageLocked || heldMouseIdx === -1 || holdMouseElapsed >= 3000) return;
  if (e && activeCagePointerId !== null && e.pointerId !== undefined && e.pointerId !== activeCagePointerId) {
    return;
  }
  cancelActiveMouseHold('Mencit terlepas! Tahan terus selama 3 detik.');
}

function setCageLockState(locked) {
  STATE.cageLocked = locked;
  const arena = document.getElementById('cage-arena');
  if (arena) {
    arena.classList.toggle('cage-locked', locked);
  }
}

function openMouseConfirmModal(mouseObj) {
  const confirmModal = document.getElementById('mouse-confirm-modal');
  if (!confirmModal || confirmModal.classList.contains('open')) return;

  setCageLockState(true);
  clearHoldTimerAndTooltip();

  const idEl = document.getElementById('mc-specimen-id');
  const sexEl = document.getElementById('mc-specimen-sex');
  const sexText = mouseObj.specimen.sex === 'female' ? 'Betina (Female)' : 'Jantan (Male)';

  if (idEl) idEl.textContent = mouseObj.specimen.id;
  if (sexEl) sexEl.textContent = sexText;

  confirmModal.classList.add('open');
}

function bindMouseConfirmModalEvents() {
  if (confirmModalListenersBound) return;
  confirmModalListenersBound = true;

  const confirmModal = document.getElementById('mouse-confirm-modal');
  const btnUse = document.getElementById('btn-use-selected-mouse');
  const btnOther = document.getElementById('btn-choose-other-mouse');

  // Tombol 1: "Pakai mencit ini"
  if (btnUse) {
    btnUse.addEventListener('click', () => {
      if (heldMouseIdx === -1 || !cageMice[heldMouseIdx]) return;
      const chosenObj = cageMice[heldMouseIdx];
      const specimen = chosenObj.specimen;

      // Tetapkan spesimen aktif
      STATE.selectedSpecimen = {
        id: specimen.id,
        index: specimen.index,
        sex: specimen.sex
      };
      STATE.sex = specimen.sex;

      // Bersihkan status hold, outline, tooltip, timer, dan kunci kandang
      chosenObj.el.classList.remove('holding', 'selected-specimen');
      clearHoldTimerAndTooltip();
      heldMouseIdx = -1;
      activeCagePointerId = null;
      holdMouseElapsed = 0;
      setCageLockState(false);

      // Tutup modal konfirmasi dan modal kandang
      if (confirmModal) confirmModal.classList.remove('open');
      const cageModal = document.getElementById('cage-capture-modal');
      if (cageModal) cageModal.classList.remove('open');

      if (cageAnimId) {
        cancelAnimationFrame(cageAnimId);
        cageAnimId = null;
      }

      // Siapkan anatomi spesimen terpilih & tampilkan Tujuan Praktikum sebelum mulai
      applySpecimenSex();
      STATE.step = 0;
      STATE.anesthesiaProgress = 0;
      STATE.anesthetized = false;
      setTool('chloroform');
      updateUI();
      saveSessionNow();
      openPracticumObjectivesModal();
    });
  }

  // Tombol 2: "Cari yang lain"
  if (btnOther) {
    btnOther.addEventListener('click', () => {
      const fill = document.getElementById('capture-progress-fill');
      const statusEl = document.getElementById('capture-status-text');
      const timerEl = document.getElementById('capture-timer-label');

      if (heldMouseIdx !== -1 && cageMice[heldMouseIdx]) {
        const returnedObj = cageMice[heldMouseIdx];
        returnedObj.el.classList.remove('holding', 'selected-specimen');
        returnedObj.x = returnedObj.originX;
        returnedObj.y = returnedObj.originY;
        const angleDeg = Math.atan2(returnedObj.vy, returnedObj.vx) * (180 / Math.PI);
        returnedObj.el.style.transform = `translate(${returnedObj.x.toFixed(1)}px, ${returnedObj.y.toFixed(1)}px) rotate(${angleDeg.toFixed(1)}deg)`;
      }

      STATE.selectedSpecimen = null;
      heldMouseIdx = -1;
      activeCagePointerId = null;
      holdMouseElapsed = 0;
      clearHoldTimerAndTooltip();

      if (fill) fill.style.width = '0%';
      if (timerEl) timerEl.textContent = '0.0 / 3.0 dtk';
      if (statusEl) statusEl.textContent = 'Status: Sentuh & tahan mencit lain selama 3 detik';

      if (confirmModal) confirmModal.classList.remove('open');
      setCageLockState(false);
    });
  }
}

function layoutCageMicePositions(arena, forceSpread = false) {
  if (!arena || cageMice.length === 0) return;
  const rawW = arena.clientWidth > 100 ? arena.clientWidth : 800;
  const rawH = arena.clientHeight > 100 ? arena.clientHeight : 310;
  const maxW = Math.max(120, rawW - 76);
  const maxH = Math.max(100, rawH - 52);

  const cols = rawW < 480 ? 2 : 5;
  const rows = Math.ceil(cageMice.length / cols);
  const cellW = maxW / cols;
  const cellH = maxH / rows;

  cageMice.forEach((m, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    if (!m.initialized || forceSpread) {
      m.x = Math.min(maxW, Math.max(14, col * cellW + cellW * 0.3));
      m.y = Math.min(maxH, Math.max(20, row * cellH + cellH * 0.3));
      m.originX = m.x;
      m.originY = m.y;
      m.initialized = true;
    } else {
      m.x = Math.min(maxW, Math.max(14, m.x));
      m.y = Math.min(maxH, Math.max(20, m.y));
      m.originX = Math.min(maxW, Math.max(14, m.originX));
      m.originY = Math.min(maxH, Math.max(20, m.originY));
    }
    const angleDeg = Math.atan2(m.vy, m.vx) * (180 / Math.PI);
    m.el.style.transform = `translate(${m.x.toFixed(1)}px, ${m.y.toFixed(1)}px) rotate(${angleDeg.toFixed(1)}deg)`;
  });
}

function openWanderingMiceCage() {
  const modal = document.getElementById('cage-capture-modal');
  const arena = document.getElementById('cage-arena');
  const fill = document.getElementById('capture-progress-fill');
  const statusEl = document.getElementById('capture-status-text');
  const timerEl = document.getElementById('capture-timer-label');

  bindMouseConfirmModalEvents();
  setCageLockState(false);
  clearHoldTimerAndTooltip();

  modal.classList.add('open');
  fill.style.width = '0%';
  statusEl.textContent = 'Status: Sentuh & tahan salah satu mencit';
  timerEl.textContent = '0.0 / 3.0 dtk';
  heldMouseIdx = -1;
  activeCagePointerId = null;
  holdMouseElapsed = 0;

  if (cageAnimId) {
    cancelAnimationFrame(cageAnimId);
    cageAnimId = null;
  }

  const specimens = initCageSpecimensSession(false);
  arena.querySelectorAll('.wandering-mouse').forEach(el => el.remove());

  const prevMap = new Map(cageMice.map(item => [item.specimen.id, item]));
  cageMice = [];

  specimens.forEach((specimen, i) => {
    const el = document.createElement('div');
    el.className = 'wandering-mouse';
    el.dataset.id = specimen.id;
    el.dataset.sex = specimen.sex;
    el.innerHTML = `<span class="wandering-mouse-tag">${specimen.id}</span>` + createMouseSpriteSvg(specimen.color);

    const prev = prevMap.get(specimen.id);
    const mObj = {
      el,
      specimen,
      x: prev ? prev.x : 0,
      y: prev ? prev.y : 0,
      originX: prev ? prev.originX : 0,
      originY: prev ? prev.originY : 0,
      vx: prev ? prev.vx : (Math.random() > 0.5 ? 1 : -1) * (1.8 + Math.random() * 1.4),
      vy: prev ? prev.vy : (Math.random() > 0.5 ? 1 : -1) * (1.4 + Math.random() * 1.2),
      initialized: prev ? prev.initialized : false
    };
    cageMice.push(mObj);
    arena.appendChild(el);

    el.addEventListener('pointerdown', e => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      // Abaikan jika kandang terkunci (modal terbuka) atau sudah ada proses hold lain
      if (STATE.cageLocked || heldMouseIdx !== -1 || holdMouseInterval !== null) return;

      heldMouseIdx = i;
      activeCagePointerId = e.pointerId;
      holdMouseElapsed = 0;
      mObj.originX = mObj.x;
      mObj.originY = mObj.y;

      el.classList.remove('selected-specimen');
      el.classList.add('holding');
      statusEl.textContent = `Menahan ${specimen.id}... jangan dilepas!`;

      holdMouseInterval = setInterval(() => {
        if (STATE.cageLocked || heldMouseIdx !== i) {
          clearHoldTimerAndTooltip();
          return;
        }

        holdMouseElapsed += 100;
        const pct = Math.min(100, (holdMouseElapsed / 3000) * 100);
        fill.style.width = pct + '%';
        timerEl.textContent = `${(holdMouseElapsed / 1000).toFixed(1)} / 3.0 dtk`;

        // Setelah 1 detik, tampilkan tooltip informasi mencit
        if (holdMouseElapsed >= 1000 && holdMouseElapsed < 3000) {
          showCageTooltipForMouse(mObj, arena);
        }

        // Setelah 3 detik, tandai terpilih (outline putih + soft glow) & buka modal konfirmasi
        if (holdMouseElapsed >= 3000) {
          clearHoldTimerAndTooltip();
          activeCagePointerId = null;
          el.classList.remove('holding');
          el.classList.add('selected-specimen');
          statusEl.textContent = `${specimen.id} terpilih! Menunggu konfirmasi...`;
          openMouseConfirmModal(mObj);
        }
      }, 100);
    });

    el.addEventListener('pointerleave', e => {
      if (STATE.cageLocked || heldMouseIdx !== i || holdMouseElapsed >= 3000) return;
      if (activeCagePointerId !== null && e.pointerId !== activeCagePointerId) return;
      cancelActiveMouseHold('Pointer keluar dari mencit! Tahan tetap di atas mencit selama 3 detik.');
    });

    el.addEventListener('pointerup', e => {
      if (STATE.cageLocked || heldMouseIdx !== i || holdMouseElapsed >= 3000) return;
      if (activeCagePointerId !== null && e.pointerId !== activeCagePointerId) return;
      cancelActiveMouseHold('Mencit terlepas! Tahan terus selama 3 detik.');
    });

    el.addEventListener('pointercancel', e => {
      if (STATE.cageLocked || heldMouseIdx !== i || holdMouseElapsed >= 3000) return;
      if (activeCagePointerId !== null && e.pointerId !== activeCagePointerId) return;
      cancelActiveMouseHold('Sentuhan terhenti! Tahan terus selama 3 detik.');
    });
  });

  layoutCageMicePositions(arena, true);
  requestAnimationFrame(() => layoutCageMicePositions(arena, true));

  if (!cageGlobalListenersBound) {
    cageGlobalListenersBound = true;
    window.addEventListener('pointerup', releaseHeldMouse);
    window.addEventListener('pointercancel', releaseHeldMouse);
    window.addEventListener('resize', () => {
      if (modal.classList.contains('open')) {
        layoutCageMicePositions(arena, false);
      }
    });
  }

  function animateCage() {
    if (!modal.classList.contains('open')) {
      cageAnimId = null;
      return;
    }

    const rawW = arena.clientWidth > 100 ? arena.clientWidth : 800;
    const rawH = arena.clientHeight > 100 ? arena.clientHeight : 310;
    const maxW = Math.max(120, rawW - 76);
    const maxH = Math.max(100, rawH - 52);

    cageMice.forEach((m, idx) => {
      if (idx === heldMouseIdx || STATE.cageLocked) return;

      if (Math.random() < 0.04) {
        m.vx += (Math.random() - 0.5) * 1.6;
        m.vy += (Math.random() - 0.5) * 1.6;
      }

      let speed = Math.hypot(m.vx, m.vy);
      if (speed < 1.6) {
        const angle = Math.random() * Math.PI * 2;
        m.vx = Math.cos(angle) * 2.2;
        m.vy = Math.sin(angle) * 2.2;
      } else if (speed > 3.6) {
        m.vx = (m.vx / speed) * 3.6;
        m.vy = (m.vy / speed) * 3.6;
      }

      m.x += m.vx;
      m.y += m.vy;

      if (m.x <= 10) { m.x = 10; m.vx = Math.abs(m.vx); }
      if (m.x >= maxW) { m.x = maxW; m.vx = -Math.abs(m.vx); }
      if (m.y <= 16) { m.y = 16; m.vy = Math.abs(m.vy); }
      if (m.y >= maxH) { m.y = maxH; m.vy = -Math.abs(m.vy); }

      const angleDeg = Math.atan2(m.vy, m.vx) * (180 / Math.PI);
      m.el.style.transform = `translate3d(${m.x.toFixed(1)}px, ${m.y.toFixed(1)}px, 0) rotate(${angleDeg.toFixed(1)}deg)`;
    });

    cageAnimId = requestAnimationFrame(animateCage);
  }
  cageAnimId = requestAnimationFrame(animateCage);
  }

/* Anesthesia Continuous Hold Timer while Chloroform is held over snout */
let anesthesiaHoldTimer = null;
function startAnesthesiaHold() {
  if (anesthesiaHoldTimer || STATE.step !== 0 || STATE.activeTool !== 'chloroform') return;
  anesthesiaHoldTimer = setInterval(() => {
    if (!STATE.drag.active || STATE.step !== 0 || STATE.activeTool !== 'chloroform') {
      stopAnesthesiaHold();
      return;
    }
    STATE.anesthesiaProgress = Math.min(100, STATE.anesthesiaProgress + 4);
    if (STATE.anesthesiaProgress >= 100) {
      STATE.anesthesiaProgress = 100;
      STATE.anesthetized = true;
      STATE.step = 1;
      stopAnesthesiaHold();
      setTool('pins');
      showToast('Mencit sudah pingsan terbius kloroform! Lanjut Tahap 1: Fiksasi 4 telapak kaki dengan Jarum Pentul.');
    }
    updateUI();
  }, 100);
}

function stopAnesthesiaHold() {
  if (anesthesiaHoldTimer) {
    clearInterval(anesthesiaHoldTimer);
    anesthesiaHoldTimer = null;
  }
}

function applySpecimenSex() {
  const activeSex = (STATE.selectedSpecimen && STATE.selectedSpecimen.sex)
    ? STATE.selectedSpecimen.sex
    : STATE.sex;
  STATE.sex = activeSex;

  const isFemale = activeSex === 'female';
  const isReproExtracted = STATE.extractedOrgans.includes('reproductive');
  const isReproSelected = STATE.popupOrganId === 'reproductive';

  // 1. Organ reproduksi internal (eksklusif sesuai jenis kelamin spesimen)
  const femEl = document.getElementById('organ-reproductive-female');
  const maleEl = document.getElementById('organ-reproductive-male');
  if (femEl) {
    femEl.style.display = isFemale ? 'block' : 'none';
    femEl.classList.toggle('extracted', isFemale && isReproExtracted);
    femEl.classList.toggle('selected', isFemale && isReproSelected);
  }
  if (maleEl) {
    maleEl.style.display = isFemale ? 'none' : 'block';
    maleEl.classList.toggle('extracted', !isFemale && isReproExtracted);
    maleEl.classList.toggle('selected', !isFemale && isReproSelected);
  }

  // 2. Ciri morfologi eksternal perineal/inguinal (terlihat sejak tahap awal hingga penutupan)
  const extMaleEl = document.getElementById('ext-male-anatomy');
  const extFemaleEl = document.getElementById('ext-female-anatomy');
  if (extMaleEl) extMaleEl.style.display = isFemale ? 'none' : 'block';
  if (extFemaleEl) extFemaleEl.style.display = isFemale ? 'block' : 'none';

  // 3. Penanda 5 pasang kelenjar mammae pada lapisan kulit ventral betina
  document.querySelectorAll('.female-mammary-left, .female-mammary-right').forEach(el => {
    el.style.display = isFemale ? 'block' : 'none';
  });
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 3400);
}

function setTool(toolId) {
  STATE.activeTool = toolId;
  document.querySelectorAll('.tool-card').forEach(c => {
    c.classList.toggle('active', c.dataset.tool === toolId);
  });
}

function getRecommendedTool() {
  if (STATE.step === 0) return 'chloroform';
  if (STATE.step === 1 || STATE.step === 4 || STATE.step === 10) return 'pins';
  if (STATE.step === 2) return 'scalpel';
  if (STATE.step === 3 || STATE.step === 6 || STATE.step === 7 || STATE.step === 8 || STATE.step === 11) return 'forceps';
  if (STATE.step === 5) return 'scissors';
  if (STATE.step === 9) return 'suture_abs';
  if (STATE.step === 12) return 'suture_nonabs';
  return 'suture_nonabs';
}

function updateUI() {
  const t = I18N[STATE.lang];
  document.getElementById('ui-title').innerHTML = t.title;
  document.getElementById('ui-left-title').textContent = t.leftTitle;
  document.getElementById('ui-right-title').textContent = t.rightTitle;
  document.getElementById('ui-box-hint').innerHTML = t.boxHint;
  document.getElementById('btn-tts').textContent = t.tts;
  document.getElementById('btn-guide').textContent = t.guide;
  document.getElementById('btn-shift-intestine').textContent = t.shiftBtn;
  document.getElementById('btn-start-suture').textContent = t.sutureBtn;
  document.getElementById('btn-finish-surgery').textContent = t.finishBtn;
  const stepObj = t.steps[STATE.step] || t.steps[0];
  const stepTitleText = `${t.stepPrefix} ${stepObj.num} — ${stepObj.name.toUpperCase()}: ${stepObj.desc.toUpperCase()}`;
  const stepTitleEl = document.getElementById('ui-step-title');
  const stepInstLabelEl = document.getElementById('ui-step-instruction-label');
  const stepInstEl = document.getElementById('ui-step-instruction');

  if (stepTitleEl) stepTitleEl.textContent = stepTitleText;
  if (stepInstLabelEl) stepInstLabelEl.textContent = t.instructionLabel;
  if (stepInstEl) stepInstEl.textContent = stepObj.instruction;

  if (typeof FULLSCREEN_MANAGER !== 'undefined' && typeof FULLSCREEN_MANAGER.updateButtonState === 'function') {
    FULLSCREEN_MANAGER.updateButtonState();
  }

  Object.keys(t.tools).forEach(k => {
    const lblEl = document.getElementById('lbl-tool-' + k);
    const descEl = document.getElementById('desc-tool-' + k);
    if (lblEl) lblEl.textContent = t.tools[k][0];
    if (descEl) descEl.textContent = t.tools[k][1];
  });

  // Hide organ inspection / forceps ONLY during active suture needle steps (9 & 12) if user skipped inspection,
  // while keeping Forceps visible on steps 8 & 11 so user can close muscle & skin flaps with Forceps!
  const forcepsCard = document.getElementById('tool-forceps');
  if (STATE.sutureModeActive && (STATE.step === 9 || STATE.step === 10 || STATE.step === 12 || STATE.step === 13)) {
    forcepsCard.style.display = 'none';
  } else {
    forcepsCard.style.display = 'flex';
  }

  const rec = getRecommendedTool();
  document.querySelectorAll('.tool-card').forEach(c => {
    c.classList.toggle('recommended', c.dataset.tool === rec);
  });

  // Step progress badge
  const mDone = STATE.muscleStitches.filter(Boolean).length;
  const sDone = STATE.skinStitches.filter(Boolean).length;
  let prog = '';
  if (STATE.step === 0) {
    prog = `Bius ${Math.round(STATE.anesthesiaProgress)}%`;
  } else if (STATE.step === 1) {
    const count = ['fl', 'fr', 'bl', 'br'].filter(k => STATE.pins[k]).length;
    prog = `${count} / 4`;
  } else if (STATE.step === 2) {
    prog = `${Math.round(STATE.skinCutProgress)}%`;
  } else if (STATE.step === 3) {
    const count = (STATE.skinRetracted.left ? 1 : 0) + (STATE.skinRetracted.right ? 1 : 0);
    prog = `${count} / 2`;
  } else if (STATE.step === 4) {
    const count = (STATE.pins.sl ? 1 : 0) + (STATE.pins.sr ? 1 : 0);
    prog = `${count} / 2`;
  } else if (STATE.step === 5) {
    prog = `${Math.round(STATE.muscleCutProgress)}%`;
  } else if (STATE.step === 6) {
    const count = (STATE.muscleRetracted.left ? 1 : 0) + (STATE.muscleRetracted.right ? 1 : 0);
    prog = `${count} / 2`;
  } else if (STATE.step === 7) {
    prog = `${STATE.extractedOrgans.length} / 8`;
  } else if (STATE.step === 8) {
    const count = (STATE.muscleClosed.left ? 1 : 0) + (STATE.muscleClosed.right ? 1 : 0);
    prog = `Tutup Otot ${count} / 2`;
  } else if (STATE.step === 9) {
    prog = `Jahit Otot ${mDone} / 5`;
  } else if (STATE.step === 10) {
    const removed = (!STATE.pins.sl ? 1 : 0) + (!STATE.pins.sr ? 1 : 0);
    prog = `Cabut Pin ${removed} / 2`;
  } else if (STATE.step === 11) {
    const count = (STATE.skinClosed.left ? 1 : 0) + (STATE.skinClosed.right ? 1 : 0);
    prog = `Tutup Kulit ${count} / 2`;
  } else if (STATE.step === 12) {
    prog = `Jahit Kulit ${sDone} / 6`;
  } else {
    prog = '100%';
  }
  document.getElementById('ui-step-progress').textContent = prog;
  document.getElementById('ui-dish-count').textContent = `${STATE.extractedOrgans.length} / 8`;

  // Sinkronisasi Progress Bar Vertikal (Pojok Kanan Atas Area Kerja Hijau)
  let stepFraction = 0;
  if (STATE.step === 0) {
    stepFraction = STATE.anesthesiaProgress / 100;
  } else if (STATE.step === 1) {
    stepFraction = ['fl', 'fr', 'bl', 'br'].filter(k => STATE.pins[k]).length / 4;
  } else if (STATE.step === 2) {
    stepFraction = STATE.skinCutProgress / 100;
  } else if (STATE.step === 3) {
    stepFraction = ((STATE.skinRetracted.left ? 1 : 0) + (STATE.skinRetracted.right ? 1 : 0)) / 2;
  } else if (STATE.step === 4) {
    stepFraction = ((STATE.pins.sl ? 1 : 0) + (STATE.pins.sr ? 1 : 0)) / 2;
  } else if (STATE.step === 5) {
    stepFraction = STATE.muscleCutProgress / 100;
  } else if (STATE.step === 6) {
    stepFraction = ((STATE.muscleRetracted.left ? 1 : 0) + (STATE.muscleRetracted.right ? 1 : 0)) / 2;
  } else if (STATE.step === 7) {
    stepFraction = STATE.extractedOrgans.length / 8;
  } else if (STATE.step === 8) {
    stepFraction = ((STATE.muscleClosed.left ? 1 : 0) + (STATE.muscleClosed.right ? 1 : 0)) / 2;
  } else if (STATE.step === 9) {
    stepFraction = mDone / 5;
  } else if (STATE.step === 10) {
    stepFraction = ((!STATE.pins.sl ? 1 : 0) + (!STATE.pins.sr ? 1 : 0)) / 2;
  } else if (STATE.step === 11) {
    stepFraction = ((STATE.skinClosed.left ? 1 : 0) + (STATE.skinClosed.right ? 1 : 0)) / 2;
  } else if (STATE.step === 12) {
    stepFraction = sDone / 6;
  }

  const totalPct = STATE.step >= 13
    ? 100
    : Math.min(99, Math.max(0, Math.round(((STATE.step + stepFraction) / 13) * 100)));

  const vpFillEl = document.getElementById('vp-fill');
  const vpPctEl = document.getElementById('vp-pct-text');
  const vpSubEl = document.getElementById('vp-sub-text');
  const vpTrackEl = document.getElementById('vp-track');

  if (vpFillEl) vpFillEl.style.height = `${totalPct}%`;
  if (vpPctEl) vpPctEl.textContent = `${totalPct}%`;
  if (vpSubEl) vpSubEl.textContent = prog;
  if (vpTrackEl) vpTrackEl.setAttribute('aria-valuenow', String(totalPct));

  // Anesthesia HUD & Snout Ring (Step 0)
  const anesHud = document.getElementById('anesthesia-hud');
  const snoutRing = document.getElementById('snout-anesthesia-ring');
  const zzzBadge = document.getElementById('zzz-badge');
  if (STATE.step === 0) {
    anesHud.classList.add('visible');
    document.getElementById('anesthesia-hud-pct').textContent = `${Math.round(STATE.anesthesiaProgress)}%`;
    document.getElementById('anesthesia-fill').style.width = `${STATE.anesthesiaProgress}%`;
    snoutRing.classList.add('visible');
  } else {
    anesHud.classList.remove('visible');
    snoutRing.classList.remove('visible');
  }
  zzzBadge.style.display = STATE.anesthetized ? 'block' : 'none';
  const eyesOpenEl = document.getElementById('mouse-eyes-open');
  const eyesClosedEl = document.getElementById('mouse-eyes-closed');
  if (eyesOpenEl) eyesOpenEl.style.display = STATE.anesthetized ? 'none' : 'block';
  if (eyesClosedEl) eyesClosedEl.style.display = STATE.anesthetized ? 'block' : 'none';

  // Contextual Suture Technique HUD (Steps 9 & 12)
  const sutureHud = document.getElementById('suture-guide-hud');
  if (STATE.step === 9) {
    sutureHud.classList.add('visible');
    sutureHud.innerHTML = `
      <div class="suture-badge-row">
        <span class="suture-spec-pill">Benang Absorbable (5-0 / 6-0)</span>
        <span class="suture-spec-pill">Teknik: Simple Interrupted</span>
        <span class="suture-spec-pill">Potong Sisa: 1–2 mm</span>
      </div>
      Otot sudah dirapatkan dengan Pinset. Jahit ketebalan otot merata di kedua sisi agar tidak terbentuk <strong>dead space</strong> dengan simpul ketegangan sedang.
    `;
  } else if (STATE.step === 12) {
    sutureHud.classList.add('visible');
    sutureHud.innerHTML = `
      <div class="suture-badge-row">
        <span class="suture-spec-pill">Non-Absorbable Nylon/Polypropylene (4-0 / 5-0)</span>
        <span class="suture-spec-pill">Jarak: 3–5 mm</span>
        <span class="suture-spec-pill">Ekor Benang: 3–4 mm</span>
      </div>
      Kulit sudah dirapatkan dengan Pinset. Tarik simpul hingga tepi kulit bertemu rata atau sedikit terangkat keluar (<strong>eversi</strong>).
    `;
  } else {
    sutureHud.classList.remove('visible');
  }

  // Action buttons in Pan Controls
  document.getElementById('btn-start-suture').style.display = (STATE.step === 7 && !STATE.inspectionOnlyMode) ? 'inline-block' : 'none';
  const showFinishBtn = ((STATE.step === 7 || STATE.step === 13) && !STATE.inspectionOnlyMode);
  document.getElementById('btn-finish-surgery').style.display = showFinishBtn ? 'inline-block' : 'none';

  // Hide suture needles if user chose Opsi A (inspection only, no suturing)
  const sutAbsCard = document.getElementById('tool-suture_abs');
  const sutNonAbsCard = document.getElementById('tool-suture_nonabs');
  if (sutAbsCard) sutAbsCard.style.display = STATE.inspectionOnlyMode ? 'none' : 'flex';
  if (sutNonAbsCard) sutNonAbsCard.style.display = STATE.inspectionOnlyMode ? 'none' : 'flex';

  // Pin targets visibility (Step 1: 4 paws, Step 4: place 2 skin pins, Step 10: remove 2 skin pins)
  document.querySelectorAll('.pin-target').forEach(el => {
    const pinKey = el.dataset.pin;
    if (['fl', 'fr', 'bl', 'br'].includes(pinKey)) {
      el.classList.toggle('visible', STATE.step === 1 && !STATE.pins[pinKey]);
    } else if (['sl', 'sr'].includes(pinKey)) {
      const showPlace = STATE.step === 4 && !STATE.pins[pinKey];
      const showRemove = STATE.step === 10 && STATE.pins[pinKey];
      el.classList.toggle('visible', showPlace || showRemove);
    }
  });

  Object.entries(STATE.pins).forEach(([key, placed]) => {
    const pinEl = document.getElementById('pin-' + key);
    if (pinEl) pinEl.style.display = placed ? 'block' : 'none';
  });

  // Flap closing targets visibility (Step 8: Close Muscle with Forceps, Step 11: Close Skin with Forceps)
  document.getElementById('close-muscle-left').classList.toggle('visible', STATE.step === 8 && !STATE.muscleClosed.left);
  document.getElementById('close-muscle-right').classList.toggle('visible', STATE.step === 8 && !STATE.muscleClosed.right);
  document.getElementById('close-skin-left').classList.toggle('visible', STATE.step === 11 && !STATE.skinClosed.left);
  document.getElementById('close-skin-right').classList.toggle('visible', STATE.step === 11 && !STATE.skinClosed.right);

  // Full Top-to-Bottom Incision Guide Line & Cut Progress
  const guideGroup = document.getElementById('incision-guide-group');
  const progLine = document.getElementById('incision-progress-line');
  if (STATE.step === 2 || STATE.step === 5) {
    guideGroup.style.display = 'block';
    const pct = STATE.step === 2 ? STATE.skinCutProgress : STATE.muscleCutProgress;
    const endY = 155 + (290 * (pct / 100));
    progLine.setAttribute('y2', endY.toFixed(1));
  } else {
    guideGroup.style.display = 'none';
  }

  // Skin layer transforms (stays open until Step 11 Forceps closure)
  const skinLeft = document.getElementById('skin-left');
  const skinRight = document.getElementById('skin-right');
  const skinSeam = document.getElementById('skin-seam');
  const isSkinLeftOpen = STATE.skinRetracted.left && !STATE.skinClosed.left;
  const isSkinRightOpen = STATE.skinRetracted.right && !STATE.skinClosed.right;
  skinSeam.style.display = (STATE.skinCut && !(STATE.skinClosed.left && STATE.skinClosed.right)) ? 'none' : 'block';
  skinLeft.setAttribute('transform', isSkinLeftOpen ? 'translate(-56, 0)' : '');
  skinRight.setAttribute('transform', isSkinRightOpen ? 'translate(56, 0)' : '');

  // Muscle layer transforms (stays open until Step 8 Forceps closure)
  const muscleLayer = document.getElementById('layer-muscle');
  muscleLayer.style.display = STATE.step >= 3 ? 'block' : 'none';
  const muscleLeft = document.getElementById('muscle-left');
  const muscleRight = document.getElementById('muscle-right');
  const muscleSeam = document.getElementById('muscle-seam');
  const isMuscleLeftOpen = STATE.muscleRetracted.left && !STATE.muscleClosed.left;
  const isMuscleRightOpen = STATE.muscleRetracted.right && !STATE.muscleClosed.right;
  muscleSeam.style.display = (STATE.muscleCut && !(STATE.muscleClosed.left && STATE.muscleClosed.right)) ? 'none' : 'block';
  muscleLeft.setAttribute('transform', isMuscleLeftOpen ? 'translate(-52, 0)' : '');
  muscleRight.setAttribute('transform', isMuscleRightOpen ? 'translate(52, 0)' : '');

  // Simple Interrupted Muscle Stitches & Targets (Step 9)
  document.querySelectorAll('[data-mstitch]').forEach(el => {
    const idx = Number(el.dataset.mstitch);
    el.classList.toggle('visible', STATE.step === 9 && !STATE.muscleStitches[idx]);
  });
  STATE.muscleStitches.forEach((done, idx) => {
    const stEl = document.getElementById('mstitch-' + idx);
    // Visible during Step 9, 10, 11 until skin covers it in Step 11/12
    const skinFullyClosed = STATE.skinClosed.left && STATE.skinClosed.right;
    if (stEl) stEl.style.display = (done && !skinFullyClosed) ? 'block' : 'none';
  });

  // Simple Interrupted Skin Stitches & Targets (Step 12 & 13)
  document.querySelectorAll('[data-sstitch]').forEach(el => {
    const idx = Number(el.dataset.sstitch);
    el.classList.toggle('visible', STATE.step === 12 && !STATE.skinStitches[idx]);
  });
  STATE.skinStitches.forEach((done, idx) => {
    const stEl = document.getElementById('sstitch-' + idx);
    if (stEl) stEl.style.display = done ? 'block' : 'none';
  });

  // Intestine shift
  const smallInt = document.getElementById('organ-small_intestine');
  smallInt.setAttribute('transform', STATE.intestineShifted ? 'translate(26, -6)' : '');

  // Organ extracted & selected states
  ORGANS.forEach(org => {
    if (org.id === 'reproductive') {
      const fEl = document.getElementById('organ-reproductive-female');
      const mEl = document.getElementById('organ-reproductive-male');
      [fEl, mEl].forEach(el => {
        if (!el) return;
        el.classList.toggle('extracted', STATE.extractedOrgans.includes('reproductive'));
        el.classList.toggle('selected', STATE.popupOrganId === 'reproductive');
      });
      return;
    }
    const el = document.getElementById('organ-' + org.id);
    if (!el) return;
    el.classList.toggle('extracted', STATE.extractedOrgans.includes(org.id));
    el.classList.toggle('selected', STATE.popupOrganId === org.id);
  });

  applySpecimenSex();
  renderDish();
  renderPopup();
  renderSpecimenIdentityPanel();
  if (t.closing) {
    const cBadge = document.getElementById('closing-badge');
    const cTitle = document.getElementById('closing-title');
    const cSub = document.getElementById('closing-subtitle');
    const cRefHead = document.getElementById('closing-reflection-heading');
    const cRefText = document.getElementById('closing-reflection-text');
    const cObjTitle = document.getElementById('closing-objects-title');
    const cObjGrid = document.getElementById('closing-objects-grid');

    if (cBadge) cBadge.textContent = t.closing.badge;
    if (cTitle) cTitle.innerHTML = t.closing.title;
    if (cSub) cSub.innerHTML = t.closing.subtitle;
    if (cRefHead) cRefHead.textContent = t.closing.reflectionHeading;
    if (cRefText) cRefText.innerHTML = t.closing.reflectionText;
    if (cObjTitle) cObjTitle.textContent = t.closing.objectsTitle;
    if (cObjGrid && Array.isArray(t.closing.objects)) {
      cObjGrid.innerHTML = t.closing.objects.map((item, idx) => {
        const spanStyle = idx === t.closing.objects.length - 1 ? ' style="grid-column: 1 / -1;"' : '';
        return `<div class="tool-summary-item"${spanStyle}><strong>${item[0]}</strong>${item[1]}</div>`;
      }).join('');
    }
  }
  scheduleAutoSave();
}

function renderSpecimenIdentityPanel() {
  const panel = document.getElementById('specimen-identity-panel');
  if (!panel) return;

  if (!STATE.selectedSpecimen || !STATE.selectedSpecimen.id) {
    panel.classList.remove('visible');
    return;
  }

  const idEl = document.getElementById('sip-id-value');
  const sexLabelEl = document.getElementById('sip-sex-label');
  const sexValEl = document.getElementById('sip-sex-value');

  const isEn = STATE.lang === 'en';
  const sexText = STATE.selectedSpecimen.sex === 'female'
    ? (isEn ? 'Female' : 'Betina')
    : (isEn ? 'Male' : 'Jantan');

  if (idEl) idEl.textContent = STATE.selectedSpecimen.id;
  if (sexLabelEl) sexLabelEl.textContent = isEn ? 'Sex:' : 'Jenis Kelamin:';
  if (sexValEl) sexValEl.textContent = sexText;

  panel.classList.add('visible');
}

function renderDish() {
  const grid = document.getElementById('dish-grid');
  grid.innerHTML = '';
  const t = I18N[STATE.lang];

  for (let i = 0; i < 8; i++) {
    const orgId = STATE.extractedOrgans[i];
    const slot = document.createElement('div');
    slot.className = 'dish-slot' + (orgId ? ' filled' : '') + (orgId && STATE.popupOrganId === orgId ? ' selected' : '');

    if (orgId) {
      const org = getOrganData(orgId);
      slot.dataset.organ = orgId;
      slot.innerHTML = `
        <div class="dish-slot-svg">${org.iconSvg}</div>
        <div class="dish-slot-label">${org.name[STATE.lang]}</div>
      `;
    } else {
      slot.innerHTML = `<div class="dish-slot-label" style="color:#94a3b8;font-weight:500;">${t.fields.emptySlot}</div>`;
    }
    grid.appendChild(slot);
  }
}

function renderPopup() {
  const popup = document.getElementById('organ-popup-box');
  const scrollBody = document.getElementById('popup-scroll-body');
  const t = I18N[STATE.lang];

  if (!STATE.popupOrganId) {
    popup.classList.remove('open');
    return;
  }

  const org = getOrganData(STATE.popupOrganId);
  if (!org) {
    popup.classList.remove('open');
    return;
  }

  document.getElementById('popup-organ-name').textContent = `${org.name.id} / ${org.name.en}`;
  document.getElementById('popup-organ-latin').textContent = org.latin;

  scrollBody.innerHTML = `
    <div class="popup-field">
      <div class="popup-field-label">${t.fields.name}</div>
      <p class="popup-field-text"><strong>${org.name.id}</strong> (ID) / <strong>${org.name.en}</strong> (EN) — <em>${org.latin}</em></p>
    </div>
    <div class="popup-field">
      <div class="popup-field-label">${t.fields.desc}</div>
      <p class="popup-field-text">${org.description[STATE.lang]}</p>
    </div>
    <div class="popup-field">
      <div class="popup-field-label">${t.fields.work}</div>
      <p class="popup-field-text">${org.howItWorks[STATE.lang]}</p>
    </div>
    <div class="popup-field">
      <div class="popup-field-label">${t.fields.func}</div>
      <p class="popup-field-text">${org.func[STATE.lang]}</p>
    </div>
    <div class="popup-field">
      <div class="popup-field-label">${t.fields.loc}</div>
      <p class="popup-field-text">${org.location[STATE.lang]}</p>
    </div>
    <div class="popup-field" style="margin-bottom: 2px;">
      <div class="popup-field-label">${t.fields.mech}</div>
      <div class="mech-visual-box">
        ${org.mechanismSvg}
        <div class="mech-caption">${org.mechanismCaption[STATE.lang]}</div>
      </div>
    </div>
  `;

  popup.classList.add('open');
}

const ttsAudioPlayer = new Audio();
ttsAudioPlayer.referrerPolicy = 'no-referrer';
let speechSessionId = 0;

function stopAllSpeech() {
  speechSessionId++;
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
  ttsAudioPlayer.onended = null;
  ttsAudioPlayer.onerror = null;
  ttsAudioPlayer.pause();
  ttsAudioPlayer.removeAttribute('src');
  ttsAudioPlayer.load();
}

function speakWithBrowserFallback(text, langCode) {
  if (!('speechSynthesis' in window)) {
    showToast('Text-to-Speech tidak didukung browser ini.');
    return;
  }
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = langCode;
  utter.rate = 0.92;
  utter.pitch = 1.0;
  window.speechSynthesis.speak(utter);
}

function playOnlineIndonesianTTS(text, mySessionId) {
  const cleanText = text.replace(/[:;–—]/g, ', ').replace(/\s+/g, ' ').trim();
  const words = cleanText.split(' ');
  const chunks = [];
  let cur = '';

  for (const w of words) {
    if ((cur + ' ' + w).trim().length <= 120) {
      cur = (cur + ' ' + w).trim();
    } else {
      if (cur) chunks.push(cur);
      cur = w;
    }
  }
  if (cur) chunks.push(cur);

  let idx = 0;
  function next() {
    if (mySessionId !== speechSessionId || idx >= chunks.length) return;

    ttsAudioPlayer.src = `https://translate.googleapis.com/translate_tts?ie=UTF-8&client=gtx&tl=id&q=${encodeURIComponent(chunks[idx])}`;
    ttsAudioPlayer.onended = () => {
      if (mySessionId !== speechSessionId) return;
      idx++;
      next();
    };
    ttsAudioPlayer.onerror = () => {
      if (mySessionId !== speechSessionId) return;
      speakWithBrowserFallback(text, 'id-ID');
    };
    ttsAudioPlayer.play().catch(() => {
      if (mySessionId !== speechSessionId) return;
      speakWithBrowserFallback(text, 'id-ID');
    });
  }
  next();
}

function toggleOrganPopup(orgId) {
  stopAllSpeech();
  if (STATE.popupOrganId === orgId) {
    STATE.popupOrganId = null;
  } else {
    STATE.popupOrganId = orgId;
  }
  updateUI();
}

function speakOrgan() {
  if (!STATE.popupOrganId) return;
  stopAllSpeech();
  const mySessionId = speechSessionId;

  const org = getOrganData(STATE.popupOrganId);
  if (!org) return;

  const isIndo = STATE.lang === 'id';
  const text = isIndo
    ? `${org.name.id}, nama latin ${org.latin}. Deskripsi: ${org.description.id} Cara kerja: ${org.howItWorks.id} Fungsi: ${org.func.id} Tempatnya: ${org.location.id}`
    : `${org.name.en}, Latin name ${org.latin}. Description: ${org.description.en} How it works: ${org.howItWorks.en} Function: ${org.func.en} Location: ${org.location.en}`;

  if (isIndo) {
    playOnlineIndonesianTTS(text, mySessionId);
  } else {
    speakWithBrowserFallback(text, 'en-US');
  }
}

/* SUTURE WORKFLOW & LARGE CHOICE-REASON-CONSEQUENCE MODAL */
document.getElementById('btn-start-suture').addEventListener('click', () => {
  if (STATE.extractedOrgans.length < 8) {
    document.getElementById('sq-count').textContent = `${STATE.extractedOrgans.length} / 8`;
    document.getElementById('suture-question-modal').classList.add('open');
  } else {
    enterSuturingMode(false);
  }
});

document.getElementById('btn-sq-inspect').addEventListener('click', () => {
  STATE.inspectionOnlyMode = true;
  STATE.sutureModeActive = false;
  document.getElementById('suture-question-modal').classList.remove('open');
  setTool('forceps');
  updateUI();
  showToast('Opsi A dipilih: Pindahkan seluruh 8 organ ke wadah spesimen kanan (proses penjahitan dinonaktifkan).');
});

document.getElementById('btn-sq-suture').addEventListener('click', () => {
  STATE.inspectionOnlyMode = false;
  document.getElementById('suture-question-modal').classList.remove('open');
  enterSuturingMode(true);
});

function enterSuturingMode(skippedInspection) {
  STATE.extractedOrgans = [];
  STATE.popupOrganId = null;
  STATE.intestineShifted = false;
  document.getElementById('btn-shift-intestine').classList.remove('active');
  STATE.sutureModeActive = skippedInspection;
  STATE.pins.sl = true;
  STATE.pins.sr = true;
  STATE.muscleClosed = { left: false, right: false };
  STATE.skinClosed = { left: false, right: false };
  STATE.step = 8;
  setTool('forceps');
  updateUI();
  showToast('Tahap 8: Gunakan Pinset terlebih dahulu untuk merapatkan dinding otot kiri & kanan ke tengah.');
}

/* HANDLER TOMBOL "SELESAI & LEPAS FIKSASI" */
document.getElementById('btn-finish-surgery').addEventListener('click', () => {
  if (STATE.step >= 8 && STATE.step < 13) {
    // Jika masih dalam proses penutupan/penjahitan (Tahap 8-12), jaga seluruh jarum tetap terpasang
    showToast('Selesaikan seluruh tahap penutupan dan penjahitan otot & kulit terlebih dahulu sebelum melepas fiksasi!');
    return;
  }

  if (STATE.step === 13) {
    // Tahap 13: Penjahitan selesai -> lepas 4 fiksasi kaki secara sah & tampilkan modal closing
    STATE.pins = { fl: false, fr: false, bl: false, br: false, sl: false, sr: false };
    updateUI();
    showToast('Jarum penahan keempat kaki dilepas. Praktikum selesai!');
    setTimeout(() => {
      document.getElementById('closing-practicum-modal').classList.add('open');
    }, 450);
    return;
  }

  if (STATE.step < 8) {
    STATE.anesthetized = false;
    STATE.pins = { fl: false, fr: false, bl: false, br: false, sl: false, sr: false };
    updateUI();
    const vp = document.getElementById('specimen-viewport');
    vp.classList.add('specimen-escaping');
    setTimeout(() => {
      document.getElementById('awake-escape-modal').classList.add('open');
    }, 650);
  }
});

document.getElementById('btn-recatch-mouse').addEventListener('click', () => {
  document.getElementById('awake-escape-modal').classList.remove('open');
  document.getElementById('specimen-viewport').classList.remove('specimen-escaping');
  resetAllSurgicalState();
  openWanderingMiceCage();
});

document.getElementById('btn-resume-suture-after-wake').addEventListener('click', () => {
  document.getElementById('awake-escape-modal').classList.remove('open');
  document.getElementById('specimen-viewport').classList.remove('specimen-escaping');
  STATE.anesthetized = true;
  STATE.pins.fl = true;
  STATE.pins.fr = true;
  STATE.pins.bl = true;
  STATE.pins.br = true;
  if (STATE.step < 8) {
    enterSuturingMode(true);
  } else {
    setTool(getRecommendedTool());
    updateUI();
  }
  showToast('Mencit kembali terbius & terfiksasi. Selesaikan penutupan dan penjahitan berlapis!');
});

/* Pointer Drag & Drop System (Mouse & Touch Unified) */
const ghost = document.getElementById('tool-ghost');

function updateGhostPosition(x, y) {
  ghost.style.left = x + 'px';
  ghost.style.top = y + 'px';
}

function getSvgPoint(clientX, clientY) {
  const svg = document.getElementById('specimen-svg');
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  return pt.matrixTransform(ctm.inverse());
}

// Start dragging a tool from the left tray
document.querySelectorAll('.tool-card').forEach(card => {
  card.addEventListener('pointerdown', e => {
    const tool = card.dataset.tool;
    setTool(tool);
    STATE.drag = {
      active: true,
      mode: 'tool',
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      organId: null,
      incisionStartedTop: false,
      incisionMaxY: 155
    };
    ghost.innerHTML = card.querySelector('.tool-icon').innerHTML;
    updateGhostPosition(e.clientX, e.clientY);
  });
});

// Start dragging or clicking inside the dissecting pan
const waxBed = document.getElementById('wax-bed');
waxBed.addEventListener('pointerdown', e => {
  const organEl = e.target.closest('.organ-node');
  if (STATE.step === 7 && organEl) {
    const orgId = organEl.dataset.organ;
    STATE.drag = {
      active: true,
      mode: 'extract',
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      organId: orgId,
      incisionStartedTop: false,
      incisionMaxY: 155
    };
    return;
  }

  const pt = getSvgPoint(e.clientX, e.clientY);
  const startedAtTop = Math.abs(pt.x - 250) < 28 && pt.y >= 140 && pt.y <= 185;

  STATE.drag = {
    active: true,
    mode: 'tool',
    startX: e.clientX,
    startY: e.clientY,
    moved: false,
    organId: null,
    incisionStartedTop: startedAtTop,
    incisionMaxY: startedAtTop ? pt.y : 155
  };
  const activeCard = document.querySelector(`.tool-card[data-tool="${STATE.activeTool}"]`);
  if (activeCard) {
    ghost.innerHTML = activeCard.querySelector('.tool-icon').innerHTML;
  }
  updateGhostPosition(e.clientX, e.clientY);

  // Check immediate hold over snout for chloroform anesthesia
  if (STATE.step === 0 && STATE.activeTool === 'chloroform') {
    if (Math.hypot(pt.x - 250, pt.y - 48) < 42) {
      ghost.style.display = 'block';
      startAnesthesiaHold();
    }
  }
});

// Start dragging or clicking an organ inside the right white specimen box
const dishGrid = document.getElementById('dish-grid');
dishGrid.addEventListener('pointerdown', e => {
  const slot = e.target.closest('.dish-slot.filled');
  if (!slot) return;
  const orgId = slot.dataset.organ;
  STATE.drag = {
    active: true,
    mode: 'return',
    startX: e.clientX,
    startY: e.clientY,
    moved: false,
    organId: orgId,
    incisionStartedTop: false,
    incisionMaxY: 155
  };
});

dishGrid.addEventListener('click', e => {
  const slot = e.target.closest('.dish-slot.filled');
  if (!slot) return;
  const orgId = slot.dataset.organ;
  if (orgId) {
    STATE.drag.active = false;
    STATE.drag.moved = false;
    ghost.style.display = 'none';
    toggleOrganPopup(orgId);
  }
});

const toolListEl = document.getElementById('tool-list');
if (toolListEl) {
  toolListEl.addEventListener('scroll', () => {
    if (STATE.drag.active && STATE.drag.mode === 'tool' && !STATE.drag.moved) {
      cleanupActiveDragState();
    }
  }, { passive: true });
}

if (dishGrid) {
  dishGrid.addEventListener('scroll', () => {
    if (STATE.drag.active && STATE.drag.mode === 'return' && !STATE.drag.moved) {
      cleanupActiveDragState();
    }
  }, { passive: true });
}

window.addEventListener('pointermove', e => {
  if (!STATE.drag.active) return;
  const dist = Math.hypot(e.clientX - STATE.drag.startX, e.clientY - STATE.drag.startY);
  if (dist >= 10) {
    STATE.drag.moved = true;
    ghost.style.display = 'block';
    updateGhostPosition(e.clientX, e.clientY);

    if (STATE.drag.mode === 'extract') {
      const org = getOrganData(STATE.drag.organId);
      ghost.innerHTML = `<div style="padding:6px 10px;background:#fff;color:#0f172a;border:2px solid ${org.color};border-radius:8px;font-size:12px;font-weight:700;">${org.name[STATE.lang]}</div>`;
      document.getElementById('specimen-dish').classList.add('drop-highlight');
    } else if (STATE.drag.mode === 'return') {
      const org = getOrganData(STATE.drag.organId);
      ghost.innerHTML = `<div style="padding:6px 10px;background:#fff;color:#0f172a;border:2px solid ${org.color};border-radius:8px;font-size:12px;font-weight:700;">↩ ${org.name[STATE.lang]}</div>`;
      waxBed.classList.add('drop-highlight');
    } else if (STATE.drag.mode === 'tool') {
      handleToolDragOverPan(e.clientX, e.clientY);
    }
  } else if (STATE.drag.mode === 'tool' && STATE.step === 0) {
    handleToolDragOverPan(e.clientX, e.clientY);
  }
});

function cleanupActiveDragState() {
  stopAnesthesiaHold();
  if (ghost) ghost.style.display = 'none';
  const dishEl = document.getElementById('specimen-dish');
  if (dishEl) dishEl.classList.remove('drop-highlight');
  if (waxBed) waxBed.classList.remove('drop-highlight');
  STATE.drag.active = false;
  STATE.drag.moved = false;
  STATE.drag.organId = null;
  STATE.drag.incisionStartedTop = false;
}

window.addEventListener('pointercancel', () => {
  if (!STATE.drag.active) return;
  cleanupActiveDragState();
});

window.addEventListener('blur', () => {
  if (!STATE.drag.active) return;
  cleanupActiveDragState();
});

window.addEventListener('pointerup', e => {
  stopAnesthesiaHold();
  if (!STATE.drag.active) return;
  ghost.style.display = 'none';
  document.getElementById('specimen-dish').classList.remove('drop-highlight');
  waxBed.classList.remove('drop-highlight');

  const { mode, moved, organId } = STATE.drag;
  STATE.drag.active = false;

  // Reset incomplete top-to-bottom incision if released early
  if (STATE.step === 2 && !STATE.skinCut && STATE.skinCutProgress > 0 && STATE.skinCutProgress < 100) {
    STATE.skinCutProgress = 0;
    updateUI();
    showToast('Sayatan kulit harus ditarik penuh dari titik atas sampai titik bawah!');
    return;
  }
  if (STATE.step === 5 && !STATE.muscleCut && STATE.muscleCutProgress > 0 && STATE.muscleCutProgress < 100) {
    STATE.muscleCutProgress = 0;
    updateUI();
    showToast('Sayatan otot harus ditarik penuh dari titik atas sampai titik bawah!');
    return;
  }

 // Click/tap without drag (< 10px): support tapping targets in Steps 8, 9, 10, 11, 12
  if (!moved) {
    if (mode === 'tool' && [8, 9, 10, 11, 12].includes(STATE.step)) {
      handleToolDragOverPan(e.clientX, e.clientY);
      return;
    }
    if (mode === 'extract' && organId && STATE.step === 7) {
      showToast(STATE.lang === 'id'
        ? 'Gunakan Pinset untuk menyeret organ ke wadah putih di kanan, lalu klik gambar organ di sana.'
        : 'Use Forceps to drag the organ into the right white box, then click its image there.');
    }
    return;
  }

  // Drag release: Extract organ to right white dish
  if (mode === 'extract' && organId) {
    if (STATE.activeTool !== 'forceps') {
      showToast(STATE.lang === 'id' ? 'Gunakan Pinset untuk memindahkan organ ke Wadah Spesimen!' : 'Select Forceps to move organs into the Specimen Box!');
      return;
    }
    const dishRect = document.getElementById('specimen-dish').getBoundingClientRect();
    if (e.clientX >= dishRect.left && e.clientX <= dishRect.right && e.clientY >= dishRect.top && e.clientY <= dishRect.bottom) {
      if (!STATE.extractedOrgans.includes(organId)) {
        STATE.extractedOrgans.push(organId);
        if (STATE.inspectionOnlyMode && STATE.extractedOrgans.length === 8) {
          STATE.step = 13;
          updateUI();
          showToast(STATE.lang === 'id'
            ? 'Seluruh 8 organ selesai dipindahkan & diinspeksi! Praktikum inspeksi tuntas (tanpa penjahitan).'
            : 'All 8 organs extracted & inspected! Inspection practicum complete.');
          setTimeout(() => document.getElementById('closing-practicum-modal').classList.add('open'), 700);
        } else {
          updateUI();
          showToast(STATE.lang === 'id'
            ? 'Organ dipindahkan! Klik gambar organ di wadah putih untuk melihat detailnya.'
            : 'Organ placed! Click the organ image in the white box to view details.');
        }
      }
    }
    return;
  }

  // Drag release: Return organ from right white dish back to body
  if (mode === 'return' && organId) {
    const panRect = waxBed.getBoundingClientRect();
    if (e.clientX >= panRect.left && e.clientX <= panRect.right && e.clientY >= panRect.top && e.clientY <= panRect.bottom) {
      STATE.extractedOrgans = STATE.extractedOrgans.filter(id => id !== organId);
      if (STATE.popupOrganId === organId) {
        STATE.popupOrganId = null;
      }
      updateUI();
    }
  }
});

function handleToolDragOverPan(clientX, clientY) {
  const panRect = waxBed.getBoundingClientRect();
  if (clientX < panRect.left || clientX > panRect.right || clientY < panRect.top || clientY > panRect.bottom) {
    stopAnesthesiaHold();
    return;
  }

  const pt = getSvgPoint(clientX, clientY);
  const tool = STATE.activeTool;

  // Step 0: Chloroform Anesthesia at Mouse Snout
  if (STATE.step === 0) {
    if (tool !== 'chloroform') return;
    if (Math.hypot(pt.x - 250, pt.y - 48) < 42) {
      startAnesthesiaHold();
    } else {
      stopAnesthesiaHold();
    }
    return;
  }

  // Step 1: Pins on 4 paws (only allowed after anesthesia!)
  if (STATE.step === 1) {
    if (!STATE.anesthetized) {
      showToast('Bius mencit terlebih dahulu dengan Kapas Kloroform!');
      return;
    }
    if (tool !== 'pins') return;
    const coords = {
      fl: [115, 142],
      fr: [385, 142],
      bl: [108, 466],
      br: [392, 466]
    };
    for (const [limb, [cx, cy]] of Object.entries(coords)) {
      if (!STATE.pins[limb] && Math.hypot(pt.x - cx, pt.y - cy) < 28) {
        STATE.pins[limb] = true;
        if (['fl', 'fr', 'bl', 'br'].every(k => STATE.pins[k])) {
          STATE.step = 2;
          setTool('scalpel');
          showToast('Fiksasi kaki selesai! Lanjut menyayat kulit penuh dari atas ke bawah.');
        }
        updateUI();
        break;
      }
    }
    return;
  }

  // Step 2: Full top-to-bottom scalpel skin incision (Y: 155 -> 445)
  if (STATE.step === 2) {
    if (tool !== 'scalpel') return;
    if (Math.abs(pt.x - 250) < 26) {
      if (!STATE.drag.incisionStartedTop && pt.y >= 145 && pt.y <= 185) {
        STATE.drag.incisionStartedTop = true;
        STATE.drag.incisionMaxY = pt.y;
      }
      if (STATE.drag.incisionStartedTop && pt.y >= STATE.drag.incisionMaxY - 12) {
        STATE.drag.incisionMaxY = Math.max(STATE.drag.incisionMaxY, Math.min(445, pt.y));
        STATE.skinCutProgress = Math.min(100, Math.max(0, ((STATE.drag.incisionMaxY - 155) / (440 - 155)) * 100));
        if (STATE.drag.incisionMaxY >= 438) {
          STATE.skinCutProgress = 100;
          STATE.skinCut = true;
          STATE.step = 3;
          setTool('forceps');
          showToast('Kulit tersayat penuh! Gunakan Pinset untuk membuka lipatan kulit.');
        }
        updateUI();
      }
    }
    return;
  }

  // Step 3: Forceps retract skin flaps
  if (STATE.step === 3) {
    if (tool !== 'forceps') return;
    if (!STATE.skinRetracted.left && pt.x >= 165 && pt.x <= 245 && pt.y >= 170 && pt.y <= 430) {
      STATE.skinRetracted.left = true;
      checkStep3Complete();
      updateUI();
    } else if (!STATE.skinRetracted.right && pt.x >= 255 && pt.x <= 335 && pt.y >= 170 && pt.y <= 430) {
      STATE.skinRetracted.right = true;
      checkStep3Complete();
      updateUI();
    }
    return;
  }

  // Step 4: Pin retracted skin flaps (left & right)
  if (STATE.step === 4) {
    if (tool !== 'pins') return;
    const flapCoords = {
      sl: [155, 300],
      sr: [345, 300]
    };
    for (const [key, [cx, cy]] of Object.entries(flapCoords)) {
      if (!STATE.pins[key] && Math.hypot(pt.x - cx, pt.y - cy) < 30) {
        STATE.pins[key] = true;
        if (STATE.pins.sl && STATE.pins.sr) {
          STATE.step = 5;
          setTool('scissors');
          showToast('Lipatan kulit terfiksasi jarum pentul! Lanjut menyayat otot dari atas ke bawah.');
        }
        updateUI();
        break;
      }
    }
    return;
  }

  // Step 5: Full top-to-bottom surgical scissors muscle incision (Y: 155 -> 445)
  if (STATE.step === 5) {
    if (tool !== 'scissors') return;
    if (Math.abs(pt.x - 250) < 26) {
      if (!STATE.drag.incisionStartedTop && pt.y >= 145 && pt.y <= 185) {
        STATE.drag.incisionStartedTop = true;
        STATE.drag.incisionMaxY = pt.y;
      }
      if (STATE.drag.incisionStartedTop && pt.y >= STATE.drag.incisionMaxY - 12) {
        STATE.drag.incisionMaxY = Math.max(STATE.drag.incisionMaxY, Math.min(445, pt.y));
        STATE.muscleCutProgress = Math.min(100, Math.max(0, ((STATE.drag.incisionMaxY - 155) / (440 - 155)) * 100));
        if (STATE.drag.incisionMaxY >= 438) {
          STATE.muscleCutProgress = 100;
          STATE.muscleCut = true;
          STATE.step = 6;
          setTool('forceps');
          showToast('Otot tersayat penuh! Gunakan Pinset untuk menyibak dinding otot.');
        }
        updateUI();
      }
    }
    return;
  }

  // Step 6: Forceps retract muscle flaps
  if (STATE.step === 6) {
    if (tool !== 'forceps') return;
    if (!STATE.muscleRetracted.left && pt.x >= 175 && pt.x <= 245 && pt.y >= 170 && pt.y <= 430) {
      STATE.muscleRetracted.left = true;
      checkStep6Complete();
      updateUI();
    } else if (!STATE.muscleRetracted.right && pt.x >= 255 && pt.x <= 325 && pt.y >= 170 && pt.y <= 430) {
      STATE.muscleRetracted.right = true;
      checkStep6Complete();
      updateUI();
    }
    return;
  }

  // Step 8: Close muscle walls with Forceps BEFORE suturing muscle
  if (STATE.step === 8) {
    if (tool !== 'forceps') return;
    if (!STATE.muscleClosed.left && pt.x >= 135 && pt.x <= 230 && pt.y >= 180 && pt.y <= 420) {
      STATE.muscleClosed.left = true;
      checkStep8Complete();
      updateUI();
    } else if (!STATE.muscleClosed.right && pt.x >= 270 && pt.x <= 365 && pt.y >= 180 && pt.y <= 420) {
      STATE.muscleClosed.right = true;
      checkStep8Complete();
      updateUI();
    }
    return;
  }

  // Step 9: Simple Interrupted Muscle Suturing (Absorbable 5-0/6-0, 5 nodes)
  if (STATE.step === 9) {
    if (tool !== 'suture_abs') return;
    const mYs = [195, 245, 295, 345, 395];
    for (let i = 0; i < mYs.length; i++) {
      if (!STATE.muscleStitches[i] && Math.hypot(pt.x - 250, pt.y - mYs[i]) < 24) {
        STATE.muscleStitches[i] = true;
        if (STATE.muscleStitches.every(Boolean)) {
          STATE.step = 10;
          setTool('pins');
          showToast('Otot selesai dijahit! Sekarang ambil/cabut 2 Jarum Pentul yang menancap pada lipatan kulit.');
        }
        updateUI();
        break;
      }
    }
    return;
  }

 // Step 10: Remove the 2 Dissecting Pins holding the skin flaps
  if (STATE.step === 10) {
    if (tool !== 'pins' && tool !== 'forceps') {
      showToast('Pilih Jarum Pentul atau Pinset untuk mencabut jarum pada lipatan kulit!');
      return;
    }
    const flapCoords = {
      sl: [155, 300],
      sr: [345, 300]
    };
    for (const [key, [cx, cy]] of Object.entries(flapCoords)) {
      if (STATE.pins[key] && Math.hypot(pt.x - cx, pt.y - cy) < 42) {
        STATE.pins[key] = false;
        // Pastikan 4 jarum fiksasi kaki tetap terpasang sampai tahap akhir
        STATE.pins.fl = true;
        STATE.pins.fr = true;
        STATE.pins.bl = true;
        STATE.pins.br = true;
        if (!STATE.pins.sl && !STATE.pins.sr) {
          STATE.step = 11;
          setTool('forceps');
          showToast('Kedua jarum pentul kulit tercabut! Gunakan Pinset untuk merapatkan lipatan kulit ke tengah.');
        } else {
          showToast('1 jarum pentul kulit tercabut! Cabut 1 jarum pentul kulit lagi.');
        }
        updateUI();
        break;
      }
    }
    return;
  }

  // Step 11: Close skin flaps with Forceps BEFORE suturing skin
  if (STATE.step === 11) {
    if (tool !== 'forceps') return;
    if (!STATE.skinClosed.left && pt.x >= 125 && pt.x <= 230 && pt.y >= 170 && pt.y <= 430) {
      STATE.skinClosed.left = true;
      checkStep11Complete();
      updateUI();
    } else if (!STATE.skinClosed.right && pt.x >= 270 && pt.x <= 375 && pt.y >= 170 && pt.y <= 430) {
      STATE.skinClosed.right = true;
      checkStep11Complete();
      updateUI();
    }
    return;
  }

  // Step 12: Simple Interrupted Skin Suturing (Non-absorbable 4-0/5-0 Nylon/Polypropylene, 6 nodes)
  if (STATE.step === 12) {
    if (tool !== 'suture_nonabs') return;
    const sYs = [180, 222, 264, 306, 348, 390];
    for (let i = 0; i < sYs.length; i++) {
      if (!STATE.skinStitches[i] && Math.hypot(pt.x - 250, pt.y - sYs[i]) < 22) {
        STATE.skinStitches[i] = true;
        if (STATE.skinStitches.every(Boolean)) {
          STATE.step = 13;
          showToast('Penjahitan kulit selesai (eversi rata, jarak 3–5 mm, ekor benang 3–4 mm)! Praktikum tuntas.');
          setTimeout(() => {
            document.getElementById('closing-practicum-modal').classList.add('open');
          }, 700);
        }
        updateUI();
        break;
      }
    }
  }
}

function checkStep3Complete() {
  if (STATE.skinRetracted.left && STATE.skinRetracted.right) {
    STATE.step = 4;
    setTool('pins');
    showToast('Lipatan kulit terbuka! Sematkan Jarum Pentul pada kedua lipatan kulit.');
  }
}

function checkStep6Complete() {
  if (STATE.muscleRetracted.left && STATE.muscleRetracted.right) {
    STATE.step = 7;
    setTool('forceps');
    updateUI();
    document.getElementById('sq-count').textContent = `${STATE.extractedOrgans.length} / 8`;
    document.getElementById('suture-question-modal').classList.add('open');
  }
}

function checkStep8Complete() {
  if (STATE.muscleClosed.left && STATE.muscleClosed.right) {
    STATE.step = 9;
    setTool('suture_abs');
    showToast('Dinding otot sudah dirapatkan! Gunakan Benang Absorbable (5-0/6-0) untuk menjahit otot.');
  }
}

function checkStep11Complete() {
  if (STATE.skinClosed.left && STATE.skinClosed.right) {
    STATE.step = 12;
    setTool('suture_nonabs');
    showToast('Lipatan kulit sudah dirapatkan! Gunakan Benang Non-Absorbable (4-0/5-0) untuk menjahit kulit.');
  }
}

function resetAllSurgicalState() {
  stopAllSpeech();
  stopAnesthesiaHold();
  if (cageAnimId) {
    cancelAnimationFrame(cageAnimId);
    cageAnimId = null;
  }
  clearHoldTimerAndTooltip();

  PRACTICUM_STORAGE.isRestoring = true;
  try {
    STATE.sex = 'female';
    STATE.step = 0;
    STATE.anesthesiaProgress = 0;
    STATE.anesthetized = false;
    STATE.cageSpecimens = [];
    STATE.selectedSpecimen = null;
    STATE.cageLocked = false;
    cageMice = [];
    heldMouseIdx = -1;
    activeCagePointerId = null;
    holdMouseElapsed = 0;
    STATE.pins = { fl: false, fr: false, bl: false, br: false, sl: false, sr: false };
    STATE.skinCutProgress = 0;
    STATE.skinCut = false;
    STATE.skinRetracted = { left: false, right: false };
    STATE.skinClosed = { left: false, right: false };
    STATE.muscleCutProgress = 0;
    STATE.muscleCut = false;
    STATE.muscleRetracted = { left: false, right: false };
    STATE.muscleClosed = { left: false, right: false };
    STATE.intestineShifted = false;
    STATE.extractedOrgans = [];
    STATE.popupOrganId = null;
    STATE.sutureModeActive = false;
    STATE.inspectionOnlyMode = false;
    STATE.muscleStitches = [false, false, false, false, false];
    STATE.skinStitches = [false, false, false, false, false, false];
    STATE.zoom = 1;

    const shiftBtn = document.getElementById('btn-shift-intestine');
    if (shiftBtn) shiftBtn.classList.remove('active');

    const vp = document.getElementById('specimen-viewport');
    if (vp) vp.classList.remove('specimen-escaping');

    applyZoom();
    setTool('chloroform');
    applySpecimenSex();
    updateUI();
  } finally {
    PRACTICUM_STORAGE.isRestoring = false;
  }
}

function openResetConfirmationModal(source) {
  const modal = document.getElementById('confirm-reset-modal');
  const titleEl = document.getElementById('crm-title');
  const bodyEl = document.getElementById('crm-body');
  if (!modal) return;

  if (source === 'restart') {
    if (titleEl) titleEl.textContent = 'Ulangi Praktikum dari Awal?';
    if (bodyEl) {
      bodyEl.textContent = 'Hasil praktikum pada sesi ini akan dibersihkan dan aplikasi akan kembali ke layar awal untuk memulai sesi baru. Apakah Anda yakin ingin mengulangi praktikum?';
    }
  } else {
    if (titleEl) titleEl.textContent = 'Atur Ulang Sesi Praktikum?';
    if (bodyEl) {
      bodyEl.textContent = 'Seluruh perkembangan praktikum saat ini, data tahapan, dan pilihan mencit akan dihapus dan dikembalikan ke layar awal. Apakah Anda yakin ingin melanjutkan?';
    }
  }

  modal.classList.add('open');
}

function executeFullSessionReset() {
  // 1. Hapus seluruh data sesi tersimpan dari localStorage
  if (typeof SPOTLIGHT_TUTORIAL !== 'undefined' && typeof SPOTLIGHT_TUTORIAL.abort === 'function') {
    SPOTLIGHT_TUTORIAL.abort();
  }
  clearSavedSession();

  // 2. Sembunyikan gambar mencit terakhir dari baki pembedahan
  document.body.classList.add('specimen-hidden-on-reset');

  // 3. Tutup seluruh modal lain yang mungkin sedang terbuka
  [
    'confirm-reset-modal',
    'closing-practicum-modal',
    'intro-setup-modal',
    'cage-capture-modal',
    'mouse-confirm-modal',
    'awake-escape-modal',
    'suture-question-modal',
    'guide-modal'
  ].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('open');
  });

  // 4. Bersihkan seluruh progres, status bedah, dan identitas spesimen terpilih
  resetAllSurgicalState();

  // 5. Kembalikan ke halaman intro awal siap untuk sesi baru
  if (typeof window.resetTouchScannerModal === 'function') {
    window.resetTouchScannerModal();
  }
  const authModal = document.getElementById('touch-auth-modal');
  if (authModal) {
    authModal.classList.add('open');
  }

  showToast('Sesi praktikum berhasil diatur ulang. Silakan mulai dari layar awal.');
}

/* Header, Pop-Up & Pan Buttons */
document.getElementById('btn-lang').addEventListener('click', () => {
  stopAllSpeech();
  STATE.lang = STATE.lang === 'id' ? 'en' : 'id';
  updateUI();
});

document.getElementById('btn-reset').addEventListener('click', () => {
  openResetConfirmationModal('reset');
});

document.getElementById('btn-cancel-reset').addEventListener('click', () => {
  const modal = document.getElementById('confirm-reset-modal');
  if (modal) modal.classList.remove('open');
});

document.getElementById('btn-confirm-reset').addEventListener('click', () => {
  executeFullSessionReset();
});

document.getElementById('btn-shift-intestine').addEventListener('click', () => {
  if (STATE.step < 7 || STATE.step >= 8) {
    showToast('Tombol geser usus hanya dapat digunakan saat rongga tubuh terbuka pada tahap pengamatan organ.');
    return;
  }
  STATE.intestineShifted = !STATE.intestineShifted;
  document.getElementById('btn-shift-intestine').classList.toggle('active', STATE.intestineShifted);
  updateUI();
});

function applyZoom() {
  const vp = document.getElementById('specimen-viewport');
  vp.setAttribute('transform', `translate(250, 290) scale(${STATE.zoom}) translate(-250, -290)`);
}

document.getElementById('btn-zoom-in').addEventListener('click', () => {
  STATE.zoom = Math.min(2.0, +(STATE.zoom + 0.25).toFixed(2));
  applyZoom();
});

document.getElementById('btn-zoom-out').addEventListener('click', () => {
  STATE.zoom = Math.max(1.0, +(STATE.zoom - 0.25).toFixed(2));
  applyZoom();
});

document.getElementById('btn-zoom-reset').addEventListener('click', () => {
  STATE.zoom = 1;
  applyZoom();
});

/* Pinch-to-Zoom (Two-Finger Spread / Pinch on Dissecting Pan) */
let pinchStartDist = 0;
let pinchStartZoom = 1;

waxBed.addEventListener('touchstart', e => {
  if (e.touches.length === 2) {
    STATE.drag.active = false;
    stopAnesthesiaHold(); // Menghentikan timer pembiusan jika user mulai pinch-zoom
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    pinchStartDist = Math.hypot(dx, dy);
    pinchStartZoom = STATE.zoom;
  }
}, { passive: true });

waxBed.addEventListener('touchmove', e => {
  if (e.touches.length === 2 && pinchStartDist > 0) {
    e.preventDefault();
    const currentDist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    const scaleRatio = currentDist / pinchStartDist;
    STATE.zoom = Math.min(2.25, Math.max(1.0, +(pinchStartZoom * scaleRatio).toFixed(2)));
    applyZoom();
  }
}, { passive: false });

waxBed.addEventListener('touchend', e => {
  if (e.touches.length < 2) {
    pinchStartDist = 0;
  }
});

document.getElementById('btn-tts').addEventListener('click', speakOrgan);

document.getElementById('btn-close-popup').addEventListener('click', () => {
  stopAllSpeech();
  STATE.popupOrganId = null;
  updateUI();
});

document.getElementById('organ-popup-box').addEventListener('click', e => {
  if (e.target.closest('#btn-tts')) return;
  stopAllSpeech();
  STATE.popupOrganId = null;
  updateUI();
});

document.getElementById('btn-guide').addEventListener('click', () => {
  document.getElementById('guide-modal').classList.add('open');
});

document.getElementById('btn-close-guide').addEventListener('click', () => {
  document.getElementById('guide-modal').classList.remove('open');
});

// Initialize
document.getElementById('btn-close-closing-view').addEventListener('click', () => {
  document.getElementById('closing-practicum-modal').classList.remove('open');
});

document.getElementById('btn-restart-from-closing').addEventListener('click', () => {
  openResetConfirmationModal('restart');
});
function restorePracticumSession() {
  const result = validateAndReadSavedSession();

  if (result.status === 'unavailable' || result.status === 'empty') {
    setTool('chloroform');
    applySpecimenSex();
    updateUI();
    return false;
  }

  if (result.status === 'corrupt' || result.status === 'version_mismatch') {
    clearSavedSession();
    setTool('chloroform');
    applySpecimenSex();
    updateUI();
    const msg = result.status === 'version_mismatch'
      ? 'Format sesi lama berbeda versi. Memulai sesi praktikum baru.'
      : 'Data sesi tersimpan rusak dan tidak dapat dipulihkan. Memulai sesi baru.';
    showToast(msg);
    return false;
  }

  const d = result.data;
  PRACTICUM_STORAGE.isRestoring = true;
  try {
    STATE.lang = d.lang;
    STATE.sex = d.sex;
    STATE.step = d.step;
    STATE.anesthesiaProgress = d.anesthesiaProgress;
    STATE.anesthetized = d.anesthetized;
    STATE.cageCapacity = d.cageCapacity;
    STATE.cageSpecimens = d.cageSpecimens;
    STATE.selectedSpecimen = d.selectedSpecimen;
    STATE.cageLocked = false;
    STATE.pins = { ...d.pins };
    STATE.skinCutProgress = d.skinCutProgress;
    STATE.skinCut = d.skinCut;
    STATE.skinRetracted = { ...d.skinRetracted };
    STATE.skinClosed = { ...d.skinClosed };
    STATE.muscleCutProgress = d.muscleCutProgress;
    STATE.muscleCut = d.muscleCut;
    STATE.muscleRetracted = { ...d.muscleRetracted };
    STATE.muscleClosed = { ...d.muscleClosed };
    STATE.intestineShifted = d.intestineShifted;
    STATE.extractedOrgans = [...d.extractedOrgans];
    STATE.popupOrganId = null;
    STATE.sutureModeActive = d.sutureModeActive;
    STATE.inspectionOnlyMode = d.inspectionOnlyMode;
    STATE.muscleStitches = [...d.muscleStitches];
    STATE.skinStitches = [...d.skinStitches];

    const restoredTool = (d.activeTool && document.getElementById('tool-' + d.activeTool))
      ? d.activeTool
      : getRecommendedTool();
    setTool(restoredTool);
    applySpecimenSex();
    updateUI();

    const shiftBtn = document.getElementById('btn-shift-intestine');
    if (shiftBtn) {
      shiftBtn.classList.toggle('active', STATE.intestineShifted);
    }

    // Jika sesi memiliki progres atau spesimen yang sudah dipilih, lewati layar intro awal
    const hasActiveProgress = Boolean(STATE.selectedSpecimen) || STATE.step > 0 || STATE.anesthesiaProgress > 0;
    const authModal = document.getElementById('touch-auth-modal');
    if (hasActiveProgress && authModal) {
      document.body.classList.remove('specimen-hidden-on-reset');
      authModal.classList.remove('open');
      const specLabel = STATE.selectedSpecimen ? ` (${STATE.selectedSpecimen.id})` : '';
      showToast(`Sesi praktikum sebelumnya dilanjutkan${specLabel} — Tahap ${STATE.step}.`);
    }

    updateStorageStatusBadge('saved');
  } finally {
    PRACTICUM_STORAGE.isRestoring = false;
  }

  return true;
}

/* === TAHAP C: MODUL KOTAK SAMBUTAN DOKTER JOVAN (C) & INTERACTIVE SPOTLIGHT TUTORIAL (D) === */
const SPOTLIGHT_TUTORIAL = (() => {
  const MORPH_MS = 350;
  const VIEWPORT_MARGIN = 12;
  const TARGET_GAP = 14;
  const CARD_MAX_WIDTH = 360;

  let isTutorialActive = false;
  let phase = 'idle'; // 'idle' | 'welcome' | 'steps'
  let currentStepIdx = 0;
  let isTransitioning = false;
  let transitionTimer = null;
  let exitTimer = null;
  let rafTrackingId = null;
  let modalObserver = null;
  let rootEl = null;
  let shadeTop = null;
  let shadeBottom = null;
  let shadeLeft = null;
  let shadeRight = null;
  let focusRingEl = null;
  let cardEl = null;
  let contentStageEl = null;
  let ariaLiveEl = null;
  let keydownHandler = null;
  let viewportHandler = null;
  let onFinishCallback = null;

  /* 6 Langkah Tutorial sesuai Bagian D (dengan fallback aman untuk #tool-rack -> #tool-list) */
  const STEPS = [
    {
      selectors: ['header.main-header'],
      title: '1. Header & Kontrol Utama Aplikasi',
      desc: 'Menampilkan identitas laboratorium virtual, indikator status penyimpanan otomatis sesi, serta tombol layar penuh, panduan, bahasa (ID/EN),suara aktif dan pengaturan, mode cerah dan gelap dan reset sesi.'
    },
    {
      selectors: ['.step-info-bar'],
      title: '2. Informasi Tahapan Praktikum',
      desc: 'Menampilkan nama tahap yang aktif, instruksi kerja yang harus dilakukan, serta indikator progres tahap saat ini.'
    },
    {
      selectors: ['#tool-rack', '#tool-list', 'main.workstation > section.tray-panel:first-child'],
      title: '3. Rak Instrumen Bedah',
      desc: 'Menyediakan seluruh instrumen virtual yang dibutuhkan secara berurutan, mulai dari Kapas Kloroform, Jarum Pentul, Skalpel, Gunting Bedah, Pinset, hingga Benang Jahit.'
    },
    {
      selectors: ['#wax-bed'],
      title: '4. Area Kerja Utama (Baki Pembedahan)',
      desc: 'Area kerja utama untuk pengamatan dan prosedur bedah berlapis. Selama pengenalan ini, area kerja dibiarkan kosong sebelum praktikum dimulai.'
    },
    {
      selectors: ['#vp-track', '#practicum-vertical-progress'],
      title: '5. Indikator Progres Praktikum',
      desc: 'Menampilkan persentase kemajuan keseluruhan praktikum secara real-time dari tahap pembiusan hingga penutupan akhir.'
    },
    {
      selectors: ['#organ-popup-box', '#specimen-dish'],
      title: '6. Informasi Organ & Fisiologi',
      desc: 'Saat organ dipindahkan ke Wadah Organ dan diklik, panel informasi akan muncul di area ini untuk menampilkan deskripsi, cara kerja, fungsi, letak, serta narasi audio.',
      conceptualDemo: true
    }
  ];

  function prefersReducedMotion() {
    return typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function hasBlockingAppModalOpen() {
    const modals = document.querySelectorAll('.modal-backdrop');
    for (let i = 0; i < modals.length; i++) {
      const m = modals[i];
      if (m.classList.contains('open')) return true;
      const cs = window.getComputedStyle(m);
      if (cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0) {
        return true;
      }
    }
    return false;
  }

  function resolveTutorialZIndex() {
    let minModalZ = Infinity;
    document.querySelectorAll('.modal-backdrop').forEach(m => {
      const z = parseInt(window.getComputedStyle(m).zIndex, 10);
      if (!Number.isNaN(z) && z < minModalZ) {
        minModalZ = z;
      }
    });
    if (Number.isFinite(minModalZ) && minModalZ > 50) {
      return minModalZ - 10;
    }
    return 2400;
  }

  function setWaxBedSpecimenHidden(hidden) {
    document.body.classList.toggle('tutorial-hide-specimen', Boolean(hidden));
  }

  function resolveStepTarget(stepObj) {
    if (!stepObj || !Array.isArray(stepObj.selectors)) return null;
    for (let i = 0; i < stepObj.selectors.length; i++) {
      const el = document.querySelector(stepObj.selectors[i]);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return { el, rect };
      }
    }
    return null;
  }

  function bindModalObserver() {
    if (modalObserver) return;
    modalObserver = new MutationObserver(() => {
  if (!isTutorialActive) return;
  if (hasBlockingAppModalOpen()) {
    abort(false);
  }
});
    modalObserver.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'aria-hidden', 'style']
    });
  }

  function bindKeyboardAndViewport() {
    if (!keydownHandler) {
      keydownHandler = e => {
        if (!isTutorialActive) return;
        if (hasBlockingAppModalOpen()) {
          abort();
          return;
        }

        const tag = e.target && e.target.tagName ? e.target.tagName.toUpperCase() : '';
        const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable);

        if (e.key === 'Escape') {
          e.preventDefault();
          skip();
          return;
        }

        if (phase === 'steps' && !isTyping) {
          if (e.key === 'ArrowRight') {
            e.preventDefault();
            if (currentStepIdx < STEPS.length - 1) {
              next();
            } else {
              complete();
            }
            return;
          }
          if (e.key === 'ArrowLeft') {
            e.preventDefault();
            if (currentStepIdx > 0) {
              prev();
            }
            return;
          }
        }

        if (e.key === 'Tab' && rootEl) {
          const focusables = Array.from(
            rootEl.querySelectorAll('button:not([disabled]), [tabindex]:not([tabindex="-1"])')
          ).filter(el => el.offsetParent !== null);
          if (focusables.length === 0) return;
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          if (e.shiftKey) {
            if (document.activeElement === first || !rootEl.contains(document.activeElement)) {
              e.preventDefault();
              last.focus();
            }
          } else {
            if (document.activeElement === last || !rootEl.contains(document.activeElement)) {
              e.preventDefault();
              first.focus();
            }
          }
        }
      };
      document.addEventListener('keydown', keydownHandler, true);
    }

    if (!viewportHandler) {
      viewportHandler = () => {
        if (!isTutorialActive || phase !== 'steps') return;
        schedulePositionSync();
      };
      window.addEventListener('resize', viewportHandler, { passive: true });
      window.addEventListener('scroll', viewportHandler, { passive: true, capture: true });
      window.addEventListener('orientationchange', viewportHandler, { passive: true });
    }
  }

  function schedulePositionSync() {
    if (!isTutorialActive || phase !== 'steps') return;
    if (rafTrackingId) cancelAnimationFrame(rafTrackingId);
    rafTrackingId = requestAnimationFrame(() => {
      rafTrackingId = null;
      if (!isTutorialActive || phase !== 'steps') return;
      positionSpotlightAndCard(currentStepIdx);
    });
  }

  function createRoot() {
    cleanupDomAndListeners(false);
    rootEl = document.createElement('div');
    rootEl.id = 'spotlight-tutorial-root';
    rootEl.style.zIndex = String(resolveTutorialZIndex());

    ariaLiveEl = document.createElement('div');
    ariaLiveEl.setAttribute('aria-live', 'polite');
    ariaLiveEl.setAttribute('aria-atomic', 'true');
    ariaLiveEl.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;';
    rootEl.appendChild(ariaLiveEl);

    document.body.appendChild(rootEl);
  }

  /* BAGIAN C: Menampilkan Kotak Cerita Sambutan Dokter Jovan */
  function startWelcomeFlow(callback) {
    onFinishCallback = typeof callback === 'function' ? callback : null;
    isTutorialActive = true;
    phase = 'welcome';
    currentStepIdx = 0;
    isTransitioning = false;

    setWaxBedSpecimenHidden(true);
    createRoot();
    bindModalObserver();
    bindKeyboardAndViewport();

    const welcomeOverlay = document.createElement('div');
    welcomeOverlay.className = 'st-backdrop-welcome';
    welcomeOverlay.setAttribute('role', 'dialog');
    welcomeOverlay.setAttribute('aria-modal', 'true');
    welcomeOverlay.setAttribute('aria-labelledby', 'st-welcome-heading');

    welcomeOverlay.innerHTML = `
      <div class="st-welcome-card">
        <span class="st-welcome-badge">Laboratorium Virtual • Pengantar Misi</span>
        <h2 class="st-welcome-title" id="st-welcome-heading">Selamat Datang, Dokter Spesialis Bedah Tri Artha Jovan Nugraha!</h2>
        <div class="st-welcome-body">
          <p>Sekelompok peneliti bersama Dokter Jovan telah menemukan suatu hewan yang dikenal dengan nama lokal mencit.</p>
          <p>Kini, Anda diundang untuk bergabung dengan kelompok peneliti tersebut dalam sebuah misi ilmiah: mengidentifikasi struktur organ dan memahami tahapan pembedahan mencit melalui simulasi laboratorium virtual.</p>
          <p>Sebelum memulai, dimohon untuk mengenakan jas laboratorium dan mempersiapkan diri.</p>
          <p>Bantulah tim peneliti menyelesaikan penelitian ini dengan cermat dan penuh tanggung jawab.</p>
          <p>Selamat bekerja sama, Dokter. Mari mulai praktikum!</p>
		  <p><strong>Jika Dokter Jovan Bingung, bisa melihat panduan melalui tombol panduan yang ada di layar utama!</strong></p>
        </div>
        <div class="st-welcome-actions">
          <button type="button" class="st-btn st-btn-primary" id="st-btn-welcome-continue">Lanjutkan</button>
        </div>
      </div>
    `;

    rootEl.appendChild(welcomeOverlay);

    const btnContinue = welcomeOverlay.querySelector('#st-btn-welcome-continue');
    btnContinue.addEventListener('click', () => {
      if (!isTutorialActive || isTransitioning) return;
      isTransitioning = true;
      const delay = prefersReducedMotion() ? 0 : MORPH_MS;
      welcomeOverlay.classList.remove('st-visible');

      transitionTimer = setTimeout(() => {
        transitionTimer = null;
        if (!isTutorialActive) return;
        isTransitioning = false;
        welcomeOverlay.remove();
        beginSpotlightSteps();
      }, delay);
    });

    if (ariaLiveEl) {
      ariaLiveEl.textContent = 'Selamat Datang, Dokter Spesialis Bedah Tri Artha Jovan Nugraha!';
    }

    requestAnimationFrame(() => {
      if (!isTutorialActive) return;
      welcomeOverlay.classList.add('st-visible');
      btnContinue.focus();
    });
  };

  function buildStepInnerHtml(stepObj) {
    const demoHtml = stepObj.conceptualDemo
      ? `
        <div class="st-conceptual-demo" aria-label="Demonstrasi Konseptual Kartu Organ">
          <div class="st-demo-head">
            <span class="st-demo-title">Contoh Kartu: Jantung (Cor)</span>
            <span class="st-demo-badge">Pratinjau Konseptual</span>
          </div>
          <ul class="st-demo-list">
            <li><strong>Deskripsi & Letak:</strong> Struktur anatomi dan posisi organ di rongga tubuh.</li>
            <li><strong>Cara Kerja & Fungsi:</strong> Mekanisme fisiologis beserta diagram animasi.</li>
            <li><strong>Narasi Audio:</strong> Tombol <em>Dengarkan</em> untuk penjelasan suara.</li>
          </ul>
        </div>
      `
      : '';

    return `
      <h3 class="st-step-title">${stepObj.title}</h3>
      <p class="st-step-desc">${stepObj.desc}</p>
      ${demoHtml}
    `;
  }

  /* BAGIAN D: Memulai 6 Langkah Interactive Spotlight Tutorial */
  function beginSpotlightSteps() {
    if (!isTutorialActive || !rootEl) return;
    if (hasBlockingAppModalOpen()) {
      abort();
      return;
    }

    phase = 'steps';
    currentStepIdx = 0;

    const shield = document.createElement('div');
    shield.className = 'st-interaction-shield';

    shadeTop = document.createElement('div');
    shadeTop.className = 'st-shade';
    shadeBottom = document.createElement('div');
    shadeBottom.className = 'st-shade';
    shadeLeft = document.createElement('div');
    shadeLeft.className = 'st-shade';
    shadeRight = document.createElement('div');
    shadeRight.className = 'st-shade';

    focusRingEl = document.createElement('div');
    focusRingEl.className = 'st-focus-ring';

    cardEl = document.createElement('div');
    cardEl.className = 'st-tutorial-card';
    cardEl.setAttribute('role', 'dialog');
    cardEl.setAttribute('aria-modal', 'true');
    cardEl.setAttribute('aria-label', 'Panduan Interaktif Laboratorium Virtual');

    cardEl.innerHTML = `
      <div class="st-card-header">
        <span class="st-progress-pill" id="st-step-counter">1 / ${STEPS.length}</span>
        <button type="button" class="st-btn-skip" id="st-btn-skip">Lewati Tutorial</button>
      </div>
      <div class="st-content-stage" id="st-content-stage">
        <div class="st-content-layer" id="st-active-layer"></div>
      </div>
      <div class="st-card-footer">
        <button type="button" class="st-btn" id="st-btn-prev" disabled>Sebelumnya</button>
        <div class="st-nav-group">
          <button type="button" class="st-btn st-btn-primary" id="st-btn-next">Berikutnya</button>
        </div>
      </div>
    `;

    rootEl.appendChild(shield);
    rootEl.appendChild(shadeTop);
    rootEl.appendChild(shadeBottom);
    rootEl.appendChild(shadeLeft);
    rootEl.appendChild(shadeRight);
    rootEl.appendChild(focusRingEl);
    rootEl.appendChild(cardEl);

    contentStageEl = cardEl.querySelector('#st-content-stage');

    cardEl.querySelector('#st-btn-skip').addEventListener('click', () => skip());
    cardEl.querySelector('#st-btn-prev').addEventListener('click', () => prev());
    cardEl.querySelector('#st-btn-next').addEventListener('click', () => {
      if (currentStepIdx < STEPS.length - 1) {
        next();
      } else {
        complete();
      }
    });

    renderStep(0, 'none');

    requestAnimationFrame(() => {
      if (!isTutorialActive) return;
      shadeTop.classList.add('st-active');
      shadeBottom.classList.add('st-active');
      shadeLeft.classList.add('st-active');
      shadeRight.classList.add('st-active');
      focusRingEl.classList.add('st-active');
      cardEl.classList.add('st-active');
      const nextBtn = cardEl.querySelector('#st-btn-next');
      if (nextBtn) nextBtn.focus();
    });
  }

  function renderStep(targetIdx, direction) {
    if (!isTutorialActive || !cardEl || !contentStageEl) return;
    if (targetIdx < 0 || targetIdx >= STEPS.length) return;

    if (transitionTimer) {
      clearTimeout(transitionTimer);
      transitionTimer = null;
    }

    currentStepIdx = targetIdx;
    const stepObj = STEPS[currentStepIdx];
    const isFirst = currentStepIdx === 0;
    const isLast = currentStepIdx === STEPS.length - 1;

    const counterEl = cardEl.querySelector('#st-step-counter');
    const prevBtn = cardEl.querySelector('#st-btn-prev');
    const nextBtn = cardEl.querySelector('#st-btn-next');

    if (counterEl) counterEl.textContent = `${currentStepIdx + 1} / ${STEPS.length}`;
    if (prevBtn) prevBtn.disabled = isFirst;
    if (nextBtn) {
      nextBtn.textContent = isLast ? 'Mulai Praktikum' : 'Berikutnya';
      nextBtn.className = isLast ? 'st-btn st-btn-finish' : 'st-btn st-btn-primary';
    }

    if (ariaLiveEl) {
      ariaLiveEl.textContent = `Langkah ${currentStepIdx + 1} dari ${STEPS.length}: ${stepObj.title}. ${stepObj.desc}`;
    }

    const oldLayer = contentStageEl.querySelector('#st-active-layer');
    const reduced = prefersReducedMotion() || direction === 'none' || !oldLayer;

    if (reduced) {
      contentStageEl.style.height = 'auto';
      contentStageEl.innerHTML = `<div class="st-content-layer" id="st-active-layer">${buildStepInnerHtml(stepObj)}</div>`;
      positionSpotlightAndCard(currentStepIdx);
      return;
    }

    const oldHeight = oldLayer.offsetHeight;
    contentStageEl.style.height = `${oldHeight}px`;

    oldLayer.removeAttribute('id');
    oldLayer.classList.add('st-layer-ghost');

    const newLayer = document.createElement('div');
    newLayer.id = 'st-active-layer';
    newLayer.className = `st-content-layer ${direction === 'prev' ? 'st-morph-in-prev' : 'st-morph-in-next'}`;
    newLayer.innerHTML = buildStepInnerHtml(stepObj);
    contentStageEl.appendChild(newLayer);

    const newHeight = newLayer.offsetHeight;

    positionSpotlightAndCard(currentStepIdx);

    requestAnimationFrame(() => {
      if (!isTutorialActive) return;
      contentStageEl.style.height = `${newHeight}px`;
      oldLayer.classList.add(direction === 'prev' ? 'st-morph-out-prev' : 'st-morph-out-next');
      newLayer.classList.remove('st-morph-in-next', 'st-morph-in-prev');
    });

    transitionTimer = setTimeout(() => {
      transitionTimer = null;
      if (!isTutorialActive) return;
      if (oldLayer && oldLayer.parentNode) oldLayer.remove();
      if (contentStageEl) contentStageEl.style.height = 'auto';
      positionSpotlightAndCard(currentStepIdx);
    }, MORPH_MS + 20);
  }

  function positionSpotlightAndCard(stepIdx) {
    if (!isTutorialActive || !cardEl || !focusRingEl) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const stepObj = STEPS[stepIdx];
    const resolved = resolveStepTarget(stepObj);

    const cardWidth = Math.min(CARD_MAX_WIDTH, vw - VIEWPORT_MARGIN * 2);
    cardEl.style.width = `${cardWidth}px`;
    const cardHeight = cardEl.offsetHeight || 190;

    if (!resolved) {
      shadeTop.style.cssText = 'top:0;left:0;width:100vw;height:100vh;';
      shadeBottom.style.cssText = 'top:0;left:0;width:0;height:0;';
      shadeLeft.style.cssText = 'top:0;left:0;width:0;height:0;';
      shadeRight.style.cssText = 'top:0;left:0;width:0;height:0;';

      focusRingEl.style.opacity = '0';
      const fallbackLeft = Math.max(VIEWPORT_MARGIN, (vw - cardWidth) / 2);
      const fallbackTop = Math.max(VIEWPORT_MARGIN, (vh - cardHeight) / 2);
      cardEl.style.left = `${Math.round(fallbackLeft)}px`;
      cardEl.style.top = `${Math.round(fallbackTop)}px`;
      return;
    }

    const pad = 4;
    const r = resolved.rect;
    const tTop = Math.max(0, r.top - pad);
    const tLeft = Math.max(0, r.left - pad);
    const tRight = Math.min(vw, r.right + pad);
    const tBottom = Math.min(vh, r.bottom + pad);
    const tWidth = Math.max(0, tRight - tLeft);
    const tHeight = Math.max(0, tBottom - tTop);

    shadeTop.style.top = '0px';
    shadeTop.style.left = '0px';
    shadeTop.style.width = `${vw}px`;
    shadeTop.style.height = `${tTop}px`;

    shadeBottom.style.top = `${tBottom}px`;
    shadeBottom.style.left = '0px';
    shadeBottom.style.width = `${vw}px`;
    shadeBottom.style.height = `${Math.max(0, vh - tBottom)}px`;

    shadeLeft.style.top = `${tTop}px`;
    shadeLeft.style.left = '0px';
    shadeLeft.style.width = `${tLeft}px`;
    shadeLeft.style.height = `${tHeight}px`;

    shadeRight.style.top = `${tTop}px`;
    shadeRight.style.left = `${tRight}px`;
    shadeRight.style.width = `${Math.max(0, vw - tRight)}px`;
    shadeRight.style.height = `${tHeight}px`;

    focusRingEl.style.opacity = '1';
    focusRingEl.style.top = `${Math.round(tTop)}px`;
    focusRingEl.style.left = `${Math.round(tLeft)}px`;
    focusRingEl.style.width = `${Math.round(tWidth)}px`;
    focusRingEl.style.height = `${Math.round(tHeight)}px`;

    const candidates = [
      {
        left: tLeft + (tWidth - cardWidth) / 2,
        top: tBottom + TARGET_GAP,
        fits: tBottom + TARGET_GAP + cardHeight <= vh - VIEWPORT_MARGIN
      },
      {
        left: tRight + TARGET_GAP,
        top: tTop + (tHeight - cardHeight) / 2,
        fits: tRight + TARGET_GAP + cardWidth <= vw - VIEWPORT_MARGIN
      },
      {
        left: tLeft - TARGET_GAP - cardWidth,
        top: tTop + (tHeight - cardHeight) / 2,
        fits: tLeft - TARGET_GAP - cardWidth >= VIEWPORT_MARGIN
      },
      {
        left: tLeft + (tWidth - cardWidth) / 2,
        top: tTop - TARGET_GAP - cardHeight,
        fits: tTop - TARGET_GAP - cardHeight >= VIEWPORT_MARGIN
      }
    ];

    let chosen = candidates.find(c => c.fits);
    if (!chosen) {
      chosen = {
        left: (vw - cardWidth) / 2,
        top: vh - cardHeight - VIEWPORT_MARGIN
      };
    }

    const clampedLeft = Math.max(VIEWPORT_MARGIN, Math.min(vw - cardWidth - VIEWPORT_MARGIN, chosen.left));
    const clampedTop = Math.max(VIEWPORT_MARGIN, Math.min(vh - cardHeight - VIEWPORT_MARGIN, chosen.top));

    cardEl.style.left = `${Math.round(clampedLeft)}px`;
    cardEl.style.top = `${Math.round(clampedTop)}px`;
  }

  function next() {
    if (!isTutorialActive || phase !== 'steps') return;
    if (currentStepIdx < STEPS.length - 1) {
      renderStep(currentStepIdx + 1, 'next');
    }
  }

  function prev() {
    if (!isTutorialActive || phase !== 'steps') return;
    if (currentStepIdx > 0) {
      renderStep(currentStepIdx - 1, 'prev');
    }
  }

  function gracefulExitAndCleanup() {
    if (!isTutorialActive) return;
    const delay = prefersReducedMotion() ? 0 : MORPH_MS;

    // Matikan pengawas lebih dulu agar perintah buka kandang mencit tidak dibatalkan
    if (modalObserver) {
      modalObserver.disconnect();
      modalObserver = null;
    }

    if (delay === 0) {
      abort(true);
      return;
    }

    if (exitTimer) return;
    const welcomeOverlay = rootEl ? rootEl.querySelector('.st-backdrop-welcome') : null;
    if (welcomeOverlay) welcomeOverlay.classList.remove('st-visible');
    if (shadeTop) shadeTop.classList.remove('st-active');
    if (shadeBottom) shadeBottom.classList.remove('st-active');
    if (shadeLeft) shadeLeft.classList.remove('st-active');
    if (shadeRight) shadeRight.classList.remove('st-active');
    if (focusRingEl) focusRingEl.classList.remove('st-active');
    if (cardEl) cardEl.classList.add('st-exiting');

    exitTimer = setTimeout(() => {
      exitTimer = null;
      abort(true);
    }, delay);
  }

  function skip() {
    if (!isTutorialActive) return;
    gracefulExitAndCleanup();
  }

  function complete() {
    if (!isTutorialActive) return;
    gracefulExitAndCleanup();
  }

  function abort(runCallback = true) {
  if (!isTutorialActive) return;
  isTutorialActive = false;
  phase = 'idle';
  isTransitioning = false;
  const nextAction = runCallback ? onFinishCallback : null;
  onFinishCallback = null;
  cleanupDomAndListeners(true);
  if (typeof nextAction === 'function') {
    nextAction();
  }
}

  function cleanupDomAndListeners(restoreSpecimen) {
    if (transitionTimer) {
      clearTimeout(transitionTimer);
      transitionTimer = null;
    }
    if (exitTimer) {
      clearTimeout(exitTimer);
      exitTimer = null;
    }
    if (rafTrackingId) {
      cancelAnimationFrame(rafTrackingId);
      rafTrackingId = null;
    }
    if (modalObserver) {
      modalObserver.disconnect();
      modalObserver = null;
    }
    if (keydownHandler) {
      document.removeEventListener('keydown', keydownHandler, true);
      keydownHandler = null;
    }
    if (viewportHandler) {
      window.removeEventListener('resize', viewportHandler);
      window.removeEventListener('scroll', viewportHandler, true);
      window.removeEventListener('orientationchange', viewportHandler);
      viewportHandler = null;
    }
    if (rootEl && rootEl.parentNode) {
      rootEl.parentNode.removeChild(rootEl);
    }
    rootEl = null;
    shadeTop = null;
    shadeBottom = null;
    shadeLeft = null;
    shadeRight = null;
    focusRingEl = null;
    cardEl = null;
    contentStageEl = null;
    ariaLiveEl = null;

    if (restoreSpecimen) {
      setWaxBedSpecimenHidden(false);
    }
  }

  return {
    startWelcomeFlow,
    next,
    prev,
    skip,
    complete,
    abort,
    isActive: () => isTutorialActive
  };
})();

/* === DUAL THEME CONTROLLER (AUTO DEVICE SYNC + MANUAL OVERRIDE) === */
const THEME_CONTROLLER = (() => {
  const STORAGE_KEY = 'vmd_theme_preference'; // 'light' | 'dark' | null (auto)
  const VALID_THEMES = ['dark', 'light'];
  let currentTheme = 'dark';
  let isManualOverride = false;

  function getSystemTheme() {
    try {
      if (typeof window !== 'undefined' && window.matchMedia) {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
    } catch (err) {
      // Fallback ke dark jika matchMedia tidak didukung
    }
    return 'dark';
  }

  function readSavedManualTheme() {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const saved = window.localStorage.getItem(STORAGE_KEY);
        if (VALID_THEMES.includes(saved)) {
          isManualOverride = true;
          return saved;
        }
      }
    } catch (err) {
      // Abaikan jika localStorage diblokir
    }
    isManualOverride = false;
    return null;
  }

  function persistTheme(theme) {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        if (theme === null) {
          window.localStorage.removeItem(STORAGE_KEY);
        } else {
          window.localStorage.setItem(STORAGE_KEY, theme);
        }
      }
    } catch (err) {
      // Tetap berjalan tanpa error
    }
  }

  function updateToggleButton(theme) {
    const btn = document.getElementById('btn-theme-toggle');
    const iconEl = document.getElementById('theme-icon');
    const labelEl = document.getElementById('theme-label');
    if (!btn) return;

    const isLight = theme === 'light';
    const modeSuffix = isManualOverride ? '' : ' (Auto)';
    btn.setAttribute('aria-pressed', String(isLight));
    btn.setAttribute(
      'title',
      isLight
        ? `Tema aktif: Light Mode${modeSuffix}. Klik untuk ganti ke Dark Mode.`
        : `Tema aktif: Dark Mode${modeSuffix}. Klik untuk ganti ke Light Mode.`
    );

    if (iconEl) iconEl.textContent = isLight ? '☀️' : '🌙';
    if (labelEl) labelEl.textContent = (isLight ? 'Light Mode' : 'Dark Mode') + modeSuffix;
  }

  function applyTheme(theme, persistMode = 'keep') {
    const normalized = VALID_THEMES.includes(theme) ? theme : getSystemTheme();
    currentTheme = normalized;
    document.documentElement.setAttribute('data-theme', normalized);

    if (persistMode === 'manual') {
      isManualOverride = true;
      persistTheme(normalized);
    } else if (persistMode === 'auto') {
      isManualOverride = false;
      persistTheme(null);
    }

    updateToggleButton(normalized);
    return normalized;
  }

  function toggleTheme() {
    const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
    applyTheme(nextTheme, 'manual');
    if (typeof AUDIO_MANAGER !== 'undefined' && typeof AUDIO_MANAGER.play === 'function') {
      AUDIO_MANAGER.play('ui_button_tap');
    }
  }

  function bindSystemThemeListener() {
    try {
      if (typeof window === 'undefined' || !window.matchMedia) return;
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handleSystemChange = (e) => {
        // Hanya otomatis berubah jika pengguna belum mengunci pilihan manual
        if (!isManualOverride) {
          applyTheme(e.matches ? 'dark' : 'light', 'keep');
        }
      };

      if (typeof mediaQuery.addEventListener === 'function') {
        mediaQuery.addEventListener('change', handleSystemChange);
      } else if (typeof mediaQuery.addListener === 'function') {
        mediaQuery.addListener(handleSystemChange);
      }
    } catch (err) {
      // Abaikan pada browser lama
    }
  }

  function init() {
    if (window.__vmdThemeControllerInitialized) return;
    window.__vmdThemeControllerInitialized = true;

    const savedManual = readSavedManualTheme();
    const initialTheme = savedManual || getSystemTheme();
    applyTheme(initialTheme, 'keep');
    bindSystemThemeListener();

    const btn = document.getElementById('btn-theme-toggle');
    if (btn) {
      btn.addEventListener('click', toggleTheme);
    }
  }

  return {
    init,
    applyTheme,
    toggleTheme,
    resetToDeviceTheme: () => applyTheme(getSystemTheme(), 'auto'),
    getTheme: () => currentTheme
  };
})();

THEME_CONTROLLER.init();

restorePracticumSession();
/* ==========================================================================
   TAHAP 5: SAFE AUTO-HOOKS (MENGHUBUNGKAN SFX KE SELURUH INTERAKSI UI)
   ========================================================================== */
   /* ==========================================================================
   TAHAP 5: SAFE AUTO-HOOKS & VOLUME MIXER CONTROLLER
   ========================================================================== */
/* ============================================================================
   PENGHUBUNG UI, SLIDER MIXER, SCANNER AWAL, MODAL & LIFECYCLE CLEANUP
   ============================================================================ */
(function initAudioIntegration() {
  AUDIO_MANAGER.updateMuteButtonUI();

  // 1. Tombol Mute Utama
  const btnSfxToggle = document.getElementById('btn-sfx-toggle');
  if (btnSfxToggle) {
    btnSfxToggle.setAttribute('data-sfx', 'custom');
    btnSfxToggle.addEventListener('click', () => {
      AUDIO_MANAGER.toggleMute();
    });
  }

  // 2. Popover Audio Mixer & 4 Slider Real-Time (Perbaikan Langkah 4)
  const btnMixer = document.getElementById('btn-sfx-mixer');
  const popover = document.getElementById('sfx-mixer-popover');
  const btnCloseMixer = document.getElementById('btn-close-mixer');

  function setMixerOpen(open) {
    if (!popover) return;
    popover.classList.toggle('open', open);
    popover.style.display = open ? 'block' : 'none';
  }

  if (btnMixer && popover) {
    btnMixer.setAttribute('data-sfx', 'custom');
    btnMixer.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = popover.style.display !== 'block';
      setMixerOpen(willOpen);
      AUDIO_MANAGER.play(willOpen ? 'ui_card_open' : 'ui_card_close');
    });
  }

  if (btnCloseMixer && popover) {
    btnCloseMixer.setAttribute('data-sfx', 'custom');
    btnCloseMixer.addEventListener('click', () => {
      setMixerOpen(false);
      AUDIO_MANAGER.play('ui_card_close');
    });
  }

  const sliderMap = [
    { id: 'vol-slider-ui', valId: 'vol-val-ui', cat: 'ui', preview: 'ui_button_tap' },
    { id: 'vol-slider-ambience', valId: 'vol-val-ambience', cat: 'ambience', preview: 'amb_hay_rustle' },
    { id: 'vol-slider-movement', valId: 'vol-val-movement', cat: 'movement', preview: 'mov_mouse_step' },
    { id: 'vol-slider-simulation', valId: 'vol-val-simulation', cat: 'simulation', preview: 'sim_marker_place' }
  ];

  sliderMap.forEach(({ id, valId, cat, preview }) => {
    const slider = document.getElementById(id);
    const valLabel = document.getElementById(valId);
    if (!slider) return;

    const savedPct = Math.round(AUDIO_MANAGER.getCategoryVolume(cat) * 100);
    slider.value = savedPct;
    if (valLabel) valLabel.textContent = `${savedPct}%`;

    slider.addEventListener('input', () => {
      const pct = parseInt(slider.value, 10);
      if (valLabel) valLabel.textContent = `${pct}%`;
      AUDIO_MANAGER.setCategoryVolume(cat, pct / 100);
    });

    slider.addEventListener('change', () => {
      AUDIO_MANAGER.play(preview);
    });
  });

  // 3. Layar Awal Scanner (Perbaikan Langkah 5: touch-auth-modal)
  const scannerBox = document.getElementById('touch-scanner-box');
  const authModal = document.getElementById('touch-auth-modal');
  if (scannerBox) {
    let scannerHoldTimer = null;
    let scannerDone = false;

    scannerBox.addEventListener('pointerdown', () => {
      AUDIO_MANAGER.ensureContext();
      scannerDone = false;
      AUDIO_MANAGER.startHoldPulse('mov_hold_progress', 340);

      clearTimeout(scannerHoldTimer);
      scannerHoldTimer = setTimeout(() => {
        scannerDone = true;
        AUDIO_MANAGER.stopHoldPulse();
        AUDIO_MANAGER.play('mov_hold_confirm');
        AUDIO_MANAGER.startLabAmbience();
      }, 2950);
    });

    const cancelScannerAudio = () => {
      clearTimeout(scannerHoldTimer);
      AUDIO_MANAGER.stopHoldPulse();
      if (!scannerDone && authModal && authModal.classList.contains('open')) {
        AUDIO_MANAGER.play('mov_hold_cancel');
      }
    };

    scannerBox.addEventListener('pointerup', cancelScannerAudio);
    scannerBox.addEventListener('pointercancel', cancelScannerAudio);
  }

  // 4. Observer Otomatis untuk Semua Modal (.modal-backdrop)
  const observedModals = document.querySelectorAll('.modal-backdrop');
  const modalObserver = new MutationObserver((mutations) => {
    mutations.forEach((m) => {
      if (m.attributeName === 'class') {
        const el = m.target;
        const isOpen = el.classList.contains('open');
        AUDIO_MANAGER.play(isOpen ? 'ui_card_open' : 'ui_card_close');
        if (el.id === 'cage-capture-modal') {
          if (isOpen) AUDIO_MANAGER.startCageAmbience();
          else AUDIO_MANAGER.stopCageAmbience();
        }
      }
    });
  });
  observedModals.forEach((el) => modalObserver.observe(el, { attributes: true, attributeFilter: ['class'] }));

  // 5. Global Button Tap & Tutup Mixer Saat Klik di Luar
  document.addEventListener('click', (e) => {
    if (popover && popover.style.display === 'block' && !popover.contains(e.target) && e.target !== btnMixer) {
      setMixerOpen(false);
    }
    const btn = e.target.closest('button');
    if (!btn || btn.disabled) return;
    if (btn.dataset.sfx === 'custom' || btn.id === 'btn-tts') return;
    AUDIO_MANAGER.play('ui_button_tap');
  }, true);

  // 6. Hook Fungsi Global (Perbaikan Langkah 6: STATE.activeTool & STATE.step)
  if (typeof window.setTool === 'function') {
    const origSetTool = window.setTool;
    window.setTool = function (toolName, ...args) {
      const prev = typeof STATE !== 'undefined' ? STATE.activeTool : null;
      const res = origSetTool.apply(this, [toolName, ...args]);
      if (toolName && toolName !== prev) AUDIO_MANAGER.play('ui_tool_select');
      return res;
    };
  }

  if (typeof window.showToast === 'function') {
    const origShowToast = window.showToast;
    window.showToast = function (...args) {
      AUDIO_MANAGER.play('ui_toast_alert');
      return origShowToast.apply(this, args);
    };
  }

  if (typeof window.updateUI === 'function') {
    let prevStep = typeof STATE !== 'undefined' ? STATE.step : 0;
    const origUpdateUI = window.updateUI;
    window.updateUI = function (...args) {
      const res = origUpdateUI.apply(this, args);
      if (typeof STATE !== 'undefined' && STATE.step > prevStep) {
        AUDIO_MANAGER.play('sim_stage_complete', STATE.step >= 13 ? 'final' : 'stage');
      }
      if (typeof STATE !== 'undefined') prevStep = STATE.step;
      return res;
    };
  }

  // 7. Lifecycle Cleanup
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      AUDIO_MANAGER.stopAllTransientAudio();
    } else if (document.getElementById('cage-capture-modal')?.classList.contains('open')) {
      AUDIO_MANAGER.startCageAmbience();
    }
  });

  window.addEventListener('pagehide', () => {
    AUDIO_MANAGER.stopAllTransientAudio();
    AUDIO_MANAGER.stopLabAmbience();
  });
})();
