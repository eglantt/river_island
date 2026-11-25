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

  // ---- tent: one closed canvas shell (roof panels, low side walls, end walls, door flaps) ----
  {
    const acc = new Acc(), L = 2.3, W = 1.05, RH = 1.3, HWL = 0.3, nz = 8, nv = 5, V3 = THREE.Vector3;
    const cA = C('#56603f'), cB = C('#66704c'), cTop = C('#7c805c'), cDirt = C('#4b4232');
    const colFn = (v) => {
      tmp.copy(N.n2(v.x * 3, v.z * 3) > 0 ? cA : cB).lerp(cTop, sm(0.7, 1.3, v.y) * 0.6).lerp(cDirt, sm(0.2, 0.02, v.y) * 0.7);
      return tmp.multiplyScalar(0.9 + 0.15 * N.n2(v.x * 9, v.y * 9 + v.z * 7));
    };
    const tri = (pts, swF) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts.flatMap((p) => p.toArray()), 3)); g.computeVertexNormals(); acc.add(g, colFn, swF); };
    for (const side of [-1, 1]) {
      const pos = [], idx = [];
      for (let j = 0; j <= nv; j++) for (let i = 0; i <= nz; i++) {
        const u = i / nz, vv = j / nv, z = (u - 0.5) * L;
        const sag = 0.05 * Math.sin(Math.PI * u) * Math.sin(Math.PI * vv);
        const x = side * vv * W, y = RH + (HWL - RH) * vv;
        pos.push(x - side * sag * 0.6, y - sag * 0.8, z);
      }
      for (let j = 0; j < nv; j++) for (let i = 0; i < nz; i++) { const a = j * (nz + 1) + i; idx.push(a, a + 1, a + nz + 1, a + 1, a + nz + 2, a + nz + 1); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
      acc.add(g, colFn, (v) => Math.sin(Math.PI * Math.min(1, Math.abs(v.x) / W)) * 0.5);
      const e0 = new V3(side * W, HWL, -L / 2), e1 = new V3(side * W, HWL, L / 2), g0 = new V3(side * W, 0.02, -L / 2), g1 = new V3(side * W, 0.02, L / 2);
      tri([e0, e1, g1], () => 0.05); tri([e0, g1, g0], () => 0.05);
    }
    const bz = -L / 2 - 0.01;
    tri([new V3(0, RH + 0.01, bz), new V3(-W - 0.01, HWL, bz), new V3(W + 0.01, HWL, bz)], () => 0.08);
    tri([new V3(-W - 0.01, HWL, bz), new V3(-W - 0.01, 0.02, bz), new V3(W + 0.01, 0.02, bz)], () => 0.02);
    tri([new V3(-W - 0.01, HWL, bz), new V3(W + 0.01, 0.02, bz), new V3(W + 0.01, HWL, bz)], () => 0.02);
    for (const side of [-1, 1]) {
      const fz = L / 2 + 0.01, top = new V3(0, RH + 0.01, fz), eave = new V3(side * (W + 0.01), HWL, fz), foot = new V3(side * (W + 0.01), 0.02, fz), inner = new V3(side * 0.55, 0.02, fz + 0.45);
      tri([top, eave, inner], (v) => (v.y < 0.4 ? 0.5 : 0.15)); tri([eave, foot, inner], () => 0.4);
    }
    const W0 = W;
    const mat = patch(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 'tent', 0.06);
    const tent = new THREE.Mesh(acc.build(), mat); tent.castShadow = true; tent.receiveShadow = true;
    const poleAcc = new Acc(), ropeAcc = new Acc(), cPole = C('#6b6152'), cRope = C('#8c8468'), cPeg = C('#3b3128');
    for (const z of [-L / 2 - 0.02, L / 2 + 0.02]) poleAcc.add(limbGeo(new V3(0, 0, z), new V3(0, RH + 0.08, z), 0.022, 0.02, 5, 1), () => cPole, () => 0);
    const lines = [];
    for (const sz of [-1, 1]) lines.push([new V3(0, RH + 0.05, sz * L / 2), new V3(0, 0.02, sz * (L / 2 + 1.15))]);
    const k = HWL / (RH - HWL);
    for (const side of [-1, 1]) for (const z of [-L / 2 + 0.05, 0, L / 2 - 0.05]) lines.push([new V3(side * W, HWL, z), new V3(side * W * (1 + k), 0.02, z)]);
    for (const [p0, p1] of lines) {
      ropeAcc.add(limbGeo(p0, p1, 0.006, 0.006, 3, 1), () => cRope, () => 0);
      poleAcc.add(limbGeo(p1.clone().add(new V3(0, -0.06, 0)), p1.clone().add(new V3(0, 0.09, 0)), 0.016, 0.01, 4, 1), () => cPeg, () => 0);
    }
    const poles = new THREE.Mesh(poleAcc.build(), patch(new THREE.MeshLambertMaterial({ vertexColors: true }), 'pole', 0));
    const ropes = new THREE.Mesh(ropeAcc.build(), patch(new THREE.MeshLambertMaterial({ vertexColors: true }), 'rope', 0));
    // inside: canvas floor, rolled sleeping bag at the back wall, backpack at a side wall
    const inAcc = new Acc(), cFloor = C('#3f4231'), cBag = C('#4f6377'), cBag2 = C('#3c4c5c'), cStrap = C('#2a2a26'), cPack = C('#8a5f38'), cPack2 = C('#6e4a2c');
    {
      const fl = new THREE.PlaneGeometry(W0 * 1.96, L * 0.99, 10, 10); fl.rotateX(-Math.PI / 2);
      const P = fl.attributes.position;
      for (let i = 0; i < P.count; i++) { const x = P.getX(i), z = P.getZ(i), edge = Math.max(Math.abs(x) / (W0 * 0.98), Math.abs(z) / (L * 0.495)); P.setY(i, 0.05 + 0.015 * N.n2(x * 4, z * 4) + (edge > 0.93 ? 0.1 : 0)); }
      fl.computeVertexNormals();
      inAcc.add(fl, (v) => tmp.copy(cFloor).multiplyScalar(0.85 + 0.2 * N.n2(v.x * 6, v.z * 6)), () => 0);
      const bag = new THREE.CylinderGeometry(0.15, 0.15, 0.78, 14, 1); bag.rotateZ(Math.PI / 2); bag.translate(0, 0.2, -L / 2 + 0.3);
      inAcc.add(bag, (v) => (Math.abs(Math.abs(v.x) - 0.22) < 0.03 ? cStrap : (N.n2(v.x * 9, v.y * 9) > 0 ? cBag : cBag2)), () => 0);
      for (const sx of [-1, 1]) { const end = new THREE.CircleGeometry(0.15, 14); end.rotateY(sx * Math.PI / 2); end.translate(sx * 0.39, 0.2, -L / 2 + 0.3); inAcc.add(end, (v) => tmp.copy(cBag2).lerp(cBag, Math.hypot(v.y - 0.2, v.z + L / 2 - 0.3) * 5), () => 0); }
      const px = 0.55 * (R() < 0.5 ? -1 : 1), pz = 0.15;
      const body = new THREE.BoxGeometry(0.2, 0.46, 0.32, 2, 3, 2); body.translate(0, 0.28, 0);
      const BP = body.attributes.position; for (let i = 0; i < BP.count; i++) { BP.setX(i, BP.getX(i) * (1 - 0.15 * (BP.getY(i) - 0.05))); BP.setZ(i, BP.getZ(i) * (0.95 + 0.1 * Math.sin(BP.getY(i) * 6))); }
      body.computeVertexNormals();
      const flap = new THREE.BoxGeometry(0.22, 0.05, 0.34); flap.translate(0, 0.52, 0.01);
      const pocket = new THREE.BoxGeometry(0.07, 0.18, 0.22); pocket.translate(-Math.sign(px) * 0.12, 0.22, 0);
      for (const g of [body, flap, pocket]) { g.rotateZ(-Math.sign(px) * 0.25); g.translate(px, 0, pz); inAcc.add(g, (v) => (g === body ? cPack : cPack2), () => 0); }
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
