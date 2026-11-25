import * as THREE from 'three';
import { makeNoise, rng } from './noise.js';
import { makeFoliageAtlas, CardAcc, cardAxes, TILE } from './foliage.js';
import { U, patch, waterMaterial, rainMaterial, pointsMaterial, mistMaterial, skyMaterial } from './shaders.js';

const C = (h) => new THREE.Color(h);
const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

// ---------- geometry accumulator (non-indexed position/normal/color/sway) ----------
export class Acc {
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

export function limbGeo(p0, p1, r0, r1, segs = 6, hseg = 2) {
  const dir = new THREE.Vector3().subVectors(p1, p0), len = dir.length();
  const g = new THREE.CylinderGeometry(r1, r0, len, segs, hseg, true);
  g.translate(0, len / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
  g.translate(p0.x, p0.y, p0.z);
  return g;
}

// Displaced icosahedron blob with soft radial normals
export function blobGeo(N, c, r, sy, detail = 1, rough = 0.28) {
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

const atlasCache = {};
function foliageMats(Q) {
  const size = Q.atlas;
  if (!atlasCache[size]) atlasCache[size] = makeFoliageAtlas(size);
  const map = atlasCache[size];
  const mk = (key, amp) => {
    const m = patch(new THREE.MeshLambertMaterial({ vertexColors: true, map, alphaTest: 0.5, side: THREE.DoubleSide, alphaToCoverage: !!Q.bloom }), key, amp, { NOFLIP: '', FOLI: '' });
    return m;
  };
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: 0.5, side: THREE.DoubleSide });
  return { mk, depth };
}
export function buildWorld(seed, Q) {
  const R = rng(seed), N = makeNoise(seed), group = new THREE.Group();
  const meshes = {};
  // ---------- river & island shape ----------
  // river: straight calm reach at the island, then big bends up- and downstream (S-curve)
  const SG = R() < 0.5 ? -1 : 1, PH = R() * 6.28, WG = 4 + R() * 3, HW = 40;
  const mz = (x) => { const s = Math.sign(x), ax = Math.abs(x); return SG * s * (125 * sm(110, 430, ax) - 85 * sm(620, 1050, ax)) + WG * Math.sin(x * 0.019 + PH); };
  const mzc = (x) => mz(x + 25) - 2 * mz(x) + mz(x - 25); // curvature sign: river bends toward +z if > 0
  U.uRiver.value.set(SG, PH, WG, HW);
  const zc0 = mz(0), irx = 19 + R() * 5, irz = 12 + R() * 3, ia = (R() - 0.5) * 0.5, ca = Math.cos(ia), sa = Math.sin(ia);
  function islandE(x, z) {
    const u = x * ca + (z - zc0) * sa, v = -x * sa + (z - zc0) * ca;
    return Math.hypot(u / irx, v / irz) + 0.13 * N.n2(x * 0.055 + 11, z * 0.055) + 0.05 * N.n2(x * 0.19, z * 0.19);
  }
  // cliff on the outer bank of the downstream bend, facing the island
  const cliffSide = -SG, cliffX = 165 + R() * 30, cliffL = 100, cxa = cliffX - cliffL / 2, cxb = cliffX + cliffL / 2;
  // sand bar on the inner (opposite) bank, a little downstream of the island
  const sbX = 70 + R() * 25, sbSide = SG, sbL = 30 + R() * 10, sbW = 8 + R() * 3;
  const cliffFall = (x) => sm(cxa, cxa + 20, x) * (1 - sm(cxb - 20, cxb, x));
  const cliffTop = (x) => 0.6 + (4.8 + 1.6 * N.n2(x * 0.05, 3.3) + 0.4 * N.n2(x * 0.13, 1.7)) * cliffFall(x);
  const cliffOff = (x) => 3.4 + 1.4 * N.n2(x * 0.07, 5.5) + 0.35 * N.n2(x * 0.17, 2.1);
  const hwAt = (x) => HW + 6 * N.n2(x * 0.006, 7.7) + 2.5 * N.n2(x * 0.03, 1.1);
  const sbC = () => [sbX, mz(sbX) + sbSide * (hwAt(sbX) - sbW * 0.55)];
  function H(x, z) {
    const zc = mz(x), side = z >= zc ? 1 : -1;
    // ragged edge + coves (side-specific), beaches on the inner side of bends
    const cove = 6 * Math.pow(Math.max(0, N.n2(x * 0.016, side * 5.3 + 2)), 1.5);
    const d = Math.abs(z - zc) - 2.2 * N.n2(x * 0.05, z * 0.05) - 0.8 * N.n2(x * 0.17, z * 0.17) - cove;
    const hw = hwAt(x);
    const beach = 9 * sm(0.5, 6, mzc(x) * side * SG * SG);
    let h = -3.1 + 3.75 * sm(0.3 * hw, hw + 9 + beach, d);
    h += Math.max(0, d - hw - 9) * 0.045;
    h += sm(hw + 8, hw + 95, d) * (N.fbm(x * 0.006, z * 0.006, 4) * 0.5 + 0.5) * 24;
    h += N.n2(x * 0.05, z * 0.05) * 0.25 * sm(hw - 2, hw + 12, d);
    if (x > cxa && x < cxb && Math.sign(z - zc) === cliffSide) {
      const f = cliffFall(x);
      if (f > 0) {
        const d0 = hw + cliffOff(x), wd = 0.6 + (1 - f) * 3.5, T = cliffTop(x);
        const talus = 0.35 * sm(hw - 0.5, d0 - wd, d) * (1 - sm(d0 - wd, d0, d));
        const target = Math.max(h, 0.15 + talus) + (T + Math.max(0, d - d0 - wd) * 0.015 - Math.max(h, 0.15 + talus)) * sm(d0 - wd, d0 + wd, d);
        h = Math.max(h, h + (target - h) * f * sm(hw - 1.5, hw - 0.3, d));
      }
    }
    // sand bar
    {
      const [cx, cz] = sbC(), dx = (x - cx) / sbL, dz = (z - cz) / sbW;
      const e2 = dx * dx + dz * dz + 0.15 * N.n2(x * 0.08, z * 0.08);
      if (e2 < 3) h = Math.max(h, 0.26 - 0.58 * e2 + 0.04 * N.n2(x * 0.3, z * 0.3));
    }
    const e = islandE(x, z);
    if (e < 1.6) {
      const core = 0.42 + 2.4 * Math.max(0, 1 - e * e) * (0.75 + 0.25 * N.n2(x * 0.07, z * 0.07)) + 0.35 * N.fbm(x * 0.08, z * 0.08, 2) * Math.max(0, 1 - e);
      const s = sm(0.82, 1.32, e);
      h = Math.max(h, core * (1 - s) - 3.1 * s);
    }
    return h;
  }
  const bankDist = (x, z) => Math.abs(z - mz(x)) - hwAt(x);

  // ---------- terrain ----------
  const TS = 1200, seg = Q.terr, a = 0.09;
  const map = (u) => TS * (a * u + (1 - a) * u * u * u);
  // across the river: uniform ~0.9-1.4 m spacing within 75 m of the river axis, coarse beyond
  const ZB = 75, VB = 0.72, AZ = (ZB / VB) * (1 - VB) / (TS - ZB);
  const mapZ = (v) => { const s = Math.sign(v), av = Math.abs(v); if (av <= VB) return ZB * v / VB; const t = (av - VB) / (1 - VB); return s * (ZB + (TS - ZB) * (AZ * t + (1 - AZ) * t * t * t)); };
  const shiftZ = (v) => { const av = Math.abs(v); return av <= VB ? 1 : 1 - (av - VB) / (1 - VB); };
  const tg = new THREE.PlaneGeometry(2, 2, seg, seg); tg.rotateX(-Math.PI / 2);
  const tp = tg.attributes.position, cols = new Float32Array(tp.count * 3);
  const cSand = C('#b7a27a'), cWet = C('#6e6146'), cBed = C('#4d4a35'), cBedDeep = C('#2f3a2b'), cGrass = C('#5f8f3a'), cGrass2 = C('#86a043'), cGrass3 = C('#4a7a30'), cDirt = C('#735f42'), cForest = C('#2f4a24'), cMoss = C('#3e5e2c');
  const tmp = new THREE.Color();
  const terrainColor = (x, z, h) => {
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
    return tmp;
  };
  const inCliffPatch = (x, z) => { if (x < cxa + 10 || x > cxb - 10) return false; const zc = mz(x), dd = (z - zc) * cliffSide, hw = hwAt(x); return dd > hw - 3 && dd < hw + 18; };
  for (let i = 0; i < tp.count; i++) {
    const x = map(tp.getX(i)), z = mapZ(tp.getZ(i)) + mz(x) * shiftZ(tp.getZ(i));
    const h = H(x, z); tp.setXYZ(i, x, h - (inCliffPatch(x, z) ? 1.5 : 0), z);
    terrainColor(x, z, h).toArray(cols, i * 3);
  }
  tg.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  tg.setAttribute('sway', new THREE.BufferAttribute(new Float32Array(tp.count), 1));
  tg.computeVertexNormals();
  const terrainMat = patch(new THREE.MeshLambertMaterial({ vertexColors: true }), 'terrain', 0, { DETAIL: '' });
  const terrain = new THREE.Mesh(tg, terrainMat);
  terrain.receiveShadow = true; group.add(terrain);
  // fine-grid patch for the cliff bank (0.6 m), main terrain is tucked below it
  {
    const step = 0.6, x0 = cxa - 5, x1 = cxb + 5, nx = Math.ceil((x1 - x0) / step), nzr = Math.ceil(28 / step), A = nx + 1, pos = [], col = [], idx = [];
    for (let j = 0; j <= nzr; j++) for (let i = 0; i <= nx; i++) {
      const x = x0 + i * step, dd = hwAt(x) - 6 + j * step, z = mz(x) + cliffSide * dd, h = H(x, z);
      pos.push(x, h, z); const c = terrainColor(x, z, h); col.push(c.r, c.g, c.b);
    }
    for (let j = 0; j < nzr; j++) for (let i = 0; i < nx; i++) {
      const a0 = j * A + i;
      if (cliffSide > 0) idx.push(a0, a0 + A, a0 + 1, a0 + 1, a0 + A, a0 + A + 1); else idx.push(a0, a0 + 1, a0 + A, a0 + 1, a0 + A + 1, a0 + A);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('sway', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3), 1));
    g.setIndex(idx); g.computeVertexNormals();
    const m = new THREE.Mesh(g, terrainMat); m.receiveShadow = true; group.add(m);
  }

