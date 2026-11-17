/*! GTR AudioManager — real audio files only (no synthesis)
 *
 *  Loads .mp3 / .wav files from  assets/sounds/  with THREE.AudioLoader and plays them.
 *
 *  SAFETY
 *   - every sound is optional: a file that is missing, still loading, or fails to decode is skipped silently
 *     (every public call is wrapped; nothing here can throw into the game loop)
 *   - engine pitch is clamped to  playbackRate = 0.9 .. 1.5  (AudioManager.PITCH_MIN / PITCH_MAX)
 *
 *  FILES (put any of them in assets/sounds/ — .mp3 is tried first, then .wav)
 *    engine_start    one-shot, played on the first throttle press; the loop fades in as it ends
 *    engine_loop     seamless loop, pitch follows speed / throttle
 *    tire_screech    loop, hard braking
 *    tire_drift      loop, drift / lateral slide / handbrake
 *    wheel_spin      loop, burnout / launch
 *    nitro           loop, while nitro is active
 *    crash_car       one-shot, hit a traffic car
 *    hit_barrier     one-shot, hit a barrier
 *    scrape_wall     loop, rubbing the barrier
 *    traffic_horn    one-shot, traffic honks at close calls / cuts
 *
 *  PERFORMANCE: all loops are persistent nodes; update() runs at 30 Hz and only moves a few AudioParams
 *  (no allocations). One-shots create a single BufferSource each and are rate-limited by cooldowns.
 */
