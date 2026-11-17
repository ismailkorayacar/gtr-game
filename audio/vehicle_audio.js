/*! GTR VehicleAudio — asset-free procedural vehicle sound suite (Web Audio)
 *  engine ignition + dynamic engine, tyre screech / drift slide / wheel-spin, nitro,
 *  car + barrier impacts, wall scrape, traffic horns.
 *
 *  PERFORMANCE MODEL (mobile WebView / Capacitor)
 *   - every buffer is synthesised ONCE (spread over idle ticks, ~1 s total, never inside the render loop)
 *   - every continuous voice is a persistent looping node; update() only moves AudioParams (30 Hz, 0 allocations)
 *   - one-shots (crank, impact, horn, nitro blast) allocate one BufferSource each, rate-limited by cooldowns
 *   - real files can replace any synthesised sound later:  VehicleAudio.useFiles({crash_car:'audio/crash_car.mp3',...})
 */
(function (root) {
  'use strict';
  const SR = 22050, TAU = 6.283185307179586;
  const cl = (x, a, b) => x < a ? a : x > b ? b : x;
  const sin = Math.sin, exp = Math.exp, tanh = Math.tanh, abs = Math.abs;
  let sd = 20241117; const rnd = () => { sd = (Math.imul(sd, 1664525) + 1013904223) >>> 0; return sd / 4294967296; };

  /* ---------------------------------------------------------------- DSP helpers (offline, init only) */
  const mk = s => new Float32Array(Math.round(s * SR));
  const wn = n => { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = rnd() * 2 - 1; return x; };
  function bq(x, type, f, q) {                       // RBJ biquad, in place
    const w = TAU * f / SR, c = Math.cos(w), s = sin(w), a = s / (2 * q); let b0, b1, b2; const a0 = 1 + a;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; } else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; } else { b0 = a; b1 = 0; b2 = -a; }
    const A1 = -2 * c / a0, A2 = (1 - a) / a0; b0 /= a0; b1 /= a0; b2 /= a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) { const v = x[i], y = b0 * v + b1 * x1 + b2 * x2 - A1 * y1 - A2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = y; x[i] = y; }
    return x;
  }
  function norm(x, pk) { let m = 1e-9; for (let i = 0; i < x.length; i++) m = Math.max(m, abs(x[i])); const g = pk / m; for (let i = 0; i < x.length; i++) x[i] *= g; return x; }
  function loopNoise(L, f) {                          // noise made seamless by an equal-power head/tail crossfade
    const xf = Math.round(L * .12), y = f(wn(L + xf)), o = new Float32Array(L);
    for (let i = 0; i < L; i++) o[i] = y[i];
    for (let i = 0; i < xf; i++) { const t = i / xf; o[i] = y[i] * sin(t * 1.5708) + y[L + i] * Math.cos(t * 1.5708); }
    return o;
  }
  const snap = (f, len) => Math.round(f * len) / len; // integer cycles per loop => periodic parts loop perfectly

  /* ---------------------------------------------------------------- synthesis */
  function engineLayer(baseFire, cycles, sp) {        // periodic exhaust-pulse train, one pulse per firing
    const T = 1 / baseFire, len = Math.round(T * cycles * SR), x = new Float32Array(len), kn = Math.round(SR * sp.len);
    for (let c = 0; c < cycles; c++) {
      const t0 = Math.round(c * T * SR), amp = 1 + (rnd() - .5) * sp.jit, fm = 1 + (rnd() - .5) * sp.fj;
      for (let k = 0; k < kn; k++) {
        const t = k / SR; let v = sp.th * sin(TAU * sp.tf * fm * t) * exp(-t * sp.td);
        for (let j = 0; j < sp.f.length; j++) v += sp.a[j] * sin(TAU * sp.f[j] * fm * t + j * 1.7) * exp(-t * sp.dec[j]);
        x[(t0 + k) % len] += amp * v;
      }
    }
    for (let i = 0; i < len; i++) x[i] = tanh(1.7 * x[i]);
    return norm(x, .9);
  }
  const ENG_LOW = () => engineLayer(30, 15, { f: [85, 170, 330, 640], a: [1, .8, .5, .25], dec: [60, 70, 90, 120], th: 1.3, tf: 48, td: 55, len: .06, jit: .2, fj: .04 });
  const ENG_HIGH = () => engineLayer(90, 45, { f: [260, 620, 1250, 2400], a: [1, .85, .6, .35], dec: [120, 150, 190, 260], th: .5, tf: 140, td: 110, len: .03, jit: .15, fj: .03 });
  const INTAKE = () => norm(loopNoise(Math.round(SR * 1.5), x => bq(bq(x, 'lp', 2600, .7), 'hp', 250, .7)), .8);

  function pulse(x, tp, amp, sp) {                    // add one exhaust pulse at time tp into x
    const t0 = Math.round(tp * SR), kn = Math.round(SR * sp.len);
    for (let k = 0; k < kn && t0 + k < x.length; k++) {
      const t = k / SR; let v = sp.th * sin(TAU * sp.tf * t) * exp(-t * sp.td);
      for (let j = 0; j < sp.f.length; j++) v += sp.a[j] * sin(TAU * sp.f[j] * t + j * 1.7) * exp(-t * sp.dec[j]);
      x[t0 + k] += amp * v;
    }
  }
  function crank() {                                  // starter motor, compression thumps, catch
    const L = 1.75, x = mk(L), n = x.length;
    for (let i = 0; i < n; i++) {                     // starter whine (gear mesh) rising as it spins up
      const t = i / SR, r = cl(t / 1.1, 0, 1), f = 78 + 34 * r, g = t < 1.12 ? 1 : exp(-(t - 1.12) * 14);
      x[i] = g * (.2 * sin(TAU * f * t + 2.4 * sin(TAU * 11 * t)) + .1 * sin(TAU * f * 2.01 * t) + .05 * sin(TAU * f * 5.3 * t));
    }
    let tp = .04, pf = 6.2;                           // compression pulses accelerate as the motor spins up
    while (tp < 1.12) {
      const am = .8 + .2 * rnd(), kn = Math.round(SR * .12), t0 = Math.round(tp * SR);
      for (let k = 0; k < kn && t0 + k < n; k++) { const t = k / SR; x[t0 + k] += am * (.9 * sin(TAU * (54 - 120 * t) * t) * exp(-t * 26) + .35 * (rnd() * 2 - 1) * exp(-t * 70)); }
      pf = 6.2 + 3.2 * cl(tp / 1.1, 0, 1); tp += 1 / pf;
    }
    const sp = { f: [85, 170, 330, 640], a: [1, .8, .5, .25], dec: [60, 70, 90, 120], th: 1.3, tf: 48, td: 55, len: .06 };
    let tc = 1.08, per = .13;                         // first firings: irregular, then catching
    while (tc < 1.72) { pulse(x, tc, .35 + .65 * cl((tc - 1.08) / .6, 0, 1) * (.8 + .4 * rnd()), sp); tc += per; per = Math.max(.034, per * .83); }
    for (let i = 0; i < n; i++) x[i] = tanh(1.3 * x[i]);
    return norm(bq(x, 'lp', 4200, .7), .9);
  }
  function hissLoop() {                               // nitro: pressurised gas + low roar
    const L = Math.round(SR * 2), a = loopNoise(L, x => bq(bq(x, 'hp', 2400, .7), 'bp', 5200, .5)), b = loopNoise(L, x => bq(x, 'lp', 520, .8)), o = new Float32Array(L);
    for (let i = 0; i < L; i++) { const t = i / SR; o[i] = a[i] * (1 + .25 * sin(TAU * 11 * t) + .15 * sin(TAU * 17 * t)) + .55 * b[i] * (1 + .3 * sin(TAU * 7 * t)); }
    return norm(o, .85);
  }
  function blast() {                                  // nitro engage: valve burst
    const x = mk(.8), n = x.length, nz = bq(wn(n), 'bp', 3800, .35);
    for (let i = 0; i < n; i++) { const t = i / SR; x[i] = nz[i] * (1 - exp(-t * 220)) * exp(-t * 4.2) + .9 * sin(TAU * (60 + 40 * exp(-t * 25)) * t) * exp(-t * 14); }
    return norm(x, .9);
  }
  function screech() {                                // high-friction tyre squeal: stick-slip tones + band noise
    const L = Math.round(SR * 2.4), o = new Float32Array(L), nz = loopNoise(L, x => bq(x, 'bp', 2300, 1.1)), F = [snap(1380, 2.4), snap(1850, 2.4), snap(2650, 2.4)], A = [.5, .38, .22];
    for (let i = 0; i < L; i++) {
      const t = i / SR; let v = 0; for (let j = 0; j < 3; j++) v += A[j] * sin(TAU * F[j] * t + 2.2 * sin(TAU * (14 + j * 5) / 2.4 * t + j));
      o[i] = (v + .55 * nz[i]) * (1 + .3 * sin(TAU * 7 / 2.4 * t));
    }
    return norm(o, .85);
  }
  function slideLoop() {                              // drift: lower, rubbery, broadband slide
    const L = Math.round(SR * 2.4), o = new Float32Array(L), a = loopNoise(L, x => bq(x, 'bp', 1500, .7)), b = loopNoise(L, x => bq(x, 'bp', 3300, .9));
    for (let i = 0; i < L; i++) { const t = i / SR; o[i] = (a[i] + .5 * b[i] + .16 * sin(TAU * snap(172, 2.4) * t + 1.5 * sin(TAU * 5 / 2.4 * t))) * (1 + .22 * sin(TAU * 3 / 2.4 * t)); }
    return norm(o, .85);
  }
  function spinLoop() {                               // wheel spin: raspy, chattering rubber
    const L = Math.round(SR * 1.6), o = new Float32Array(L), a = loopNoise(L, x => bq(x, 'hp', 1800, .7)), b = loopNoise(L, x => bq(x, 'bp', 4200, .8));
    for (let i = 0; i < L; i++) { const t = i / SR; o[i] = (a[i] * (.55 + .45 * sin(TAU * 35 / 1.6 * t)) + .5 * b[i]); }
    return norm(o, .85);
  }
  function crashCar() {                               // crunching metal + plastic + glass
    const x = mk(1.5), n = x.length, c1 = bq(wn(n), 'bp', 900, .5), c2 = bq(wn(n), 'hp', 3500, .7); let ph = 0;
    const P = [312, 547, 1103, 1731, 2410], A = [.25, .2, .14, .1, .07], D = [5, 6, 8, 11, 13], deb = [];
    for (let k = 0; k < 14; k++) deb.push([.12 + rnd() * .9, .1 + rnd() * .12]);
    for (let i = 0; i < n; i++) {
      const t = i / SR; ph += TAU * (38 + 60 * exp(-t * 9)) / SR;
      let v = .9 * sin(ph) * exp(-t * 7) + c1[i] * exp(-t * 4.5) * (.65 + .35 * sin(TAU * 31 * t)) * 1.3;
      for (const q of [.06, .13, .24]) if (t > q) v += c2[i] * exp(-(t - q) * 40) * .8;
      for (let j = 0; j < 5; j++) v += A[j] * sin(TAU * P[j] * t) * exp(-t * D[j]);
      for (const d of deb) if (t > d[0]) v += c2[i] * d[1] * exp(-(t - d[0]) * 90);
      x[i] = v;
    }
    return norm(x, .95);
  }
  function hitBarrier() {                             // sharp metallic clang + rattle
    const x = mk(1.1), n = x.length, cn = bq(wn(n), 'hp', 1500, .7), cb = bq(wn(n), 'bp', 1800, .8);
    const P = [440, 1130, 1790, 2740, 4100, 5600], A = [.5, .45, .35, .25, .15, .1], D = [4.5, 5.5, 7, 9, 12, 16];
    for (let i = 0; i < n; i++) {
      const t = i / SR; let v = cn[i] * exp(-t * 160) + .9 * sin(TAU * 95 * t) * exp(-t * 18);
      for (let j = 0; j < 6; j++) v += A[j] * sin(TAU * P[j] * t) * exp(-t * D[j]);
      for (const q of [.07, .15, .24]) if (t > q) v += (.4 * cb[i] + .3 * sin(TAU * 880 * t)) * exp(-(t - q) * 60) * .7;
      x[i] = v;
    }
    return norm(x, .95);
  }
  function scrapeLoop() {                             // metal-on-barrier friction, irregular stick-slip
    const L = Math.round(SR * 2.2), o = new Float32Array(L), nz = loopNoise(L, x => bq(bq(x, 'bp', 2100, 1.4), 'hp', 900, .7));
    const K = [snap(6, 2.2), snap(11, 2.2), snap(19, 2.2), snap(31, 2.2), snap(47, 2.2)];
    for (let i = 0; i < L; i++) {
      const t = i / SR; let e = 0; for (let j = 0; j < 5; j++) e += sin(TAU * K[j] * t + j * 1.3) / (j + 1);
      e = .55 + .45 * cl(e * .6, -1, 1); e *= e;
      o[i] = nz[i] * (.35 + e) + .13 * sin(TAU * snap(3150, 2.2) * t) * e;
    }
    return norm(o, .9);
  }
  function horn(f1, f2, dur, dbl) {                   // two-tone car horn, optional double honk
    const x = mk(dur), n = x.length, seg = dbl ? [[0, .21], [.3, dur - .02]] : [[0, dur - .02]];
    for (let i = 0; i < n; i++) {
      const t = i / SR; let e = 0;
      for (const s of seg) if (t >= s[0] && t < s[1]) { e = cl((t - s[0]) / .014, 0, 1) * cl((s[1] - t) / .04, 0, 1); break; }
      if (!e) continue;
      let v = 0; for (let h = 1; h <= 6; h++) v += (sin(TAU * h * f1 * t) + .85 * sin(TAU * h * f2 * t + .6)) / h;
      x[i] = e * tanh(1.5 * v * (1 + .1 * sin(TAU * 26 * t)));
    }
    return norm(bq(x, 'lp', 3400, .7), .85);
  }

  /* ---------------------------------------------------------------- runtime */
  const VA = { now: () => performance.now(), ctx: null, ready: false, running: false, gears: [0, .213, .41, .607, .82, 1.049] };
  const B = {}, V = {}, FILES = {};                   // buffers, voices, optional external files
  let M = null, lastU = 0, igT = 99, rpm = 900, shiftT = 0, lastG = 0, thrS = 0, boostOn = 0, pendIgn = false, ready = 0;
  const cool = { car: 0, barrier: 0, horn: 0 };
  const mkPlan = () => [['engLow', ENG_LOW], ['engHigh', ENG_HIGH], ['intake', INTAKE], ['crank', crank], ['hiss', hissLoop], ['blast', blast], ['screech', screech],
    ['slide', slideLoop], ['spin', spinLoop], ['scrape', scrapeLoop], ['crash_car', crashCar], ['hit_barrier', hitBarrier],
    ['horn0', () => horn(392, 495, .55, false)], ['horn1', () => horn(430, 540, .8, false)], ['horn2', () => horn(370, 466, .5, true)]];
  let PLAN = [];

  const setP = (p, v, tc) => p.setTargetAtTime(v, VA.ctx.currentTime, tc);
  function mkBuf(name, data) { const b = VA.ctx.createBuffer(1, data.length, SR); b.getChannelData(0).set(data); B[name] = b; startVoice(name); }
  function loopVoice(name, out, rate0) { const s = VA.ctx.createBufferSource(); s.buffer = B[name]; s.loop = true; if (rate0) s.playbackRate.value = rate0; const g = VA.ctx.createGain(); g.gain.value = 0; s.connect(g); g.connect(out); s.start(); return { s, g }; }
  function startVoice(name) {
    if (name === 'engLow') V.engLow = loopVoice(name, M.eng, 1);
    else if (name === 'engHigh') V.engHigh = loopVoice(name, M.eng, 1);
    else if (name === 'intake') V.intake = loopVoice(name, M.eng, 1);
    else if (name === 'hiss') V.hiss = loopVoice(name, M.hiss, 1);
    else if (name === 'screech' || name === 'slide' || name === 'spin' || name === 'scrape') V[name] = loopVoice(name, M.master, 1);
    if (B.engLow && B.engHigh && B.intake && B.crank && !VA.ready) { VA.ready = true; if (pendIgn) { pendIgn = false; VA.ignite(); } }
  }
  function build() {                                  // synthesise one buffer per idle tick
    if (!PLAN.length) return; const it = PLAN.shift(), nm = it[0];
    if (!(nm in FILES)) { try { mkBuf(nm, it[1]()); } catch (e) { console.warn('VA synth', nm, e); } }
    PLAN.length ? setTimeout(build, 0) : 0;
  }
  VA.init = function (ctx) {
    if (!ctx || VA.ctx === ctx) return; VA.ctx = ctx; VA.ready = false; VA.running = false; for (const k in V) delete V[k]; for (const k in B) delete B[k];
    const master = ctx.createGain(); master.gain.value = .95;
    const lim = ctx.createDynamicsCompressor(); lim.threshold.value = -6; lim.knee.value = 4; lim.ratio.value = 16; lim.attack.value = .001; lim.release.value = .12;
    const og = ctx.createGain(); og.gain.value = .82; master.connect(lim); lim.connect(og); og.connect(ctx.destination);
    /* engine bus: mix -> hp(removes bass phone speakers cannot play) -> saturation (harmonics) -> mid boost -> lowpass(rpm) */
    const eng = ctx.createGain(), hp = ctx.createBiquadFilter(), ws = ctx.createWaveShaper(), pk = ctx.createBiquadFilter(), lp = ctx.createBiquadFilter(), eo = ctx.createGain();
    hp.type = 'highpass'; hp.frequency.value = 150; hp.Q.value = .7; const cv = new Float32Array(2048); for (let i = 0; i < 2048; i++) cv[i] = tanh((i / 1023.5 - 1) * 2.4);
    ws.curve = cv; ws.oversample = '2x'; pk.type = 'peaking'; pk.frequency.value = 2000; pk.Q.value = .8; pk.gain.value = 6; lp.type = 'lowpass'; lp.frequency.value = 3500; lp.Q.value = .6; eo.gain.value = 0;
    eng.connect(hp); hp.connect(ws); ws.connect(pk); pk.connect(lp); lp.connect(eo); eo.connect(master);
    const hissBus = ctx.createGain(), hh = ctx.createBiquadFilter(); hh.type = 'highpass'; hh.frequency.value = 500; hissBus.connect(hh); hh.connect(master);
    M = { master, eng, lp, eo, hiss: hissBus, pan: !!ctx.createStereoPanner };
    PLAN = mkPlan();
    setTimeout(build, 0);
    for (const n in FILES) loadFile(n, FILES[n]);
  };
  function loadFile(name, url) {                      // optional: decode a real asset and use it instead of the synthesised one
    FILES[name] = url; if (!VA.ctx || !root.fetch) return;
    root.fetch(url).then(r => r.arrayBuffer()).then(ab => new Promise((ok, no) => VA.ctx.decodeAudioData(ab, ok, no))).then(b => { const k = name === 'scrape_wall' ? 'scrape' : name; B[k] = b; if (V[k]) { try { V[k].s.stop(); } catch (e) { } delete V[k]; startVoice(k); } }).catch(e => console.warn('VA file', name, e));
  }
  VA.useFiles = function (map) { for (const k in map) loadFile(k, map[k]); };

  function shot(name, gain, rate, pan) {              // one-shot voice
    const C = VA.ctx, b = B[name]; if (!C || !b) return; const s = C.createBufferSource(); s.buffer = b; if (rate) s.playbackRate.value = rate;
    const g = C.createGain(); g.gain.value = gain; s.connect(g); let out = g;
    if (pan && M.pan) { const p = C.createStereoPanner(); p.pan.value = cl(pan, -1, 1); g.connect(p); out = p; }
    out.connect(M.master); s.start();
  }

  /* ---- events ------------------------------------------------------------------------------ */
  VA.ignite = function () {                           // first throttle press -> crank -> engine takes over seamlessly
    if (!VA.ctx || VA.running) return; if (!VA.ready) { pendIgn = true; return; }
    const C = VA.ctx, T = C.currentTime; VA.running = true; igT = 0; rpm = 250; shiftT = 0; lastG = 0; thrS = 0;
    shot('crank', 1, 1, 0);
    const g = M.eo.gain; g.cancelScheduledValues(T); g.setValueAtTime(0, T); g.setValueAtTime(0, T + 1.0); g.linearRampToValueAtTime(1, T + 1.5);
  };
  VA.stop = function (fade) {                         // engine off (menu / crash / finish)
    pendIgn = false; if (!VA.ctx || !VA.running) return; VA.running = false; igT = 99;
    const g = M.eo.gain, T = VA.ctx.currentTime; g.cancelScheduledValues(T); g.setValueAtTime(g.value, T); g.linearRampToValueAtTime(0, T + (fade || .35));
  };
  VA.impact = function (kind, sn, pan) {              // sn: 0..1 impact speed
    if (!VA.ctx || !B.crash_car) return; const T = VA.ctx.currentTime, k = kind === 'barrier' ? 'barrier' : 'car';
    if (T < cool[k]) return; cool[k] = T + .16; const f = cl(sn, 0, 1);
    shot(k === 'car' ? 'crash_car' : 'hit_barrier', .35 + .65 * f, .94 + rnd() * .12 + (1 - f) * .1, pan || 0);
  };
  VA.horn = function (pan, hard) {
    if (!VA.ctx || !B.horn0) return; const T = VA.ctx.currentTime; if (T < cool.horn) return; cool.horn = T + 2.2;
    const v = hard ? 2 : (rnd() * 2) | 0; shot('horn' + v, .85 + .15 * rnd(), .96 + rnd() * .1, pan || 0);
  };

  /* ---- per-frame update: s = {play,sn,v,thr,boost,screech,slide,spin,scrape} (reused object, no allocation) ---- */
  VA.update = function (s) {
    if (!VA.ctx || !VA.ready) return; const now = VA.now(); if (now - lastU < 30) return; const dt = Math.min(.1, (now - lastU) / 1000); lastU = now;
    const C = VA.ctx, T = C.currentTime, run = VA.running && s.play;
    if (VA.running && !s.play) VA.stop(.4);
    /* tyres / scrape / nitro (work even before ignition) */
    const on = s.play ? 1 : 0;
    if (V.screech) { setP(V.screech.g.gain, s.screech * .85 * on, .05); setP(V.screech.s.playbackRate, .85 + .35 * s.sn, .1); }
    if (V.slide) { setP(V.slide.g.gain, s.slide * .8 * on, .06); setP(V.slide.s.playbackRate, .9 + .45 * s.sn, .1); }
    if (V.spin) { setP(V.spin.g.gain, s.spin * .75 * on, .04); setP(V.spin.s.playbackRate, .95 + .25 * s.sn, .08); }
    if (V.scrape) { setP(V.scrape.g.gain, s.scrape * .9 * on, .04); setP(V.scrape.s.playbackRate, .8 + .5 * s.sn, .1); }
    const bo = s.boost && s.play ? 1 : 0;
    if (V.hiss) setP(V.hiss.g.gain, bo * .7, bo ? .03 : .06);
    if (bo && !boostOn) shot('blast', .85, 1, 0);
    boostOn = bo;
    if (!run) return;
    /* engine: rpm model */
    igT += dt; thrS += ((s.thr ? 1 : 0) - thrS) * Math.min(1, dt * 8);
    const G = VA.gears, sp = s.sn; let g = 0; for (let i = 0; i < G.length; i++) if (sp >= G[i]) g = i;
    if (g > lastG && s.v > 6) shiftT = .18; lastG = g; shiftT = Math.max(0, shiftT - dt);
    const lo = G[g], hi = G[g + 1] || 1.15, fr = cl((sp - lo) / (hi - lo), 0, 1);
    let tgt;
    if (igT < 1.05) tgt = 250 + 60 * igT;             // cranking
    else if (igT < 1.5) tgt = 1900;                   // catch / flare
    else if (igT < 2.4) tgt = 1100 - 150 * cl((igT - 1.5) / .9, 0, 1);
    else {
      tgt = 1000 + fr * 5600; tgt = tgt * (.9 + .1 * thrS) + thrS * 380 + (bo ? 850 : 0);
      if (s.v < 4 && thrS > .1) tgt = Math.max(tgt, 3000 * thrS);   // launch: revs climb with throttle
      if (shiftT > 0) tgt -= 900; if (!s.thr && fr > .3) tgt *= .93;
    }
    rpm += (tgt - rpm) * Math.min(1, dt * (igT < 1.05 ? 3 : 7));
    const w = cl((rpm - 1800) / 3200, 0, 1), vol = (.55 + .3 * thrS + .15 * fr) * (s.play ? 1 : .5);
    if (V.engLow) { setP(V.engLow.g.gain, Math.cos(w * 1.5708) * vol * (rpm < 1200 ? 1 : .95), .05); setP(V.engLow.s.playbackRate, rpm / 900, .04); }
    if (V.engHigh) { setP(V.engHigh.g.gain, Math.sin(w * 1.5708) * vol * 1.0, .05); setP(V.engHigh.s.playbackRate, rpm / 2700, .04); }
    if (V.intake) setP(V.intake.g.gain, (.06 + .2 * thrS * (.4 + fr)) * vol, .08);
    setP(M.lp.frequency, 2600 + rpm * .55 + thrS * 1800 + (bo ? 1500 : 0), .06);
  };
  VA.reset = function () { if (VA.running) VA.stop(.05); igT = 99; pendIgn = false; rpm = 900; boostOn = 0; };
  VA.B = B; VA.V = V; VA.dbg = () => M; VA.state = () => ({ rpm, igT, thrS, shiftT, lastG });
  root.VehicleAudio = VA;
})(typeof window !== 'undefined' ? window : globalThis);

