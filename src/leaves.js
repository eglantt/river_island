import * as THREE from 'three';
import { patch } from './shaders.js';

// Leaves torn off by strong wind: they leave the crowns of the trees near the camera in the gusts, fly downwind
// tumbling and fluttering, then lie on the ground (fading after a while) or float off with the current.
const LEAFY = { birch: 1, oak: 1, willow: 1.3, alder: 1, aspen: 1.2, maple: 1, linden: 1 };
export function createTornLeaves(world, Q, scene, noise) {
  const { H, mz, trunks } = world, N = Q.torn || 120;
  const trees = trunks.filter((t) => t[3] && t[4] && (LEAFY[t[3]] || (t[3] !== 'dead' && t[3] !== 'snag' && t[3] !== 'spruce' && t[3] !== 'pine' && t[3] !== 'log' && t[3] !== 'stump' && t[3] !== 'stones')));
  // a small leaf: blade on a 1 x 1 frame (scaled per leaf), bent a little along the midrib
  const g = new THREE.BufferGeometry();
  const P = [0, 0, -0.5, 0.32, 0.04, -0.1, 0, 0.06, 0.5, -0.32, 0.04, -0.1, 0, 0.02, 0];
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  g.setAttribute('sway', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0], 1));
  g.setIndex([0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4]);
  const mat = patch(new THREE.MeshLambertMaterial({ side: THREE.DoubleSide }), 'torn', 0);
  const mesh = new THREE.InstancedMesh(g, mat, N); mesh.frustumCulled = false; mesh.count = 0;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(mesh);
  const cols = ['#5f8a2e', '#6f9a34', '#86a83c', '#a7b24a', '#c2b04a', '#4e7a2a'].map((c) => new THREE.Color(c));
  const L = [];
  for (let i = 0; i < N; i++) { L.push({ on: false, p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(), ax: new THREE.Vector3(1, 0, 0), w: 0, s: 0.05, st: 0, t: 0, life: 0, ph: 0 }); mesh.setColorAt(i, cols[i % cols.length]); }
  mesh.instanceColor.needsUpdate = true;
  // the same gust field the vegetation shader uses (blue channel of the noise texture, bilinear)
  const gust = (x, z, t, dir, wind) => {
    const n = 256, u = (x * 0.013 - dir.x * t * (0.05 + 0.04 * wind)) * n - 0.5, v = (z * 0.013 - dir.y * t * (0.05 + 0.04 * wind)) * n - 0.5;
    const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0, at = (a, b) => noise[((((b % n) + n) % n) * n + (((a % n) + n) % n)) * 4 + 2] / 255;
    const r = (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
    const s = Math.min(1, Math.max(0, (r - 0.3) / 0.55)); return s * s * (3 - 2 * s);
  };
  const m4 = new THREE.Matrix4(), sc = new THREE.Vector3(), dq = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), tmp = new THREE.Vector3();
  let acc = 0, cursor = 0, near = [], nearT = 0, R = Math.random;
  function spawn(cam, wind, WL, dir, t) {
    if (!near.length) return;
    // pick a nearby tree, weighted by the gust at its crown
    for (let k = 0; k < 4; k++) {
      const tr = near[Math.floor(R() * near.length)], gs = gust(tr[0], tr[1], t, dir, wind);
      if (R() > 0.15 + gs) continue;
      let lf = null; for (let j = 0; j < N && !lf; j++) { const c = L[(cursor + j) % N]; if (!c.on) { lf = c; cursor = (cursor + j + 1) % N; } }
      if (!lf) { // pool full: reuse the leaf that has lain longest on the ground or water
        let best = -1; for (const c of L) if (c.st !== 0 && c.life > best) { best = c.life; lf = c; }
        if (!lf) return;
      }
      const h = tr[4], a = R() * 6.283, rr = h * (0.12 + 0.25 * Math.sqrt(R()));
      lf.p.set(tr[0] + Math.cos(a) * rr, H(tr[0], tr[1]) + h * (0.45 + 0.5 * R()), tr[1] + Math.sin(a) * rr);
      lf.v.set(dir.x, 0, dir.y).multiplyScalar(1 + 3 * wind * gs); lf.v.y = 0.3 + R() * 0.8;
      lf.q.setFromEuler(new THREE.Euler(R() * 6.28, R() * 6.28, R() * 6.28)); lf.ax.set(R() - 0.5, R() - 0.5, R() - 0.5).normalize();
      lf.w = 4 + R() * 9; lf.s = (tr[3] === 'willow' ? 0.075 : 0.06) + R() * 0.035; lf.st = 0; lf.t = 0; lf.life = 0; lf.ph = R() * 6.28; lf.on = true;
      return;
    }
  }
  let lt = 0, lw = 0, ld = new THREE.Vector2(1, 0);
  function update(dt, t, cam, wind, WL, dir) {
    dt = Math.min(dt, 0.1); lt = t; lw = wind; ld.copy(dir);
    // trees within ~45 m of the camera (refreshed twice a second)
    if ((nearT -= dt) < 0) { nearT = 0.5; near = trees.filter((tr) => (tr[0] - cam.x) ** 2 + (tr[1] - cam.z) ** 2 < 45 * 45); }
    // leaves start tearing off at a moderate breeze (load > 0.2), many in a storm
    const rate = N * 0.35 * Math.max(0, WL - 0.18) * Math.min(1, near.length / 4);
    acc += rate * dt; while (acc >= 1) { acc -= 1; spawn(cam, wind, WL, dir, t); }
    let n = 0;
    for (let i = 0; i < N; i++) {
      const l = L[i]; if (!l.on) continue;
      l.t += dt;
      if (l.st === 0) {
        // flying: dragged toward the wind velocity, sinking with a flutter, tumbling
        const gs = gust(l.p.x, l.p.z, t, dir, wind), ws = 1.5 + 9 * wind * (0.35 + 0.9 * gs);
        const k = Math.min(1, dt * 1.6);
        l.v.x += (dir.x * ws + Math.sin(t * 2.3 + l.ph) * 0.8 - l.v.x) * k;
        l.v.z += (dir.y * ws + Math.cos(t * 1.9 + l.ph) * 0.8 - l.v.z) * k;
        l.v.y += (-1.15 + 0.7 * Math.sin(t * 5 + l.ph) + 0.35 * gs * wind - l.v.y) * Math.min(1, dt * 3);
        l.p.addScaledVector(l.v, dt);
        dq.setFromAxisAngle(l.ax, l.w * dt * (0.6 + 0.6 * wind)); l.q.premultiply(dq);
        const gh = H(l.p.x, l.p.z);
        if (gh > 0.02 && l.p.y <= gh + 0.02) { l.st = 1; l.p.y = gh + 0.015; l.life = 0; l.q.setFromAxisAngle(up, R() * 6.28); dq.setFromAxisAngle(tmp.set(1, 0, 0), (R() - 0.5) * 0.4); l.q.multiply(dq); }
        else if (gh <= 0.02 && l.p.y <= 0.01) { l.st = 2; l.p.y = 0.012; l.life = 0; l.q.setFromAxisAngle(up, R() * 6.28); }
        if (l.t > 30) l.on = false;
      } else if (l.st === 1) {
        // on the ground: a gust may lift it again, otherwise it lies and slowly fades into the litter
        l.life += dt;
        const gs = gust(l.p.x, l.p.z, t, dir, wind);
        if (WL * gs > 0.55 && R() < dt * 0.4) { l.st = 0; l.v.set(dir.x, 1.2, dir.y); }
        if (l.life > 18) l.on = false;
      } else {
        // on the water: carried by the current (downstream, +x along the river), turning slowly, nudged by the wind
        l.life += dt;
        const depth = -H(l.p.x, l.p.z), sp = 0.15 + 0.45 * Math.min(1, Math.max(0, depth) / 1.5);
        const fz = (mz(l.p.x + 2) - mz(l.p.x - 2)) * 0.25, fl = Math.hypot(1, fz);
        l.p.x += (sp / fl + dir.x * 0.08 * wind) * dt; l.p.z += (sp * fz / fl + dir.y * 0.08 * wind) * dt;
        l.p.y = 0.012 + 0.006 * Math.sin(t * 2 + l.ph);
        dq.setFromAxisAngle(up, 0.15 * dt * Math.sin(l.ph)); l.q.premultiply(dq);
        if (H(l.p.x, l.p.z) > 0.05) { l.st = 1; l.life = 10; }
        if (l.life > 45) l.on = false;
      }
      if ((l.p.x - cam.x) ** 2 + (l.p.z - cam.z) ** 2 > 90 * 90) l.on = false;
      if (!l.on) continue;
      const fade = l.st === 1 ? Math.min(1, (18 - l.life) / 4) : l.st === 2 ? Math.min(1, (45 - l.life) / 6) : 1;
      sc.setScalar(l.s * Math.max(0.01, fade));
      m4.compose(l.p, l.q, sc); mesh.setMatrixAt(n, m4);
      if (n !== i) mesh.setColorAt(n, cols[i % cols.length]);
      n++;
    }
    mesh.count = n; mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
  const active = () => L.filter((l) => l.on).map((l) => ({ st: l.st, x: l.p.x, y: l.p.y, z: l.p.z }));
  // for the sound: the gust at a point, and how close the nearest leafy crown is (0 far .. 1 under it)
  const gustAt = (x, z) => gust(x, z, lt, ld, lw);
  const treeNear = (x, z) => { let d = 1e9; for (const tr of near) d = Math.min(d, Math.hypot(tr[0] - x, tr[1] - z) - tr[4] * 0.3); return Math.min(1, Math.max(0, 1 - d / 22)); };
  return { update, active, gustAt, treeNear, mesh, dispose: () => { scene.remove(mesh); g.dispose(); mat.dispose(); } };
}