(function (root) {
  'use strict';
  const cl = (x, a, b) => x < a ? a : x > b ? b : x;
  const PITCH_MIN = 0.9, PITCH_MAX = 1.5;
  const AM = {
    now: () => performance.now(), ctx: null, running: false, ready: false, base: 'assets/sounds/',
    files: {
      engine_start: ['engine_start.mp3', 'engine_start.wav'], engine_loop: ['engine_loop.mp3', 'engine_loop.wav'],
      tire_screech: ['tire_screech.mp3', 'tire_screech.wav'], tire_drift: ['tire_drift.mp3', 'tire_drift.wav'], wheel_spin: ['wheel_spin.mp3', 'wheel_spin.wav'],
      nitro: ['nitro.mp3', 'nitro.wav'], crash_car: ['crash_car.mp3', 'crash_car.wav'], hit_barrier: ['hit_barrier.mp3', 'hit_barrier.wav'],
      scrape_wall: ['scrape_wall.mp3', 'scrape_wall.wav'], traffic_horn: ['traffic_horn.mp3', 'traffic_horn.wav']
    },
    gain: { engine_start: 1, engine_loop: .9, tire_screech: .85, tire_drift: .8, wheel_spin: .75, nitro: .8, crash_car: 1, hit_barrier: 1, scrape_wall: .85, traffic_horn: .9 },
    B: {}, V: {}, failed: {}, PITCH_MIN, PITCH_MAX
  };
  const LOOPS = { engine_loop: 1, tire_screech: 1, tire_drift: 1, wheel_spin: 1, nitro: 1, scrape_wall: 1 };
  let M = null, lastU = 0, rpm = 1000, shiftT = 0, lastG = 0, thrS = 0, boostOn = 0, igT = 99, engOn = false;
  const cool = { car: 0, barrier: 0, horn: 0 };
  const G = [0, .213, .41, .607, .82, 1.049];

  /* a decode failure inside THREE.AudioLoader has no error callback -> keep it from surfacing as an uncaught rejection */
  try { root.addEventListener('unhandledrejection', e => { const r = e && e.reason; if (r && (r.name === 'EncodingError' || /decod/i.test(String(r.message || r)))) e.preventDefault(); }); } catch (e) { }

  /* ---------------------------------------------------------------- loading */
  function tryLoad(name, i) {
    const list = AM.files[name]; if (!list || i >= list.length) { AM.failed[name] = 1; return; }
    const url = AM.base + list[i], ok = b => { try { if (b && b.duration > 0) { AM.B[name] = b; onLoaded(name); } else tryLoad(name, i + 1); } catch (e) { } }, no = () => { try { tryLoad(name, i + 1); } catch (e) { } };
    try {
      if (root.THREE && root.THREE.AudioLoader) {
        if (root.THREE.AudioContext && root.THREE.AudioContext.setContext) root.THREE.AudioContext.setContext(AM.ctx);   // decode with the game's context
        new root.THREE.AudioLoader().load(url, ok, undefined, no);
      } else if (root.fetch) {
        root.fetch(url).then(r => { if (!r.ok) throw 0; return r.arrayBuffer(); }).then(ab => new Promise((a, b) => { const p = AM.ctx.decodeAudioData(ab, a, b); if (p && p.catch) p.catch(b); })).then(ok).catch(no);
      } else AM.failed[name] = 1;
    } catch (e) { no(); }
  }
  function loopVoice(name) {
    const C = AM.ctx, s = C.createBufferSource(); s.buffer = AM.B[name]; s.loop = true; if (name === 'engine_loop') s.playbackRate.value = PITCH_MIN;
    const g = C.createGain(); g.gain.value = 0; s.connect(g); g.connect(M.master); s.start(); return { s, g };
  }
  function onLoaded(name) {
    if (!AM.ctx || !M) return;
    if (LOOPS[name] && !AM.V[name]) AM.V[name] = loopVoice(name);
    if (name === 'engine_loop' && AM.running && !engOn) { engOn = true; const g = AM.V.engine_loop.g.gain, T = AM.ctx.currentTime; g.cancelScheduledValues(T); g.setValueAtTime(0, T); g.linearRampToValueAtTime(1, T + .4); }   // loaded late: fade in
  }
  AM.init = function (ctx) {
    try {
      if (!ctx || AM.ctx === ctx) return; AM.ctx = ctx; AM.running = false; AM.V = {}; AM.B = {}; AM.failed = {}; engOn = false;
      const master = ctx.createGain(); master.gain.value = 1;
      const lim = ctx.createDynamicsCompressor(); lim.threshold.value = -6; lim.knee.value = 4; lim.ratio.value = 12; lim.attack.value = .002; lim.release.value = .15;   // clip protection only
      master.connect(lim); lim.connect(ctx.destination);
      M = { master, pan: !!ctx.createStereoPanner };
      AM.ready = true;
      for (const n in AM.files) tryLoad(n, 0);
    } catch (e) { AM.ready = false; }
  };

  /* ---------------------------------------------------------------- playback helpers (all guarded) */
  const setP = (p, v, tc) => { try { p.setTargetAtTime(v, AM.ctx.currentTime, tc); } catch (e) { } };
  function shot(name, gain, rate, pan) {
    try {
      const C = AM.ctx, b = AM.B[name]; if (!C || !M || !b) return 0;                  // missing / still loading -> skip
      const s = C.createBufferSource(); s.buffer = b; if (rate) s.playbackRate.value = rate;
      const g = C.createGain(); g.gain.value = gain * (AM.gain[name] == null ? 1 : AM.gain[name]); s.connect(g); let out = g;
      if (pan && M.pan) { const p = C.createStereoPanner(); p.pan.value = cl(pan, -1, 1); g.connect(p); out = p; }
      out.connect(M.master); s.start(); return b.duration;
    } catch (e) { return 0; }
  }

  /* ---------------------------------------------------------------- events */
  AM.ignite = function () {                           // first throttle press: engine_start, then engine_loop takes over
    try {
      if (!AM.ctx || !M || AM.running) return; AM.running = true; igT = 0; rpm = 1000; shiftT = 0; lastG = 0; thrS = 0; engOn = false;
      const T = AM.ctx.currentTime, d = shot('engine_start', 1, 1, 0), V = AM.V.engine_loop;
      if (V) {
        const delay = d ? Math.max(0, d - .25) : 0, g = V.g.gain; engOn = true;
        g.cancelScheduledValues(T); g.setValueAtTime(0, T); g.setValueAtTime(0, T + delay); g.linearRampToValueAtTime(1, T + delay + .25);   // crossfade into the loop
      }
    } catch (e) { }
  };
  AM.stop = function (fade) {
    try {
      AM.running = false; engOn = false; igT = 99; const V = AM.V.engine_loop; if (!AM.ctx || !V) return;
      const g = V.g.gain, T = AM.ctx.currentTime; g.cancelScheduledValues(T); g.setValueAtTime(g.value, T); g.linearRampToValueAtTime(0, T + (fade || .35));
    } catch (e) { }
  };
  AM.impact = function (kind, sn, pan) {              // sn: 0..1 impact speed -> volume
    try {
      if (!AM.ctx) return; const T = AM.ctx.currentTime, k = kind === 'barrier' ? 'barrier' : 'car'; if (T < cool[k]) return; cool[k] = T + .16;
      const f = cl(sn, 0, 1); shot(k === 'car' ? 'crash_car' : 'hit_barrier', .3 + .7 * f, .96 + Math.random() * .08, pan || 0);
    } catch (e) { }
  };
  AM.horn = function (pan) {
    try { if (!AM.ctx) return; const T = AM.ctx.currentTime; if (T < cool.horn) return; cool.horn = T + 2.2; shot('traffic_horn', .75 + .25 * Math.random(), .97 + Math.random() * .06, pan || 0); } catch (e) { }
  };

  /* ---- per-frame update: s = {play,sn,v,thr,boost,screech,slide,spin,scrape} (reused object) ---- */
  AM.update = function (s) {
    try {
      if (!AM.ctx || !M) return; const now = AM.now(); if (now - lastU < 30) return; const dt = Math.min(.1, (now - lastU) / 1000); lastU = now;
      const V = AM.V, on = s.play ? 1 : 0, gn = AM.gain;
      if (AM.running && !s.play) AM.stop(.4);
      if (V.tire_screech) setP(V.tire_screech.g.gain, s.screech * gn.tire_screech * on, .05);
      if (V.tire_drift) setP(V.tire_drift.g.gain, s.slide * gn.tire_drift * on, .06);
      if (V.wheel_spin) setP(V.wheel_spin.g.gain, s.spin * gn.wheel_spin * on, .04);
      if (V.scrape_wall) setP(V.scrape_wall.g.gain, s.scrape * gn.scrape_wall * on, .04);
      const bo = s.boost && s.play ? 1 : 0; if (V.nitro) setP(V.nitro.g.gain, bo * gn.nitro, bo ? .03 : .07); boostOn = bo;
      if (!AM.running || !s.play || !V.engine_loop || !engOn) return;
      /* rpm model: speed -> gear -> rpm, throttle adds load, nitro adds surge */
      igT += dt; thrS += ((s.thr ? 1 : 0) - thrS) * Math.min(1, dt * 8);
      const sp = s.sn; let g = 0; for (let i = 0; i < G.length; i++) if (sp >= G[i]) g = i;
      if (g > lastG && s.v > 6) shiftT = .18; lastG = g; shiftT = Math.max(0, shiftT - dt);
      const lo = G[g], hi = G[g + 1] || 1.15, fr = cl((sp - lo) / (hi - lo), 0, 1);
      let tgt = 1000 + fr * 5600; tgt = tgt * (.9 + .1 * thrS) + thrS * 380 + (bo ? 850 : 0);
      if (s.v < 4 && thrS > .1) tgt = Math.max(tgt, 3000 * thrS);
      if (shiftT > 0) tgt -= 900; if (!s.thr && fr > .3) tgt *= .93;
      rpm += (tgt - rpm) * Math.min(1, dt * 7);
      const rate = cl(PITCH_MIN + (rpm - 900) / (7000 - 900) * (PITCH_MAX - PITCH_MIN), PITCH_MIN, PITCH_MAX);   // strictly 0.9 .. 1.5
      setP(V.engine_loop.s.playbackRate, rate, .06);
      setP(V.engine_loop.g.gain, (.6 + .3 * thrS + .1 * fr) * gn.engine_loop, .08);
    } catch (e) { }
  };
  AM.reset = function () { try { if (AM.running) AM.stop(.05); igT = 99; rpm = 1000; boostOn = 0; } catch (e) { } };
  AM.state = () => ({ rpm, igT, thrS, engOn });
  root.AudioManager = AM;
})(typeof window !== 'undefined' ? window : globalThis);

