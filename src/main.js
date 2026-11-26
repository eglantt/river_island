import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { U } from './shaders.js';
import { noiseTextureData, waterNormalData } from './noise.js';
import { buildWorld, disposeGroup, sm } from './world.js';
import { createFauna } from './fauna.js';
import { createAudio, testThunder, testCrackle, testFrogs } from './audio.js';
import { createCamp } from './camp.js';
import { createDucks } from './ducks.js';
import { createSnakes } from './snakes.js';
import { createLightning } from './lightning.js';

const VERSION = '0.0.28';
const $ = (id) => document.getElementById(id);
document.querySelectorAll('.ver').forEach((e) => { e.textContent = 'Версия ' + VERSION; });
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const coarse = matchMedia('(pointer: coarse)').matches;
const dpr = window.devicePixelRatio || 1;

// ---------- quality tiers ----------
const TIERS = {
  low: { name: 'Низкое', scale: 0.9, terr: 150, mtn: 256, grass: 11000, flowers: 380, reeds: 1700, forest: 650, far: 260, shadows: 0, bloom: 0, rain: 1800, ff: 15, lily: 500, dust: 60, bf: 8, df: 4, ducks: 2, smoke: 14, atlas: 192, cards: 34, bushCards: 13, spruceLv: 12, sprucePer: 6, forestCards: 20, variants: 2, reedWall: 1500, reedIsle: 800, leaves: 2400, leafMode: 'leaves', algae: 2000, bankBush: 50 },
  med: { name: 'Среднее', scale: 1, terr: 190, mtn: 256, grass: 24000, flowers: 800, reeds: 2400, forest: 1300, far: 500, shadows: 1024, bloom: 0, rain: 4000, ff: 30, lily: 800, dust: 120, bf: 14, df: 6, ducks: 4, smoke: 22, atlas: 320, cards: 56, bushCards: 20, spruceLv: 17, sprucePer: 8, forestCards: 36, variants: 3, reedWall: 2600, reedIsle: 1500, leaves: 5000, leafMode: 'leaves', algae: 3600, bankBush: 80 },
  high: { name: 'Высокое', scale: Math.min(dpr, 1.25), terr: 230, mtn: 512, grass: 45000, flowers: 1500, reeds: 3500, forest: 2300, far: 900, shadows: 1536, bloom: 1, rain: 8000, ff: 45, lily: 1100, dust: 200, bf: 22, df: 8, ducks: 5, smoke: 30, atlas: 512, cards: 80, bushCards: 27, spruceLv: 20, sprucePer: 9, forestCards: 50, variants: 4, reedWall: 4000, reedIsle: 2200, leaves: 10000, leafMode: 'leaves', algae: 5500, bankBush: 110 },
};
const WEATHER = {
  clear: { name: 'Ясно', cover: 0.1, dark: 0, rain: 0, near: 120, far: 6500, wind: 0, mist: 0, storm: 0 },
  partly: { name: 'Облачно', cover: 0.46, dark: 0.05, rain: 0, near: 120, far: 6000, wind: 0.1, mist: 0, storm: 0 },
  overcast: { name: 'Пасмурно', cover: 0.86, dark: 0.42, rain: 0, near: 80, far: 3800, wind: 0.15, mist: 0.15, storm: 0 },
  fog: { name: 'Туман', cover: 0.62, dark: 0.3, rain: 0, near: 2, far: 150, wind: -0.2, mist: 1, storm: 0 },
  rain: { name: 'Дождь', cover: 0.93, dark: 0.55, rain: 0.75, near: 30, far: 1100, wind: 0.3, mist: 0.3, storm: 0 },
  storm: { name: 'Гроза', cover: 1, dark: 0.75, rain: 1, near: 20, far: 750, wind: 0.6, mist: 0.2, storm: 1 },
};
// phones: 'Среднее' without live shadows
const tier = (k) => Object.assign({}, TIERS[k], coarse && k === 'med' ? { shadows: 0 } : {});
const NEXT = { clear: ['partly', 'partly', 'clear'], partly: ['clear', 'overcast', 'partly'], overcast: ['partly', 'rain', 'fog'], fog: ['clear', 'partly'], rain: ['overcast', 'storm', 'partly'], storm: ['rain'] };

// ---------- settings ----------
const DEF = { cycle: 25, paused: false, hour: 17, day: 0, weather: 'clear', auto: true, quality: 'auto', wind: 0.35, volume: 0.7, mode: 'walk', clock: true, fps: false, seed: 20261124, camp: false };
let S = Object.assign({}, DEF);
try { Object.assign(S, JSON.parse(localStorage.getItem('island-settings') || '{}')); } catch (e) { /* storage unavailable */ }
const save = () => { try { localStorage.setItem('island-settings', JSON.stringify(S)); } catch (e) { /* ignore */ } };

// ---------- renderer ----------
const canvas = $('gl');
let renderer;
try { renderer = new THREE.WebGLRenderer({ canvas, antialias: !coarse, powerPreference: 'high-performance' }); }
catch (e) { $('loadmsg').textContent = 'Не удалось запустить 3D-графику на этом устройстве.'; throw e; }
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene(); scene.fog = new THREE.Fog(0x9fb8d0, 120, 6000);
const camera = new THREE.PerspectiveCamera(70, 1, 0.08, 9000);
const sun = new THREE.DirectionalLight(0xffffff, 2); scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x334422, 1); scene.add(hemi);
// lightning bolt
const bolts = createLightning(scene, U);

const nt = new THREE.DataTexture(noiseTextureData(256), 256, 256, THREE.RGBAFormat);
nt.wrapS = nt.wrapT = THREE.RepeatWrapping; nt.magFilter = nt.minFilter = THREE.LinearFilter; nt.needsUpdate = true; U.tNoise.value = nt;
const wn = new THREE.DataTexture(waterNormalData(256), 256, 256, THREE.RGBAFormat);
wn.wrapS = wn.wrapT = THREE.RepeatWrapping; wn.magFilter = THREE.LinearFilter; wn.minFilter = THREE.LinearMipmapLinearFilter; wn.generateMipmaps = true; wn.needsUpdate = true; U.tWaterN.value = wn;