/* =====================================================================================
 *  GTR adapter — wires VehicleAudio into the game's controller (state read once per frame,
 *  no allocations; collision / near-miss hooks wrap the existing functions)
 * ===================================================================================== */
(function () {
  const VA = window.VehicleAudio, S = { play: false, sn: 0, v: 0, thr: false, boost: false, screech: 0, slide: 0, spin: 0, scrape: 0 };
  const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
  let brkT = 0, lastN = 0, scanT = 0, inTraffic = false;

  window.aud = function (boost) {                       // called once per frame from the game loop
    if (!AC) return; if (VA.ctx !== AC) VA.init(AC);
    const nw = performance.now(), dt = Math.min(.1, (nw - lastN) / 1000); lastN = nw;
    const racing = st === 'race', play = racing || st === 'count' || st === 'win', v = P.v, thr = !!(pdG || keys.ArrowUp || keys.KeyW);
    if (!VA.running && play && (thr || (racing && v > 3))) VA.ignite();     // first throttle press: crank -> engine
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
          if (dz > 2 && dz < 15 && Math.abs(t.x - P.x) < 2.3) { VA.horn(clamp((t.x - P.x) / 7, -1, 1), true); break; }
        }
      }
    } else brkT = 0;
    S.play = play; S.v = v; S.sn = clamp(v / Math.max(curV, 1), 0, 1.1); S.thr = thr; S.boost = !!boost;
    S.screech = screech; S.slide = slide; S.spin = spin; S.scrape = scrape;
    VA.update(S);
  };

  const _col = collide; collide = function () { inTraffic = true; try { return _col.apply(this, arguments); } finally { inTraffic = false; } };
  const _cr = crash; crash = function () {
    const live = invT <= 0, sh = shieldOn, sn = clamp(P.v / Math.max(curV, 1), 0, 1), px = P.x, r = _cr.apply(this, arguments);
    try { if (live && sn > .03 && (st === 'race' || st === 'crash')) VA.impact(inTraffic ? 'car' : 'barrier', sh ? sn * .5 : sn, clamp((imp.x - px) / 4, -1, 1)); } catch (e) { }
    return r;
  };
  const _nm = nearMiss; nearMiss = function () {                      // close call -> angry horn from the closest traffic car
    try {
      let best = null, bd = 2.9;
      for (let i = 0; i < traffic.length; i++) { const t = traffic[i]; if (!t.on || Math.abs(t.z - P.z) > 30) continue; const dx = Math.abs(t.x - P.x); if (dx < bd) { bd = dx; best = t; } }
      if (best && (bd < 2 || Math.random() < .5)) VA.horn(clamp((best.x - P.x) / 7, -1, 1), bd < 1.7);
    } catch (e) { }
    return _nm.apply(this, arguments);
  };
  const _rs = reset; reset = function () { try { VA.reset(); brkT = 0; } catch (e) { } return _rs.apply(this, arguments); };
})();
