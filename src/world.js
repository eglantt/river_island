import * as THREE from 'three';
import { makeNoise, rng } from './noise.js';
import { makeFoliageAtlas, CardAcc, cardAxes, TILE, makeBark, TexAcc, leafGeo } from './foliage.js';
import { growSkeleton, pipeRadii, skeletonTubes, tube, rootPath, samplePts } from './treegen.js';
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
    const m = patch(new THREE.MeshLambertMaterial({ vertexColors: true, map, alphaTest: 0.5, side: THREE.DoubleSide, alphaToCoverage: !!Q.bloom }), key, amp, { NOFLIP: '', FOLI: '', CARD: '' });
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
  const trunks = [], rockList = []; // collision circles; rocks (grass-free zones)
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

  // ---- island trees: textured bark with root flare and roots; individual leaves on twigs (or cards) ----
  const barkTex = { rough: makeBark('rough'), birch: makeBark('birch') };
  const barkAcc = { rough: new TexAcc(), birch: new TexAcc() };
  const leafInst = { oak: [], birch: [], willow: [] };
  const V3 = THREE.Vector3, _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _bx = new V3(), _by = new V3(), _bz = new V3();
  // species: trunk height, crown envelope, growth parameters
  const SPEC = {
    birch: { h: [9, 11.5], rBase: 0.2, trunkF: 0.9, wob: 0.05, step: 0.32, di: 1.7, dk: 0.45, nPts: 750, persist: 0.6, kink: 0.12, elbowP: 0.15, elbow: 0.3, maxKids: 3, rTip: 0.007, flare: 0.45, flareK: 0.45, irr: 0.06,
      env: (x, y, z, h) => { const dy = (y - h * 0.64) / (h * 0.33), rr = h * (0.17 + 0.05 * N.n2(x * 0.5 + 3, z * 0.5)); return y > h * 0.34 && (x * x + z * z) / (rr * rr) + dy * dy < 1; },
      trop: (n) => new V3(0, n.out < 1.0 ? 0.35 : 0.35 - 0.7 * Math.min(1, (n.out - 1.0) / 1.6), 0) },
    oak: { h: [8, 10], rBase: 0.36, trunkF: 0.3, wob: 0.1, step: 0.42, di: 2.5, dk: 0.65, nPts: 950, persist: 0.5, kink: 0.18, elbowP: 0.28, elbow: 0.5, maxKids: 3, rTip: 0.009, flare: 0.6, flareK: 0.75, irr: 0.13,
      env: (x, y, z, h) => { const dy = (y - h * 0.6) / (h * 0.36), rr = h * (0.44 + 0.08 * N.n2(x * 0.3 + 7, z * 0.3 + y * 0.3)); return y > h * 0.3 && (x * x + z * z) / (rr * rr) + dy * dy < 1; },
      trop: (n) => new V3(0, 0.1, 0) },
    willow: { h: [9.5, 11.5], rBase: 0.4, trunkF: 0.27, wob: 0.08, step: 0.42, di: 2.5, dk: 0.65, nPts: 850, persist: 0.55, kink: 0.15, elbowP: 0.2, elbow: 0.4, maxKids: 3, rTip: 0.009, flare: 0.65, flareK: 0.8, irr: 0.15,
      env: (x, y, z, h) => { const dy = (y - h * 0.52) / (h * 0.48), rr = h * (0.47 + 0.05 * N.n2(x * 0.3 + 1, z * 0.3)); return y > h * 0.33 && (x * x + z * z) / (rr * rr) + dy * dy < 1; },
      trop: (n) => new V3(0, n.out < 2.5 ? 0.45 : 0.08, 0) },
    dead: { h: [7, 9], rBase: 0.32, trunkF: 0.38, wob: 0.16, step: 0.4, di: 3.0, dk: 0.75, nPts: 320, persist: 0.45, kink: 0.24, elbowP: 0.38, elbow: 0.7, maxKids: 3, rTip: 0.012, flare: 0.6, flareK: 0.8, irr: 0.2, env: null,
      trop: (n) => new V3(0, 0.22, 0) },
  };
  const deadTint = new THREE.Color(1.32, 1.3, 1.26);
  // grow a skeleton for a species at local origin (base), returns {nodes, height}
  function skeleton(kind, base, lean) {
    const S = SPEC[kind], height = S.h[0] + R() * (S.h[1] - S.h[0]);
    const trunk = []; let p = base.clone(), d = lean.clone();
    const tl = height * S.trunkF * (kind === 'willow' || kind === 'oak' ? 0.85 + R() * 0.3 : 1), ns = Math.max(3, Math.round(tl / 0.4));
    for (let i = 0; i <= ns; i++) {
      trunk.push(p.clone());
      d.add(new V3((R() - 0.5) * S.wob * 2, 0, (R() - 0.5) * S.wob * 2)); d.lerp(lean, 0.25).normalize();
      p.addScaledVector(d, tl / ns);
    }
    let env = S.env;
    if (!env) { // dead tree: union of a few lopsided blobs
      const blobs = Array.from({ length: 4 }, () => { const a = R() * 6.28, rr = height * (0.12 + R() * 0.25); return [Math.cos(a) * height * (0.1 + R() * 0.3), height * (0.5 + R() * 0.4), Math.sin(a) * height * (0.1 + R() * 0.3), height * (0.18 + R() * 0.12)]; });
      env = (x, y, z) => y > height * 0.35 && blobs.some(([bx, by, bz, br]) => (x - bx) ** 2 + (y - by) ** 2 + (z - bz) ** 2 < br * br);
    }
    const ext = height * 0.75, ox = base.x + lean.x * height * 0.4, oz = base.z + lean.z * height * 0.4;
    const pts = samplePts(R, S.nPts, [-ext, 0, -ext, ext, height, ext], (x, y, z) => env(x, y, z, height)).map((q) => q.add(new V3(ox, base.y, oz)));
    const nodes = growSkeleton({ R, trunk, pts, step: S.step, di: S.di, dk: S.dk, maxIter: 220, maxNodes: 4500, persist: S.persist, kink: S.kink, elbowP: S.elbowP, elbow: S.elbow, maxKids: S.maxKids, trop: S.trop });
    return { nodes, height, S };
  }
  const barkNoise = (a, b) => N.n2(a, b);
  function emitBark(nodes, S, bt, colorFn, swayT, seed) {
    const emit = (g, nd) => barkAcc[bt].add(g, colorFn(nd), swayT, 1, 1); emit.count = 0;
    skeletonTubes(nodes, { noise: barkNoise, irr: S.irr, seed, flare: S.flare, flareK: S.flareK, twist: 0.12, uvScale: 0.6 }, emit);
  }
  function addRoots(base, S, bt, colorFn, n, swayT) {
    for (let k = 0; k < n; k++) {
      const [P, Rr] = rootPath(R, H, base.clone().add(new V3(0, 0.3, 0)), k / n * 6.28 + R() * 0.6, S.rBase * (0.38 + R() * 0.15), 1.2 + R() * 1.3);
      const g = tube(P, Rr, { noise: barkNoise, irr: 0.12, seed: k * 5.1 + base.x, uvScale: 0.6 });
      barkAcc[bt].add(g, colorFn(null), () => 0, 1, 1);
    }
  }
  // break off a few limbs: cut subtrees and leave a jagged stub
  function breakLimbs(nodes, count) {
    for (let c = 0, t = 0; c < count && t < 200; t++) {
      const i = 1 + Math.floor(R() * (nodes.length - 1)), nd = nodes[i];
      if (nd.trunk || !nd.kids.length || nd.out < 0.6) continue;
      nd.kids = []; nd.broken = true; c++;
    }
  }
  function tree(x, z, kind) {
    const g0 = H(x, z), base = new V3(x, g0 - 0.3, z);
    const la = R() * Math.PI * 2, lt = kind === 'willow' ? 0.12 + R() * 0.12 : kind === 'dead' ? 0.1 + R() * 0.15 : 0.05 * R();
    const lean = new V3(Math.sin(lt) * Math.cos(la), Math.cos(lt), Math.sin(lt) * Math.sin(la)).normalize();
    const { nodes, height, S } = skeleton(kind, base, lean);
    if (kind === 'dead') breakLimbs(nodes, 4 + Math.floor(R() * 3));
    pipeRadii(nodes, S.rTip, S.rBase);
    nodes.forEach((nd) => { if (nd.broken) nd.r = nodes[nd.parent].r * 0.85; });
    trunks.push([x, z, S.rBase + 0.25, kind, height]);
    const bt = kind === 'birch' ? 'birch' : 'rough';
    const tintB = kind === 'willow' ? C('#d2c6b0') : kind === 'oak' ? C('#cdbca4') : kind === 'dead' ? deadTint : C('#ffffff');
    const swayT = (v) => Math.max(0, (v.y - g0) / height) ** 2 * (kind === 'dead' ? 0.1 : 0.3);
    const twigBirch = C('#7a6252');
    const colorFn = (nd) => (v, n) => {
      tmp.copy(tintB).multiplyScalar(0.8 + 0.25 * sm(g0, g0 + 1.5, v.y));
      if (kind === 'birch') {
        tmp.multiplyScalar(1 - 0.65 * sm(g0 + 0.9, g0 + 0.1, v.y));
        if (nd && nd.r < 0.045) tmp.lerp(twigBirch, sm(0.045, 0.015, nd.r) * 0.85);
      } else if (kind === 'dead') tmp.multiplyScalar(0.85 + 0.25 * sm(-0.3, 0.8, n.y));
      else tmp.lerp(C('#56703a'), sm(g0 + 1.2, g0, v.y) * sm(0.1, -0.6, n.z) * 0.55);
      return tmp;
    };
    emitBark(nodes, S, bt, colorFn, swayT, x * 0.37 + z);
    addRoots(base, S, bt, colorFn, kind === 'birch' ? 3 : 5 + Math.floor(R() * 3), swayT);
    if (kind === 'dead') return;
    // leaf-bearing nodes: near the tips
    const zone = kind === 'birch' ? 1.5 : kind === 'oak' ? 1.3 : 2.2;
    const lnodes = nodes.filter((nd) => !nd.trunk && nd.tip < zone);
    if (!lnodes.length) return;
    const cc = new V3(); lnodes.forEach((nd) => cc.add(nd.p)); cc.multiplyScalar(1 / lnodes.length);
    let crad = 0; lnodes.forEach((nd) => { crad = Math.max(crad, nd.p.distanceTo(cc)); }); crad += 0.6;
    const sw = (y) => 0.25 + 0.75 * Math.max(0, (y - g0) / height);
    if (Q.leafMode !== 'leaves') { // card crowns (fallback)
      const tile = kind === 'birch' ? TILE.birch : kind === 'willow' ? TILE.willow : TILE.oak;
      cardAcc.rad = crad;
      for (let k = 0; k < Q.cards * 2; k++) {
        const nd = lnodes[Math.floor(R() * lnodes.length)], out = nd.p.clone().sub(cc).normalize();
        const size = 0.8 + R() * 0.4, mode = kind === 'willow' && R() < 0.6 ? 'hang' : 'out';
        const [ax, ay] = cardAxes(R, size, out, mode);
        cardAcc.card(nd.p.clone().addScaledVector(out, 0.3), ax, ay, mode === 'hang' ? TILE.willow : (tile === TILE.oak && R() < 0.5 ? TILE.oak2 : tile), cc, tint(1), sw(nd.p.y - size), sw(nd.p.y + size), R() < 0.5);
      }
      cardAcc.rad = 0; return;
    }
    const LCOL = leafCols[kind].map((h) => C(h)), twigs = [];
    const putLeaf = (pos, ldir, nrm, s) => {
      _by.copy(ldir).normalize(); _bz.copy(nrm).addScaledVector(_by, -nrm.dot(_by)).normalize(); _bx.crossVectors(_by, _bz);
      _m4.makeBasis(_bx, _by, _bz); _m4.scale(new V3(s, s, s)); _m4.setPosition(pos);
      const d = Math.min(1, pos.distanceTo(cc) / crad), up = Math.max(-1, Math.min(1, (pos.y - cc.y) / crad));
      const ao = (0.55 + 0.45 * Math.pow(d, 1.3)) * (0.85 + 0.15 * up);
      const c = LCOL[Math.floor(R() * LCOL.length)].clone().multiplyScalar(ao * (0.88 + R() * 0.24) * 1.02);
      if (R() < 0.04 && kind !== 'willow') c.lerp(C('#b8a640'), 0.6);
      leafInst[kind].push([_m4.clone(), c]);
    };
    const total = Q.leaves * (kind === 'birch' ? 1.7 : kind === 'willow' ? 4.2 : 2.3);
    // weight outer nodes higher (the inside of a crown is shaded and bare)
    const wOf = (nd) => 0.25 + Math.pow(Math.min(1, nd.p.distanceTo(cc) / crad), 2);
    const cum = []; let wsum = 0; for (const nd of lnodes) { wsum += wOf(nd); cum.push(wsum); }
    const pick = () => { const r = R() * wsum; let lo = 0, hi = cum.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < r) lo = m + 1; else hi = m; } return lnodes[lo]; };
    if (kind === 'willow') {
      const perStep = 3, nStreams = Math.round(total / 42);
      for (let s = 0; s < nStreams; s++) {
        const nd = pick(), start = nd.p.clone();
        const out = start.clone().sub(cc).setY(0); if (out.lengthSq() < 1e-4) out.set(R() - 0.5, 0, R() - 0.5); out.normalize();
        const room = start.y - g0 - 0.7 - R() * 0.5; if (room < 0.5) continue;
        const L = Math.min(4.5, room) * (0.6 + R() * 0.4), steps = 13 + Math.floor(R() * 5);
        // short rise up-out, then the shoot falls
        const rise = start.clone().addScaledVector(out, 0.12 + R() * 0.12).add(new V3(0, 0.1 + R() * 0.1, 0));
        twigs.push([start, rise, 'shoot']);
        let p = rise.clone(), last = rise.clone();
        for (let k = 0; k < steps; k++) {
          const t = k / steps, prev = p.clone();
          p.add(new V3(out.x * 0.06 * (1 - t) * (1 - t), -L / steps, out.z * 0.06 * (1 - t) * (1 - t)));
          const d = new V3().subVectors(p, prev).normalize();
          for (let q = 0; q < perStep; q++) {
            const ang = (k * perStep + q) * 2.4, pp = prev.clone().lerp(p, (q + 0.5) / perStep);
            const side = new V3(-d.z, 0, d.x).normalize().multiplyScalar(Math.cos(ang)).add(out.clone().multiplyScalar(Math.sin(ang)));
            const ld = d.clone().multiplyScalar(0.8).addScaledVector(side, 0.55).normalize();
            putLeaf(pp, ld, side.clone().add(new V3(0, 0.2, 0)), (1.1 + R() * 0.3) * (1 - t * 0.3));
          }
          if (k % 3 === 2 || k === steps - 1) { twigs.push([last, p.clone(), 'shoot']); last = p.clone(); }
        }
      }
    } else {
      const perTwig = kind === 'birch' ? 12 : 9, nTw = Math.round(total / perTwig);
      for (let s = 0; s < nTw; s++) {
        const nd = pick(), start = nd.p.clone().lerp(nd.parent >= 0 ? nodes[nd.parent].p : nd.p, R() * 0.8);
        const hz = nd.d.clone().setY(0); if (hz.lengthSq() < 1e-4) hz.set(R() - 0.5, 0, R() - 0.5);
        hz.normalize().add(new V3(R() - 0.5, 0, R() - 0.5).multiplyScalar(1.4)).normalize();
        let pts;
        if (kind === 'birch') { // pendulous twig: short outward stretch then hanging
          const L = 0.5 + R() * 0.6, a = start.clone().addScaledVector(hz, 0.18).add(new V3(0, 0.04, 0));
          const b = a.clone().addScaledVector(hz, L * 0.25).add(new V3(0, -L * 0.45, 0)), c2 = b.clone().addScaledVector(hz, L * 0.08).add(new V3(0, -L * 0.5, 0));
          pts = [start, a, b, c2];
        } else { // oak: short, outward and up, slightly zigzag
          const L = 0.35 + R() * 0.35, dir = hz.clone().add(new V3(0, 0.35 + R() * 0.4, 0)).normalize();
          const a = start.clone().addScaledVector(dir, L * 0.5).add(new V3((R() - 0.5) * 0.08, 0, (R() - 0.5) * 0.08));
          pts = [start, a, a.clone().addScaledVector(dir, L * 0.5)];
        }
        for (let k = 1; k < pts.length; k++) twigs.push([pts[k - 1], pts[k], kind === 'birch' ? 'btwig' : 'twig']);
        for (let k = 0; k < perTwig; k++) {
          const t = kind === 'birch' ? 0.15 + 0.85 * (k + 0.5) / perTwig : 0.35 + 0.65 * (k + 0.5) / perTwig;
          const f = t * (pts.length - 1), si = Math.min(pts.length - 2, Math.floor(f)), pos = pts[si].clone().lerp(pts[si + 1], f - si);
          const tdir = new V3().subVectors(pts[si + 1], pts[si]).normalize(), side = k % 2 ? 1 : -1;
          const perp = new V3().crossVectors(tdir, new V3(0, 1, 0)); if (perp.lengthSq() < 1e-4) perp.copy(hz).cross(new V3(0, 1, 0)); perp.normalize().multiplyScalar(side);
          const ld = kind === 'birch' ? tdir.clone().multiplyScalar(0.4).add(perp.clone().multiplyScalar(0.6)).add(new V3(0, -0.6, 0)).normalize()
            : tdir.clone().multiplyScalar(0.55).add(perp).add(new V3(0, 0.1, 0)).normalize();
          const nrm = (kind === 'birch' ? hz.clone().add(new V3(0, 0.5, 0)) : new V3(0, 1, 0).add(hz.clone().multiplyScalar(0.6))).add(new V3(R() - 0.5, R() - 0.5, R() - 0.5).multiplyScalar(0.7));
          putLeaf(pos, ld, nrm, kind === 'birch' ? 1.0 + R() * 0.4 : 0.8 + R() * 0.3);
        }
      }
    }
    const woodC = C('#8c8c52'), twigC = C('#7a6a58');
    for (const [a0, a1, kd] of twigs) {
      const r0 = kd === 'shoot' ? 0.006 : kd === 'btwig' ? 0.005 : 0.008, r1 = 0.003;
      trunkAcc.add(limbGeo(a0, a1, r0, r1, 3, 1), () => (kd === 'shoot' ? woodC : kd === 'btwig' ? twigBirch : twigC), swayT);
    }
  }
  // a dead snag lying half in the water: skeleton grown upright, broken, then laid down
  function snag(x, z, ang) {
    const base0 = new V3(0, 0, 0), { nodes, S } = skeleton('dead', base0, new V3(0, 1, 0));
    // keep only thick limbs
    for (const nd of nodes) nd.kids = nd.kids.filter((k) => nodes[k].trunk || nodes[k].tip > 0.8 || nodes[k].kids.length);
    breakLimbs(nodes, 6);
    pipeRadii(nodes, 0.02, 0.34);
    nodes.forEach((nd) => { if (nd.broken && nd.parent >= 0) nd.r = nodes[nd.parent].r * 0.85; });
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ang, -Math.PI / 2 - 0.08)), off = new V3(x, H(x, z) + 0.3, z);
    for (const nd of nodes) nd.p.applyQuaternion(q).add(off);
    const colorFn = () => (v, n) => tmp.copy(deadTint).multiplyScalar((0.75 + 0.3 * sm(-0.3, 0.9, n.y)) * (v.y < 0.05 ? 0.55 : 1));
    emitBark(nodes, { ...S, flare: 0.5, flareK: 0.55 }, 'rough', colorFn, () => 0, x);
    // root plate: thick roots fanned out in the plane perpendicular to the trunk, around a clod of earth
    const ax = new V3(0, 1, 0).applyQuaternion(q), bpos = off.clone().addScaledVector(ax, 0.15);
    const nRt = 10;
    for (let k = 0; k < nRt; k++) {
      const a = k / nRt * 6.28 + R() * 0.35, d = new V3(Math.cos(a), 0, Math.sin(a)).applyQuaternion(q).addScaledVector(ax, -0.15 - R() * 0.25).normalize();
      const P = [], Rr = [], r0 = 0.2 + R() * 0.1, L = 1.5 + R() * 1.1; let p = bpos.clone(), dd = d.clone();
      for (let i = 0; i <= 7; i++) {
        P.push(p.clone()); Rr.push(Math.max(0.015, r0 * Math.pow(1 - i / 7, 0.9)));
        dd.add(new V3(R() - 0.5, R() - 0.5, R() - 0.5).multiplyScalar(0.45)).addScaledVector(ax, 0.04).add(new V3(0, -0.13, 0)).normalize();
        p.addScaledVector(dd, L / 7);
      }
      barkAcc.rough.add(tube(P, Rr, { noise: barkNoise, irr: 0.18, seed: k * 3.3, uvScale: 0.6 }), colorFn(), () => 0, 1, 1);
    }
    const clod = blobGeo(N, bpos.clone().addScaledVector(ax, -0.35), 0.85, 1, 1, 0.4);
    { const P = clod.attributes.position, v = new V3(), c = bpos.clone().addScaledVector(ax, -0.35);
      for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i).sub(c); const a = v.dot(ax); v.addScaledVector(ax, -a * 0.6); P.setXYZ(i, c.x + v.x, c.y + v.y, c.z + v.z); }
      clod.computeVertexNormals(); }
    trunkAcc.add(clod, (v) => tmp.copy(C('#4a3c2e')).multiplyScalar(0.75 + 0.35 * N.n2(v.x * 5, v.y * 5 + v.z * 3)), () => 0);
    trunks.push([x, z, 0.6, 'snag', 3]);
  }
  {
    const nT = 3 + Math.floor(R() * 3), kinds = ['willow', 'birch', 'oak', 'birch', 'willow'];
    for (let i = 0; i < nT; i++) {
      let s = null;
      for (let t = 0; t < 40 && !s; t++) {
        const c = randIsland(i === 0 ? 0.9 : 0.75);
        if (c && trunks.every(([x, z]) => Math.hypot(x - c[0], z - c[1]) > 7.5)) s = c;
      }
      if (s) tree(s[0], s[1], kinds[i]);
    }
    { // a dead tree near the island shore
      let s = null;
      for (let t = 0; t < 200 && !s; t++) { const c = randIsland(0.9, 50); if (c && islandE(c[0], c[1]) > 0.62 && trunks.every(([x, z]) => Math.hypot(x - c[0], z - c[1]) > 6)) s = c; }
      if (s) tree(s[0], s[1], 'dead');
    }
    { // a snag lying half in the water at the edge of the sand bar
      const [sx, sz] = sbC(), dz = -sbSide;
      let x = sx - sbL * 0.25, z = sz;
      for (let k = 0; k < 60; k++) { if (H(x, z) < -0.15) break; z += dz * 0.3; }
      snag(x - 0.5, z - dz * 1.2, sbSide * Math.PI / 2 + (R() - 0.5) * 0.6);
    }
    for (const bt of ['rough', 'birch']) {
      if (!barkAcc[bt].p.length) continue;
      const m = new THREE.Mesh(barkAcc[bt].build(), patch(new THREE.MeshLambertMaterial({ vertexColors: true, map: barkTex[bt] }), 'barkT', 0.32));
      m.castShadow = true; m.receiveShadow = true; group.add(m);
    }
    const LG = { oak: leafGeo(0.14, 0.055, 'oak'), birch: leafGeo(0.1, 0.045, 'oak'), willow: leafGeo(0.16, 0.038, 'willow') };
    const leafMatI = patch(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 'leafI', 0.32, { FOLI: '', LEAFI: '' });
    for (const kd of ['oak', 'birch', 'willow']) {
      const L = leafInst[kd]; if (!L.length) continue;
      const im = new THREE.InstancedMesh(LG[kd], leafMatI, L.length);
      L.forEach(([mm, c], i) => { im.setMatrixAt(i, mm); im.setColorAt(i, c); });
      im.userData.leaf = true; im.instanceMatrix.needsUpdate = true; im.instanceColor.needsUpdate = true; im.castShadow = true; im.receiveShadow = true; group.add(im);
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
        bushCards.rad = sz * 0.9; bushCards.card(p, ax, ay, R() < 0.5 ? TILE.bush2 : TILE.bush, bc, tint(1), Math.max(0, p.y - size - g0) * 0.25, (p.y + size - g0) * 0.25, R() < 0.5);
      }
    }
    // rocks along the shore
    const nR = 7 + Math.floor(R() * 6), cRock = C('#7b766c'), cMossR = C('#55703a');
    for (let i = 0; i < nR; i++) {
      let c = null;
      for (let t = 0; t < 80 && !c; t++) { const q = randIsland(1.25, 50); if (q && islandE(q[0], q[1]) > 0.78) c = q; }
      if (!c) continue;
      const [x, z] = c, g0 = H(x, z), r = 0.25 + R() * 0.7, cc = new THREE.Vector3(x, g0 + r * 0.15, z);
      cc.y -= r * 0.25; rockAcc.add(rockGeo(cc, r, 0.5 + R() * 0.3), rockCol(cRock), () => 0); rockList.push([x, z, r * 1.2]);
    }
  }
  // faceted rock: displaced blob chopped by random planes (flat faces, sharp edges), flattened top
  function rockGeo(c, r, flat) {
    const g = new THREE.IcosahedronGeometry(1, 2), P = g.attributes.position, v = new THREE.Vector3();
    const planes = Array.from({ length: 6 + Math.floor(R() * 4) }, () => { const nn = new THREE.Vector3(R() - 0.5, (R() - 0.2) * 1.2, R() - 0.5).normalize(); return [nn, 0.6 + R() * 0.3]; });
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i);
      v.multiplyScalar(1 + 0.18 * N.n2(v.x * 1.3 + c.x, v.z * 1.3 + c.z + v.y));
      for (const [nn, d] of planes) { const e = v.dot(nn) - d; if (e > 0) v.addScaledVector(nn, -e); }
      if (v.y > flat) v.y = flat + (v.y - flat) * 0.3;
      P.setXYZ(i, c.x + v.x * r * 1.15, c.y + v.y * r * 0.75, c.z + v.z * r);
    }
    g.computeVertexNormals();
    return g;
  }
  function rockCol(base) { return (v, n) => {
    const grain = 0.82 + 0.22 * N.n2(v.x * 9, v.z * 9 + v.y * 7) + 0.1 * N.n2(v.x * 31, v.y * 29);
    tmp.copy(base).multiplyScalar(grain);
    const lich = N.n2(v.x * 2.3 + 7, v.z * 2.3 + v.y * 1.7);
    if (lich > 0.45) tmp.lerp(C('#a8a48a'), 0.55); else if (lich < -0.6) tmp.lerp(C('#b0743c'), 0.45);
    tmp.lerp(C('#4f6a30'), sm(0.55, 0.9, n.y) * sm(-0.2, 0.4, N.n2(v.x * 1.5, v.z * 1.5)) * 0.8 + sm(0.2, -0.7, n.z) * 0.25);
    return tmp;
  }; }
  // boulders inside the island and scattered stones
  {
    const cB = C('#8a857c'), cB2 = C('#726c63'), cM = C('#5a7438');
    const boulder = (x, z, r) => {
      const g0 = H(x, z), cc = new THREE.Vector3(x, g0 - r * 0.22, z), base = R() < 0.5 ? cB : cB2;
      rockAcc.add(rockGeo(cc, r, 0.55 + R() * 0.3), rockCol(base), () => 0);
      trunks.push([x, z, r * 0.95]); rockList.push([x, z, r * 1.2]);
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
      const r = 0.06 + R() * 0.14, cc = new THREE.Vector3(c[0], H(c[0], c[1]) - r * 0.1, c[1]);
      rockAcc.add(rockGeo(cc, r, 0.5), rockCol(cB2), () => 0); rockList.push([c[0], c[1], r * 1.2]);
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
      cc.y -= r * 0.15; rockAcc.add(rockGeo(cc, r, 0.6), rockCol(cR), () => 0);
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
        if (trunks.some(([tx, tz, r]) => Math.hypot(tx - x, tz - z) < r * 0.8) || rockList.some(([rx, rz, r]) => Math.hypot(rx - x, rz - z) < r)) continue;
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
  const spawn0 = [irx * 0.8 * ca, zc0 + irx * 0.8 * sa];
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
    // dense walls: strips 10-25 m along the waterline
    const walls = [];
    for (let t = 0; t < 4000 && walls.length < 12; t++) {
      const x = (R() * 2 - 1) * 240, side = R() < 0.5 ? -1 : 1, z = mz(x) + side * (hwAt(x) - 1), h = H(x, z);
      if (h < 0.1 && h > -0.4 && Math.abs(x) > 6) walls.push([x, side, 10 + R() * 15]);
    }
    const reedMat = patch(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 'reed', 0.8, { GUST: '', NOFLIP: '', HIDECAMP: '' });
    const placeWall = (d) => {
      for (let t = 0; t < 30; t++) {
        const w0 = walls[Math.floor(R() * walls.length)], x = w0[0] + (R() - 0.5) * w0[2], z = mz(x) + w0[1] * (hwAt(x) - 3.5 + R() * 4.5), h = H(x, z);
        if (h > 0.3 || h < -0.6) continue;
        d.position.set(x, h - 0.05, z); d.rotation.set((R() - 0.5) * 0.12, R() * 6.28, (R() - 0.5) * 0.12); d.scale.set(1 + R() * 0.6, 1.5 + R() * 1.3, 1);
        return white;
      }
      return null;
    };
    const g = bladeGeo(0.08, 5, C('#a2a85a'), C('#3e5a2a'), 0.25);
    {
      // march outward along rays from the island centre: find the band from waterline (h 0.15) to ~0.55 m deep
      const ray = (ang) => {
        const dx = Math.cos(ang), dz = Math.sin(ang); let inner = null, outer = null;
        for (let d = 3; d < 60; d += 0.25) { const x = dx * d, z = zc0 + dz * d, h = H(x, z); if (!inner && h < 0.15) inner = d; if (inner && h < -0.55) { outer = d; break; } }
        return inner && outer ? [inner, outer] : null;
      };
      const NA = 120, bands = []; for (let i = 0; i < NA; i++) bands.push(ray(i / NA * Math.PI * 2));
      const spA = Math.atan2(spawn0[1] - zc0, spawn0[0]);
      const cand = [];
      for (let i = 0; i < NA; i++) {
        let sc = 0, ok = true; for (let k = -3; k <= 3; k++) { const bd = bands[(i + k + NA) % NA]; if (!bd) { ok = false; break; } sc += bd[1] - bd[0]; }
        if (!ok) continue;
        const a = i / NA * Math.PI * 2, near = Math.abs(Math.atan2(Math.sin(a - spA), Math.cos(a - spA)));
        cand.push([i, sc + (near < 0.9 ? 25 : 0)]);
      }
      cand.sort((p, q) => q[1] - p[1]);
      const arcs = [];
      for (const [i] of cand) { if (arcs.every((j) => Math.min(Math.abs(i - j), NA - Math.abs(i - j)) > 14)) arcs.push(i); if (arcs.length >= 3) break; }
      if (arcs.length) meshes.reedIsle = instanced(g, reedMat, Q.reedIsle * arcs.length, (d) => {
        for (let t = 0; t < 40; t++) {
          const i = arcs[Math.floor(R() * arcs.length)], off = (R() + R() + R() - 1.5) * 4.2, fi = i + off, ang = fi / NA * Math.PI * 2, bd = bands[((Math.round(fi) % NA) + NA) % NA];
          if (!bd) continue;
          const dd = bd[0] + Math.pow(R(), 0.8) * (bd[1] - bd[0]), x = Math.cos(ang) * dd, z = zc0 + Math.sin(ang) * dd, h = H(x, z);
          if (h > 0.2 || h < -0.6) continue;
          d.position.set(x, h - 0.05, z); d.rotation.set((R() - 0.5) * 0.14, R() * 6.28, (R() - 0.5) * 0.14); const tap = Math.max(0.35, 1 - Math.pow(Math.abs(off) / 6.3, 2) * 0.75), edge = Math.min(1, (dd - bd[0]) / 1.2 + 0.45);
          if (R() > Math.max(0.25, tap)) continue;
          d.scale.set(1 + R() * 0.6, (1.6 + R() * 1.4) * tap * edge * (0.7 + R() * 0.45), 1);
          return white;
        }
        return null;
      });
    }
    if (walls.length) meshes.reedWalls = instanced(g, reedMat, Q.reedWall, placeWall);
    // brown panicles on part of the stems
    {
      const pg = bladeGeo(0.08, 5, C('#a2a85a'), C('#3e5a2a'), 0.25), P = pg.attributes.position, cols = pg.attributes.color;
      const pos = Array.from(P.array), col = Array.from(cols.array), sw = Array.from(pg.attributes.sway.array), nor = Array.from(pg.attributes.normal.array), idx = Array.from(pg.index.array);
      const b0 = pos.length / 3, pc = C('#5a4028');
      for (const [x, y, s2] of [[-0.035, 1.0, 1], [0.035, 1.0, 1], [-0.02, 1.16, 1], [0.02, 1.16, 1]]) { pos.push(x, y, 0.25); col.push(pc.r, pc.g, pc.b); sw.push(s2); nor.push(0, 1, 0); }
      idx.push(b0, b0 + 1, b0 + 2, b0 + 1, b0 + 3, b0 + 2);
      const g2 = new THREE.BufferGeometry();
      g2.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g2.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g2.setAttribute('sway', new THREE.Float32BufferAttribute(sw, 1)); g2.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g2.setIndex(idx);
      if (walls.length) meshes.reedPan = instanced(g2, reedMat, Math.round(Q.reedWall * 0.25), placeWall);
    }
    meshes.reeds = instanced(g, reedMat, Q.reeds, (d) => {
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
  // underwater weed on the shallow bed, swaying with the current
  {
    const g = bladeGeo(0.15, 5, C('#7c9a34'), C('#2c4216'), 0.35);
    meshes.algae = instanced(g, patch(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 'algae', 0.9, { NOFLIP: '' }), Q.algae, (d) => {
      for (let t = 0; t < 40; t++) {
        const near = R() < 0.7;
        let x, z;
        if (near) { const u = (R() * 2 - 1) * irx * 1.5, v = (R() * 2 - 1) * irz * 1.6; x = u * ca - v * sa; z = zc0 + u * sa + v * ca; }
        else { x = (R() * 2 - 1) * 200; z = mz(x) + (R() < 0.5 ? -1 : 1) * (hwAt(x) - 1 - R() * 9); }
        const h = H(x, z); if (h > -0.14 || h < -0.75) continue;
        if (N.n2(x * 0.25, z * 0.25) < -0.2) continue;
        const L = -h * (0.6 + R() * 0.33);
        d.position.set(x, h, z); d.rotation.set(0, R() * 6.28, 0); d.scale.set(0.8 + R() * 0.8, L, 1);
        return white;
      }
      return null;
    });
  }
  // bushes along both banks
  {
    const bush = (n) => {
      const acc = new CardAcc(), bc = new THREE.Vector3(0, 0.6, 0), nin = Math.round(n * 0.4);
      for (let j = 0; j < n; j++) {
        const isIn = j < nin, out = new THREE.Vector3(R() - 0.5, R() * 0.6, R() - 0.5).normalize();
        const p = bc.clone().addScaledVector(out, isIn ? 0.05 + R() * 0.25 : 0.3 + R() * 0.45), size = isIn ? 0.55 + R() * 0.2 : 0.6 + R() * 0.3;
        const [ax, ay] = cardAxes(R, size, out, 'out');
        acc.rad = 1.0; acc.card(p, ax, ay, R() < 0.5 ? TILE.bush2 : TILE.bush, bc, tint(1), Math.max(0, p.y - size) * 0.25, (p.y + size) * 0.25, R() < 0.5);
      }
      return acc.build();
    };
    const bm = FM.mk('bankbush', 0.3), btint = new THREE.Color();
    const groups = [];
    for (let t = 0; t < 3000 && groups.length < Q.bankBush / 3; t++) {
      const x = (R() * 2 - 1) * 260, side = R() < 0.5 ? -1 : 1, bd = Math.pow(R(), 1.5) * 30 - 1, z = mz(x) + side * (hwAt(x) + bd);
      if (H(x, z) > 0.45) groups.push([x, z]);
    }
    if (groups.length) {
      for (const geo of [bush(Q.bushCards), bush(Math.round(Q.bushCards * 0.8))]) {
        const m = instanced(geo, bm, Math.round(Q.bankBush / 2), (d) => {
          for (let t = 0; t < 10; t++) {
            const gq = groups[Math.floor(R() * groups.length)], x = gq[0] + (R() - 0.5) * 6, z = gq[1] + (R() - 0.5) * 6, h = H(x, z);
            if (h < 0.4) continue;
            const s = 0.8 + R() * 1.0; d.position.set(x, h - 0.1, z); d.rotation.set(0, R() * 6.28, 0); d.scale.set(s * (0.9 + R() * 0.3), s, s * (0.9 + R() * 0.3));
            return btint.setHSL(0.25 + (R() - 0.5) * 0.06, 0.2 + R() * 0.15, 0.45 + R() * 0.1).multiplyScalar(2.1);
          }
          return null;
        });
        m.customDepthMaterial = FM.depth;
      }
    }
  }
  // bank forest (instanced conifers + broadleaves; foliage cards; simpler geometry far away)
  {
    const trunkC = C('#4a3a2a'), V3 = THREE.Vector3;
    const decT = new Acc();
    decT.add(limbGeo(new V3(0, -0.5, 0), new V3(0, 4.2, 0), 0.3, 0.16, 5, 1), () => trunkC, () => 0);
    for (let k = 0; k < 3; k++) { const a = k * 2.1; decT.add(limbGeo(new V3(0, 3.6, 0), new V3(Math.cos(a) * 1.3, 5.6, Math.sin(a) * 1.3), 0.12, 0.05, 4, 1), () => trunkC, () => 0); }
    // spruce (Picea abies): irregular whorls, upper branches rise, middle level, lower droop; side shoots hang as a comb
    // beneath each bough; ragged outline (random lengths, gaps); spire with a leader; dead twigs on the bare lower trunk.
    // o: { lv: whorls, per: branches per whorl, bare: bare trunk fraction, slim: crown width, dense, crook: top bend, young }
    const spruce = (o) => {
      const acc = new CardAcc(), tr = new Acc(), top = 11.2, deadC = C('#6a635a'), barkC = C('#4e4034');
      // trunk axis with a slight sway and an optional crooked top
      const ca = R() * 6.28, axis = (y) => { const t = y / top; return new V3(Math.sin(y * 0.35 + ca) * 0.06 + Math.cos(ca) * o.crook * Math.max(0, t - 0.78) ** 2 * 12, y, Math.cos(y * 0.31 + ca) * 0.06 + Math.sin(ca) * o.crook * Math.max(0, t - 0.78) ** 2 * 12); };
      for (let k = 0; k < 8; k++) { const y0 = -0.5 + k / 8 * (top + 0.6), y1 = -0.5 + (k + 1) / 8 * (top + 0.6); tr.add(limbGeo(axis(y0), axis(y1), 0.26 * (1 - k / 8) ** 0.9 + 0.025, 0.26 * (1 - (k + 1) / 8) ** 0.9 + 0.02, 5, 1), () => barkC, () => 0); }
      const y0 = top * o.bare + 0.4;
      let y = y0, wi = 0; const step = (top - 0.7 - y0) / (Q.spruceLv * (o.young ? 1.1 : 1));
      const bough = (base, ang, L, t, tilt) => {
        const elev = t > 0.72 ? 0.25 + (t - 0.72) * 1.6 : t > 0.4 ? 0.05 - (0.72 - t) * 0.2 : -0.12 - (0.4 - t) * 0.9; // radians
        const e = elev + tilt, dir = new V3(Math.cos(ang) * Math.cos(e), Math.sin(e), Math.sin(ang) * Math.cos(e));
        const side = new V3(-dir.z, 0, dir.x).normalize(), up = new V3().crossVectors(side, dir).normalize();
        const roll = (R() - 0.5) * 0.5, col = tint((0.88 + t * 0.25) * (0.88 + R() * 0.22));
        // flat spray along the bough
        const ay = side.clone().multiplyScalar(Math.cos(roll)).addScaledVector(up, Math.sin(roll)).multiplyScalar(L * 0.52 * o.dense);
        acc.card(base.clone().addScaledVector(dir, L / 2 + 0.05), dir.clone().multiplyScalar(L / 2 + 0.05), ay, TILE.spruce, axis(base.y), col, base.y * 0.012, (base.y + 0.4) * 0.016, R() < 0.5);
        // hanging comb below the bough (lower and middle crown)
        if (t < 0.78 && L > 0.9 && R() < 0.75) {
          const hang = up.clone().multiplyScalar(-1).addScaledVector(dir, 0.15).normalize(), hl = L * (0.16 + 0.1 * (1 - t));
          acc.card(base.clone().addScaledVector(dir, L * 0.55).addScaledVector(hang, hl * 0.9), dir.clone().multiplyScalar(L * 0.42), hang.multiplyScalar(hl), TILE.spruce, axis(base.y), col.clone().multiplyScalar(0.85), base.y * 0.012, base.y * 0.014, R() < 0.5);
        }
      };
      while (y < top - 0.7) {
        const t = (y - y0) / (top - 0.7 - y0), lump = 0.82 + R() * 0.33;
        const nPer = Math.max(3, Math.round(o.per * (1 - t * 0.4) + (R() - 0.5) * 2)), rot = wi * 2.4;
        const maxL = (3.0 * Math.pow(1 - t, 0.9) * o.slim + 0.3) * (o.young ? 0.85 : 1);
        for (let k = 0; k < nPer; k++) {
          if (R() < 0.08 && t < 0.85) continue; // gaps in the crown
          const ang = rot + (k + (R() - 0.5) * 0.7) / nPer * Math.PI * 2, L = maxL * lump * (0.7 + R() * 0.5);
          bough(axis(y), ang, L, t, (R() - 0.5) * 0.15);
        }
        // intermediate branches between whorls
        if (R() < (Q.spruceLv > 14 ? 0.4 : 0.15) && t < 0.85) { const yi = y + 0.2, ang = R() * 6.28; bough(axis(yi), ang, maxL * (0.45 + R() * 0.3), t, -0.05); }
        y += step * (0.75 + R() * 0.5) * (t > 0.8 ? 0.75 : 1); wi++;
      }
      // spire: small upright sprays and the leader
      for (let k = 0; k < 4; k++) { const a = k * 1.6 + R(), yy = top - 0.65 + k * 0.08; bough(axis(yy), a, 0.35 - k * 0.05, 0.95, 0.2); }
      { const b = axis(top - 0.55), tp = axis(top + 0.25), d = tp.clone().sub(b), sd = new V3(1, 0, 0).multiplyScalar(0.07);
        acc.card(b.clone().addScaledVector(d, 0.5), d.clone().multiplyScalar(0.5), sd, TILE.spruce, null, tint(1.05), top * 0.012, top * 0.017); }
      // dead twigs on the bare trunk (forest trees)
      if (o.bare > 0.12) {
        for (let yy = 1.2; yy < y0; yy += 0.5 + R() * 0.4) {
          const n = 1 + Math.floor(R() * 2.5);
          for (let k = 0; k < n; k++) {
            const a = R() * 6.28, L = 0.35 + R() * 0.8 * (yy / y0 + 0.3), d = new V3(Math.cos(a), -0.15 - R() * 0.3, Math.sin(a)).normalize(), b0 = axis(yy), b1 = b0.clone().addScaledVector(d, L);
            tr.add(limbGeo(b0, b1, 0.018, 0.005, 3, 1), () => deadC, () => 0);
            if (L > 0.7 && R() < 0.5) { const m = b0.clone().lerp(b1, 0.55), d2 = d.clone().add(new V3((R() - 0.5), 0.3, (R() - 0.5))).normalize(); tr.add(limbGeo(m, m.clone().addScaledVector(d2, L * 0.35), 0.007, 0.003, 3, 1), () => deadC, () => 0); }
          }
        }
      }
      // dark inner core: the shaded inside of the crown seen through gaps between boughs
      { const cy0 = y0 + 0.3, h = top - 0.9 - cy0, rb = (3.0 * o.slim + 0.3) * 0.3;
        const cone = new THREE.ConeGeometry(rb, h, 6, 2, true).translate(0, cy0 + h / 2, 0);
        const P = cone.attributes.position; for (let i = 0; i < P.count; i++) { const yy = P.getY(i), q = axis(yy); P.setX(i, P.getX(i) * (0.85 + R() * 0.3) + q.x); P.setZ(i, P.getZ(i) * (0.85 + R() * 0.3) + q.z); }
        cone.computeVertexNormals();
        tr.add(cone, (v) => tmp.copy(C('#2e4a32')).multiplyScalar(0.85 + 0.35 * (v.y - cy0) / h), () => 0); }
      acc.rad = 0;
      return [tr.build(), acc.build()];
    };
    const broad = (n, ry, spread) => {
      const acc = new CardAcc(), cc = new V3(0, 5.4 * ry, 0), nin = Math.round(n * 0.4);
      for (let k = 0; k < n; k++) {
        const isIn = k < nin, out = new V3(R() - 0.5, (R() - 0.3) * 0.8, R() - 0.5).normalize();
        const p = cc.clone().add(new V3(out.x * spread, out.y * ry, out.z * spread).multiplyScalar(isIn ? 0.4 + R() * 0.7 : 1.3 + R() * 1.0));
        const size = isIn ? 1.3 + R() * 0.4 : 1.4 + R() * 0.6;
        const [ax, ay] = cardAxes(R, size, out, 'out');
        acc.rad = 3.2 * spread; acc.card(p, ax, ay, R() < 0.5 ? TILE.oak2 : TILE.oak, cc, tint(1), (p.y - size) * 0.03, (p.y + size) * 0.03, R() < 0.5);
      }
      return acc.build();
    };
    const SPV = [
      { lv: 0, per: Q.sprucePer, bare: 0.24, slim: 0.95, dense: 1.0, crook: 0 },          // mature forest spruce
      { lv: 0, per: Q.sprucePer + 1, bare: 0.04, slim: 1.08, dense: 1.1, crook: 0, young: true }, // dense to the ground
      { lv: 0, per: Q.sprucePer - 1, bare: 0.36, slim: 0.72, dense: 0.9, crook: 0.03 },   // tall slender, bare below
      { lv: 0, per: Q.sprucePer, bare: 0.16, slim: 0.88, dense: 1.0, crook: 0.08 },        // crooked top
      { lv: 0, per: Q.sprucePer + 1, bare: 0.1, slim: 1.15, dense: 1.05, crook: 0 },       // broad
      { lv: 0, per: Q.sprucePer - 1, bare: 0.3, slim: 0.82, dense: 0.95, crook: 0.02 },
    ];
    const nCV = Math.min(SPV.length, Q.variants + 2);
    const conV = SPV.slice(0, nCV).map((o) => spruce(o));
    const decV = [[Q.forestCards, 1.0, 1.0], [Q.forestCards, 1.15, 0.85], [Q.forestCards, 0.9, 1.2]].slice(0, Math.max(2, Q.variants - 1)).map((v) => broad(...v));
    const conFar = spruce({ per: 5, bare: 0.1, slim: 1.0, dense: 1.3, crook: 0 }), decFar = broad(Math.round(Q.forestCards * 0.4), 1.0, 1.0);
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
        return con ? ftint.setHSL(0.27 + R() * 0.06, 0.1 + R() * 0.14, 0.5 + R() * 0.1).multiplyScalar(2.15) : ftint.setHSL(0.2 + R() * 0.06, 0.12 + R() * 0.12, 0.45 + R() * 0.1).multiplyScalar(2.1);
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
    const dtB = decT.build();
    meshes.con = conV.map(([tg, g]) => pair(tg, g, Math.round(Q.forest * 0.55 / conV.length), true, false));
    meshes.dec = decV.map((g) => pair(dtB, g, Math.round(Q.forest * 0.45 / decV.length), false, false));
    meshes.conF = pair(conFar[0], conFar[1], Math.round(Q.far * 0.55), true, true);
    meshes.decF = pair(dtB, decFar, Math.round(Q.far * 0.45), false, true);
  }

  // ---------- water lilies in the calm water below the sand bar ----------
  {
    const [sx, sz] = sbC(), spots = [];
    for (let t = 0; t < 400 && spots.length < 3; t++) { // calm water a few metres off the downstream end of the island
      const ang = (R() - 0.5) * 2.6, dx = Math.cos(ang), dz = Math.sin(ang);
      for (let d = 4; d < 70; d += 0.5) {
        const x = dx * d, z = zc0 + dz * d, h = H(x, z);
        if (h < -0.4) { const x2 = x + dx * 1.5, z2 = z + dz * 1.5, h2 = H(x2, z2); if (h2 < -0.3 && h2 > -1.4 && spots.every(([p, q]) => Math.hypot(p - x2, q - z2) > 7)) spots.push([x2, z2]); break; }
      }
    }
    for (let t = 0; t < 3000 && spots.length < 4; t++) {
      const x = sx + (R() - 0.2) * 90, z = sz + (R() - 0.5) * 50, h = H(x, z);
      if (h < -0.3 && h > -1.1 && spots.every(([p, q]) => Math.hypot(p - x, q - z) > 9)) spots.push([x, z]);
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
          if (h > -0.25 || h < -1.6 || pads.some(([a, b, r]) => Math.hypot(a - x, b - z) < r + 0.25)) continue;
          const r = 0.5 + R() * 0.4; pads.push([x, z, r]);
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
      meshes.lilies = instanced(g, fMat, Math.ceil(Q.lily / 2), (d) => {
        if (!pads.length) return null; const p = pads[Math.floor(R() * pads.length)];
        d.position.set(p[0] + (R() - 0.5) * 0.1, 0.012, p[1] + (R() - 0.5) * 0.1); d.rotation.set(0, R() * 6.28, 0); const s = 1.7 + R() * 0.6; d.scale.set(s, s, s);
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