let tierKey = S.quality === 'auto' ? (coarse ? 'med' : 'high') : S.quality, Q = tier(tierKey);
let world = null, fauna = null, ducks = null, snakes = null, camp = null, composer = null, bloom = null;
const audio = createAudio();

function applyRenderQuality() {
  let pr = Q.scale;
  const px = innerWidth * innerHeight * pr * pr; if (px > 3.2e6) pr *= Math.sqrt(3.2e6 / px);
  renderer.setPixelRatio(pr); renderer.setSize(innerWidth, innerHeight, false);
  
  renderer.shadowMap.enabled = !!Q.shadows; sun.castShadow = !!Q.shadows;
  if (Q.shadows) {
    sun.shadow.mapSize.set(Q.shadows, Q.shadows); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    const c = sun.shadow.camera; c.left = c.bottom = -32; c.right = c.top = 32; c.near = 1; c.far = 260; c.updateProjectionMatrix(); sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.04;
  }
  if (Q.bloom) {
    if (!composer) {
      composer = new EffectComposer(renderer); composer.addPass(new RenderPass(scene, camera));
      bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.32, 0.55, 0.88); composer.addPass(bloom); composer.addPass(new OutputPass());
    }
    composer.setPixelRatio(pr); composer.setSize(innerWidth, innerHeight);
  }
  camera.aspect = innerWidth / innerHeight; camera.fov = camera.aspect < 1 ? 78 : 66; camera.updateProjectionMatrix();
  U.uPx.value = innerHeight * pr * 0.5 / Math.tan(camera.fov * Math.PI / 360); // pixels per metre at 1 m
  scene.traverse((o) => { if (o.material && 'needsUpdate' in o.material) o.material.needsUpdate = true; });
}

// ---------- player ----------
const P = { pos: new THREE.Vector3(), yaw: Math.PI / 2, pitch: 0.02, eye: 1.65, bob: 0, vy: 0, jy: 0, squat: 0, gy: 0, lastStep: 0 };
let curve = null, flyU = 0;
function build() {
  if (world) { scene.remove(world.group); disposeGroup(world.group); world.disposeExtra(); fauna.dispose(); ducks.dispose(); snakes.dispose(); camp.dispose(); }
  world = buildWorld(S.seed, Q); world.bakeImpostors(renderer); scene.add(world.group);
  fauna = createFauna(world, Q, scene); ducks = createDucks(world, Q, scene); snakes = createSnakes(world, Q, scene);
  camp = createCamp(world, Q, scene, coarse); camp.setVisible(!!S.camp);
  U.uCampA.value.set(camp.tentP.x, camp.tentP.z, camp.fireP.x, camp.fireP.z); U.uCampB.value.set(Math.cos(camp.yaw), Math.sin(camp.yaw), camp.halfW, camp.halfL);
  P.pos.set(world.spawn[0], world.H(world.spawn[0], world.spawn[1]) + P.eye, world.spawn[1]); P.pitch = 0.02; P.gy = P.pos.y; P.jy = 0; P.vy = 0;
  // face roughly west along the river, avoiding a trunk right in front
  let best = Math.PI / 2, bestScore = -1;
  for (let k = -8; k <= 8; k++) {
    const yaw = Math.PI / 2 + k * 0.12, fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    let score = 3;
    for (const [tx, tz] of world.trunks) {
      const dx = tx - P.pos.x, dz = tz - P.pos.z, d = Math.hypot(dx, dz); if (d > 16) continue;
      const ang = Math.acos(Math.max(-1, Math.min(1, (dx * fx + dz * fz) / d))); score = Math.min(score, ang + d * 0.02);
    }
    score -= Math.abs(k) * 0.02;
    if (score > bestScore) { bestScore = score; best = yaw; }
  }
  P.yaw = best;
  const c = new THREE.Vector3(0, 0, world.zc0), pts = [];
  const ring = [[1.9, 2.2, 0], [1.6, 1.2, 0.8], [1.15, 3.5, 1.6], [2.4, 9, 2.4], [3.2, 22, 3.2], [2.2, 5, 4.0], [1.25, 1.1, 4.8], [1.7, 1.4, 5.6]];
  ring.forEach(([r, y, a]) => pts.push(new THREE.Vector3(c.x + Math.cos(a) * world.irx * r, y, c.z + Math.sin(a) * world.irz * r * 1.4)));
  curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
  if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  applyRenderQuality();
}

const walkable = (x, z) => world.H(x, z) > 0.08 && world.islandE(x, z) < 1.25 && !world.trunks.some(([tx, tz, r]) => (tx - x) ** 2 + (tz - z) ** 2 < r * r) && !camp.blocks(x, z);

