import * as THREE from 'three';

// Branched lightning bolts: camera-facing glowing ribbons (white core, blue halo), re-strokes and afterglow.
export function createLightning(scene, U) {
  const MAXQ = 420, pos = new Float32Array(MAXQ * 4 * 3), dir = new Float32Array(MAXQ * 4 * 3), side = new Float32Array(MAXQ * 4), wid = new Float32Array(MAXQ * 4), idx = [];
  for (let q = 0; q < MAXQ; q++) { const b = q * 4; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('dir', new THREE.BufferAttribute(dir, 3));
  g.setAttribute('side', new THREE.BufferAttribute(side, 1)); g.setAttribute('wid', new THREE.BufferAttribute(wid, 1)); g.setIndex(idx);
  const LU = { uB: { value: 0 } };
  const mat = new THREE.ShaderMaterial({
    uniforms: LU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    vertexShader: /* glsl */`
      attribute vec3 dir; attribute float side, wid; varying float vS, vW;
      void main(){
        vec3 toCam = normalize(cameraPosition - position);
        vec3 off = normalize(cross(dir, toCam));
        float d = length(cameraPosition - position);
        float w = max(wid, d * 0.0045);               // never thinner than ~2 px
        vec3 p = position + off * side * w * 4.0;     // ribbon wide enough for the halo
        vS = side; vW = wid;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform float uB; varying float vS, vW;
      void main(){
        float x = abs(vS);
        float core = exp(-x * x * 45.0), halo = exp(-x * x * 6.0);
        vec3 c = vec3(1.0) * core * 3.0 + vec3(0.55, 0.65, 1.0) * halo * 0.7;
        gl_FragColor = vec4(c * uB * (0.35 + 0.65 * min(vW * 3.0, 1.0)), 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(g, mat); mesh.frustumCulled = false; mesh.visible = false; mesh.renderOrder = 9; scene.add(mesh);

  let nq = 0;
  const seg = (a, b, w) => {
    if (nq >= MAXQ) return;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, L = Math.hypot(dx, dy, dz) || 1;
    for (let k = 0; k < 4; k++) {
      const p = k < 2 ? a : b, i = nq * 4 + k;
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      dir[i * 3] = dx / L; dir[i * 3 + 1] = dy / L; dir[i * 3 + 2] = dz / L;
      side[i] = k % 2 ? 1 : -1; wid[i] = w;
    }
    nq++;
  };
  // fractal path from a to b
  function path(a, b, w, depth, branchy, R) {
    const pts = [a.clone()], n = Math.max(6, Math.round(a.distanceTo(b) / 22));
    const D = new THREE.Vector3().subVectors(b, a), L = D.length();
    for (let i = 1; i < n; i++) {
      const t = i / n, p = a.clone().addScaledVector(D, t);
      p.x += (R() - 0.5) * L * 0.07; p.z += (R() - 0.5) * L * 0.07; p.y += (R() - 0.5) * L * 0.02;
      pts.push(p);
    }
    pts.push(b.clone());
    let nb = 0;
    for (let i = 1; i < pts.length; i++) {
      seg(pts[i - 1], pts[i], w);
      if (depth > 0 && R() < branchy && i < pts.length * 0.6 && nb < 3) { nb++;
        const rem = L * (1 - i / pts.length) * (0.12 + R() * 0.22);
        const bd = new THREE.Vector3((R() - 0.5) * 1.6, -0.55 - R() * 0.6, (R() - 0.5) * 1.6).normalize();
        path(pts[i], pts[i].clone().addScaledVector(bd, rem), w * 0.45, depth - 1, branchy * 0.55, R);
      }
    }
  }
  function strike(cam, kind, R = Math.random, fixA = null) {
    nq = 0;
    let p, dist;
    if (kind === 'cloud') {
      const a = fixA != null ? fixA : R() * Math.PI * 2; dist = 500 + R() * 1800;
      p = new THREE.Vector3(cam.x + Math.cos(a) * dist, 560 + R() * 140, cam.z + Math.sin(a) * dist);
      const q = p.clone().add(new THREE.Vector3((R() - 0.5) * 1400, -60 - R() * 120, (R() - 0.5) * 1400));
      path(p, q, 3.5, 1, 0.25, R);
    } else {
      const a = fixA != null ? fixA : R() * Math.PI * 2; dist = kind === 'near' ? 260 + R() * 250 : 500 + R() * 2000;
      const gx = cam.x + Math.cos(a) * dist, gz = cam.z + Math.sin(a) * dist;
      const top = new THREE.Vector3(gx + (R() - 0.5) * 300, 620 + R() * 120, gz + (R() - 0.5) * 300);
      path(top, new THREE.Vector3(gx, 0, gz), 3.2, 1, 0.12, R);
      p = new THREE.Vector3(gx, 0, gz);
    }
    for (let i = nq * 4; i < MAXQ * 4; i++) { pos[i * 3 + 1] = -9999; }
    for (const k of ['position', 'dir', 'side', 'wid']) g.attributes[k].needsUpdate = true;
    g.setDrawRange(0, nq * 6);
    return { pos: p, dist };
  }
  return {
    strike,
    set(b) { LU.uB.value = b; mesh.visible = b > 0.01; },
  };
}
