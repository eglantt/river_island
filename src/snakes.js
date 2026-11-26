import * as THREE from 'three';
import { rng } from './noise.js';
import { patch, U } from './shaders.js';

// Grass snakes (Natrix natrix): body is a tube that follows the exact trail of the head (lateral undulation),
// keeled scales and checkered belly in the shader, yellow "ear" patches, white labials, flicking forked tongue.
// Behaviour: crawl, bask coiled in the sun, slide into the water and swim with the head raised, flee from the
// player, hide at night and in rain. Two snakes live on the island, one along the river bank.
const V = THREE.Vector3;
const NODES = 56, RAD = 12;

export function createSnakes(world, Q, scene) {
  const R = rng(4242), { H, islandE, zc0, mz, hwAt } = world;
  const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const obst = world.trunks.map((t) => [t[0], t[1], t[2]]).concat(world.rockList || []);

  // ---------- materials ----------
  const mkMat = (base, spots, L) => {
    const m = patch(new THREE.MeshPhongMaterial({ vertexColors: false, color: 0xffffff, shininess: 38, specular: new THREE.Color(0.16, 0.16, 0.15) }), 'snake' + spots, 0);
    const ob = m.onBeforeCompile;
    m.customProgramCacheKey = () => 'snake' + spots;
    m.onBeforeCompile = (sh) => {
      ob(sh);
      sh.uniforms.uBase = { value: base }; sh.uniforms.uSpots = { value: spots }; sh.uniforms.uLen = { value: L };
      sh.vertexShader = 'attribute vec2 aS; varying vec2 vS;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvS = aS;');
      sh.fragmentShader = 'varying vec2 vS; uniform vec3 uBase; uniform float uSpots, uLen;\n' + sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      {
        // vS.x: metres from the snout along the body, vS.y: 0..1 around (0 = spine, 0.5 = belly centre)
        float a = vS.y * 6.2831853, ca = cos(a), along = vS.x;
        float belly = smoothstep(-0.78, -0.9, ca);
        // dorsal scales: 19 rows around, diamond cells offset per row, dark seams and a keel highlight
        float rows = 19.0, sv = vS.y * rows, su = along / 0.0062 + 0.5 * mod(floor(sv), 2.0);
        vec2 f = fract(vec2(su, sv)) - 0.5;
        float d = abs(f.x) * 1.15 + abs(f.y);
        float seam = smoothstep(0.38, 0.52, d), keel = (1.0 - smoothstep(0.0, 0.09, abs(f.y))) * (1.0 - smoothstep(0.15, 0.45, abs(f.x)));
        vec3 dors = uBase * (0.92 + 0.16 * fract(sin(dot(floor(vec2(su, sv)), vec2(12.9898, 78.233))) * 43758.5453));
        // olive morph: small dark spots in rows along the back and flanks
        if (uSpots > 0.5) { vec2 g = vec2(along / 0.035, vS.y * 7.0); vec2 gf = fract(g + vec2(0.5 * mod(floor(g.y), 2.0), 0.0)) - 0.5; dors *= 1.0 - 0.55 * (1.0 - smoothstep(0.12, 0.22, length(gf * vec2(1.0, 1.4)))); }
        dors *= 1.0 - seam * 0.3; dors += keel * 0.05;
        // belly: wide scutes, white-cream with black checks, darker toward the tail
        float sc = floor(along / 0.0075), side = step(0.5, vS.y);
        float chk = step(0.5, fract((sc + side) * 0.5)) * smoothstep(0.1, 0.35, abs(ca + 1.0) + 0.2);
        vec3 bel = mix(vec3(0.82, 0.8, 0.7), vec3(0.06, 0.06, 0.06), clamp(chk * 0.85 + smoothstep(0.35, 0.7, along / uLen) * 0.6, 0.0, 1.0));
        bel *= 1.0 - 0.35 * smoothstep(0.42, 0.5, abs(fract(along / 0.0075) - 0.5));
        vec3 col = mix(dors, bel, belly);
        // yellow "ears" behind the head with black edge behind them (flanks only)
        float neck = smoothstep(0.0, 0.004, along) * (1.0 - smoothstep(0.022, 0.027, along)) * smoothstep(0.5, 0.75, abs(sin(a))) * smoothstep(-0.1, 0.25, -ca + 0.3) * (1.0 - belly);
        float blk = smoothstep(0.023, 0.028, along) * (1.0 - smoothstep(0.04, 0.046, along)) * smoothstep(0.05, 0.3, abs(sin(a))) * (1.0 - belly);
        col = mix(col, vec3(0.95, 0.78, 0.22), neck); col = mix(col, vec3(0.03, 0.03, 0.03), blk);
        diffuseColor.rgb = col;
      }`);
    };
    return m;
  };

  // ---------- head geometry (local: +x forward, origin at the back of the head) ----------
  function headGeo(base) {
    const g = new THREE.SphereGeometry(1, 18, 12), P = g.attributes.position, v = new V(), cols = [];
    const dark = base.clone().multiplyScalar(0.9), lab = new THREE.Color(0.9, 0.88, 0.8), blk = new THREE.Color(0.04, 0.04, 0.04);
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i);
      const u = (v.x + 1) / 2; // 0 back .. 1 snout
      const w = 0.0085 * (1 - 0.32 * u * u) + 0.001, hgt = 0.0062 * (1 - 0.3 * u);
      let y = v.y * hgt; if (y > 0.003) y = 0.003 + (y - 0.003) * 0.6; // flat crown
      if (v.y < -0.2) y *= 0.8;
      P.setXYZ(i, u * 0.03, y, v.z * w);
      // colours: dark crown, white labials with black bars on the lower sides, pale chin
      let c = dark;
      if (v.y < -0.05 && v.y > -0.55 && u > 0.15) c = Math.abs(Math.sin(u * 26)) < 0.18 ? blk : lab;
      else if (v.y <= -0.55) c = lab;
      cols.push(c.r, c.g, c.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3)); g.computeVertexNormals();
    // eyes: large, round, dark with a glint, high on the sides toward the front
    const parts = [g];
    for (const sd of [-1, 1]) {
      const e = new THREE.SphereGeometry(0.0025, 10, 8).scale(1, 1, 0.75).translate(0.02, 0.0018, sd * 0.0062);
      const n = e.attributes.position.count; e.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(0.02), 3)); parts.push(e);
      const ring = new THREE.TorusGeometry(0.0025, 0.0005, 4, 12).rotateX(Math.PI / 2).rotateX(sd * 0.3).translate(0.02, 0.0018, sd * 0.006);
      const nr = ring.attributes.position.count; ring.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: nr }, () => [0.55, 0.45, 0.2]).flat(), 3)); parts.push(ring);
    }
    return merge(parts);
  }
  function tongueGeo() { // forked tongue, local +x forward from the snout tip
    const pos = [], w = 0.0007;
    const seg = (a, b) => { pos.push(a[0], a[1], -w, b[0], b[1], -w, b[0], b[1], w, a[0], a[1], -w, b[0], b[1], w, a[0], a[1], w); };
    seg([0, 0], [0.012, 0]);
    for (const sd of [-1, 1]) { const p = [0.012, 0], q = [0.019, 0]; pos.push(p[0], 0, 0, q[0], 0, sd * 0.003, q[0], 0.0006, sd * 0.003); pos.push(p[0], 0, 0, q[0], 0.0006, sd * 0.003, p[0], 0.0006, 0); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
    return g;
  }
  function merge(list) {
    const pos = [], nor = [], col = [];
    for (const g0 of list) {
      const g = g0.index ? g0.toNonIndexed() : g0, P = g.attributes.position, Nn = g.attributes.normal, Cc = g.attributes.color;
      for (let i = 0; i < P.count; i++) { pos.push(P.getX(i), P.getY(i), P.getZ(i)); nor.push(Nn.getX(i), Nn.getY(i), Nn.getZ(i)); col.push(Cc.getX(i), Cc.getY(i), Cc.getZ(i)); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('sway', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3), 1));
    return g;
  }

  // ---------- spots ----------
  const islandPt = (emin, emax) => { for (let t = 0; t < 300; t++) { const x = (R() * 2 - 1) * 28, z = zc0 + (R() * 2 - 1) * 20, e = islandE(x, z); if (e > emin && e < emax && H(x, z) > 0.12) return new V(x, 0, z); } return new V(0, 0, zc0); };
  const islandWater = () => { for (let t = 0; t < 300; t++) { const x = (R() * 2 - 1) * 32, z = zc0 + (R() * 2 - 1) * 24, h = H(x, z); if (h < -0.25 && h > -1.6 && islandE(x, z) < 1.45) return new V(x, 0, z); } return new V(0, 0, zc0 + 16); };
  // the bank snake: a stretch of the mainland shore opposite the island
  const bankX = (R() - 0.5) * 50, bankSide = R() < 0.5 ? -1 : 1;
  const bankPt = (wet) => {
    for (let t = 0; t < 300; t++) {
      const x = bankX + (R() - 0.5) * 30, z = mz(x) + bankSide * (hwAt(x) + (wet ? -2 - R() * 4 : 0.5 + R() * 5)), h = H(x, z);
      if (wet ? h < -0.25 && h > -1.5 : h > 0.1 && h < 2.5) return new V(x, 0, z);
    }
    return new V(bankX, 0, mz(bankX) + bankSide * hwAt(bankX));
  };

  // ---------- snakes ----------
  const looks = [
    { base: new THREE.Color(0.075, 0.078, 0.08), spots: 0 },  // black
    { base: new THREE.Color(0.2, 0.21, 0.19), spots: 1 },    // grey-olive with spots
    { base: new THREE.Color(0.1, 0.11, 0.1), spots: 0 },
  ];
  const snakes = [];
  for (let k = 0; k < 3; k++) {
    const bank = k === 2, L = 0.75 + R() * 0.25, look = looks[k];
    const mat = mkMat(look.base, look.spots, L);
    // body tube
    const nV = NODES * (RAD + 1), pos = new Float32Array(nV * 3), nor = new Float32Array(nV * 3), aS = new Float32Array(nV * 2), idx = [];
    for (let i = 0; i < NODES - 1; i++) for (let j = 0; j < RAD; j++) { const a = i * (RAD + 1) + j, b = a + 1, c = a + RAD + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
    for (let i = 0; i < NODES; i++) for (let j = 0; j <= RAD; j++) { const q = i * (RAD + 1) + j; aS[q * 2] = i / (NODES - 1) * L; aS[q * 2 + 1] = j / RAD; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); g.setAttribute('aS', new THREE.BufferAttribute(aS, 2));
    g.setAttribute('sway', new THREE.BufferAttribute(new Float32Array(nV), 1)); g.setIndex(idx);
    const body = new THREE.Mesh(g, mat); body.frustumCulled = false; body.castShadow = true; body.receiveShadow = true; scene.add(body);
    const hm = patch(new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 50, specular: new THREE.Color(0.2, 0.2, 0.2) }), 'snakeH', 0);
    const head = new THREE.Mesh(headGeo(look.base), hm); head.castShadow = true; scene.add(head);
    const tg = tongueGeo(); tg.setAttribute('sway', new THREE.Float32BufferAttribute(new Float32Array(tg.attributes.position.count), 1));
    const tongue = new THREE.Mesh(tg, patch(new THREE.MeshLambertMaterial({ color: 0x141012, side: THREE.DoubleSide }), 'tongue', 0)); head.add(tongue);
    tongue.position.set(0.029, -0.0012, 0); tongue.scale.set(0.001, 1, 1);
    // initial trail: a gentle S on land
    const start = bank ? bankPt(false) : islandPt(0.2, 0.7), trail = [];
    const a0 = R() * 6.28;
    for (let i = 0; i <= 120; i++) { const s = i / 120 * (L + 0.1); trail.push(new V(start.x - Math.cos(a0) * s + Math.sin(s * 9) * 0.04 * Math.sin(a0), 0, start.z - Math.sin(a0) * s - Math.sin(s * 9) * 0.04 * Math.cos(a0))); }
    snakes.push({
      bank, L, body, head, tongue, trail, hd: new V().copy(start), th: a0, ph: R() * 6, spd: 0, state: 'crawl', goal: null, stateT: 0, nextT: 5 + R() * 10,
      tongueT: 0, nextTongue: 1 + R() * 3, lift: 0, coil: 0, hidden: 0, wet: 0, look: 0, lookT: 0, slot: 6 + k, splashed: false, rMax: L * 0.0165,
    });
  }

  // ---------- behaviour ----------
  const groundY = (x, z, r) => { const h = H(x, z); return Math.max(h + r * 0.85, r * 0.3); };
  const pickGoal = (s, env) => {
    const sunny = env.sunInt * (1 - (env.cover || 0)) > 0.35 && env.day > 0.5;
    const r = R();
    if (sunny && r < 0.35) { s.state = 'toBask'; s.goal = s.bank ? bankPt(false) : islandPt(0.55, 0.95); return; }
    if (r < 0.65) { s.state = 'crawl'; s.goal = s.bank ? (R() < 0.5 ? bankPt(true) : bankPt(false)) : (R() < 0.45 ? islandWater() : islandPt(0.15, 0.9)); return; }
    s.state = 'crawl'; s.goal = s.bank ? bankPt(false) : islandPt(0.15, 0.9);
  };
  const tmp = new V(), side = new V(), upv = new V(), T = new V(), Pn = [], Tn = [];
  for (let i = 0; i < NODES; i++) { Pn.push(new V()); Tn.push(new V()); }
  const radius = (s, u) => { // u: 0 snout .. 1 tail tip
    const neck = 0.58 + 0.42 * sm(0.0, 0.13, u), tail = 1 - sm(0.7, 1.0, u) * 0.9;
    return s.rMax * neck * tail * (1 + 0.05 * Math.sin(u * 40));
  };

  function update(dt, t, env) {
    dt = Math.min(dt, 0.1);
    const night = env.night > 0.55, wetW = (env.rain || 0) > 0.25, cam = env.cam;
    for (let k = 0; k < snakes.length; k++) {
      const s = snakes[k];
      // hide at night / in rain: crawl into cover and sink out of sight; come back later
      const wantHide = night || wetW;
      if (wantHide && s.state !== 'hide' && s.state !== 'hidden') { s.state = 'hide'; s.goal = s.bank ? bankPt(false) : islandPt(0.4, 0.85); }
      if (!wantHide && (s.state === 'hide' || s.state === 'hidden')) { s.hidden = Math.max(0, s.hidden - dt * 0.3); if (s.hidden <= 0) { s.state = 'crawl'; pickGoal(s, env); } }
      // flee from the player
      const dp = cam ? Math.hypot(cam.x - s.hd.x, cam.z - s.hd.z) : 99;
      if (!s.noFlee && dp < 3.0 && cam && (s.state === 'bask' || s.state === 'crawl' || s.state === 'toBask') && cam.y - H(cam.x, cam.z) < 4) {
        s.state = 'flee'; s.stateT = 4 + R() * 3;
        const away = new V(s.hd.x - cam.x, 0, s.hd.z - cam.z).normalize();
        const w = s.bank ? bankPt(true) : islandWater();
        s.goal = new V(w.x - s.hd.x, 0, w.z - s.hd.z).normalize().dot(away) > 0 ? w : s.hd.clone().addScaledVector(away, 4);
      }
      const inWater = H(s.hd.x, s.hd.z) < -0.06;
      if (inWater && !s.splashed) { env.ripple(s.hd.x, s.hd.z, 0.12); s.splashed = true; }
      if (!inWater) s.splashed = false;
      s.wet += ((inWater ? 1 : 0) - s.wet) * Math.min(1, dt * 2);
      // target speed per state
      let want = 0;
      if (s.state === 'bask') { s.stateT -= dt; if (s.stateT <= 0) pickGoal(s, env); }
      else if (s.state === 'hidden') want = 0;
      else {
        const toG = s.goal ? Math.hypot(s.goal.x - s.hd.x, s.goal.z - s.hd.z) : 0;
        want = s.state === 'flee' ? 0.65 : inWater ? 0.42 : 0.26 + 0.1 * Math.sin(t * 0.3 + k);
        if (s.state === 'flee') { s.stateT -= dt; if (s.stateT <= 0) pickGoal(s, env); }
        // occasional pauses while crawling
        if (s.state === 'crawl' && Math.sin(t * 0.21 + k * 2.1) > 0.85) want *= 0.05;
        if (s.state === 'toBask' && toG < 0.4) { s.state = 'coil'; s.coil = 0; s.coilDir = R() < 0.5 ? 1 : -1; s.coilR = 0.13 + R() * 0.03; }
        else if (s.state === 'coil') { want = 0.18; s.coil += want * dt; if (s.coil > s.L * 1.05) { s.state = 'bask'; s.stateT = 30 + R() * 60; } }
        else if ((s.state === 'crawl' || s.state === 'hide') && toG < 0.35) { if (s.state === 'hide') { s.state = 'hidden'; } else pickGoal(s, env); }
        if (!s.goal) pickGoal(s, env);
      }
      if (s.state === 'hidden') s.hidden = Math.min(1, s.hidden + dt * 0.3);
      s.spd += (want - s.spd) * Math.min(1, dt * 3);
      // steering: toward the goal, lateral undulation, obstacle avoidance, stay near home
      if (s.spd > 0.005) {
        let wantTh = s.th;
        if (s.state === 'coil') s.th += s.coilDir * s.spd / Math.max(0.06, s.coilR - s.coil * 0.06) * dt;
        else {
          if (s.goal) wantTh = Math.atan2(s.goal.z - s.hd.z, s.goal.x - s.hd.x);
          let dTh = Math.atan2(Math.sin(wantTh - s.th), Math.cos(wantTh - s.th));
          // avoid trunks and rocks
          for (const [ox, oz, orr] of obst) {
            const dx = ox - s.hd.x, dz = oz - s.hd.z, dd = Math.hypot(dx, dz);
            if (dd < orr + 0.5) { const fa = Math.atan2(dz, dx), rel = Math.atan2(Math.sin(fa - s.th), Math.cos(fa - s.th)); if (Math.abs(rel) < 1.3) dTh += (rel > 0 ? -1 : 1) * 1.5 * (1 - (dd - orr) / 0.5); }
          }
          s.ph += s.spd * dt * (inWater ? 14 : 17);
          const und = Math.sin(s.ph) * (inWater ? 1.5 : 2.1);
          s.th += (Math.max(-1.6, Math.min(1.6, dTh)) * 1.2 + und) * dt * Math.min(1, s.spd / 0.15 + 0.2);
        }
        const nx = s.hd.x + Math.cos(s.th) * s.spd * dt, nz = s.hd.z + Math.sin(s.th) * s.spd * dt;
        const tooDeep = H(nx, nz) < -1.7, offHome = s.bank ? Math.abs(nx - bankX) > 26 : islandE(nx, nz) > 1.5;
        if (tooDeep || offHome) { s.th += 2.2 * dt * 3; s.goal = s.bank ? bankPt(false) : islandPt(0.2, 0.8); if (s.state === 'flee') s.state = 'crawl'; }
        else { s.hd.x = nx; s.hd.z = nz; }
        // extend the trail
        const last = s.trail[0];
        if (Math.hypot(s.hd.x - last.x, s.hd.z - last.z) > 0.008) { s.trail.unshift(new V(s.hd.x, 0, s.hd.z)); if (s.trail.length > 400) s.trail.length = 400; }
      }
      // ---- body: sample the trail by arclength ----
      const ds = s.L / (NODES - 1);
      let ti = 0, acc = 0; Pn[0].set(s.hd.x, 0, s.hd.z);
      let prev = Pn[0].clone();
      for (let i = 1; i < NODES; i++) {
        const need = i * ds;
        while (ti < s.trail.length - 1) {
          const a = ti === 0 ? Pn[0] : s.trail[ti], b = s.trail[ti + 1] || s.trail[ti], seg = a.distanceTo(b);
          if (acc + seg >= need && seg > 1e-6) { Pn[i].copy(a).lerp(b, (need - acc) / seg); break; }
          acc += seg; ti++;
        }
        if (ti >= s.trail.length - 1) Pn[i].copy(prev).add(tmp.subVectors(prev, Pn[Math.max(0, i - 2)]).setY(0));
        prev = Pn[i];
      }
      // heights: on the ground, or at the water surface; head raised when swimming / basking alert
      const alert = s.state === 'bask' ? 0.35 + 0.35 * Math.max(0, Math.sin(t * 0.13 + k)) : s.state === 'flee' ? 0.6 : 0.15;
      s.lift += ((s.wet > 0.5 ? 1 : alert) - s.lift) * Math.min(1, dt * 2);
      const sinkH = s.hidden * 0.12;
      for (let i = 0; i < NODES; i++) {
        const u = i / (NODES - 1), r = radius(s, u);
        let y = groundY(Pn[i].x, Pn[i].z, r);
        const hl = Math.max(0, 1 - i / 6); y += hl * hl * (0.012 + 0.03 * s.lift) * (s.state === 'hidden' ? 0 : 1);
Pn[i].y = y - sinkH;
      }
      // coils: lift crossing body segments over the ones beneath
      const lifts = new Float32Array(NODES);
      for (let i = 0; i < NODES; i++) for (let j = i + 8; j < NODES; j++) {
        const d = Math.hypot(Pn[i].x - Pn[j].x, Pn[i].z - Pn[j].z), rr = radius(s, i / (NODES - 1)) + radius(s, j / (NODES - 1));
        if (d < rr * 1.05) lifts[i] = Math.max(lifts[i], (rr * 1.05 - d) * 1.6);
      }
      for (let i = 0; i < NODES; i++) { let a = 0, w = 0; for (let k2 = -3; k2 <= 3; k2++) { const q = i + k2; if (q < 0 || q >= NODES) continue; const ww = 4 - Math.abs(k2); a += lifts[q] * ww; w += ww; } Pn[i].y += a / w; }
      // tube vertices
      const P = s.body.geometry.attributes.position.array, Nr = s.body.geometry.attributes.normal.array;
      for (let i = 0; i < NODES; i++) {
        const a = Pn[Math.max(0, i - 1)], b = Pn[Math.min(NODES - 1, i + 1)];
        T.subVectors(a, b).normalize(); Tn[i].copy(T); // toward the head
        side.crossVectors(new V(0, 1, 0), T).normalize(); upv.crossVectors(T, side).normalize();
        const r = radius(s, i / (NODES - 1)), rw = r * 1.08, rh = r * 0.9;
        for (let j = 0; j <= RAD; j++) {
          const ang = j / RAD * Math.PI * 2, ca = Math.cos(ang), sa = Math.sin(ang);
          const yy = ca < 0 ? ca * 0.82 : ca; // flatter belly
          const q = (i * (RAD + 1) + j) * 3;
          P[q] = Pn[i].x + upv.x * yy * rh + side.x * sa * rw; P[q + 1] = Pn[i].y + upv.y * yy * rh + side.y * sa * rw; P[q + 2] = Pn[i].z + upv.z * yy * rh + side.z * sa * rw;
          const nx = upv.x * yy / rh + side.x * sa / rw, ny = upv.y * yy / rh + side.y * sa / rw, nz = upv.z * yy / rh + side.z * sa / rw, nl = Math.hypot(nx, ny, nz) || 1;
          Nr[q] = nx / nl; Nr[q + 1] = ny / nl; Nr[q + 2] = nz / nl;
        }
      }
      s.body.geometry.attributes.position.needsUpdate = true; s.body.geometry.attributes.normal.needsUpdate = true;
      s.body.geometry.computeBoundingSphere();
      // head: sits in front of node 0, along its tangent, with a little look-around while basking
      s.lookT -= dt; if (s.lookT <= 0) { s.look = s.state === 'bask' ? (R() - 0.5) * 1.2 : (R() - 0.5) * 0.3; s.lookT = 1.5 + R() * 3; }
      const yaw = Math.atan2(-Tn[0].z, Tn[0].x), pitch = Math.asin(Math.max(-1, Math.min(1, Tn[0].y)));
      s.head.rotation.set(0, 0, 0); s.head.rotation.order = 'YZX';
      s.head.rotation.y = yaw + (s.curLook = (s.curLook || 0) + (s.look - (s.curLook || 0)) * Math.min(1, dt * 2)); s.head.rotation.z = pitch + 0.08 * s.lift;
      s.head.position.copy(Pn[0]).addScaledVector(Tn[0], -0.004); s.head.position.y += 0.0005;
      const hs = s.rMax / 0.0145; s.head.scale.setScalar(hs);
      // tongue flicks
      s.nextTongue -= dt;
      if (s.nextTongue <= 0 && s.state !== 'hidden') { s.tongueT = 0.001; s.nextTongue = (s.state === 'bask' ? 2 : 1) + R() * 4; }
      if (s.tongueT > 0) { s.tongueT += dt; const f = s.tongueT < 0.5 ? Math.abs(Math.sin(s.tongueT / 0.5 * Math.PI * 2)) : 0; s.tongue.scale.x = Math.max(0.001, f); if (s.tongueT > 0.5) { s.tongueT = 0; s.tongue.scale.x = 0.001; } }
      const vis = s.hidden < 0.98; s.body.visible = vis; s.head.visible = vis;
      // wake while swimming
      if (U.uDuck.value[s.slot]) { const w = s.wet > 0.5 && vis ? s.spd : 0; U.uDuck.value[s.slot].set(s.hd.x, s.hd.z, Math.cos(s.th) * w * 0.8, Math.sin(s.th) * w * 0.8); }
    }
  }
  function dispose() { for (const s of snakes) { for (const o of [s.body, s.head]) { scene.remove(o); o.geometry.dispose(); o.material.dispose(); } s.tongue.geometry.dispose(); } for (let k = 6; k < 9; k++) if (U.uDuck.value[k]) U.uDuck.value[k].set(0, 0, 0, 0); }
  return { update, dispose, list: () => snakes };
}