// ---------- input ----------
const keys = {}; let joy = null, look = null, rjoy = null; const jv = { x: 0, y: 0 }, rv = { x: 0, y: 0 }; let lookDX = 0, lookDY = 0, jumpReq = false;
const rstickEl = $('rstick'), rknob = $('rknob'), jumpEl = $('jump');
let ctlLast = 0, upId = null; const ctlTouch = () => { ctlLast = performance.now(); };
const showEl = (el, x, y) => { el.style.left = x + 'px'; el.style.top = y + 'px'; el.classList.add('vis'); };
const onJumpBtn = (x, y) => { if (!jumpEl.classList.contains('vis')) return false; const b = jumpEl.getBoundingClientRect(); return Math.hypot(x - (b.left + b.width / 2), y - (b.top + b.height / 2)) < b.width * 0.7; };
addEventListener('keydown', (e) => { if (e.target.tagName === 'INPUT') return; keys[e.code] = true; if (e.code === 'Space' && started) { jumpReq = true; e.preventDefault(); } if (e.code === 'Escape' && photo) setPhoto(false); });
addEventListener('keyup', (e) => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
const pad = $('pad'), stick = $('stick'), knob = $('knob');
pad.addEventListener('pointerdown', (e) => {
  if (!started) return; closePanel();
  try { pad.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  if (e.pointerType !== 'mouse') ctlTouch();
  if (freeCam && e.pointerType !== 'mouse' && touchUI()) { const db = $('down').getBoundingClientRect(); if (onJumpBtn(e.clientX, e.clientY)) { upHeld = 1; upId = e.pointerId; return; } if ($('down').classList.contains('vis') && Math.hypot(e.clientX - db.left - 36, e.clientY - db.top - 36) < 50) { upHeld = -1; upId = e.pointerId; return; } }
  if (e.pointerType !== 'mouse' && touchUI() && onJumpBtn(e.clientX, e.clientY)) { jumpReq = true; jumpEl.classList.add('down'); setTimeout(() => jumpEl.classList.remove('down'), 150); return; }
  if (e.pointerType !== 'mouse' && touchUI() && !rjoy && e.clientX >= innerWidth * 0.5 && e.clientY > innerHeight * 0.5) {
    // right joystick appears under the finger, jump button just below it (or to its left near the bottom edge)
    const r = 58, cx = Math.min(e.clientX, innerWidth - r - 8), cy = Math.min(e.clientY, innerHeight - r - 8);
    rjoy = { id: e.pointerId, x: cx, y: cy, r };
    showEl(rstickEl, cx - r, cy - r);
    const below = cy + r + 14 + 72 < innerHeight - 6;
    showEl(jumpEl, below ? cx - 36 : cx - r - 14 - 72, below ? cy + r + 14 : cy - 36);
    if (freeCam) { const jb = jumpEl.getBoundingClientRect(); showEl($('down'), jb.left - 84, jb.top); }
    return;
  }
  if (e.pointerType !== 'mouse' && e.clientX < innerWidth * 0.5 && !joy && (S.mode === 'walk' || freeCam)) {
    joy = { id: e.pointerId, x: e.clientX, y: e.clientY }; showEl(stick, e.clientX - 60, e.clientY - 60);
  } else if (e.pointerType === 'mouse' && !coarse && !locked() && pad.requestPointerLock) {
    try { const r = pad.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch (_) { /* not allowed here */ }
    if (!look) look = { id: e.pointerId, x: e.clientX, y: e.clientY };
  } else if (!look && !locked()) look = { id: e.pointerId, x: e.clientX, y: e.clientY };
});
const locked = () => document.pointerLockElement === pad;
document.addEventListener('mousemove', (e) => { if (locked()) { lookDX += e.movementX || 0; lookDY += e.movementY || 0; } });
pad.addEventListener('pointermove', (e) => {
  if (joy && e.pointerId === joy.id) {
    let dx = e.clientX - joy.x, dy = e.clientY - joy.y; const l = Math.hypot(dx, dy), r = 46; if (l > r) { dx *= r / l; dy *= r / l; }
    jv.x = dx / r; jv.y = dy / r; knob.style.transform = `translate(${dx}px,${dy}px)`;
  }
  if (look && e.pointerId === look.id && !locked()) { lookDX += e.clientX - look.x; lookDY += e.clientY - look.y; look.x = e.clientX; look.y = e.clientY; }
  if (rjoy && e.pointerId === rjoy.id) {
    let dx = e.clientX - rjoy.x, dy = e.clientY - rjoy.y; const l = Math.hypot(dx, dy), r = rjoy.r * 0.75; if (l > r) { dx *= r / l; dy *= r / l; }
    rv.x = dx / r; rv.y = dy / r; rknob.style.transform = `translate(${dx}px,${dy}px)`;
  }
});
const up = (e) => {
  if (e.pointerId === upId) { upHeld = 0; upId = null; }
  if (e.pointerType !== 'mouse') ctlTouch();
  if (joy && e.pointerId === joy.id) { joy = null; jv.x = jv.y = 0; knob.style.transform = ''; }
  if (look && e.pointerId === look.id) look = null;
  if (rjoy && e.pointerId === rjoy.id) { rjoy = null; rv.x = rv.y = 0; rknob.style.transform = ''; }
};
const touchUI = () => coarse && started && (S.mode === 'walk' || freeCam) && !photo;
pad.addEventListener('pointerup', up); pad.addEventListener('pointercancel', up);

// ---------- environment state ----------
const W = { cover: 0.1, dark: 0, rain: 0, near: 120, far: 6500, wind: 0, mist: 0, storm: 0 };
Object.assign(W, WEATHER[S.weather]);
let weatherRate = 1 / 30, nextAuto = 3 + Math.random() * 3, autoClock = 0;
let dbgA = null, dbgK = null, flash = 0, nextStrike = 5, strikeSeq = [], strikeKind = 'ground';
let windS = S.wind, gameTime = 0;
const keysPal = [
  [-18, '#03050c', '#0a1020', '#000000'], [-9, '#0a1230', '#1d2650', '#24183a'], [-3, '#1c2c5a', '#b4685c', '#ff6a3a'],
  [2, '#365791', '#f0915a', '#ff9a5a'], [9, '#4a78c0', '#f0c391', '#ffc78e'], [24, '#3f7bd6', '#b8d3ec', '#ffeccc'], [60, '#2f6fd6', '#c4ddf3', '#fff4dd'],
].map(([e, z, h, g]) => [e, new THREE.Color(z), new THREE.Color(h), new THREE.Color(g)]);
const sunPal = [[-3, '#ff4a1a'], [2, '#ff7a35'], [8, '#ffa865'], [20, '#ffdcb5'], [50, '#fff4e6']].map(([e, c]) => [e, new THREE.Color(c)]);
function pal(list, e, idx, out) {
  if (e <= list[0][0]) return out.copy(list[0][idx]);
  for (let i = 1; i < list.length; i++) if (e <= list[i][0]) { const t = (e - list[i - 1][0]) / (list[i][0] - list[i - 1][0]); return out.copy(list[i - 1][idx]).lerp(list[i][idx], t); }
  return out.copy(list[list.length - 1][idx]);
}
const zen = new THREE.Color(), hor = new THREE.Color(), glow = new THREE.Color(), sc = new THREE.Color(), tc = new THREE.Color();
function grey(c, k) { const l = c.r * 0.3 + c.g * 0.55 + c.b * 0.15; return tc.setRGB(l * 0.92 * k, l * 0.96 * k, l * k); }
function dirFor(h, maxEl) {
  const phi = Math.PI * (h - 5.5) / 15, el = maxEl * Math.cos(Math.PI * (h - 13) / 15);
  return new THREE.Vector3(Math.cos(phi) * Math.cos(el), Math.sin(el), -Math.sin(phi) * Math.cos(el));
}
let env = {};
function updateEnv(dt) {
  const h = S.hour;
  const sd = dirFor(h, 0.98), el = Math.asin(sd.y) * 57.3;
  const phase = (((S.day + h / 24) / 29.5) + 0.42) % 1;
  const md = dirFor(((h - phase * 24) % 24 + 24) % 24, 0.85), mBright = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
  U.uSunDir.value.copy(sd); U.uMoonDir.value.copy(md); U.uMoonPhase.value = phase;
  const night = sm(-2, -12, el); U.uNight.value = night * (1 - W.cover * 0.85);
  U.uMoonVis.value = sm(-0.02, 0.06, md.y) * (0.25 + 0.75 * night);
  // weather transitions
  const tw = WEATHER[S.weather], k = Math.min(1, dt * weatherRate * 3);
  for (const key of ['cover', 'dark', 'rain', 'near', 'far', 'wind', 'mist', 'storm']) W[key] += (tw[key] - W[key]) * k;
  U.uWet.value = clamp(U.uWet.value + (W.rain > 0.2 ? dt / 35 : -dt / 200), 0, 1);
  U.uCover.value = W.cover; U.uDark.value = W.dark; U.uRain.value = W.rain;
  const dawnMist = sm(3.8, 5.8, h) * (1 - sm(6.5, 9, h)) * 0.85 * (1 - W.rain);
  U.uMist.value = Math.max(W.mist, dawnMist);
  // sky colors
  pal(keysPal, el, 1, zen); pal(keysPal, el, 2, hor); pal(keysPal, el, 3, glow); pal(sunPal, el, 1, sc);
  const c = W.cover, dk = W.dark;
  zen.lerp(grey(zen, 1 - dk * 0.6), c * 0.85); hor.lerp(grey(hor, 1.02 - dk * 0.5), c * 0.8); glow.multiplyScalar(1 - c * 0.6);
  const sunInt = sm(-2.5, 7, el) * (1 - 0.8 * dk - 0.12 * c);
  U.uZen.value.copy(zen); U.uHor.value.copy(hor); U.uGlow.value.copy(glow); U.uSunCol.value.copy(sc);
  U.uSunVis.value = sm(-2.5, 5, el) * (1 - dk * 0.85);
  const day = sm(-6, 6, el);
  U.uCloudLit.value.copy(sc).multiplyScalar(sunInt * 1.1).add(tc.copy(zen).multiplyScalar(0.55)).add(tc.copy(hor).multiplyScalar(0.35 * day))
    .add(tc.setRGB(0.05, 0.06, 0.09).multiplyScalar(mBright * night)).multiplyScalar(1 - dk * 0.5);
  U.uCloudDark.value.copy(hor).lerp(zen, 0.5).multiplyScalar(0.55 - dk * 0.25 + night * 0.1);
  // occlusion by the ridge line (horizon profile)
  const occ = (d) => { const hz = world.horizonEl(Math.atan2(d.z, d.x)); return sm(hz - 0.004, hz + 0.01, Math.asin(d.y)); };
  const sOcc = occ(sd), mOcc = occ(md);
  { const hzM = world.horizonMtn(Math.atan2(sd.z, sd.x)); U.uSunOccM.value = sm(hzM - 0.004, hzM + 0.008, Math.asin(sd.y)); }
  U.uSunOcc.value = sOcc; U.uMoonOcc.value = mOcc;
  // lights
  if (el > -2.5) { sun.color.copy(sc); sun.intensity = 2.7 * sunInt * sOcc; sun.position.copy(sd); }
  else { sun.color.setRGB(0.5, 0.62, 1.0); sun.intensity = 0.5 * mBright * sm(0, 0.12, md.y) * (1 - 0.75 * c) * mOcc; sun.position.copy(md); }
  const tgt = new THREE.Vector3(P.pos.x * 0.3, 0, world.zc0 * 0.7 + P.pos.z * 0.3);
  sun.target.position.copy(tgt); sun.position.multiplyScalar(120).add(tgt);
  hemi.color.copy(zen).lerp(hor, 0.45).lerp(tc.setRGB(0.09, 0.12, 0.26), night * 0.85);
  hemi.groundColor.setRGB(0.16, 0.17, 0.09).multiplyScalar(0.3 + 0.7 * day);
  hemi.intensity = (0.55 + 0.55 * day) * (1 - dk * 0.3) + U.uFlash.value * 3;
  U.uAmb.value.copy(hemi.color).multiplyScalar(hemi.intensity * 0.65);
  renderer.toneMappingExposure = 0.85 + 0.75 * night + 0.25 * dk;
  // fog
  const fogC = tc.copy(hor).lerp(zen, 0.15);
  if (W.mist > 0.3) fogC.lerp(grey(hor, 1.05), 0.5);
  scene.fog.color.copy(fogC); scene.fog.near = W.near; scene.fog.far = W.far * (1 - dawnMist * 0.4); U.uFogNear.value = scene.fog.near; U.uFogFar.value = scene.fog.far;
  U.uFogCol.value.copy(fogC).lerp(tc.setRGB(0.6, 0.65, 0.7).multiplyScalar(day * 0.8 + 0.1), 0.25);
  renderer.setClearColor(fogC); U.uSkyFog.value.copy(fogC); U.uFogSky.value = 1 - sm(300, 5200, scene.fog.far);
  // wind
  windS += (clamp(S.wind + W.wind, 0, 1) - windS) * Math.min(1, dt * 0.4);
  U.uWind.value = windS;
  const wa = Math.sin(gameTime * 0.01) * 0.4; U.uWindDir.value.set(Math.cos(wa) * 0.9 + 0.1, Math.sin(wa) * 0.5 + 0.4).normalize();
  U.uCloudOff.value.addScaledVector(U.uWindDir.value, dt * (0.0012 + windS * 0.0035));
  U.uCloudOff.value.set(U.uCloudOff.value.x % 1, U.uCloudOff.value.y % 1);
  // particles
  const dry = 1 - sm(0.1, 0.4, W.rain);
  U.uFF.value = sm(-3, -9, el) * dry; U.uDust.value = sunInt * sOcc * (1 - c) * (1 - night);
  world.meshes.rain.visible = W.rain > 0.02;
  world.meshes.rain.geometry.setDrawRange(0, Math.floor(Q.rain * 2 * clamp(W.rain, 0, 1)));
  world.meshes.mist.visible = U.uMist.value > 0.02;
  world.meshes.ff.visible = U.uFF.value > 0.01; world.meshes.dust.visible = U.uDust.value > 0.02;
  // rainbow: after rain, sun low behind the viewer
  const rbT = (U.uWet.value > 0.25 && W.rain < 0.08 && W.cover < 0.8 && el > 2 && el < 40 && sOcc > 0.5) ? Math.min(1, (U.uWet.value - 0.25) * 2) : 0;
  U.uRainbow.value += (rbT - U.uRainbow.value) * Math.min(1, dt * 0.3);
  U.uOpen.value += (sm(4, 14, el) - U.uOpen.value) * Math.min(1, dt * 0.05);
  env = { el, night, day, sunInt, dry, h,
    bfly: sm(7, 18, el) * dry * (1 - dk * 0.7), dfly: sm(1, 10, el) * dry, birds: sm(-3, 5, el) * (1 - sm(0.4, 0.8, W.rain)),
    bats: sm(-5, -10, el) * dry, fish: 1 - W.storm * 0.9 };
}

function lightning(dt) {
  if (W.storm > 0.6) {
    nextStrike -= dt;
    if (nextStrike <= 0) {
      nextStrike = Math.random() < 0.25 ? 1 + Math.random() * 1.5 : 6 + Math.random() * 9;
      const r = Math.random(), kind = dbgK || (r < 0.3 ? 'cloud' : r < 0.45 ? 'near' : 'ground');
      const s = bolts.strike(camera.position, kind, Math.random, dbgA); dbgA = dbgK = null;
      U.uBolt.value.set(s.pos.x, s.pos.z, kind === 'cloud' ? 0 : 1, 0);
      const n = 2 + Math.floor(Math.random() * 3); strikeSeq = [];
      for (let i = 0, t = 0; i < n; i++) { strikeSeq.push([t, i === 0 ? 1 : 0.55 + Math.random() * 0.4]); t += 0.06 + Math.random() * 0.1; }
      flash = 0.001; strikeKind = kind;
      audio.thunder(s.dist / 340, kind === 'cloud' ? 0.25 : Math.max(0, 1 - s.dist / 2600));
    }
  }
  if (flash > 0) {
    flash += dt; let f = 0;
    for (const [d, v] of strikeSeq) if (flash > d && flash < d + 0.07) f = Math.max(f, v);
    f = Math.max(f, Math.exp(-(flash - 0.3) * 8) * 0.3 * (flash > 0.3 ? 1 : 0));
    const lastS = strikeSeq[strikeSeq.length - 1][0] + 0.07;
    const glowB = flash < lastS ? f : Math.max(0, 0.35 * (1 - (flash - lastS) / 0.35));
    U.uFlash.value = f * (strikeKind === 'cloud' ? 0.7 : 1); bolts.set(glowB); U.uBolt.value.w = glowB;
    if (flash > 1.2) { flash = 0; U.uFlash.value = 0; bolts.set(0); U.uBolt.value.w = 0; }
  }
}

let ripIdx = 0;
const fenv = {
  ripple: (x, z, a) => { U.uRip.value[ripIdx].set(x, z, gameTime % 3600, a); ripIdx = (ripIdx + 1) % 4; },
  splash: (p, v) => audio.splash(v * clamp(1 - p.distanceTo(camera.position) / 35, 0.1, 1)),
};

// ---------- movement ----------
const fwd = new THREE.Vector3(), right = new THREE.Vector3();
function surface() {
  const x = P.pos.x, z = P.pos.z, h = world.H(x, z);
  if (h < 0.18) return 'water';
  if (world.trunks.some(([tx, tz, r]) => Math.hypot(tx - x, tz - z) < r + 0.5 && r > 0.5) || (camp.blocks(x, z))) return 'stone';
  if (h < 0.42) return 'sand';
  return 'grass';
}
let freeCam = false; const FC = { pos: new THREE.Vector3(), yaw: 0, pitch: 0 }; let upHeld = 0;
function updatePlayer(dt) {
  if (freeCam) {
    FC.yaw -= lookDX * (coarse ? 0.0055 : 0.0035) + rv.x * Math.abs(rv.x) * dt * 2.4; FC.pitch = clamp(FC.pitch - lookDY * (coarse ? 0.0045 : 0.003) - rv.y * Math.abs(rv.y) * dt * 1.6, -1.5, 1.5); lookDX = lookDY = 0;
    let f = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0) - jv.y, s = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0) + jv.x;
    const u = (keys.KeyE || keys.Space ? 1 : 0) - (keys.KeyQ || keys.KeyC ? 1 : 0) + upHeld;
    const sp = (keys.ShiftLeft || keys.ShiftRight ? 120 : 18) * (1 + Math.max(0, FC.pos.y - 30) / 120);
    const cp = Math.cos(FC.pitch);
    fwd.set(-Math.sin(FC.yaw) * cp, Math.sin(FC.pitch), -Math.cos(FC.yaw) * cp); right.set(Math.cos(FC.yaw), 0, -Math.sin(FC.yaw));
    FC.pos.addScaledVector(fwd, f * sp * dt).addScaledVector(right, s * sp * dt); FC.pos.y += u * sp * dt;
    const r = Math.hypot(FC.pos.x, FC.pos.z), gnd = r < 1150 ? Math.max(world.H(FC.pos.x, FC.pos.z), 0) : (r < 5600 ? world.mh(r, Math.atan2(FC.pos.z, FC.pos.x)) : 0);
    FC.pos.y = Math.max(FC.pos.y, gnd + 0.8);
    camera.position.copy(FC.pos); camera.rotation.set(FC.pitch, FC.yaw, 0, 'YXZ'); return;
  }
  if (S.mode === 'fly') {
    flyU = (flyU + dt / 75) % 1;
    const p = curve.getPointAt(flyU), q = curve.getPointAt((flyU + 0.02) % 1);
    const minY = Math.max(world.H(p.x, p.z), 0) + 1.2; if (p.y < minY) p.y = minY;
    camera.position.copy(p);
    const center = new THREE.Vector3(0, 1.5, world.zc0), look = q.clone().lerp(center, 0.55); look.y = Math.min(look.y, p.y - 0.3);
    camera.lookAt(look); return;
  }
  P.yaw -= lookDX * (coarse ? 0.0055 : 0.0035); P.pitch = clamp(P.pitch - lookDY * (coarse ? 0.0045 : 0.003), -1.35, 1.35); lookDX = lookDY = 0;
  if (keys.ArrowLeft) P.yaw += dt * 1.8; if (keys.ArrowRight) P.yaw -= dt * 1.8;
  P.yaw -= rv.x * Math.abs(rv.x) * dt * 2.4; P.pitch = clamp(P.pitch - rv.y * Math.abs(rv.y) * dt * 1.6, -1.35, 1.35);
  let f = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0) - jv.y;
  let s = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0) + jv.x;
  const l = Math.hypot(f, s); if (l > 1) { f /= l; s /= l; }
  const speed = (keys.ShiftLeft || keys.ShiftRight ? 4.2 : 2.3) * (joy ? 1.3 : 1);
  fwd.set(-Math.sin(P.yaw), 0, -Math.cos(P.yaw)); right.set(Math.cos(P.yaw), 0, -Math.sin(P.yaw));
  const dx = (fwd.x * f + right.x * s) * speed * dt, dz = (fwd.z * f + right.z * s) * speed * dt;
  if (l > 0.05) {
    if (walkable(P.pos.x + dx, P.pos.z + dz)) { P.pos.x += dx; P.pos.z += dz; }
    else if (walkable(P.pos.x + dx, P.pos.z)) P.pos.x += dx; else if (walkable(P.pos.x, P.pos.z + dz)) P.pos.z += dz;
    if (P.jy <= 0) P.bob += dt * Math.min(1, l) * speed * 3.2;
  }
  // jump
  if (jumpReq) { jumpReq = false; if (P.jy <= 0 && P.vy === 0) P.vy = 3.2; }
  if (P.vy !== 0 || P.jy > 0) {
    P.vy -= 9.8 * dt; P.jy += P.vy * dt;
    if (P.jy <= 0) { P.jy = 0; P.vy = 0; P.squat = 0.09; audio.step(surface(), 1.6); }
  }
  P.squat = Math.max(0, P.squat - dt * 0.45);
  // footsteps on each down-beat of the walk bob
  const beat = Math.floor(P.bob / Math.PI); if (beat !== P.lastStep) { P.lastStep = beat; if (P.jy <= 0) audio.step(surface(), keys.ShiftLeft || keys.ShiftRight ? 1.2 : 0.9); }
  const gy = world.H(P.pos.x, P.pos.z) + P.eye + Math.sin(P.bob) * 0.035;
  P.gy += (gy - P.gy) * Math.min(1, dt * 10);
  P.pos.y = P.gy + P.jy - P.squat;
  camera.position.copy(P.pos);
  camera.rotation.set(P.pitch, P.yaw, Math.sin(P.bob * 0.5) * 0.004, 'YXZ');
}

