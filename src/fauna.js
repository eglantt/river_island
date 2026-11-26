import * as THREE from 'three';
import { rng } from './noise.js';

const V = THREE.Vector3;
const _m = new THREE.Matrix4(), _l = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new V(), _p = new V();

function wingTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
  // wing occupies z (canvas y: 0 = body .. 128 = tip), x (canvas x: front at 0)
  g.fillStyle = '#fff';
  g.beginPath(); g.moveTo(64, 0); g.bezierCurveTo(10, 30, 6, 110, 40, 122); g.bezierCurveTo(70, 128, 80, 70, 64, 0); g.fill();
  g.beginPath(); g.moveTo(64, 0); g.bezierCurveTo(124, 18, 124, 92, 96, 100); g.bezierCurveTo(78, 104, 70, 50, 64, 0); g.fill();
  g.globalCompositeOperation = 'source-atop';
  g.strokeStyle = 'rgba(20,16,12,.9)'; g.lineWidth = 12;
  g.beginPath(); g.moveTo(64, 0); g.bezierCurveTo(10, 30, 6, 110, 40, 122); g.bezierCurveTo(70, 128, 80, 70, 64, 0); g.stroke();
  g.beginPath(); g.moveTo(64, 0); g.bezierCurveTo(124, 18, 124, 92, 96, 100); g.stroke();
  g.fillStyle = 'rgba(20,16,12,.85)'; [[38, 78, 7], [30, 100, 5], [96, 62, 6]].forEach(([x, y, r]) => { g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); });
  g.fillStyle = 'rgba(255,255,255,.9)'; [[30, 112, 3], [44, 116, 2.5], [104, 80, 3]].forEach(([x, y, r]) => { g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); });
  const grad = g.createLinearGradient(0, 0, 0, 128); grad.addColorStop(0, 'rgba(40,30,20,.55)'); grad.addColorStop(0.3, 'rgba(40,30,20,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export function createFauna(world, Q, scene) {
  const R = rng(777), { H, islandE, flowerPts, reedPts, irx, irz, zc0, mz } = world;
  const group = new THREE.Group(); scene.add(group);
  const randAir = (lo, hi) => {
    for (let t = 0; t < 60; t++) { const x = (R() * 2 - 1) * irx, z = zc0 + (R() * 2 - 1) * irz; if (islandE(x, z) < 0.9) return new V(x, H(x, z) + lo + R() * (hi - lo), z); }
    return new V(0, 2, zc0);
  };
  // ---------- butterflies ----------
  const NB = Q.bf;
  const wingGeo = new THREE.PlaneGeometry(1, 1); wingGeo.rotateX(-Math.PI / 2); wingGeo.translate(0, 0, 0.5);
  const wingMat = new THREE.MeshLambertMaterial({ map: wingTexture(), alphaTest: 0.5, side: THREE.DoubleSide });
  const bWings = new THREE.InstancedMesh(wingGeo, wingMat, NB * 2); bWings.frustumCulled = false;
  const pal = ['#ffd94a', '#f2f2ea', '#ff8a3d', '#8fb8ff', '#ffb0e0', '#fff27a'].map((h) => new THREE.Color(h));
  const bf = [];
  for (let i = 0; i < NB; i++) {
    const c = pal[i % pal.length].clone().multiplyScalar(1.3);
    bWings.setColorAt(i * 2, c); bWings.setColorAt(i * 2 + 1, c);
    bf.push({ p: randAir(0.4, 1.5), v: new V(), tgt: randAir(0.4, 1.5), rest: 0, s: 0, ph: R() * 10, size: 0.065 + R() * 0.03, flower: false, yaw: 0 });
  }
  group.add(bWings);
  const bBody = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.06, 0.04, 1, 4).rotateZ(Math.PI / 2), new THREE.MeshLambertMaterial({ color: '#2a2018' }), NB); bBody.frustumCulled = false; group.add(bBody);

  // ---------- dragonflies ----------
  const ND = Q.df;
  const dBody = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05, 0.025, 1, 5).rotateZ(Math.PI / 2).translate(-0.1, 0, 0), new THREE.MeshLambertMaterial({ color: '#ffffff', emissive: '#0a1a1a' }), ND); dBody.frustumCulled = false;
  const dw = new THREE.PlaneGeometry(1, 1); dw.rotateX(-Math.PI / 2); dw.translate(0, 0, 0.5);
  const dWings = new THREE.InstancedMesh(dw, new THREE.MeshBasicMaterial({ color: '#dfeff7', transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false }), ND * 4); dWings.frustumCulled = false;
  const dPal = ['#1d6f8f', '#2a8a5a', '#a33b2a', '#3a5fb0'].map((h) => new THREE.Color(h));
  const df = [];
  const waterSpot = () => {
    for (let t = 0; t < 80; t++) {
      const x = (R() * 2 - 1) * irx * 1.9, z = zc0 + (R() * 2 - 1) * irz * 2.4;
      const h = H(x, z); if (h < -0.1 && h > -2.2) return new V(x, 0.35 + R() * 1.1, z);
    }
    return reedPts.length ? reedPts[Math.floor(R() * reedPts.length)].clone() : new V(irx, 1, zc0);
  };
  for (let i = 0; i < ND; i++) { dBody.setColorAt(i, dPal[i % 4]); df.push({ p: waterSpot(), v: new V(), tgt: waterSpot(), hover: R() * 2, s: 0, yaw: R() * 6, ph: R() * 10 }); }
  group.add(dBody, dWings);

  // ---------- birds / bats ----------
  const NBird = 14;
  const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.Float32BufferAttribute([-0.2, 0, 0, 0.25, 0, 0, -0.05, 0, 1], 3)); bg.computeVertexNormals();
  const birdMat = new THREE.MeshBasicMaterial({ color: '#25242a', side: THREE.DoubleSide });
  const birds = new THREE.InstancedMesh(bg, birdMat, NBird * 2); birds.frustumCulled = false; group.add(birds);
  // a lone gull gliding low along the river now and then
  const gull = new THREE.Group(); group.add(gull);
  {
    const white = new THREE.MeshLambertMaterial({ color: '#eeece6' }), grey = new THREE.MeshLambertMaterial({ color: '#9aa0a6', side: THREE.DoubleSide }), tipM = new THREE.MeshLambertMaterial({ color: '#1e1e20', side: THREE.DoubleSide }), beakM = new THREE.MeshLambertMaterial({ color: '#e2b33a' });
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 7).scale(2.6, 0.85, 0.9), white); gull.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 7).scale(1.3, 1, 0.95), white); head.position.set(0.33, 0.05, 0); gull.add(head);
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.09, 6).rotateZ(-Math.PI / 2), beakM); beak.position.set(0.44, 0.04, 0); gull.add(beak);
    const tail = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([-0.26, 0.02, 0, -0.46, 0.03, 0.1, -0.46, 0.03, -0.1], 3)), white); tail.geometry.computeVertexNormals(); tail.material = grey; gull.add(tail);
    const wingPart = (len, w0, w1, sweep, sd) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, -w0, 0, 0, -sweep - w1, 0, len * sd, 0, 0, 0, -sweep - w1, 0, len * sd, -sweep, 0, len * sd], 3)); g.computeVertexNormals(); return g; };
    gull.userData.w = [];
    for (const side of [1, -1]) {
      const sh = new THREE.Group(); sh.position.set(0.06, 0.04, side * 0.07); gull.add(sh);
      sh.add(new THREE.Mesh(wingPart(0.42, 0.16, 0.12, 0.02, side), grey));
      const el = new THREE.Group(); el.position.set(-0.02, 0, 0.42 * side); sh.add(el);
      el.add(new THREE.Mesh(wingPart(0.4, 0.12, 0.05, 0.12, side), grey));
      const tp = new THREE.Mesh(wingPart(0.12, 0.05, 0.02, 0.05, side), tipM); tp.position.set(-0.12, 0.001, 0.36 * side); el.add(tp);
      gull.userData.w.push([sh, el, side]);
    }
    gull.scale.setScalar(1.6); gull.visible = false;
  }
  let gullT = 20 + R() * 30, gullDir = 1;
  const bd = Array.from({ length: NBird }, (_, i) => ({ off: new V((R() - 0.5) * 26, (R() - 0.5) * 8, (R() - 0.5) * 26), ph: R() * 10, p: new V(), prev: new V() }));

  // ---------- fish ----------
  const fish = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshLambertMaterial({ color: '#8a9298' }));
  fish.scale.set(0.22, 0.06, 0.05); fish.visible = false; group.add(fish);
  let fishT = 6 + R() * 8, jump = null;

  const tmpV = new V(), tmpW = new V();
  function pickB(b, pf) {
    b.flower = R() < pf && flowerPts.length > 0;
    b.tgt.copy(b.flower ? flowerPts[Math.floor(R() * flowerPts.length)] : randAir(0.5, 2.2));
  }
  function setWing(mesh, idx, pos, yaw, pitch, side, flap, scale, offX = 0, width = 1) {
    _e.set(0, yaw, pitch, 'YZX'); _q.setFromEuler(_e);
    _m.compose(pos, _q, _s.set(1, 1, 1));
    _l.makeRotationX(side > 0 ? -flap : flap); _l.setPosition(offX, 0, 0);
    _m.multiply(_l); _m.multiply(_l.makeScale(scale * width, scale, scale * side));
    mesh.setMatrixAt(idx, _m);
  }

  function update(dt, t, env) {
    const cam = env.cam;
    // butterflies
    for (let i = 0; i < NB; i++) {
      const b = bf[i], want = i < NB * env.bfly;
      if (want && b.s <= 0) { b.p.copy(randAir(0.3, 1.2)); b.tgt.copy(randAir(0.4, 1.6)); }
      b.s = Math.min(1, Math.max(0, b.s + (want ? dt * 0.6 : -dt * 0.5)));
      let flap;
      if (b.rest > 0) {
        b.rest -= dt; b.v.multiplyScalar(0.8);
        flap = 1.35 + (Math.sin(t * 0.9 + b.ph) > 0.6 ? -1.0 : 0.12 * Math.sin(t * 2 + b.ph));
        if (b.rest <= 0 || !want) { b.rest = 0; pickB(b, 0.6); }
      } else {
        if (!want) b.tgt.set(b.p.x + 3, b.p.y + 6, b.p.z);
        tmpV.subVectors(b.tgt, b.p); const d = tmpV.length();
        tmpV.normalize().multiplyScalar(1.15).add(tmpW.set(Math.sin(t * 3.1 + b.ph) * 0.9, Math.sin(t * 4.3 + b.ph * 2) * 0.7, Math.cos(t * 2.7 + b.ph) * 0.9));
        b.v.lerp(tmpV, Math.min(1, dt * 3)); b.p.addScaledVector(b.v, dt);
        const g = H(b.p.x, b.p.z); if (b.p.y < Math.max(g, 0) + 0.12) b.p.y = Math.max(g, 0) + 0.12;
        flap = 0.1 + 1.2 * (0.5 + 0.5 * Math.sin(t * 15 + b.ph));
        if (d < 0.14) {
          if (b.flower && want) { b.rest = 2 + R() * 5; b.p.copy(b.tgt); }
          else pickB(b, 0.55);
        }
      }
      const yaw = b.rest > 0 ? b.yaw : (b.yaw = Math.atan2(-b.v.z, b.v.x));
      const sc = b.size * b.s;
      setWing(bWings, i * 2, b.p, yaw, 0, 1, flap, sc); setWing(bWings, i * 2 + 1, b.p, yaw, 0, -1, flap, sc);
      _e.set(0, yaw, 0); _q.setFromEuler(_e); _m.compose(b.p, _q, _s.set(b.size * 0.9 * b.s, b.size * 0.12 * b.s + 1e-4, b.size * 0.12 * b.s + 1e-4)); bBody.setMatrixAt(i, _m);
    }
    bWings.instanceMatrix.needsUpdate = true; bBody.instanceMatrix.needsUpdate = true;

    // dragonflies
    for (let i = 0; i < ND; i++) {
      const d = df[i], want = i < ND * env.dfly;
      if (want && d.s <= 0) d.p.copy(waterSpot());
      d.s = Math.min(1, Math.max(0, d.s + (want ? dt * 0.8 : -dt * 0.6)));
      if (d.hover > 0) {
        d.hover -= dt;
        d.p.y += Math.sin(t * 7 + d.ph) * 0.002; d.p.x += Math.sin(t * 5.3 + d.ph) * 0.0015;
        if (d.hover <= 0) {
          if (!want) d.tgt.set(d.p.x, d.p.y + 8, d.p.z + 6);
          else if (R() < 0.13 && cam) { tmpV.set(Math.cos(env.yaw), 0, -Math.sin(env.yaw)); d.tgt.copy(cam).addScaledVector(tmpV, 1.5 + R()).add(new V((R() - 0.5) * 0.8, -0.3 - R() * 0.3, (R() - 0.5) * 0.8)); }
          else d.tgt.copy(waterSpot());
        }
      } else {
        tmpV.subVectors(d.tgt, d.p); const dist = tmpV.length();
        const sp = Math.min(6.5, dist * 4 + 0.5);
        d.v.lerp(tmpV.normalize().multiplyScalar(sp), Math.min(1, dt * 6)); d.p.addScaledVector(d.v, dt);
        d.yaw = Math.atan2(-d.v.z, d.v.x);
        if (dist < 0.08) { d.hover = 0.5 + R() * 2.4; if (cam && d.p.distanceTo(cam) < 3) d.hover += 1.5; d.v.set(0, 0, 0); }
      }
      const sc = d.s;
      _e.set(0, d.yaw, 0); _q.setFromEuler(_e); _m.compose(d.p, _q, _s.set(0.075 * sc + 1e-4, 0.075 * sc + 1e-4, 0.075 * sc + 1e-4)); dBody.setMatrixAt(i, _m);
      const fl = 0.15 + 0.35 * Math.sin(t * 95 + i * 1.7);
      for (let k = 0; k < 4; k++) setWing(dWings, i * 4 + k, d.p, d.yaw, 0, k % 2 ? -1 : 1, k < 2 ? fl : -fl * 0.8, 0.048 * sc + 1e-4, k < 2 ? 0.006 : -0.008, 0.22);
    }
    dBody.instanceMatrix.needsUpdate = true; dWings.instanceMatrix.needsUpdate = true;

    // birds by day, bats at night
    const bats = env.bats > env.birds;
    const act = bats ? env.bats : env.birds, nAct = Math.round((bats ? 6 : NBird) * act);
    birdMat.color.set(bats ? '#141018' : '#26252b');
    for (let i = 0; i < NBird; i++) {
      const b = bd[i]; b.prev.copy(b.p);
      let flap, sc;
      if (bats) {
        const k = t * 0.55 + b.ph;
        b.p.set(Math.sin(k * 1.3 + b.ph) * irx * 0.8 + Math.sin(k * 3.7) * 2, 4 + Math.sin(k * 2.1) * 1.5 + 2, zc0 + Math.cos(k * 1.1 + b.ph * 2) * irz * 0.9 + Math.cos(k * 4.3) * 2);
        flap = Math.sin(t * 22 + b.ph) * 0.9; sc = 0.22;
      } else {
        const k = t * 0.045;
        b.p.set(Math.cos(k) * 150 + b.off.x * 0.6 + Math.sin(t * 0.3 + b.ph) * 3, 26 + Math.sin(k * 2.3) * 9 + b.off.y * 0.6, zc0 + Math.sin(k) * 95 + b.off.z * 0.6);
        const glide = Math.sin(t * 0.5 + b.ph) > 0.4;
        flap = glide ? 0.15 : Math.sin(t * 9 + b.ph) * 0.7; sc = 1.15;
      }
      tmpV.subVectors(b.p, b.prev); const yaw = Math.atan2(-tmpV.z, tmpV.x);
      const s = i < nAct ? sc : 1e-4;
      setWing(birds, i * 2, b.p, yaw, 0, 1, flap, s); setWing(birds, i * 2 + 1, b.p, yaw, 0, -1, flap, s);
    }
    birds.instanceMatrix.needsUpdate = true;
    // gull pass: ~40 s along the river, then a pause
    gullT -= dt;
    const gu = gullT < 0 ? Math.min(1, -gullT / 40) : -1;
    if (gu >= 1) { gullT = 30 + R() * 60; gullDir = -gullDir; }
    const gx = gullDir * (-320 + 640 * Math.max(0, gu)), gs = gu >= 0 && gu < 1 && env.birds > 0.3 ? 1.1 : 1e-4;
    const gp = new V(gx, 9 + Math.sin(t * 0.6) * 3, mz(gx) + Math.sin(t * 0.21) * 12), gnx = gx + gullDir;
    const gyaw = Math.atan2(-(mz(gnx) - mz(gx)), gullDir);
    const flapping = Math.sin(t * 0.7) > 0.3, ph = Math.sin(t * 6.5);
    gull.visible = gs > 0.01; gull.position.copy(gp); gull.rotation.set(0, gyaw, Math.sin(t * 0.4) * 0.15, 'YXZ');
    for (const [sh, el, sd] of gull.userData.w) { sh.rotation.x = -sd * (flapping ? ph * 0.5 : 0.12); el.rotation.x = sd * (flapping ? 0.1 + ph * 0.3 : 0.22); }

    // fish
    if (jump) {
      jump.t += dt / 0.85; const u = jump.t;
      if (u >= 1) { fish.visible = false; env.ripple(fish.position.x, fish.position.z, 0.9); env.splash(fish.position, 0.6); jump = null; }
      else {
        fish.position.copy(jump.a).addScaledVector(jump.dir, u * 1.3); fish.position.y = 0.75 * 4 * u * (1 - u) - 0.08;
        fish.rotation.set(0, Math.atan2(-jump.dir.z, jump.dir.x), Math.cos(u * Math.PI) * 1.0);
      }
    } else if (env.fish > 0 && (fishT -= dt * env.fish) <= 0 && cam) {
      fishT = 7 + R() * 16;
      for (let k = 0; k < 20; k++) {
        const a = R() * 6.28, r = 7 + R() * 22, x = cam.x + Math.cos(a) * r, z = cam.z + Math.sin(a) * r;
        if (H(x, z) < -0.9) {
          jump = { t: 0, a: new V(x, 0, z), dir: new V(Math.cos(a + 1.5), 0, Math.sin(a + 1.5)) };
          fish.visible = true; env.ripple(x, z, 0.7); env.splash(jump.a, 0.4); break;
        }
      }
    }
  }
  function dispose() { group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } }); scene.remove(group); }
  function nearest(cam) {
    let best = 1e9, bp = null;
    for (let i = 0; i < ND; i++) { if (df[i].s < 0.5) continue; const d = df[i].p.distanceTo(cam); if (d < best) { best = d; bp = df[i].p; } }
    return { d: best, p: bp };
  }
  return { update, dispose, nearest };
}
