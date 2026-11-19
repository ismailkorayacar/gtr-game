/*! GTR AudioManager
 *
 *  Engine, gear-shift pop and nitro: the original v9.50 synthesised sounds (WebAudio oscillators + noise).
 *  Everything else (tyres, crashes, horn, engine start, wheel spin) is played from files in assets/sounds/
 *  (.wav first, then .mp3) with THREE.AudioLoader.
 *
 *  SAFETY: every sound is optional; a missing / undecodable file is skipped silently and every public call is
 *  wrapped, so nothing here can throw into the game loop.
 *
 *  FILES  engine_start, tire_screech, tire_drift, wheel_spin, crash_car, hit_barrier, scrape_wall, traffic_horn
 *  PERFORMANCE: all loops are persistent nodes; update() runs at 30 Hz and only moves a few AudioParams.
 */
(function (root) {
  'use strict';
  const cl = (x, a, b) => x < a ? a : x > b ? b : x;
  const AM = {
    now: () => performance.now(), ctx: null, running: false, ready: false, base: 'assets/sounds/',
    files: {
      engine_start: ['engine_start.wav', 'engine_start.mp3'],
      engine_l0: ['engine_l0.wav'], engine_l1: ['engine_l1.wav'], engine_l2: ['engine_l2.wav'], engine_l3: ['engine_l3.wav'], engine_l4: ['engine_l4.wav'],
      shift_1: ['shift_1.wav'], shift_2: ['shift_2.wav'], shift_3: ['shift_3.wav'],
      tire_screech: ['tire_screech.wav', 'tire_screech.mp3'], tire_drift: ['tire_drift.wav', 'tire_drift.mp3'], wheel_spin: ['wheel_spin.wav', 'wheel_spin.mp3'],
      crash_car: ['crash_car.wav', 'crash_car.mp3'], hit_barrier: ['hit_barrier.wav', 'hit_barrier.mp3'],
      scrape_wall: ['scrape_wall.wav', 'scrape_wall.mp3'], traffic_horn: ['traffic_horn.wav', 'traffic_horn.mp3']
    },
    gain: { engine_start: 2.5, tire_screech: 1, tire_drift: 1, wheel_spin: 4, engine_loop: 1.6, shift_1: 1.1, shift_2: 1.1, shift_3: 1.1, crash_car: 4, hit_barrier: 1, scrape_wall: 1, traffic_horn: 1, synth: 1.6 },   // 1 = the file's own level; synth = v9.50 engine / pop / nitro bus
    B: {}, V: {}, failed: {}
  };
  const LOOPS = { tire_screech: 1, tire_drift: 1, wheel_spin: 1, scrape_wall: 1 };
  let M = null, lastU = 0, thrS = 0, igT = 99, engOn = false, boostOn = 0;
  const cool = { car: 0, barrier: 0, horn: 0 };
  const GS = [0, 13, 25, 37, 50, 64];                       // v9.50 gear speed thresholds
  const E = { rpm: 1100, gear: 0, gT: 0, rr: null, duck: 0 };

  /* a decode failure inside THREE.AudioLoader has no error callback -> keep it from surfacing as an uncaught rejection */
  try { root.addEventListener('unhandledrejection', e => { const r = e && e.reason; if (r && (r.name === 'EncodingError' || /decod/i.test(String(r.message || r)))) e.preventDefault(); }); } catch (e) { }

  /* ---------------------------------------------------------------- loading */
  function tryLoad(name, i) {
    const list = AM.files[name], emb = root.GTR_SND && root.GTR_SND[name]; if (!list || i >= list.length + (emb ? 1 : 0)) { AM.failed[name] = 1; return; }
    const url = i < list.length ? AM.base + list[i] : emb, ok = b => { try { if (b && b.duration > 0) { AM.B[name] = b; onLoaded(name); } else tryLoad(name, i + 1); } catch (e) { } }, no = () => { try { tryLoad(name, i + 1); } catch (e) { } };
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
    const C = AM.ctx, s = C.createBufferSource(); s.buffer = AM.B[name]; s.loop = true;
    const g = C.createGain(); g.gain.value = 0; s.connect(g); g.connect(M.master); s.start(); return { s, g };
  }
  function onLoaded(name) {
    if (!AM.ctx || !M) return;
    if (LOOPS[name] && !AM.V[name]) AM.V[name] = loopVoice(name);
    if (/^engine_l\d$/.test(name) && !AM.lay && [0, 1, 2, 3, 4].every(i => AM.B['engine_l' + i])) {        // all rpm layers decoded -> recorded engine replaces the synth fallback
      try { AM.lay = AM.makeLayers(AM.ctx, AM.eb, [0, 1, 2, 3, 4].map(i => AM.B['engine_l' + i])); } catch (e) { AM.lay = null; }
    }
  }

  /* ---------------------------------------------------------------- v9.50 engine / nitro / pop (synth) */
  AM.makeV50 = function (C, dest) {
    const nb = C.createBuffer(1, C.sampleRate, C.sampleRate), d = nb.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const comp = C.createDynamicsCompressor(); comp.connect(dest);
    const ef = C.createGain(); ef.gain.value = 0; ef.connect(comp);                     // engine fade (ignite / stop)
    const eg = C.createGain(); eg.gain.value = 0; eg.connect(ef);
    const efm = C.createBiquadFilter(); efm.type = 'peaking'; efm.frequency.value = 500; efm.Q.value = 1.2; efm.gain.value = 9; efm.connect(eg);
    const elp = C.createBiquadFilter(); elp.type = 'lowpass'; elp.frequency.value = 900; elp.Q.value = .7; elp.connect(efm);
    const esh = C.createWaveShaper(), cv = new Float32Array(256); for (let i = 0; i < 256; i++) cv[i] = Math.tanh((i / 128 - 1) * 3); esh.curve = cv; esh.connect(elp);
    const eam = C.createGain(); eam.gain.value = .8; eam.connect(esh);
    const eo = [[1, 'sawtooth', .5], [1.004, 'sawtooth', .35], [.5, 'square', .45], [2, 'sawtooth', .18], [3, 'triangle', .1]].map(a => { const o = C.createOscillator(), gg = C.createGain(); o.type = a[1]; gg.gain.value = a[2]; o.connect(gg); gg.connect(eam); o.start(); o.r = a[0]; return o; });
    const lf = C.createOscillator(), lg = C.createGain(); lf.frequency.value = 20; lg.gain.value = .22; lf.connect(lg); lg.connect(eam.gain); lf.start();
    const s = C.createBufferSource(); s.buffer = nb; s.loop = true; const bp = C.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 700; bp.Q.value = .8; const erum = C.createGain(); erum.gain.value = 0; s.connect(bp); bp.connect(erum); erum.connect(ef); s.start();
    const s2 = C.createBufferSource(); s2.buffer = nb; s2.loop = true; const bp2 = C.createBiquadFilter(); bp2.type = 'bandpass'; bp2.frequency.value = 2200; bp2.Q.value = .7; const ng = C.createGain(); ng.gain.value = 0; s2.connect(bp2); bp2.connect(ng); ng.connect(comp); s2.start();
    const tb = C.createOscillator(); tb.type = 'sine'; tb.frequency.value = 2500; const tbg = C.createGain(); tbg.gain.value = 0; tb.connect(tbg); tbg.connect(comp); tb.start();
    const noise = (f, t, g, type) => { const T = C.currentTime, n = C.createBufferSource(); n.buffer = nb; const fl = C.createBiquadFilter(); fl.type = type || 'lowpass'; fl.frequency.setValueAtTime(f, T); fl.frequency.exponentialRampToValueAtTime(80, T + t); const gn = C.createGain(); gn.gain.setValueAtTime(g, T); gn.gain.exponentialRampToValueAtTime(.001, T + t); n.connect(fl); fl.connect(gn); gn.connect(comp); n.start(); };
    const tone = (f, t0, dd, g, type) => { const o = C.createOscillator(), gn = C.createGain(), T = C.currentTime + t0; o.type = type || 'sine'; o.frequency.setValueAtTime(f, T); gn.gain.setValueAtTime(g, T); gn.gain.exponentialRampToValueAtTime(.001, T + dd); o.connect(gn); gn.connect(comp); o.start(T); o.stop(T + dd); };
    return {
      ef, quiet(T) { ng.gain.setTargetAtTime(0, T, .08); tbg.gain.setTargetAtTime(0, T, .1); }, pop() { noise(1800, .2, .35); }, nos() { noise(7000, .7, .7, 'highpass'); tone(180, 0, .5, .25, 'sawtooth'); },
      frame(T, rpm, fr, thr, on, boost, win) {
        const f = rpm / 30, P = (p, v, t) => p.setTargetAtTime(v, T, t);
        eo.forEach(o => P(o.frequency, f * o.r, .03)); P(lf.frequency, f / 2, .03);
        P(elp.frequency, 500 + rpm * .45 + thr * 600, .05); P(efm.frequency, 350 + rpm * .12, .05);
        P(eg.gain, on ? (.07 + thr * .07) * (E.gT > 0 ? .55 : 1) : 0, .05);
        P(erum.gain, on ? .05 + fr * .07 * thr : 0, .08); P(bp.frequency, 500 + rpm * .3, .1);
        P(ng.gain, boost ? .28 : 0, .08); P(tbg.gain, boost ? .025 : (on && !win ? .008 * fr : 0), .1); P(tb.frequency, 1800 + rpm * .35 + (boost ? 900 : 0), .1);
      }
    };
  };

  /* recorded engine: 5 pitch-flattened rpm layers cut from a real engine acceleration recording (seamless loops),
   * crossfaded by revs and pitch-matched with playbackRate; gear changes play the real recorded shift clips */
  const LAY_F = [56, 62, 70, 78, 86], LAY_F0 = 54, LAY_F1 = 90;
  AM.makeLayers = function (C, dest, bufs) {
    const g = C.createGain(); g.gain.value = AM.gain.engine_loop; const lv = C.createGain(); lv.gain.value = 1;
    const lp = C.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5000; lp.Q.value = .5;
    lp.connect(lv); lv.connect(g); g.connect(dest);
    const V = bufs.map((b, i) => { const s = C.createBufferSource(); s.buffer = b; s.loop = true; const x = C.createGain(); x.gain.value = i ? 0 : 1; s.connect(x); x.connect(lp); s.start(0, Math.random() * b.duration * .9); return { s, x }; });
    return {
      g, lv,
      set(r, thr, tc, at) {
        const T = at == null ? C.currentTime : at, t = tc || .05, fT = LAY_F0 * Math.pow(LAY_F1 / LAY_F0, cl(r, 0, 1)), n = LAY_F.length;
        const w = new Array(n).fill(0);
        if (fT <= LAY_F[0]) w[0] = 1; else if (fT >= LAY_F[n - 1]) w[n - 1] = 1;
        else { let i = 0; while (i < n - 2 && fT > LAY_F[i + 1]) i++; const a = Math.log(fT / LAY_F[i]) / Math.log(LAY_F[i + 1] / LAY_F[i]); w[i] = Math.cos(a * Math.PI / 2); w[i + 1] = Math.sin(a * Math.PI / 2); }
        for (let i = 0; i < n; i++) { V[i].s.playbackRate.setTargetAtTime(cl(fT / LAY_F[i], .8, 1.3), T, t); V[i].x.gain.setTargetAtTime(w[i], T, t); }
        lp.frequency.setTargetAtTime(1300 + 2700 * thr, T, .08); lv.gain.setTargetAtTime(.32 + .68 * thr, T, .08);
      }
    };
  };
  AM.init = function (ctx) {
    try {
      if (!ctx || AM.ctx === ctx) return; AM.ctx = ctx; AM.running = false; AM.V = {}; AM.B = {}; AM.failed = {}; engOn = false; AM.lay = null;
      const master = ctx.createGain(); master.gain.value = 1;
      const lim = ctx.createDynamicsCompressor(); lim.threshold.value = -1; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = .002; lim.release.value = .15;   // clip protection only
      master.connect(lim); lim.connect(ctx.destination);
      const sb = ctx.createGain(); sb.gain.value = AM.gain.synth; sb.connect(master);
      M = { master, pan: !!ctx.createStereoPanner };
      const eb = ctx.createGain(); eb.gain.value = 0; eb.connect(master); AM.eb = eb;                                    // engine bus (ignite / stop fade)
      AM.syn = AM.makeV50(ctx, sb); AM.syn.ef.gain.value = 1; AM.lay = null; AM.V.engine_loop = { g: eb };                                       // v9.50 synth: nitro (+ engine until the recorded layers are decoded)
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
  AM.ignite = function () {                           // first throttle press: engine_start, then the engine takes over
    try {
      if (!AM.ctx || !M || AM.running) return; AM.running = true; igT = 0; thrS = 0; engOn = false; E.rpm = 1100; E.gear = 0; E.gT = 0; E.rr = null;
      const T = AM.ctx.currentTime, d = shot('engine_start', 1, 1, 0), V = AM.V.engine_loop;
      if (V) {
        const delay = .08, g = V.g.gain; engOn = true;
        g.cancelScheduledValues(T); g.setValueAtTime(0, T); g.setValueAtTime(0, T + delay); g.linearRampToValueAtTime(1, T + delay + .3);   // engine comes in right away, engine_start plays over it
      }
    } catch (e) { }
  };
  AM.launch = function (delay) {                      // standing start without gas in the countdown: engine_start (ignite) -> tyre screech -> engine revs
    try { setTimeout(() => { try { if (AM.running) shot('tire_screech', .9, 1, 0); } catch (e) { } }, Math.max(0, (delay || 0) * 1000)); } catch (e) { }
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

  /* ---- per-frame update: s = {play,st,cdT,v50,v,thr,boost,screech,slide,spin,scrape} (reused object) ---- */
  AM.update = function (s) {
    try {
      if (!AM.ctx || !M) return; const now = AM.now(); if (now - lastU < 30) return; const dt = Math.min(.1, (now - lastU) / 1000); lastU = now;
      const V = AM.V, on = s.play ? 1 : 0, gn = AM.gain;
      if (AM.running && !s.play) AM.stop(.4);
      if (V.tire_screech) setP(V.tire_screech.g.gain, s.screech * gn.tire_screech * on, .05);
      if (V.tire_drift) setP(V.tire_drift.g.gain, s.slide * gn.tire_drift * on, .06);
      if (V.wheel_spin) setP(V.wheel_spin.g.gain, s.spin * gn.wheel_spin * on, .04);
      if (V.scrape_wall) setP(V.scrape_wall.g.gain, s.scrape * gn.scrape_wall * on, .04);
      if (boostOn && AM.syn && (!AM.running || !s.play)) { AM.syn.quiet(AM.ctx.currentTime); boostOn = 0; }
      if (!AM.running || !s.play || !engOn || !AM.syn) return;
      igT += dt; thrS += ((s.thr ? 1 : 0) - thrS) * Math.min(1, dt * 8);
      const bo = s.boost ? 1 : 0, T = AM.ctx.currentTime, v = s.v50, L = AM.lay;
      let g = 0; for (let i = 0; i < GS.length; i++) if (v >= GS[i]) g = i;
      const up = g > E.gear;
      if (g !== E.gear) {
        if (up && s.st === 'race') { if (L && AM.B['shift_' + Math.min(g, 3)]) { shot('shift_' + Math.min(g, 3), 1, 1, 0); E.duck = T + .42; L.g.gain.setTargetAtTime(.08, T, .02); L.g.gain.setTargetAtTime(gn.engine_loop, T + .42, .05); } else if (!L) AM.syn.pop(); }
        E.gT = .18; E.gear = g; E.rr = null;
      }
      const lo = GS[g], hi = GS[g + 1] || 76; let fr = cl((v - lo) / (hi - lo), 0, 1);
      if (s.st === 'count') fr = s.thr ? Math.min(.7, .1 + (3 - s.cdT) * .3) : 0; else if (s.st === 'win') fr = .85;
      if (s.v < 4 && thrS > .1) fr = Math.max(fr, .3 * thrS);                       // gas pressed while standing: engine revs
      E.gT = Math.max(0, E.gT - dt);
      const thr = bo ? 1 : (s.st === 'race' ? .8 : .5), k = 1 - Math.pow(.75, dt / .016);
      E.rpm += ((1100 + fr * 5600 - (E.gT > 0 ? 600 : 0) + (bo ? 300 : 0)) - E.rpm) * k;
      if (E.rr == null) E.rr = fr; else E.rr += (fr - E.rr) * Math.min(1, k);
      if (bo && !boostOn) AM.syn.nos(); boostOn = bo;
      if (L) L.set(E.rr, thrS * .6 + .4 * (bo ? 1 : (s.st === 'race' ? .8 : .5)), .05);
      AM.syn.frame(T, E.rpm, fr, thr, !L, bo, s.st === 'win');
    } catch (e) { }
  };
  AM.reset = function () { try { if (AM.running) AM.stop(.05); igT = 99; boostOn = 0; E.rpm = 1100; } catch (e) { } };
  AM.state = () => ({ rpm: E.rpm, gear: E.gear, igT, thrS, engOn });
  root.AudioManager = AM;
})(typeof window !== 'undefined' ? window : globalThis);

/* =====================================================================================
 *  GTR adapter — wires AudioManager into the game's controller (state read once per frame,
 *  no allocations; collision / near-miss hooks wrap the existing functions)
 * ===================================================================================== */
(function () {
  const AM = window.AudioManager, S = { play: false, sn: 0, v: 0, thr: false, boost: false, screech: 0, slide: 0, spin: 0, scrape: 0 };
  const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
  let brkT = 0, thrT = 0, lastN = 0, lastSt = '', scanT = 0, inTraffic = false;

  window.aud = function (boost) {                       // called once per frame from the game loop
    try {
      if (!AC) return; if (AM.ctx !== AC) AM.init(AC);
      const nw = performance.now(), dt = Math.min(.1, (nw - lastN) / 1000); lastN = nw;
      const racing = st === 'race', cinEnd = st === 'win' && typeof winEnd !== 'undefined' && winEnd, play = racing || st === 'count' || (st === 'win' && !cinEnd), v = P.v, bcin = typeof buyAnim !== 'undefined' && buyAnim, thr = !!(pdG || keys.ArrowUp || keys.KeyW || bcin);
      if (racing && lastSt === 'count' && !AM.running) { AM.ignite(); AM.launch(.45); }   // GO without gas: start sound, then tyre screech, then the revving engine
      lastSt = st;
      if (!AM.running && play && (thr || (racing && v > 3))) AM.ignite();     // first throttle press: start -> engine loop
      thrT = thr ? thrT + dt : 0;                                              // how long the gas has been held
      let screech = 0, slide = 0, spin = 0, scrape = 0;
      if (racing) {
        if (pdB && !pdG && v > 14) brkT += dt; else brkT = 0;                  // hard brake = brake held > 1.5 s
        if (brkT > 1.5) screech = clamp((brkT - 1.5) / .4, 0, 1) * clamp((v - 14) / 20, 0, 1);
        if (typeof isDR === 'function' && isDR()) slide = clamp((Math.abs(drA) - .05) / .34, 0, 1) * Math.min(1, v / 28);
        if (pdH && v > 8) slide = Math.max(slide, Math.min(1, v / 25));       // handbrake slide
        const lat = Math.abs(P.vx); if (v > 12 && lat > 9) slide = Math.max(slide, clamp((lat / Math.max(v, 10) - .45) / .3, 0, 1)); // lateral slip
        if (thrT > .25 && v < 12) spin = clamp(1.2 - v / 10, 0, 1);              // launch / burnout: gas held > 0.25 s while (almost) standing

        if (Math.abs(P.x) >= LIM - .2 && v > 3) scrape = clamp(v / 25, .3, 1);   // rubbing the barrier
        if (nw - scanT > 100) {                                                 // sudden cut: player swerves right in front of a traffic car
          scanT = nw;
          if (Math.abs(P.vx) > 7 && v > 12) for (let i = 0; i < traffic.length; i++) {
            const t = traffic[i]; if (!t.on) continue; const dz = t.z - P.z;
            if (dz > 2 && dz < 15 && Math.abs(t.x - P.x) < 2.3) { AM.horn(clamp((t.x - P.x) / 7, -1, 1)); break; }
          }
        }
      } else { brkT = 0; if (st === 'count' && thrT > .25) spin = 1; }                // gas held during the 3-2-1 countdown: tyres spin on the spot
      if (st === 'win' && !cinEnd && typeof winC !== 'undefined' && winC && !(typeof buyAnim !== 'undefined' && buyAnim) && !(typeof TX !== 'undefined' && TX && typeof EV !== 'undefined' && EV && EV.tx && TX.wt != null)) slide = .9;   // victory donut
      S.play = play; S.st = st; S.cdT = typeof cdT !== 'undefined' ? cdT : 0; S.v50 = v / (1 + (typeof lvl !== 'undefined' ? lvl : 0) * .158); S.v = v; S.sn = clamp(v / Math.max(curV, 1), 0, 1.1); S.thr = thr; S.boost = !!boost;
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
