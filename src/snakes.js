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
  const R = rng(4242), { H, zc0, mz, hwAt } = world;
  // the island snakes' home area: the island and its whole tail bar with the shallows round it
  const islandE = (x, z) => Math.min(world.islandE(x, z), world.bar ? 0.6 + 0.35 * world.bar.q(x, z) : 9);
  const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const obst = world.trunks.map((t) => [t[0], t[1], t[2]]).concat(world.rockList || []);

  // ---------- materials ----------
  const mkMat = (base, spots, L) => {
    const m = patch(new THREE.MeshPhongMaterial({ vertexColors: false, color: 0xffffff, shininess: 38, specular: new THREE.Color(0.16, 0.16, 0.15) }), 'snake' + spots, 0, { SAFE: '' });
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
        float belly = (1.0 - smoothstep(-0.9, -0.78, ca));
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
        // yellow "ears": a crescent on each side right behind the head (concave toward the head), black band behind it
        float sideM = 1.0 - smoothstep(0.72, 0.86, abs(ca));                 // flanks only, about ±55° from the horizontal
        float kk = clamp(1.0 - (ca / 0.82) * (ca / 0.82), 0.0, 1.0);
        float fr = 0.0015 + 0.003 * kk, bk = 0.0145 + 0.0015 * kk;              // front edge bulges back in the middle
        float neck = smoothstep(fr - 0.0008, fr + 0.0008, along) * (1.0 - smoothstep(bk - 0.0008, bk + 0.0008, along)) * sideM * (1.0 - belly);
        float blk = smoothstep(bk - 0.0008, bk + 0.0008, along) * (1.0 - smoothstep(bk + 0.0065, bk + 0.0085, along)) * (1.0 - smoothstep(0.78, 0.92, abs(ca))) * (1.0 - belly);
        col = mix(col, vec3(1.0, 0.8, 0.25), neck); col = mix(col, vec3(0.03, 0.03, 0.03), blk);
        diffuseColor.rgb = mix(col, vec3(0.04, 0.09, 0.085), clamp(-vWp.y * 3.0 + max(-vWp.y, 0.0) * 8.0, 0.0, 0.85));
      }`);
    };
    return m;
  };

  // ---------- head geometry (local: +x forward, origin at the back of the head) ----------
  function headGeo(base) {
    // 3.8 x 2.4 x 1.4 cm: egg-shaped from above (widest behind the eyes), rounded snout, flat crown, full cheeks
    const HL = 0.038, g = new THREE.SphereGeometry(1, 28, 18), P = g.attributes.position, v = new V(), cols = [];
    const wAt = (u) => 0.0105 * Math.pow(Math.max(0, 1 - Math.pow((u - 0.32) / (u > 0.32 ? 0.7 : 0.5), 2)), 0.6) + 0.0012;
    const hAt = (u) => 0.0068 * Math.pow(Math.max(0, 1 - Math.pow((u - 0.3) / (u > 0.3 ? 0.75 : 0.5), 2)), 0.45) + 0.0012;
    const dark = base.clone().multiplyScalar(0.8), plate = base.clone().multiplyScalar(0.9), lab = new THREE.Color(0.86, 0.84, 0.74), blk = base.clone().multiplyScalar(0.45);
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i);
      const u = (v.x + 1) / 2, w = wAt(u), h = hAt(u);
      let y = v.y * h; if (y > h * 0.45) y = h * 0.45 + (y - h * 0.45) * 0.45; // flat crown
      if (v.y < 0) y *= 0.85;
      const cheek = 1 + 0.08 * Math.exp(-Math.pow((u - 0.25) / 0.15, 2)) * (v.y < 0.3 ? 1 : 0);
      P.setXYZ(i, u * HL, y + 0.0005, v.z * w * cheek);
      // colours: dark plates with seams on the crown, white labials with black bars, pale chin
      let c = dark;
      const side = Math.abs(v.z), top = v.y;
      if (top > 0.55) { // crown plates: midline seam and transverse seams
        const seam = (Math.abs(v.z) < 0.06 && u > 0.25 && u < 0.62) || Math.abs(u - 0.62) < 0.02 || Math.abs(u - 0.8) < 0.015 || Math.abs(u - 0.25) < 0.02;
        c = seam ? blk : plate.clone().multiplyScalar(0.92 + 0.16 * Math.sin(u * 37 + v.z * 23));
      } else if (top < -0.05 && top > -0.6 && u > 0.12 && side > 0.25) c = Math.abs(Math.sin(u * 30)) < 0.2 ? blk : lab;
      else if (top <= -0.6) c = lab;
      cols.push(c.r, c.g, c.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3)); g.computeVertexNormals();
    const parts = [g];
    // eyes: large and round, dark iris with a pale ring, on the sides toward the snout, under a small brow plate
    const eu = 0.64, ew = wAt(eu), ey = hAt(eu) * 0.25;
    for (const sd of [-1, 1]) {
      const e = new THREE.SphereGeometry(0.0029, 12, 10).scale(1, 1, 0.45).translate(eu * HL, ey, sd * (ew - 0.0016));
      const n = e.attributes.position.count; e.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(0.015), 3)); parts.push(e);
      const ring = new THREE.TorusGeometry(0.0029, 0.00045, 5, 16).rotateX(Math.PI / 2).rotateX(sd * 0.35).translate(eu * HL, ey, sd * (ew - 0.0019));
      const nr = ring.attributes.position.count; ring.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: nr }, () => [0.62, 0.5, 0.25]).flat(), 3)); parts.push(ring);
      const brow = new THREE.SphereGeometry(0.003, 8, 6).scale(1.4, 0.4, 0.8).translate(eu * HL - 0.0005, ey + 0.0032, sd * (ew - 0.0026));
      const nb = brow.attributes.position.count; brow.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: nb }, () => [dark.r, dark.g, dark.b]).flat(), 3)); parts.push(brow);
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
  const islandPt = (emin, emax, hmax = 99) => { for (let t = 0; t < 400; t++) { const x = (R() * 2 - 1) * 28, z = zc0 + (R() * 2 - 1) * 20, e = islandE(x, z), h = H(x, z); if (e > emin && e < emax && h > 0.12 && h < hmax) return new V(x, 0, z); } return hmax < 99 ? islandPt(emin, emax) : new V(0, 0, zc0); };
  const islandWater = () => { for (let t = 0; t < 300; t++) { const x = (R() * 2 - 1) * 32, z = zc0 + (R() * 2 - 1) * 24, h = H(x, z); if (h < -0.25 && h > -1.6 && islandE(x, z) < 1.45) return new V(x, 0, z); } return new V(0, 0, zc0 + 16); };
  // the bank snake: a stretch of the mainland shore opposite the island
  const bx0 = (R() - 0.5) * 50, bs0 = R() < 0.5 ? -1 : 1; // (draws kept so the rest of the snakes' randomness is unchanged)
  const bankX = world.snakeBank ? world.snakeBank.x : bx0, bankSide = world.snakeBank ? world.snakeBank.side : bs0;
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
    const bank = k === 2, L = 1.0 + R() * 0.25, look = looks[k];
    const mat = mkMat(look.base, look.spots, L);
    // body tube
    const nV = NODES * (RAD + 1), pos = new Float32Array(nV * 3), nor = new Float32Array(nV * 3), aS = new Float32Array(nV * 2), idx = [];
    for (let i = 0; i < NODES - 1; i++) for (let j = 0; j < RAD; j++) { const a = i * (RAD + 1) + j, b = a + 1, c = a + RAD + 1, d = c + 1; idx.push(a, b, c, b, d, c); } // outward-facing (counter-clockwise seen from outside)
    for (let i = 0; i < NODES; i++) for (let j = 0; j <= RAD; j++) { const q = i * (RAD + 1) + j; aS[q * 2] = i / (NODES - 1) * L; aS[q * 2 + 1] = j / RAD; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); g.setAttribute('aS', new THREE.BufferAttribute(aS, 2));
    g.setAttribute('sway', new THREE.BufferAttribute(new Float32Array(nV), 1)); g.setIndex(idx);
    const body = new THREE.Mesh(g, mat); body.frustumCulled = false; body.castShadow = true; body.receiveShadow = true; scene.add(body);
    const hm = patch(new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 38, specular: new THREE.Color(0.16, 0.16, 0.15) }), 'snakeH', 0, { SAFE: '' });
    { const ob = hm.onBeforeCompile; hm.customProgramCacheKey = () => 'snakeH'; hm.onBeforeCompile = (sh) => { ob(sh); sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.04, 0.09, 0.085), clamp(-vWp.y * 3.0 + max(-vWp.y, 0.0) * 8.0, 0.0, 0.85));'); }; }
    const head = new THREE.Mesh(headGeo(look.base), hm); head.castShadow = true; scene.add(head);
    const tg = tongueGeo(); tg.setAttribute('sway', new THREE.Float32BufferAttribute(new Float32Array(tg.attributes.position.count), 1));
    const tongue = new THREE.Mesh(tg, patch(new THREE.MeshLambertMaterial({ color: 0x141012, side: THREE.DoubleSide }), 'tongue', 0, { SAFE: '' })); head.add(tongue);
    tongue.position.set(0.038, -0.0008, 0); tongue.scale.set(0.001, 1, 1);
    // initial trail: a gentle S on land
    const start = bank ? bankPt(false) : islandPt(0.2, 0.7), trail = [];
    const a0 = R() * 6.28;
    { // lay the body out as if it had crawled here: serpenoid from tail to head, stored head-first
      const lam = 0.42 * L, n = 220, ds0 = (L + 0.1) / n, pts = []; let x = 0, z = 0;
      for (let i = 0; i <= n; i++) { const ph = 2 * Math.PI * i * ds0 / lam, th = a0 + 1.4 * 0.85 * Math.sin(ph); pts.push([x, z]); x += Math.cos(th) * ds0; z += Math.sin(th) * ds0; }
      const [hx, hz] = pts[n];
      for (let i = n - 1; i >= 0; i--) trail.push(new V(start.x + pts[i][0] - hx, 0, start.z + pts[i][1] - hz));
      trail.wph0 = 2 * Math.PI * (L + 0.1) / lam;
    }
    snakes.push({
      bank, L, body, head, tongue, trail, axTrail: trail.filter((_, i) => i % 2 === 0).map((p) => p.clone()), hd: new V().copy(start), ax: new V().copy(start), th: a0, axTh: a0, wph0: trail.wph0, wph: 0, amp: 0.85, swimAmp: 0.25,
      spd: 0, state: 'crawl', goal: null, stateT: 0, tongueT: 0, nextTongue: 1 + R() * 3, lift: 0, flat: 0, hidden: 0, wet: 0, look: 0, curLook: 0, lookT: 0, splashed: false,
      rMax: 0.0118 + R() * 0.0012, lifts: new Float32Array(NODES), dep: new Float32Array(NODES), pose: null, poseI: 0, emi: 0, lastApex: undefined, slowT: 0, slowK: 1, turnK: 0, nextSlow: 10 + R() * 20, lurk: false, lurked: false, hdY: 0, dv: null, diveCD: 60 + R() * 120, sinceDive: 61, fleeDive: false,
    });
  }

  // ---------- behaviour ----------
  const Hg = world.Hmesh || H; // height of the visible terrain mesh (triangles), not the analytic field
  const islandWaterFar = () => { // open water within the zone, not deeper than 1.5 m: best of a few candidates (farther out)
    let best = null, be = -1;
    for (let t = 0; t < 200 && (!best || t < 40); t++) { const x = (R() * 2 - 1) * 34, z = zc0 + (R() * 2 - 1) * 26, h = Hg(x, z), e = islandE(x, z); if (h < -0.3 && h > -1.5 && e < 1.4 && e > be) { be = e; best = new V(x, 0, z); } }
    return best || islandWater();
  };
  const awayOk = (s, g) => { if (!(s.avoidT > 0) || !s.avoidP) return true; const ax = s.hd.x - s.avoidP.x, az = s.hd.z - s.avoidP.z, gx = g.x - s.hd.x, gz = g.z - s.hd.z; return (ax * gx + az * gz) / (Math.hypot(ax, az) * Math.hypot(gx, gz) + 1e-6) > -0.17; };
  const pickGoal = (s, env) => {
    s.goalT = 0; s.gD = undefined;
    const sunny = env.sunInt * (1 - (env.cover || 0)) > 0.35 && env.day > 0.5;
    for (let tries = 0; tries < 12; tries++) {
      const r = R(), wet = s.wet > 0.5;
      if (sunny && !wet && r < 0.3) { s.state = 'toBask'; s.goal = s.bank ? bankPt(false) : islandPt(0.78, 1.0, 0.42); }
      else if (wet ? r < 0.7 : r < 0.6) { s.state = 'crawl'; s.goal = s.bank ? bankPt(true) : (R() < 0.6 ? islandWaterFar() : islandWater()); } // water: about half the time, often several goals in a row
      else { s.state = 'crawl'; s.goal = s.bank ? bankPt(false) : (R() < 0.85 ? islandPt(0.65, 1.0) : islandPt(0.15, 0.65)); }
      if (awayOk(s, s.goal)) return;
    }
  };
  const tmp = new V(), side = new V(), upv = new V(), T = new V(), UP = new V(0, 1, 0);
  const Pl = [], Pw = [], Pn = [], Tn = [];
  for (let i = 0; i < NODES; i++) { Pl.push(new V()); Pw.push(new V()); Pn.push(new V()); Tn.push(new V()); }
  const radius = (s, u) => { // u: 0 snout .. 1 tail tip
    const neck = 0.6 + 0.4 * sm(0.0, 0.12, u), tail = 1 - sm(0.68, 1.0, u) * 0.9;
    return s.rMax * neck * tail * (1 + 0.05 * Math.sin(u * 40));
  };
  // basking poses, drawn tail -> head as turtle segments [length (fraction of L), turn (rad, + = left)]
  const POSES = {
    // A: flat cluster of loops in one layer: big outer arc, U-folds inward, small neck loop, head in the middle
    flat: [[0.06, 0], [0.58, 4.5], [0.13, 3.14], [0.14, -3.0], [0.09, 3.3], [0.04, 0.8]],
    // B: loose ring with the front third climbing over it, head resting on top
    ring: [[0.03, 0], [0.7, 5.6], [0.14, 1.5], [0.13, -2.6]],
  };
  const posePath = (s, kind) => {
    const segs = POSES[kind], mir = R() < 0.5 ? -1 : 1, pts = [];
    let x = s.hd.x, z = s.hd.z, th = s.th, total = 0;
    for (const [lf, turn0] of segs) {
      const len = lf * s.L * (0.96 + R() * 0.08), turn = turn0 * mir * (0.95 + R() * 0.1), n = Math.max(2, Math.ceil(len / 0.006));
      for (let i = 0; i < n; i++) { th += turn / n; x += Math.cos(th) * len / n; z += Math.sin(th) * len / n; pts.push([x, z]); }
      total += len;
    }
    return pts;
  };
  // arr[0] is a live point that follows the head; once it is minD away from the last fixed point (arr[1]) it gets
  // fixed and a new live point starts. Comparing with arr[0] instead would never fix points at high frame rates.
  const pushTrail = (arr, x, z, minD, max, y = 0) => {
    const l = arr[0], f = arr[1];
    if (!l) { arr.unshift(new V(x, y, z)); return; }
    l.x = x; l.z = z; l.y = y;
    if (!f || Math.hypot(x - f.x, z - f.z) > minD) { arr.unshift(new V(x, y, z)); if (arr.length > max) arr.length = max; }
  };
  // sample a polyline (starting at p0, then arr[0..]) by arclength into out[]
  const sampleTrail = (p0x, p0z, arr, ds, out, p0y = 0) => {
    let ti = -1, acc = 0, ax = p0x, az = p0z, ay = p0y;
    out[0].set(p0x, p0y, p0z);
    for (let i = 1; i < out.length; i++) {
      const need = i * ds;
      for (;;) {
        const b = arr[ti + 1]; if (!b) { const pv = out[i - 1], pp = out[Math.max(0, i - 2)]; out[i].set(pv.x + (pv.x - pp.x), pv.y, pv.z + (pv.z - pp.z)); break; }
        const seg = Math.hypot(b.x - ax, b.y - ay, b.z - az);
        if (acc + seg >= need && seg > 1e-7) { const f = (need - acc) / seg; out[i].set(ax + (b.x - ax) * f, ay + (b.y - ay) * f, az + (b.z - az) * f); break; }
        acc += seg; ax = b.x; az = b.z; ay = b.y; ti++;
      }
    }
  };
  // swimming body: axis trail + travelling wave whose amplitude grows toward the tail; arclength kept = L
  const swimBody = (s, out) => {
    const k = 2 * Math.PI / (0.6 * s.L), ds = s.L / (NODES - 1);
    let ti = -1, ax = s.ax.x, az = s.ax.z, x = 0, arc = 0, i = 1, px = 0, pz = 0, first = true;
    const pt = (bx, bz, dx, dz, xx) => { const a = (0.006 + 0.07 * s.L * Math.min(1, xx / (0.8 * s.L))) * s.swimAmp; const y = a * Math.sin(k * xx - s.wph); return [bx - dz * y, bz + dx * y]; };
    let dirx = Math.cos(s.axTh + Math.PI), dirz = Math.sin(s.axTh + Math.PI);
    { const [hx, hz] = pt(ax, az, -dirx, -dirz, 0); out[0].set(hx, 0, hz); px = hx; pz = hz; }
    while (i < NODES) {
      const b = s.axTrail[ti + 1];
      let bx, bz;
      if (b) { bx = b.x; bz = b.z; } else { bx = ax + dirx * 0.05; bz = az + dirz * 0.05; }
      const seg = Math.hypot(bx - ax, bz - az);
      if (seg < 1e-6) { ti++; ax = bx; az = bz; if (!b && first) break; continue; }
      dirx = (bx - ax) / seg; dirz = (bz - az) / seg;
      const steps = Math.max(1, Math.ceil(seg / 0.004));
      for (let q = 1; q <= steps && i < NODES; q++) {
        const f = q / steps, cx = ax + (bx - ax) * f, cz = az + (bz - az) * f, xx = x + seg * f;
        const [qx, qz] = pt(cx, cz, -dirx, -dirz, xx);
        arc += Math.hypot(qx - px, qz - pz); px = qx; pz = qz;
        while (i < NODES && arc >= i * ds) { out[i].set(qx, 0, qz); i++; }
      }
      x += seg; ax = bx; az = bz; ti++; first = false;
      if (!b && ti > s.axTrail.length + 400) break;
    }
    for (; i < NODES; i++) out[i].copy(out[i - 1]);
  };
  const snkU = U.uSnk.value, snkB = U.uSnB.value;
  // ---- night shelters: tree roots, big stones, driftwood, dense reeds at the water's edge ----
  const shelters = [];
  for (const t of world.trunks) { const [x, z, r, kind] = t, h = Hg(x, z); if (h < -0.02) continue; shelters.push({ x, z, R: Math.min(0.9, r + (kind ? 0.3 : 0.25)), kind: kind ? 'roots' : 'stone' }); }
  for (const [x, z, r] of (world.rockList || [])) { if (r < 0.25 || r > 1.6 || Hg(x, z) < -0.02) continue; if (shelters.some((q) => Math.hypot(q.x - x, q.z - z) < 0.6)) continue; shelters.push({ x, z, R: Math.min(0.9, r * 0.85 + 0.15), kind: 'stone' }); }
  for (let i = 0; i < world.reedPts.length; i += 3) { const p = world.reedPts[i], h = Hg(p.x, p.z); if (h < -0.08 || h > 0.3) continue; shelters.push({ x: p.x, z: p.z, R: 0.45, kind: 'reeds' }); }
  const inZone = (s, x, z) => s.bank ? Math.abs(x - bankX) < 22 && (z - mz(x)) * bankSide > hwAt(x) - 3 && Hg(x, z) > -0.1 : islandE(x, z) < 1.4;
  function pickShelter(s) {
    const used = snakes.filter((o) => o !== s && o.shel).map((o) => o.shel);
    const c = shelters.filter((q) => inZone(s, q.x, q.z) && !used.includes(q)).map((q) => [q, Math.hypot(q.x - s.hd.x, q.z - s.hd.z)]).sort((a, b) => a[1] - b[1]).slice(0, 3);
    if (!c.length) { const g = s.bank ? bankPt(false) : islandPt(0.4, 0.85); return { x: g.x, z: g.z, R: 0.4, kind: 'ground' }; }
    return c[Math.floor(R() * c.length)][0];
  }
  // a path the head follows exactly: in to the middle of the shelter, then coiled up tightly underneath it
  function enterPath(s, q) {
    const pts = [], dx = q.x - s.hd.x, dz = q.z - s.hd.z, d = Math.hypot(dx, dz) || 1;
    // crawling in with the usual S-bends, flattening out as the head slips under
    const lam = 0.42 * s.L, nx = -dz / d, nz = dx / d;
    for (let u = 0.06; u <= d; u += 0.06) { const w = 0.1 * Math.sin(2 * Math.PI * u / lam) * Math.min(1, (d - u) / 0.5); pts.push([s.hd.x + dx / d * u + nx * w, s.hd.z + dz / d * u + nz * w]); }
    let a = Math.atan2(dz, dx) - Math.PI / 2, len = 0; const rad = Math.min(0.2, q.R * 0.45);
    while (len < s.L + 0.4) { const rr = rad * (0.6 + 0.4 * Math.max(0, 1 - len / (s.L + 0.4))); a += 0.08 / rr; pts.push([q.x + Math.cos(a) * rr, q.z + Math.sin(a) * rr]); len += 0.08; }
    return pts;
  }
  // out again: from inside straight out across the edge and on for a body length
  function emergePath(s, q) {
    const pts = []; let a = R() * 6.28;
    for (let t = 0; t < 12; t++) { const ex = q.x + Math.cos(a) * (q.R + s.L + 0.5), ez = q.z + Math.sin(a) * (q.R + s.L + 0.5); if (Hg(ex, ez) > -0.05 && inZone(s, ex, ez)) break; a = R() * 6.28; }
    const lam = 0.42 * s.L, nx = -Math.sin(a), nz = Math.cos(a);
    for (let u = 0.06; u <= q.R + s.L + 0.5; u += 0.06) { const w = 0.1 * Math.sin(2 * Math.PI * u / lam) * Math.min(1, u / 0.5); pts.push([q.x + Math.cos(a) * u + nx * w, q.z + Math.sin(a) * u + nz * w]); }
    return pts;
  }
  const startLurk = (s) => { s.state = 'pose'; s.lurk = true; s.slowT = 0; s.poseKind = R() < 0.65 ? 'flat' : 'ring'; s.pose = posePath(s, s.poseKind); s.poseI = 0; };

  function update(dt, t, env) {
    dt = Math.min(dt, 0.1);
    const night = env.night > 0.55, wetW = (env.rain || 0) > 0.25, cam = env.cam;
    for (let k = 0; k < snakes.length; k++) {
      const s = snakes[k];
      const wantHide = night || wetW;
      const inOut = s.state === 'pose' && (s.enter || s.emerge);
      if (wantHide && s.state !== 'hide' && s.state !== 'hidden' && !inOut) {
        s.state = 'hide'; s.pose = null; s.dv = null; s.hdY = 0; s.shel = pickShelter(s); s.hideT = 0;
        const dx = s.hd.x - s.shel.x, dz = s.hd.z - s.shel.z, d = Math.hypot(dx, dz) || 1;
        s.goal = new V(s.shel.x + dx / d * (s.shel.R + 0.15), 0, s.shel.z + dz / d * (s.shel.R + 0.15));
      }
      if (s.state === 'hide') {
        s.hideT += dt; const toS = Math.hypot(s.goal.x - s.hd.x, s.goal.z - s.hd.z);
        if (!wantHide) { s.state = 'crawl'; s.shel = null; pickGoal(s, env); }
        else if (toS < 0.35 || (toS < 0.9 && s.hideT > 25) || (toS < 3 && s.hideT > 60) || s.hideT > 120) { s.state = 'pose'; s.enter = true; s.lurk = false; s.pose = enterPath(s, s.shel); s.poseI = 0; }
      }
      if (!wantHide && s.state === 'hidden') { s.hidden = 0; s.state = 'pose'; s.emerge = true; s.pose = emergePath(s, s.shel); s.poseI = 0; s.trail.length = 0; s.axTrail.length = 0; }
      // flee from the player
      const dp = cam ? Math.hypot(cam.x - s.hd.x, cam.z - s.hd.z) : 99;
      if (!s.noFlee && dp < 2.0 && cam && !inOut && (s.state === 'bask' || s.state === 'crawl' || s.state === 'toBask' || s.state === 'pose') && cam.y - H(cam.x, cam.z) < 4) {
        s.state = 'flee'; s.stateT = 15; s.pose = null; s.fleeDive = R() < 0.35; s.slowT = 0;
        s.avoidP = new V(cam.x, 0, cam.z); s.avoidT = 20;
        // refuge: water, reeds or grass 2-8 m away, in a direction at least ~100 deg away from the player, inside the zone
        const ax = s.hd.x - cam.x, az = s.hd.z - cam.z, al = Math.hypot(ax, az) || 1; let best = null, bs = -1e9;
        for (let c = 0; c < 40; c++) {
          const a = Math.atan2(az, ax) + (R() - 0.5) * 2 * 1.4, d = 2.5 + R() * 5.5, x = s.hd.x + Math.cos(a) * d, z = s.hd.z + Math.sin(a) * d, h = Hg(x, z);
          if (h < -1.5 || (s.bank ? Math.abs(x - bankX) > 24 : islandE(x, z) > 1.4)) continue;
          const dot = (Math.cos(a) * ax + Math.sin(a) * az) / al; if (dot < -0.17) continue;
          const sc = dot * 2 + (h < -0.2 ? 1.5 : 0) - Math.abs(d - 5) * 0.2; if (sc > bs) { bs = sc; best = new V(x, 0, z); }
        }
        s.goal = best || s.hd.clone().add(new V(ax / al * 3, 0, az / al * 3));
      }
      const inWater = Hg(s.hd.x, s.hd.z) < -0.05;
      if (dp > 7) s.lurked = false;
      if (!s.noFlee && cam && !inOut && !s.lurked && dp > 2.5 && dp < 4 && !inWater && (s.state === 'crawl' || s.state === 'toBask') && cam.y - H(cam.x, cam.z) < 4) { s.lurked = true; if (R() < 0.5) startLurk(s); }
      if (inWater && !s.splashed) { env.ripple(s.hd.x, s.hd.z, 0.1); s.splashed = true; }
      if (!inWater) s.splashed = false;
      s.wet += ((inWater ? 1 : 0) - s.wet) * Math.min(1, dt * 0.8);
      // speed per state
      let want = 0;
      if (s.state === 'bask') { s.stateT -= dt; if (s.stateT <= 0) { pickGoal(s, env); } }
      else if (s.state === 'hidden') want = 0;
      else if (s.state === 'pose') want = s.enter || s.emerge ? 0.13 : 0.1;
      else {
        const toG = s.goal ? Math.hypot(s.goal.x - s.hd.x, s.goal.z - s.hd.z) : 0;
        want = s.state === 'flee' ? (inWater ? 0.69 : 0.56) : inWater ? 0.26 + 0.05 * Math.sin(t * 0.3 + k) : 0.18 + 0.05 * Math.sin(t * 0.3 + k);
        if (s.state === 'flee') {
          s.stateT -= dt;
          const far = !cam || Math.hypot(cam.x - s.hd.x, cam.z - s.hd.z) > 6, at = s.goal && Math.hypot(s.goal.x - s.hd.x, s.goal.z - s.hd.z) < 0.4;
          if (s.stateT <= 0 || (far && at)) pickGoal(s, env);
          else if (at && !far) { s.state = 'crawl'; s.avoidP = new V(cam.x, 0, cam.z); s.avoidT = 20; pickGoal(s, env); s.state = s.state === 'toBask' ? 'crawl' : s.state; s.fleeAgain = true; }
        }
        if (s.avoidT > 0) s.avoidT -= dt;
        if (s.state === 'toBask' && toG < 0.4 && !inWater) { s.state = 'pose'; s.poseKind = s.forcePose || (R() < 0.65 ? 'flat' : 'ring'); s.pose = posePath(s, s.poseKind); s.poseI = 0; }
        else if ((s.state === 'crawl' || s.state === 'hide') && toG < 0.35) { if (s.state === 'hide') s.state = 'hidden'; else pickGoal(s, env); }
        if (!s.goal) pickGoal(s, env);
        // a goal that cannot be reached (rocks, deep water) is dropped after a while
        if ((s.state === 'crawl' || s.state === 'toBask') && s.goal) { // drop a goal only when no progress is made toward it
          s.goalT = (s.goalT || 0) + dt;
          if (s.goalT > 12) { const gd = Math.hypot(s.goal.x - s.hd.x, s.goal.z - s.hd.z); if (s.gD !== undefined && s.gD - gd < 0.5) pickGoal(s, env); else { s.goalT = 0; s.gD = gd; } }
        } else s.goalT = 0;
      }
      // ---- diving: down at ~30°, swim or lie on the bottom, come back up ----
      const depthHere = -Hg(s.hd.x, s.hd.z);
      s.diveCD -= dt; s.sinceDive += dt;
      if (!s.dv && inWater && s.wet > 0.8 && !wantHide && depthHere > 0.45 && (s.state === 'crawl' || s.state === 'flee')) {
        if (s.sinceDive > 60 && ((s.state === 'flee' && s.fleeDive) || s.diveCD <= 0)) {
          s.fleeDive = false;
          const maxD = Math.min(0.5, depthHere - 0.05);
          const bottom = depthHere < 0.75 && R() < 0.55;
          s.dv = { ph: 'down', target: bottom ? -(depthHere - 0.04) : -maxD, t: 0, bottom };
          env.ripple(s.hd.x, s.hd.z, 0.12); s.diveCD = 120 + R() * 120; s.sinceDive = 0;
        } else if (s.diveCD <= 0) s.diveCD = 5;
      }
      if (s.dv) {
        const dv = s.dv, floorY = -Math.max(0, depthHere - 0.04); // head stays above the bottom
        dv.t += dt;
        if (wantHide || !inWater) dv.ph = 'up';
        const stepH = s.spd * dt * 0.55; // depth changes only together with forward travel (≤ ~30°)
        if (dv.ph === 'down') { s.hdY = Math.max(dv.target, floorY, s.hdY - stepH); if (s.hdY <= Math.max(dv.target, floorY) + 0.005) { dv.ph = dv.bottom ? 'bottom' : 'under'; dv.t = 0; dv.dur = dv.bottom ? 5 + R() * 5 : 3 + R() * 6; } }
        else if (dv.ph === 'bottom' || dv.ph === 'under') { s.hdY = Math.max(s.hdY, floorY); if (dv.t > dv.dur && (dv.ph === 'under' || true)) { dv.ph = 'up'; } }
        else if (dv.ph === 'up') { s.hdY = Math.min(0, s.hdY + stepH); if (s.hdY >= 0) { s.hdY = 0; s.dv = null; env.ripple(s.hd.x, s.hd.z, 0.1); } }
        if (s.dv) { if (s.dv.ph === 'bottom') want = 0; else if (s.dv.ph === 'under') want *= 0.8; else want = Math.max(0.18, want * 0.85); }
      }
      // slow phases instead of stopping: speed eases down to ~4 % (still writhing, carried by the current), then back up
      s.nextSlow -= dt;
      if (s.state === 'crawl' && !s.dv && s.slowT <= 0 && s.nextSlow <= 0) {
        if (!inWater && R() < 0.2) startLurk(s); // sometimes hides on land instead: coils up to be less visible
        else s.slowT = inWater ? 4 + R() * 4 : 4 + R() * 6;
        s.nextSlow = inWater ? 15 + R() * 10 : 20 + R() * 25;
      }
      if (s.slowT > 0) { s.slowT -= dt; if (s.state !== 'crawl') s.slowT = 0; }
      s.slowK += ((s.slowT > 0 ? 0.04 : 1) - s.slowK) * Math.min(1, dt * 0.9);
      if (s.state === 'crawl' && !s.dv) want *= s.slowK;
      if (s.state !== 'pose') { const th = 1.4 * s.amp * (s.state === 'flee' ? 0.85 : 1), J = 1 - th * th / 4 + Math.pow(th, 4) / 64; s.Jc = Math.max(0.45, J); want /= s.Jc; }
      s.spd += (want - s.spd) * Math.min(1, dt * (s.state === 'flee' ? 7 : 2.5));
      s.flat += ((s.state === 'bask' ? 1 : 0) - s.flat) * Math.min(1, dt * 0.4);
      // ---- head motion ----
      const step = s.spd * dt;
      if (step > 1e-5) {
        if (s.state === 'pose' && s.pose) {
          // follow the pose path exactly: the body lays itself into the shape
          let rem = step;
          while (rem > 0 && s.poseI < s.pose.length) {
            const [px, pz] = s.pose[s.poseI], d = Math.hypot(px - s.hd.x, pz - s.hd.z);
            if (d <= rem) { s.hd.x = px; s.hd.z = pz; rem -= d; s.poseI++; } else { s.hd.x += (px - s.hd.x) / d * rem; s.hd.z += (pz - s.hd.z) / d * rem; rem = 0; }
          }
          const tr = s.trail[0]; if (tr) s.th = Math.atan2(s.hd.z - tr.z, s.hd.x - tr.x);
          if (s.poseI >= s.pose.length) {
            if (s.enter) { s.enter = false; s.state = 'hidden'; s.hidden = 1; s.spd = 0; }
            else if (s.emerge) { s.emerge = false; s.shel = null; s.state = 'crawl'; s.goal = null; pickGoal(s, env); } // (sunny: pickGoal often sends it to bask nearby)
            else { s.state = 'bask'; s.stateT = s.lurk ? 10 + R() * 30 : 35 + R() * 60; s.lurk = false; s.spd = 0; }
          }
          s.ax.set(s.hd.x, 0, s.hd.z); s.axTh = s.th; s.amp = 0.7;
        } else {
          // steer the axis toward the goal, around trunks and rocks
          let dTh = 0;
          if (s.goal) dTh = Math.atan2(Math.sin(Math.atan2(s.goal.z - s.ax.z, s.goal.x - s.ax.x) - s.axTh), Math.cos(Math.atan2(s.goal.z - s.ax.z, s.goal.x - s.ax.x) - s.axTh));
          for (const [ox, oz, orr] of obst) {
            if (s.shel && s.state === 'hide' && Math.hypot(ox - s.shel.x, oz - s.shel.z) < 0.8) continue; // its own shelter: go to it
            const dx = ox - s.hd.x, dz = oz - s.hd.z, dd = Math.hypot(dx, dz);
            if (dd < orr + 0.6) { const fa = Math.atan2(dz, dx), rel = Math.atan2(Math.sin(fa - s.axTh), Math.cos(fa - s.axTh)); if (Math.abs(rel) < 1.4) dTh += (rel > 0 ? -1 : 1) * 1.6 * (1 - (dd - orr) / 0.6); }
          }
          { const lx = s.ax.x + Math.cos(s.axTh) * 1.1, lz = s.ax.z + Math.sin(s.axTh) * 1.1;
            if (Hg(lx, lz) < -1.6 || (s.bank ? Math.abs(lx - bankX) > 25 : islandE(lx, lz) > 1.45)) dTh += 1.2; }
          // wide turns only: the axis turns on a radius of at least ~half the body length, so a U-turn is a broad arc
          const Rt = s.state === 'flee' ? 0.12 : Math.max(0.5, 0.55 * s.L), maxTurn = step * (s.Jc || 1) / Rt; // radius measured along the forward progress
          const dA = Math.max(-maxTurn, Math.min(maxTurn, dTh * dt * (s.state === 'flee' ? 30 : 1.5)));
          s.axTh += dA;
          s.turnK += (Math.min(1, Math.abs(dA) / Math.max(1e-6, maxTurn)) * Math.sign(dA) - s.turnK) * Math.min(1, dt * 2);
          // land: serpenoid path — the heading swings ±~70° sinusoidally with the distance crawled, giving round U-loops
          // with straight flanks (wave length along the body ~0.42 L); in the water the head goes almost straight
          // loops get smaller while turning, more on the inner side of the turn
          const fleeTurn = s.state === 'flee' && s.goal ? Math.abs(Math.atan2(Math.sin(Math.atan2(s.goal.z - s.hd.z, s.goal.x - s.hd.x) - s.axTh), Math.cos(Math.atan2(s.goal.z - s.hd.z, s.goal.x - s.hd.x) - s.axTh))) : 0;
          const tk = Math.abs(s.turnK), thMax = 1.4 * s.amp * (s.state === 'flee' ? 0.85 * (1 - 0.55 * sm(0.5, 1.5, fleeTurn)) : 1) * (1 - 0.1 * tk), lam = 0.42 * s.L * (s.state === 'flee' ? 0.85 : 1);
          const wph = s.wph0 + 2 * Math.PI * step / lam, sw = Math.sin(wph);
          let hth = s.axTh + thMax * sw * (sw * s.turnK > 0 ? 1 - 0.12 * tk : 1);
          // never crawl over or through its own body: if the next head point comes close to the body, swing away
          const clear = (a) => { const x = s.hd.x + Math.cos(a) * 0.05, z = s.hd.z + Math.sin(a) * 0.05; let m = 9; for (let q = 30; q < s.trail.length; q += 3) { const p = s.trail[q], d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z); if (d < m) m = d; } return Math.sqrt(m); };
          const minC = 4.2 * s.rMax;
          if (clear(hth) < minC) { let best = hth, bc = -1; for (const o of [0.35, -0.35, 0.7, -0.7, 1.1, -1.1]) { const c = clear(hth + o); if (c > bc) { bc = c; best = hth + o; } if (c >= minC) break; } s.axTh += (best - hth) * 0.3; hth = best; }
          const nx = s.hd.x + Math.cos(hth) * step, nz = s.hd.z + Math.sin(hth) * step;
          // soft limit: near the edge of its area (or too deep) the snake keeps moving while turning back on a wide arc;
          // only at the hard limit does it stop advancing (rare, the look-ahead turns it well before)
          const soft = Hg(nx, nz) < -1.7 || (s.bank ? Math.abs(nx - bankX) > 26 : islandE(nx, nz) > 1.5);
          const hard = Hg(nx, nz) < -2.3 || (s.bank ? Math.abs(nx - bankX) > 29 : islandE(nx, nz) > 1.62);
          if (soft) { // turn toward home (not a fixed side), so it never cancels the steering toward the goal
            const hx = s.bank ? bankX : 0, hz = s.bank ? mz(bankX) + bankSide * hwAt(bankX) : zc0, hdir = Math.atan2(hz - s.hd.z, hx - s.hd.x);
            const dd = Math.atan2(Math.sin(hdir - s.axTh), Math.cos(hdir - s.axTh)); s.axTh += Math.sign(dd) * Math.min(Math.abs(dd), 2 * step / Math.max(0.5, 0.55 * s.L)); if (!s.backGoal) { s.goal = s.bank ? bankPt(false) : islandPt(0.2, 0.8); s.backGoal = true; } if (s.state === 'flee') s.state = 'crawl'; } else s.backGoal = false;
          const bad = (x, z) => Math.max(0, -Hg(x, z) - 2.3) + Math.max(0, (s.bank ? (Math.abs(x - bankX) - 29) / 20 : islandE(x, z) - 1.62));
          if (!hard || bad(s.hd.x, s.hd.z) > 0) { /* already outside: keep swimming, the axis turns toward home */ s.hd.x = nx; s.hd.z = nz; s.th = hth; s.wph0 = wph; } else s.wph0 = wph; // blocked: let the swing move on so a better direction comes up // the wave phase only advances when the head really moves
          // axis follows the mean line of the head path
          const J = 1 - thMax * thMax / 4 + Math.pow(thMax, 4) / 64; // mean forward fraction of a serpenoid
          s.ax.x += Math.cos(s.axTh) * step * J; s.ax.z += Math.sin(s.axTh) * step * J;
          const kk = Math.min(1, dt * 0.8); s.ax.x += (s.hd.x - s.ax.x) * kk; s.ax.z += (s.hd.z - s.ax.z) * kk;
          s.amp = Math.min(1, Math.max(0.65, s.amp) + step / (0.3 * s.L));
        }
        pushTrail(s.trail, s.hd.x, s.hd.z, 0.006, 500, s.hdY);
        pushTrail(s.axTrail, s.ax.x, s.ax.z, 0.01, 260);
        // swimming wave travels backward ~1.6x faster than the snake moves forward
        s.wph += (2 * Math.PI / (0.6 * s.L)) * step * 1.6 + dt * 1.5 * s.wet;
      }
      s.swimAmp += ((s.wet > 0.4 && s.spd > 0.03 ? 1 : 0.25) - s.swimAmp) * Math.min(1, dt * 1.5);
      // ---- drift with the current when floating still: the whole body moves, slowly turning head-upstream ----
      if (inWater && !(s.dv && s.dv.ph === 'bottom')) {
        const sl = (mz(s.hd.x + 1) - mz(s.hd.x - 1)) / 2, fl = Math.hypot(1, sl);
        // fade the current near the limits: water deeper than 1.5 m and the edge of the home area (last ~2.5 m)
        const fdx = 1 / fl * 2.5, fdz = sl / fl * 2.5, ax2 = s.hd.x + fdx, az2 = s.hd.z + fdz;
        const edge = s.bank ? sm(25, 22.5, Math.abs(ax2 - bankX)) : sm(1.45, 1.32, islandE(ax2, az2));
        const deepF = sm(1.5, 1.2, -Hg(ax2, az2));
        const cv = (0.025 + 0.1 * sm(0.3, 1.2, depthHere)) * (s.dv ? 0.4 : 1) * sm(0.2, 0.8, s.wet) * edge * deepF;
        // drifting close to an edge ends the slow phase: the snake swims back
        if (s.slowT > 0 && (edge < 0.5 || deepF < 0.5)) { s.slowT = 0; s.goal = s.bank ? bankPt(true) : islandWater(); s.goalT = 0; }
        const fx = 1 / fl * cv * dt, fz = sl / fl * cv * dt;
        const nxh = s.hd.x + fx, nzh = s.hd.z + fz;
        if (cv > 1e-4 && Hg(nxh, nzh) < -0.15 && Hg(nxh, nzh) > -1.5 && (s.bank ? Math.abs(nxh - bankX) < 25 : islandE(nxh, nzh) < 1.45)) {
          // while drifting slowly the snake turns head-upstream around the middle of its body
          const up = Math.atan2(-sl, -1), d = Math.atan2(Math.sin(up - s.axTh), Math.cos(up - s.axTh)), rot = Math.max(-0.08, Math.min(0.08, d)) * dt * (1 - s.slowK);
          const mid = s.trail[Math.min(s.trail.length - 1, 60)] || s.hd, cx = mid.x, cz = mid.z, c = Math.cos(rot), sn = Math.sin(rot);
          const mv = (p) => { const x = p.x - cx, z = p.z - cz; p.x = cx + x * c - z * sn + fx; p.z = cz + x * sn + z * c + fz; };
          mv(s.hd); mv(s.ax); for (const p of s.trail) mv(p); for (const p of s.axTrail) mv(p);
          s.axTh += rot; s.th += rot;
        }
      }
      // ---- body ----
      const ds = s.L / (NODES - 1);
      sampleTrail(s.hd.x, s.hd.z, s.trail, ds, Pn, s.hdY);
      for (let i = 0; i < NODES; i++) s.dep[i] = Pn[i].y;
      // heights: on the visible ground, floating at the surface in water; head + neck raised
      const alert = s.state === 'bask' ? 0.3 + 0.5 * Math.max(0, Math.sin(t * 0.13 + k * 1.7)) : s.state === 'flee' ? 0.6 : 0.25;
      s.lift += ((s.wet > 0.5 ? 0.45 : alert) - s.lift) * Math.min(1, dt * 2);
      const sinkH = 0, fl = 1 - 0.25 * s.flat;
      for (let i = 0; i < NODES; i++) {
        const u = i / (NODES - 1), r = radius(s, u) * fl;
        const g = Hg(Pn[i].x, Pn[i].z);
        const dp = s.dep[i]; // <0: under water (dive)
        let y = Math.max(g + r * 0.95 + 0.002, r * 0.75 + 0.002 + dp);
        const hl = Math.max(0, 1 - i / 7); y += hl * hl * (0.006 + 0.02 * s.lift) * sm(-0.06, -0.005, dp);
        Pn[i].y = y - sinkH;
      }
      // where the body crosses itself, the part nearer the head lies on top
      const lifts = s.lifts;
      lifts.fill(0);
      for (let i = 0; i < NODES; i++) for (let j = i + 8; j < NODES; j++) {
        const d = Math.hypot(Pn[i].x - Pn[j].x, Pn[i].z - Pn[j].z), rr = (radius(s, i / (NODES - 1)) + radius(s, j / (NODES - 1))) * fl;
        if (d < rr * 1.02) lifts[i] = Math.max(lifts[i], (Pn[j].y - Pn[i].y) + Math.sqrt(Math.max(0, rr * rr - d * d)) * 1.05);
      }
      for (let i = 0; i < NODES; i++) { let a = 0, w = 0; for (let k2 = -4; k2 <= 4; k2++) { const q = i + k2; if (q < 0 || q >= NODES) continue; const ww = 5 - Math.abs(k2); a = Math.max(a, lifts[q] * ww / 5); w += ww; } Pn[i].y += a; }
      // smooth heights along the body
      for (let pass = 0; pass < 2; pass++) { let prev = Pn[0].y; for (let i = 1; i < NODES - 1; i++) { const cur = Pn[i].y; Pn[i].y = Math.max(cur, (prev + 2 * cur + Pn[i + 1].y) / 4); prev = cur; } }
      // under the shelter: the parts of the body inside its outline go down out of sight
      if (s.shel && (s.state === 'hidden' || s.enter || s.emerge || s.state === 'hide')) {
        const q = s.shel;
        for (let i = 0; i < NODES; i++) { const d = Math.hypot(Pn[i].x - q.x, Pn[i].z - q.z), f = sm(q.R, q.R - 0.22, d); if (f > 0) Pn[i].y -= f * 0.35; }
      }
      // tube vertices
      const P = s.body.geometry.attributes.position.array, Nr = s.body.geometry.attributes.normal.array;
      const breathe = 1 + 0.03 * Math.sin(t * 1.3 + k) * s.flat;
      for (let i = 0; i < NODES; i++) {
        const a = Pn[Math.max(0, i - 1)], b = Pn[Math.min(NODES - 1, i + 1)];
        T.subVectors(a, b).normalize(); Tn[i].copy(T);
        side.crossVectors(UP, T).normalize(); upv.crossVectors(T, side).normalize();
        const u = i / (NODES - 1), r = radius(s, u), rw = r * (1.08 + 0.2 * s.flat), rh = r * (0.9 - 0.22 * s.flat) * (u > 0.2 && u < 0.6 ? breathe : 1);
        for (let j = 0; j <= RAD; j++) {
          const ang = j / RAD * Math.PI * 2, ca = Math.cos(ang), sa = Math.sin(ang);
          const yy = ca < 0 ? ca * 0.82 : ca;
          const q = (i * (RAD + 1) + j) * 3;
          P[q] = Pn[i].x + upv.x * yy * rh + side.x * sa * rw; P[q + 1] = Pn[i].y + upv.y * yy * rh + side.y * sa * rw; P[q + 2] = Pn[i].z + upv.z * yy * rh + side.z * sa * rw;
          const nx = upv.x * yy / rh + side.x * sa / rw, ny = upv.y * yy / rh + side.y * sa / rw, nz = upv.z * yy / rh + side.z * sa / rw, nl = Math.hypot(nx, ny, nz) || 1;
          Nr[q] = nx / nl; Nr[q + 1] = ny / nl; Nr[q + 2] = nz / nl;
        }
      }
      s.body.geometry.attributes.position.needsUpdate = true; s.body.geometry.attributes.normal.needsUpdate = true;
      s.body.geometry.computeBoundingSphere();
      // head
      s.lookT -= dt; if (s.lookT <= 0) { s.look = s.state === 'bask' ? (R() - 0.5) * 1.0 : (R() - 0.5) * 0.25; s.lookT = 1.5 + R() * 3; }
      s.curLook += (s.look - s.curLook) * Math.min(1, dt * 2);
      const nk = Math.round(4 + 6 * s.wet), dxn = Pn[0].x - Pn[nk].x, dzn = Pn[0].z - Pn[nk].z;
      const yawT = Math.atan2(-Tn[0].z, Tn[0].x), yawN = Math.atan2(-dzn, dxn);
      const yaw = yawT + Math.atan2(Math.sin(yawN - yawT), Math.cos(yawN - yawT)) * (0.3 + 0.5 * s.wet), pitch = Math.asin(Math.max(-1, Math.min(1, Tn[0].y)));
      s.head.rotation.order = 'YZX'; s.head.rotation.set(0, yaw + s.curLook, pitch + 0.06 * s.lift);
      s.head.position.copy(Pn[0]).addScaledVector(Tn[0], -0.004); s.head.position.y += 0.0005;
      s.head.scale.setScalar(1);
      s.nextTongue -= dt;
      if (s.nextTongue <= 0 && s.state !== 'hidden') { s.tongueT = 0.001; s.nextTongue = (s.state === 'bask' ? 2 : 1) + R() * 4; }
      if (s.tongueT > 0) { s.tongueT += dt; const f = s.tongueT < 0.5 ? Math.abs(Math.sin(s.tongueT / 0.5 * Math.PI * 2)) : 0; s.tongue.scale.x = Math.max(0.001, f); if (s.tongueT > 0.5) { s.tongueT = 0; s.tongue.scale.x = 0.001; } }
      const vis = s.state !== 'hidden'; s.body.visible = vis; s.head.visible = vis;
      // ---- water shader data: 10 body points (head -> tail) + 8 wave sources at loop apexes ----
      const base = k * 24, inW = vis && s.wet > 0.05;
      if (inW) {
        for (let q = 0; q < 16; q++) { const nd = Pn[Math.round(q / 15 * (NODES - 1))]; snkU[base + q].set(nd.x, nd.z, 0, nd.y); }
        let cx = 0, cz = 0; for (let q = 0; q < 16; q++) { cx += snkU[base + q].x; cz += snkU[base + q].y; } cx /= 16; cz /= 16;
        let rad = 0; for (let q = 0; q < 16; q++) rad = Math.max(rad, Math.hypot(snkU[base + q].x - cx, snkU[base + q].y - cz));
        for (let q = 0; q < 8; q++) { const e = snkU[base + 16 + q], age = (t % 3600) - e.z; if (age >= 0 && age < 3.2) rad = Math.max(rad, Math.hypot(e.x - cx, e.y - cz) + 0.03 + 0.3 * age); }
        snkB[k].set(cx, cz, rad + 0.05, Math.min(1, s.spd / 0.3) * sm(0.3, 0.8, s.wet) * sm(-0.05, -0.01, s.hdY));
      } else snkB[k].set(0, 0, 0, 0);
      // a loop apex is passed each time the wave phase crosses a multiple of pi
      const apex = Math.floor(s.wph0 / Math.PI);
      if (apex !== s.lastApex) {
        if (s.lastApex !== undefined && inW && s.wet > 0.5 && s.spd > 0.05 && s.hdY > -0.02) {
          const outA = s.axTh + (apex % 2 === 0 ? -Math.PI / 2 : Math.PI / 2);
          snkU[base + 16 + s.emi].set(s.hd.x, s.hd.z, t % 3600, outA); s.emi = (s.emi + 1) % 8;
        }
        s.lastApex = apex;
      }
    }
  }
  function dispose() { for (const s of snakes) { for (const o of [s.body, s.head]) { scene.remove(o); o.geometry.dispose(); o.material.dispose(); } s.tongue.geometry.dispose(); } for (const b of snkB) b.set(0, 0, 0, 0); }
  return { update, dispose, list: () => snakes };
}
