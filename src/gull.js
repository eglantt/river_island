import * as THREE from 'three';

// Herring-gull: lofted body, long narrow "M"-planform wings with arm/hand joints (CPU-deformed each frame),
// vertex-coloured plumage (grey mantle, black tips with white mirrors, white trailing edge), fan tail.
const SEMI = 0.68; // half span, m (span ~1.4 m)
const WRIST = 0.42;
const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const LEx = (s) => (s < WRIST ? 0.07 * Math.sin(s / WRIST * Math.PI / 2) : 0.07 - 0.27 * Math.pow((s - WRIST) / (1 - WRIST), 1.3));
const chord = (s) => (s < WRIST ? 0.19 - 0.04 * (s / WRIST) : 0.15 * Math.pow(1 - (s - WRIST) / (1 - WRIST), 0.7) + 0.01);

function bodyGeo() {
  // profile: x, half-height, half-width, centre y
  const prof = [[-0.3, 0.012, 0.012, 0.01], [-0.22, 0.04, 0.045, 0.0], [-0.12, 0.065, 0.07, 0], [-0.02, 0.078, 0.08, -0.005], [0.07, 0.07, 0.068, 0], [0.13, 0.05, 0.048, 0.02], [0.17, 0.047, 0.044, 0.04], [0.22, 0.05, 0.045, 0.05], [0.26, 0.038, 0.034, 0.05], [0.285, 0.016, 0.016, 0.047]];
  const seg = 14, pos = [], col = [], idx = [];
  const white = new THREE.Color('#f2f1ec'), grey = new THREE.Color('#a3aab1'), eye = new THREE.Color('#e8d24a');
  prof.forEach(([x, hy, hz, cy], j) => {
    for (let i = 0; i <= seg; i++) {
      const a = i / seg * Math.PI * 2, y = cy + Math.sin(a) * hy, z = Math.cos(a) * hz;
      pos.push(x, y, z);
      let c = white;
      if (Math.sin(a) > 0.55 && x > -0.17 && x < 0.09) c = grey;                 // mantle
      if (j === 7 && Math.abs(Math.cos(a)) > 0.7 && Math.sin(a) > 0.15 && Math.sin(a) < 0.6) c = eye;
      col.push(c.r, c.g, c.b);
    }
  });
  for (let j = 0; j < prof.length - 1; j++) for (let i = 0; i < seg; i++) { const a = j * (seg + 1) + i, b = a + seg + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
  // beak: tapered wedge with a slight hook and red gonys spot
  const b0 = pos.length / 3, y0 = 0.045, Y = new THREE.Color('#e9c23a'), Rd = new THREE.Color('#c8352a');
  const bp = [[0.275, y0 + 0.014, 0.012], [0.275, y0 + 0.014, -0.012], [0.275, y0 - 0.016, 0.012], [0.275, y0 - 0.016, -0.012], [0.35, y0 + 0.002, 0.004], [0.35, y0 + 0.002, -0.004], [0.345, y0 - 0.012, 0.003], [0.345, y0 - 0.012, -0.003], [0.362, y0 - 0.008, 0]];
  bp.forEach((p, i) => { pos.push(...p); const c = i === 6 || i === 7 ? Rd : Y; col.push(c.r, c.g, c.b); });
  idx.push(b0, b0 + 4, b0 + 1, b0 + 1, b0 + 4, b0 + 5, b0 + 2, b0 + 3, b0 + 6, b0 + 3, b0 + 7, b0 + 6, b0, b0 + 2, b0 + 4, b0 + 2, b0 + 6, b0 + 4, b0 + 1, b0 + 5, b0 + 3, b0 + 3, b0 + 5, b0 + 7, b0 + 4, b0 + 8, b0 + 5, b0 + 6, b0 + 7, b0 + 8, b0 + 4, b0 + 6, b0 + 8, b0 + 5, b0 + 8, b0 + 7);
  // tucked pink feet
  const f0 = pos.length / 3, P = new THREE.Color('#d9958a');
  [[-0.14, -0.05, 0.025], [-0.24, -0.04, 0.035], [-0.24, -0.045, 0.012], [-0.14, -0.05, -0.025], [-0.24, -0.04, -0.035], [-0.24, -0.045, -0.012]].forEach((p) => { pos.push(...p); col.push(P.r, P.g, P.b); });
  idx.push(f0, f0 + 1, f0 + 2, f0 + 3, f0 + 5, f0 + 4);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}

function tailGeo() {
  // fan of 5 rectangles; spread is animated by scaling z
  const pos = [], col = [], idx = [], W = new THREE.Color('#f2f1ec');
  const n = 6;
  for (let i = 0; i <= n; i++) {
    const a = (i / n - 0.5) * 0.9, L = 0.15 - Math.abs(i / n - 0.5) * 0.03;
    pos.push(-0.2, 0.012, Math.sin(a) * 0.02, -0.2 - Math.cos(a) * L, 0.006, Math.sin(a) * L * 0.9);
    col.push(W.r, W.g, W.b, W.r * 0.95, W.g * 0.95, W.b * 0.95);
  }
  for (let i = 0; i < n; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}

function wingTemplate() {
  // parametric surface: s (root->tip), c (leading->trailing), upper/lower skins
  const NS = 26, NC = 7, verts = [], col = [], idx = [];
  const up = new THREE.Color('#9fa7af'), black = new THREE.Color('#1d1d20'), white = new THREE.Color('#f4f3ef'), under = new THREE.Color('#dfe2e4');
  for (const side of [1, -1]) { // 1 = upper skin, -1 = lower
    const base = verts.length;
    for (let i = 0; i <= NS; i++) for (let j = 0; j <= NC; j++) {
      const s = i / NS, c = j / NC;
      verts.push({ s, c, t: side });
      let k;
      if (side > 0) {
        k = up.clone();
        if (s > 0.8) k.lerp(black, sm(0.8, 0.86, s));
        const mirror = (Math.abs(s - 0.94) < 0.025 && c > 0.25 && c < 0.65) || s > 0.985;
        if (mirror) k = white.clone();
        if (c > 0.86 && s < 0.85) k.lerp(white, 0.85);          // white trailing edge
        if (s < 0.06) k.lerp(white, 0.4);
      } else {
        k = under.clone(); if (s > 0.84) k.lerp(black, sm(0.84, 0.92, s) * 0.85);
      }
      col.push(k);
    }
    for (let i = 0; i < NS; i++) for (let j = 0; j < NC; j++) {
      const a = base + i * (NC + 1) + j, b = a + NC + 1;
      if (side > 0) idx.push(a, b, a + 1, a + 1, b, b + 1); else idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  return { verts, col, idx };
}

export function createGull(scale = 1) {
  const root = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, emissive: new THREE.Color('#40444a') }); // feathers scatter light: pale even from below
  const body = new THREE.Mesh(bodyGeo(), mat); root.add(body);
  const tail = new THREE.Mesh(tailGeo(), mat); root.add(tail);
  const T = wingTemplate();
  const wings = [1, -1].map((sd) => {
    const g = new THREE.BufferGeometry(), n = T.verts.length;
    const pos = new Float32Array(n * 3), cl = new Float32Array(n * 3);
    T.col.forEach((k, i) => { cl[i * 3] = k.r; cl[i * 3 + 1] = k.g; cl[i * 3 + 2] = k.b; });
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(cl, 3));
    g.setIndex(T.idx);
    const m = new THREE.Mesh(g, mat); m.frustumCulled = false; root.add(m);
    return { sd, g, pos };
  });
  root.scale.setScalar(scale);
  const v = new THREE.Vector3(), q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion(), ax = new THREE.Vector3(1, 0, 0), ay = new THREE.Vector3(0, 1, 0);
  const pivotS = new THREE.Vector3(0.02, 0.035, 0.07);
  // pose: arm (up angle), hand (extra up angle), fold (hand swept back), sweep (arm back)
  function pose(arm, hand, fold, sweep, tailSpread) {
    for (const w of wings) {
      const { sd, pos } = w;
      q1.setFromAxisAngle(ax, -arm).multiply(new THREE.Quaternion().setFromAxisAngle(ay, -sweep));
      q2.setFromAxisAngle(ay, -fold).premultiply(new THREE.Quaternion().setFromAxisAngle(ax, -hand));
      const wristX = LEx(WRIST);
      T.verts.forEach(({ s, c, t }, i) => {
        const ch = chord(s);
        // feathered trailing edge on the hand
        const serr = c === 1 && s > WRIST ? ((Math.round(s * 26) % 2) * 0.012) : 0;
        const x = LEx(s) - c * ch - serr, z = s * SEMI;
        const camber = 0.02 * Math.sin(Math.PI * c) * (ch / 0.2), thick = t * 0.006 * Math.sin(Math.PI * Math.min(1, c * 1.4)) * (1 - s * 0.8);
        v.set(x, camber + thick, z);
        const wh = sm(WRIST - 0.06, WRIST + 0.06, s);
        if (wh > 0) { // hand rotation about the wrist
          const px = wristX, pz = WRIST * SEMI;
          const h = new THREE.Vector3(v.x - px, v.y, v.z - pz).applyQuaternion(new THREE.Quaternion().slerpQuaternions(new THREE.Quaternion(), q2, wh));
          v.set(h.x + px, h.y, h.z + pz);
        }
        v.applyQuaternion(q1);
        pos[i * 3] = v.x + pivotS.x; pos[i * 3 + 1] = v.y + pivotS.y; pos[i * 3 + 2] = sd * (v.z + pivotS.z);
      });
      w.g.attributes.position.needsUpdate = true; w.g.computeVertexNormals();
    }
    tail.scale.z = tailSpread;
  }
  // glide <-> flap blend; phase in radians
  function animate(phase, flapW, bank) {
    const sn = Math.sin(phase), up = Math.max(0, -sn);
    const arm = (0.16) * (1 - flapW) + (0.12 + 0.62 * sn) * flapW;
    const hand = (-0.1) * (1 - flapW) + (0.3 * Math.sin(phase - 0.7) - 0.15 * up) * flapW;
    const fold = 0.12 * (1 - flapW) + (0.05 + 0.5 * up) * flapW;
    const sweep = 0.05 + 0.12 * up * flapW;
    pose(arm, hand, fold, sweep, 1 + Math.min(1, Math.abs(bank) * 2.5));
    body.position.y = -0.03 * sn * flapW;
  }
  animate(0, 0, 0);
  const api = { root, animate, dispose() { root.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); mat.dispose(); } };
  root.userData.gull = api;
  return api;
}

// flat silhouette geometry with gull planform for distant flock birds (one wing, z outward)
export function flockWingGeo() {
  const pts = [];
  for (let i = 0; i <= 8; i++) { const s = i / 8; pts.push([LEx(s), s]); }
  for (let i = 8; i >= 0; i--) { const s = i / 8; pts.push([LEx(s) - chord(s), s]); }
  const pos = [];
  for (let i = 0; i < 8; i++) {
    const a = pts[i], b = pts[i + 1], c = pts[16 - i], d = pts[17 - i];
    pos.push(a[0], 0, a[1], b[0], 0, b[1], d[0], 0, d[1], b[0], 0, b[1], c[0], 0, c[1], d[0], 0, d[1]);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
  return g;
}
