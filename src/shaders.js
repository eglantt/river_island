import * as THREE from 'three';

// Shared uniforms updated once per frame
export const U = {
  uTime: { value: 0 }, uWind: { value: 0.3 }, uWindDir: { value: new THREE.Vector2(0.85, 0.53) },
  tNoise: { value: null }, tHzn: { value: null }, tWaterN: { value: null }, tDepth: { value: null },
  uCloudOff: { value: new THREE.Vector2() }, uCover: { value: 0.1 }, uDark: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
  uSunVis: { value: 1 }, uNight: { value: 0 }, uMoonPhase: { value: 0.4 }, uMoonVis: { value: 0 },
  uZen: { value: new THREE.Color() }, uHor: { value: new THREE.Color() }, uGlow: { value: new THREE.Color() },
  uSunCol: { value: new THREE.Color() }, uCloudLit: { value: new THREE.Color() }, uCloudDark: { value: new THREE.Color() },
  uAmb: { value: new THREE.Color() }, uWet: { value: 0 }, uRain: { value: 0 }, uFlash: { value: 0 },
  uRip: { value: [new THREE.Vector4(0, 0, -99, 0), new THREE.Vector4(0, 0, -99, 0), new THREE.Vector4(0, 0, -99, 0), new THREE.Vector4(0, 0, -99, 0)] },
  uCam: { value: new THREE.Vector3() }, uMist: { value: 0 }, uFogCol: { value: new THREE.Color() },
  uFF: { value: 0 }, uSunOcc: { value: 1 }, uMoonOcc: { value: 1 }, uFogNear: { value: 100 }, uFogFar: { value: 6000 }, uFogSky: { value: 0 }, uSkyFog: { value: new THREE.Color() }, uDust: { value: 0 }, uPx: { value: 1 }, uDepthBox: { value: new THREE.Vector4(-300, -130, 600, 260) },
  uRiver: { value: new THREE.Vector4(0, 0, 0, 40) }, // meander a1,f1(phase),.., halfwidth
};

const CLOUD = /* glsl */`
float cloudDensity(vec2 uv){
  float a = texture2D(tNoise, uv + uCloudOff).r;
  float b = texture2D(tNoise, uv*2.31 + uCloudOff*1.6 + vec2(.37,.71)).g;
  return a*.68 + b*.32;
}
float cloudCov(float d){ return smoothstep(1.0-uCover-0.10, 1.0-uCover+0.20, d); }
`;

const SKYFN = /* glsl */`
vec3 skyBase(vec3 d){
  float y = max(d.y, 0.0);
  vec3 c = mix(uHor, uZen, pow(y, 0.42));
  float sd = max(dot(d, uSunDir), 0.0);
  float clear = 1.0 - uDark*0.85;
  c += uGlow * (pow(sd, 5.0)*0.28 + pow(sd, 40.0)*0.5) * clear;
  c += uGlow * 0.45 * exp(-y*9.0) * pow(sd, 2.5) * clear;
  if (d.y < 0.0) c = mix(uHor, uHor*0.55, clamp(-d.y*4.0, 0.0, 1.0));
  return c;
}
`;

// ---------- generic material patch: wind sway, cloud shadows, ground detail ----------
const PROJ = /* glsl */`
vec4 mvPosition = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
vec4 wpp = modelMatrix * mvPosition;
float gst = texture2D(tNoise, wpp.xz*0.013 - uWindDir*uTime*0.075).b;
vGust = gst;
float sw = sway * uAmp;
vec2 wv = uWindDir * (uWind*(0.25 + 1.5*gst*gst)) + vec2(sin(uTime*1.9 + wpp.x*0.8 + wpp.z*0.35), cos(uTime*1.45 + wpp.z*0.7)) * 0.1 * (0.25 + uWind);
wpp.xz += wv * sw; wpp.y -= dot(wv,wv) * sw * 0.3;
vWp = wpp.xyz;
mvPosition = viewMatrix * wpp;
gl_Position = projectionMatrix * mvPosition;
`;

