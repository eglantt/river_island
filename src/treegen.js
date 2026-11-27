// Procedural tree skeletons: space colonization with kinks, light/gravity tropism,
// pipe-model radii and smooth bark tubes with collars at forks.
import * as THREE from 'three';

const V3 = THREE.Vector3;

// ---------- skeleton ----------
// o: { R, base, trunk: [V3...] (manual trunk points incl. base), pts: [V3] attraction points,
//      step, di, dk, maxIter, maxNodes, kink, elbow, persist, trop(node)->V3, maxKids }
export function growSkeleton(o) {
  const { R } = o, step = o.step, di = o.di, dk = o.dk, cell = di;
  const nodes = [];
  const grid = new Map();
  const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  const addNode = (p, d, parent, extra = {}) => {
    const pa = parent >= 0 ? nodes[parent] : null, sl = pa ? p.distanceTo(pa.p) : 0;
    const n = { p: p.clone(), d: d.clone().normalize(), parent, kids: [], r: 0, dist: pa ? pa.dist + sl : 0, out: 0, trunk: false, ...extra };
    if (pa && !n.trunk) n.out = (pa.trunk ? 0 : pa.out) + sl;
    nodes.push(n); const i = nodes.length - 1;
    if (parent >= 0) nodes[parent].kids.push(i);
    const k = key(p.x, p.y, p.z); let b = grid.get(k); if (!b) grid.set(k, (b = [])); b.push(i);
    return i;
  };
  // manual trunk
  let prev = -1;
  for (let i = 0; i < o.trunk.length; i++) {
    const p = o.trunk[i], d = i < o.trunk.length - 1 ? new V3().subVectors(o.trunk[i + 1], p) : new V3().subVectors(p, o.trunk[i - 1]);
    prev = addNode(p, d, prev, { trunk: true });
  }
  let pts = o.pts.map((p) => ({ p, alive: true }));
  const acc = new Map();
  for (let it = 0; it < o.maxIter && nodes.length < o.maxNodes; it++) {
    acc.clear();
    let any = false;
    for (const a of pts) {
      if (!a.alive) continue;
      const cx = Math.floor(a.p.x / cell), cy = Math.floor(a.p.y / cell), cz = Math.floor(a.p.z / cell);
      let best = -1, bd = di * di;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const b = grid.get(`${cx + dx},${cy + dy},${cz + dz}`); if (!b) continue;
        for (const i of b) { const d2 = nodes[i].p.distanceToSquared(a.p); if (d2 < bd) { bd = d2; best = i; } }
      }
      if (best < 0) continue;
      if (bd < dk * dk) { a.alive = false; continue; }
      let v = acc.get(best); if (!v) acc.set(best, (v = new V3()));
      v.add(new V3().subVectors(a.p, nodes[best].p).normalize());
      any = true;
    }
    if (!any) break;
    for (const [i, v] of acc) {
      const n = nodes[i];
      if (n.kids.length >= (n.trunk ? 6 : o.maxKids)) continue;
      const d = v.normalize().clone();
      if (!n.trunk) d.addScaledVector(n.d, o.persist);
      d.add(o.trop(n));
      const kk = R() < o.elbowP ? o.elbow : o.kink;
      d.add(new V3(R() - 0.5, R() - 0.5, R() - 0.5).multiplyScalar(kk * 2)).normalize();
      const np = n.p.clone().addScaledVector(d, step * (0.8 + R() * 0.4));
      // avoid duplicate children
      if (n.kids.some((k) => nodes[k].p.distanceToSquared(np) < step * step * 0.2)) continue;
      addNode(np, d, i);
    }
    pts = pts.filter((a) => a.alive);
  }
  return nodes;
}

// pipe model radii, computed from the tips back to the root; small taper along each segment
export function pipeRadii(nodes, rTip, rRoot, n = 2.3, taper = 1.015) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const nd = nodes[i];
    if (!nd.kids.length) { nd.r = rTip; continue; }
    let s = 0; for (const k of nd.kids) s += Math.pow(nodes[k].r, n);
    nd.r = Math.pow(s, 1 / n) * taper;
  }
  // remap so tips keep rTip and the root gets rRoot: r' = rTip * (r/rTip)^e
  const e = Math.log(rRoot / rTip) / Math.log(Math.max(1.01, nodes[0].r / rTip));
  for (const nd of nodes) nd.r = rTip * Math.pow(nd.r / rTip, e);
  // distance to the nearest tip (path length), for leaf placement
  for (let i = nodes.length - 1; i >= 0; i--) {
    const nd = nodes[i];
    nd.tip = nd.kids.length ? Math.min(...nd.kids.map((c) => nodes[c].tip + nodes[c].p.distanceTo(nd.p))) : 0;
  }
  return nodes;
}

