// Seeded RNG, 2D simplex noise and tileable texture generators
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeNoise(seed) {
  const r = rng(seed);
  const p = new Uint8Array(512);
  const base = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [base[i], base[j]] = [base[j], base[i]]; }
  for (let i = 0; i < 512; i++) p[i] = base[i & 255];
  const G = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
  const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
  function n2(x, y) {
    const s = (x + y) * F2, i = Math.floor(x + s), j = Math.floor(y + s);
    const t = (i + j) * G2, x0 = x - (i - t), y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n = 0, tt, g;
    tt = 0.5 - x0 * x0 - y0 * y0; if (tt > 0) { g = G[p[ii + p[jj]] & 7]; tt *= tt; n += tt * tt * (g[0] * x0 + g[1] * y0); }
    tt = 0.5 - x1 * x1 - y1 * y1; if (tt > 0) { g = G[p[ii + i1 + p[jj + j1]] & 7]; tt *= tt; n += tt * tt * (g[0] * x1 + g[1] * y1); }
    tt = 0.5 - x2 * x2 - y2 * y2; if (tt > 0) { g = G[p[ii + 1 + p[jj + 1]] & 7]; tt *= tt; n += tt * tt * (g[0] * x2 + g[1] * y2); }
    return 70 * n; // ~[-1,1]
  }
  function fbm(x, y, oct = 4) {
    let a = 1, f = 1, s = 0, m = 0;
    for (let o = 0; o < oct; o++) { s += a * n2(x * f, y * f); m += a; a *= 0.5; f *= 2.03; }
    return s / m;
  }
  function ridged(x, y, oct = 5) {
    let a = 1, f = 1, s = 0, m = 0, w = 1;
    for (let o = 0; o < oct; o++) { let v = 1 - Math.abs(n2(x * f, y * f)); v *= v * w; w = Math.min(1, v * 1.6); s += a * v; m += a; a *= 0.5; f *= 2.1; }
    return s / m;
  }
  return { n2, fbm, ridged };
}

// Periodic value-noise fbm, size N, returns Float32Array normalised 0..1
function tileFbm(N, seed, base, oct) {
  const r = rng(seed), out = new Float32Array(N * N);
  let amp = 1, period = base;
  for (let o = 0; o < oct; o++) {
    const lat = new Float32Array(period * period).map(() => r());
    const cell = N / period;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const fx = x / cell, fy = y / cell, x0 = Math.floor(fx), y0 = Math.floor(fy);
      let tx = fx - x0, ty = fy - y0; tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
      const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
      const a = lat[y0 * period + x0], b = lat[y0 * period + x1], c = lat[y1 * period + x0], d = lat[y1 * period + x1];
      out[y * N + x] += amp * ((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty);
    }
    amp *= 0.5; period *= 2;
  }
  let mn = 1e9, mx = -1e9; for (const v of out) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - mn) / (mx - mn);
  return out;
}

// RGBA noise texture data: R,G = cloud fbm, B = smooth gust field, A = fine detail
export function noiseTextureData(N = 256) {
  const R = tileFbm(N, 11, 4, 6), G = tileFbm(N, 23, 8, 5), B = tileFbm(N, 37, 2, 3), A = tileFbm(N, 51, 16, 3);
  const d = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) { d[i * 4] = R[i] * 255; d[i * 4 + 1] = G[i] * 255; d[i * 4 + 2] = B[i] * 255; d[i * 4 + 3] = A[i] * 255; }
  return d;
}

// Tileable water normal map (RG = normal xy) from sum of noise layers
export function waterNormalData(N = 256) {
  const h1 = tileFbm(N, 71, 8, 4), h2 = tileFbm(N, 83, 16, 3);
  const h = new Float32Array(N * N);
  for (let i = 0; i < h.length; i++) h[i] = h1[i] * 0.7 + h2[i] * 0.3;
  const d = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const l = h[y * N + ((x - 1 + N) % N)], r = h[y * N + ((x + 1) % N)], u = h[((y - 1 + N) % N) * N + x], dn = h[((y + 1) % N) * N + x];
    let nx = (l - r) * 6, ny = (u - dn) * 6; const nz = 1, L = Math.hypot(nx, ny, nz);
    const i = (y * N + x) * 4; d[i] = (nx / L * 0.5 + 0.5) * 255; d[i + 1] = (ny / L * 0.5 + 0.5) * 255; d[i + 2] = (nz / L * 0.5 + 0.5) * 255; d[i + 3] = 255;
  }
  return d;
}
