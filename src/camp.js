import * as THREE from 'three';
import { Acc, limbGeo, blobGeo, sm } from './world.js';
import { U, patch } from './shaders.js';
import { rng } from './noise.js';

const C = (h) => new THREE.Color(h);

// Tent (faded dark-green canvas) + campfire with flames, sparks, smoke and fire light.
export function createCamp(world, Q, scene, coarse) {
  const R = rng(4242), { H, N, islandE, trunks } = world, tmp = new THREE.Color();
  // ---- pick a flat open spot on the island ----
  let best = null;
  for (let t = 0; t < 900; t++) {
    const x = (R() * 2 - 1) * world.irx * 0.9, z = world.zc0 + (R() * 2 - 1) * world.irz * 0.9;
    if (islandE(x, z) > 0.62) continue;
    const h = H(x, z); if (h < 0.5) continue;
    let flat = 0; for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2], [1.5, 1.5], [-1.5, -1.5]]) flat += Math.abs(H(x + dx, z + dz) - h);
    if (flat > 1.05) continue; // no more than ~5 degrees of slope
    const clear = Math.min(...trunks.map(([tx, tz, r]) => Math.hypot(tx - x, tz - z) - r));
    const sp = Math.hypot(world.spawn[0] - x, world.spawn[1] - z);
    if (clear < 3.2 || sp < 3.5) continue;
    const score = -flat * 4 + Math.min(clear, 6) * 0.3 - Math.abs(sp - 9) * 0.05;
    if (!best || score > best.s) best = { x, z, s: score };
  }
  if (!best) best = { x: world.spawn[0] - 4, z: world.spawn[1] };
  // tent door faces direction fa; the fire is ~4 m in front of it and ~1.2 m off the tent axis
  const FD = 4.0, FO = 1.2 * (R() < 0.5 ? -1 : 1);
  const firePos = (a) => [best.x + Math.cos(a) * FD - Math.sin(a) * FO, best.z + Math.sin(a) * FD + Math.cos(a) * FO];
  let fa = 0, fs = -1e9;
  for (let k = 0; k < 16; k++) {
    const a = k / 16 * Math.PI * 2, [fx, fz] = firePos(a);
    if (islandE(fx, fz) > 0.8) continue;
    const s = Math.min(...trunks.map(([tx, tz, r]) => Math.hypot(tx - fx, tz - fz) - r)) - Math.abs(H(fx, fz) - H(best.x, best.z)) * 3;
    if (s > fs) { fs = s; fa = a; }
  }
  const tentP = new THREE.Vector3(best.x, H(best.x, best.z), best.z);
  const fp = firePos(fa), fireP = new THREE.Vector3(fp[0], 0, fp[1]); fireP.y = H(fireP.x, fireP.z);
  const yaw = Math.atan2(Math.cos(fa), Math.sin(fa)); // tent local +z (door) -> direction fa
  const group = new THREE.Group(); group.visible = false; scene.add(group);

  // ---- tent: one canvas without open seams (roof and side walls extruded from one profile, end walls lofted onto
  // the very same edge points), pinned along the seams so the wind can only billow the panels; its foot follows the ground ----
  {
    const acc = new Acc(), L = 2.3, W = 1.05, RH = 1.3, HWL = 0.3, V3 = THREE.Vector3;
    const cA = C('#56603f'), cB = C('#66704c'), cTop = C('#7c805c'), cDirt = C('#4b4232'), cSeam = C('#3e4630');
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const gl = (x, z) => H(tentP.x + x * cy + z * sy, tentP.z - x * sy + z * cy) - tentP.y + 0.02; // local ground height
    const toGround = (v) => { if (v.y < HWL) v.y += gl(v.x, v.z) * (1 - v.y / HWL); return v; };
    const colFn = (v) => {
      tmp.copy(N.n2(v.x * 3, v.z * 3) > 0 ? cA : cB).lerp(cTop, sm(0.7, 1.3, v.y) * 0.6);
      const gy = v.y - gl(v.x, v.z); tmp.lerp(cDirt, sm(0.22, 0.02, gy) * 0.7);
      // creases toward the peg points along the eaves and down from the ridge, darker seams
      const pz = Math.min(Math.abs(v.z + L / 2 - 0.05), Math.abs(v.z), Math.abs(v.z - L / 2 + 0.05));
      tmp.lerp(cSeam, (sm(0.12, 0.0, pz) * sm(0.6, 0.3, v.y) + sm(0.05, 0.0, Math.abs(v.x)) * sm(1.1, 1.3, v.y)) * 0.45);
      return tmp.multiplyScalar(0.9 + 0.15 * N.n2(v.x * 9, v.y * 9 + v.z * 7));
    };
    // sway: 0 on every seam (ground, eaves, ridge, end edges), most in the middle of each panel
    const swayF = (v) => {
      const u = Math.max(0, Math.min(1, v.z / L + 0.5)), ez = Math.sin(Math.PI * u);
      if (Math.abs(Math.abs(v.z) - L / 2) < 0.02) { // end walls
        const wy = v.y >= HWL ? W * (RH - v.y) / (RH - HWL) : W;
        return 0.6 * Math.max(0, 1 - Math.abs(v.x) / Math.max(0.05, wy)) * Math.sin(Math.PI * Math.min(1, Math.max(0, v.y) / RH));
      }
      const vv = v.y >= HWL - 0.005 ? (v.y - HWL) / (RH - HWL) : Math.max(0, v.y) / HWL;
      return ez * Math.sin(Math.PI * Math.min(1, Math.max(0, vv))) * (v.y >= HWL ? 1 : 0.35);
    };
    // the cross-section: ground - wall - eave - roof - ridge - roof - eave - wall - ground
    const prof = [[-W, 0], [-W, HWL * 0.5], [-W, HWL]];
    for (let k = 1; k <= 5; k++) prof.push([-W + W * k / 5, HWL + (RH - HWL) * k / 5]); // ... up to the ridge [0, RH]
    for (let k = 1; k <= 5; k++) prof.push([W * k / 5, RH - (RH - HWL) * k / 5]);       // ... down to the right eave
    prof.push([W, HWL * 0.5], [W, 0]);
    const nz = 10, sag = (u, x, y) => (y > HWL && y < RH ? 0.035 : y < HWL && y > 0 ? 0.02 : 0) * Math.sin(Math.PI * u); // slack canvas
    const shell = (pts, idx) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)); g.setIndex(idx); g.computeVertexNormals(); acc.add(g, colFn, swayF); };
    { const pts = [], idx = [], np = prof.length;
      for (let i = 0; i <= nz; i++) for (const [x, y] of prof) {
        const u = i / nz, z = (u - 0.5) * L, sg = sag(u, x, y), v = toGround(new V3(x - Math.sign(x) * sg * 0.4, y - sg, z)); pts.push(v.x, v.y, v.z);
      }
      for (let i = 0; i < nz; i++) for (let j = 0; j < np - 1; j++) { const a = i * np + j; idx.push(a, a + np, a + 1, a + 1, a + np, a + np + 1); }
      shell(pts, idx);
    }
    // eave lips: the roof overhangs the walls by ~6 cm
    for (const sd of [-1, 1]) { const pts = [], idx = [];
      for (let i = 0; i <= nz; i++) { const z = (i / nz - 0.5) * (L + 0.06); pts.push(sd * W, HWL + 0.004, z, sd * (W + 0.065), HWL - 0.035, z); }
      for (let i = 0; i < nz; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
      shell(pts, idx);
    }
    // end walls lofted between the left and the right edge of the profile (back) / the outer edge and the door edge (front)
    const half = prof.slice(0, 8); // ground -> eave -> ridge (left half, 8 points)
    const loft = (A, B, z, n = 6) => { const pts = [], idx = [];
      for (let j = 0; j < A.length; j++) for (let k = 0; k <= n; k++) { const t = k / n, x = A[j][0] + (B[j][0] - A[j][0]) * t, y = A[j][1] + (B[j][1] - A[j][1]) * t; const v = toGround(new V3(x, y, z)); pts.push(v.x, v.y, v.z); }
      for (let j = 0; j < A.length - 1; j++) for (let k = 0; k < n; k++) { const a = j * (n + 1) + k; idx.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2); }
      shell(pts, idx);
    };
    loft(half, half.map(([x, y]) => [-x, y]), -L / 2);
    // front: two panels between the outer edge and the door's slanted edge (the door is open, flaps rolled and tied)
    const DW = 0.42, DH = 1.05, door = half.map(([x, y], j) => { const t = j / (half.length - 1); return t < 0.8 ? [-DW + DW * (t / 0.8), DH * (t / 0.8)] : [0, DH + (RH - DH) * ((t - 0.8) / 0.2)]; });
    loft(half, door, L / 2, 4); loft(half.map(([x, y]) => [-x, y]), door.map(([x, y]) => [-x, y]), L / 2, 4);
    // the flaps rolled up along the door edges, tied with two tapes; the zip line
    for (const sd of [-1, 1]) {
      const p0 = toGround(new V3(sd * (DW + 0.02), 0.03, L / 2 + 0.04)), p1 = new V3(sd * 0.03, DH - 0.05, L / 2 + 0.04);
      acc.add(limbGeo(p0, p1, 0.055, 0.04, 7, 3), (v) => tmp.copy(cB).multiplyScalar(0.82 + 0.15 * N.n2(v.y * 25, v.x * 9)), () => 0);
      for (const t of [0.3, 0.7]) { const c = p0.clone().lerp(p1, t); acc.add(new THREE.TorusGeometry(0.058 - t * 0.012, 0.008, 4, 10).rotateX(Math.PI / 2).rotateZ(Math.atan2(p1.x - p0.x, p1.y - p0.y)).translate(c.x, c.y, c.z), () => cDirt, () => 0); }
      acc.add(limbGeo(new V3(sd * 0.012, DH - 0.02, L / 2 + 0.005), new V3(sd * 0.012, RH - 0.02, L / 2 + 0.005), 0.006, 0.006, 3, 1), () => C('#2a2c24'), () => 0);
    }
    const W0 = W;
    const mat = patch(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 'tent', 0.12);
    const tent = new THREE.Mesh(acc.build(), mat); tent.castShadow = true; tent.receiveShadow = true;
    const poleAcc = new Acc(), ropeAcc = new Acc(), cPole = C('#6b6152'), cRope = C('#8c8468'), cPeg = C('#3b3128');
    for (const z of [-L / 2 - 0.02, L / 2 + 0.02]) poleAcc.add(limbGeo(new V3(0, gl(0, z) - 0.05, z), new V3(0, RH + 0.08, z), 0.022, 0.02, 5, 1), () => cPole, () => 0);
    const lines = [];
    for (const sz of [-1, 1]) lines.push([new V3(0, RH + 0.05, sz * L / 2), new V3(0, 0, sz * (L / 2 + 1.15))]);
    const k = HWL / (RH - HWL);
    for (const side of [-1, 1]) for (const z of [-L / 2 + 0.05, 0, L / 2 - 0.05]) lines.push([new V3(side * (W + 0.06), HWL - 0.03, z), new V3(side * W * (1 + k), 0, z)]);
    for (const [p0, p1] of lines) {
      p1.y = gl(p1.x, p1.z) + 0.03;
      ropeAcc.add(limbGeo(p0, p1, 0.006, 0.006, 3, 1), () => cRope, () => 0);
      // a little wooden tensioner on the line, the peg driven in leaning away from the tent
      const tz = p0.clone().lerp(p1, 0.82), dir = p1.clone().sub(p0).normalize();
      poleAcc.add(limbGeo(tz.clone().addScaledVector(dir, -0.035), tz.clone().addScaledVector(dir, 0.035), 0.012, 0.012, 4, 1), () => cPole, () => 0);
      const out = new V3(dir.x, 0, dir.z).normalize();
      poleAcc.add(limbGeo(p1.clone().add(new V3(-out.x * 0.04, -0.12, -out.z * 0.04)), p1.clone().add(new V3(out.x * 0.035, 0.08, out.z * 0.035)), 0.016, 0.01, 4, 1), () => cPeg, () => 0);
    }
    const poles = new THREE.Mesh(poleAcc.build(), patch(new THREE.MeshLambertMaterial({ vertexColors: true }), 'pole', 0));
    const ropes = new THREE.Mesh(ropeAcc.build(), patch(new THREE.MeshLambertMaterial({ vertexColors: true }), 'rope', 0));
    // inside: canvas floor, rolled sleeping bag at the back wall, backpack at a side wall
    const inAcc = new Acc(), cFloor = C('#3f4231'), cBag = C('#4f6377'), cBag2 = C('#3c4c5c'), cStrap = C('#2a2a26'), cPack = C('#8a5f38'), cPack2 = C('#6e4a2c');
    {
      const fl = new THREE.PlaneGeometry(W0 * 1.98, L * 0.995, 14, 14); fl.rotateX(-Math.PI / 2);
      const P = fl.attributes.position;
      for (let i = 0; i < P.count; i++) { const x = P.getX(i), z = P.getZ(i), edge = Math.max(Math.abs(x) / (W0 * 0.98), Math.abs(z) / (L * 0.495)); P.setY(i, gl(x, z) + 0.035 + 0.012 * N.n2(x * 4, z * 4) + (edge > 0.93 ? 0.1 : 0)); /* follows the ground, bathtub rim under the walls */ }
      fl.computeVertexNormals();
      inAcc.add(fl, (v) => tmp.copy(cFloor).multiplyScalar(0.85 + 0.2 * N.n2(v.x * 6, v.z * 6)), () => 0);
      const bag = new THREE.CylinderGeometry(0.15, 0.15, 0.78, 14, 1); bag.rotateZ(Math.PI / 2); bag.translate(0, 0.2 + gl(0, -L / 2 + 0.3), -L / 2 + 0.3);
      inAcc.add(bag, (v) => (Math.abs(Math.abs(v.x) - 0.22) < 0.03 ? cStrap : (N.n2(v.x * 9, v.y * 9) > 0 ? cBag : cBag2)), () => 0);
      for (const sx of [-1, 1]) { const end = new THREE.CircleGeometry(0.15, 14); end.rotateY(sx * Math.PI / 2); end.translate(sx * 0.39, 0.2 + gl(0, -L / 2 + 0.3), -L / 2 + 0.3); inAcc.add(end, (v) => tmp.copy(cBag2).lerp(cBag, Math.hypot(v.y - 0.2, v.z + L / 2 - 0.3) * 5), () => 0); }
      const px = 0.32 * (R() < 0.5 ? -1 : 1), pz = 0.15; /* well clear of the sloping roof (it is only ~0.55 m high at 0.8 m from the axis) */
      const body = new THREE.BoxGeometry(0.2, 0.46, 0.32, 2, 3, 2); body.translate(0, 0.28, 0);
      const BP = body.attributes.position; for (let i = 0; i < BP.count; i++) { BP.setX(i, BP.getX(i) * (1 - 0.15 * (BP.getY(i) - 0.05))); BP.setZ(i, BP.getZ(i) * (0.95 + 0.1 * Math.sin(BP.getY(i) * 6))); }
      body.computeVertexNormals();
      const flap = new THREE.BoxGeometry(0.22, 0.05, 0.34); flap.translate(0, 0.52, 0.01);
      const pocket = new THREE.BoxGeometry(0.07, 0.18, 0.22); pocket.translate(-Math.sign(px) * 0.12, 0.22, 0);
      for (const g of [body, flap, pocket]) { g.rotateZ(-Math.sign(px) * 0.12); g.translate(px, gl(px, pz) + 0.02, pz); inAcc.add(g, (v) => (g === body ? cPack : cPack2), () => 0); }
    }
    const inside = new THREE.Mesh(inAcc.build(), patch(new THREE.MeshLambertMaterial({ vertexColors: true }), 'tentin', 0)); inside.receiveShadow = true;
    const tg = new THREE.Group(); tg.add(tent, poles, ropes, inside);
    tg.position.copy(tentP); tg.position.y -= 0.02;
    // door faces the fire: local +z -> direction to fire
    tg.rotation.y = yaw;
    group.add(tg);
  }

  // ---- fire pit: stones, ash, logs, embers ----
  const fireG = new THREE.Group(); fireG.position.copy(fireP); group.add(fireG);
  {
    const acc = new Acc(), cS = C('#7d776d'), cS2 = C('#5f5a52'), cLog = C('#3a2c20'), cChar = C('#141210');
    const nS = 11;
    for (let k = 0; k < nS; k++) {
      const a = k / nS * Math.PI * 2 + R() * 0.2, r = 0.42 + R() * 0.05, c = new THREE.Vector3(Math.cos(a) * r, 0.04, Math.sin(a) * r);
      const base = R() < 0.5 ? cS : cS2;
      acc.add(blobGeo(N, c, 0.08 + R() * 0.05, 0.7, 1, 0.25), (v, n) => tmp.copy(base).multiplyScalar(0.7 + 0.35 * Math.max(0, n.y) - 0.25 * sm(0.4, 0.2, Math.hypot(v.x, v.z))), () => 0);
    }
    for (let k = 0; k < 5; k++) {
      const a = k / 5 * Math.PI * 2 + 0.3, p0 = new THREE.Vector3(Math.cos(a) * 0.34, 0.02, Math.sin(a) * 0.34), p1 = new THREE.Vector3(Math.cos(a) * 0.05, 0.3 + R() * 0.06, Math.sin(a) * 0.05);
      acc.add(limbGeo(p0, p1, 0.045, 0.03, 6, 2), (v) => tmp.copy(cLog).lerp(cChar, sm(0.08, 0.25, v.y)), () => 0);
    }
    const ash = new THREE.CircleGeometry(0.38, 16); ash.rotateX(-Math.PI / 2); ash.translate(0, 0.012, 0);
    acc.add(ash, (v) => tmp.setRGB(0.09, 0.085, 0.08).multiplyScalar(1 + 0.6 * N.n2(v.x * 12, v.z * 12)), () => 0);
    const m = new THREE.Mesh(acc.build(), patch(new THREE.MeshLambertMaterial({ vertexColors: true }), 'pit', 0)); m.receiveShadow = true; fireG.add(m);
  }
  const emberMat = new THREE.MeshBasicMaterial({ color: '#ff5a10', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const embers = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 6).scale(1, 0.25, 1), emberMat); embers.position.y = 0.04; fireG.add(embers);

  // ---- flames: crossed quads with a procedural fire shader ----
  const FU = { uFire: { value: 1 }, uFlick: { value: 1 } };
  {
    const pos = [], uv = [], sd = [], idx = [];
    for (let k = 0; k < 3; k++) {
      const a = k / 3 * Math.PI, c = Math.cos(a), s = Math.sin(a), w = 0.3, h = 1.0, b = pos.length / 3;
      for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) { pos.push((u - 0.5) * 2 * w * c, 0.06 + v * h, (u - 0.5) * 2 * w * s); uv.push(u, v); sd.push(k * 0.37); }
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('seed', new THREE.Float32BufferAttribute(sd, 1)); g.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      uniforms: Object.assign({}, FU, { uTime: U.uTime, tNoise: U.tNoise, uWind: U.uWind, uWindDir: U.uWindDir }),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      vertexShader: /* glsl */`
        attribute float seed; uniform float uFire, uWind, uTime; uniform vec2 uWindDir; varying vec2 vUv; varying float vSeed;
        void main(){
          vUv = uv; vSeed = seed;
          vec3 p = position; p.y = 0.06 + (p.y - 0.06) * mix(0.3, 1.0, uFire);
          vec4 w = modelMatrix * vec4(p, 1.0);
          float k = uv.y * uv.y;
          w.xz += uWindDir * k * (0.12 + uWind * 0.5) + vec2(sin(uTime * 7.0 + seed * 9.0), cos(uTime * 6.0 + seed * 5.0)) * k * 0.04;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D tNoise; uniform float uTime, uFire, uFlick; varying vec2 vUv; varying float vSeed;
        void main(){
          vec2 p = vUv; float x = (p.x - 0.5) * 2.0;
          float n = texture2D(tNoise, vec2(p.x * 0.55 + vSeed, p.y * 0.7 - uTime * 1.4)).r * 0.6 + texture2D(tNoise, vec2(p.x * 1.3 + vSeed * 2.0, p.y * 1.5 - uTime * 2.6)).g * 0.4;
          float width = 0.95 * (1.0 - p.y) + 0.05;
          float shape = 1.0 - smoothstep(0.2, 1.0, abs(x) / width);
          float f = smoothstep(0.32, 0.72, shape * (1.12 - p.y) + (n - 0.5) * 0.75);
          f *= smoothstep(0.0, 0.06, p.y);
          vec3 c = mix(vec3(0.9, 0.18, 0.02), vec3(1.0, 0.78, 0.32), smoothstep(0.45, 1.0, f + (1.0 - p.y) * 0.25));
          gl_FragColor = vec4(c * f * 2.4 * uFire * uFlick, 1.0);
        }`,
    });
    const flames = new THREE.Mesh(g, mat); flames.renderOrder = 8; flames.frustumCulled = false; fireG.add(flames);
  }

  // ---- sparks & smoke (points) ----
  const SU = { uSmoke: { value: 0.3 }, uSmokeDark: { value: 0 } };
  function pts(n, kind) {
    const pos = new Float32Array(n * 3), seed = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) seed.set([R(), R(), R(), R()], i * 4);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
    const spark = kind === 'spark';
    const mat = new THREE.ShaderMaterial({
      uniforms: Object.assign({ uBase: { value: fireP } }, FU, SU, { uTime: U.uTime, uWind: U.uWind, uWindDir: U.uWindDir, uPx: U.uPx, tNoise: U.tNoise, uAmb: U.uAmb, uSunCol: U.uSunCol, uSunVis: U.uSunVis }),
      transparent: true, depthWrite: false, blending: spark ? THREE.AdditiveBlending : THREE.NormalBlending, fog: false,
      vertexShader: /* glsl */`
        attribute vec4 seed; uniform vec3 uBase; uniform float uTime, uWind, uFire, uSmoke, uPx; uniform vec2 uWindDir; varying float vA; varying vec4 vS;
        void main(){
          vS = seed;
          ${spark ? `
            float life = fract(uTime * (0.45 + seed.x * 0.5) + seed.y);
            vec3 p = uBase + vec3((seed.z - 0.5) * 0.3, 0.15 + life * (1.2 + seed.w * 1.4) * (0.4 + uFire), (seed.w - 0.5) * 0.3);
            p.xz += uWindDir * life * life * (0.3 + uWind * 2.0) + vec2(sin(uTime * 3.0 + seed.x * 20.0), cos(uTime * 2.6 + seed.z * 17.0)) * life * 0.15;
            vA = (1.0 - life) * step(0.25, uFire) * uFire;
            vec4 mv = viewMatrix * vec4(p, 1.0);
            gl_PointSize = clamp(0.035 * uPx / -mv.z, 1.0, 5.0);
          ` : `
            float life = fract(uTime * 0.075 * (0.8 + seed.x * 0.5) + seed.y);
            float hgt = life * (3.2 + seed.w * 2.0) / (1.0 + uWind * 1.2);
            vec3 p = uBase + vec3((seed.z - 0.5) * 0.2, 0.35 + hgt, (seed.w - 0.5) * 0.2);
            p.xz += uWindDir * pow(life, 1.4) * (0.6 + uWind * 9.0) + vec2(sin(uTime * 0.4 + seed.x * 9.0), cos(uTime * 0.35 + seed.z * 7.0)) * life * 0.8;
            float size = 0.35 + life * (1.6 + uSmoke * 1.8);
            vA = smoothstep(0.0, 0.08, life) * pow(1.0 - life, 1.3) * uSmoke;
            vec4 mv = viewMatrix * vec4(p, 1.0);
            gl_PointSize = clamp(size * uPx / -mv.z, 1.0, 600.0);
          `}
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D tNoise; uniform float uSmokeDark, uSunVis; uniform vec3 uAmb, uSunCol; varying float vA; varying vec4 vS;
        void main(){
          vec2 c = gl_PointCoord - 0.5; float r = length(c);
          ${spark ? `
            float g = smoothstep(0.5, 0.0, r);
            gl_FragColor = vec4(vec3(1.0, 0.55, 0.15) * g * vA * 2.0, 1.0);
          ` : `
            float n = texture2D(tNoise, gl_PointCoord * 0.35 + vS.xy).r;
            float a = smoothstep(0.5, 0.1, r) * (0.55 + 0.6 * n) * vA * 0.8;
            vec3 col = mix(vec3(0.78, 0.78, 0.76), vec3(0.42, 0.42, 0.42), uSmokeDark) * (uAmb * 1.25 + uSunCol * uSunVis * 0.35 + 0.04);
            gl_FragColor = vec4(col, a);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          `}
        }`,
    });
    const p = new THREE.Points(g, mat); p.frustumCulled = false; p.renderOrder = spark ? 9 : 7; return p;
  }
  const sparks = pts(coarse ? 12 : 26, 'spark'), smoke = pts(Q.smoke, 'smoke');
  group.add(sparks, smoke);

  // ---- fire light: real point light on desktop, painted ground glow on phones ----
  let light = null, glow = null;
  const GU = { uGlow: { value: 0 } };
  if (!coarse) { light = new THREE.PointLight('#ff9a4a', 0, 14, 1.6); light.position.copy(fireP).add(new THREE.Vector3(0, 0.7, 0)); group.add(light); }
  {
    const n = 18, S = 12, pos = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) { const x = fireP.x + (i / n - 0.5) * S, z = fireP.z + (j / n - 0.5) * S; pos.push(x, Math.max(H(x, z), 0) + 0.05, z); }
    const idx = []; for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = j * (n + 1) + i; idx.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
    glow = new THREE.Mesh(g, new THREE.ShaderMaterial({
      uniforms: Object.assign({ uC: { value: fireP } }, GU), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }',
      fragmentShader: 'uniform vec3 uC; uniform float uGlow; varying vec3 vW; void main(){ float d = length(vW.xz - uC.xz); float f = exp(-d*d*0.09) * uGlow; gl_FragColor = vec4(vec3(1.0,0.42,0.1)*f*0.35, 1.0); }',
    }));
    glow.renderOrder = 4; group.add(glow);
  }

  // ---- fire state ----
  let fire = 1, smokeAmt = 0.25, stormT = 0, out = false, relightT = 0, smolder = 0;
  function update(dt, t, e) {
    if (!group.visible) return;
    if (e.weather === 'storm') stormT += dt; else stormT = Math.max(0, stormT - dt * 0.5);
    let target;
    if (out) {
      target = 0; smolder = Math.max(0, smolder - dt / 150);
      if (e.weather !== 'storm' && e.rain < 0.4) { relightT += dt; if (relightT > 25) { out = false; relightT = 0; } } else relightT = 0;
    } else {
      target = 1 - 0.6 * Math.min(1, e.rain / 0.75) - 0.15 * e.storm;
      if (stormT > 75) { out = true; smolder = 1; }
    }
    fire += (target - fire) * Math.min(1, dt * (target < fire ? 0.12 : 0.05));
    const sTarget = 0.22 + 0.7 * Math.min(1, e.rain / 0.75) * (fire > 0.05 || smolder > 0 ? 1 : 0.3) + 0.45 * smolder;
    smokeAmt += (sTarget - smokeAmt) * Math.min(1, dt * 0.3);
    const flick = 0.82 + 0.1 * Math.sin(t * 11.3) + 0.08 * Math.sin(t * 23.7 + 1.3) + 0.06 * Math.sin(t * 5.1);
    FU.uFire.value = fire; FU.uFlick.value = flick;
    SU.uSmoke.value = smokeAmt; SU.uSmokeDark.value = Math.min(1, e.rain * 0.5 + smolder * 0.4);
    emberMat.color.setRGB(1, 0.32, 0.06).multiplyScalar(0.25 + 0.75 * Math.max(fire, smolder * 0.35) * flick);
    const li = Math.max(fire * flick, smolder * 0.08) * (0.25 + 0.75 * e.night);
    if (light) light.intensity = 5 * li;
    GU.uGlow.value = li * (light ? 0.35 : 1);
  }
  function setVisible(v) { group.visible = v; }
  function dispose() { group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); scene.remove(group); }
  return {
    update, setVisible, dispose, fireP, tentP, yaw, halfW: 1.42, halfL: 1.2,
    get state() { return { fire, smoke: smokeAmt, out }; },
    blocks: (x, z) => {
      if (!group.visible) return false;
      const dx = x - tentP.x, dz = z - tentP.z, lx = dx * Math.cos(yaw) - dz * Math.sin(yaw), lz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
      return (Math.abs(lx) < 1.4 && Math.abs(lz) < 1.45) || Math.hypot(x - fireP.x, z - fireP.z) < 0.65;
    },
  };
}
