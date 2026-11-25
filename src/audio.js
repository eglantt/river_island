function thunderGraph(ctx, dest0, buf, t0, near) {
  const R = Math.random, dest = ctx.createGain(); dest.gain.value = 2.8; dest.connect(dest0);
  const nb = (t, dur, f, q, vol, fEnd, att = 0.01, type = 'bandpass') => {
    const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true;
    const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.setValueAtTime(f, t); if (fEnd) fl.frequency.exponentialRampToValueAtTime(fEnd, t + att + dur); fl.Q.value = q;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 150; hp.Q.value = 0.7;
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + att); g.gain.exponentialRampToValueAtTime(0.0001, t + att + dur);
    s.connect(fl); fl.connect(hp); hp.connect(g); g.connect(dest); s.start(t, R() * 2); s.stop(t + att + dur + 0.1);
  };
  const v = 0.55 + 0.45 * near;
  // sharp dry crack for close strikes
  if (near > 0.35) {
    nb(t0, 0.12, 3200, 0.6, 1.4 * near, 1800, 0.002);
    nb(t0 + 0.03, 0.45, 1600, 0.7, 1.1 * near, 600, 0.004);
    for (let i = 0; i < 4; i++) nb(t0 + 0.05 + i * (0.05 + R() * 0.07), 0.12, 900 + R() * 1800, 1.2, 0.7 * near, null, 0.003);
  }
  // rolling rumble: a chain of overlapping mid-range bursts
  const k = 4 + Math.floor(R() * 4);
  for (let i = 0; i < k; i++) {
    const st = t0 + 0.1 + i * (0.35 + R() * 0.6);
    nb(st, 1.2 + R() * 1.6, 380 + R() * 700, 0.8, v * (1.0 - i * 0.08), 200, 0.08 + R() * 0.15);
    if (R() < 0.6) nb(st + 0.05, 0.35, 1100 + R() * 900, 1.0, v * 0.45, 500, 0.02);
  }
  // long tail and echo from the mountains
  nb(t0 + 0.2, 4.5 + R() * 2, 520, 0.6, v * 0.55, 220, 0.4);
  for (let e = 1; e <= 2; e++) nb(t0 + 1.4 * e + R() * 0.6, 1.6, 450 + R() * 300, 0.8, v * 0.35 / e, 230, 0.15);
}
export async function testThunder() {
  const sr = 22050, ctx = new OfflineAudioContext(1, sr * 9, sr), buf = ctx.createBuffer(1, sr * 3, sr), d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  // rain bed (same filters/gain as the ambience) on a separate render for comparison
  const band = (c, node) => { const h = c.createBiquadFilter(); h.type = 'highpass'; h.frequency.value = 300; const l = c.createBiquadFilter(); l.type = 'lowpass'; l.frequency.value = 3000; node.connect(h); h.connect(l); l.connect(c.destination); };
  const tg = ctx.createGain(); band(ctx, tg); thunderGraph(ctx, tg, buf, 0.1, 0.6);
  const out = (await ctx.startRendering()).getChannelData(0);
  const rc = new OfflineAudioContext(1, sr * 9, sr), rs = rc.createBufferSource(); rs.buffer = buf; rs.loop = true;
  const f1 = rc.createBiquadFilter(); f1.type = 'highpass'; f1.frequency.value = 900; const f2 = rc.createBiquadFilter(); f2.type = 'lowpass'; f2.frequency.value = 7500;
  const rg = rc.createGain(); rg.gain.value = 0.4 * 0.35; rs.connect(f1); f1.connect(f2); f2.connect(rg); band(rc, rg); rs.start();
  const ro = (await rc.startRendering()).getChannelData(0); let re = 0; for (let i = 0; i < ro.length; i++) re += ro[i] * ro[i];
  const rainRms = Math.sqrt(re / ro.length);
  let all = 0, hi = 0, peak = 0; const secs = [];
  for (let i = 1; i < out.length; i++) { all += out[i] * out[i]; const h = out[i] - out[i - 1]; hi += h * h; peak = Math.max(peak, Math.abs(out[i])); }
  for (let s = 0; s < 9; s++) { let e = 0; for (let i = s * sr; i < (s + 1) * sr; i++) e += out[i] * out[i]; secs.push(+Math.sqrt(e / sr).toFixed(3)); }
  const loud = Math.max(...secs.slice(0, 3));
  return { thunderBandRms_first3s: loud, rainBandRms_ducked: +rainRms.toFixed(3), dB_over_rain: +(20 * Math.log10(loud / rainRms)).toFixed(1), peak: +peak.toFixed(2), perSecond: secs };
}

