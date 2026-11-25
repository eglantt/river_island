import * as THREE from 'three';
import { rng } from './noise.js';
import { Acc, blobGeo } from './world.js';
import { patch } from './shaders.js';

// A small family of mallards: swims along calm shallow water, dives now and then, hides in reeds at night.
export function createDucks(world, Q, scene) {
  const R = rng(9191), { H, N } = world, n = Q.ducks;
  const C = (h) => new THREE.Color(h), tmp = new THREE.Color();
  const acc = new Acc(), V = THREE.Vector3;
  const cBody = C('#7a6650'), cBreast = C('#6b4a35'), cHead = C('#2f5a3a'), cBeak = C('#d9b23a'), cTail = C('#2a2622'), cWing = C('#8a8a86');
  acc.add(blobGeo(N, new V(0, 0.06, 0), 0.13, 0.62, 1, 0.06).scale(1.65, 1, 1), (v) => tmp.copy(v.x > 0.08 ? cBreast : cBody).lerp(cWing, v.y > 0.1 && Math.abs(v.z) > 0.05 ? 0.4 : 0), () => 0);
  acc.add(blobGeo(N, new V(0.2, 0.17, 0), 0.058, 1, 1, 0.03), () => cHead, () => 0);
  acc.add(new THREE.ConeGeometry(0.022, 0.07, 6).rotateZ(-Math.PI / 2).translate(0.27, 0.16, 0), () => cBeak, () => 0);
  acc.add(new THREE.ConeGeometry(0.04, 0.09, 5).rotateZ(Math.PI / 2 + 0.5).translate(-0.24, 0.1, 0), () => cTail, () => 0);
  const geo = acc.build();
  const mesh = new THREE.InstancedMesh(geo, patch(new THREE.MeshLambertMaterial({ vertexColors: true }), 'duck', 0), Math.max(1, n));
  mesh.frustumCulled = false; mesh.renderOrder = 3; mesh.material.transparent = true; scene.add(mesh);
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
    mesh.setColorAt(i, tints[i === 0 ? 0 : 1]);
    return { p: leader.p.clone().add(new V(-i * 0.6, 0, (i % 2 ? 1 : -1) * 0.3)), yaw: 0, dive: 0, diveT: 8 + R() * 30, s: 1, ph: R() * 6 };
  });
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
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
      m.compose(new V(k.p.x, y, k.p.z), q, sc.set(s, s, s)); mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
  function dispose() { mesh.geometry.dispose(); mesh.material.dispose(); scene.remove(mesh); }
  return { update, dispose };
}