// ---------- UI ----------
const panel = $('panel'), menuBtn = $('menu');
function closePanel() { panel.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); }
menuBtn.addEventListener('click', (e) => { e.stopPropagation(); panel.hidden = !panel.hidden; $('hint').classList.remove('on'); menuBtn.setAttribute('aria-expanded', String(!panel.hidden)); syncUI(); });
$('close').addEventListener('click', closePanel);
const fmt = (h) => { const m = Math.floor((h % 1) * 60); return `${String(Math.floor(h) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`; };
function seg(id, val) { document.querySelectorAll(`#${id} button`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === String(val)))); }
function syncUI() {
  seg('speed', S.cycle); $('pause').checked = S.paused; seg('wx', S.weather); seg('qual', S.quality); seg('mode', S.mode);
  $('hour').value = S.hour; $('hourval').textContent = fmt(S.hour); $('auto').checked = S.auto; $('wind').value = S.wind; $('vol').value = S.volume;
  $('showclock').checked = S.clock; $('showfps').checked = S.fps; $('camp').checked = !!S.camp;
  $('qnote').textContent = S.quality === 'auto' ? `Сейчас: ${Q.name.toLowerCase()}` : '';
}
$('speed').addEventListener('click', (e) => { const v = e.target.dataset && e.target.dataset.v; if (!v) return; S.cycle = +v; save(); syncUI(); });
$('pause').addEventListener('change', (e) => { S.paused = e.target.checked; save(); });
$('preset').addEventListener('click', (e) => { const v = e.target.dataset && e.target.dataset.v; if (!v) return; S.hour = +v; save(); syncUI(); });
$('hour').addEventListener('input', (e) => { S.hour = +e.target.value; $('hourval').textContent = fmt(S.hour); });
$('hour').addEventListener('change', save);
$('wx').addEventListener('click', (e) => { const v = e.target.dataset && e.target.dataset.v; if (!v) return; S.weather = v; weatherRate = 1 / 8; save(); syncUI(); });
$('auto').addEventListener('change', (e) => { S.auto = e.target.checked; save(); });
$('wind').addEventListener('input', (e) => { S.wind = +e.target.value; save(); });
$('vol').addEventListener('input', (e) => { S.volume = +e.target.value; save(); });
$('showclock').addEventListener('change', (e) => { S.clock = e.target.checked; save(); });
$('showfps').addEventListener('change', (e) => { S.fps = e.target.checked; save(); });
let camTaps = [];
$('camhead').addEventListener('pointerdown', (e) => {
  e.preventDefault(); const now = performance.now(); camTaps = camTaps.filter((t) => now - t < 2000); camTaps.push(now);
  if (camTaps.length >= 10 && (S.mode === 'fly' || freeCam)) {
    camTaps = []; freeCam = !freeCam;
    if (freeCam) { FC.pos.copy(camera.position); const eu = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ'); FC.yaw = eu.y; FC.pitch = eu.x; }
    document.body.classList.toggle('freecam', freeCam);
    $('snapmsg').textContent = freeCam ? 'Свободная камера' : 'Свободная камера выключена'; $('snapmsg').classList.add('on'); setTimeout(() => { $('snapmsg').classList.remove('on'); $('snapmsg').textContent = 'Снимок сохранён'; }, 1800);
  }
});
$('mode').addEventListener('click', (e) => { const v = e.target.dataset && e.target.dataset.v; if (!v) return; if (freeCam) { freeCam = false; document.body.classList.remove('freecam'); } S.mode = v; save(); syncUI(); if (v === 'walk') camera.position.copy(P.pos); });
$('qual').addEventListener('click', (e) => {
  const v = e.target.dataset && e.target.dataset.v; if (!v) return; S.quality = v; save();
  const nk = v === 'auto' ? (coarse ? 'med' : 'high') : v; autoDone = v !== 'auto';
  if (nk !== tierKey) { tierKey = nk; Q = tier(nk); rebuildSoon(); }
  syncUI();
});
$('camp').addEventListener('change', (e) => { S.camp = e.target.checked; save(); camp.setVisible(S.camp); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; } applyRenderQuality(); });
let photo = false;
function setPhoto(v) { photo = v; document.body.classList.toggle('photo', v); closePanel(); }
$('photo').addEventListener('click', (e) => { e.stopPropagation(); setPhoto(true); });
$('photoexit').addEventListener('click', () => setPhoto(false));
let snapReq = false;
$('snap').addEventListener('click', () => { snapReq = true; });
function doSnap() {
  try {
    canvas.toBlob((b) => {
      if (!b) return; const a = document.createElement('a'); a.href = URL.createObjectURL(b);
      const d = new Date(); a.download = `ostrov-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}.png`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      $('snapmsg').classList.add('on'); setTimeout(() => $('snapmsg').classList.remove('on'), 1800);
    }, 'image/png');
  } catch (err) { /* downloads blocked here */ }
}
$('newisland').addEventListener('click', () => { S.seed = (Math.random() * 1e9) | 0; save(); rebuildSoon(); });
function rebuildSoon() { $('busy').hidden = false; setTimeout(() => { build(); $('busy').hidden = true; syncUI(); }, 60); }