// Fully synthesized ambience: wind, leaves, river, rain, birds, crickets, frogs, owl, splash, thunder, dragonfly buzz
export function createAudio() {
  let ac = null, master, noiseBuf, ch = {}, nextBird = 0, nextCricket = 0, nextFrog = 0, nextOwl = 0, buzz = null;
  const R = Math.random;
  function init() {
    if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
    try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ac = null; return; }
    master = ac.createGain(); master.gain.value = 0.7;
    const lim = ac.createDynamicsCompressor(); lim.threshold.value = -6; lim.knee.value = 6; lim.ratio.value = 12; lim.attack.value = 0.003; lim.release.value = 0.25;
    master.connect(lim); lim.connect(ac.destination);
    noiseBuf = ac.createBuffer(1, ac.sampleRate * 3, ac.sampleRate);
    const d = noiseBuf.getChannelData(0); let b = 0;
    for (let i = 0; i < d.length; i++) { const w = R() * 2 - 1; b = 0.985 * b + 0.15 * w; d[i] = w * 0.5 + b * 0.5; }
    const loop = (filters, vol) => {
      const s = ac.createBufferSource(); s.buffer = noiseBuf; s.loop = true; s.playbackRate.value = 0.8 + R() * 0.4;
      let node = s; for (const [type, f, q] of filters) { const fl = ac.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q; node.connect(fl); node = fl; }
      const g = ac.createGain(); g.gain.value = vol; node.connect(g); g.connect(master); s.start(); return { g, f: node };
    };
    ch.wind = loop([['bandpass', 380, 0.6]], 0);
    ch.leaves = loop([['highpass', 2200, 0.7], ['lowpass', 7000, 0.5]], 0);
    ch.river = loop([['lowpass', 900, 0.7], ['peaking', 520, 3]], 0);
    ch.babble = loop([['bandpass', 1400, 4]], 0);
    ch.rain = loop([['highpass', 900, 0.5], ['lowpass', 7500, 0.5]], 0);
    ch.rainLow = loop([['lowpass', 300, 0.5]], 0);
    const o = ac.createOscillator(), og = ac.createGain(), lf = ac.createOscillator(), lg = ac.createGain(), pan = ac.createStereoPanner ? ac.createStereoPanner() : ac.createGain();
    o.type = 'sawtooth'; o.frequency.value = 150; lf.frequency.value = 28; lg.gain.value = 40; lf.connect(lg); lg.connect(o.frequency);
    const bf = ac.createBiquadFilter(); bf.type = 'bandpass'; bf.frequency.value = 600; bf.Q.value = 1.5;
    o.connect(bf); bf.connect(og); og.gain.value = 0; og.connect(pan); pan.connect(master); o.start(); lf.start();
    buzz = { g: og, pan };
  }
  const env = (node, t, a, peak, dec) => { node.gain.setValueAtTime(0, t); node.gain.linearRampToValueAtTime(peak, t + a); node.gain.exponentialRampToValueAtTime(0.0001, t + a + dec); };
  const panner = (p) => { if (!ac.createStereoPanner) { const g = ac.createGain(); g.connect(master); return g; } const pn = ac.createStereoPanner(); pn.pan.value = p; pn.connect(master); return pn; };
  function chirp(vol) {
    const t0 = ac.currentTime, out = panner(R() * 1.6 - 0.8), base = 2200 + R() * 2600, n = 2 + Math.floor(R() * 6), kind = R();
    for (let i = 0; i < n; i++) {
      const t = t0 + i * (0.09 + R() * 0.08), o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine'; const f = base * (0.85 + R() * 0.35);
      o.frequency.setValueAtTime(f, t);
      if (kind < 0.5) o.frequency.exponentialRampToValueAtTime(f * (0.6 + R() * 0.3), t + 0.08); else o.frequency.exponentialRampToValueAtTime(f * 1.3, t + 0.06);
      env(g, t, 0.01, vol * (0.5 + R() * 0.5), 0.09); o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.2);
    }
  }
  function cricket(vol) {
    const t0 = ac.currentTime, out = panner(R() * 1.4 - 0.7), f = 4200 + R() * 900;
    for (let k = 0; k < 3; k++) for (let i = 0; i < 4; i++) {
      const t = t0 + k * 0.5 + i * 0.045, o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = f; env(g, t, 0.005, vol, 0.03); o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.06);
    }
  }
  function frog(vol) {
    const t0 = ac.currentTime, out = panner(R() * 1.6 - 0.8), n = 1 + Math.floor(R() * 3);
    for (let i = 0; i < n; i++) {
      const t = t0 + i * 0.35, o = ac.createOscillator(), am = ac.createOscillator(), ag = ac.createGain(), g = ac.createGain(), f = ac.createBiquadFilter();
      o.type = 'sawtooth'; o.frequency.setValueAtTime(110 + R() * 40, t); o.frequency.linearRampToValueAtTime(80, t + 0.2);
      am.frequency.value = 32; ag.gain.value = 0.5; am.connect(ag); ag.connect(g.gain);
      f.type = 'bandpass'; f.frequency.value = 700; f.Q.value = 3;
      env(g, t, 0.02, vol, 0.22); o.connect(f); f.connect(g); g.connect(out); o.start(t); am.start(t); o.stop(t + 0.3); am.stop(t + 0.3);
    }
  }
  function owl(vol) {
    const t0 = ac.currentTime, out = panner(R() * 1.2 - 0.6);
    [[0, 0.35], [0.55, 0.18], [0.8, 0.6]].forEach(([dt, len]) => {
      const t = t0 + dt, o = ac.createOscillator(), g = ac.createGain();
      o.frequency.setValueAtTime(400, t); o.frequency.linearRampToValueAtTime(360, t + len);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.05); g.gain.linearRampToValueAtTime(0.0001, t + len);
      o.connect(g); g.connect(out); o.start(t); o.stop(t + len + 0.05);
    });
  }
  function noiseBurst(t, dur, type, f, q, vol, out, fEnd) {
    const s = ac.createBufferSource(); s.buffer = noiseBuf; s.playbackRate.value = 1;
    const fl = ac.createBiquadFilter(); fl.type = type; fl.frequency.setValueAtTime(f, t); if (fEnd) fl.frequency.exponentialRampToValueAtTime(fEnd, t + dur); fl.Q.value = q;
    const g = ac.createGain(); env(g, t, 0.01, vol, dur); s.connect(fl); fl.connect(g); g.connect(out || master); s.start(t, R() * 2); s.stop(t + dur + 0.1);
  }
  function splash(vol) { if (!ac) return; const t = ac.currentTime; noiseBurst(t, 0.35, 'bandpass', 1800, 1.2, vol * 0.5, null, 700); noiseBurst(t + 0.05, 0.25, 'highpass', 3500, 0.7, vol * 0.25); }
  let duckFrom = 0, duckTo = 0;
  function thunder(delay, near) { if (!ac) return; const t = ac.currentTime + delay; thunderGraph(ac, master, noiseBuf, t, near); duckFrom = t; duckTo = t + 4.5; }
  const set = (g, v) => g.gain.setTargetAtTime(v, ac.currentTime, 0.4);
  function update(dt, s) {
    if (!ac) return;
    master.gain.setTargetAtTime(s.volume, ac.currentTime, 0.2);
    set(ch.wind.g, 0.05 + s.wind * 0.35 * (0.5 + s.gust)); ch.wind.f.frequency.setTargetAtTime(260 + s.gust * 380 + s.wind * 200, ac.currentTime, 0.5);
    set(ch.leaves.g, s.wind * 0.12 * (0.3 + s.gust));
    set(ch.river.g, 0.10 + 0.22 * s.water); set(ch.babble.g, 0.05 * s.water);
    ch.babble.f.frequency.setTargetAtTime(1100 + Math.sin(performance.now() * 0.0013) * 300 + Math.sin(performance.now() * 0.0047) * 200, ac.currentTime, 0.1);
    const duck = ac.currentTime > duckFrom && ac.currentTime < duckTo ? 0.35 : 1;
    set(ch.rain.g, s.rain * 0.4 * duck); set(ch.rainLow.g, s.rain * 0.25 * duck);
    const now = ac.currentTime;
    if (now > nextBird) { if (s.birds > 0.05 && R() < s.birds) chirp(0.05 + 0.05 * s.birds); nextBird = now + (0.6 + R() * 4) / (0.3 + s.birds); }
    if (now > nextCricket) { if (s.crickets > 0.05) cricket(0.012 * s.crickets); nextCricket = now + 0.8 + R() * 1.5 / (0.2 + s.crickets); }
    if (now > nextFrog) { if (s.frogs > 0.05 && R() < s.frogs) frog(0.06); nextFrog = now + 2 + R() * 6; }
    if (now > nextOwl) { if (s.owl > 0.3 && R() < 0.5) owl(0.05); nextOwl = now + 12 + R() * 25; }
    set(buzz.g, s.buzz * 0.05); if (buzz.pan.pan) buzz.pan.pan.setTargetAtTime(s.buzzPan, now, 0.1);
  }
  let fireCh = null, nextCrackle = 0;
  function step(kind, vol = 1) {
    if (!ac) return; const t = ac.currentTime, v = (0.8 + Math.random() * 0.4) * vol, f = 0.85 + Math.random() * 0.3;
    if (kind === 'water') { noiseBurst(t, 0.22, 'bandpass', 1300 * f, 1, 0.16 * v, null, 600); return; }
    if (kind === 'stone') { noiseBurst(t, 0.04, 'bandpass', 2600 * f, 3, 0.18 * v); noiseBurst(t, 0.06, 'lowpass', 320, 0.7, 0.12 * v); return; }
    if (kind === 'sand') { noiseBurst(t, 0.11, 'bandpass', 3400 * f, 1.2, 0.09 * v); noiseBurst(t + 0.035, 0.07, 'bandpass', 2600 * f, 1.4, 0.06 * v); return; }
    noiseBurst(t, 0.09, 'bandpass', 1700 * f, 0.8, 0.08 * v); noiseBurst(t + 0.01, 0.06, 'highpass', 4200, 0.7, 0.05 * v);
  }
  function fireSound(level, rain) {
    if (!ac) return;
    if (!fireCh) {
      const mk = (type, f, q) => { const s = ac.createBufferSource(); s.buffer = noiseBuf; s.loop = true; const fl = ac.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q; const g = ac.createGain(); g.gain.value = 0; s.connect(fl); fl.connect(g); g.connect(master); s.start(); return g; };
      fireCh = { roar: mk('lowpass', 420, 0.7), hiss: mk('bandpass', 5200, 0.8) };
    }
    set(fireCh.roar, level * 0.22); set(fireCh.hiss, level * rain * 0.12 + (level > 0 ? 0.004 : 0));
    const now = ac.currentTime;
    if (level > 0.03 && now > nextCrackle) {
      const n = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) noiseBurst(now + i * 0.03, 0.012 + Math.random() * 0.03, 'highpass', 1800 + Math.random() * 2500, 0.7, (0.05 + Math.random() * 0.12) * level);
      nextCrackle = now + (0.08 + Math.random() * 0.5) / (0.3 + level);
    }
  }
  function suspend(v) { if (!ac) return; v ? ac.suspend() : ac.resume(); }
  return { init, update, splash, thunder, step, fireSound, suspend, get on() { return !!ac; } };
}
