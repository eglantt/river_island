import * as THREE from 'three';
import { makeNoise, rng } from './noise.js';
import { U, patch, waterMaterial, rainMaterial, pointsMaterial, mistMaterial, skyMaterial } from './shaders.js';

const C = (h) => new THREE.Color(h);
const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

// ---------- geometry accumulator (non-indexed position/normal/color/sway) ----------
class Acc {
  constructor() { this.p = []; this.n = []; this.c = []; this.s = []; }
  add(geo, colorFn, swayFn) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const P = g.attributes.position, N = g.attributes.normal, v = new THREE.Vector3(), nn = new THREE.Vector3();
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i); nn.fromBufferAttribute(N, i);
      this.p.push(v.x, v.y, v.z); this.n.push(nn.x, nn.y, nn.z);
      const c = colorFn(v, nn); this.c.push(c.r, c.g, c.b); this.s.push(swayFn ? swayFn(v) : 0);
    }
    if (g !== geo) g.dispose(); geo.dispose();
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('sway', new THREE.Float32BufferAttribute(this.s, 1));
    g.computeBoundingSphere();
    return g;
  }
}

function limbGeo(p0, p1, r0, r1, segs = 6, hseg = 2) {
  const dir = new THREE.Vector3().subVectors(p1, p0), len = dir.length();
  const g = new THREE.CylinderGeometry(r1, r0, len, segs, hseg, true);
  g.translate(0, len / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
  g.translate(p0.x, p0.y, p0.z);
  return g;
}

// Displaced icosahedron blob with soft radial normals
function blobGeo(N, c, r, sy, detail = 1, rough = 0.28) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const P = g.attributes.position, Nn = g.attributes.normal, v = new THREE.Vector3();
  for (let i = 0; i < P.count; i++) {
    v.fromBufferAttribute(P, i);
    const k = 1 + rough * N.n2(v.x * 1.7 + c.x * 0.37 + v.z, v.y * 1.7 + c.z * 0.41 + c.y);
    const nx = v.x, ny = v.y, nz = v.z;
    v.multiplyScalar(r * k); v.y *= sy;
    P.setXYZ(i, v.x + c.x, v.y + c.y, v.z + c.z);
    const L = Math.hypot(nx, ny / sy, nz); Nn.setXYZ(i, nx / L, ny / sy / L, nz / L);
  }
  return g;
}