// split the node tree into chains: the thickest child continues the chain, others start new ones
export function chains(nodes) {
  const out = [], stack = [[0, -1]];
  while (stack.length) {
    const [start, from] = stack.pop();
    const ch = { idx: [], from };
    if (from >= 0) ch.idx.push(from);
    let i = start;
    for (;;) {
      ch.idx.push(i);
      const kids = nodes[i].kids; if (!kids.length) break;
      let best = kids[0]; for (const k of kids) if (nodes[k].r > nodes[best].r) best = k;
      for (const k of kids) if (k !== best) stack.push([k, i]);
      i = best;
    }
    out.push(ch);
  }
  return out;
}

// ---------- tube mesh ----------
// P: points, Rr: radii, opts: { noise(x,y)->[-1,1], irr, seed, flare (m), flareK, twist, uvScale, collar }
export function tube(P, Rr, opts) {
  const n = P.length; if (n < 2) return null;
  const rMax = Math.max(...Rr);
  const rad = opts.radial || (rMax > 0.2 ? 14 : rMax > 0.1 ? 10 : rMax > 0.045 ? 7 : rMax > 0.02 ? 5 : 3);
  const T = [], Nn = [], B = [];
  for (let i = 0; i < n; i++) {
    const t = new V3().subVectors(P[Math.min(n - 1, i + 1)], P[Math.max(0, i - 1)]).normalize(); T.push(t);
  }
  // parallel transport frames
  let nrm = Math.abs(T[0].y) < 0.9 ? new V3(0, 1, 0).cross(T[0]).normalize() : new V3(1, 0, 0).cross(T[0]).normalize();
  for (let i = 0; i < n; i++) {
    if (i > 0) { const q = new THREE.Quaternion().setFromUnitVectors(T[i - 1], T[i]); nrm = nrm.clone().applyQuaternion(q); nrm.addScaledVector(T[i], -nrm.dot(T[i])).normalize(); }
    Nn.push(nrm.clone()); B.push(new V3().crossVectors(T[i], nrm).normalize());
  }
  const pos = [], uv = [], idx = [], uvs = opts.uvScale || 0.6;
  const uRep = Math.max(1, Math.round(Math.PI * 2 * Rr[Math.min(1, n - 1)] / uvs));
  const irr = opts.irr ?? 0.1, sd = opts.seed || 0, noise = opts.noise, tw = opts.twist || 0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) s += P[i].distanceTo(P[i - 1]);
    const fl = opts.flare ? 1 + (opts.flareK || 0.8) * Math.exp(-s / opts.flare) : 1;
    const lob = opts.flare ? irr * (1 + 2.2 * Math.exp(-s / (opts.flare * 1.5))) : irr;
    for (let j = 0; j <= rad; j++) {
      const a = j / rad * Math.PI * 2, ag = a + s * tw;
      const c = Math.cos(a), sn = Math.sin(a);
      const k = 1 + lob * (noise(c * 1.3 + sd, s * 0.9 + sn * 1.3) * 0.75 + noise(c * 4 + sd, s * 4 + sn) * 0.25);
      const rr = Rr[i] * fl * Math.max(0.55, k);
      const cg = Math.cos(ag), sg = Math.sin(ag);
      pos.push(P[i].x + (Nn[i].x * cg + B[i].x * sg) * rr, P[i].y + (Nn[i].y * cg + B[i].y * sg) * rr, P[i].z + (Nn[i].z * cg + B[i].z * sg) * rr);
      uv.push(j / rad * uRep, s / uvs);
    }
  }
  const W = rad + 1;
  // end cap fitted exactly to the last ring: concentric rings toward the centre (for the cut-wood colouring);
  // a broken end bulges out into a splintered point
  if (opts.capEnd) {
    const cp = [], i0 = (n - 1) * W, Tn = T[n - 1], c0 = P[n - 1], rings = 4, bulge = opts.capEnd === 'broken' ? 0.7 : 0.06;
    const rim = []; for (let j = 0; j <= rad; j++) rim.push(new V3(pos[(i0 + j) * 3], pos[(i0 + j) * 3 + 1], pos[(i0 + j) * 3 + 2]));
    const rMean = rim.reduce((a, q) => a + q.distanceTo(c0), 0) / rim.length;
    const at = (j, k) => { // k = 0 rim .. rings centre
      const f = 1 - k / rings, q = c0.clone().lerp(rim[j], f);
      const jag = opts.capEnd === 'broken' ? (0.6 + 0.8 * Math.abs(Math.sin(j * 2.7 + sd * 3.1))) : 1;
      return q.addScaledVector(Tn, rMean * bulge * jag * (1 - f * f) + rMean * 0.02 * Math.sin(j * 1.9 + k * 2.3));
    };
    const pts = []; for (let k = 0; k <= rings; k++) { const row = []; for (let j = 0; j <= rad; j++) row.push(at(j, k)); pts.push(row); }
    for (let k = 0; k < rings; k++) for (let j = 0; j < rad; j++) {
      const a = pts[k][j], b = pts[k][j + 1], c = pts[k + 1][j], d = pts[k + 1][j + 1];
      cp.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, b.x, b.y, b.z, d.x, d.y, d.z, c.x, c.y, c.z);
    }
    const cg = new THREE.BufferGeometry(); cg.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
    cg.computeVertexNormals();
    // keep the winding facing outward (along the tangent)
    const nA = cg.attributes.normal; let dot = 0; for (let i = 0; i < nA.count; i++) dot += nA.getX(i) * Tn.x + nA.getY(i) * Tn.y + nA.getZ(i) * Tn.z;
    if (dot < 0) { const A = cg.attributes.position; for (let i = 0; i < A.count; i += 3) { for (let c = 0; c < 3; c++) { const t1 = A.getComponent(i + 1, c); A.setComponent(i + 1, c, A.getComponent(i + 2, c)); A.setComponent(i + 2, c, t1); } } cg.computeVertexNormals(); }
    cg.userData = { c: c0.clone(), r: rMean, axis: Tn.clone(), broken: opts.capEnd === 'broken' };
    opts._cap = cg;
  }
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < rad; j++) {
    const a = i * W + j, b = a + 1, c = a + W, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  // weld normals across the u seam
  const No = g.attributes.normal;
  for (let i = 0; i < n; i++) {
    const a = i * W, b = a + rad;
    const x = No.getX(a) + No.getX(b), y = No.getY(a) + No.getY(b), z = No.getZ(a) + No.getZ(b), l = Math.hypot(x, y, z) || 1;
    No.setXYZ(a, x / l, y / l, z / l); No.setXYZ(b, x / l, y / l, z / l);
  }
  return g;
}