  // ---------- mountains: polar height grid, eroded to natural slopes ----------
  const r0 = 1180, r1 = 5600, GA = 512, GR = 56, LR = Math.log(r1 / r0);
  const thE = Math.atan2(mz(1250), 1250), thW = Math.atan2(mz(-1250), -1250);
  const grid = new Float32Array((GA + 1) * (GR + 1));
  {
    const raw = (r, th) => {
      const c = Math.cos(th), s = Math.sin(th), px = c * r, pz = s * r;
      const wx = px + 450 * N.n2(px * 0.00035 + 11, pz * 0.00035), wz = pz + 450 * N.n2(px * 0.00035, pz * 0.00035 + 17);
      const da = (a, b) => { let q = a - b; q = Math.atan2(Math.sin(q), Math.cos(q)); return q; };
      const valley = (Math.exp(-Math.pow(da(th, thE), 2) * 22) + Math.exp(-Math.pow(da(th, thW), 2) * 22)) * (1 - sm(2400, 3400, r));
      // forested foothills
      const foot = sm(r0 + 80, 1800, r) * (1 - sm(2400, 3600, r) * 0.6) * (110 + 190 * (N.fbm(wx * 0.0011, wz * 0.0011, 3) * 0.5 + 0.5));
      // main range: broad massifs carved by ridges
      const mass = sm(1900, 3300, r) * (1 - sm(5000, r1, r) * 0.45);
      const broad = N.fbm(wx * 0.00026 + 5, wz * 0.00026, 3) * 0.5 + 0.5;
      const ridge = N.ridged(wx * 0.00048 + 3, wz * 0.00048, 4);
      const main = mass * (260 + 980 * broad * broad) * (0.5 + 0.5 * ridge);
      const base = -25 + 55 * sm(r0, r0 + 350, r);
      return base + (foot + main) * (1 - 0.55 * valley);
    };
    for (let j = 0; j <= GR; j++) { const r = r0 * Math.exp(LR * j / GR); for (let i = 0; i <= GA; i++) grid[j * (GA + 1) + i] = raw(r, i / GA * Math.PI * 2); }
    const at = (i, j) => j * (GA + 1) + ((i % GA) + GA) % GA;
    // thermal erosion: no slope steeper than ~36 degrees, plus light smoothing
    const maxT = 0.72;
    for (let it = 0; it < 24; it++) {
      for (let j = 0; j <= GR; j++) {
        const r = r0 * Math.exp(LR * j / GR), da = r * Math.PI * 2 / GA, dr = r * (Math.exp(LR / GR) - 1);
        for (let i = 0; i < GA; i++) {
          const k = at(i, j);
          const nb = [[at(i + 1, j), da], [at(i - 1, j), da]]; if (j < GR) nb.push([at(i, j + 1), dr]); if (j > 0) nb.push([at(i, j - 1), dr * 0.97]);
          for (const [m, dd] of nb) { const ex = grid[k] - grid[m] - maxT * dd; if (ex > 0) { grid[k] -= ex * 0.45; grid[m] += ex * 0.45; } }
        }
      }
    }
    for (let it = 0; it < 2; it++) {
      const cp = grid.slice();
      for (let j = 1; j < GR; j++) for (let i = 0; i < GA; i++) {
        const k = at(i, j); grid[k] = cp[k] * 0.5 + (cp[at(i + 1, j)] + cp[at(i - 1, j)] + cp[at(i, j + 1)] + cp[at(i, j - 1)]) * 0.125;
      }
    }
    for (let j = 0; j <= GR; j++) grid[j * (GA + 1) + GA] = grid[j * (GA + 1)];
  }
  const mh = (r, th) => {
    const fj = Math.max(0, Math.min(GR - 1e-6, Math.log(Math.max(r, r0) / r0) / LR * GR)), fi = ((th / (Math.PI * 2)) % 1 + 1) % 1 * GA;
    const j = Math.floor(fj), i = Math.floor(fi), tj = fj - j, ti = fi - i, A = GA + 1;
    const a0 = grid[j * A + i], a1 = grid[j * A + i + 1], b0 = grid[(j + 1) * A + i], b1 = grid[(j + 1) * A + i + 1];
    return (a0 * (1 - ti) + a1 * ti) * (1 - tj) + (b0 * (1 - ti) + b1 * ti) * tj;
  };
  {
    const step = Q.mtn >= 400 ? 1 : 2, AS = GA / step, RS = GR, pos = [], col = [], idx = [];
    const cFor = C('#2f4a26'), cFor2 = C('#3a5a2c'), cRock = C('#6e6a63'), cRock2 = C('#5c554c'), cScree = C('#7d776c');
    for (let j = 0; j <= RS; j++) {
      const r = r0 * Math.exp(LR * j / RS);
      for (let i = 0; i <= AS; i++) {
        const th = i / AS * Math.PI * 2, y = grid[j * (GA + 1) + i * step];
        pos.push(Math.cos(th) * r, y, Math.sin(th) * r);
        const nn = N.n2(th * 45, r * 0.004), n2 = N.n2(th * 140, r * 0.012);
        tmp.copy(nn > 0 ? cFor : cFor2);
        tmp.lerp(n2 > 0 ? cRock : cRock2, sm(260, 480, y + nn * 120));
        tmp.lerp(cScree, sm(0.2, 0.9, n2) * sm(300, 600, y) * 0.5);
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
  const HZN = 720, horizon = new Float32Array(HZN), mtnHz = new Float32Array(HZN);
  {
    const eye = 2, cx = 0, cz = zc0;
    for (let i = 0; i < HZN; i++) {
      const az = i / HZN * Math.PI * 2, dx = Math.cos(az), dz = Math.sin(az);
      let best = -0.2, bm = -0.2;
      for (let d = 25; d < 5400; d *= 1.045) {
        const x = cx + dx * d, z = cz + dz * d, r = Math.hypot(x, z);
        let h = Math.abs(x) < 1200 && Math.abs(z) < 1200 ? H(x, z) : -50;
        if (r > r0) { const m = mh(r, Math.atan2(z, x)); h = Math.max(h, m); if (r > r0 + 200) bm = Math.max(bm, Math.atan2(m - eye, d)); }
        best = Math.max(best, Math.atan2(h - eye, d));
      }
      horizon[i] = best; mtnHz[i] = bm;
    }
  }
  {
    const d = new Uint8Array(HZN * 4);
    const enc = (e) => Math.max(0, Math.min(255, Math.round((e + 0.05) / 0.4 * 255)));
    for (let i = 0; i < HZN; i++) { d[i * 4] = d[i * 4 + 1] = enc(horizon[i]); d[i * 4 + 2] = enc(mtnHz[i]); d[i * 4 + 3] = 255; }
    const t = new THREE.DataTexture(d, HZN, 1, THREE.RGBAFormat); t.wrapS = THREE.RepeatWrapping; t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
    if (U.tHzn.value) U.tHzn.value.dispose(); U.tHzn.value = t;
  }
  const horizonMtn = (az) => {
    const f = ((az / (Math.PI * 2)) % 1 + 1) % 1 * HZN, i = Math.floor(f) % HZN, t = f - Math.floor(f);
    return mtnHz[i] * (1 - t) + mtnHz[(i + 1) % HZN] * t;
  };
  const horizonEl = (az) => {
    const f = ((az / (Math.PI * 2)) % 1 + 1) % 1 * HZN, i = Math.floor(f) % HZN, t = f - Math.floor(f);
    return horizon[i] * (1 - t) + horizon[(i + 1) % HZN] * t;
  };

  // ---------- water + depth texture ----------
  {
    const W = 768, Hh = 384, box = U.uDepthBox.value.set(-480, -240, 960, 480), d = new Uint8Array(W * Hh * 4);
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
  const FM = foliageMats(Q), cardAcc = new CardAcc(), bushCards = new CardAcc();
  const tint = (k = 1) => new THREE.Color(1, 1, 0.92).multiplyScalar((0.85 + R() * 0.3) * k);
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
    const clusters = [];
    function leaves(c, r) { clusters.push([kind === 'willow' ? c.clone().add(new THREE.Vector3(0, -r * 0.35, 0)) : c.clone(), r]); }
    function crown() {
      if (!clusters.length) return;
      const cc = new THREE.Vector3(); clusters.forEach(([p]) => cc.add(p)); cc.multiplyScalar(1 / clusters.length);
      const tile = kind === 'birch' ? TILE.birch : kind === 'willow' ? TILE.willow : TILE.oak;
      const sw = (y) => 0.25 + 0.75 * Math.max(0, (y - g0) / height);
      const total = Q.cards, inner = Math.round(total * 0.4);
      for (let k = 0; k < total; k++) {
        const [p0, r] = clusters[k % clusters.length], isIn = k < inner;
        const out = p0.clone().sub(cc).add(new THREE.Vector3(R() - 0.5, (R() - 0.4) * 0.8, R() - 0.5)).normalize();
        const p = p0.clone().addScaledVector(out, r * (isIn ? 0.1 + R() * 0.3 : 0.35 + R() * 0.45)).add(new THREE.Vector3((R() - 0.5) * r * 0.5, (R() - 0.5) * r * 0.5, (R() - 0.5) * r * 0.5));
        const size = r * (isIn ? 0.55 + R() * 0.22 : 0.6 + R() * 0.3);
        const mode = !isIn && kind === 'willow' && R() < 0.55 ? 'hang' : 'out';
        if (mode === 'hang') p.y -= r * 0.45;
        const [ax, ay] = cardAxes(R, size, out, mode);
        const t = isIn ? tint(0.62 + R() * 0.12) : tint(p.y > cc.y ? 1.05 : 0.88);
        cardAcc.card(p, ax, ay, isIn ? TILE.core : mode === 'hang' ? TILE.willow : tile, cc, t, sw(p.y - size), sw(p.y + size), R() < 0.5);
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
    crown();
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
      const bc = new THREE.Vector3(x, g0 + sz * 0.55, z);
      const nb = Q.bushCards + k, nin = Math.round(nb * 0.4);
      for (let j = 0; j < nb; j++) {
        const isIn = j < nin, out = new THREE.Vector3(R() - 0.5, R() * 0.6, R() - 0.5).normalize();
        const p = bc.clone().addScaledVector(out, sz * (isIn ? 0.05 + R() * 0.25 : 0.3 + R() * 0.4)), size = sz * (isIn ? 0.55 + R() * 0.2 : 0.6 + R() * 0.3);
        const [ax, ay] = cardAxes(R, size, out, 'out');
        bushCards.card(p, ax, ay, isIn ? TILE.core : TILE.bush, bc, isIn ? tint(0.65) : tint(p.y > bc.y ? 1 : 0.82), Math.max(0, p.y - size - g0) * 0.25, (p.y + size - g0) * 0.25, R() < 0.5);
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
  // boulders inside the island and scattered stones
  {
    const cB = C('#8a857c'), cB2 = C('#726c63'), cM = C('#5a7438');
    const boulder = (x, z, r) => {
      const g0 = H(x, z), cc = new THREE.Vector3(x, g0 + r * 0.12, z), base = R() < 0.5 ? cB : cB2;
      rockAcc.add(blobGeo(N, cc, r, 0.68, 2, 0.22), (v, n) => tmp.copy(base).lerp(cM, sm(0.4, 0.85, n.y) * 0.75).multiplyScalar(0.72 + 0.3 * N.n2(v.x * 3.5, v.z * 3.5 + v.y)), () => 0);
      trunks.push([x, z, r * 0.95]);
    };
    const nBo = 4 + Math.floor(R() * 4);
    for (let i = 0, made = 0; i < 60 && made < nBo; i++) {
      const c = randIsland(0.75); if (!c) continue;
      if (trunks.some(([tx, tz]) => Math.hypot(tx - c[0], tz - c[1]) < 3.2)) continue;
      const r = 0.6 + R() * 0.9; boulder(c[0], c[1], r); made++;
      const extra = R() < 0.45 ? 1 + Math.floor(R() * 2) : 0;
      for (let k = 0; k < extra; k++) { const a = R() * 6.28, dd = r + 0.4 + R() * 0.6, x = c[0] + Math.cos(a) * dd, z = c[1] + Math.sin(a) * dd; if (onIsland(x, z)) boulder(x, z, 0.3 + R() * 0.4); }
    }
    for (let i = 0; i < 55; i++) {
      const c = randIsland(1.05, 30); if (!c) continue;
      const r = 0.06 + R() * 0.14, cc = new THREE.Vector3(c[0], H(c[0], c[1]) + r * 0.2, c[1]);
      rockAcc.add(blobGeo(N, cc, r, 0.6, 0, 0.25), () => tmp.copy(cB2).multiplyScalar(0.75 + R() * 0.4), () => 0);
    }
  }
  // driftwood on the sand bar and a fallen tree reaching into the river upstream
  {
    const cDw = C('#a59b8a'), cDw2 = C('#5d5246');
    const [sx, sz] = sbC();
    for (let k = 0; k < 4; k++) {
      const x = sx + (R() - 0.5) * sbL * 1.1, z = sz + (R() - 0.5) * sbW * 0.8, h = H(x, z); if (h < -0.1) continue;
      const a = R() * 6.28, L = 1.6 + R() * 2.4, r = 0.08 + R() * 0.1;
      const p0 = new THREE.Vector3(x - Math.cos(a) * L / 2, h + r * 0.7, z - Math.sin(a) * L / 2), p1 = new THREE.Vector3(x + Math.cos(a) * L / 2, h + r * 0.6, z + Math.sin(a) * L / 2);
      trunkAcc.add(limbGeo(p0, p1, r, r * 0.7, 6, 2), (v) => tmp.copy(cDw).multiplyScalar(0.8 + 0.25 * N.n2(v.x * 4, v.z * 4)), () => 0);
      if (R() < 0.6) { const m = p0.clone().lerp(p1, 0.35 + R() * 0.3); trunkAcc.add(limbGeo(m, m.clone().add(new THREE.Vector3((R() - 0.5) * 0.9, 0.2 + R() * 0.4, (R() - 0.5) * 0.9)), r * 0.45, r * 0.2, 4, 1), () => cDw, () => 0); }
    }
    const fx = -60 - R() * 40, fside = -SG, zc = mz(fx), hw = hwAt(fx);
    const base = new THREE.Vector3(fx - 2, 0, zc + fside * (hw + 5)); base.y = H(base.x, base.z) + 0.2;
    const tip = new THREE.Vector3(fx + 5, -0.45, zc + fside * (hw - 7));
    trunkAcc.add(limbGeo(base, tip, 0.32, 0.13, 7, 4), (v) => tmp.copy(cDw2).multiplyScalar(0.8 + 0.3 * N.n2(v.x * 3, v.y * 3)), () => 0);
    for (let k = 0; k < 5; k++) {
      const m = base.clone().lerp(tip, 0.3 + k * 0.13), dir = new THREE.Vector3((R() - 0.5) * 1.4, 0.4 + R() * 0.8, (R() - 0.5) * 1.4).normalize();
      trunkAcc.add(limbGeo(m, m.clone().addScaledVector(dir, 0.8 + R() * 1.4), 0.08, 0.025, 4, 1), () => cDw2, () => 0);
    }
    trunks.push([base.x, base.z, 0.8]);
    // root plate at the base
    trunkAcc.add(blobGeo(N, base.clone().add(new THREE.Vector3(-0.5, 0.3, fside * 0.6)), 0.9, 0.8, 1, 0.45), () => tmp.copy(cDw2).multiplyScalar(0.75), () => 0);
  }
  // fallen stones at the foot of the cliff
  {
    const cR = C('#7a7266');
    for (let k = 0; k < 16; k++) {
      const x = cxa + 12 + R() * (cliffL - 24); if (cliffFall(x) < 0.6) continue;
      const r = 0.2 + R() * 0.6, dd = hwAt(x) + cliffOff(x) - 2.2 + R() * 1.4, z = mz(x) + cliffSide * dd, cc = new THREE.Vector3(x, H(x, z) + r * 0.15, z);
      rockAcc.add(blobGeo(N, cc, r, 0.7, 1, 0.25), (v, n) => tmp.copy(cR).multiplyScalar(0.7 + 0.35 * Math.max(0, n.y)), () => 0);
    }
  }
  const leafMat = patch(new THREE.MeshLambertMaterial({ vertexColors: true }), 'leaf', 0.32, { LEAF: '' });
  const barkMat = patch(new THREE.MeshLambertMaterial({ vertexColors: true }), 'bark', 0.32);
  const addAcc = (acc, mat, cast = true) => { if (!acc.p.length) return; const m = new THREE.Mesh(acc.build(), mat); m.castShadow = cast; m.receiveShadow = true; group.add(m); };
  addAcc(trunkAcc, barkMat); addAcc(leafAcc, leafMat); addAcc(bushAcc, leafMat); addAcc(rockAcc, barkMat);
  const folMat = FM.mk('foliage', 0.32), bushMat = FM.mk('bushfol', 0.32);
  for (const [acc, mat] of [[cardAcc, folMat], [bushCards, bushMat]]) {
    if (!acc.p.length) continue;
    const m = new THREE.Mesh(acc.build(), mat); m.castShadow = true; m.receiveShadow = true; m.customDepthMaterial = FM.depth; group.add(m);
  }

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
    const mat = patch(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 'grass', 0.55, { GUST: '', NOFLIP: '', HIDECAMP: '' });
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
    meshes.flowers = instanced(g, patch(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 'flower', 0.55, { NOFLIP: '', HIDECAMP: '' }), Q.flowers, (d) => {
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
  const reedPts = [], reedClusters = [];
  {
    // clump centres: island shoreline and both river banks
    for (let t = 0; t < 4000 && reedClusters.length < 26; t++) {
      const u = (R() * 2 - 1) * irx * 1.4, v = (R() * 2 - 1) * irz * 1.4, x = u * ca - v * sa, z = zc0 + u * sa + v * ca, h = H(x, z);
      if (h < 0.15 && h > -0.3) reedClusters.push([x, z, 1.2 + R() * 2.2]);
    }
    for (let t = 0; t < 6000 && reedClusters.length < 70; t++) {
      const x = (R() * 2 - 1) * 260, z = mz(x) + (R() < 0.5 ? -1 : 1) * (hwAt(x) + (R() * 2 - 1) * 9), h = H(x, z);
      if (h < 0.2 && h > -0.35) reedClusters.push([x, z, 1.5 + R() * 3.5]);
    }
    const g = bladeGeo(0.08, 5, C('#a2a85a'), C('#3e5a2a'), 0.25);
    meshes.reeds = instanced(g, patch(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 'reed', 0.35, { GUST: '', NOFLIP: '', HIDECAMP: '' }), Q.reeds, (d) => {
      for (let t = 0; t < 30; t++) {
        let x, z;
        if (reedClusters.length && R() < 0.7) {
          // dense clumps along the shores
          const c = reedClusters[Math.floor(R() * reedClusters.length)], rr = c[2] * Math.sqrt(-2 * Math.log(R() + 1e-6)) * 0.55, an = R() * 6.283;
          x = c[0] + Math.cos(an) * rr; z = c[1] + Math.sin(an) * rr;
          const h = H(x, z); if (h > 0.3 || h < -0.5) continue;
          d.position.set(x, h - 0.05, z); d.rotation.set((R() - 0.5) * 0.15, R() * 6.28, (R() - 0.5) * 0.15); d.scale.set(1 + R() * 0.8, 1.3 + R() * 1.3, 1);
          return white;
        }
        if (R() < 0.45) { const u = (R() * 2 - 1) * irx * 1.4, v = (R() * 2 - 1) * irz * 1.4; x = u * ca - v * sa; z = zc0 + u * sa + v * ca; }
        else { x = (R() * 2 - 1) * 300; z = mz(x) + (R() < 0.5 ? -1 : 1) * (hwAt(x) + (R() * 2 - 1) * 10); }
        const h = H(x, z); if (h > 0.25 || h < -0.45) continue;
        const clump = N.n2(x * 0.3, z * 0.3); if (clump < -0.15) continue;
        d.position.set(x, h - 0.05, z); d.rotation.set(0, R() * 6.28, 0); d.scale.set(1 + R(), 1.0 + R() * 1.1, 1);
        if (reedPts.length < 120 && R() < 0.2) reedPts.push(new THREE.Vector3(x, Math.max(h, 0) + 0.6, z));
        return white;
      }
      return null;
    });
  }
  // bank forest (instanced conifers + broadleaves; foliage cards; simpler geometry far away)
  {
    const trunkC = C('#4a3a2a'), V3 = THREE.Vector3;
    const conT = new Acc(), decT = new Acc();
    conT.add(limbGeo(new V3(0, -0.5, 0), new V3(0, 11.6, 0), 0.24, 0.025, 5, 3), () => trunkC, () => 0);
    for (let k = 0; k < 4; k++) { const a = k * 1.7 + 0.4, y = 0.9 + k * 0.35; conT.add(limbGeo(new V3(0, y, 0), new V3(Math.cos(a) * 0.7, y - 0.1, Math.sin(a) * 0.7), 0.035, 0.01, 3, 1), () => trunkC, () => 0); }
    decT.add(limbGeo(new V3(0, -0.5, 0), new V3(0, 4.2, 0), 0.3, 0.16, 5, 1), () => trunkC, () => 0);
    for (let k = 0; k < 3; k++) { const a = k * 2.1; decT.add(limbGeo(new V3(0, 3.6, 0), new V3(Math.cos(a) * 1.3, 5.6, Math.sin(a) * 1.3), 0.12, 0.05, 4, 1), () => trunkC, () => 0); }
    const conifer = (levels, per, bare, slim, dense) => {
      const acc = new CardAcc(), top = 11.2, y0 = bare;
      for (let l = 0; l < levels; l++) {
        const t = l / (levels - 1), y = y0 + t * (top - 0.7 - y0);
        const nPer = Math.max(3, Math.round(per * (1 - t * 0.45)));
        const baseLen = (3.0 * Math.pow(1 - t, 0.85) * slim + 0.35);
        for (let k = 0; k < nPer; k++) {
          const a = (k + R() * 0.6) / nPer * Math.PI * 2 + l * 0.9, len = baseLen * (0.75 + R() * 0.45);
          const droop = (0.45 - t * 0.75) * (0.8 + R() * 0.4);
          const dir = new V3(Math.cos(a), -droop, Math.sin(a)).normalize(), base = new V3(0, y, 0);
          const c = base.clone().addScaledVector(dir, len / 2 + 0.08), side = new V3(-dir.z, 0, dir.x).normalize(), up = new V3().crossVectors(side, dir).normalize();
          const roll = (R() < 0.5 ? -1 : 1) * (0.7 + R() * 0.45);
          const ay = side.multiplyScalar(Math.cos(roll)).addScaledVector(up, Math.sin(roll)).multiplyScalar(len * 0.4 * dense);
          acc.card(c, dir.clone().multiplyScalar(len / 2 + 0.08), ay, TILE.spruce, base, tint((0.8 + t * 0.35) * (0.9 + R() * 0.2)), y * 0.012, (y + 0.4) * 0.016);
        }
      }
      return acc.build();
    };
    const broad = (n, ry, spread) => {
      const acc = new CardAcc(), cc = new V3(0, 5.4 * ry, 0), nin = Math.round(n * 0.4);
      for (let k = 0; k < n; k++) {
        const isIn = k < nin, out = new V3(R() - 0.5, (R() - 0.3) * 0.8, R() - 0.5).normalize();
        const p = cc.clone().add(new V3(out.x * spread, out.y * ry, out.z * spread).multiplyScalar(isIn ? 0.4 + R() * 0.7 : 1.3 + R() * 1.0));
        const size = isIn ? 1.3 + R() * 0.4 : 1.4 + R() * 0.6;
        const [ax, ay] = cardAxes(R, size, out, 'out');
        acc.card(p, ax, ay, isIn ? TILE.core : TILE.oak, cc, isIn ? tint(0.62) : tint(p.y > cc.y ? 1.05 : 0.82), (p.y - size) * 0.03, (p.y + size) * 0.03, R() < 0.5);
      }
      return acc.build();
    };
    const conV = [[Q.spruceLv, Q.sprucePer, 1.4, 1.0, 1.0], [Q.spruceLv + 2, Q.sprucePer, 2.2, 0.85, 0.9], [Q.spruceLv - 2, Q.sprucePer + 1, 0.9, 1.15, 1.1], [Q.spruceLv, Q.sprucePer - 1, 2.8, 0.75, 0.85]]
      .slice(0, Q.variants).map((v) => conifer(...v));
    const decV = [[Q.forestCards, 1.0, 1.0], [Q.forestCards, 1.15, 0.85], [Q.forestCards, 0.9, 1.2]].slice(0, Math.max(2, Q.variants - 1)).map((v) => broad(...v));
    const conFar = conifer(10, 6, 1.6, 1.05, 1.25), decFar = broad(Math.round(Q.forestCards * 0.4), 1.0, 1.0);
    const fmat = FM.mk('forestfol', 0.25);
    const mat = patch(new THREE.MeshLambertMaterial({ vertexColors: true }), 'forest', 0.25);
    const ftint = new THREE.Color();
    const placeF = (con, far) => (d) => {
      for (let t = 0; t < 40; t++) {
        const x = (R() * 2 - 1) * (far ? 1050 : 430), side = R() < 0.5 ? -1 : 1;
        const bd = far ? 75 + R() * 900 : 6 + Math.pow(R(), 2.2) * 75;
        const z = mz(x) + side * (hwAt(x) + bd);
        if (Math.abs(z) > 1150) continue;
        const h = H(x, z); if (h < 0.7) continue;
        if (N.fbm(x * 0.012, z * 0.012, 2) < -0.32) continue;
        const pc = sm(20, 160, bd) * 0.75 + 0.15;
        if ((R() < pc) !== con) continue;
        const s = (0.75 + R() * 0.7) * (far ? 1.35 : 1);
        d.position.set(x, h, z); d.rotation.set((R() - 0.5) * 0.08, R() * 6.28, (R() - 0.5) * 0.08); d.scale.set(s, s * (0.85 + R() * 0.4), s);
        return ftint.setHSL(con ? 0.28 : 0.2 + R() * 0.06, 0.12 + R() * 0.12, 0.45 + R() * 0.1).multiplyScalar(2.1);
      }
      return null;
    };
    // same placement stream for trunk + foliage of each kind: place once, copy matrices
    const pair = (trunkGeo, folGeo, count, con, far) => {
      const tm = instanced(trunkGeo, mat, count, placeF(con, far));
      const fm = new THREE.InstancedMesh(folGeo, fmat, tm.count); fm.frustumCulled = false; fm.customDepthMaterial = FM.depth;
      const m4 = new THREE.Matrix4(), cl = new THREE.Color();
      for (let i = 0; i < tm.count; i++) { tm.getMatrixAt(i, m4); fm.setMatrixAt(i, m4); tm.getColorAt(i, cl); fm.setColorAt(i, cl); }
      fm.instanceMatrix.needsUpdate = true; if (fm.instanceColor) fm.instanceColor.needsUpdate = true; group.add(fm);
      return [tm, fm];
    };
    const ctB = conT.build(), dtB = decT.build();
    meshes.con = conV.map((g) => pair(ctB, g, Math.round(Q.forest * 0.55 / conV.length), true, false));
    meshes.dec = decV.map((g) => pair(dtB, g, Math.round(Q.forest * 0.45 / decV.length), false, false));
    meshes.conF = pair(ctB, conFar, Math.round(Q.far * 0.55), true, true);
    meshes.decF = pair(dtB, decFar, Math.round(Q.far * 0.45), false, true);
  }

  // ---------- water lilies in the calm water below the sand bar ----------
  {
    const [sx, sz] = sbC(), spots = [];
    for (let t = 0; t < 3000 && spots.length < 4; t++) {
      const x = sx + (R() - 0.2) * 90, z = sz + (R() - 0.5) * 50, h = H(x, z);
      if (h < -0.3 && h > -1.1 && spots.every(([a, b]) => Math.hypot(a - x, b - z) > 9)) spots.push([x, z]);
    }
    if (spots.length) {
      const pad = new THREE.CircleGeometry(1, 14, 0.25, Math.PI * 2 - 0.5); pad.rotateX(-Math.PI / 2);
      pad.setAttribute('sway', new THREE.Float32BufferAttribute(new Float32Array(pad.attributes.position.count), 1));
      pad.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pad.attributes.position.count * 3).fill(1), 3));
      const padMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true });
      const pads = [], tint = new THREE.Color();
      meshes.pads = instanced(pad, padMat, Q.lily, (d) => {
        for (let t = 0; t < 20; t++) {
          const s = spots[Math.floor(R() * spots.length)], x = s[0] + (R() - 0.5) * 9, z = s[1] + (R() - 0.5) * 7, h = H(x, z);
          if (h > -0.25 || h < -1.3 || pads.some(([a, b, r]) => Math.hypot(a - x, b - z) < r + 0.25)) continue;
          const r = 0.3 + R() * 0.32; pads.push([x, z, r]);
          d.position.set(x, 0.012, z); d.rotation.set(0, R() * 6.28, 0); d.scale.set(r, 1, r);
          return tint.setHSL(0.27 + (R() - 0.5) * 0.05, 0.55, 0.28 + R() * 0.08);
        }
        return null;
      });
      meshes.pads.renderOrder = 3;
      // flowers: petals close at night (uOpen)
      const pos = [], col = [], sw = [], nor = [];
      for (let ring = 0; ring < 2; ring++) for (let k = 0; k < 8; k++) {
        const a = (k + ring * 0.5) / 8 * 6.283, r = ring ? 0.075 : 0.1, w2 = 0.028, y0 = 0.01 + ring * 0.012;
        const cx = Math.cos(a), cz = Math.sin(a), px = -cz, pz = cx;
        pos.push(px * w2, y0, pz * w2, -px * w2, y0, -pz * w2, cx * r, y0 + 0.035, cz * r);
        for (let q = 0; q < 3; q++) { col.push(1, 1, 1); nor.push(0, 1, 0); } sw.push(0, 0, 1);
      }
      for (let k = 0; k < 6; k++) { const a = k / 6 * 6.283, b = (k + 1) / 6 * 6.283; pos.push(0, 0.03, 0, Math.cos(a) * 0.022, 0.028, Math.sin(a) * 0.022, Math.cos(b) * 0.022, 0.028, Math.sin(b) * 0.022); for (let q = 0; q < 3; q++) { col.push(1, 0.82, 0.2); nor.push(0, 1, 0); sw.push(0); } }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setAttribute('sway', new THREE.Float32BufferAttribute(sw, 1)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      const fMat = patch(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true }), 'lily', 0, { LILY: '', NOFLIP: '' });
      const pinks = [C('#ffffff'), C('#fff4f8'), C('#ffc7dc')];
      meshes.lilies = instanced(g, fMat, Math.ceil(Q.lily / 4), (d) => {
        if (!pads.length) return null; const p = pads[Math.floor(R() * pads.length)];
        d.position.set(p[0] + (R() - 0.5) * 0.1, 0.012, p[1] + (R() - 0.5) * 0.1); d.rotation.set(0, R() * 6.28, 0); const s = 1 + R() * 0.4; d.scale.set(s, s, s);
        return pinks[Math.floor(R() * pinks.length)].clone().multiplyScalar(1.15);
      });
      meshes.lilies.renderOrder = 3;
    }
  }

  // ---------- sky, mist, rain, fireflies, dust ----------
  const sky = new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16), skyMaterial());
  sky.renderOrder = -10; sky.material.depthTest = false; sky.frustumCulled = false; group.add(sky);
  {
    const geos = [];
    for (let k = 0; k < 3; k++) { const g = new THREE.PlaneGeometry(2200, 520, 1, 1); g.rotateX(-Math.PI / 2); g.translate(0, 0.25 + k * 0.45, 0); geos.push(g); }
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
    for (let i = 0; i < n; i++) {
      let p = null;
      for (let t = 0; t < 60 && !p; t++) {
        if (R() < 0.65) { const c = randIsland(0.8, 5); if (c && H(c[0], c[1]) > 0.35) p = new THREE.Vector3(c[0], H(c[0], c[1]) + 0.4 + R() * 1.2, c[1]); }
        else { const x = (R() * 2 - 1) * 160, z = mz(x) + (R() < 0.5 ? -1 : 1) * (hwAt(x) + 6 + R() * 20), h = H(x, z); if (h > 0.8) p = new THREE.Vector3(x, h + 0.4 + R() * 1.2, z); }
      }
      if (!p) p = new THREE.Vector3(0, -50, 0);
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

  return { group, meshes, sandbar: sbC(), hwAt, SG, N, cliff: { x: cliffX, side: cliffSide, top: cliffTop, off: cliffOff }, horizonEl, horizonMtn, mh, H, islandE, mz, HW, zc0, irx, irz, trunks, flowerPts, reedPts, spawn, onIsland };
}

export function disposeGroup(g) {
  g.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
  });
}
export { lerp, sm };