export function buildWorld(seed, Q) {
  const R = rng(seed), N = makeNoise(seed), group = new THREE.Group();
  const meshes = {};
  // ---------- river & island shape ----------
  const A1 = 6 + R() * 4, PH = R() * 6.28, A2 = 2 + R() * 2.5, HW = 40;
  const mz = (x) => A1 * Math.sin(x * 0.011 + PH) + A2 * Math.sin(x * 0.023 + 1.3);
  U.uRiver.value.set(A1, PH, A2, HW);
  const zc0 = mz(0), irx = 19 + R() * 5, irz = 12 + R() * 3, ia = (R() - 0.5) * 0.5, ca = Math.cos(ia), sa = Math.sin(ia);
  function islandE(x, z) {
    const u = x * ca + (z - zc0) * sa, v = -x * sa + (z - zc0) * ca;
    return Math.hypot(u / irx, v / irz) + 0.13 * N.n2(x * 0.055 + 11, z * 0.055) + 0.05 * N.n2(x * 0.19, z * 0.19);
  }
  function H(x, z) {
    const zc = mz(x), d = Math.abs(z - zc);
    const hw = HW + 3 * N.n2(x * 0.008, 7.7);
    let h = -3.1 + 3.75 * sm(0.3 * hw, hw + 9, d);
    h += Math.max(0, d - hw - 9) * 0.045;
    h += sm(hw + 8, hw + 95, d) * (N.fbm(x * 0.006, z * 0.006, 4) * 0.5 + 0.5) * 24;
    h += N.n2(x * 0.05, z * 0.05) * 0.25 * sm(hw - 2, hw + 12, d);
    const e = islandE(x, z);
    if (e < 1.6) {
      const core = 0.42 + 2.4 * Math.max(0, 1 - e * e) * (0.75 + 0.25 * N.n2(x * 0.07, z * 0.07)) + 0.35 * N.fbm(x * 0.08, z * 0.08, 2) * Math.max(0, 1 - e);
      const s = sm(0.82, 1.32, e);
      h = Math.max(h, core * (1 - s) - 3.1 * s);
    }
    return h;
  }
  const bankDist = (x, z) => Math.abs(z - mz(x)) - HW;

  // ---------- terrain ----------
  const TS = 1200, seg = Q.terr, a = 0.09;
  const map = (u) => TS * (a * u + (1 - a) * u * u * u);
  const tg = new THREE.PlaneGeometry(2, 2, seg, seg); tg.rotateX(-Math.PI / 2);
  const tp = tg.attributes.position, cols = new Float32Array(tp.count * 3);
  const cSand = C('#b7a27a'), cWet = C('#6e6146'), cBed = C('#4d4a35'), cBedDeep = C('#2f3a2b'), cGrass = C('#5f8f3a'), cGrass2 = C('#86a043'), cGrass3 = C('#4a7a30'), cDirt = C('#735f42'), cForest = C('#2f4a24'), cMoss = C('#3e5e2c');
  const tmp = new THREE.Color();
  for (let i = 0; i < tp.count; i++) {
    const x = map(tp.getX(i)), z = map(tp.getZ(i)) + mz(map(tp.getX(i))) * (1 - Math.min(1, Math.abs(tp.getZ(i)) * 3));
    const h = H(x, z); tp.setXYZ(i, x, h, z);
    const sl = Math.min(1, (Math.abs(H(x + 1, z) - h) + Math.abs(H(x, z + 1) - h)) * 0.9);
    const nz = N.n2(x * 0.09, z * 0.09), bd = bankDist(x, z);
    if (h < -1.2) tmp.copy(cBed).lerp(cBedDeep, sm(-1.2, -3, h));
    else if (h < -0.15) tmp.copy(cWet).lerp(cBed, sm(-0.15, -1.2, h));
    else if (h < 0.32 + nz * 0.12) tmp.copy(cSand).lerp(cWet, sm(0.15, -0.15, h));
    else {
      tmp.copy(cGrass).lerp(nz > 0 ? cGrass2 : cGrass3, Math.abs(nz) * 0.8);
      tmp.lerp(cDirt, sm(0.35, 0.8, sl) * 0.8);
      tmp.lerp(cForest, sm(14, 60, bd) * (islandE(x, z) > 1.2 ? 1 : 0));
      tmp.lerp(cMoss, sm(70, 400, bd) * 0.5);
    }
    tmp.toArray(cols, i * 3);
  }
  tg.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  tg.setAttribute('sway', new THREE.BufferAttribute(new Float32Array(tp.count), 1));
  tg.computeVertexNormals();
  const terrain = new THREE.Mesh(tg, patch(new THREE.MeshLambertMaterial({ vertexColors: true }), 'terrain', 0, { DETAIL: '' }));
  terrain.receiveShadow = true; group.add(terrain);

  // ---------- mountains ----------
  const r0 = 1180, r1 = 5400;
  const mh = (r, th) => {
    const c = Math.cos(th), s = Math.sin(th);
    const env = sm(r0, 2300, r) * (1 - sm(4700, r1, r) * 0.7);
    const rd = N.ridged(c * r * 0.00062 + 50, s * r * 0.00062 + 9, 5) * 0.7 + (N.fbm(c * r * 0.0004, s * r * 0.0004 + 30, 3) * 0.5 + 0.5) * 0.45;
    const big = 0.5 + 0.5 * (N.n2(c * 1.4, s * 1.4 + 4) * 0.5 + 0.5);
    const boost = 1 + 0.7 * Math.max(0, -c) ** 2;
    // river valley: nearer ridges dip where the river leaves (east / west)
    const valley = Math.exp(-s * s * 28) * (1 - sm(2600, 3600, r));
    const base = -25 + 55 * sm(r0, r0 + 350, r);
    let y = base + env * (rd * big * 720 * boost + 150 * (0.6 + 0.4 * N.n2(c * 4, s * 4 + 7))) * (1 - 0.55 * valley);
    // distant closing range: no gaps on the horizon
    const back = sm(3500, 4500, r) * (1 - sm(5000, r1, r) * 0.6);
    y = Math.max(y, base + back * (430 + 260 * (N.ridged(c * 2.2 + 3, s * 2.2 + 1, 4))));
    return y;
  };
  {
    const AS = Q.mtn, RS = 30, pos = [], col = [], idx = [];
    const cLow = C('#34502c'), cRock = C('#6b6a68'), cRock2 = C('#58524a'), cSnow = C('#eef2f7');
    for (let j = 0; j <= RS; j++) {
      const r = r0 * Math.pow(r1 / r0, j / RS);
      for (let i = 0; i <= AS; i++) {
        const th = i / AS * Math.PI * 2, y = mh(r, th);
        pos.push(Math.cos(th) * r, y, Math.sin(th) * r);
        const sl = Math.abs(mh(r + 60, th) - y) / 60 + Math.abs(mh(r, th + 0.015) - y) / (r * 0.015);
        const nn = N.n2(th * 40, r * 0.004);
        tmp.copy(cLow).lerp(nn > 0 ? cRock : cRock2, sm(200, 420, y + nn * 100) * 0.9 + sm(0.6, 1.1, sl) * 0.6);
        tmp.lerp(cSnow, sm(560, 700, y + nn * 110) * (1 - sm(0.9, 1.5, sl) * 0.7));
        col.push(tmp.r, tmp.g, tmp.b);
      }
    }
    for (let j = 0; j < RS; j++) for (let i = 0; i < AS; i++) { const a0 = j * (AS + 1) + i, b0 = a0 + AS + 1; idx.push(a0, a0 + 1, b0, a0 + 1, b0 + 1, b0); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('sway', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3), 1));
    g.setIndex(idx); g.computeVertexNormals();
    group.add(new THREE.Mesh(g, patch(new THREE.MeshLambertMaterial({ vertexColors: true, fog: false }), 'mtn', 0, { MTN: '' })));
  }
  // ---------- horizon profile seen from the island (for sun / moon occlusion) ----------
  const HZN = 720, horizon = new Float32Array(HZN);
  {
    const eye = 2, cx = 0, cz = zc0;
    for (let i = 0; i < HZN; i++) {
      const az = i / HZN * Math.PI * 2, dx = Math.cos(az), dz = Math.sin(az);
      let best = -0.2;
      for (let d = 25; d < 5400; d *= 1.045) {
        const x = cx + dx * d, z = cz + dz * d, r = Math.hypot(x, z);
        let h = Math.abs(x) < 1200 && Math.abs(z) < 1200 ? H(x, z) : -50;
        if (r > r0) h = Math.max(h, mh(r, Math.atan2(z, x)));
        best = Math.max(best, Math.atan2(h - eye, d));
      }
      horizon[i] = best;
    }
  }
  {
    const d = new Uint8Array(HZN * 4);
    for (let i = 0; i < HZN; i++) { const v = Math.max(0, Math.min(255, Math.round((horizon[i] + 0.05) / 0.4 * 255))); d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
    const t = new THREE.DataTexture(d, HZN, 1, THREE.RGBAFormat); t.wrapS = THREE.RepeatWrapping; t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
    if (U.tHzn.value) U.tHzn.value.dispose(); U.tHzn.value = t;
  }
  const horizonEl = (az) => {
    const f = ((az / (Math.PI * 2)) % 1 + 1) % 1 * HZN, i = Math.floor(f) % HZN, t = f - Math.floor(f);
    return horizon[i] * (1 - t) + horizon[(i + 1) % HZN] * t;
  };

  // ---------- water + depth texture ----------
  {
    const W = 512, Hh = 224, box = U.uDepthBox.value, d = new Uint8Array(W * Hh * 4);
    for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
      const wx = box.x + (x + 0.5) / W * box.z, wz = box.y + (y + 0.5) / Hh * box.w;
      const v = Math.max(0, Math.min(1, -H(wx, wz) / 4)) * 255, k = (y * W + x) * 4;
      d[k] = d[k + 1] = d[k + 2] = v; d[k + 3] = 255;
    }
    const tex = new THREE.DataTexture(d, W, Hh, THREE.RGBAFormat); tex.magFilter = tex.minFilter = THREE.LinearFilter; tex.needsUpdate = true;
    if (U.tDepth.value) U.tDepth.value.dispose(); U.tDepth.value = tex;
    const wg = new THREE.PlaneGeometry(2600, 2600, 1, 1); wg.rotateX(-Math.PI / 2);
    const water = new THREE.Mesh(wg, waterMaterial()); water.renderOrder = 2; group.add(water);
  }

  // ---------- island vegetation ----------
  const trunks = []; // collision circles
  const trunkAcc = new Acc(), leafAcc = new Acc(), rockAcc = new Acc(), bushAcc = new Acc();
  const onIsland = (x, z) => islandE(x, z) < 0.95 && H(x, z) > 0.2;
  const randIsland = (emax, tries = 200) => {
    for (let t = 0; t < tries; t++) {
      const u = (R() * 2 - 1) * irx * 1.3, v = (R() * 2 - 1) * irz * 1.3;
      const x = u * ca - v * sa, z = zc0 + u * sa + v * ca;
      if (islandE(x, z) < emax && H(x, z) > 0.25) return [x, z];
    }
    return null;
  };
  const leafCols = { oak: ['#4f7d2e', '#5f8a34', '#3f6a28'], birch: ['#7da23a', '#8db345', '#6c9433'], willow: ['#7c9a3e', '#8aa84a', '#6a8a36'], bush: ['#3d6b2a', '#4b7a2f', '#567f30', '#35602a'] };

  function tree(x, z, kind) {
    const g0 = H(x, z), base = new THREE.Vector3(x, g0 - 0.2, z);
    const height = kind === 'birch' ? 6 + R() * 2.5 : kind === 'willow' ? 4.5 + R() * 1.5 : 4.5 + R() * 2;
    const lean = new THREE.Vector3((R() - 0.5) * (kind === 'willow' ? 0.6 : 0.2), 1, (R() - 0.5) * (kind === 'willow' ? 0.6 : 0.2)).normalize();
    const rBase = kind === 'birch' ? 0.17 : kind === 'willow' ? 0.32 : 0.28;
    trunks.push([x, z, rBase + 0.25]);
    const lc = leafCols[kind], barkCol = kind === 'birch' ? C('#e8e4da') : C('#5a4632'), barkDark = C('#2a2420');
    const swayT = (v) => Math.max(0, (v.y - g0) / height) ** 2 * 0.35;
    const barkFn = (v) => {
      if (kind !== 'birch') return tmp.copy(barkCol).multiplyScalar(0.8 + 0.3 * N.n2(v.x * 5, v.y * 3));
      return N.n2(v.y * 4 + v.x * 9, v.z * 9) > 0.35 ? barkDark : barkCol;
    };
    function leaves(c, r) {
      const col = C(lc[Math.floor(R() * lc.length)]), sy = kind === 'willow' ? 1.35 : kind === 'birch' ? 1.2 : 0.95;
      const cc = kind === 'willow' ? c.clone().add(new THREE.Vector3(0, -r * 0.45, 0)) : c;
      leafAcc.add(blobGeo(N, cc, r, sy, 2, 0.3), (v) => tmp.copy(col).multiplyScalar(0.62 + 0.55 * sm(cc.y - r * sy, cc.y + r * sy, v.y) + 0.1 * N.n2(v.x * 3, v.z * 3)), (v) => 0.25 + 0.75 * Math.max(0, (v.y - g0) / height));
      if (kind === 'willow') for (let k = 0; k < 3; k++) {
        const hc = cc.clone().add(new THREE.Vector3((R() - 0.5) * r * 1.6, -r * (0.9 + R() * 0.5), (R() - 0.5) * r * 1.6));
        leafAcc.add(blobGeo(N, hc, r * 0.38, 2.4, 1, 0.2), (v) => tmp.copy(col).multiplyScalar(0.7 + 0.35 * sm(hc.y - r, hc.y + r, v.y)), () => 0.9);
      }
    }
    function branch(p, dir, len, r, depth) {
      const end = p.clone().addScaledVector(dir, len);
      trunkAcc.add(limbGeo(p, end, r, r * 0.68, depth > 1 ? 7 : 5, 2), barkFn, swayT);
      if (depth === 0) { leaves(end, (kind === 'birch' ? 0.85 : 1.15) + R() * 0.45); return; }
      const kids = depth === 1 ? 3 : 2 + (R() < 0.5 ? 1 : 0);
      for (let k = 0; k < kids; k++) {
        const nd = dir.clone().add(new THREE.Vector3((R() - 0.5) * 1.5, (kind === 'willow' ? 0.15 : 0.45) + R() * 0.4, (R() - 0.5) * 1.5)).normalize();
        branch(end, nd, len * (0.62 + R() * 0.15), r * 0.62, depth - 1);
      }
      if (depth === 1 && R() < 0.7) leaves(end, 0.9 + R() * 0.3);
    }
    branch(base, lean, height * 0.5, rBase, 2);
  }
  {
    const nT = 3 + Math.floor(R() * 3), kinds = ['willow', 'birch', 'oak', 'birch', 'willow'];
    for (let i = 0; i < nT; i++) {
      let s = null;
      for (let t = 0; t < 40 && !s; t++) {
        const c = randIsland(i === 0 ? 0.9 : 0.75);
        if (c && trunks.every(([x, z]) => Math.hypot(x - c[0], z - c[1]) > 6)) s = c;
      }
      if (s) tree(s[0], s[1], kinds[i]);
    }
    // bushes
    const nB = 9 + Math.floor(R() * 7);
    for (let i = 0; i < nB; i++) {
      const c = randIsland(0.9); if (!c) continue;
      const [x, z] = c, g0 = H(x, z), col = C(leafCols.bush[Math.floor(R() * 4)]), k = 3 + Math.floor(R() * 4), sz = 0.6 + R() * 0.6;
      for (let j = 0; j < k; j++) {
        const cc = new THREE.Vector3(x + (R() - 0.5) * sz * 1.8, g0 + sz * (0.35 + R() * 0.5), z + (R() - 0.5) * sz * 1.8), r = sz * (0.45 + R() * 0.4);
        bushAcc.add(blobGeo(N, cc, r, 0.85, 2, 0.3), (v) => tmp.copy(col).multiplyScalar(0.62 + 0.6 * sm(g0, cc.y + r, v.y)), (v) => Math.max(0, v.y - g0) * 0.25);
      }
    }
    // rocks along the shore
    const nR = 7 + Math.floor(R() * 6), cRock = C('#7b766c'), cMossR = C('#55703a');
    for (let i = 0; i < nR; i++) {
      let c = null;
      for (let t = 0; t < 80 && !c; t++) { const q = randIsland(1.25, 50); if (q && islandE(q[0], q[1]) > 0.78) c = q; }
      if (!c) continue;
      const [x, z] = c, g0 = H(x, z), r = 0.25 + R() * 0.7, cc = new THREE.Vector3(x, g0 + r * 0.15, z);
      rockAcc.add(blobGeo(N, cc, r, 0.6, 1, 0.22), (v, n) => tmp.copy(cRock).lerp(cMossR, sm(0.4, 0.9, n.y) * 0.6).multiplyScalar(0.75 + 0.25 * N.n2(v.x * 4, v.z * 4)), () => 0);
    }
  }
  const leafMat = patch(new THREE.MeshLambertMaterial({ vertexColors: true }), 'leaf', 0.32, { LEAF: '' });
  const barkMat = patch(new THREE.MeshLambertMaterial({ vertexColors: true }), 'bark', 0.32);
  const addAcc = (acc, mat, cast = true) => { if (!acc.p.length) return; const m = new THREE.Mesh(acc.build(), mat); m.castShadow = cast; m.receiveShadow = true; group.add(m); };
  addAcc(trunkAcc, barkMat); addAcc(leafAcc, leafMat); addAcc(bushAcc, leafMat); addAcc(rockAcc, barkMat);

  // ---------- instanced helpers ----------
  const dummy = new THREE.Object3D();
  function instanced(geo, mat, count, place) {
    const m = new THREE.InstancedMesh(geo, mat, count); let n = 0;
    for (let i = 0; i < count; i++) { const col = place(dummy); if (!col) continue; dummy.updateMatrix(); m.setMatrixAt(n, dummy.matrix); m.setColorAt(n, col); n++; }
    m.count = n; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.frustumCulled = false; group.add(m); return m;
  }
  function bladeGeo(w, segs, tipCol, rootCol, curve) {
    const pos = [], col = [], sw = [], nor = [], idx = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs, ww = w * (1 - t) * 0.5 + (i === segs ? 0 : 0), bend = curve * t * t;
      const c = rootCol.clone().lerp(tipCol, t);
      if (i < segs) { pos.push(-ww, t, bend, ww, t, bend); col.push(c.r, c.g, c.b, c.r, c.g, c.b); sw.push(t * t, t * t); nor.push(0, 1, 0, 0, 1, 0); }
      else { pos.push(0, t, bend); col.push(c.r, c.g, c.b); sw.push(1); nor.push(0, 1, 0); }
    }
    for (let i = 0; i < segs - 1; i++) { const a0 = i * 2; idx.push(a0, a0 + 1, a0 + 2, a0 + 1, a0 + 3, a0 + 2); }
    const l = (segs - 1) * 2; idx.push(l, l + 1, l + 2);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('sway', new THREE.Float32BufferAttribute(sw, 1)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setIndex(idx); return g;
  }
  const white = new THREE.Color(1, 1, 1);

  // grass
  {
    const g = bladeGeo(0.04, 4, C('#c3c865'), C('#3d6a26'), 0.1);
    const mat = patch(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 'grass', 0.55, { GUST: '', NOFLIP: '' });
    const tint = new THREE.Color();
    meshes.grass = instanced(g, mat, Q.grass, (d) => {
      for (let t = 0; t < 12; t++) {
        const c = randIsland(0.97, 1); if (!c) continue;
        const [x, z] = c, h = H(x, z); if (h < 0.3 + N.n2(x * 0.4, z * 0.4) * 0.1) continue;
        if (trunks.some(([tx, tz, r]) => Math.hypot(tx - x, tz - z) < r * 0.8)) continue;
        const patchy = N.n2(x * 0.25, z * 0.25);
        d.position.set(x, h - 0.03, z); d.rotation.set(0, R() * 6.28, 0);
        const hs = (0.22 + R() * 0.3) * (0.8 + 0.5 * sm(-0.3, 0.6, patchy)) * sm(0.2, 0.55, h);
        d.scale.set(0.8 + R() * 0.6, hs, 1);
        return tint.setHSL(0.22 + (R() - 0.5) * 0.05 + patchy * 0.02, 0.5, 0.42 + R() * 0.16).multiplyScalar(2.2);
      }
      return null;
    });
    meshes.grass.receiveShadow = !!Q.shadows;
  }
  // flowers
  const flowerPts = [];
  {
    const pos = [], col = [], sw = [], nor = [];
    const stem = C('#3f6b2a'), petals = 6;
    pos.push(-0.006, 0, 0, 0.006, 0, 0, 0, 1, 0); col.push(stem.r, stem.g, stem.b, stem.r, stem.g, stem.b, stem.r, stem.g, stem.b); sw.push(0, 0, 1); nor.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
    for (let k = 0; k < petals; k++) {
      const a0 = k / petals * 6.283, a1 = (k + 0.5) / petals * 6.283, a2 = (k + 1) / petals * 6.283, r = 0.065;
      pos.push(0, 0.99, 0, Math.cos(a0) * r * 0.5, 1, Math.sin(a0) * r * 0.5, Math.cos(a1) * r, 1.03, Math.sin(a1) * r);
      pos.push(0, 0.99, 0, Math.cos(a1) * r, 1.03, Math.sin(a1) * r, Math.cos(a2) * r * 0.5, 1, Math.sin(a2) * r * 0.5);
      for (let q = 0; q < 6; q++) { col.push(1, 1, 1); sw.push(1); nor.push(0, 1, 0); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('sway', new THREE.Float32BufferAttribute(sw, 1)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    const pal = ['#ffffff', '#ffd21f', '#ffe36b', '#a77bff', '#ff7fb0', '#6f8dff'].map((h) => C(h).multiplyScalar(1.25));
    const clusters = [];
    for (let i = 0; i < 22; i++) { const c = randIsland(0.85); if (c) clusters.push([c[0], c[1], pal[Math.floor(R() * pal.length)], 0.8 + R() * 1.8]); }
    meshes.flowers = instanced(g, patch(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 'flower', 0.55, { NOFLIP: '' }), Q.flowers, (d) => {
      if (!clusters.length) return null;
      for (let t = 0; t < 8; t++) {
        const cl = clusters[Math.floor(R() * clusters.length)], rr = cl[3] * Math.sqrt(-2 * Math.log(R() + 1e-6)) * 0.6, an = R() * 6.28;
        const x = cl[0] + Math.cos(an) * rr, z = cl[1] + Math.sin(an) * rr;
        if (!onIsland(x, z) || H(x, z) < 0.35) continue;
        const h = 0.22 + R() * 0.28; d.position.set(x, H(x, z) - 0.02, z); d.rotation.set(0, R() * 6.28, 0); d.scale.set(1, h, 1);
        if (flowerPts.length < 90 && R() < 0.3) flowerPts.push(new THREE.Vector3(x, H(x, z) + h + 0.03, z));
        return cl[2];
      }
      return null;
    });
  }
  // reeds along all shores (island + near banks)
  const reedPts = [];
  {
    const g = bladeGeo(0.05, 5, C('#9aa457'), C('#3e5a2a'), 0.25);
    meshes.reeds = instanced(g, patch(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 'reed', 0.35, { GUST: '', NOFLIP: '' }), Q.reeds, (d) => {
      for (let t = 0; t < 30; t++) {
        let x, z;
        if (R() < 0.45) { const u = (R() * 2 - 1) * irx * 1.4, v = (R() * 2 - 1) * irz * 1.4; x = u * ca - v * sa; z = zc0 + u * sa + v * ca; }
        else { x = (R() * 2 - 1) * 220; z = mz(x) + (R() < 0.5 ? -1 : 1) * (HW + (R() * 2 - 1) * 9); }
        const h = H(x, z); if (h > 0.25 || h < -0.45) continue;
        const clump = N.n2(x * 0.3, z * 0.3); if (clump < -0.15) continue;
        d.position.set(x, h - 0.05, z); d.rotation.set(0, R() * 6.28, 0); d.scale.set(1 + R(), 1.0 + R() * 1.1, 1);
        if (reedPts.length < 120 && R() < 0.2) reedPts.push(new THREE.Vector3(x, Math.max(h, 0) + 0.6, z));
        return white;
      }
      return null;
    });
  }
  // bank forest (instanced conifers + broadleaves)
  {
    const conA = new Acc(), decA = new Acc(), trunkC = C('#4a3a2a');
    conA.add(limbGeo(new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(0, 2.5, 0), 0.25, 0.18, 5, 1), () => trunkC, () => 0);
    for (let k = 0; k < 4; k++) {
      const cg = new THREE.ConeGeometry(2.3 - k * 0.45, 3.4 - k * 0.3, 7, 1); cg.translate(0, 3.2 + k * 1.9, 0);
      const cc = C(['#2c4a26', '#30522a', '#365a2c', '#3c6230'][k]);
      conA.add(cg, (v, n) => tmp.copy(cc).multiplyScalar(0.6 + 0.5 * Math.max(0, n.y)), (v) => v.y * 0.015);
    }
    decA.add(limbGeo(new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(0, 3, 0), 0.3, 0.2, 5, 1), () => trunkC, () => 0);
    for (let k = 0; k < 5; k++) {
      const c = new THREE.Vector3((R() - 0.5) * 2.6, 3.4 + R() * 2.6, (R() - 0.5) * 2.6), r = 1.9 + R() * 0.8, cc = C('#46702f');
      decA.add(blobGeo(N, c, r, 0.9, 0, 0.25), (v) => tmp.copy(cc).multiplyScalar(0.5 + 0.6 * sm(c.y - r, c.y + r, v.y)), (v) => v.y * 0.03);
    }
    const mat = patch(new THREE.MeshLambertMaterial({ vertexColors: true }), 'forest', 0.25);
    const tint = new THREE.Color();
    const placeF = (con) => (d) => {
      for (let t = 0; t < 40; t++) {
        const far = R() < Q.far / (Q.far + Q.forest);
        const x = (R() * 2 - 1) * (far ? 1050 : 430), side = R() < 0.5 ? -1 : 1;
        const bd = far ? 60 + R() * 900 : 10 + Math.pow(R(), 2.2) * 200;
        const z = mz(x) + side * (HW + bd);
        if (Math.abs(z) > 1150) continue;
        const h = H(x, z); if (h < 0.7) continue;
        if (N.fbm(x * 0.012, z * 0.012, 2) < -0.32) continue;
        const pc = sm(20, 160, bd) * 0.75 + 0.15;
        if ((R() < pc) !== con) continue;
        const s = (0.75 + R() * 0.7) * (far ? 1.35 : 1);
        d.position.set(x, h, z); d.rotation.set((R() - 0.5) * 0.08, R() * 6.28, (R() - 0.5) * 0.08); d.scale.set(s, s * (0.85 + R() * 0.4), s);
        return tint.setHSL(con ? 0.3 : 0.23 + R() * 0.06, 0.25 + R() * 0.2, 0.42 + R() * 0.12).multiplyScalar(2.1);
      }
      return null;
    };
    const total = Q.forest + Q.far;
    meshes.con = instanced(conA.build(), mat, Math.round(total * 0.55), placeF(true));
    meshes.dec = instanced(decA.build(), mat, Math.round(total * 0.45), placeF(false));
  }

  // ---------- sky, mist, rain, fireflies, dust ----------
  const sky = new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16), skyMaterial());
  sky.renderOrder = -10; sky.material.depthTest = false; sky.frustumCulled = false; group.add(sky);
  {
    const geos = [];
    for (let k = 0; k < 3; k++) { const g = new THREE.PlaneGeometry(2200, 2 * HW + 60, 1, 1); g.rotateX(-Math.PI / 2); g.translate(0, 0.25 + k * 0.45, 0); geos.push(g); }
    const acc = new Acc(); geos.forEach((g) => acc.add(g, () => white));
    meshes.mist = new THREE.Mesh(acc.build(), mistMaterial()); meshes.mist.renderOrder = 3; meshes.mist.frustumCulled = false; group.add(meshes.mist);
  }
  {
    const n = Q.rain, seeds = new Float32Array(n * 6), tips = new Float32Array(n * 2), pos = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) { const s = [R(), R(), R()]; seeds.set(s, i * 6); seeds.set(s, i * 6 + 3); tips[i * 2 + 1] = 1; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('seed', new THREE.BufferAttribute(seeds, 3)); g.setAttribute('tip', new THREE.BufferAttribute(tips, 1));
    meshes.rain = new THREE.LineSegments(g, rainMaterial()); meshes.rain.frustumCulled = false; meshes.rain.renderOrder = 5; group.add(meshes.rain);
  }
  {
    const n = Q.ff, pos = new Float32Array(n * 3), seeds = new Float32Array(n * 4);
    const pts = reedPts.concat(flowerPts);
    for (let i = 0; i < n; i++) {
      let p; const c = R() < 0.6 ? randIsland(1.0) : null;
      if (c) p = new THREE.Vector3(c[0], H(c[0], c[1]) + 0.3 + R() * 1.4, c[1]); else p = pts.length ? pts[Math.floor(R() * pts.length)].clone().add(new THREE.Vector3((R() - 0.5) * 3, R(), (R() - 0.5) * 3)) : new THREE.Vector3();
      pos.set([p.x, p.y, p.z], i * 3); seeds.set([R() + 0.3, R() + 0.3, R() + 0.3, R()], i * 4);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('seed', new THREE.BufferAttribute(seeds, 4));
    meshes.ff = new THREE.Points(g, pointsMaterial('ff')); meshes.ff.frustumCulled = false; meshes.ff.renderOrder = 6; group.add(meshes.ff);
  }
  {
    const n = Q.dust, pos = new Float32Array(n * 3), seeds = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) seeds.set([R(), R(), R(), R()], i * 4);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('seed', new THREE.BufferAttribute(seeds, 4));
    meshes.dust = new THREE.Points(g, pointsMaterial('dust')); meshes.dust.frustumCulled = false; meshes.dust.renderOrder = 6; group.add(meshes.dust);
  }

  // spawn point on east side of the island looking west along the river
  let spawn = null;
  for (let t = 0; t < 400; t++) {
    const c = randIsland(0.72, 5);
    if (c && (!spawn || c[0] > spawn[0]) && trunks.every(([x, z]) => Math.hypot(x - c[0], z - c[1]) > 6)) spawn = c;
  }
  if (!spawn) spawn = [0, zc0];

  return { group, meshes, horizonEl, mh, H, islandE, mz, HW, zc0, irx, irz, trunks, flowerPts, reedPts, spawn, onIsland };
}

export function disposeGroup(g) {
  g.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
  });
}
export { lerp, sm };
