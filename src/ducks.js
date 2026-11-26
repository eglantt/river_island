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
  const water = (x, z) => { const h = H(x, z); return h < -0.3 && h > -1.4; };
  const spot = () => {
    for (let t = 0; t < 400; t++) {
      const x = (R() * 2 - 1) * 140, z = world.mz(x) + (R() < 0.5 ? -1 : 1) * (world.hwAt(x) - 4 - R() * 10);
      if (water(x, z)) return new V(x, 0, z);
    }
    return new V(world.sandbar[0] + 10, 0, world.sandbar[1]);
  };
  const roost = () => {
    const pts = world.reedPts.filter((p) => H(p.x, p.z) < -0.05);
    if (pts.length) { const p = pts[Math.floor(R() * pts.length)]; return new V(p.x, 0, p.z); }
    return spot();
  };
  const leader = { p: spot(), tgt: spot(), dir: new V(1, 0, 0), v: new V(), pause: 0, nextPause: 20 + R() * 30, ph: R() * 10 };
  const ducks = Array.from({ length: n }, (_, i) => {
    const a = R() * 6.28;
    return {
      p: leader.p.clone().add(new V(Math.cos(a) * (0.5 + i * 0.4), 0, Math.sin(a) * (0.5 + i * 0.4))), v: new V(), yaw: R() * 6.28,
      off: new V((R() - 0.5) * 2, 0, (R() - 0.5) * 2), offT: new V(), offTime: 0, ph: R() * 100, stroke: R() * 6, sp: 1,
      act: 'swim', actT: 3 + R() * 10, actDur: 0, hYaw: 0, hYawT: 0, hPitch: 0, look: 2 + R() * 4,
      pitch: 0, s: 1, upAmt: 0, stray: 0, roll: 0,
    };
  });
  let night = false, roostP = null;
  const mb = new THREE.Matrix4(), mh = new THREE.Matrix4(), mloc = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new V(), tv = new V(), fw = new V();
  const approach = (a, b, r) => a + (b - a) * Math.min(1, r);

  function update(dt, t, env) {
    dt = Math.min(dt, 0.1);
    const wantNight = env.night > 0.6;
    if (wantNight && !night) { night = true; roostP = roost(); leader.tgt.copy(roostP); }
    if (!wantNight && night) { night = false; leader.tgt.copy(spot()); }
    // leader: wanders between spots with varying pace and occasional feeding pauses
    leader.nextPause -= dt;
    if (!night && leader.nextPause < 0 && leader.pause <= 0) { leader.pause = 6 + R() * 14; leader.nextPause = 25 + R() * 40; }
    tv.subVectors(leader.tgt, leader.p); const d = tv.length();
    let lsp = 0;
    if (leader.pause > 0) leader.pause -= dt;
    else if (d < 0.8) { if (!night) leader.tgt.copy(spot()); }
    else {
      tv.normalize(); leader.dir.lerp(tv, Math.min(1, dt * 0.5)).normalize();
      lsp = 0.3 * (0.75 + 0.5 * (N.n2(t * 0.05 + leader.ph, 3.1) * 0.5 + 0.5));
      const nx = leader.p.x + leader.dir.x * lsp * dt, nz = leader.p.z + leader.dir.z * lsp * dt;
      if (H(nx, nz) < -0.15) { leader.p.x = nx; leader.p.z = nz; } else leader.tgt.copy(night ? roostP : spot());
    }
    leader.v.copy(leader.dir).multiplyScalar(lsp);
    const side = new V(-leader.dir.z, 0, leader.dir.x);
    for (let i = 0; i < n; i++) {
      const k = ducks[i];
      // personal place in the group: a slowly wandering offset around the leader, sometimes a straggler drifts off
      k.offTime -= dt;
      if (k.offTime <= 0) {
        if (!night && R() < 0.22) { k.stray = 1; k.offT.set((R() < 0.5 ? -1 : 1) * (2.2 + R() * 2), 0, -(R() * 2.5)); k.offTime = 10 + R() * 12; }
        else { k.stray = 0; k.offT.set((R() - 0.5) * 2.2, 0, -0.4 - R() * (0.6 + i * 0.35)); k.offTime = 6 + R() * 10; }
      }
      k.off.lerp(k.offT, Math.min(1, dt * 0.15));
      const goal = leader.p.clone().addScaledVector(side, k.off.x).addScaledVector(leader.dir, k.off.z);
      if (i === 0 && n > 1) goal.lerp(leader.p, 0.6);
      // desired velocity: steer to the goal, keep personal pace, avoid crowding
      const des = tv.subVectors(goal, k.p);
      const dist = des.length();
      const catchUp = dist > 1.5 ? 1.6 : 1;
      k.sp = 0.85 + 0.3 * N.n2(t * 0.08 + k.ph, 7.7);
      let want = Math.min(0.55, dist * 0.35) * k.sp * catchUp;
      if (k.act === 'upend' || k.act === 'dabble') want *= 0.1;
      if (dist > 1e-3) des.multiplyScalar(want / dist); else des.set(0, 0, 0);
      des.addScaledVector(leader.v, dist < 1.5 ? 0.6 : 0.2);
      for (let j = 0; j < n; j++) {
        if (j === i) continue; const o = ducks[j], dx = k.p.x - o.p.x, dz = k.p.z - o.p.z, dd = Math.hypot(dx, dz);
        if (dd < 0.55 && dd > 1e-4) { const f = (0.55 - dd) / 0.55 * 0.5; des.x += dx / dd * f; des.z += dz / dd * f; }
      }
      // accelerate gently toward the desired velocity
      const acc = 0.35 * dt; tv.set(des.x - k.v.x, 0, des.z - k.v.z); const al = tv.length(); if (al > acc) tv.multiplyScalar(acc / al);
      k.v.add(tv);
      const spd = k.v.length();
      // strokes: speed pulses slightly with each paddle
      k.stroke += dt * (4.5 + spd * 9);
      const pulse = 1 + 0.12 * Math.sin(k.stroke) * Math.min(1, spd / 0.15);
      const nx = k.p.x + k.v.x * pulse * dt, nz = k.p.z + k.v.z * pulse * dt;
      if (H(nx, nz) < -0.12) { k.p.x = nx; k.p.z = nz; } else k.v.multiplyScalar(0.5);
      // heading turns smoothly toward the motion
      if (spd > 0.04) {
        const ty = Math.atan2(-k.v.z, k.v.x); let dy = ty - k.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        k.yaw += Math.max(-1.1 * dt, Math.min(1.1 * dt, dy));
      }
      // activities: look around, preen, dabble, tail-up feeding
      k.actT -= dt;
      if (k.act === 'swim' && k.actT <= 0 && !night) {
        const r = R(), calm = spd < 0.26;
        if (r < 0.3 && calm) { k.act = 'upend'; k.actDur = 2 + R() * 2; env.ripple(k.p.x + Math.cos(k.yaw) * 0.15, k.p.z - Math.sin(k.yaw) * 0.15, 0.25); }
        else if (r < 0.6) { k.act = 'dabble'; k.actDur = 1.5 + R() * 2; }
        else if (r < 0.8 && calm) { k.act = 'preen'; k.actDur = 2 + R() * 2.5; k.hYawT = (R() < 0.5 ? -1 : 1) * 2.5; }
        else { k.actT = 2 + R() * 4; }
        if (k.act !== 'swim') k.actT = k.actDur;
      } else if (k.act !== 'swim' && k.actT <= 0) {
        if (k.act === 'upend') env.ripple(k.p.x + Math.cos(k.yaw) * 0.15, k.p.z - Math.sin(k.yaw) * 0.15, 0.2);
        k.act = 'swim'; k.actT = (k.stray ? 3 : 6) + R() * 12; k.hYawT = 0;
      }
      k.look -= dt;
      if (k.act === 'swim' && k.look <= 0) { k.hYawT = R() < 0.4 ? 0 : (R() - 0.5) * 1.3; k.look = 1 + R() * 3; }
      // targets for body pitch / head pose
      const up = k.act === 'upend' ? 1 : 0;
      k.upAmt = approach(k.upAmt, up, dt * 3.5);
      const hp = k.act === 'dabble' ? 1.1 : k.act === 'preen' ? 0.35 : 0;
      k.hPitch = approach(k.hPitch, hp, dt * 4);
      k.hYaw = approach(k.hYaw, k.hYawT, dt * (k.act === 'preen' ? 3 : 2.2));
      k.roll = 0.025 * Math.sin(k.stroke) * Math.min(1, spd / 0.2);
      // hide in reeds at night
      const tgtS = night && leader.p.distanceTo(roostP || leader.p) < 1.5 ? 0 : 1;
      k.s += (tgtS - k.s) * Math.min(1, dt * 0.5);
      // body transform: bobbing on the water, tail-up feeding tips the body forward around its middle
      const y = Math.sin(t * 2 + k.ph) * 0.006 - 0.018 - k.upAmt * 0.05;
      e.set(k.roll, k.yaw, -k.upAmt * 1.25, 'YZX'); q.setFromEuler(e);
      const s = k.s + 1e-4;
      mb.compose(new V(k.p.x, y, k.p.z), q, sc.set(s, s, s));
      // head: gentle forward-back stroke bob (small amplitude), turns, dips
      const bob = Math.sin(k.stroke) * (0.004 + 0.008 * Math.min(1, spd / 0.3)) * (k.act === 'swim' ? 1 : 0.2);
      e.set(0, k.hYaw, -k.hPitch - k.upAmt * 0.5, 'YZX'); q.setFromEuler(e);
      mloc.compose(new V(PIVOT.x + bob, PIVOT.y, 0), q, sc.set(1, 1, 1));
      mh.multiplyMatrices(mb, mloc);
      setM(i, mb, mh);
      // wake data for the water shader
      if (i < 6) {
        const vis = k.s > 0.5 ? 1 : 0;
        fw.set(Math.cos(k.yaw), 0, -Math.sin(k.yaw));
        U.uDuck.value[i].set(k.p.x, k.p.z, fw.x * spd * vis, fw.z * spd * vis);
      }
    }
    for (let i = n; i < 6; i++) U.uDuck.value[i].set(0, 0, 0, 0);
    for (const mm of Object.values(meshes)) mm.instanceMatrix.needsUpdate = true;
  }
  function dispose() { for (const mm of Object.values(meshes)) { mm.geometry.dispose(); scene.remove(mm); } mat.dispose(); for (const v of U.uDuck.value) v.set(0, 0, 0, 0); }
  return { update, dispose, pos: () => leader.p, dir: () => leader.dir, list: () => ducks };
}