// build bark tubes for every chain of a skeleton; collar flare where a branch leaves its parent
export function skeletonTubes(nodes, opts, emit) {
  for (const ch of chains(nodes)) {
    const P = [], Rr = [];
    const first = ch.from >= 0;
    for (let q = 0; q < ch.idx.length; q++) {
      const nd = nodes[ch.idx[q]];
      if (first && q === 0) {
        const nx = nodes[ch.idx[1]], d = new V3().subVectors(nx.p, nd.p), L = d.length(); d.normalize();
        // start inside the parent, then a collar just outside its surface
        P.push(nd.p.clone()); Rr.push(nx.r * 0.9);
        const off = Math.min(L * 0.7, nd.r * 1.15 + nx.r * 0.3);
        P.push(nd.p.clone().addScaledVector(d, off)); Rr.push(nx.r * (1.2 + Math.min(0.35, nd.r / nx.r * 0.08)));
        continue;
      }
      P.push(nd.p.clone()); Rr.push(nd.r);
    }
    // subdivide long thick chains with a Catmull-Rom pass for smooth trunks
    let PP = P, RR = Rr;
    if (Rr[0] > 0.06 && P.length >= 3) {
      const cr = new THREE.CatmullRomCurve3(P, false, 'centripetal', 0.5), m = (P.length - 1) * 2;
      PP = cr.getSpacedPoints(m); RR = PP.map((_, i) => { const t = i / m * (Rr.length - 1), a = Math.floor(t), b = Math.min(Rr.length - 1, a + 1); return Rr[a] + (Rr[b] - Rr[a]) * (t - a); });
    }
    // close the thick or broken ends (a hollow tube would show through from the end)
    const last = nodes[ch.idx[ch.idx.length - 1]], capEnd = emit.cap && (last.broken ? 'broken' : RR[RR.length - 1] > 0.03 ? 'cut' : null);
    const o2 = { ...opts, flare: !first ? opts.flare : 0, seed: (opts.seed || 0) + emit.count++ * 3.7, capEnd };
    const g = tube(PP, RR, o2);
    if (g) emit(g, nodes[ch.idx[first ? 1 : 0]]);
    if (g && o2._cap) emit.cap(o2._cap, last);
  }
}

// a root that leaves the trunk base and follows the ground
export function rootPath(R, H, base, ang, r0, len) {
  const P = [], Rr = []; let d = new V3(Math.cos(ang), 0, Math.sin(ang)), p = base.clone();
  const steps = 7;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const g = H(p.x, p.z);
    const q = p.clone(); q.y = i === 0 ? base.y + r0 * 1.6 : g + Math.max(-0.12, r0 * (1 - t) * 0.5 - 0.06);
    P.push(q); Rr.push(Math.max(0.012, r0 * Math.pow(1 - t, 1.4)));
    d.applyAxisAngle(new V3(0, 1, 0), (R() - 0.5) * 0.7);
    p.addScaledVector(d, len / steps);
  }
  return [P, Rr];
}

// attraction points inside an envelope given by inside(x,y,z) within a bounding box
export function samplePts(R, n, box, inside) {
  const out = []; let guard = 0;
  while (out.length < n && guard++ < n * 60) {
    const x = box[0] + R() * (box[3] - box[0]), y = box[1] + R() * (box[4] - box[1]), z = box[2] + R() * (box[5] - box[2]);
    if (inside(x, y, z)) out.push(new V3(x, y, z));
  }
  return out;
}
