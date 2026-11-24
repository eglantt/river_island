// Fully synthesized ambience: wind, leaves, river, rain, birds, crickets, frogs, owl, splash, thunder, dragonfly buzz
export function createAudio() {
  let ac = null, master, noiseBuf, ch = {}, nextBird = 0, nextCricket = 0, nextFrog = 0, nextOwl = 0, buzz = null;
  const R = Math.random;
  function init() {
    if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
    try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ac = null; return; }
    master = ac.createGain(); master.gain.value = 0.7; master.connect(ac.destination);
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
  function thunder(delay, near) {
    if (!ac) return; const t = ac.currentTime + delay;
    if (near > 0.5) noiseBurst(t, 0.4, 'highpass', 1500, 0.5, 0.35 * near);
    noiseBurst(t + 0.05, 4 + R() * 2, 'lowpass', 260, 0.8, 0.9 * (0.4 + near * 0.6), null, 60);
    noiseBurst(t + 0.6 + R(), 3, 'lowpass', 160, 0.8, 0.5, null, 50);
  }
  const set = (g, v) => g.gain.setTargetAtTime(v, ac.currentTime, 0.4);
  function update(dt, s) {
    if (!ac) return;
    master.gain.setTargetAtTime(s.volume, ac.currentTime, 0.2);
    set(ch.wind.g, 0.05 + s.wind * 0.35 * (0.5 + s.gust)); ch.wind.f.frequency.setTargetAtTime(260 + s.gust * 380 + s.wind * 200, ac.currentTime, 0.5);
    set(ch.leaves.g, s.wind * 0.12 * (0.3 + s.gust));
    set(ch.river.g, 0.10 + 0.22 * s.water); set(ch.babble.g, 0.05 * s.water);
    ch.babble.f.frequency.setTargetAtTime(1100 + Math.sin(performance.now() * 0.0013) * 300 + Math.sin(performance.now() * 0.0047) * 200, ac.currentTime, 0.1);
    set(ch.rain.g, s.rain * 0.4); set(ch.rainLow.g, s.rain * 0.25);
    const now = ac.currentTime;
    if (now > nextBird) { if (s.birds > 0.05 && R() < s.birds) chirp(0.05 + 0.05 * s.birds); nextBird = now + (0.6 + R() * 4) / (0.3 + s.birds); }
    if (now > nextCricket) { if (s.crickets > 0.05) cricket(0.012 * s.crickets); nextCricket = now + 0.8 + R() * 1.5 / (0.2 + s.crickets); }
    if (now > nextFrog) { if (s.frogs > 0.05 && R() < s.frogs) frog(0.06); nextFrog = now + 2 + R() * 6; }
    if (now > nextOwl) { if (s.owl > 0.3 && R() < 0.5) owl(0.05); nextOwl = now + 12 + R() * 25; }
    set(buzz.g, s.buzz * 0.05); if (buzz.pan.pan) buzz.pan.pan.setTargetAtTime(s.buzzPan, now, 0.1);
  }
  function suspend(v) { if (!ac) return; v ? ac.suspend() : ac.resume(); }
  return { init, update, splash, thunder, suspend, get on() { return !!ac; } };
}
