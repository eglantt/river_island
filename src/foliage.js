import * as THREE from 'three';
import { rng } from './noise.js';

// Procedural foliage atlas: 3x2 tiles, each a whole chunk of crown with transparent gaps.
// 0 oak/maple spray, 1 birch spray, 2 willow streamers, 3 spruce bough, 4 bush mass, 5 dense core leaves
export const TILE = { oak: 0, birch: 1, willow: 2, spruce: 3, bush: 4, core: 5 };
const COLS = 3, ROWS = 2;
export function tileUV(t) { const c = t % COLS, r = Math.floor(t / COLS); return [c / COLS, 1 - (r + 1) / ROWS, (c + 1) / COLS, 1 - r / ROWS]; }

export function makeFoliageAtlas(size) {
  const W = size * COLS, Hh = size * ROWS, cv = document.createElement('canvas'); cv.width = W; cv.height = Hh;
  const g = cv.getContext('2d'), R = rng(31337), s = size / 256;
  const hsl = (h, sat, l, a = 1) => `hsla(${h},${sat}%,${l}%,${a})`;
  const leaf = (x, y, ang, len, wid, col, vein) => {
    g.save(); g.translate(x, y); g.rotate(ang); g.fillStyle = col; g.beginPath();
    g.moveTo(0, 0); g.quadraticCurveTo(len * 0.45, -wid, len, 0); g.quadraticCurveTo(len * 0.45, wid, 0, 0); g.fill();
    if (vein) { g.strokeStyle = 'rgba(30,45,15,0.35)'; g.lineWidth = Math.max(0.6, wid * 0.12); g.beginPath(); g.moveTo(0, 0); g.lineTo(len * 0.9, 0); g.stroke(); }
    g.restore();
  };
  const twig = (x0, y0, x1, y1, w, col = 'rgba(70,55,35,0.9)') => { g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.moveTo(x0, y0); g.quadraticCurveTo((x0 + x1) / 2 + (R() - 0.5) * 20 * s, (y0 + y1) / 2 + (R() - 0.5) * 20 * s, x1, y1); g.stroke(); };
  const inTile = (t, fn) => { const c = t % COLS, r = Math.floor(t / COLS); g.save(); g.translate(c * size, r * size); g.beginPath(); g.rect(0, 0, size, size); g.clip(); fn(); g.restore(); };
  // shade: leaves nearer the middle of the spray darker (inner shade), outer ones lighter
  const shade = (x, y, cx, cy, rad) => Math.max(0, Math.min(1, Math.hypot(x - cx, y - cy) / rad));

  // 0: broadleaf spray (oak / maple), radiating twigs with many leaves
  inTile(0, () => {
    const cx = 128 * s, cy = 128 * s;
    for (let b = 0; b < 9; b++) {
      const a = b / 9 * Math.PI * 2 + R() * 0.4, L = (70 + R() * 45) * s, ex = cx + Math.cos(a) * L, ey = cy + Math.sin(a) * L;
      twig(cx, cy, ex, ey, 2.2 * s);
    }
    for (let i = 0; i < 520; i++) {
      const a = R() * Math.PI * 2, rr = Math.pow(R(), 0.6) * 118 * s, x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr * 0.92;
      const sh = shade(x, y, cx, cy, 118 * s), l = 20 + sh * 22 + R() * 9, h = 88 + R() * 26 - (R() < 0.06 ? 30 : 0);
      leaf(x, y, a + (R() - 0.5) * 1.6, (12 + R() * 9) * s, (5 + R() * 3) * s, hsl(h, 28 + R() * 16, l * 0.92), true);
    }
  });
  // 1: birch spray, fine drooping twigs with small leaves
  inTile(1, () => {
    for (let b = 0; b < 14; b++) {
      let x = (30 + R() * 196) * s, y = (10 + R() * 40) * s; const len = 7 + Math.floor(R() * 8);
      for (let k = 0; k < len; k++) {
        const nx = x + (R() - 0.5) * 16 * s, ny = y + (13 + R() * 7) * s; twig(x, y, nx, ny, 1.1 * s, 'rgba(60,50,40,0.8)');
        for (let q = 0; q < 4; q++) leaf(nx + (R() - 0.5) * 8 * s, ny + (R() - 0.5) * 8 * s, Math.PI / 2 + (R() - 0.5) * 2.2, (6 + R() * 4) * s, (3 + R() * 1.5) * s, hsl(78 + R() * 20, 34 + R() * 14, 26 + R() * 20 + (y / s / 256) * 4), false);
        x = nx; y = ny; if (y > 245 * s) break;
      }
    }
  });
  // 2: willow streamers
  inTile(2, () => {
    for (let b = 0; b < 22; b++) {
      let x = (10 + R() * 236) * s, y = (R() * 30) * s; const sway = (R() - 0.5) * 0.4;
      while (y < 250 * s) {
        const nx = x + sway * 10 * s + (R() - 0.5) * 3 * s, ny = y + 9 * s; twig(x, y, nx, ny, 0.9 * s, 'rgba(90,80,40,0.7)');
        leaf(nx, ny, Math.PI / 2 + 0.6 + (R() - 0.5) * 0.6, (14 + R() * 6) * s, 2.2 * s, hsl(75 + R() * 15, 30 + R() * 14, 28 + R() * 18), false);
        leaf(nx, ny, Math.PI / 2 - 0.6 + (R() - 0.5) * 0.6, (14 + R() * 6) * s, 2.2 * s, hsl(75 + R() * 15, 30 + R() * 14, 28 + R() * 18), false);
        x = nx; y = ny;
      }
    }
  });
  // 3: spruce bough — horizontal branch (left = trunk side), side shoots covered in needles
  inTile(3, () => {
    const y0 = 110 * s;
    twig(4 * s, y0, 250 * s, y0 + 14 * s, 4 * s, 'rgba(55,40,28,1)');
    for (let k = 0; k < 13; k++) {
      const t = k / 13, bx = (14 + t * 230) * s, by = y0 + t * 14 * s, L = (95 - t * 60) * s;
      for (const sd of [-1, 1]) {
        const ex = bx + L * 0.55, ey = by + sd * L * 0.65; twig(bx, by, ex, ey, 1.6 * s, 'rgba(50,40,28,1)');
        for (let i = 0; i < 26; i++) {
          const u = i / 26, px = bx + (ex - bx) * u, py = by + (ey - by) * u, nl = (7 + 6 * (1 - u)) * s;
          for (const q of [-1, 1]) { g.strokeStyle = hsl(115 + R() * 30, 22 + R() * 14, 17 + R() * 15 + (1 - Math.abs(sd * 0.5)) * 4); g.lineWidth = 1.3 * s; g.beginPath(); g.moveTo(px, py); g.lineTo(px + nl * 0.7, py + q * nl * 0.7); g.stroke(); }
        }
      }
    }
  });
  // 4: bush mass, small dense leaves
  inTile(4, () => {
    const cx = 128 * s, cy = 140 * s;
    for (let i = 0; i < 900; i++) {
      const a = R() * Math.PI * 2, rr = Math.pow(R(), 0.55) * 120 * s, x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr * 0.8;
      const sh = shade(x, y, cx, cy, 120 * s), l = 14 + sh * 22 + R() * 10 + (y < cy ? 6 : 0);
      leaf(x, y, R() * 6.28, (8 + R() * 6) * s, (4 + R() * 2) * s, hsl(92 + R() * 22, 28 + R() * 14, l * 0.92), false);
    }
  });
  // 5: dense core (tileable-ish, fully covered, darker)
  inTile(5, () => {
    g.fillStyle = hsl(100, 35, 12); g.fillRect(0, 0, size, size);
    for (let i = 0; i < 1600; i++) leaf(R() * size, R() * size, R() * 6.28, (9 + R() * 8) * s, (4 + R() * 3) * s, hsl(85 + R() * 30, 35 + R() * 20, 14 + R() * 20), R() < 0.3);
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  return tex;
}

// Builder for foliage cards: quads with atlas uvs and volume-style normals (pointing out of the crown centre).
export class CardAcc {
  constructor() { this.p = []; this.n = []; this.c = []; this.s = []; this.uv = []; }
  // centre, half-width/height vectors (ax, ay), tile, crown centre for normals, tint, sway (bottom, top), flipU
  card(c, ax, ay, tile, crownC, col, swB = 0.3, swT = 0.8, flipU = false) {
    const [u0, v0, u1, v1] = tileUV(tile), pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const corner = pts.map(([a, b]) => c.clone().addScaledVector(ax, a).addScaledVector(ay, b));
    const fn = new THREE.Vector3().crossVectors(ax, ay).normalize();
    const nrm = corner.map((q) => {
      const o = crownC ? q.clone().sub(crownC).normalize() : fn.clone();
      if (crownC && o.dot(fn) < 0) fn.negate();
      return o.multiplyScalar(0.75).addScaledVector(fn, 0.25).normalize();
    });
    const uv = pts.map(([a, b]) => [((flipU ? -a : a) + 1) / 2 * (u1 - u0) + u0, (b + 1) / 2 * (v1 - v0) + v0]);
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const q = corner[i]; this.p.push(q.x, q.y, q.z); this.n.push(nrm[i].x, nrm[i].y, nrm[i].z);
      this.uv.push(uv[i][0], uv[i][1]); this.c.push(col.r, col.g, col.b); this.s.push(i >= 2 ? swT : swB);
    }
  }
  // geometry from Acc-like (no uv) blob for the dark core, uv projected onto the core tile
  coreFrom(geo, col, sway) {
    const g = geo.index ? geo.toNonIndexed() : geo, P = g.attributes.position, Nn = g.attributes.normal, [u0, v0, u1, v1] = tileUV(TILE.core);
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
      this.p.push(x, y, z); this.n.push(Nn.getX(i), Nn.getY(i), Nn.getZ(i)); this.c.push(col.r, col.g, col.b); this.s.push(sway);
      const fu = ((x + z) * 0.35 % 1 + 1) % 1, fv = ((y * 0.45) % 1 + 1) % 1;
      this.uv.push(u0 + (0.05 + 0.9 * fu) * (u1 - u0), v0 + (0.05 + 0.9 * fv) * (v1 - v0));
    }
    if (g !== geo) g.dispose(); geo.dispose();
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3)); g.setAttribute('sway', new THREE.Float32BufferAttribute(this.s, 1));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2)); g.computeBoundingSphere();
    return g;
  }
}

// random card orientation around a point: returns [ax, ay] half-extents
export function cardAxes(R, size, outward, mode) {
  const V = THREE.Vector3;
  let nrm;
  if (mode === 'hang') nrm = new V(R() - 0.5, 0, R() - 0.5).normalize();
  else if (mode === 'flat') nrm = new V((R() - 0.5) * 0.5, 1, (R() - 0.5) * 0.5).normalize();
  else nrm = outward.clone().multiplyScalar(0.45).add(new V(R() - 0.5, (R() - 0.5) * 0.8 + 0.35, R() - 0.5)).normalize();
  const up = Math.abs(nrm.y) > 0.9 ? new V(1, 0, 0) : new V(0, 1, 0);
  const ax = new V().crossVectors(up, nrm).normalize(), ay = new V().crossVectors(nrm, ax).normalize();
  const rot = mode === 'hang' ? 0 : (R() - 0.5) * 1.2, c = Math.cos(rot), s = Math.sin(rot);
  const ax2 = ax.clone().multiplyScalar(c).addScaledVector(ay, s), ay2 = ay.clone().multiplyScalar(c).addScaledVector(ax, -s);
  return [ax2.multiplyScalar(size), ay2.multiplyScalar(size)];
}