export function patch(mat, key, amp = 0, defs = {}) {
  mat.defines = Object.assign({}, mat.defines || {}, defs);
  mat.onBeforeCompile = (sh) => {
    for (const k of ['uTime', 'uWind', 'uWindDir', 'tNoise', 'uCloudOff', 'uCover', 'uSunDir', 'uSunVis', 'uWet', 'uSunOcc', 'uZen', 'uHor', 'uGlow', 'uDark', 'uSkyFog', 'uFogSky', 'uFogNear', 'uFogFar']) sh.uniforms[k] = U[k];
    sh.uniforms.uAmp = { value: amp };
    if (defs.NOFLIP !== undefined) sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''));
    sh.vertexShader = `attribute float sway;\nuniform float uTime, uWind, uAmp;\nuniform vec2 uWindDir;\nuniform sampler2D tNoise;\nvarying vec3 vWp;\nvarying float vGust;\n` +
      sh.vertexShader.replace('#include <project_vertex>', PROJ);
    sh.fragmentShader = `uniform sampler2D tNoise;\nuniform vec2 uCloudOff;\nuniform float uCover, uSunVis, uWet, uSunOcc, uDark, uFogSky, uFogNear, uFogFar;\nuniform vec3 uSunDir, uZen, uHor, uGlow, uSkyFog;\nvarying vec3 vWp;\nvarying float vGust;\n` + CLOUD + SKYFN +
      sh.fragmentShader.replace('#include <opaque_fragment>', `
      {
        vec3 cp = vWp + uSunDir * ((1000.0 - vWp.y) / max(uSunDir.y, 0.06));
        float cs = cloudCov(cloudDensity(cp.xz * 0.00035));
        outgoingLight *= 1.0 - cs * 0.5 * uSunVis * uSunOcc;
        #ifdef MTN
          vec3 vd = vWp - cameraPosition; float dist = length(vd); vd /= dist;
          float sd = max(dot(vd, uSunDir), 0.0);
          float sunLow = 1.0 - smoothstep(0.04, 0.4, uSunDir.y);
          float back = pow(sd, 3.0) * sunLow * (1.0 - uDark);
          outgoingLight *= 1.0 - 0.5 * back;
          float f = clamp((dist - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
          float fMax = mix(0.86, 0.5, pow(sd, 2.0) * sunLow);
          f = min(f, mix(fMax, 1.0, uFogSky));
          vec3 haze = mix(uSkyFog, uHor + uGlow * pow(sd, 4.0) * 0.22 * (1.0 - uDark), 0.55 * (1.0 - uFogSky));
          haze = mix(haze, haze * 0.62, back);
          outgoingLight = mix(outgoingLight, haze, f);
        #endif
        #ifdef DETAIL
          float dn = texture2D(tNoise, vWp.xz*0.19).a*0.55 + texture2D(tNoise, vWp.xz*0.83).g*0.45;
          outgoingLight *= 0.74 + 0.5*dn;
          outgoingLight *= 1.0 - uWet*0.32*smoothstep(-0.5, 0.6, vWp.y + 1.0);
        #endif
        #ifdef LEAF
          float ln = texture2D(tNoise, vWp.xz*1.7 + vWp.y*0.9).a*0.6 + texture2D(tNoise, vWp.zy*2.3 + vWp.x*0.5).g*0.4;
          outgoingLight *= 0.72 + 0.56*ln;
          outgoingLight *= 1.0 - uWet*0.15;
        #endif
        #ifdef GUST
          outgoingLight *= 0.86 + 0.32*vGust;
          outgoingLight *= 1.0 - uWet*0.18;
        #endif
      }
      #include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}

// ---------- sky ----------
export function skyMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: U, depthWrite: false, side: THREE.BackSide, fog: false,
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }`,
    fragmentShader: /* glsl */`
      uniform sampler2D tNoise, tHzn; uniform vec2 uCloudOff; uniform float uCover, uDark, uSunVis, uNight, uMoonPhase, uMoonVis, uTime, uFlash;
      uniform vec3 uSunDir, uMoonDir, uZen, uHor, uGlow, uSunCol, uCloudLit, uCloudDark, uSkyFog; uniform float uFogSky;
      varying vec3 vDir;
      ${CLOUD}${SKYFN}
      float hash(vec3 p){ p = fract(p*0.3183099 + .1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
      void main(){
        vec3 d = normalize(vDir);
        vec3 col = skyBase(d);
        float sd = dot(d, uSunDir);
        float cov = 0.0;
        if (d.y > 0.0) {
          // stars + milky way
          if (uNight > 0.01) {
            vec3 p = d * 130.0; vec3 c = floor(p); float h = hash(c);
            if (h > 0.965) {
              vec3 o = vec3(hash(c+1.3), hash(c+2.7), hash(c+5.1)) - 0.5;
              float dist = length(fract(p) - 0.5 - o*0.55);
              float s = smoothstep(0.17, 0.0, dist) * (0.35 + (h-0.965)/0.035);
              float tw = 0.65 + 0.35*sin(uTime*(1.5 + h*9.0) + h*80.0);
              col += vec3(0.85, 0.9, 1.0) * s * tw * 1.4 * uNight * smoothstep(0.0, 0.25, d.y);
            }
            vec3 ax = normalize(vec3(0.45, 0.35, -0.82));
            float band = exp(-pow(dot(d, ax), 2.0) * 16.0);
            float mw = band * smoothstep(0.3, 0.9, texture2D(tNoise, vec2(atan(d.z, d.x)*0.6, d.y*1.1)).r*0.6 + texture2D(tNoise, d.xz*2.0).g*0.4);
            col += vec3(0.5, 0.55, 0.78) * mw * mw * 0.07 * uNight;
          }
          // moon
          float md = dot(d, uMoonDir);
          if (md > 0.9996 && uMoonVis > 0.0) {
            vec3 mr = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.001))); vec3 mu = cross(mr, uMoonDir);
            vec3 dd = d - uMoonDir*md; vec2 q = vec2(dot(dd, mr), dot(dd, mu)) / 0.0283;
            float r = length(q);
            if (r < 1.0) {
              float ph = uMoonPhase * 6.2831853;
              float term = cos(ph) * sqrt(max(1.0 - q.y*q.y, 0.0));
              float lit = uMoonPhase < 0.5 ? smoothstep(-0.06, 0.06, q.x - term) : smoothstep(-0.06, 0.06, -q.x - term);
              float maria = 0.78 + 0.22*texture2D(tNoise, q*0.18 + 0.3).r;
              float edge = smoothstep(1.0, 0.92, r);
              col = mix(col, vec3(1.0, 0.97, 0.88) * maria * (0.08 + 1.4*lit), edge * uMoonVis);
            }
          }
          col += vec3(0.55, 0.65, 0.9) * (pow(max(md,0.0), 900.0)*0.35 + pow(max(md,0.0), 60.0)*0.04) * uMoonVis * (1.0 - uDark);
          // sun disk
          col += uSunCol * smoothstep(0.99955, 0.99975, sd) * 14.0 * uSunVis;
          // clouds
          vec2 uv = d.xz / (d.y + 0.06) * 0.35;
          float den = cloudDensity(uv);
          cov = cloudCov(den);
          float den2 = cloudDensity(uv + uSunDir.xz * 0.025);
          float shade = clamp(1.0 - (den2 - den) * 5.5, 0.0, 1.0);
          shade *= mix(1.0, 0.55, smoothstep(0.0, 0.25, den - (1.0-uCover)));
          vec3 cc = mix(uCloudDark, uCloudLit, shade);
          float rim = pow(max(sd, 0.0), 6.0) * (1.0 - smoothstep(0.0, 0.3, den - (1.0-uCover-0.1)));
          cc += uGlow * rim * 0.9 * (1.0 - uDark);
          float a = cov * smoothstep(0.0, 0.12, d.y) * (0.72 + 0.28*uCover);
          col = mix(col, cc, a);
          col = mix(col, uHor, (1.0 - smoothstep(0.0, 0.06, d.y)) * 0.6);
        }
        {
          float u = fract(atan(d.z, d.x) / 6.2831853 + 1.0);
          float hz = texture2D(tHzn, vec2(u, 0.5)).b * 0.4 - 0.05;
          float m = smoothstep(hz + 0.003, hz - 0.003, asin(clamp(d.y, -1.0, 1.0)));
          float sdm = max(dot(d, uSunDir), 0.0), sunLow = 1.0 - smoothstep(0.04, 0.4, uSunDir.y);
          vec3 mcol = mix(uSkyFog, uHor + uGlow * pow(sdm, 4.0) * 0.22 * (1.0 - uDark), 0.55 * (1.0 - uFogSky)) * (0.8 - 0.32 * pow(sdm, 3.0) * sunLow * (1.0 - uDark));
          col = mix(col, mcol, m);
        }
        float hb = uFogSky * (1.0 - smoothstep(-0.02, 0.22 + 0.55*uFogSky, d.y));
        col = mix(col, uSkyFog, max(hb, uFogSky*uFogSky*0.8));
        col += vec3(0.75, 0.8, 1.0) * uFlash * (0.4 + 0.8*cov);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

// ---------- water ----------
export function waterMaterial() {
  const m = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]), transparent: true, fog: true,
    vertexShader: /* glsl */`
      #include <fog_pars_vertex>
      varying vec3 vWp;
      void main(){ vec4 w = modelMatrix * vec4(position,1.0); vWp = w.xyz; vec4 mvPosition = viewMatrix * w; gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <fog_pars_fragment>
      uniform sampler2D tNoise, tWaterN, tDepth, tHzn; uniform vec2 uCloudOff, uWindDir; uniform float uCover, uDark, uSunVis, uTime, uRain, uWind, uMoonVis, uFlash, uNight, uSunOcc, uMoonOcc;
      uniform vec3 uSunDir, uMoonDir, uZen, uHor, uGlow, uSunCol, uCloudLit, uCloudDark, uAmb, uCam, uSkyFog; uniform float uFogSky;
      uniform vec4 uRip[4]; uniform vec4 uDepthBox, uRiver;
      varying vec3 vWp;
      ${CLOUD}${SKYFN}
      float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      vec2 ripple(vec2 p, vec2 c, float age, float amp){
        vec2 dv = p - c; float d = length(dv); float r = age*1.4;
        float w = sin((d - r)*14.0) * exp(-abs(d - r)*5.0) * exp(-age*0.9) * amp;
        return d > 0.001 ? dv/d * w : vec2(0.0);
      }
      void main(){
        vec3 V = uCam - vWp; float dist = length(V); V /= dist;
        vec2 flow = vec2(1.0, 0.0);
        float sp = 0.035 + uWind*0.03;
        vec3 n1 = texture2D(tWaterN, vWp.xz*0.045 + flow*uTime*sp).xyz*2.0 - 1.0;
        vec3 n2 = texture2D(tWaterN, vWp.xz*0.11 + vec2(0.3,-0.6)*uTime*sp*1.3 + uWindDir*uTime*0.01).xyz*2.0 - 1.0;
        vec3 n3 = texture2D(tWaterN, vWp.xz*0.013 + flow*uTime*0.012).xyz*2.0 - 1.0;
        vec2 nxy = n1.xy*0.55 + n2.xy*0.35*(0.5+uWind) + n3.xy*0.5;
        // rain ripples
        if (uRain > 0.01) {
          vec2 g = vWp.xz / 0.7; vec2 id = floor(g);
          float rnd = h21(id); float t = fract(uTime*0.9 + rnd);
          vec2 c = (id + 0.25 + 0.5*vec2(h21(id+3.1), h21(id+7.7))) * 0.7;
          if (rnd < uRain) nxy += ripple(vWp.xz, c, t*0.9, 0.55) * (1.0 - t);
        }
        for (int i = 0; i < 4; i++) { float age = uTime - uRip[i].z; if (age > 0.0 && age < 4.0) nxy += ripple(vWp.xz, uRip[i].xy, age, uRip[i].w); }
        float flt = smoothstep(30.0, 220.0, dist);
        nxy *= mix(0.55, 0.12, flt);
        vec3 N = normalize(vec3(nxy.x, 1.0, nxy.y));
        // depth
        vec2 duv = (vWp.xz - uDepthBox.xy) / uDepthBox.zw;
        float depth = 1.8;
        if (duv.x > 0.0 && duv.x < 1.0 && duv.y > 0.0 && duv.y < 1.0) depth = texture2D(tDepth, duv).r * 4.0;
        // reflection
        vec3 R = reflect(-V, N); R.y = abs(R.y);
        vec3 refl = skyBase(R);
        vec2 cuv = R.xz / (R.y + 0.06) * 0.35;
        float cv = cloudCov(cloudDensity(cuv)) * smoothstep(0.0, 0.12, R.y);
        refl = mix(refl, mix(uCloudDark, uCloudLit, 0.7), cv * 0.8);
        // reflected mountain ridges (from the horizon profile)
        {
          float u = fract(atan(R.z, R.x) / 6.2831853 + 1.0);
          float hz = texture2D(tHzn, vec2(u, 0.5)).r * 0.4 - 0.05;
          float rel = asin(clamp(R.y, 0.0, 1.0));
          float mtn = smoothstep(hz + 0.004, hz - 0.004, rel);
          vec3 vdf = normalize(vec3(R.x, max(R.y, 0.015), R.z));
          float sdm = max(dot(vdf, uSunDir), 0.0), sunLow = 1.0 - smoothstep(0.04, 0.4, uSunDir.y);
          vec3 mcol = mix(uSkyFog, uHor + uGlow * pow(sdm, 4.0) * 0.22 * (1.0 - uDark), 0.55 * (1.0 - uFogSky)) * (0.8 - 0.32 * pow(sdm, 3.0) * sunLow * (1.0 - uDark));
          refl = mix(refl, mcol, mtn * (1.0 - uFogSky * 0.6));
        }
        refl = mix(refl, uSkyFog, uFogSky*0.75);
        // reflected forest wall along banks
        float side = sign(R.z + 1e-4);
        float mz = uRiver.x*sin(vWp.x*0.011 + uRiver.y) + uRiver.z*sin(vWp.x*0.023 + 1.3);
        float bankZ = mz + side*(uRiver.w + 14.0);
        float tz = (bankZ - vWp.z) / (R.z + side*1e-4);
        if (tz > 0.0) {
          float hx = vWp.x + R.x*tz;
          float th = 15.0 + 9.0*texture2D(tNoise, vec2(hx*0.004, side*0.3)).g + 7.0*texture2D(tNoise, vec2(hx*0.017, 0.2)).r;
          float hy = R.y * tz;
          float tree = smoothstep(th + 1.5, th - 1.5, hy);
          vec3 forest = uAmb * vec3(0.16, 0.24, 0.13) * 1.6 + uSunCol*uSunVis*uSunOcc*vec3(0.06,0.08,0.03);
          refl = mix(refl, forest, tree * 0.92);
        }
        float fres = 0.04 + 0.96*pow(1.0 - max(dot(N, V), 0.0), 4.0);
        fres = mix(fres, 0.85, flt*0.4);
        vec3 deepC = vec3(0.02, 0.075, 0.07), shallowC = vec3(0.07, 0.2, 0.15);
        vec3 body = mix(shallowC, deepC, smoothstep(0.2, 2.6, depth)) * (uAmb*1.2 + uSunCol*uSunVis*uSunOcc*0.35);
        vec3 col = mix(body, refl, fres);
        // sun / moon glints
        float sg = pow(max(dot(R, uSunDir), 0.0), 380.0) * 22.0 + pow(max(dot(R, uSunDir), 0.0), 40.0) * 0.4;
        col += uSunCol * sg * uSunVis * uSunOcc * (1.0 - uDark*0.9) * (1.0 - cloudCov(cloudDensity(vWp.xz*0.00035 + uSunDir.xz*0.35))*0.8);
        col += vec3(0.75, 0.8, 1.0) * pow(max(dot(R, uMoonDir), 0.0), 220.0) * 3.0 * uMoonVis * uMoonOcc * (1.0 - uDark);
        // shoreline foam
        float fn = texture2D(tNoise, vWp.xz*0.35 + vec2(uTime*0.05, 0.0)).a;
        float foam = smoothstep(0.22, 0.0, depth + (fn - 0.5)*0.18) * (0.55 + 0.45*sin(uTime*1.6 + depth*30.0 + fn*6.0));
        col = mix(col, (uAmb + uSunCol*uSunVis)*0.75, clamp(foam, 0.0, 1.0)*0.6);
        col += vec3(0.75, 0.8, 1.0) * uFlash * 0.5;
        float alpha = clamp(mix(0.4, 0.97, smoothstep(0.0, 1.4, depth)) + fres*0.5 + foam*0.4, 0.0, 1.0);
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  Object.assign(m.uniforms, U);
  return m;
}

// ---------- rain (line segments around camera) ----------
export function rainMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: U, transparent: true, depthWrite: false, fog: false,
    vertexShader: /* glsl */`
      attribute vec3 seed; attribute float tip;
      uniform float uTime, uWind, uRain; uniform vec2 uWindDir; uniform vec3 uCam;
      varying float vA;
      void main(){
        vec3 box = vec3(36.0, 22.0, 36.0);
        vec3 slant = normalize(vec3(uWindDir.x*(0.15+uWind*0.5), -1.0, uWindDir.y*(0.15+uWind*0.5)));
        float y = mod(seed.y*box.y - uTime*(11.0 + seed.x*3.0), box.y);
        vec3 p;
        p.x = uCam.x + mod(seed.x*box.x - uCam.x - slant.x*y, box.x) - box.x*0.5;
        p.z = uCam.z + mod(seed.z*box.z - uCam.z - slant.z*y, box.z) - box.z*0.5;
        p.y = uCam.y - 6.0 + y;
        p -= slant * tip * (0.45 + seed.y*0.3);
        vA = (1.0 - tip*0.7) * smoothstep(box.y, box.y - 3.0, y);
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform float uRain, uFlash; uniform vec3 uAmb; varying float vA;
      void main(){ vec3 c = uAmb*1.6 + 0.12 + uFlash*0.6; gl_FragColor = vec4(c, vA * 0.38 * min(1.0, uRain*1.5));
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`,
  });
}

