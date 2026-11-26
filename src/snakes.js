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
    const bank = k === 2, L = 1.0 + R() * 0.25, look = looks[k];
    const mat = mkMat(look.base, look.spots, L);
    // body tube
    const nV = NODES * (RAD + 1), pos = new Float32Array(nV * 3), nor = new Float32Array(nV * 3), aS = new Float32Array(nV * 2), idx = [];
    for (let i = 0; i < NODES - 1; i++) for (let j = 0; j < RAD; j++) { const a = i * (RAD + 1) + j, b = a + 1, c = a + RAD + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
    for (let i = 0; i < NODES; i++) for (let j = 0; j <= RAD; j++) { const q = i * (RAD + 1) + j; aS[q * 2] = i / (NODES - 1) * L; aS[q * 2 + 1] = j / RAD; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); g.setAttribute('aS', new THREE.BufferAttribute(aS, 2));
    g.setAttribute('sway', new THREE.BufferAttribute(new Float32Array(nV), 1)); g.setIndex(idx);
    const body = new THREE.Mesh(g, mat); body.frustumCulled = false; body.castShadow = true; body.receiveShadow = true; scene.add(body);
    const hm = patch(new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 38, specular: new THREE.Color(0.16, 0.16, 0.15) }), 'snakeH', 0);
    { const ob = hm.onBeforeCompile; hm.customProgramCacheKey = () => 'snakeH'; hm.onBeforeCompile = (sh) => { ob(sh); sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.04, 0.09, 0.085), clamp(-vWp.y * 3.0 + max(-vWp.y, 0.0) * 8.0, 0.0, 0.85));'); }; }
    const head = new THREE.Mesh(headGeo(look.base), hm); head.castShadow = true; scene.add(head);
    const tg = tongueGeo(); tg.setAttribute('sway', new THREE.Float32BufferAttribute(new Float32Array(tg.attributes.position.count), 1));
    const tongue = new THREE.Mesh(tg, patch(new THREE.MeshLambertMaterial({ color: 0x141012, side: THREE.DoubleSide }), 'tongue', 0)); head.add(tongue);
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
      rMax: 0.0118 + R() * 0.0012, lifts: new Float32Array(NODES), dep: new Float32Array(NODES), pose: null, poseI: 0, emi: 0, lastApex: undefined, hdY: 0, dv: null, diveCD: 60 + R() * 120, sinceDive: 61, fleeDive: false,
    });
  }

  // ---------- behaviour ----------
  const Hg = world.Hmesh || H; // height of the visible terrain mesh (triangles), not the analytic field
  const pickGoal = (s, env) => {
    s.goalT = 0;
    const sunny = env.sunInt * (1 - (env.cover || 0)) > 0.35 && env.day > 0.5;
    const r = R();
    if (sunny && r < 0.35) { s.state = 'toBask'; s.goal = s.bank ? bankPt(false) : islandPt(0.55, 0.95); return; }
    if (r < 0.65) { s.state = 'crawl'; s.goal = s.bank ? (R() < 0.5 ? bankPt(true) : bankPt(false)) : (R() < 0.45 ? islandWater() : islandPt(0.15, 0.9)); return; }
    s.state = 'crawl'; s.goal = s.bank ? bankPt(false) : islandPt(0.15, 0.9);
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
  const pushTrail = (arr, x, z, minD, max, y = 0) => {
    const l = arr[0];
    if (!l || Math.hypot(x - l.x, z - l.z) > minD) { arr.unshift(new V(x, y, z)); if (arr.length > max) arr.length = max; }
    else { l.x = x; l.z = z; l.y = y; }
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

  function update(dt, t, env) {
    dt = Math.min(dt, 0.1);
    const night = env.night > 0.55, wetW = (env.rain || 0) > 0.25, cam = env.cam;
    for (let k = 0; k < snakes.length; k++) {
      const s = snakes[k];
      const wantHide = night || wetW;
      if (wantHide && s.state !== 'hide' && s.state !== 'hidden') { s.state = 'hide'; s.pose = null; s.goal = s.bank ? bankPt(false) : islandPt(0.4, 0.85); }
      if (!wantHide && (s.state === 'hide' || s.state === 'hidden')) { s.hidden = Math.max(0, s.hidden - dt * 0.3); if (s.hidden <= 0) { s.state = 'crawl'; pickGoal(s, env); } }
      // flee from the player
      const dp = cam ? Math.hypot(cam.x - s.hd.x, cam.z - s.hd.z) : 99;
      if (!s.noFlee && dp < 3.0 && cam && (s.state === 'bask' || s.state === 'crawl' || s.state === 'toBask' || s.state === 'pose') && cam.y - H(cam.x, cam.z) < 4) {
        s.state = 'flee'; s.stateT = 4 + R() * 3; s.pose = null; s.fleeDive = R() < 0.35;
        const away = new V(s.hd.x - cam.x, 0, s.hd.z - cam.z).normalize();
        const w = s.bank ? bankPt(true) : islandWater();
        s.goal = new V(w.x - s.hd.x, 0, w.z - s.hd.z).normalize().dot(away) > 0 ? w : s.hd.clone().addScaledVector(away, 4);
      }
      const inWater = Hg(s.hd.x, s.hd.z) < -0.05;
      if (inWater && !s.splashed) { env.ripple(s.hd.x, s.hd.z, 0.1); s.splashed = true; }
      if (!inWater) s.splashed = false;
      s.wet += ((inWater ? 1 : 0) - s.wet) * Math.min(1, dt * 0.8);
      // speed per state
      let want = 0;
      if (s.state === 'bask') { s.stateT -= dt; if (s.stateT <= 0) { pickGoal(s, env); } }
      else if (s.state === 'hidden') want = 0;
      else if (s.state === 'pose') want = 0.1;
      else {
        const toG = s.goal ? Math.hypot(s.goal.x - s.hd.x, s.goal.z - s.hd.z) : 0;
        want = s.state === 'flee' ? (inWater ? 0.69 : 0.56) : inWater ? 0.26 + 0.05 * Math.sin(t * 0.3 + k) : 0.18 + 0.05 * Math.sin(t * 0.3 + k);
        if (s.state === 'flee') { s.stateT -= dt; if (s.stateT <= 0) pickGoal(s, env); }
        if (s.state === 'crawl' && !inWater && Math.sin(t * 0.21 + k * 2.1) > 0.88) want *= 0.03; // short pauses
        if (s.state === 'toBask' && toG < 0.4 && !inWater) { s.state = 'pose'; s.poseKind = s.forcePose || (R() < 0.65 ? 'flat' : 'ring'); s.pose = posePath(s, s.poseKind); s.poseI = 0; }
        else if ((s.state === 'crawl' || s.state === 'hide') && toG < 0.35) { if (s.state === 'hide') s.state = 'hidden'; else pickGoal(s, env); }
        if (!s.goal) pickGoal(s, env);
        // a goal that cannot be reached (rocks, deep water) is dropped after a while
        if (s.state === 'crawl' || s.state === 'toBask') { s.goalT = (s.goalT || 0) + dt; if (s.goalT > 35) { s.goalT = 0; pickGoal(s, env); } } else s.goalT = 0;
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
      // short pauses on the water surface (the current then carries the snake)
      if (inWater && !s.dv && s.state === 'crawl' && Math.sin(t * 0.17 + k * 1.3) > 0.9) want = 0;
      if (s.state === 'hidden') s.hidden = Math.min(1, s.hidden + dt * 0.3);
      s.spd += (want - s.spd) * Math.min(1, dt * 2.5);
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
          if (s.poseI >= s.pose.length) { s.state = 'bask'; s.stateT = 35 + R() * 60; s.spd = 0; }
          s.ax.set(s.hd.x, 0, s.hd.z); s.axTh = s.th; s.amp = 0.7;
        } else {
          // steer the axis toward the goal, around trunks and rocks
          let dTh = 0;
          if (s.goal) dTh = Math.atan2(Math.sin(Math.atan2(s.goal.z - s.ax.z, s.goal.x - s.ax.x) - s.axTh), Math.cos(Math.atan2(s.goal.z - s.ax.z, s.goal.x - s.ax.x) - s.axTh));
          for (const [ox, oz, orr] of obst) {
            const dx = ox - s.hd.x, dz = oz - s.hd.z, dd = Math.hypot(dx, dz);
            if (dd < orr + 0.6) { const fa = Math.atan2(dz, dx), rel = Math.atan2(Math.sin(fa - s.axTh), Math.cos(fa - s.axTh)); if (Math.abs(rel) < 1.4) dTh += (rel > 0 ? -1 : 1) * 1.6 * (1 - (dd - orr) / 0.6); }
          }
          { const lx = s.ax.x + Math.cos(s.axTh) * 0.6, lz = s.ax.z + Math.sin(s.axTh) * 0.6;
            if (Hg(lx, lz) < -1.6 || (s.bank ? Math.abs(lx - bankX) > 25 : islandE(lx, lz) > 1.45)) dTh += 1.2; }
          const maxTurn = s.spd / (s.wet > 0.5 ? 0.35 : 0.22) * dt; // turning radius limit: no sharp corners in the path
          s.axTh += Math.max(-maxTurn, Math.min(maxTurn, dTh * dt * 1.5));
          // land: serpenoid path — the heading swings ±~70° sinusoidally with the distance crawled, giving round U-loops
          // with straight flanks (wave length along the body ~0.42 L); in the water the head goes almost straight
          const thMax = 1.4 * s.amp * (s.state === 'flee' ? 0.85 : 1), lam = 0.42 * s.L * (s.state === 'flee' ? 0.85 : 1);
          const wph = s.wph0 + 2 * Math.PI * step / lam;
          const hth = s.axTh + thMax * Math.sin(wph);
          const nx = s.hd.x + Math.cos(hth) * step, nz = s.hd.z + Math.sin(hth) * step;
          const tooDeep = Hg(nx, nz) < -1.7, offHome = s.bank ? Math.abs(nx - bankX) > 26 : islandE(nx, nz) > 1.5;
          if (tooDeep || offHome) { s.axTh += s.spd / 0.3 * dt; s.goal = s.bank ? bankPt(false) : islandPt(0.2, 0.8); if (s.state === 'flee') s.state = 'crawl'; }
          else { s.hd.x = nx; s.hd.z = nz; s.th = hth; s.wph0 = wph; } // the wave phase only advances when the head really moves
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
      if (inWater && s.spd < 0.05 && !(s.dv && s.dv.ph === 'bottom')) {
        const sl = (mz(s.hd.x + 1) - mz(s.hd.x - 1)) / 2, fl = Math.hypot(1, sl), cv = (0.04 + 0.03 * Math.min(1, depthHere / 1.2)) * (1 - s.spd / 0.05);
        const fx = 1 / fl * cv * dt, fz = sl / fl * cv * dt;
        const nxh = s.hd.x + fx, nzh = s.hd.z + fz;
        if (Hg(nxh, nzh) < -0.15 && (s.bank ? Math.abs(nxh - bankX) < 25 : islandE(nxh, nzh) < 1.45)) {
          // slow turn toward upstream around the middle of the body
          const up = Math.atan2(-sl, -1), d = Math.atan2(Math.sin(up - s.axTh), Math.cos(up - s.axTh)), rot = Math.max(-0.08, Math.min(0.08, d)) * dt;
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
      const sinkH = s.hidden * 0.12, fl = 1 - 0.25 * s.flat;
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
      const vis = s.hidden < 0.98; s.body.visible = vis; s.head.visible = vis;
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