// ---------- auto quality ----------
let autoDone = S.quality !== 'auto', autoT = 0, autoFrames = 0, upgraded = false;
function autoQuality(dt) {
  if (autoDone || !started) return;
  autoT += dt; autoFrames++;
  if (autoT > 5) {
    const fps = autoFrames / autoT; autoT = 0; autoFrames = 0;
    if (fps < 40 && tierKey === 'high') { tierKey = 'med'; Q = tier('med'); rebuildSoon(); }
    else if (fps < (coarse ? 33 : 27) && tierKey === 'med') { tierKey = 'low'; Q = tier('low'); rebuildSoon(); autoDone = true; }
    else if (fps < 24 && tierKey === 'low') { Q = Object.assign({}, Q, { scale: 0.72 }); applyRenderQuality(); autoDone = true; }
    else if (fps > 57 && tierKey === 'low' && !upgraded && !coarse) { upgraded = true; tierKey = 'med'; Q = tier('med'); rebuildSoon(); }
    else autoDone = true;
  }
}

// ---------- start ----------
let started = false;
$('enter').addEventListener('click', () => {
  started = true; $('start').hidden = true; audio.init();
  $('hint').classList.add('on'); setTimeout(() => $('hint').classList.remove('on'), 5500);
});
document.addEventListener('visibilitychange', () => audio.suspend(document.hidden));
if (location.protocol === 'https:' && 'serviceWorker' in navigator && /github\.io$/.test(location.hostname)) { try { navigator.serviceWorker.register('sw.js').catch(() => {}); } catch (e) { /* not allowed here */ } }
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); $('lost').hidden = false; });
canvas.addEventListener('webglcontextrestored', () => location.reload());
addEventListener('resize', () => applyRenderQuality());

