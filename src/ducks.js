import * as THREE from 'three';
import { rng } from './noise.js';
import { Acc, blobGeo } from './world.js';
import { patch } from './shaders.js';

// A small family of mallards: swims along calm shallow water, dives now and then, hides in reeds at night.
export function createDucks(world, Q, scene) {
  const R = rng(9191), { H, N } = world, n = Q.ducks;
  const C = (h) => new THREE.Color(h), tmp = new THREE.Color();
  const V = THREE.Vector3;
  // mallard: body, neck, elongated head, broad flat spatulate bill
  function duckGeo(drake) {
    const acc = new Acc();
    const cBody = C(drake ? '#8f8a82' : '#7a6448'), cBreast = C(drake ? '#5a3324' : '#6e5236'), cHead = C(drake ? '#1f5a36' : '#6b5238'), cBill = C(drake ? '#c9b24a' : '#b9773a'), cTail = C(drake ? '#1d1d1f' : '#4a3a2a'), cWing = C(drake ? '#6f6a62' : '#5e4a34');
    const mott = (c, v) => tmp.copy(c).multiplyScalar(drake ? 1 : 0.85 + 0.3 * N.n2(v.x * 60, v.z * 60 + v.y * 40));
    acc.add(blobGeo(N, new V(0, 0.06, 0), 0.13, 0.6, 1, 0.05).scale(1.7, 1, 1), (v) => mott(v.x > 0.1 ? cBreast : (v.y > 0.1 && Math.abs(v.z) > 0.05 ? cWing : cBody), v), () => 0);
    // neck: short tilted cylinder from the breast up to the head, white ring on the drake
    const neck = new THREE.CylinderGeometry(0.032, 0.045, 0.11, 8, 3).rotateZ(-0.35).translate(0.19, 0.15, 0);
    acc.add(neck, (v) => (drake && Math.abs(v.y - 0.125) < 0.008 ? C('#f2f2ee') : mott(v.y > 0.13 ? cHead : cBreast, v)), () => 0);
    // head: elongated, slightly flattened, gentle forehead
    const head = new THREE.SphereGeometry(0.05, 12, 8).scale(1.45, 0.85, 0.82).translate(0.245, 0.215, 0);
    acc.add(head, (v) => mott(cHead, v), () => 0);
    // bill: broad, flat, rounded tip
    const bill = new THREE.SphereGeometry(0.04, 10, 6, 0, Math.PI * 2, 0, Math.PI).scale(1.6, 0.28, 0.62).rotateZ(-0.18).translate(0.31, 0.198, 0);
    acc.add(bill, () => cBill, () => 0);
    acc.add(new THREE.ConeGeometry(0.045, 0.09, 6).rotateZ(Math.PI / 2 + 0.55).translate(-0.25, 0.1, 0), () => cTail, () => 0);
    return acc.build();
  }
  const mat = patch(new THREE.MeshLambertMaterial({ vertexColors: true }), 'duck', 0); mat.transparent = true;
  const drakeM = new THREE.InstancedMesh(duckGeo(true), mat, 1), henM = new THREE.InstancedMesh(duckGeo(false), mat, Math.max(1, n - 1));
  for (const mm of [drakeM, henM]) { mm.frustumCulled = false; mm.renderOrder = 3; scene.add(mm); }
  const setM = (i, m4) => (i === 0 ? drakeM.setMatrixAt(0, m4) : henM.setMatrixAt(i - 1, m4));
  const tints = [new THREE.Color(1, 1, 1), new THREE.Color(1.15, 1.05, 0.9)];
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
  const leader = { p: spot(), tgt: spot(), dir: new V(1, 0, 0) };
  const ducks = Array.from({ length: n }, (_, i) => {
    return { p: leader.p.clone().add(new V(-i * 0.6, 0, (i % 2 ? 1 : -1) * 0.3)), yaw: 0, dive: 0, diveT: 8 + R() * 30, s: 1, ph: R() * 6 };
  });
  let night = false, roostP = null;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new V(), tv = new V();
  function update(dt, t, env) {
    const wantNight = env.night > 0.6;
    if (wantNight && !night) { night = true; roostP = roost(); leader.tgt.copy(roostP); }
    if (!wantNight && night) { night = false; leader.tgt.copy(spot()); }
    tv.subVectors(leader.tgt, leader.p); const d = tv.length();
    if (d < 0.5) { if (!night) leader.tgt.copy(spot()); }
    else {
      tv.normalize(); leader.dir.lerp(tv, Math.min(1, dt * 0.8)).normalize();
      const nx = leader.p.x + leader.dir.x * 0.35 * dt, nz = leader.p.z + leader.dir.z * 0.35 * dt;
      if (H(nx, nz) < -0.15) { leader.p.x = nx; leader.p.z = nz; } else leader.tgt.copy(night ? roostP : spot());
    }
    for (let i = 0; i < n; i++) {
      const k = ducks[i];
      const goal = leader.p.clone().addScaledVector(leader.dir, -0.65 * i).add(new V(-leader.dir.z, 0, leader.dir.x).multiplyScalar((i % 2 ? 1 : -1) * 0.28 * Math.min(i, 1)));
      tv.subVectors(goal, k.p); const dd = tv.length();
      if (dd > 0.02) { const sp = Math.min(0.6, dd * 1.2); k.p.addScaledVector(tv.normalize(), sp * dt); k.yaw = Math.atan2(-tv.z, tv.x); }
      // diving
      if (!night) {
        k.diveT -= dt;
        if (k.diveT <= 0 && k.dive === 0) { k.dive = 0.001; env.ripple(k.p.x, k.p.z, 0.35); }
        if (k.dive > 0) { k.dive += dt; if (k.dive > 3.2) { k.dive = 0; k.diveT = 15 + R() * 40; env.ripple(k.p.x, k.p.z, 0.3); } }
      }
      const div = k.dive > 0 ? Math.min(1, k.dive / 0.4) * (k.dive > 2.8 ? Math.max(0, (3.2 - k.dive) / 0.4) : 1) : 0;
      // hide in reeds at night
      const tgtS = night && leader.p.distanceTo(roostP || leader.p) < 1.5 ? 0 : 1;
      k.s += (tgtS - k.s) * Math.min(1, dt * 0.5);
      const y = Math.sin(t * 2 + k.ph) * 0.008 - div * 0.32;
      e.set(0, k.yaw, -div * 1.0, 'YZX'); q.setFromEuler(e);
      const s = k.s * (1 - (k.dive > 0.35 && k.dive < 2.85 ? 1 : 0)) + 1e-4;
      m.compose(new V(k.p.x, y, k.p.z), q, sc.set(s, s, s)); setM(i, m);
    }
    drakeM.instanceMatrix.needsUpdate = true; henM.instanceMatrix.needsUpdate = true;
  }
  function dispose() { for (const mm of [drakeM, henM]) { mm.geometry.dispose(); scene.remove(mm); } mat.dispose(); }
  return { update, dispose, pos: () => leader.p, dir: () => leader.dir };
}