/* =====================================================================================
 *  GTR adapter — wires AudioManager into the game's controller (state read once per frame,
 *  no allocations; collision / near-miss hooks wrap the existing functions)
 * ===================================================================================== */
(function () {
  const AM = window.AudioManager, S = { play: false, sn: 0, v: 0, thr: false, boost: false, screech: 0, slide: 0, spin: 0, scrape: 0 };
  const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
  let brkT = 0, lastN = 0, scanT = 0, inTraffic = false;

  window.aud = function (boost) {                       // called once per frame from the game loop
    try {
      if (!AC) return; if (AM.ctx !== AC) AM.init(AC);
      const nw = performance.now(), dt = Math.min(.1, (nw - lastN) / 1000); lastN = nw;
      const racing = st === 'race', play = racing || st === 'count' || st === 'win', v = P.v, thr = !!(pdG || keys.ArrowUp || keys.KeyW);
      if (!AM.running && play && (thr || (racing && v > 3))) AM.ignite();     // first throttle press: start -> engine loop
      let screech = 0, slide = 0, spin = 0, scrape = 0;
      if (racing) {
        if (pdB && !pdG && v > 14) brkT += dt; else brkT = 0;                  // hard brake = brake held > 1.5 s
        if (brkT > 1.5) screech = clamp((brkT - 1.5) / .4, 0, 1) * clamp((v - 14) / 20, 0, 1);
        if (typeof isDR === 'function' && isDR()) slide = clamp((Math.abs(drA) - .05) / .34, 0, 1) * Math.min(1, v / 28);
        if (pdH && v > 8) slide = Math.max(slide, Math.min(1, v / 25));       // handbrake slide
        const lat = Math.abs(P.vx); if (v > 12 && lat > 9) slide = Math.max(slide, clamp((lat / Math.max(v, 10) - .45) / .3, 0, 1)); // lateral slip
        if (pdG && v < 9) spin = clamp(1 - v / 9, 0, 1);                       // burnout / launch wheel spin
        if (Math.abs(P.x) >= LIM - .2 && v > 3) scrape = clamp(v / 25, .3, 1);   // rubbing the barrier
        if (nw - scanT > 100) {                                                 // sudden cut: player swerves right in front of a traffic car
          scanT = nw;
          if (Math.abs(P.vx) > 7 && v > 12) for (let i = 0; i < traffic.length; i++) {
            const t = traffic[i]; if (!t.on) continue; const dz = t.z - P.z;
            if (dz > 2 && dz < 15 && Math.abs(t.x - P.x) < 2.3) { AM.horn(clamp((t.x - P.x) / 7, -1, 1)); break; }
          }
        }
      } else brkT = 0;
      S.play = play; S.v = v; S.sn = clamp(v / Math.max(curV, 1), 0, 1.1); S.thr = thr; S.boost = !!boost;
      S.screech = screech; S.slide = slide; S.spin = spin; S.scrape = scrape;
      AM.update(S);
    } catch (e) { }
  };

  const _col = collide; collide = function () { inTraffic = true; try { return _col.apply(this, arguments); } finally { inTraffic = false; } };
  const _cr = crash; crash = function () {
    const live = invT <= 0, sh = shieldOn, sn = clamp(P.v / Math.max(curV, 1), 0, 1), px = P.x, r = _cr.apply(this, arguments);
    try { if (live && sn > .03 && (st === 'race' || st === 'crash')) AM.impact(inTraffic ? 'car' : 'barrier', sh ? sn * .5 : sn, clamp((imp.x - px) / 4, -1, 1)); } catch (e) { }
    return r;
  };
  const _nm = nearMiss; nearMiss = function () {                      // close call -> horn from the closest traffic car
    try {
      let best = null, bd = 2.9;
      for (let i = 0; i < traffic.length; i++) { const t = traffic[i]; if (!t.on || Math.abs(t.z - P.z) > 30) continue; const dx = Math.abs(t.x - P.x); if (dx < bd) { bd = dx; best = t; } }
      if (best && (bd < 2 || Math.random() < .5)) AM.horn(clamp((best.x - P.x) / 7, -1, 1));
    } catch (e) { }
    return _nm.apply(this, arguments);
  };
  const _rs = reset; reset = function () { try { AM.reset(); brkT = 0; } catch (e) { } return _rs.apply(this, arguments); };
})();
