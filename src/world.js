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

// flat (slightly domed) disc closing a cylinder end, with concentric rings of vertices for the cut-wood colouring
export function capDisc(c, axis, r, segs = 8, rings = 3, dome = 0.05) {
  const ax = axis.clone().normalize(), u = new THREE.Vector3(Math.abs(ax.y) < 0.9 ? 0 : 1, Math.abs(ax.y) < 0.9 ? 1 : 0, 0).cross(ax).normalize(), w = new THREE.Vector3().crossVectors(ax, u);
  const pt = (j, k) => { const f = 1 - k / rings, a = j / segs * Math.PI * 2; return c.clone().addScaledVector(u, Math.cos(a) * r * f).addScaledVector(w, Math.sin(a) * r * f).addScaledVector(ax, r * dome * (1 - f * f)); };
  const pos = [];
  for (let k = 0; k < rings; k++) for (let j = 0; j < segs; j++) {
    const a = pt(j, k), b = pt(j + 1, k), cc = pt(j, k + 1), d = pt(j + 1, k + 1);
    pos.push(a.x, a.y, a.z, cc.x, cc.y, cc.z, b.x, b.y, b.z, b.x, b.y, b.z, cc.x, cc.y, cc.z, d.x, d.y, d.z);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
  const nA = g.attributes.normal; if (nA.getX(0) * ax.x + nA.getY(0) * ax.y + nA.getZ(0) * ax.z < 0) { const A = g.attributes.position; for (let i = 0; i < A.count; i += 3) for (let q = 0; q < 3; q++) { const t = A.getComponent(i + 1, q); A.setComponent(i + 1, q, A.getComponent(i + 2, q)); A.setComponent(i + 2, q, t); } g.computeVertexNormals(); }
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
  let Hmesh = null;
  let world_bake = () => {}, world_dispose = () => {};
  let sodGeo = null, Rsrc = rng(seed); const R = () => Rsrc(), N = makeNoise(seed), group = new THREE.Group();
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
  // ---------- tail bar: sand settles in the calm wake downstream of the island (the current runs toward +x) ----------
  // a tongue of sand from the island's tail along the current, 6-8 m wide at the root, tapering, the end curled a
  // little; a shallow apron around it. Own random stream so the rest of the world keeps its layout.
  const RB = rng(seed ^ 0x7a11); let snakeBank = null;
  const TB = (() => {
    const sl = (mz(2) - mz(-2)) / 4, ln = Math.hypot(1, sl), dx = 1 / ln, dz = sl / ln;
    let tx = 0, tz = zc0;
    for (let k = 0; k < 600; k++) { if (islandE(tx, tz) > 0.97) break; tx += dx * 0.1; tz += dz * 0.1; }
    const L = 27 + RB() * 6, w0 = 6.2 + RB() * 0.8, curl = (RB() < 0.5 ? -1 : 1) * (1.6 + RB() * 2.0), root = 5;
    return { tx, tz, dx, dz, L, w0, curl, root, ox: tx - dx * root, oz: tz - dz * root, len: L + root };
  })();
  // bar frame: s = 0 at the root (inside the island) .. 1 at the tip; n = signed lateral offset from the (curled) axis
  const tbFrame = (x, z) => {
    const px = x - TB.ox, pz = z - TB.oz, a = px * TB.dx + pz * TB.dz, b = -px * TB.dz + pz * TB.dx, s = a / TB.len;
    // the curled axis; past the tip it carries on along its tangent (no kink)
    const off = s <= 0 ? 0 : s <= 1 ? TB.curl * s * s : TB.curl * (2 * s - 1);
    return [s, b - off, a];
  };
  // a tongue: wide where it leaves the island, narrowing steadily to the tip (no pier-like constant width)
  const tbHalfW = (s) => TB.w0 * Math.pow(Math.max(0, 1 - Math.max(0, s)), 1.25) + 0.4;
  // the dry sand outline (noisy half width) and the distance outside it in metres
  const tbW = (x, z, s, n) => tbHalfW(Math.min(1, s)) * (1 + 0.18 * Math.sign(n * TB.curl)) * (1 + 0.14 * N.n2(x * 0.17 + 3.3, z * 0.17) + 0.06 * N.n2(x * 0.6, z * 0.6 + 2.2));
  const tbQ = (x, z) => {
    const [s, n] = tbFrame(x, z), w = tbW(x, z, s, n);
    const ds = s < 0 ? -s * TB.len / 6 : s > 1 ? (s - 1) * TB.len / 2.2 : 0;
    return Math.hypot((n + 0.35 * N.n2(x * 0.33, z * 0.33 + 1.7)) / w, ds);
  };
  // under water the bar slopes away gently (~1:5 to 1 m deep, then on down to the bed over 10-15 m), a little
  // steeper on the side of the main current; past the tip the shoal runs on twice as gently, narrowing to a point
  const tbDepth = (d) => 1.0 * sm(0, 5, d) + 2.15 * sm(3.5, 15, d);
  const tbHeight = (x, z) => {
    const [s, n] = tbFrame(x, z);
    if (s < -0.3 || s > 2.2) return -99;
    const w = tbW(x, z, s, n), nn = n + 0.35 * N.n2(x * 0.33, z * 0.33 + 1.7);
    const lat = Math.abs(nn) - w, lon = s > 1 ? (s - 1) * TB.len : s < 0 ? -s * TB.len * 0.7 : 0;
    const q = Math.hypot(nn / w, s < 0 ? -s * TB.len / 6 : s > 1 ? (s - 1) * TB.len / 2.2 : 0);
    if (q < 1) {
      const crest = 0.1 + 0.34 * Math.pow(Math.max(0, 1 - Math.max(0, s)), 0.9) + 0.04 * N.n2(x * 0.4, z * 0.4);
      return crest * (1 - q * q) + 0.015 * N.n2(x * 1.3, z * 1.3);
    }
    const side = Math.sign(nn * TB.curl) > 0 ? 0.8 : 1.25; // inside of the curl gentler
    const d = Math.hypot(Math.max(0, lat) * side, lon * (s > 1 ? 0.5 : 1));
    if (d > 16) return -99;
    return -tbDepth(d) + 0.01 * N.n2(x * 1.3, z * 1.3);
  };
  U.uLee.value.set(TB.ox, TB.oz, TB.dx, TB.dz); U.uLeeS.value.set(TB.len, TB.w0, TB.curl);
  const onBar = (x, z, m = 1.5) => tbFrame(x, z)[0] > 0.22 && (tbQ(x, z) < m || tbHeight(x, z) > -1.1); // the bar and its shoal
  // cliff on the outer bank of the downstream bend, facing the island
  const cliffSide = -SG, cliffX = 165 + R() * 30, cliffL = 100, cxa = cliffX - cliffL / 2, cxb = cliffX + cliffL / 2;
  // sand bar on the inner (opposite) bank, a little downstream of the island
  const sbX = 70 + R() * 25, sbSide = SG, sbL = 30 + R() * 10, sbW = 8 + R() * 3;
  const cliffFall = (x) => sm(cxa, cxa + 20, x) * (1 - sm(cxb - 20, cxb, x));
  const cliffTop = (x) => 0.6 + (4.8 + 1.6 * N.n2(x * 0.05, 3.3) + 0.4 * N.n2(x * 0.13, 1.7)) * cliffFall(x);
  // narrow erosion gullies cut back into the edge (own random stream: the rest of the world keeps its layout)
  const RC = rng(seed ^ 0x3c1f), gullies = [];
  for (let k = 0; k < 6; k++) { const gx = cxa + 18 + (cliffL - 36) * (k + 0.2 + RC() * 0.6) / 6; gullies.push([gx, 0.45 + RC() * 0.6, 1.2 + RC() * 1.6]); }
  const gully = (x, wk = 1) => { let g = 0; for (const [gx, gw, gd] of gullies) g = Math.max(g, gd * Math.exp(-(((x - gx) / (gw * wk)) ** 2))); return g; };
  // the edge line: bays and buttresses of 5-15 m, smaller bites, and the gullies
  const cliffOff = (x) => 3.4 + 1.4 * N.n2(x * 0.07, 5.5) + 1.3 * N.n2(x * 0.13, 9.1) + 0.45 * N.n2(x * 0.37, 2.1) + 0.22 * N.n2(x * 1.3, 6.6) + 0.1 * N.n2(x * 3.1, 8.8) + gully(x);
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
        const d0 = hw + cliffOff(x), wd = 0.75 + (1 - f) * 3.2, T = cliffTop(x);
        // fallen sand at the foot, heaped into cones below the gullies
        const cone = gully(x, 2.2) / 2.8, tal = 0.3 + 1.1 * cone, tw = 1.2 + 2.2 * cone;
        const talus = tal * sm(d0 - wd - tw, d0 - wd, d) * (1 - sm(d0 - wd, d0, d)) + 0.12 * sm(hw - 0.5, d0 - wd - tw, d);
        // the face profile: steep but uneven up its height (small ledges, bulges and hollows)
        const u = Math.max(0, Math.min(1, (d - (d0 - wd)) / (2 * wd)));
        const prof = Math.max(0, Math.min(1, sm(0, 1, u) + 0.16 * N.n2(x * 0.9, u * 4.3 + 2.2) * 4 * u * (1 - u)));
        const target = Math.max(h, 0.15 + talus) + (T + Math.max(0, d - d0 - wd) * 0.015 - Math.max(h, 0.15 + talus)) * prof;
        h = Math.max(h, h + (target - h) * f * sm(hw - 1.5, hw - 0.3, d));
      }
    }
    // sand bar
    {
      const [cx, cz] = sbC(), dx = (x - cx) / sbL, dz = (z - cz) / sbW;
      const e2 = dx * dx + dz * dz + 0.15 * N.n2(x * 0.08, z * 0.08);
      if (e2 < 9) h = Math.max(h, 0.26 - 0.58 * e2 + 0.04 * N.n2(x * 0.3, z * 0.3)); // (no cut-off: it runs down into the bed)
    }
    const e = islandE(x, z);
    if (e < 2.0) {
      const core = 0.42 + 2.4 * Math.max(0, 1 - e * e) * (0.75 + 0.25 * N.n2(x * 0.07, z * 0.07)) + 0.35 * N.fbm(x * 0.08, z * 0.08, 2) * Math.max(0, 1 - e);
      const s = sm(0.82, 1.32, e);
      let hi = core * (1 - s) - 3.1 * s;
      // under water the island shelves away gently: a third of the old slope at the shore, then a wide skirt
      if (hi < 0) { const s2 = sm(0.82, 1.95, e); hi = Math.min(core * (1 - s2) - 3.1 * s2, 0.3 * hi); }
      h = Math.max(h, hi);
    }
    { // smooth union with the tail bar: the shore runs round into the bar in a curve, no shoulders
      const hb = tbHeight(x, z), k = 0.55, dd = Math.max(k - Math.abs(h - hb), 0) / k;
      h = Math.max(h, hb) + dd * dd * k * 0.25;
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
  const sbE = (x, z) => { const [cx, cz] = sbC(), dx = (x - cx) / sbL, dz = (z - cz) / sbW; return dx * dx + dz * dz + 0.15 * N.n2(x * 0.08, z * 0.08); };
  // colours blend smoothly (no straight cut lines): underwater bed -> wet sand -> dry sand -> grass, with the sand of the
  // tail bar and of the bank sand bar fading in along noisy edges
  const cU = new THREE.Color(), cS = new THREE.Color(), cG = new THREE.Color();
  const terrainColor = (x, z, h) => {
    const sl = Math.min(1, (Math.abs(H(x + 1, z) - h) + Math.abs(H(x, z + 1) - h)) * 0.9);
    const nz = N.n2(x * 0.09, z * 0.09), bd = bankDist(x, z), n2 = N.n2(x * 0.31, z * 0.31 + 4.1);
    const s0 = tbFrame(x, z)[0], tq = tbQ(x, z);
    const barK = sm(0.15, 0.33, s0 + 0.07 * n2) * sm(2.8, 1.9, tq + 0.25 * n2);
    const sbK = sm(2.2, 1.5, sbE(x, z) + 0.2 * n2);
    // under water
    if (h < -1.2) cU.copy(cBed).lerp(cBedDeep, sm(-1.2, -3, h)); else cU.copy(cWet).lerp(cBed, sm(-0.15, -1.2, h));
    const shoal = sm(0.14, 0.3, s0 + 0.07 * n2) * sm(-1.05, -0.55, tbHeight(x, z));
    if (shoal > 0) cU.lerp(tmp.copy(cSand).multiplyScalar(0.92).lerp(cWet, sm(0.1, -0.3, h) * 0.75).lerp(cBed, sm(-0.3, -0.95, h) * 0.6), shoal);
    // sand at the water's edge
    cS.copy(cSand).lerp(cWet, sm(0.15, -0.15, h));
    // grass
    cG.copy(cGrass).lerp(nz > 0 ? cGrass2 : cGrass3, Math.abs(nz) * 0.8);
    cG.lerp(cDirt, sm(0.35, 0.8, sl) * 0.8);
    cG.lerp(cForest, sm(14, 60, bd) * sm(1.1, 1.3, islandE(x, z)));
    cG.lerp(cMoss, sm(70, 400, bd) * 0.5);
    const gK = sm(0.27 + nz * 0.12, 0.4 + nz * 0.12 + 0.05 * n2, h) * (1 - Math.max(barK, sbK));
    tmp.copy(cS).lerp(cG, gK);
    return tmp.lerp(cU, sm(-0.05, -0.25, h)).clone();
  };
  // fine-grid patch over the island and its tail bar (shoreline, wet band and grass edge without grid steps)
  const IP = { x0: -45, x1: 84, z0: zc0 - 33, z1: zc0 + 33, step: Q.terr >= 180 ? 0.5 : 0.8 };
  const inIslePatch = (x, z) => x > IP.x0 + 4 && x < IP.x1 - 4 && z > IP.z0 + 4 && z < IP.z1 - 4;
  const inCliffPatch = (x, z) => { if (x < cxa + 10 || x > cxb - 10) return false; const zc = mz(x), dd = (z - zc) * cliffSide, hw = hwAt(x); return dd > hw - 3 && dd < hw + 18; };
  for (let i = 0; i < tp.count; i++) {
    const x = map(tp.getX(i)), z = mapZ(tp.getZ(i)) + mz(x) * shiftZ(tp.getZ(i));
    const h = H(x, z); tp.setXYZ(i, x, h - (inCliffPatch(x, z) || inIslePatch(x, z) ? 1.5 : 0), z);
    terrainColor(x, z, h).toArray(cols, i * 3);
  }
  tg.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  tg.setAttribute('sway', new THREE.BufferAttribute(new Float32Array(tp.count), 1));
  tg.computeVertexNormals();
  // height of the terrain mesh itself (piecewise-linear triangles), so small objects sit exactly on what is drawn
  const hCache = new Map();
  Hmesh = (x, z) => {
    let lo = -1, hi = 1; for (let it = 0; it < 30; it++) { const m = (lo + hi) / 2; if (map(m) < x) lo = m; else hi = m; }
    const fu = (lo + 1) / 2 * seg, ix = Math.max(0, Math.min(seg - 1, Math.floor(fu)));
    const u0 = -1 + 2 * ix / seg, u1 = -1 + 2 * (ix + 1) / seg, x0 = map(u0), x1 = map(u1), tx = (x - x0) / (x1 - x0 || 1);
    const zAt = (v, xx) => mapZ(v) + mz(xx) * shiftZ(v);
    let vlo = -1, vhi = 1; for (let it = 0; it < 30; it++) { const m = (vlo + vhi) / 2; const zm = zAt(m, x0) * (1 - tx) + zAt(m, x1) * tx; if (zm < z) vlo = m; else vhi = m; }
    const iy = Math.max(0, Math.min(seg - 1, Math.floor((vlo + 1) / 2 * seg))), v0 = -1 + 2 * iy / seg, v1 = -1 + 2 * (iy + 1) / seg;
    const P = (i, j) => { const key = i * 4096 + j; let r = hCache.get(key); if (!r) { const u = -1 + 2 * i / seg, v = -1 + 2 * j / seg, xx = map(u), zz = zAt(v, xx); r = [xx, zz, H(xx, zz)]; if (hCache.size > 20000) hCache.clear(); hCache.set(key, r); } return r; };
    const A = P(ix, iy), B = P(ix, iy + 1), Cq = P(ix + 1, iy + 1), D = P(ix + 1, iy);
    const bary = (p, q, r) => { const d = (q[2 - 1] - r[1]) * (p[0] - r[0]) + (r[0] - q[0]) * (p[1] - r[1]); if (Math.abs(d) < 1e-12) return null; const l1 = ((q[1] - r[1]) * (x - r[0]) + (r[0] - q[0]) * (z - r[1])) / d, l2 = ((r[1] - p[1]) * (x - r[0]) + (p[0] - r[0]) * (z - r[1])) / d, l3 = 1 - l1 - l2; return [l1, l2, l3]; };
    for (const [p, q, r] of [[A, B, D], [B, Cq, D]]) { const b = bary(p, q, r); if (b && b[0] > -1e-4 && b[1] > -1e-4 && b[2] > -1e-4) return b[0] * p[2] + b[1] * q[2] + b[2] * r[2]; }
    return H(x, z);
  };
  const terrainMat = patch(new THREE.MeshLambertMaterial({ vertexColors: true }), 'terrain', 0, { DETAIL: '' });
  const terrain = new THREE.Mesh(tg, terrainMat);
  terrain.receiveShadow = true; group.add(terrain);
  {
    const { x0, z0, step } = IP, nx = Math.ceil((IP.x1 - x0) / step), nzr = Math.ceil((IP.z1 - z0) / step), A = nx + 1;
    const pos = new Float32Array(A * (nzr + 1) * 3), col = new Float32Array(A * (nzr + 1) * 3), hh = new Float32Array(A * (nzr + 1)), idx = [];
    for (let j = 0; j <= nzr; j++) for (let i = 0; i <= nx; i++) {
      const x = x0 + i * step, z = z0 + j * step, h = H(x, z), k = j * A + i;
      pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z; hh[k] = h; terrainColor(x, z, h).toArray(col, k * 3);
    }
    for (let j = 0; j < nzr; j++) for (let i = 0; i < nx; i++) { const a0 = j * A + i; idx.push(a0, a0 + A, a0 + 1, a0 + 1, a0 + A, a0 + A + 1); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('sway', new THREE.BufferAttribute(new Float32Array(A * (nzr + 1)), 1));
    g.setIndex(idx); g.computeVertexNormals();
    const m = new THREE.Mesh(g, patch(new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }), 'terrain', 0, { DETAIL: '' }));
    m.receiveShadow = true; group.add(m);
    // the visible height there is this grid's triangles
    const HmMain = Hmesh;
    Hmesh = (x, z) => {
      const fi = (x - x0) / step, fj = (z - z0) / step;
      if (fi < 0 || fj < 0 || fi >= nx || fj >= nzr) return HmMain(x, z);
      const i = Math.floor(fi), j = Math.floor(fj), fx = fi - i, fz = fj - j, k = j * A + i;
      const h00 = hh[k], h10 = hh[k + 1], h01 = hh[k + A], h11 = hh[k + A + 1];
      return fx + fz < 1 ? h00 + fx * (h10 - h00) + fz * (h01 - h00) : h11 + (1 - fx) * (h01 - h11) + (1 - fz) * (h10 - h11);
    };
  }
  // fine-grid patch for the cliff bank (0.6 m), main terrain is tucked below it
  {
    const step = 0.4, x0 = cxa - 5, x1 = cxb + 5, nx = Math.ceil((x1 - x0) / step), nzr = Math.ceil(28 / step), A = nx + 1, pos = [], col = [], idx = [], cl = [];
    for (let j = 0; j <= nzr; j++) for (let i = 0; i <= nx; i++) {
      const x = x0 + i * step, dd = hwAt(x) - 6 + j * step, z = mz(x) + cliffSide * dd, h = H(x, z);
      pos.push(x, h, z); const c = terrainColor(x, z, h); col.push(c.r, c.g, c.b); cl.push(Math.max(0, cliffTop(x) - h), cliffFall(x));
    }
    for (let j = 0; j < nzr; j++) for (let i = 0; i < nx; i++) {
      const a0 = j * A + i;
      if (cliffSide > 0) idx.push(a0, a0 + A, a0 + 1, a0 + 1, a0 + A, a0 + A + 1); else idx.push(a0, a0 + 1, a0 + A, a0 + 1, a0 + A + 1, a0 + A);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('sway', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3), 1));
    g.setAttribute('aCl', new THREE.Float32BufferAttribute(cl, 2));
    g.setIndex(idx); g.computeVertexNormals();
    const m = new THREE.Mesh(g, patch(new THREE.MeshLambertMaterial({ vertexColors: true }), 'terrain', 0, { DETAIL: '', CLIFF: '' })); m.receiveShadow = true; group.add(m);
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
    birch: { h: [9, 11.5], rBase: 0.145, trunkF: 0.9, wob: 0.05, step: 0.32, di: 1.7, dk: 0.45, nPts: 750, persist: 0.6, kink: 0.12, elbowP: 0.15, elbow: 0.3, maxKids: 3, rTip: 0.007, flare: 0.45, flareK: 0.45, irr: 0.06,
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
  // cut / broken wood seen end-on: pale heartwood with growth rings, darker rim and sapwood, a radial crack or two;
  // weathered (driftwood) ends are greyer, broken stubs are splintery and lighter at the tip
  const cWoodL = C('#e2cfa6'), cWoodD = C('#a07e55'), cWoodRim = C('#4a3828'), cWoodGrey = C('#9c968a'), cWoodTmp = new THREE.Color();
  const woodEnd = (c, axis, r, weather = 0, broken = false) => (v) => {
    const d = new THREE.Vector3().subVectors(v, c), along = d.dot(axis); d.addScaledVector(axis, -along);
    const rr = Math.min(1, d.length() / Math.max(1e-4, r)), ang = Math.atan2(d.z, d.x + d.y * 0.7);
    const ringN = 4 + r * 40, ring = 0.5 + 0.5 * Math.sin(rr * ringN * 6.283 + 0.6 * N.n2(v.x * 9, v.z * 9));
    cWoodTmp.copy(cWoodL).lerp(cWoodD, ring * 0.55 + 0.15 * N.n2(v.x * 23, v.z * 23 + v.y * 17) + rr * 0.15);
    const crack = Math.pow(Math.max(0, Math.cos(ang * 2 + c.x * 3.1)), 40) * (0.3 + rr);
    cWoodTmp.lerp(cWoodRim, Math.min(1, crack * 0.9 + Math.pow(rr, 5) * 0.9));
    if (broken) cWoodTmp.lerp(cWoodL, Math.min(1, along / Math.max(1e-3, r) * 0.6)).multiplyScalar(1.05);
    return cWoodTmp.lerp(cWoodGrey, weather).multiplyScalar(1.35);
  };
  // a log or branch: open cylinder plus closed ends
  function woodLimb(p0, p1, r0, r1, segs, hseg, colorFn, weather = 0.18) {
    trunkAcc.add(limbGeo(p0, p1, r0, r1, segs, hseg), colorFn, () => 0);
    const ax = new THREE.Vector3().subVectors(p1, p0).normalize();
    trunkAcc.add(capDisc(p1, ax, r1, segs, r1 > 0.05 ? 3 : 1), woodEnd(p1, ax, r1, weather), () => 0);
    trunkAcc.add(capDisc(p0, ax.clone().negate(), r0, segs, r0 > 0.05 ? 3 : 1), woodEnd(p0, ax.clone().negate(), r0, weather), () => 0);
  }
  function emitBark(nodes, S, bt, colorFn, swayT, seed) {
    const emit = (g, nd) => barkAcc[bt].add(g, colorFn(nd), swayT, 1, 1); emit.count = 0;
    emit.cap = (g, nd) => { const u = g.userData; trunkAcc.add(g, woodEnd(u.c, u.axis, u.r, 0.12, u.broken), () => 0); };
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
  function tree(x, z, kind, leanO, leafK = 1) {
    const g0 = H(x, z), base = new V3(x, g0 - 0.3, z);
    const la = R() * Math.PI * 2, lt = kind === 'willow' ? 0.12 + R() * 0.12 : kind === 'dead' ? 0.1 + R() * 0.15 : 0.05 * R();
    const lean = leanO ? leanO.clone().normalize() : new V3(Math.sin(lt) * Math.cos(la), Math.cos(lt), Math.sin(lt) * Math.sin(la)).normalize();
    const { nodes, height, S } = skeleton(kind, base, lean);
    if (kind === 'dead') breakLimbs(nodes, 4 + Math.floor(R() * 3));
    pipeRadii(nodes, S.rTip, S.rBase);
    nodes.forEach((nd) => { if (nd.broken) nd.r = nodes[nd.parent].r * 0.85; });
    trunks.push([x, z, S.rBase + 0.25, kind, height]);
    const bt = kind === 'birch' ? 'birch' : 'rough';
    const tintB = kind === 'willow' ? C('#d2c6b0') : kind === 'oak' ? C('#cdbca4') : kind === 'dead' ? deadTint : C('#ffffff');
    // flexibility: birch and willow bend most, oak least, dead trees hardly at all
    const flex = kind === 'dead' ? 0.12 : kind === 'birch' || kind === 'willow' ? 0.39 : kind === 'oak' ? 0.21 : 0.3;
    const swayT = (v) => Math.max(0, (v.y - g0) / height) ** 2 * flex;
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
      leafInst[kind].push([_m4.clone(), c, swayT(pos)]);
    };
    const total = Q.leaves * leafK * (kind === 'birch' ? 1.7 : kind === 'willow' ? 4.2 : 2.3);
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
    // ---------- the cliff: trees at the edge, a fallen one, roots, the overhanging sod, slumped blocks, driftwood ----------
    {
      const Rkeep = Rsrc; Rsrc = RC; // own random stream: the rest of the world keeps its layout
      const out = new V3(0, 0, -cliffSide); // toward the water
      const edge = (x) => { const d0 = hwAt(x) + cliffOff(x), z = mz(x) + cliffSide * d0; return { x, z, d0, T: H(x, mz(x) + cliffSide * (d0 + 0.8)) }; };
      const at = (x, dd) => [x, mz(x) + cliffSide * dd];
      const cRoot = C('#4a3a2c'), cRoot2 = C('#6b5640'), cHum = C('#4a3828'), cSodG = C('#56682f'), cLoam = C('#7d5a3a'), cDwC = C('#8e8474');
      // trees and bushes right at the edge, one leaning out
      const treeXs = [cliffX - 30 + R() * 8, cliffX + 4 + R() * 8, cliffX + 28 + R() * 6];
      treeXs.forEach((tx, k) => {
        if (gully(tx) > 0.3) tx += 3;
        const e = edge(tx), [x, z] = at(tx, e.d0 + 1.0 + R() * 0.6);
        const lean = k === 1 ? new V3(out.x * 0.35, 1, out.z * 0.35) : null;
        tree(x, z, k === 2 ? 'oak' : 'birch', lean, 0.5);
        // its roots laid bare by the falling face, hanging down the wall
        for (let j = 0; j < 7; j++) {
          const xx = tx + (R() - 0.5) * 2.2, ee = edge(xx), y0 = ee.T - 0.15 - R() * 0.3;
          const p0 = new V3(xx, y0, mz(xx) + cliffSide * (ee.d0 + 0.15));
          const p1 = new V3(xx + (R() - 0.5) * 0.4, y0 - 0.4 - R() * 1.1, mz(xx) + cliffSide * (ee.d0 - 0.12 - R() * 0.25));
          trunkAcc.add(limbGeo(p0, p1, 0.025 + R() * 0.03, 0.006, 4, 2), () => (R() < 0.5 ? cRoot : cRoot2), () => 0);
        }
      });
      { // a birch that went down with a slump: its root plate torn up on the edge, the trunk down the face into the water
        let fx = cliffX - 8 + R() * 10; if (gully(fx) > 0.3) fx += 3;
        const e = edge(fx), [x, z] = at(fx, e.d0 + 0.3), base = new V3(x, e.T + 0.25, z);
        const [tx2, tz2] = at(fx + 3.5, e.d0 - 8.5), tip = new V3(tx2, -0.25, tz2), mid = base.clone().lerp(tip, 0.45); mid.y += 0.5;
        const cB = C('#d9d6cc'), cBd = C('#2d2a26');
        const birchC = (v) => tmp.copy(cB).lerp(cBd, smoothNoise(v) > 0.55 ? 0.85 : 0.05).multiplyScalar(0.8 + 0.2 * N.n2(v.x * 3, v.z * 3));
        function smoothNoise(v) { return N.n2(v.x * 2.3 + v.y * 9, v.z * 2.3) * 0.5 + 0.5; }
        woodLimb(base, mid, 0.24, 0.19, 10, 3, birchC, 0.1); woodLimb(mid, tip, 0.19, 0.07, 9, 3, birchC, 0.1);
        // bare branches, broken short on the underside
        for (let j = 0; j < 15; j++) {
          const t0 = 0.28 + j * 0.047, p0 = base.clone().lerp(tip, t0); p0.y += Math.sin(t0 * Math.PI) * 0.45;
          const a = R() * 6.28, up = R() < 0.65, ln = (up ? 1.4 + R() * 1.8 : 0.3 + R() * 0.4) * (1 - t0 * 0.45);
          const p1 = p0.clone().add(new V3(Math.cos(a) * ln * 0.7, up ? ln * 0.7 : -ln * 0.3, Math.sin(a) * ln * 0.7));
          woodLimb(p0, p1, 0.065 * (1 - t0 * 0.5), 0.014, 5, 2, () => tmp.copy(cDwC).multiplyScalar(0.75), 0.2);
          if (up && R() < 0.7) { const m = p0.clone().lerp(p1, 0.6); woodLimb(m, m.clone().add(new V3((R() - 0.5) * 0.8, 0.3 + R() * 0.4, (R() - 0.5) * 0.8)), 0.018, 0.005, 4, 1, () => cDwC, 0.2); }
        }
        // the root plate standing up on the edge, earth still in it
        trunkAcc.add(blobGeo(N, base.clone().add(new V3(-out.x * 0.15, 0.25, -out.z * 0.15)), 0.75, 0.75, 1, 0.45), (v, n) => tmp.copy(n.y > 0.6 ? cHum : cLoam).multiplyScalar(0.75 + 0.3 * N.n2(v.x * 4, v.z * 4)), () => 0);
        for (let j = 0; j < 9; j++) { const a = j * 0.7 + R() * 0.4, p0 = base.clone().add(new V3(0, 0.2, 0)), p1 = p0.clone().add(new V3(Math.cos(a) * (0.6 + R() * 0.5), 0.1 + R() * 0.8, Math.sin(a) * (0.6 + R() * 0.5)));
          trunkAcc.add(limbGeo(p0, p1, 0.045, 0.01, 4, 2), () => cRoot, () => 0); }
        trunks.push([x, z, 0.5]);
      }
      // the overhanging sod along the top edge: a mat of turf 12-20 cm thick, sticking out 15-45 cm and sagging,
      // torn at the gullies and here and there; roots and rootlets hang from under it
      {
        const pos = [], col = [];
        const quad = (a, b, c, d, nWant, ca, cb) => {
          const n = new V3().subVectors(b, a).cross(new V3().subVectors(d, a));
          const tri = n.dot(nWant) >= 0 ? [a, b, c, a, c, d] : [a, c, b, a, d, c];
          for (const v of tri) { pos.push(v.x, v.y, v.z); const cc = (v === a || v === d) ? ca : cb; col.push(cc.r, cc.g, cc.b); }
        };
        let prev = null;
        for (let x = cxa + 10; x <= cxb - 10; x += 0.35) {
          const f = cliffFall(x), torn = gully(x) > 0.1 || N.n2(x * 0.21, 4.4) < -0.45;
          if (f < 0.55 || torn) { prev = null; continue; }
          const e = edge(x), ov = 0.15 + 0.3 * (N.n2(x * 0.3, 7.7) * 0.5 + 0.5), th = 0.12 + 0.08 * (N.n2(x * 0.5, 1.9) * 0.5 + 0.5), sag = 0.05 + 0.12 * (N.n2(x * 0.4, 3.3) * 0.5 + 0.5);
          const pz = (dd) => mz(x) + cliffSide * dd;
          const A = new V3(x, e.T + 0.02, pz(e.d0 + 0.6)), B = new V3(x, e.T - sag, pz(e.d0 - ov)), Cc = new V3(x, e.T - sag - th, pz(e.d0 - ov + 0.04)), D = new V3(x, e.T - th - 0.1, pz(e.d0 + 0.25));
          const cur = { A, B, C: Cc, D, T: e.T, d0: e.d0 };
          if (prev && (Math.abs(prev.T - e.T) > 0.2 || Math.abs(prev.d0 - e.d0) > 0.3)) prev = null; // a step in the edge: the turf is torn there
          if (prev) {
            const g1 = tmp.copy(cSodG).multiplyScalar(0.85 + 0.3 * N.n2(x * 2, 1)).clone();
            quad(prev.A, cur.A, cur.B, prev.B, new V3(0, 1, 0), g1, g1);
            quad(prev.B, cur.B, cur.C, prev.C, out, cHum, cHum);
            quad(prev.C, cur.C, cur.D, prev.D, new V3(0, -1, 0), cHum, cHum);
            // rootlets hanging from the underside
            if (R() < 0.55) { const p0 = cur.C.clone().lerp(cur.D, R() * 0.6), ln = 0.15 + R() * 0.6;
              trunkAcc.add(limbGeo(p0, p0.clone().add(new V3((R() - 0.5) * 0.15, -ln, out.z * 0.05 * R())), 0.008 + R() * 0.012, 0.002, 3, 2), () => (R() < 0.6 ? cRoot : cRoot2), () => 0); }
          }
          prev = cur;
        }
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        g.setAttribute('sway', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3), 1)); g.computeVertexNormals();
        sodGeo = g; // meshed once the bark material exists
      }
      // slumped blocks of earth at the foot (some with their turf still on top), a few in the water
      for (let k = 0, made = 0; k < 80 && made < 9; k++) {
        const x = cxa + 14 + R() * (cliffL - 28); if (cliffFall(x) < 0.6) continue;
        const e = edge(x), r = 0.35 + R() * 0.55, dd = e.d0 - 1.1 - r * 0.6 - R() * (made < 3 ? 4.5 : 2.0), [bx, bz] = at(x, dd), h = H(bx, bz);
        if (h > 1.2) continue; // must lie at the foot, not on the face
        if (rockList.some(([rx, rz, rr]) => Math.hypot(rx - bx, rz - bz) < rr + r)) continue;
        const turf = R() < 0.4, tilt = R();
        rockAcc.add(blobGeo(N, new V3(bx, Math.max(h, -0.6) + r * 0.1, bz), r, 0.55 + 0.2 * R(), 1, 0.42), (v, n) => {
          const up = n.y > 0.45 + tilt * 0.3;
          return tmp.copy(turf && up ? cSodG : cLoam).multiplyScalar(0.75 + 0.35 * N.n2(v.x * 3, v.z * 3 + v.y * 5)).lerp(cHum, turf && n.y > 0.1 && !up ? 0.5 : 0);
        }, () => 0);
        rockList.push([bx, bz, r * 1.1]); made++;
      }
      // driftwood at the foot
      for (let k = 0; k < 2; k++) {
        const x = cliffX - 20 + k * 30 + R() * 10, e = edge(x), [x0, z0] = at(x, e.d0 - 2.2 - R()), [x1, z1] = at(x + 2.5 + R() * 1.5, e.d0 - 3.5 - R() * 1.5);
        const r = 0.12 + R() * 0.08, p0 = new V3(x0, Math.max(H(x0, z0), -0.15) + r * 0.7, z0), p1 = new V3(x1, Math.max(H(x1, z1), -0.2) + r * 0.5, z1);
        woodLimb(p0, p1, r, r * 0.6, 7, 2, (v) => tmp.copy(cDwC).multiplyScalar(0.7 + 0.3 * N.n2(v.x * 5, v.z * 5)));
        for (let j = 0; j < 4; j++) { const a = R() * 6.28; woodLimb(p0, p0.clone().add(new V3(Math.cos(a) * 0.45, (R() - 0.3) * 0.3, Math.sin(a) * 0.45)), r * 0.45, r * 0.1, 5, 1, () => cDwC); }
      }
      Rsrc = Rkeep;
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
      // each leaf carries its tree's sway at that point (so it moves with its branch); its own shape only flutters
      const lg = LG[kd].clone(), isw = new Float32Array(L.length); L.forEach((e, i) => { isw[i] = e[2]; });
      lg.setAttribute('iSway', new THREE.InstancedBufferAttribute(isw, 1));
      const im = new THREE.InstancedMesh(lg, leafMatI, L.length);
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
  function rockGeo(c, r, flat, RR = R) {
    const g = new THREE.IcosahedronGeometry(1, 2), P = g.attributes.position, v = new THREE.Vector3();
    const planes = Array.from({ length: 6 + Math.floor(RR() * 4) }, () => { const nn = new THREE.Vector3(RR() - 0.5, (RR() - 0.2) * 1.2, RR() - 0.5).normalize(); return [nn, 0.6 + RR() * 0.3]; });
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
    // stones on the tail bar: a few washed cobbles along it, some in a small group at the waterline, one or two bigger
    const cStone = C('#8f887c'), cStone2 = C('#6d675f');
    for (let i = 0, made = 0; i < 400 && made < 16; i++) {
      const s0 = 0.12 + RB() * 0.95, side = RB() < 0.5 ? -1 : 1, nn = side * RB() * 1.25;
      const ax = TB.ox + TB.dx * s0 * TB.len, az = TB.oz + TB.dz * s0 * TB.len, off = nn * tbHalfW(s0) + TB.curl * s0 * s0;
      const x = ax - TB.dz * off, z = az + TB.dx * off, h = H(x, z);
      if (h < -0.35 || islandE(x, z) < 1.0) continue;
      if (rockList.some(([rx, rz, rr]) => Math.hypot(rx - x, rz - z) < rr + 0.25)) continue;
      const big = made < 2, r = big ? 0.3 + RB() * 0.2 : 0.07 + RB() * 0.16;
      const cc = new THREE.Vector3(x, h - r * (big ? 0.3 : 0.15), z);
      rockAcc.add(rockGeo(cc, r, 0.45 + RB() * 0.2, RB), rockCol(RB() < 0.5 ? cStone : cStone2), () => 0); rockList.push([x, z, r * 1.2]);
      if (big) trunks.push([x, z, r * 0.9]);
      made++;
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
      woodLimb(p0, p1, r, r * 0.7, 6, 2, (v) => tmp.copy(cDw).multiplyScalar(0.8 + 0.25 * N.n2(v.x * 4, v.z * 4)));
      if (R() < 0.6) { const m = p0.clone().lerp(p1, 0.35 + R() * 0.3); woodLimb(m, m.clone().add(new THREE.Vector3((R() - 0.5) * 0.9, 0.2 + R() * 0.4, (R() - 0.5) * 0.9)), r * 0.45, r * 0.2, 4, 1, () => cDw); }
    }
    { // washed-up wood on the tail bar: a barkless trunk lying along the current, its thick end upstream, and branches
      const at = (s0, nn) => { const ax = TB.ox + TB.dx * s0 * TB.len, az = TB.oz + TB.dz * s0 * TB.len, off = nn * tbHalfW(s0) + TB.curl * s0 * s0; return [ax - TB.dz * off, az + TB.dx * off]; };
      const cDw3 = C('#a39785');
      { const s0 = 0.45 + RB() * 0.25, nn = (RB() < 0.5 ? -1 : 1) * (0.35 + RB() * 0.35), [x, z] = at(s0, nn);
        const a = Math.atan2(TB.dz, TB.dx) + (RB() - 0.5) * 0.7, L = 3.2 + RB() * 1.6, r = 0.15 + RB() * 0.06;
        const hA = Math.max(H(x - Math.cos(a) * L / 2, z - Math.sin(a) * L / 2), -0.2), hB = Math.max(H(x + Math.cos(a) * L / 2, z + Math.sin(a) * L / 2), -0.2);
        const p0 = new THREE.Vector3(x - Math.cos(a) * L / 2, hA + r * 0.75, z - Math.sin(a) * L / 2), p1 = new THREE.Vector3(x + Math.cos(a) * L / 2, hB + r * 0.5, z + Math.sin(a) * L / 2);
        // two slightly bent pieces, weathered grey-brown with lengthwise cracks and darker wet underside
        const side = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a)), pm = p0.clone().lerp(p1, 0.45).addScaledVector(side, (RB() - 0.5) * 0.5); pm.y += 0.04;
        const wood = (v, nrm) => tmp.copy(cDw3).multiplyScalar(0.62 + 0.22 * N.n2(v.x * 3.1, v.z * 3.1) + 0.14 * Math.abs(N.n2((v.x * Math.cos(a) + v.z * Math.sin(a)) * 1.2, (v.y + v.x * Math.sin(a) - v.z * Math.cos(a)) * 26))).lerp(cDw2, nrm && nrm.y < -0.2 ? 0.5 : 0);
        woodLimb(p0, pm, r, r * 0.8, 9, 3, wood);
        woodLimb(pm, p1, r * 0.8, r * 0.5, 9, 3, wood);
        // what is left of the roots at the thick end: a swollen root collar and a few short, broken, uneven stubs,
        // most of them bent back and down into the sand
        trunkAcc.add(blobGeo(N, p0.clone().addScaledVector(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), 0.06), r * 1.35, 0.85, 1, 0.35), wood, () => 0);
        for (let k = 0; k < 5; k++) { const b = a + Math.PI + (k - 2) * 0.75 + (RB() - 0.5) * 0.4, down = k % 2 ? -0.25 - RB() * 0.2 : (RB() - 0.4) * 0.35, ln = 0.18 + RB() * 0.3;
          const s0 = p0.clone().add(new THREE.Vector3(Math.cos(b) * r * 0.6, 0, Math.sin(b) * r * 0.6));
          const e = new THREE.Vector3(s0.x + Math.cos(b) * ln, Math.max(s0.y + down * ln * 1.6, hA - 0.05), s0.z + Math.sin(b) * ln);
          woodLimb(s0, e, r * (0.32 + RB() * 0.2), r * (0.1 + RB() * 0.1), 5, 1, wood); }
        for (let k = 0; k < 2; k++) { const m = p0.clone().lerp(p1, 0.4 + k * 0.25), b = a + (k ? 1 : -1) * (0.6 + RB() * 0.5);
          woodLimb(m, m.clone().add(new THREE.Vector3(Math.cos(b) * (0.3 + RB() * 0.4), 0.1 + RB() * 0.2, Math.sin(b) * (0.3 + RB() * 0.4))), r * 0.38, r * 0.14, 5, 1, wood); }
        trunks.push([x, z, 0.35]); rockList.push([x, z, L / 2]);
      }
      for (let k = 0; k < 3; k++) { // branches, one of them half in the water at the edge
        const s0 = 0.2 + RB() * 0.7, nn = (RB() < 0.5 ? -1 : 1) * (k === 0 ? 0.95 : RB() * 0.8), [x, z] = at(s0, nn);
        const a = RB() * 6.28, L = 1.1 + RB() * 1.4, r = 0.04 + RB() * 0.04;
        const p0 = new THREE.Vector3(x - Math.cos(a) * L / 2, 0, z - Math.sin(a) * L / 2), p1 = new THREE.Vector3(x + Math.cos(a) * L / 2, 0, z + Math.sin(a) * L / 2);
        p0.y = Math.max(H(p0.x, p0.z), -0.12) + r * 0.8; p1.y = Math.max(H(p1.x, p1.z), -0.12) + r * 0.6;
        woodLimb(p0, p1, r, r * 0.5, 5, 2, (v) => tmp.copy(k ? cDw : cDw2).multiplyScalar(0.8 + 0.25 * N.n2(v.x * 6, v.z * 6)));
        const m = p0.clone().lerp(p1, 0.5); woodLimb(m, m.clone().add(new THREE.Vector3((RB() - 0.5) * 0.6, 0.1 + RB() * 0.15, (RB() - 0.5) * 0.6)), r * 0.5, r * 0.2, 4, 1, () => cDw);
      }
    }
    { // the bank grass snake's home: an old log, a stump with its roots and a little heap of stones by the water
      const side = RB() < 0.5 ? -1 : 1, bx = -10 - RB() * 18; snakeBank = { x: bx, side };
      const bp = (x, dd) => { const z = mz(x) + side * (hwAt(x) + dd); return [x, z, H(x, z)]; };
      { const [x0, z0, h0] = bp(bx - 1.4, 2.6), [x1, z1, h1] = bp(bx + 1.3, 2.9), r = 0.17;
        const p0 = new THREE.Vector3(x0, h0 + r * 0.7, z0), p1 = new THREE.Vector3(x1, h1 + r * 0.55, z1);
        const logC = (v) => tmp.copy(cDw2).lerp(cDw, 0.4).multiplyScalar(0.7 + 0.3 * N.n2(v.x * 5, v.z * 5 + v.y * 9));
        woodLimb(p0, p1, r, r * 0.8, 8, 3, logC);
        const m = p0.clone().lerp(p1, 0.6); woodLimb(m, m.clone().add(new THREE.Vector3(0.25, 0.28, side * 0.3)), r * 0.35, r * 0.15, 5, 1, logC);
        trunks.push([(x0 + x1) / 2, (z0 + z1) / 2, 0.35, 'log']); }
      { const [x, z, h] = bp(bx + 4.5, 4.2), r = 0.24, top = new THREE.Vector3(x, h + 0.42, z);
        const stC = (v) => tmp.copy(cDw2).multiplyScalar(0.62 + 0.2 * N.n2(v.y * 30, v.x * 7));
        woodLimb(new THREE.Vector3(x, h - 0.1, z), top, r * 1.15, r, 9, 2, stC, 0.1);
        for (let k = 0; k < 5; k++) { const a = k * 1.256 + RB() * 0.5, ln = 0.35 + RB() * 0.3, s0 = new THREE.Vector3(x + Math.cos(a) * r * 0.8, h + 0.08, z + Math.sin(a) * r * 0.8);
          woodLimb(s0, new THREE.Vector3(x + Math.cos(a) * (r + ln), H(x + Math.cos(a) * (r + ln), z + Math.sin(a) * (r + ln)) - 0.03, z + Math.sin(a) * (r + ln)), r * 0.35, r * 0.1, 5, 1, stC); }
        trunks.push([x, z, r + 0.1, 'stump']); }
      { const [x, z] = bp(bx - 5, 0.9);
        for (let k = 0; k < 5; k++) { const rr = 0.14 + RB() * 0.2, xx = x + (RB() - 0.5) * 0.9, zz = z + (RB() - 0.5) * 0.7, hh = H(xx, zz);
          rockAcc.add(rockGeo(new THREE.Vector3(xx, hh + rr * (k < 3 ? 0.2 : 0.55), zz), rr, 0.55, RB), rockCol(RB() < 0.5 ? C('#8f887c') : C('#6d675f')), () => 0); rockList.push([xx, zz, rr * 1.2]); }
        trunks.push([x, z, 0.45, 'stones']); }
    }
    const fx = -60 - R() * 40, fside = -SG, zc = mz(fx), hw = hwAt(fx);
    const base = new THREE.Vector3(fx - 2, 0, zc + fside * (hw + 5)); base.y = H(base.x, base.z) + 0.2;
    const tip = new THREE.Vector3(fx + 5, -0.45, zc + fside * (hw - 7));
    woodLimb(base, tip, 0.32, 0.13, 7, 4, (v) => tmp.copy(cDw2).multiplyScalar(0.8 + 0.3 * N.n2(v.x * 3, v.y * 3)));
    for (let k = 0; k < 5; k++) {
      const m = base.clone().lerp(tip, 0.3 + k * 0.13), dir = new THREE.Vector3((R() - 0.5) * 1.4, 0.4 + R() * 0.8, (R() - 0.5) * 1.4).normalize();
      woodLimb(m, m.clone().addScaledVector(dir, 0.8 + R() * 1.4), 0.08, 0.025, 4, 1, () => cDw2);
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
  if (sodGeo) { const m = new THREE.Mesh(sodGeo, barkMat); m.castShadow = true; m.receiveShadow = true; group.add(m); }
  const folMat = FM.mk('foliage', 0.32), bushMat = FM.mk('bushfol', 0.12);
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
    // a few tussocks where the tail bar joins the island (the rest of the bar is bare sand)
    { let cl = null, left = 0;
      const ok = (x, z) => { const [s0] = tbFrame(x, z); return H(x, z) > 0.14 && tbQ(x, z) < 0.9 && s0 > 0.12 && s0 < 0.42 && islandE(x, z) > 0.98; };
      meshes.tbGrass = instanced(g, mat, Math.round(Q.grass * 0.012), (d) => {
        for (let t = 0; t < 30; t++) {
          if (!cl || left <= 0) { const s0 = 0.14 + RB() * 0.26, nn = (RB() * 2 - 1) * 0.8, ax = TB.ox + TB.dx * s0 * TB.len, az = TB.oz + TB.dz * s0 * TB.len, off = nn * tbHalfW(s0) + TB.curl * s0 * s0, x = ax - TB.dz * off, z = az + TB.dx * off; if (!ok(x, z)) continue; cl = [x, z]; left = 6 + Math.floor(RB() * 10); }
          const a = RB() * 6.28, rr = Math.sqrt(RB()) * 0.2, x = cl[0] + Math.cos(a) * rr, z = cl[1] + Math.sin(a) * rr; left--;
          if (!ok(x, z)) continue;
          d.position.set(x, H(x, z) - 0.03, z); d.rotation.set((RB() - 0.5) * 0.3, RB() * 6.28, (RB() - 0.5) * 0.3);
          d.scale.set(0.8 + RB() * 0.6, (0.25 + RB() * 0.35) * (1 - rr * 1.8), 1);
          return tint.setHSL(0.18 + RB() * 0.05, 0.45, 0.42 + RB() * 0.14).multiplyScalar(2.2);
        }
        return null;
      });
    }
    // sparse tussocks on the sand bar, in irregular patches shaped by noise
    { const [cx, cz] = sbC(); let cl = null, left = 0;
      const ok = (x, z) => { const h = H(x, z), e = sbE(x, z); return h > 0.1 && e < 1.4 && N.n2(x * 0.16 + 5.3, z * 0.16) * 0.8 + 0.45 * N.n2(x * 0.55, z * 0.55 + 2) - 0.6 * e > -0.3; };
      meshes.sbGrass = instanced(g, mat, Math.round(Q.grass * 0.07), (d) => {
        for (let t = 0; t < 30; t++) {
          if (!cl || left <= 0) { const x = cx + (R() - 0.5) * sbL * 2.2, z = cz + (R() - 0.5) * sbW * 2.2; if (!ok(x, z)) continue; cl = [x, z]; left = 8 + Math.floor(R() * 14); }
          const a = R() * 6.28, rr = Math.sqrt(R()) * 0.22, x = cl[0] + Math.cos(a) * rr, z = cl[1] + Math.sin(a) * rr; left--;
          if (!ok(x, z)) continue;
          d.position.set(x, H(x, z) - 0.03, z); d.rotation.set((R() - 0.5) * 0.3, R() * 6.28, (R() - 0.5) * 0.3);
          d.scale.set(0.8 + R() * 0.6, (0.28 + R() * 0.4) * (1 - rr * 1.8), 1);
          return tint.setHSL(0.17 + R() * 0.05, 0.42, 0.42 + R() * 0.14).multiplyScalar(2.2);
        }
        return null;
      });
    }
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
      if (h < 0.15 && h > -0.3 && !onBar(x, z, 3.2)) reedClusters.push([x, z, 1.2 + R() * 2.2]);
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
          if (h > 0.2 || h < -0.6 || onBar(x, z, 2.7)) continue;
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
          const h = H(x, z); if (h > 0.3 || h < -0.5 || onBar(x, z, 2.7)) continue;
          d.position.set(x, h - 0.05, z); d.rotation.set((R() - 0.5) * 0.15, R() * 6.28, (R() - 0.5) * 0.15); d.scale.set(1 + R() * 0.8, 1.3 + R() * 1.3, 1);
          return white;
        }
        if (R() < 0.45) { const u = (R() * 2 - 1) * irx * 1.4, v = (R() * 2 - 1) * irz * 1.4; x = u * ca - v * sa; z = zc0 + u * sa + v * ca; }
        else { x = (R() * 2 - 1) * 300; z = mz(x) + (R() < 0.5 ? -1 : 1) * (hwAt(x) + (R() * 2 - 1) * 10); }
        const h = H(x, z); if (h > 0.25 || h < -0.45 || onBar(x, z, 2.7)) continue;
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
        const h = H(x, z); if (h > -0.14 || h < -0.75 || onBar(x, z, 2.8)) continue;
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
    const bm = FM.mk('bankbush', 0.12), btint = new THREE.Color();
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
      const acc = new CardAcc(), tr = new Acc(), top = 11.2, deadC = C('#66625d'), barkC = C('#3d3632'), stickC = C('#4a3e36');
      const lite = Q.sprucePer < 7; // low tier: fewer cards per bough
      // trunk axis with a slight sway and an optional crooked top
      const ca = R() * 6.28, axis = (y) => { const t = y / top; return new V3(Math.sin(y * 0.35 + ca) * 0.06 + Math.cos(ca) * o.crook * Math.max(0, t - 0.78) ** 2 * 12, y, Math.cos(y * 0.31 + ca) * 0.06 + Math.sin(ca) * o.crook * Math.max(0, t - 0.78) ** 2 * 12); };
      for (let k = 0; k < 8; k++) { const y0 = -0.5 + k / 8 * (top + 0.6), y1 = -0.5 + (k + 1) / 8 * (top + 0.6); tr.add(limbGeo(axis(y0), axis(y1), 0.26 * (1 - k / 8) ** 0.9 + 0.025, 0.26 * (1 - (k + 1) / 8) ** 0.9 + 0.02, 5, 1), () => barkC, () => 0); }
      const y0 = top * o.bare + 0.4, crownR = 3.0 * o.slim + 0.3;
      acc.rad = crownR * 1.1;
      // crown profile: widest at the crown base, slightly concave toward the spire
      const prof = (t) => Math.pow(1 - t, 1.12) * (1 - 0.12 * Math.sin(Math.PI * t));
      // a bough: brown main shoot + several small needle cards in different planes + light tip
      const bough = (base, ang, L, t, tilt) => {
        const elev = t > 0.72 ? 0.25 + (t - 0.72) * 1.6 : t > 0.4 ? 0.05 - (0.72 - t) * 0.2 : -0.12 - (0.4 - t) * 0.9;
        const e = elev + tilt, hd = new V3(Math.cos(ang), 0, Math.sin(ang));
        const sag = t < 0.55 ? (0.55 - t) * 0.35 : 0, up = t < 0.5 ? (0.5 - t) * 0.5 : 0; // lower boughs sag and turn their tips up
        const cur = (u) => base.clone().addScaledVector(hd, L * u * Math.cos(e)).add(new V3(0, L * u * Math.sin(e) - L * sag * Math.sin(Math.PI * u) + L * up * u * u * u, 0));
        const side = new V3(-hd.z, 0, hd.x), cC = axis(base.y - 1.2), shade = (1.05 + t * 0.3) * (0.88 + R() * 0.2);
        if (L > 0.55) tr.add(limbGeo(base, cur(0.8), 0.012 + 0.01 * L, 0.004, 3, 1), () => stickC, () => 0);
        const n = Math.max(2, Math.min(6, Math.round(1.5 + L * 1.3) - (lite ? 1 : 0)));
        for (let j = 0; j < n; j++) {
          const u0 = j / n, u1 = (j + 1.25) / n, a = cur(Math.min(1, u0)), b = cur(Math.min(1, u1)), d = b.clone().sub(a), seg = d.length(); d.normalize();
          const c = a.clone().lerp(b, 0.5), w = seg * (0.55 + 0.2 * (1 - u0)) * o.dense;
          const kind = j % 3, roll = kind === 0 ? (R() - 0.5) * 0.3 : (kind === 1 ? 1 : -1) * (0.5 + R() * 0.3);
          const upv = new V3().crossVectors(d, side).multiplyScalar(-1).normalize();
          const ay = side.clone().multiplyScalar(Math.cos(roll)).addScaledVector(upv, Math.sin(roll)).multiplyScalar(w);
          acc.card(c, d.clone().multiplyScalar(seg * 0.6), ay, TILE.sShoot, cC, tint(shade), base.y * 0.012, (base.y + 0.4) * 0.016, R() < 0.5);
          // hanging fringe under the bough in the lower and middle crown
          if (t < 0.75 && (j === 1 || (j === 3 && !lite)) && L > 0.7) {
            const hl = seg * (0.5 + 0.35 * (1 - t));
            acc.card(c.clone().add(new V3(0, -hl * 0.78, 0)), d.clone().multiplyScalar(seg * 0.62), new V3(0, hl, 0).addScaledVector(side, (R() - 0.5) * 0.3 * hl), TILE.sFringe, cC, tint(shade * 0.9), base.y * 0.012, base.y * 0.014, R() < 0.5);
          }
        }
        // light young growth at the tip
        const tp = cur(1), td = tp.clone().sub(cur(0.88)).normalize().add(new V3(0, 0.15, 0)).normalize(), tl = Math.min(0.28, L * 0.18);
        acc.card(tp.clone().addScaledVector(td, tl * 0.5), td.clone().multiplyScalar(tl * 0.6), side.clone().multiplyScalar(tl * 0.45), TILE.sTip, cC, tint(1.05 + R() * 0.1), base.y * 0.012, (base.y + 0.4) * 0.016);
      };
      let y = y0, wi = 0; const step = (top - 0.7 - y0) / (Q.spruceLv * (o.young ? 1.1 : 1));
      while (y < top - 0.7) {
        const t = (y - y0) / (top - 0.7 - y0), lump = 0.82 + R() * 0.33;
        const nPer = Math.max(3, Math.round(o.per * (1 - t * 0.4) + (R() - 0.5) * 2)), rot = wi * 2.4;
        const maxL = (crownR * prof(t) + 0.3) * (o.young ? 0.85 : 1);
        for (let k = 0; k < nPer; k++) {
          if (R() < 0.08 && t < 0.85) continue; // gaps in the crown
          const ang = rot + (k + (R() - 0.5) * 0.7) / nPer * Math.PI * 2, L = maxL * lump * (0.7 + R() * 0.5);
          bough(axis(y), ang, L, t, (R() - 0.5) * 0.15);
        }
        if (R() < (Q.spruceLv > 14 ? 0.4 : 0.15) && t < 0.85) { const yi = y + step * 0.5, ang = R() * 6.28; bough(axis(yi), ang, maxL * (0.45 + R() * 0.3), t, -0.05); }
        // shaded old needles close to the trunk (instead of a solid core)
        if (t < 0.8 && R() < 0.8) {
          const a = R() * 6.28, rr = maxL * (0.25 + R() * 0.25), c = axis(y).add(new V3(Math.cos(a) * rr, -0.1, Math.sin(a) * rr)), sz = maxL * 0.3 + 0.15;
          const [ax, ay] = cardAxes(R, sz, new V3(Math.cos(a), 0, Math.sin(a)), 'out');
          acc.card(c, ax, ay, TILE.sDark, axis(y - 1.2), tint(0.75), y * 0.012, y * 0.014, R() < 0.5);
        }
        y += step * (0.75 + R() * 0.5) * (t > 0.8 ? 0.75 : 1); wi++;
      }
      // spire: short upright whorls and the leader
      for (let k = 0; k < 4; k++) { const a = k * 1.6 + R(), yy = top - 0.65 + k * 0.08; bough(axis(yy), a, 0.4 - k * 0.06, 0.95, 0.2); }
      { const b = axis(top - 0.55), tp = axis(top + 0.3), d = tp.clone().sub(b);
        acc.card(b.clone().addScaledVector(d, 0.5), d.clone().multiplyScalar(0.5), new V3(0.09, 0, 0), TILE.sTip, axis(top - 2), tint(1.05), top * 0.012, top * 0.017);
        acc.card(b.clone().addScaledVector(d, 0.5), d.clone().multiplyScalar(0.5), new V3(0, 0, 0.09), TILE.sTip, axis(top - 2), tint(1.05), top * 0.012, top * 0.017); }
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
    const decFar = broad(Math.round(Q.forestCards * 0.4), 1.0, 1.0);
    const fmat = FM.mk('forestfol', 0.25);
    const mat = patch(new THREE.MeshLambertMaterial({ vertexColors: true }), 'forest', 0.25);
    const ftint = new THREE.Color();
    // one placement: returns [matrix, colour, distance from the water] or null
    const placeOne = (con, far) => {
      for (let t = 0; t < 40; t++) {
        const x = (R() * 2 - 1) * (far ? 1050 : 430), side = R() < 0.5 ? -1 : 1;
        const bd = far ? 75 + R() * 900 : 6 + Math.pow(R(), 2.2) * 75;
        const z = mz(x) + side * (hwAt(x) + bd);
        if (Math.abs(z) > 1150) continue;
        const h = H(x, z); if (h < 0.7) continue;
        if (N.fbm(x * 0.012, z * 0.012, 2) < -0.32) continue;
        const pc = sm(20, 160, bd) * 0.75 + 0.15;
        if ((R() < pc) !== con) continue;
        const s = (0.75 + R() * 0.7) * (far ? 1.35 : 1) * (con ? 1.1 : 1);
        dummy.position.set(x, h, z); dummy.rotation.set((R() - 0.5) * 0.08, R() * 6.28, (R() - 0.5) * 0.08); dummy.scale.set(s, s * (0.85 + R() * 0.4), s); dummy.updateMatrix();
        const col = con ? new THREE.Color().setHSL(0.27 + R() * 0.06, 0.1 + R() * 0.14, 0.5 + R() * 0.1).multiplyScalar(2.15) : new THREE.Color().setHSL(0.2 + R() * 0.06, 0.12 + R() * 0.12, 0.45 + R() * 0.1).multiplyScalar(2.1);
        return [dummy.matrix.clone(), col, bd];
      }
      return null;
    };
    const fromList = (geo, mt, list) => {
      const m = new THREE.InstancedMesh(geo, mt, Math.max(1, list.length));
      list.forEach(([m4, c], i) => { m.setMatrixAt(i, m4); m.setColorAt(i, c); });
      m.count = list.length; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; m.frustumCulled = false; group.add(m); return m;
    };
    const pairL = (trunkGeo, folGeo, list) => { const fm = fromList(folGeo, fmat, list); fm.customDepthMaterial = FM.depth; return [fromList(trunkGeo, mat, list), fm]; };
    const dtB = decT.build();
    // broadleaves as before
    const gen = (con, far, n) => { const L = []; for (let i = 0; i < n; i++) { const r = placeOne(con, far); if (r) L.push(r); } return L; };
    const decN = gen(false, false, Math.round(Q.forest * 0.45)), decFL = gen(false, true, Math.round(Q.far * 0.45));
    meshes.dec = decV.map((g, v) => pairL(dtB, g, decN.filter((_, i) => i % decV.length === v)));
    meshes.decF = pairL(dtB, decFar, decFL);
    // spruces: detailed geometry for the row near the water, impostors beyond
    const conAll = gen(true, false, Math.round(Q.forest * 0.55)).concat(gen(true, true, Math.round(Q.far * 0.55)));
    const NEAR = Q.spruceLv > 14 ? 30 : 26, conNear = conAll.filter((r) => r[2] < NEAR), conImp = conAll.filter((r) => r[2] >= NEAR);
    meshes.con = conV.map(([tg, g], v) => pairL(tg, g, conNear.filter((_, i) => i % conV.length === v)));
    // ---- impostors: each of the first variants baked from 8 directions x 2 elevations into an atlas ----
    const nIV = Math.min(3, conV.length), F = Q.atlas >= 512 ? 160 : Q.atlas >= 320 ? 112 : 72, IW = 8.5, IH = 14.4, IPY = 5.4, Fh = Math.round(F * IH / IW);
    const rtOpt = { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true };
    const rtA = new THREE.WebGLRenderTarget(8 * F, 2 * nIV * Fh, { ...rtOpt, type: THREE.HalfFloatType });
    const rtN = new THREE.WebGLRenderTarget(8 * F, 2 * nIV * Fh, rtOpt);
    const quad = new THREE.PlaneGeometry(IW, IH, 1, 1), qn = quad.attributes.position.count;
    quad.setAttribute('sway', new THREE.Float32BufferAttribute(new Float32Array([0.27, 0.27, 0, 0]), 1)); // far spruces sway as a whole (top) quad.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(qn * 3).fill(1), 3));
    const impMat = (v) => {
      const m = patch(new THREE.MeshLambertMaterial({ vertexColors: true, alphaTest: 0.5, alphaToCoverage: !!Q.bloom }), 'imp' + v, 0.32, { FOLI: '' });
      const base = m.onBeforeCompile;
      m.customProgramCacheKey = () => 'imp' + v;
      m.onBeforeCompile = (sh) => {
        base(sh);
        sh.uniforms.tAlb = { value: rtA.texture }; sh.uniforms.tNrm = { value: rtN.texture }; sh.uniforms.uVar = { value: v }; sh.uniforms.uNIV = { value: nIV };
        const VAR = 'varying vec2 vImpUv; varying vec2 vK; varying float vBl, vRowB; varying mat3 vRot;\n';
        sh.vertexShader = VAR + sh.vertexShader.replace('#include <begin_vertex>', `vec3 transformed = vec3(position);
          {
            mat3 M = mat3(instanceMatrix);
            vec3 pivW = (modelMatrix * instanceMatrix * vec4(0.0, ${IPY.toFixed(2)}, 0.0, 1.0)).xyz;
            vec3 dl = normalize(inverse(M) * (cameraPosition - pivW));
            float az = atan(dl.z, dl.x); if (az < 0.0) az += 6.2831853;
            float fa = az / 6.2831853 * 8.0, k0 = floor(fa);
            vBl = fa - k0; vK = vec2(mod(k0, 8.0), mod(k0 + 1.0, 8.0));
            vRowB = smoothstep(0.12, 0.5, asin(clamp(dl.y, -1.0, 1.0)));
            vec3 rt = normalize(cross(vec3(0.0, 1.0, 0.0), dl)), upv = cross(dl, rt);
            transformed = vec3(0.0, ${IPY.toFixed(2)}, 0.0) + rt * position.x + upv * position.y;
            vRot = mat3(normalize(M[0]), normalize(M[1]), normalize(M[2]));
            vImpUv = uv;
          }`);
        sh.fragmentShader = VAR + 'uniform sampler2D tAlb, tNrm; uniform float uVar, uNIV;\nvec3 nTex;\n' + sh.fragmentShader.replace('#include <map_fragment>', `{
            float rows = 2.0 * uNIV;
            vec2 a0 = vec2((vK.x + vImpUv.x) / 8.0, (uVar * 2.0 + vImpUv.y) / rows), a1 = vec2((vK.y + vImpUv.x) / 8.0, a0.y);
            vec2 b0 = a0 + vec2(0.0, 1.0 / rows), b1 = a1 + vec2(0.0, 1.0 / rows);
            vec4 al = mix(mix(texture2D(tAlb, a0), texture2D(tAlb, a1), vBl), mix(texture2D(tAlb, b0), texture2D(tAlb, b1), vBl), vRowB);
            vec4 nn = mix(mix(texture2D(tNrm, a0), texture2D(tNrm, a1), vBl), mix(texture2D(tNrm, b0), texture2D(tNrm, b1), vBl), vRowB);
            nTex = normalize(nn.xyz / max(nn.a, 0.01) * 2.0 - 1.0);
            diffuseColor.rgb *= al.rgb / max(nn.a, 0.01); diffuseColor.a *= nn.a;
          }`).replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          normal = normalize((viewMatrix * vec4(vRot * nTex, 0.0)).xyz);`);
      };
      return m;
    };
    const impM = [];
    for (let v = 0; v < nIV; v++) impM.push(fromList(quad, impMat(v), conImp.filter((_, i) => i % nIV === v)));
    meshes.conImp = impM; meshes.impRT = [rtA, rtN, F, Fh];
    // bake on the GPU once the renderer is available
    world_bake = (renderer) => {
      const sc = new THREE.Scene(), cam = new THREE.OrthographicCamera(-IW / 2, IW / 2, IH / 2, -IH / 2, 1, 200);
      const map = FM.depth.map;
      const albF = new THREE.MeshBasicMaterial({ vertexColors: true, map, alphaTest: 0.5, side: THREE.DoubleSide }), albT = new THREE.MeshBasicMaterial({ vertexColors: true });
      const nrmSh = (useMap) => new THREE.ShaderMaterial({
        uniforms: { map: { value: map } }, side: THREE.DoubleSide,
        vertexShader: 'varying vec3 vN; varying vec2 vU; void main(){ vN = normal; ' + (useMap ? 'vU = uv;' : 'vU = vec2(0.0);') + ' gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'uniform sampler2D map; varying vec3 vN; varying vec2 vU; void main(){ ' + (useMap ? 'if (texture2D(map, vU).a < 0.5) discard; ' : '') + 'gl_FragColor = vec4(normalize(vN) * 0.5 + 0.5, 1.0); }',
      });
      const nrmF = nrmSh(true), nrmT = nrmSh(false);
      const prevRT = renderer.getRenderTarget(), prevCol = renderer.getClearColor(new THREE.Color()), prevA = renderer.getClearAlpha(), prevAuto = renderer.autoClear;
      renderer.autoClear = false;
      for (const [rt, fm, tm, cc] of [[rtA, albF, albT, [0, 0, 0]], [rtN, nrmF, nrmT, [0, 0, 0]]]) {
        renderer.setRenderTarget(rt); renderer.setClearColor(new THREE.Color(...cc), 0); rt.scissorTest = true;
        rt.scissor.set(0, 0, rt.width, rt.height); rt.viewport.set(0, 0, rt.width, rt.height); renderer.setRenderTarget(rt); renderer.clear(true, true);
        for (let v = 0; v < nIV; v++) {
          sc.clear(); const [tg, g] = conV[v]; sc.add(new THREE.Mesh(tg, tm), new THREE.Mesh(g, fm));
          for (let row = 0; row < 2; row++) for (let k = 0; k < 8; k++) {
            const az = k / 8 * Math.PI * 2, el = row ? 0.61 : 0.05, d = new V3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
            cam.position.set(0, IPY, 0).addScaledVector(d, 60); cam.up.set(0, 1, 0); cam.lookAt(0, IPY, 0); cam.updateMatrixWorld();
            rt.viewport.set(k * F, (v * 2 + row) * Fh, F, Fh); rt.scissor.copy(rt.viewport); renderer.setRenderTarget(rt);
            renderer.clear(true, true); renderer.render(sc, cam);
          }
        }
        rt.scissorTest = false; rt.viewport.set(0, 0, rt.width, rt.height);
      }
      renderer.setRenderTarget(prevRT); renderer.setClearColor(prevCol, prevA); renderer.autoClear = prevAuto;
      for (const m of [albF, albT, nrmF, nrmT]) m.dispose();
    };
    world_dispose = () => { rtA.dispose(); rtN.dispose(); };
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
      // Nymphaea pad, 1 m radius before scaling: notch to the centre, 22 edge points, slightly irregular rim
      const padGeo = (redRim) => {
        const NE = 22, notch = 0.2, pos = [], col = [], nor = [];
        const ring = (k, r, lift) => { const a = notch / 2 + k / NE * (Math.PI * 2 - notch); return [Math.cos(a) * r, lift, Math.sin(a) * r]; };
        const wob = Array.from({ length: NE + 1 }, () => 0.94 + R() * 0.08), lift = Array.from({ length: NE + 1 }, () => R() * 0.03);
        const cC = [1.12, 1.12, 1.0], cM = [1, 1, 1], cE = redRim ? [1.55, 0.72, 0.55] : [0.92, 0.95, 0.9];
        for (let k = 0; k < NE; k++) {
          const m0 = ring(k, 0.6 * wob[k], 0), m1 = ring(k + 1, 0.6 * wob[k + 1], 0), e0 = ring(k, wob[k], lift[k]), e1 = ring(k + 1, wob[k + 1], lift[k + 1]);
          const vein = k % 2 ? cM : [1.07, 1.07, 0.98];
          for (const [q, c] of [[[0, 0.004, 0], cC], [m1, vein], [m0, vein], [m0, vein], [m1, vein], [e1, cE], [m0, vein], [e1, cE], [e0, cE]]) { pos.push(...q); col.push(...c); nor.push(0, 1, 0); }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute('sway', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3), 1));
        return g;
      };
      // opaque, and pulled toward the camera in depth so the water plane never wins the depth test (no flicker)
      const padMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
      const pads = [], tint = new THREE.Color(), olive = C('#4a5e2c'), yel = C('#7a7038');
      // dense clumps: gaussian scatter around each spot, pads touch and overlap slightly
      const placePad = (d) => {
        for (let t = 0; t < 40; t++) {
          const s = spots[Math.floor(R() * spots.length)], rad = s[2];
          const gx = (R() + R() + R() - 1.5) * rad * 0.9, gz = (R() + R() + R() - 1.5) * rad * 0.7, x = s[0] + gx, z = s[1] + gz, h = H(x, z);
          if (h > -0.22 || h < -1.6 || onBar(x, z, 1.7)) continue;
          const r = 0.125 + R() * 0.075;
          if (pads.some(([a, b, rr]) => Math.hypot(a - x, b - z) < (r + rr) * 0.82)) continue;
          pads.push([x, z, r]);
          d.position.set(x, 0.025, z); d.rotation.set((R() - 0.5) * 0.04, R() * 6.28, (R() - 0.5) * 0.04); d.scale.set(r, 1, r);
          tint.copy(olive).offsetHSL((R() - 0.5) * 0.04, (R() - 0.5) * 0.1, (R() - 0.5) * 0.05);
          if (R() < 0.06) tint.lerp(yel, 0.3 + R() * 0.25);
          return tint;
        }
        return null;
      };
      spots.forEach((sp) => sp.push(1.6 + R() * 1.3));
      const nRed = Math.round(Q.lily * 0.3);
      meshes.pads = instanced(padGeo(false), padMat, Q.lily - nRed, placePad);
      meshes.padsR = instanced(padGeo(true), padMat, nRed, placePad);
      meshes.padsR.renderOrder = 3;
      meshes.pads.renderOrder = 3;
      // flowers: petals close at night (uOpen)
      const pos = [], col = [], sw = [], nor = [];
      for (let ring = 0; ring < 3; ring++) for (let k = 0; k < 8; k++) {
        const a = (k + ring * 0.5) / 8 * 6.283, r = [0.1, 0.08, 0.055][ring], w2 = [0.03, 0.026, 0.02][ring], y0 = 0.01 + ring * 0.014;
        const cx = Math.cos(a), cz = Math.sin(a), px = -cz, pz = cx;
        pos.push(px * w2, y0, pz * w2, -px * w2, y0, -pz * w2, cx * r, y0 + 0.03 + ring * 0.015, cz * r);
        for (let q = 0; q < 3; q++) { col.push(1, 1, 1); nor.push(0, 1, 0); } sw.push(0, 0, 1);
      }
      for (let k = 0; k < 6; k++) { const a = k / 6 * 6.283, b = (k + 1) / 6 * 6.283; pos.push(0, 0.03, 0, Math.cos(a) * 0.022, 0.028, Math.sin(a) * 0.022, Math.cos(b) * 0.022, 0.028, Math.sin(b) * 0.022); for (let q = 0; q < 3; q++) { col.push(1, 0.82, 0.2); nor.push(0, 1, 0); sw.push(0); } }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setAttribute('sway', new THREE.Float32BufferAttribute(sw, 1)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      const fMat = patch(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }), 'lily', 0, { LILY: '', NOFLIP: '' });
      const pinks = [C('#ffffff'), C('#fff4f8'), C('#ffc7dc')];
      meshes.lilies = instanced(g, fMat, Math.ceil(Q.lily / 10), (d) => {
        if (!pads.length) return null; const p = pads[Math.floor(R() * pads.length)];
        d.position.set(p[0] + (R() - 0.5) * 0.04, 0.03, p[1] + (R() - 0.5) * 0.04); d.rotation.set(0, R() * 6.28, 0); const bud = R() < 0.25, s = (bud ? 0.4 : 0.55) + R() * 0.17; d.scale.set(bud ? s * 0.55 : s, bud ? s * 1.6 : s, bud ? s * 0.55 : s);
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

  return { snakeBank, bar: Object.assign({ q: tbQ, frame: tbFrame, halfW: tbHalfW }, TB), bakeImpostors: (r) => world_bake(r), disposeExtra: () => world_dispose(), group, meshes, sandbar: sbC(), hwAt, SG, N, cliff: { x: cliffX, side: cliffSide, top: cliffTop, off: cliffOff }, horizonEl, horizonMtn, mh, H, Hmesh, islandE, mz, HW, zc0, irx, irz, trunks, rockList, flowerPts, reedPts, spawn, onIsland };
}

export function disposeGroup(g) {
  g.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
  });
}
export { lerp, sm };
