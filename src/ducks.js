import * as THREE from 'three';
import { rng } from './noise.js';
import { Acc } from './world.js';
import { patch, U } from './shaders.js';

// A small loose group of mallards. Boat-shaped body, separately animated head (gentle stroke bob,
// looking around, preening, dabbling), tail-up feeding, free group movement with stragglers.
export function createDucks(world, Q, scene) {
  const R = rng(9191), { H, N } = world, n = Q.ducks;
  const C = (h) => new THREE.Color(h), tmp = new THREE.Color();
  const V = THREE.Vector3;
  const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  // ---------- geometry ----------
  // lofted body: t=0 tail tip .. t=1 breast front; superelliptic cross-section (flat back)
  function bodyGeo() {
    const NU = 40, NV = 18, pos = [], idx = [], uv = [];
    // side profile and width (t: 0 = raised tail tip .. 1 = breast front), Catmull-Rom through samples
    const TT = [0, 0.08, 0.2, 0.4, 0.6, 0.78, 0.9, 0.95, 0.985, 1];
    const TOP = [0.105, 0.12, 0.132, 0.141, 0.14, 0.132, 0.117, 0.1, 0.08, 0.062];
    const BOT = [0.108, 0.062, 0.0, -0.045, -0.05, -0.042, -0.02, 0.0, 0.03, 0.06];
    const WID = [0.0, 0.04, 0.086, 0.114, 0.12, 0.112, 0.09, 0.07, 0.04, 0.0];
    const cr = (A, t) => {
      let k = 0; while (k < TT.length - 2 && t > TT[k + 1]) k++;
      const u = (t - TT[k]) / (TT[k + 1] - TT[k]), p0 = A[Math.max(0, k - 1)], p1 = A[k], p2 = A[k + 1], p3 = A[Math.min(A.length - 1, k + 2)];
      return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);
    };
    for (let i = 0; i <= NU; i++) {
      const t = i / NU, x = -0.29 + 0.5 * t;
      const tp = cr(TOP, t), bt = cr(BOT, t), yc = (tp + bt) / 2, ry = Math.max(0, (tp - bt) / 2), rz = Math.max(0, cr(WID, t));
      for (let j = 0; j <= NV; j++) {
        const a = j / NV * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        const e = 2.6, px = Math.sign(ca) * Math.pow(Math.abs(ca), 2 / e), py = Math.sign(sa) * Math.pow(Math.abs(sa), 2 / e);
        pos.push(x, yc + py * ry, px * rz);
        uv.push(t, j / NV);
      }
    }
    for (let i = 0; i < NU; i++) for (let j = 0; j < NV; j++) {
      const a = i * (NV + 1) + j, b = a + 1, c = a + NV + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals(); return g;
  }
  const PIVOT = new V(0.165, 0.085, 0), HY = 0.105; // neck base on the body

  function duckGeo(drake) {
    const body = new Acc(), head = new Acc();
    const hen = !drake;
    // --- body colours by region (t along body from the geometry x)
    const cBreast = C('#5b2f22'), cSide = C('#b8b4aa'), cBack = C('#7a6a5a'), cTert = C('#5a4636'), cRump = C('#141416'), cTail = C('#e6e4de'), cSpec = C('#2b3fa8'), cWhite = C('#f0eee8');
    const hBase = C('#9c7a52'), hDark = C('#5a4128'), hLight = C('#c4a378');
    const henPat = (v) => { // scalloped mottling
      const k = N.n2(v.x * 85, v.z * 85 + v.y * 60), k2 = N.n2(v.x * 170 + v.y * 90, v.z * 170 - v.y * 60) * 0.5 + 0.5;
      return tmp.copy(hBase).lerp(hDark, sm(0.15, 0.6, k) * 0.75).lerp(hLight, sm(0.6, 0.95, k2) * 0.5);
    };
    body.add(bodyGeo(), (v, nn) => {
      const t = (v.x + 0.29) / 0.5, side = Math.abs(v.z), top = nn.y;
      // speculum on the folded wing: blue patch edged white, on the upper side
      const spec = t > 0.33 && t < 0.42 && top > 0.42 && top < 0.62;
      const specEdge = spec && (t < 0.342 || t > 0.408);
      if (hen) {
        if (spec) return specEdge ? cWhite : cSpec;
        if (t < 0.1) return tmp.copy(hLight).multiplyScalar(1.05);
        henPat(v); if (top > 0.6) tmp.multiplyScalar(0.82); return tmp;
      }
      if (spec) return specEdge ? cWhite : cSpec;
      if (t < 0.05) return cTail;
      if (t < 0.17) return cRump;
      if (t > 0.74 && v.y > -0.005) return tmp.copy(cBreast).multiplyScalar(0.9 + 0.2 * N.n2(v.x * 60, v.y * 60));
      if (top > 0.82) return tmp.copy(cBack).multiplyScalar(0.92 + 0.15 * N.n2(v.x * 50, v.z * 50));
      if (top > 0.62 && t < 0.7) return tmp.copy(cTert).lerp(cSide, 0.35);
      return tmp.copy(cSide).multiplyScalar(0.94 + 0.1 * Math.sin(v.y * 900 + v.x * 200)); // fine vermiculation
    }, () => 0);
    if (drake) { // curled black feathers on the rump
      const curl = new THREE.TorusGeometry(0.011, 0.0035, 4, 10, Math.PI * 1.5).rotateZ(-0.6).translate(-0.225, 0.13, 0);
      body.add(curl, () => cRump, () => 0);
    }
    // --- head, built around the neck pivot (0,0,0)
    const cHeadG = C('#1d5c38'), cHeadG2 = C('#2f7a4c'), cBill = C(drake ? '#d2b84a' : '#c97a34'), cNail = C('#2a2620');
    const neck = new THREE.CylinderGeometry(0.027, 0.05, 0.11, 10, 4).translate(0, 0.045, 0).rotateZ(-0.15);
    head.add(neck, (v) => {
      if (drake) { if (Math.abs(v.y - 0.05) < 0.006) return cWhite; return v.y > 0.05 ? tmp.copy(cHeadG).lerp(cHeadG2, sm(-0.02, 0.03, v.z)) : cBreast; }
      return henPat(v);
    }, () => 0);
    const hg = new THREE.SphereGeometry(1, 16, 10);
    { const P = hg.attributes.position, v = new V();
      for (let i = 0; i < P.count; i++) {
        v.fromBufferAttribute(P, i);
        if (v.y > 0.2) v.y = 0.2 + (v.y - 0.2) * 0.55; // flat crown
        if (v.x > 0.3) v.y -= (v.x - 0.3) * 0.25;      // forehead slopes into the bill
        P.setXYZ(i, 0.06 + v.x * 0.058, HY + v.y * 0.038, v.z * 0.032);
      }
      hg.computeVertexNormals(); }
    head.add(hg, (v) => {
      if (drake) return tmp.copy(cHeadG).lerp(cHeadG2, sm(-0.01, 0.03, Math.abs(v.z)) * sm(HY - 0.015, HY + 0.015, v.y));
      // hen: dark crown and eye stripe on buff face
      const eye = Math.abs(v.y - HY - 0.002) < 0.0055 && v.x > 0.035;
      if (v.y > HY + 0.022 || eye) return tmp.copy(hDark).multiplyScalar(0.9);
      return tmp.copy(hLight).lerp(hBase, sm(0.0, 0.06, -v.x + 0.055) * 0.5);
    }, () => 0);
    // bill: long, flat, spatulate, slightly drooping, dark nail at the tip
    const bg = new THREE.SphereGeometry(1, 12, 6);
    { const P = bg.attributes.position, v = new V();
      for (let i = 0; i < P.count; i++) {
        v.fromBufferAttribute(P, i);
        const u = (v.x + 1) / 2; // 0 base .. 1 tip
        const w = 0.016 + 0.006 * Math.sin(Math.PI * Math.min(1, u * 1.1)), h = 0.011 * (1 - u * 0.55);
        P.setXYZ(i, 0.103 + u * 0.062, HY - 0.008 - u * 0.012 + v.y * h, v.z * w);
      }
      bg.computeVertexNormals(); }
    head.add(bg, (v) => (v.x > 0.157 ? cNail : drake ? cBill : (Math.abs(v.z) < 0.008 && v.y > HY - 0.012 && v.x > 0.115 ? cNail : cBill)), () => 0);
    for (const sd of [-1, 1]) head.add(new THREE.SphereGeometry(0.0055, 6, 4).translate(0.085, HY + 0.006, sd * 0.027), () => C('#0c0b0a'), () => 0);
    return { body: body.build(), head: head.build() };
  }
  const mat = patch(new THREE.MeshLambertMaterial({ vertexColors: true }), 'duck', 0); mat.transparent = true;
  const gD = duckGeo(true), gH = duckGeo(false), nh = Math.max(1, n - 1);
  const meshes = { db: new THREE.InstancedMesh(gD.body, mat, 1), dh: new THREE.InstancedMesh(gD.head, mat, 1), hb: new THREE.InstancedMesh(gH.body, mat, nh), hh: new THREE.InstancedMesh(gH.head, mat, nh) };
  for (const mm of Object.values(meshes)) { mm.frustumCulled = false; mm.renderOrder = 3; mm.castShadow = false; scene.add(mm); }
  const setM = (i, mb, mh) => { if (i === 0) { meshes.db.setMatrixAt(0, mb); meshes.dh.setMatrixAt(0, mh); } else { meshes.hb.setMatrixAt(i - 1, mb); meshes.hh.setMatrixAt(i - 1, mh); } };

  // ---------- behaviour ----------
  // The flock roams the whole reach (~150 m both ways): banks, backwaters at the reeds, open water, now and then
  // across the river. It lingers 1-4 min at a place, then moves on. The island is just one of the places.
  // Only the walking player scares it: alert at 12-15 m, swims off to 20-25 m at 8-10 m, then stays wary.
  // At night it gathers in a quiet backwater by the reeds and sleeps on the water.
  const wet = (x, z, d0 = -0.3, d1 = -1.4) => { const h = H(x, z); return h < d0 && h > d1; };
  const reedW = world.reedPts.filter((p) => world.islandE(p.x, p.z) > 1.6 && H(p.x, p.z) < 0.25);
  const reedAll = world.reedPts.filter((p) => H(p.x, p.z) < 0.25);
  // a water point next to a reed bed: step from the reeds toward the river middle until the water is 0.3-1.2 m deep
  const offReed = (p) => {
    const toMid = Math.sign(world.mz(p.x) - p.z) || 1;
    for (let k = 0; k < 14; k++) { const z = p.z + toMid * (1 + k * 0.8), x = p.x + (R() - 0.5) * 2; if (wet(x, z, -0.3, -1.2)) return new V(x, 0, z); }
    return null;
  };
  const sideOf = (p) => (p.z >= world.mz(p.x) ? 1 : -1);
  // the island is the flock's favourite place: shallows round its shore, the backwaters at its reeds, the calm
  // water by the tail bar; then the reeds and banks of the river, now and then open water
  const B = world.bar;
  const atBar = (s0, side, qq) => { const ax = B.ox + B.dx * s0 * B.len, az = B.oz + B.dz * s0 * B.len, off = side * qq * B.halfW(s0) + B.curl * s0 * s0; return new V(ax - B.dz * off, 0, az + B.dx * off); };
  // a resting place right at the sand of the bar (shallow water on its calm sides)
  const barRoost = (side) => {
    for (let t = 0; t < 200; t++) { const sd = side || (R() < 0.5 ? -1 : 1), c = atBar(0.3 + R() * 0.62, sd, 1.4 + R() * 1.2); if (wet(c.x, c.z, -0.2, -0.55)) { c.kind = 'bar'; c.side = sd; return c; } }
    return null;
  };
  const isleWater = () => {
    for (let t = 0; t < 60; t++) {
      if (R() < 0.25) { const c = atBar(0.2 + R() * 0.8, R() < 0.5 ? -1 : 1, 1.6 + R() * 1.4); if (wet(c.x, c.z, -0.2, -1.3)) return c; continue; }
      const an = R() * 6.283, dx = Math.cos(an), dz = Math.sin(an); let d = 4;
      while (d < 70 && H(dx * d, world.zc0 + dz * d) > -0.25) d += 0.5;
      d += 0.5 + R() * 5; const c = new V(dx * d, 0, world.zc0 + dz * d);
      if (wet(c.x, c.z, -0.25, -1.3)) return c;
    }
    return null;
  };
  // shallow water next to the nearest shore: somewhere to sleep without a long trip
  function shoreNear(p, maxR = 25) {
    for (let r = 3; r <= maxR; r += 2) for (let k = 0; k < 16; k++) {
      const a = k / 16 * 6.283 + r, x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
      if (!wet(x, z, -0.2, -0.7)) continue;
      let land = false; for (let j = 0; j < 8 && !land; j++) { const b = j * 0.785; if (H(x + Math.cos(b) * 2.5, z + Math.sin(b) * 2.5) > 0.05) land = true; }
      if (land) { const c = new V(x, 0, z); c.kind = 'shore'; return c; }
    }
    return null;
  }
  function pickSpot(from, o = {}) {
    const cam = o.cam, side0 = sideOf(from);
    for (let t = 0; t < 500; t++) {
      const r = R(); let c = null, kind;
      if (o.night) { // the tail bar when it is within reach (most nights), else a backwater at reeds nearby, else the shore
        if (r < 0.65 && t < 250) { c = barRoost(); kind = 'bar'; if (!c) continue; }
        else if (t < 400) { kind = 'reed'; const L = reedAll; if (!L.length) continue; c = offReed(L[Math.floor(R() * L.length)]); if (!c) continue; }
        else { kind = 'shore'; c = shoreNear(from, 60); if (!c) continue; }
      } else if (r < 0.37) { kind = 'isle'; c = isleWater(); if (!c) continue; }
      else if (r < 0.62) { kind = 'reed'; const rp = reedAll[Math.floor(R() * reedAll.length)]; if (!rp || Math.abs(rp.x) > 95) continue; c = offReed(rp); if (!c) continue; }
      else {
        kind = r < 0.9 ? 'bank' : 'open';
        const dir = Math.abs(from.x) > 45 && R() < 0.75 ? -Math.sign(from.x) : (R() < 0.5 ? -1 : 1), x = Math.max(-90, Math.min(90, from.x + dir * (20 + R() * 55)));
        const sd = R() < 0.3 ? -side0 : side0, hw = world.hwAt(x);
        const z = world.mz(x) + sd * (kind === 'bank' ? hw - 3 - R() * 7 : R() * hw * 0.75);
        if (!wet(x, z, -0.3, kind === 'bank' ? -1.4 : -9)) continue;
        c = new V(x, 0, z);
      }
      if (Math.abs(c.x) > 170) continue;
      const dFrom = c.distanceTo(from);
      if (dFrom < (o.near || o.night ? 6 : 18)) continue;
      if (dFrom > (o.night ? (c.kind === 'bar' ? 90 : 60) : 75)) continue;
      // never straight at the player
      if (cam && Math.hypot(c.x - cam.x, c.z - cam.z) < (o.night ? 9 : 6)) continue;
      if (o.away && (c.x - from.x) * o.away.x + (c.z - from.z) * o.away.z < 0) continue;
      c.kind = c.kind || kind; return c;
    }
    const sb = world.sandbar; const c = new V(sb[0] + 12, 0, sb[1]); c.kind = 'bank'; return c;
  }
  // straight-line water check (ducks never cut across land)
  const clear = (x, z, dx, dz, len) => { for (let s = 1; s <= len; s += 1) if (H(x + dx * s, z + dz * s) > -0.09) return false; return true; };
  // flee target: water 22-28 m from the player, roughly away from him, reachable in a straight line
  function fleeSpot(p, cam) {
    // water 10-12 m from the player, roughly away from him, reachable in a straight line, a few metres off any shore
    const ax = p.x - cam.x, az = p.z - cam.z, a0 = Math.atan2(az, ax), want = 10.5 + R() * 1.5;
    let best = null, bs = -1e9;
    for (let t = 0; t < 48; t++) {
      const a = a0 + (R() * 2 - 1) * 1.4, dx = Math.cos(a), dz = Math.sin(a);
      let len = 0; while (len < 16 && H(p.x + dx * (len + 0.5), p.z + dz * (len + 0.5)) < -0.09 && Math.hypot(p.x + dx * len - cam.x, p.z + dz * len - cam.z) < want) len += 0.5;
      const q = new V(p.x + dx * len, 0, p.z + dz * len), dc = Math.hypot(q.x - cam.x, q.z - cam.z);
      let open = 6; for (let j = 0; j < 8; j++) { const b2 = j * 0.785, ex = Math.cos(b2), ez = Math.sin(b2); let r = 0.5; while (r < 6 && H(q.x + ex * r, q.z + ez * r) < 0) r += 0.5; open = Math.min(open, r); }
      const sc = -Math.abs(dc - want) * 1.2 - Math.abs(Math.atan2(Math.sin(a - a0), Math.cos(a - a0))) * 1.0 + open * 0.7;
      if (sc > bs) { bs = sc; best = q; }
    }
    // cornered (a cove, the shallows by the bar): water further off, reached round the obstacle by the steering
    if (!best || Math.hypot(best.x - cam.x, best.z - cam.z) < want - 2.5) {
      let b2 = null, s2 = -1e9;
      for (let t = 0; t < 120; t++) {
        const a = R() * 6.283, r = 6 + R() * 16, x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
        if (!wet(x, z, -0.25, -9)) continue;
        const dc = Math.hypot(x - cam.x, z - cam.z); if (dc < 10) continue;
        const sc = -Math.abs(dc - 13) - r * 0.25 + ((x - p.x) * ax + (z - p.z) * az) / Math.max(1e-3, Math.hypot(ax, az) * r) * 2;
        if (sc > s2) { s2 = sc; b2 = new V(x, 0, z); }
      }
      if (b2) best = b2;
    }
    return best;
  }
  // coarse water map (2 m cells, columns along x, rows across the river relative to its axis) and a distance field
  // from the leader: a duck cut off by land walks down the field round the island, the bar or a spit
  const GC = 2, GX0 = -184, GNX = 185, GNR = 71, GR0 = 35;
  const gWater = new Uint8Array(GNX * GNR);
  for (let i = 0; i < GNX; i++) { const x = GX0 + i * GC, m = world.mz(x); for (let r = 0; r < GNR; r++) gWater[i * GNR + r] = H(x, m + (r - GR0) * GC) < -0.1 ? 1 : 0; }
  const cellOf = (x, z) => { const i = Math.round((x - GX0) / GC); if (i < 0 || i >= GNX) return -1; const r = Math.round((z - world.mz(GX0 + i * GC)) / GC) + GR0; return r < 0 || r >= GNR ? -1 : i * GNR + r; };
  const cellPos = (c) => { const i = Math.floor(c / GNR), r = c % GNR, x = GX0 + i * GC; return new V(x, 0, world.mz(x) + (r - GR0) * GC); };
  const gDist = new Float32Array(GNX * GNR), gQ = new Int32Array(GNX * GNR); let gSrc = null, gT = -1e9;
  function field(src, t) {
    if (gSrc && gSrc.distanceTo(src) < 3 && t - gT < 4) return;
    gSrc = src.clone(); gT = t; gDist.fill(1e9);
    let c0 = cellOf(src.x, src.z); if (c0 < 0) return;
    if (!gWater[c0]) { // the source sits in the shallows: start from the nearest water cell
      let best = -1, bd = 1e9; const i0 = Math.floor(c0 / GNR), r0 = c0 % GNR;
      for (let di = -3; di <= 3; di++) for (let dr = -3; dr <= 3; dr++) { const i = i0 + di, r = r0 + dr; if (i < 0 || i >= GNX || r < 0 || r >= GNR) continue; const c = i * GNR + r; if (gWater[c] && di * di + dr * dr < bd) { bd = di * di + dr * dr; best = c; } }
      if (best < 0) return; c0 = best;
    }
    let h = 0, tl = 0; gQ[tl++] = c0; gDist[c0] = 0;
    while (h < tl) {
      const c = gQ[h++], i = Math.floor(c / GNR), r = c % GNR, x = GX0 + i * GC, z = world.mz(x) + (r - GR0) * GC;
      for (let di = -1; di <= 1; di++) {
        const ii = i + di; if (ii < 0 || ii >= GNX) continue;
        const rr0 = Math.round((z - world.mz(GX0 + ii * GC)) / GC) + GR0;
        for (let dr = -1; dr <= 1; dr++) {
          if (!di && !dr) continue; const rr = rr0 + dr; if (rr < 0 || rr >= GNR) continue;
          const n2 = ii * GNR + rr; if (!gWater[n2]) continue;
          const nd = gDist[c] + (di && dr ? 1.414 : 1); if (nd < gDist[n2]) { gDist[n2] = nd; gQ[tl++] = n2; }
        }
      }
    }
  }
  // a few cells down the field from p: the way round the obstacle
  function wayOut(p) {
    let c = cellOf(p.x, p.z); if (c < 0) return null;
    if (!gWater[c] || gDist[c] >= 1e9) { // standing in the shallows: the best water cell around
      let best = -1, bd = 1e9; const i0 = Math.floor(c / GNR), r0 = c % GNR;
      for (let di = -2; di <= 2; di++) for (let dr = -2; dr <= 2; dr++) { const i = i0 + di, r = r0 + dr; if (i < 0 || i >= GNX || r < 0 || r >= GNR) continue; const q2 = i * GNR + r; if (gWater[q2] && gDist[q2] < bd) { bd = gDist[q2]; best = q2; } }
      if (best < 0) return null; return cellPos(best);
    }
    for (let step = 0; step < 3; step++) {
      const i = Math.floor(c / GNR), r = c % GNR, x = GX0 + i * GC, z = world.mz(x) + (r - GR0) * GC; let best = c;
      for (let di = -1; di <= 1; di++) { const ii = i + di; if (ii < 0 || ii >= GNX) continue; const rr0 = Math.round((z - world.mz(GX0 + ii * GC)) / GC) + GR0;
        for (let dr = -1; dr <= 1; dr++) { const rr = rr0 + dr; if (rr < 0 || rr >= GNR) continue; const n2 = ii * GNR + rr; if (gWater[n2] && gDist[n2] < gDist[best]) best = n2; } }
      if (best === c) break; c = best;
    }
    return cellPos(c);
  }
  const start = pickSpot(new V((R() * 2 - 1) * 120, 0, 0), { near: true });
  const leader = {
    p: start.clone(), tgt: start.clone(), home: start.clone(), dir: new V(1, 0, 0), v: new V(), ph: R() * 10,
    st: 'linger', stT: 30 + R() * 120, sub: 0, pause: 0, nextPause: 20 + R() * 30, prog: 0, progP: start.clone(),
    wary: 0, alert: 0, quackT: 60 + R() * 120, turnS: 1, visits: [], trail: [],
  };
  const ducks = Array.from({ length: n }, (_, i) => {
    const a = R() * 6.28;
    return {
      p: leader.p.clone().add(new V(Math.cos(a) * (0.5 + i * 0.4), 0, Math.sin(a) * (0.5 + i * 0.4))), v: new V(), yaw: R() * 6.28,
      off: new V((R() - 0.5) * 2, 0, (R() - 0.5) * 2), offT: new V(), offTime: 0, ph: R() * 100, stroke: R() * 6, sp: 1,
      act: 'swim', actT: 3 + R() * 10, actDur: 0, hYaw: 0, hYawT: 0, hPitch: 0, look: 2 + R() * 4,
      pitch: 0, s: 1, upAmt: 0, stray: 0, roll: 0, viaT: 0, via: null, tuck: 0, tuckDelay: R() * 40, tuckSide: R() < 0.5 ? -1 : 1,
    };
  });
  let night = false, prevEl = null;
  const mb = new THREE.Matrix4(), mh = new THREE.Matrix4(), mloc = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new V(), tv = new V(), fw = new V();
  const approach = (a, b, r) => a + (b - a) * Math.min(1, r);
  const DIRS = [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.45, -1.45, 1.9, -1.9, 2.4, -2.4, 3.0];
  const go = (tgt, st) => { leader.tgtKind = tgt.kind; leader.tgtSide = tgt.side; leader.tgt.copy(tgt); leader.home.copy(tgt); leader.st = st; leader.prog = 0; leader.progP.copy(leader.p); };

  function update(dt, t, env) {
    dt = Math.min(dt, 0.1);
    const L = leader, cam = env.cam || null;
    // ---- the player (walking only): nearest duck distance
    let dmin = 1e9;
    if (cam) for (const k of ducks) dmin = Math.min(dmin, Math.hypot(k.p.x - cam.x, k.p.z - cam.z));
    // bedtime starts at sunset (the flock is at its roost by full dark) and ends at dawn twilight
    // (evening: the sun sinking below +3 deg; morning: the sun rising above -5 deg)
    let wantNight;
    if (env.el === undefined) wantNight = env.night > 0.6;
    else { const el = env.el, rising = prevEl !== null && el > prevEl; prevEl = el; wantNight = night ? !(rising && el > -5) : (!rising && el < 3); }
    if (wantNight && !night) { night = true; L.napped = false; if (L.st !== 'flee') go(pickSpot(L.p, { night: true, cam, near: true }), 'roost'); }
    if (!wantNight && night) { night = false; if (L.st === 'sleep' || L.st === 'roost') { L.st = 'wake'; L.stT = 25 + R() * 40; } }
    L.wary = Math.max(0, L.wary - dt);
    // alarm: swim off when the player comes closer than 4-5 m (3 m if he crouches or stands still); wakes a sleeping flock
    const fleeR = env.calm ? 3 : 4 + (N.n2(t * 0.02, 5.5) * 0.5 + 0.5);
    if (cam && dmin < fleeR && L.st !== 'flee') {
      const f = fleeSpot(L.p, cam); if (f) {
        go(f, 'flee'); L.stT = 15; L.wary = 20 + R() * 20; L.fleeFrom = new V(cam.x, 0, cam.z);
        if (R() < 0.65 && env.quack) env.quack(L.p.x, L.p.z, 3 + Math.floor(R() * 4), 1);
        for (const k of ducks) { k.act = 'swim'; k.actT = 6 + R() * 6; k.tuck = Math.min(k.tuck, 0.3); }
      }
    }
    const alertNow = cam && dmin < 10 + 2 * (N.n2(t * 0.03, 8.1) * 0.5 + 0.5) + (L.wary > 0 ? 3 : 0);
    L.alert = approach(L.alert, alertNow || L.st === 'flee' ? 1 : 0, dt * (alertNow ? 2 : 0.3));
    // ---- states
    L.stT -= dt;
    let lsp = 0, moving = false;
    tv.subVectors(L.tgt, L.p); const d = tv.length();
    if (L.st === 'flee') {
      moving = d > 1; lsp = 0.95;
      if (!moving || L.stT < 0) {
        // keep going if the player is still close, else settle down warily
        if (cam && dmin < 7) { const f = fleeSpot(L.p, cam); if (f && f.distanceTo(L.p) > 2) { go(f, 'flee'); L.stT = 12; } else { L.st = 'linger'; L.stT = 20; L.home.copy(L.p); L.tgt.copy(L.p); } }
        // settle down warily where they are (at night: wait 1-2 min, then go back to sleep)
        else { L.st = 'linger'; L.stT = night ? 60 + R() * 60 : 30 + R() * 40; L.home.copy(L.p); L.tgt.copy(L.p); }
      }
    } else if (L.st === 'travel' || L.st === 'roost') {
      moving = d > 1.2; lsp = (L.st === 'roost' ? 0.45 : 0.32) * (0.8 + 0.4 * (N.n2(t * 0.05 + L.ph, 3.1) * 0.5 + 0.5));
      if (alertNow) lsp *= 0.6;
      if (!moving) { if (L.st === 'roost') { L.st = 'sleep'; L.home.copy(L.p); L.roostP = L.tgt.clone(); L.roostP.kind = L.tgtKind; L.roostP.side = L.tgtSide; } else { L.st = 'linger'; L.stT = 80 + R() * 160; L.home.copy(L.p); } L.visits.push([t, L.p.x, L.p.z]); }
      // full dark and still far from the roost: settle at the nearest shore instead
      if (L.st === 'roost' && env.night > 0.9 && d > 25 && !L.napped) { L.napped = true; const c = shoreNear(L.p, 25); if (c) go(c, 'roost'); }
      // no progress for a long time (blocked) -> another place; going to roost: close enough is good enough
      L.prog += dt; L.roostT = L.st === 'roost' ? (L.roostT || 0) + dt : 0;
      if (L.st === 'roost' && (L.roostT > 150 || (env.night > 0.95 && L.roostT > 40 && d > 15)) && !L.napped) { L.napped = true; const c = shoreNear(L.p, 20); if (c) go(c, 'roost'); else { L.st = 'sleep'; L.home.copy(L.p); L.roostP = L.p.clone(); } }
      if (L.prog > (L.st === 'roost' ? 20 : 40)) {
        if (L.p.distanceTo(L.progP) < 4) {
          if (L.st === 'roost' && (d < 8 || L.napped)) { L.st = 'sleep'; L.home.copy(L.p); L.roostP = L.p.clone(); L.roostP.kind = L.tgtKind; }
          else go(pickSpot(L.p, { night, cam }), L.st);
        }
        L.prog = 0; L.progP.copy(L.p);
      }
    } else if (L.st === 'linger') {
      // potter about the place: short hops around it with feeding pauses
      L.nextPause -= dt;
      if (!alertNow && L.nextPause < 0 && L.pause <= 0) { L.pause = 8 + R() * 16; L.nextPause = 18 + R() * 30; }
      if (L.pause > 0) L.pause -= dt;
      else if (d < 0.6) { for (let k = 0; k < 20; k++) { const a = R() * 6.28, r = 1 + R() * 4, x = L.home.x + Math.cos(a) * r, z = L.home.z + Math.sin(a) * r; if (wet(x, z, -0.25, -9) && (!cam || Math.hypot(x - cam.x, z - cam.z) > 7)) { L.tgt.set(x, 0, z); break; } } }
      else { moving = true; lsp = 0.12; }
      if (L.stT < 0 && !alertNow && night) {
        // back to sleep: the same place if the player has gone, else the other side of the bar or another backwater
        const rp = L.roostP, far = (q) => !cam || Math.hypot(q.x - cam.x, q.z - cam.z) > 12;
        let nt = rp && far(rp) ? rp : null;
        if (!nt && rp && rp.kind === 'bar') { const alt = barRoost(-rp.side); if (alt && far(alt)) nt = alt; }
        go(nt || pickSpot(L.p, { night: true, cam }), 'roost');
      } else if (L.stT < 0 && !alertNow) go(pickSpot(L.p, { cam, away: L.wary > 0 && L.fleeFrom ? tv.set(L.p.x - L.fleeFrom.x, 0, L.p.z - L.fleeFrom.z) : null }), 'travel');
    } else if (L.st === 'wake') {
      if (L.stT < 0) go(pickSpot(L.p, { cam }), 'travel');
    }
    // the player walking up to where the flock is heading: pick another place
    if (cam && (L.st === 'travel' || L.st === 'roost') && Math.hypot(L.tgt.x - cam.x, L.tgt.z - cam.z) < (L.st === 'roost' ? 9 : 6)) go(pickSpot(L.p, { night: L.st === 'roost', cam }), L.st);
    // ---- steering around land: probe ahead and turn to the first free direction
    if (moving && d > 1e-3) {
      tv.normalize(); const a0 = Math.atan2(tv.z, tv.x); let ok = null;
      const look = Math.min(6, d);
      for (const da0 of DIRS) {
        const da = da0 * (da0 ? L.turnS : 1), a = a0 + da, dx = Math.cos(a), dz = Math.sin(a);
        if (clear(L.p.x, L.p.z, dx, dz, look)) { ok = [dx, dz]; if (da0) L.turnS = Math.sign(da); break; }
      }
      if (!ok) { L.turnS = -L.turnS; ok = [-L.dir.x, -L.dir.z]; }
      tv.set(ok[0], 0, ok[1]); L.dir.lerp(tv, Math.min(1, dt * (L.st === 'flee' ? 2.5 : 0.8))).normalize();
      const nx = L.p.x + L.dir.x * lsp * dt, nz = L.p.z + L.dir.z * lsp * dt;
      if (H(nx, nz) < -0.08 || H(nx, nz) < H(L.p.x, L.p.z) - 1e-4) { L.p.x = nx; L.p.z = nz; } else { lsp = 0; L.turnS = -L.turnS; }
    } else lsp = 0;
    L.v.copy(L.dir).multiplyScalar(lsp);
    // breadcrumbs of the leader's way: a duck cut off by land follows them round the obstacle
    { const tr = L.trail, lt = tr[tr.length - 1]; if (!lt || Math.hypot(lt.x - L.p.x, lt.z - L.p.z) > 1.5) { tr.push(L.p.clone()); if (tr.length > 220) tr.shift(); } }
    // rare quiet quacks by day
    L.quackT -= dt;
    if (L.quackT < 0) { L.quackT = 90 + R() * 240; if (!night && L.st !== 'sleep' && env.quack) env.quack(L.p.x, L.p.z, 2 + Math.floor(R() * 3), 0.6); }
    const sleeping = L.st === 'sleep', fleeing = L.st === 'flee', alert = L.alert;
    const side = new V(-leader.dir.z, 0, leader.dir.x);
    // look direction toward the player (alert heads turn to him now and then)
    for (let i = 0; i < n; i++) {
      const k = ducks[i];
      // personal place in the group: a slowly wandering offset around the leader, sometimes a straggler drifts off;
      // alert or fleeing birds bunch up, sleeping ones lie close together
      k.offTime -= dt;
      if (k.offTime <= 0) {
        if (sleeping) { const a = R() * 6.28, r = 0.35 + R() * 0.25 * n; k.stray = 0; k.offT.set(Math.cos(a) * r, 0, Math.sin(a) * r); k.offTime = 40 + R() * 60; }
        else if (alert > 0.5 || fleeing) { k.stray = 0; k.offT.set((R() - 0.5) * 1.4, 0, -0.3 - R() * (0.4 + i * 0.25)); k.offTime = 4 + R() * 5; }
        else if (!night && R() < 0.22) { k.stray = 1; k.offT.set((R() < 0.5 ? -1 : 1) * (2.2 + R() * 2), 0, -(R() * 2.5)); k.offTime = 10 + R() * 12; }
        else { k.stray = 0; k.offT.set((R() - 0.5) * 2.2, 0, -0.4 - R() * (0.6 + i * 0.35)); k.offTime = 6 + R() * 10; }
      }
      if ((alert > 0.5 || fleeing) && k.stray) { k.stray = 0; k.offTime = 0; }
      k.off.lerp(k.offT, Math.min(1, dt * (fleeing ? 0.6 : 0.15)));
      let goal = sleeping ? leader.home.clone().add(k.off) : leader.p.clone().addScaledVector(side, k.off.x).addScaledVector(leader.dir, k.off.z);
      if (i === 0 && n > 1 && !sleeping) goal.lerp(leader.p, 0.6);
      // cut off from the goal by land: head for the furthest point of the leader's trail that is in plain sight
      k.viaT -= dt;
      if (k.viaT <= 0) {
        k.viaT = 0.5 + R() * 0.3; k.via = null;
        const gx = goal.x - k.p.x, gz = goal.z - k.p.z, gd = Math.hypot(gx, gz);
        if (gd > 2.5 && !clear(k.p.x, k.p.z, gx / gd, gz / gd, gd)) {
          field(sleeping ? leader.home : leader.p, t); k.via = wayOut(k.p);
        }
      }
      if (k.via) goal = k.via.clone();
      // desired velocity: steer to the goal, keep personal pace, avoid crowding
      const des = tv.subVectors(goal, k.p);
      const dist = des.length();
      const catchUp = dist > 1.5 ? (fleeing ? 2.2 : 1.6) : 1;
      k.sp = 0.85 + 0.3 * N.n2(t * 0.08 + k.ph, 7.7);
      const vmax = fleeing ? 1.25 : sleeping ? 0.08 : 0.55;
      let want = Math.min(vmax, dist * (sleeping ? 0.15 : 0.35)) * k.sp * catchUp;
      if (k.act === 'upend' || k.act === 'dabble') want *= 0.1;
      if (dist > 1e-3) des.multiplyScalar(want / dist); else des.set(0, 0, 0);
      des.addScaledVector(leader.v, dist < 1.5 ? 0.6 : 0.2);
      // a duck the player has walked right up to shies away at once, without waiting for the flock
      if (env.cam) { const ex = k.p.x - env.cam.x, ez = k.p.z - env.cam.z, ed = Math.hypot(ex, ez); if (ed < 4.5 && ed > 1e-3) { const f = (4.5 - ed) / 4.5 * 1.4; des.x += ex / ed * f; des.z += ez / ed * f; } }
      const sep = sleeping ? 0.38 : 0.55;
      for (let j = 0; j < n; j++) {
        if (j === i) continue; const o = ducks[j], dx = k.p.x - o.p.x, dz = k.p.z - o.p.z, dd = Math.hypot(dx, dz);
        if (dd < sep && dd > 1e-4) { const f = (sep - dd) / sep * 0.5; des.x += dx / dd * f; des.z += dz / dd * f; }
      }
      // accelerate toward the desired velocity (hard paddling when fleeing)
      const acc = (fleeing || (env.cam && Math.hypot(k.p.x - env.cam.x, k.p.z - env.cam.z) < 4.5) ? 1.4 : 0.35) * dt; tv.set(des.x - k.v.x, 0, des.z - k.v.z); const al = tv.length(); if (al > acc) tv.multiplyScalar(acc / al);
      k.v.add(tv);
      const spd = k.v.length();
      // strokes: speed pulses slightly with each paddle
      k.stroke += dt * (4.5 + spd * 9);
      const pulse = 1 + 0.12 * Math.sin(k.stroke) * Math.min(1, spd / 0.15);
      const nx = k.p.x + k.v.x * pulse * dt, nz = k.p.z + k.v.z * pulse * dt;
      const hn = H(nx, nz), h0 = H(k.p.x, k.p.z);
      if (hn < -0.08 || hn < h0 - 1e-4) { k.p.x = nx; k.p.z = nz; }
      else { // slide along the shore: the nearest turn of the heading that is open water
        let moved = false;
        for (const da of [0.5, -0.5, 1.0, -1.0, 1.6, -1.6, 2.3, -2.3]) {
          const c = Math.cos(da), sn = Math.sin(da), vx = (k.v.x * c - k.v.z * sn) * pulse * dt, vz = (k.v.x * sn + k.v.z * c) * pulse * dt;
          if (H(k.p.x + vx, k.p.z + vz) < -0.08) { k.p.x += vx; k.p.z += vz; k.v.set(vx / (pulse * dt), 0, vz / (pulse * dt)); moved = true; break; }
        }
        if (!moved) k.v.multiplyScalar(0.5);
      }
      // heading turns smoothly toward the motion (a sleeping bird turns very slowly)
      if (spd > (sleeping ? 0.02 : 0.04)) {
        const ty = Math.atan2(-k.v.z, k.v.x); let dy = ty - k.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        const tr = (fleeing ? 2.2 : sleeping ? 0.15 : 1.1) * dt;
        k.yaw += Math.max(-tr, Math.min(tr, dy));
      }
      // activities: look around, preen, dabble, tail-up feeding (not when alert, fleeing or asleep)
      k.actT -= dt;
      const busy = alert > 0.4 || fleeing || sleeping || night;
      if (k.act === 'swim' && k.actT <= 0 && !busy) {
        const r = R(), calm = spd < 0.26;
        if (r < 0.3 && calm) { k.act = 'upend'; k.actDur = 2 + R() * 2; env.ripple(k.p.x + Math.cos(k.yaw) * 0.15, k.p.z - Math.sin(k.yaw) * 0.15, 0.25); }
        else if (r < 0.6) { k.act = 'dabble'; k.actDur = 1.5 + R() * 2; }
        else if (r < 0.8 && calm) { k.act = 'preen'; k.actDur = 2 + R() * 2.5; k.hYawT = (R() < 0.5 ? -1 : 1) * 2.5; }
        else { k.actT = 2 + R() * 4; }
        if (k.act !== 'swim') k.actT = k.actDur;
      } else if (k.act !== 'swim' && (k.actT <= 0 || (busy && k.act !== 'preen') || fleeing)) {
        if (k.act === 'upend') env.ripple(k.p.x + Math.cos(k.yaw) * 0.15, k.p.z - Math.sin(k.yaw) * 0.15, 0.2);
        k.act = 'swim'; k.actT = (k.stray ? 3 : 6) + R() * 12; k.hYawT = 0;
      }
      // waking up in the morning: a short preen now and then
      if (leader.st === 'wake' && k.act === 'swim' && k.tuck < 0.1 && R() < dt * 0.08) { k.act = 'preen'; k.actDur = 2 + R() * 3; k.actT = k.actDur; k.hYawT = (R() < 0.5 ? -1 : 1) * 2.5; }
      k.look -= dt;
      if (k.act === 'swim' && k.look <= 0) {
        if (alert > 0.5 && env.cam && R() < 0.5) { // glance at the player
          const ay = Math.atan2(-(env.cam.z - k.p.z), env.cam.x - k.p.x); let dy = ay - k.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
          k.hYawT = Math.max(-1.3, Math.min(1.3, dy));
        } else k.hYawT = R() < 0.4 ? 0 : (R() - 0.5) * 1.3;
        k.look = alert > 0.5 ? 0.6 + R() * 1.2 : 1 + R() * 3;
      }
      // sleep: head turned back and laid on the back, bill under the wing (each bird tucks in at its own moment)
      if (sleeping) k.tuckDelay -= dt;
      const tuckT = sleeping && k.tuckDelay < 0 && alert < 0.5 ? 1 : 0;
      if (!sleeping) k.tuckDelay = 5 + R() * 40;
      k.tuck = approach(k.tuck, tuckT, dt * (tuckT ? 0.5 : 0.35));
      // targets for body pitch / head pose
      const up = k.act === 'upend' ? 1 : 0;
      k.upAmt = approach(k.upAmt, up, dt * 3.5);
      const hp = k.act === 'dabble' ? 1.1 : k.act === 'preen' ? 0.35 : -0.22 * alert; // alert: head held high
      k.hPitch = approach(k.hPitch, hp, dt * 4);
      k.hYaw = approach(k.hYaw, k.hYawT, dt * (k.act === 'preen' ? 3 : alert > 0.5 ? 4 : 2.2));
      k.roll = 0.025 * Math.sin(k.stroke) * Math.min(1, spd / 0.2);
      // body transform: bobbing on the water, tail-up feeding tips the body forward around its middle
      const y = Math.sin(t * (sleeping ? 1.1 : 2) + k.ph) * 0.006 - 0.018 - k.upAmt * 0.05;
      e.set(k.roll + Math.sin(t * 0.7 + k.ph) * 0.015 * k.tuck, k.yaw, -k.upAmt * 1.25, 'YZX'); q.setFromEuler(e);
      mb.compose(new V(k.p.x, y, k.p.z), q, sc.set(1, 1, 1));
      // head: gentle forward-back stroke bob (small amplitude), turns, dips; tucked: turned ~170 deg, lowered onto the back
      const bob = Math.sin(k.stroke) * (0.004 + 0.008 * Math.min(1, spd / 0.3)) * (k.act === 'swim' ? 1 : 0.2) * (1 - k.tuck);
      const tk = k.tuck * k.tuck * (3 - 2 * k.tuck);
      const hyaw = k.hYaw * (1 - tk) + k.tuckSide * 2.95 * tk, hpit = (k.hPitch + k.upAmt * 0.5) * (1 - tk) + 0.3 * tk;
      e.set(0, hyaw, -hpit, 'YZX'); q.setFromEuler(e);
      mloc.compose(new V(PIVOT.x + bob - 0.03 * tk, PIVOT.y + 0.004 * tk, 0), q, sc.set(1, 1 - 0.2 * tk, 1));
      mh.multiplyMatrices(mb, mloc);
      setM(i, mb, mh);
      // wake data for the water shader
      if (i < 6) {
        fw.set(Math.cos(k.yaw), 0, -Math.sin(k.yaw));
        U.uDuck.value[i].set(k.p.x, k.p.z, fw.x * spd, fw.z * spd);
      }
    }
    for (let i = n; i < 6; i++) U.uDuck.value[i].set(0, 0, 0, 0);
    for (const mm of Object.values(meshes)) mm.instanceMatrix.needsUpdate = true;
  }
  function dispose() { for (const mm of Object.values(meshes)) { mm.geometry.dispose(); scene.remove(mm); } mat.dispose(); for (const v of U.uDuck.value) v.set(0, 0, 0, 0); }
  return { update, dispose, pos: () => leader.p, dir: () => leader.dir, list: () => ducks, leader, get state() { return leader.st; } };
}