// ---------- loop ----------
const dbs = new THREE.Vector2(); let hintT = 0;
let last = performance.now(), fpsS = 60, saveT = 0, lastMin = -1, lastWx = '';
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  gameTime += dt; U.uTime.value = gameTime % 3600;
  if (!S.paused) {
    const prev = S.hour; S.hour += dt * 24 / (S.cycle * 60);
    if (S.hour >= 24) { S.hour -= 24; S.day++; }
    if (S.auto) { autoClock += (S.hour - prev + 24) % 24; if (autoClock > nextAuto) { autoClock = 0; nextAuto = 2 + Math.random() * 3.5; const opts = NEXT[S.weather]; let n = opts[Math.floor(Math.random() * opts.length)]; if (n === 'fog' && !(S.hour > 3 && S.hour < 9)) n = 'overcast'; S.weather = n; weatherRate = 1 / 40; if (!panel.hidden) syncUI(); } }
  }
  if (window.__island && window.__island.freeze) { /* debug camera */ }
  else if (started || S.mode === 'fly' || freeCam) updatePlayer(dt); else { P.yaw += dt * 0.03; camera.position.copy(P.pos); camera.rotation.set(0.03, P.yaw, 0, 'YXZ'); }
  updateEnv(dt); lightning(dt);
  U.uCam.value.copy(camera.position);
  world.group.children.forEach((o) => { if (o.material && o.material.side === THREE.BackSide) o.position.copy(camera.position); });
  fauna.update(dt, gameTime, Object.assign(env, fenv, { cam: camera.position, yaw: S.mode === 'walk' ? P.yaw + Math.PI / 2 : 0 }));
  ducks.update(dt, gameTime, env);
  snakes.update(dt, gameTime, Object.assign(env, { cover: W.cover, rain: W.rain }));
  camp.update(dt, gameTime, { weather: S.weather, rain: W.rain, storm: W.storm, night: env.night });
  U.uCampOn.value = S.camp ? 1 : 0;
  if (audio.on) {
    const nd = fauna.nearest(camera.position); let pan = 0;
    if (nd.p) { const v = nd.p.clone().sub(camera.position); right.set(Math.cos(P.yaw), 0, -Math.sin(P.yaw)); pan = clamp(v.dot(right) / (nd.d + 0.01), -1, 1); }
    const nearW = clamp(1.2 - (camera.position.y - Math.max(0, world.H(camera.position.x, camera.position.z)) - 1.2) * 0.2 - world.H(camera.position.x, camera.position.z) * 0.35, 0.3, 1);
    if (camp.state && S.camp) { const d = camera.position.distanceTo(camp.fireP); audio.fireSound(Math.max(camp.state.fire, camp.state.out ? 0.15 : 0) * clamp(1 - d / 22, 0, 1) ** 1.5, W.rain); } else audio.fireSound(0, 0);
    audio.update(dt, { volume: S.volume, wind: windS, gust: 0.5 + 0.5 * Math.sin(gameTime * 0.37) * Math.sin(gameTime * 0.11), water: nearW, rain: W.rain,
      birds: (sm(4.5, 6, env.h) * (1 - sm(8.5, 10, env.h)) * 0.9 + 0.3 * env.day + 0.15 * sm(18.5, 19.5, env.h) * (1 - sm(20.5, 21.5, env.h))) * (1 - sm(0.2, 0.6, W.rain)),
      crickets: (0.2 * env.day + 0.85 * sm(-1, -6, env.el)) * env.dry, frogs: (0.8 * sm(2, -6, env.el) + 0.15 * env.day * (1 - W.cover * 0.6) + 0.25 * U.uWet.value * (1 - W.rain)) * (1 - W.storm * 0.8) * (1 - sm(0.5, 1, W.rain) * 0.6), owl: sm(-6, -12, env.el) * env.dry,
      buzz: nd.p ? clamp(1 - nd.d / 2.8, 0, 1) : 0, buzzPan: pan });
  }
  autoQuality(dt);
  if (composer && Q.bloom) composer.render(); else renderer.render(scene, camera);
  if (snapReq) { snapReq = false; doSnap(); }
  // HUD
  fpsS += (1 / Math.max(dt, 1e-3) - fpsS) * 0.05;
  const mn = Math.floor(S.hour * 60);
  if (mn !== lastMin || S.weather !== lastWx) { lastMin = mn; lastWx = S.weather; $('clock').textContent = `${fmt(S.hour)} · ${WEATHER[S.weather].name}`; if (!panel.hidden) { $('hour').value = S.hour; $('hourval').textContent = fmt(S.hour); } }
  document.body.classList.toggle('touchui', touchUI());
  if (!joy && !rjoy && !look && performance.now() - ctlLast > 3000) for (const el of [stick, rstickEl, jumpEl, $('down')]) el.classList.remove('vis');
  $('clock').hidden = !S.clock; $('fps').hidden = !S.fps;
  if (S.fps) { renderer.getDrawingBufferSize(dbs); $('fps').textContent = `${Math.round(fpsS)} к/с · ${Q.name.toLowerCase()} · ${dbs.x}×${dbs.y}`; }
  if ((hintT += dt) > 1) {
    hintT = 0;
    const warn = coarse && tierKey === 'high' && fpsS < 25;
    const t = S.quality === 'auto' ? `Сейчас: ${Q.name.toLowerCase()}` : warn ? 'Для этого устройства лучше «Среднее»' : '';
    if ($('qnote').textContent !== t) $('qnote').textContent = t;
  }
  if ((saveT += dt) > 5) { saveT = 0; save(); }
  requestAnimationFrame(frame);
}

// boot after the loading message paints
requestAnimationFrame(() => setTimeout(() => {
  build(); syncUI(); $('loadmsg').hidden = true; $('enter').hidden = false;
  window.__island = { get renderer() { return renderer; }, get ducks() { return ducks; }, get snakes() { return snakes; }, testThunder, testCrackle, testFrogs, strike(a, k) { W.storm = 1; nextStrike = 0; dbgA = a; dbgK = k; }, get flash() { return flash; }, get camp() { return camp; }, set(h, w, m) { if (h != null) S.hour = h; if (w) { S.weather = w; Object.assign(W, WEATHER[w]); } if (m) S.mode = m; }, pos: P, cam: camera, get world() { return world; }, U, get fps() { return fpsS; } };
  requestAnimationFrame(frame);
}, 30));