// ---------- fireflies & sunlit dust ----------
export function pointsMaterial(kind) {
  const ff = kind === 'ff';
  return new THREE.ShaderMaterial({
    uniforms: U, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    vertexShader: /* glsl */`
      attribute vec4 seed; uniform float uTime, uPx; uniform vec3 uCam; varying float vB;
      void main(){
        vec3 p = position;
        ${ff ? `
          p += vec3(sin(uTime*0.4*seed.x + seed.y*6.0)*0.6, sin(uTime*0.6*seed.y + seed.z*5.0)*0.3, cos(uTime*0.35*seed.z + seed.x*4.0)*0.6);
          vB = pow(max(sin(uTime*(0.35 + seed.w*0.5) + seed.x*20.0), 0.0), 14.0);
        ` : `
          vec3 box = vec3(14.0, 6.0, 14.0);
          vec3 q = seed.xyz*box + vec3(uTime*0.12, sin(uTime*0.3 + seed.w*6.0)*0.4 + uTime*0.03, uTime*0.07);
          p = uCam + mod(q - uCam, box) - box*0.5;
          vB = 0.4 + 0.6*sin(uTime*2.0 + seed.w*30.0)*0.5 + 0.3;
        `}
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = ${ff ? '24.0' : '5.0'} * uPx / -mv.z;
        ${ff ? 'gl_PointSize = clamp(gl_PointSize, 2.0, 40.0);' : 'gl_PointSize = clamp(gl_PointSize, 1.0, 3.0); vB *= smoothstep(7.0, 1.5, -mv.z);'}
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uFF, uDust, uSunVis; uniform vec3 uSunCol; varying float vB;
      void main(){
        vec2 c = gl_PointCoord - 0.5; float r = length(c);
        ${ff ? `
          float g = smoothstep(0.5, 0.0, r); g = g*g*0.6 + smoothstep(0.09, 0.0, r);
          gl_FragColor = vec4(vec3(0.75, 1.0, 0.35) * g * vB * uFF * 1.6, 1.0);
        ` : `
          float g = smoothstep(0.5, 0.1, r);
          gl_FragColor = vec4(uSunCol * vec3(1.0, 0.85, 0.6) * g * vB * uDust * 0.22, 1.0);
        `}
      }`,
  });
}

// ---------- low mist over the river ----------
export function mistMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: U, transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
    vertexShader: /* glsl */`varying vec3 vWp; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vWp = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
    fragmentShader: /* glsl */`
      uniform sampler2D tNoise; uniform float uTime, uMist; uniform vec3 uFogCol, uCam; uniform vec2 uWindDir; varying vec3 vWp;
      void main(){
        float n = texture2D(tNoise, vWp.xz*0.012 + vec2(uTime*0.006, uTime*0.002) + vWp.y*0.1).r;
        float n2 = texture2D(tNoise, vWp.xz*0.031 - vec2(uTime*0.004, 0.0)).g;
        float a = smoothstep(0.35, 0.85, n*0.65 + n2*0.35) * uMist;
        float d = length(vWp.xz - uCam.xz);
        a *= smoothstep(3.0, 14.0, d) * smoothstep(900.0, 300.0, d);
        gl_FragColor = vec4(uFogCol*1.05, a*0.55);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}
