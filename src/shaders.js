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
  uDuck: { value: Array.from({ length: 6 }, () => new THREE.Vector4(0, 0, 0, 0)) },
  uSnk: { value: Array.from({ length: 72 }, () => new THREE.Vector4(0, 0, -100, 0)) }, uSnB: { value: Array.from({ length: 3 }, () => new THREE.Vector4(0, 0, 0, 0)) },
  uRip: { value: [new THREE.Vector4(0, 0, -99, 0), new THREE.Vector4(0, 0, -99, 0), new THREE.Vector4(0, 0, -99, 0), new THREE.Vector4(0, 0, -99, 0)] },
  uCam: { value: new THREE.Vector3() }, uMist: { value: 0 }, uFogCol: { value: new THREE.Color() },
  uFF: { value: 0 }, uBolt: { value: new THREE.Vector4(0, 0, 0, 0) }, uCampOn: { value: 0 }, uCampA: { value: new THREE.Vector4(0, 0, 999, 999) }, uCampB: { value: new THREE.Vector4(1, 0, 1, 1) }, uOpen: { value: 1 }, uRainbow: { value: 0 }, uHaze: { value: new THREE.Color() }, uMtnK: { value: new THREE.Vector3(1, 1, 1) }, uLee: { value: new THREE.Vector4(0, 0, 1, 0) }, uLeeS: { value: new THREE.Vector3(1, 1, 0) }, uSunOccM: { value: 1 }, uSunOcc: { value: 1 }, uMoonOcc: { value: 1 }, uFogNear: { value: 100 }, uFogFar: { value: 6000 }, uFogSky: { value: 0 }, uSkyFog: { value: new THREE.Color() }, uDust: { value: 0 }, uPx: { value: 1 }, uDepthBox: { value: new THREE.Vector4(-480, -240, 960, 480) },
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
#ifdef LILY
  transformed.xz *= mix(0.25, 1.0, uOpen * sway + (1.0 - sway));
  transformed.y += sway * (1.0 - uOpen) * 0.05;
#endif
vec4 mvPosition = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
  #ifdef HIDECAMP
  if (uCampOn > 0.5) {
    vec2 o = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xz;
    vec2 d = o - uCampA.xy;
    vec2 l = vec2(d.x * uCampB.x - d.y * uCampB.y, d.x * uCampB.y + d.y * uCampB.x); // tent-local (x across, y along)
    bool inTent = abs(l.x) < uCampB.z + 0.12 && abs(l.y) < uCampB.w + 0.35;
    bool inPit = length(o - uCampA.zw) < 0.78;
    if (inTent || inPit) mvPosition.y -= 5.0;
  }
  #endif
#endif
vec4 wpp = modelMatrix * mvPosition;
float gst = texture2D(tNoise, wpp.xz*0.013 - uWindDir*uTime*0.075).b;
vGust = gst;
float sw = sway * uAmp;
vec2 wv = uWindDir * (uWind*(0.25 + 1.5*gst*gst)) + vec2(sin(uTime*1.9 + wpp.x*0.8 + wpp.z*0.35), cos(uTime*1.45 + wpp.z*0.7)) * 0.1 * (0.25 + uWind);
wpp.xz += wv * sw; wpp.y -= dot(wv,wv) * sw * 0.3;
vWp = wpp.xyz; vWN = normal;
#ifdef CLIFF
vCl = aCl;
#endif
mvPosition = viewMatrix * wpp;
gl_Position = projectionMatrix * mvPosition;
`;

export function patch(mat, key, amp = 0, defs = {}) {
  mat.defines = Object.assign({}, mat.defines || {}, defs);
  mat.onBeforeCompile = (sh) => {
    for (const k of ['uAmb', 'uSunCol', 'uCampOn', 'uCampA', 'uCampB', 'uOpen', 'uTime', 'uWind', 'uWindDir', 'tNoise', 'uCloudOff', 'uCover', 'uSunDir', 'uSunVis', 'uWet', 'uSunOcc', 'uZen', 'uHor', 'uGlow', 'uDark', 'uSkyFog', 'uFogSky', 'uFogNear', 'uFogFar', 'uHaze', 'uMtnK']) sh.uniforms[k] = U[k];
    sh.uniforms.uAmp = { value: amp };
    if (defs.SAFE !== undefined) sh.fragmentShader = sh.fragmentShader.replace('#include <dithering_fragment>', '#include <dithering_fragment>\n  { vec4 c_ = gl_FragColor; if (!(abs(c_.r) < 1e4 && abs(c_.g) < 1e4 && abs(c_.b) < 1e4 && abs(c_.a) < 1e4)) gl_FragColor = vec4(0.04, 0.07, 0.065, 1.0); }');
    if (defs.NOFLIP !== undefined) sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''));
    sh.vertexShader = `attribute float sway;\n#ifdef CLIFF\nattribute vec2 aCl;\nvarying vec2 vCl;\n#endif\nuniform float uTime, uWind, uAmp, uOpen, uCampOn;\nuniform vec4 uCampA, uCampB;\nuniform vec2 uWindDir;\nuniform sampler2D tNoise;\nvarying vec3 vWp;\nvarying vec3 vWN;\nvarying float vGust;\n` +
      sh.vertexShader.replace('#include <project_vertex>', PROJ);
    sh.fragmentShader = `uniform sampler2D tNoise;\nuniform vec2 uCloudOff;\nuniform float uCover, uSunVis, uWet, uSunOcc, uDark, uFogSky, uFogNear, uFogFar, uTime;\nuniform vec3 uSunDir, uZen, uHor, uGlow, uSkyFog, uSunCol, uAmb, uHaze, uMtnK;\nvarying vec3 vWp;\nvarying vec3 vWN;\nvarying float vGust;\n#ifdef CLIFF\nvarying vec2 vCl;\n#endif\n` + CLOUD + SKYFN +
      sh.fragmentShader.replace('#include <alphatest_fragment>', `#ifdef CARD
        { vec3 fn = normalize(cross(dFdx(vWp), dFdy(vWp))); vec3 vd = normalize(cameraPosition - vWp); diffuseColor.a *= smoothstep(0.06, 0.32, abs(dot(fn, vd))); }
      #endif
      #include <alphatest_fragment>`).replace('#include <color_fragment>', `#include <color_fragment>
      #ifdef DETAIL
        {
          // exposed earth on steep banks: mostly one ochre-brown loam with big soft patches, vertical rain runnels and
          // lighter wash streaks; layering only faint and only here and there; dark topsoil with roots at the top edge
          // (cliff), sand-martin burrows in places, a wet dark band at the water
          float steep = 1.0 - smoothstep(0.58, 0.86, normalize(vWN).y);
          steep *= smoothstep(-0.4, 0.2, vWp.y) * (1.0 - smoothstep(9.0, 14.0, vWp.y));
          if (steep > 0.001) {
            float hc = vWp.x * 0.8 + vWp.z * 0.6;
            float n1 = texture2D(tNoise, vec2(hc * 0.035, vWp.y * 0.05 + 0.13)).r;
            float n2 = texture2D(tNoise, vec2(hc * 0.13, vWp.y * 0.17 + 0.71)).g;
            float st = texture2D(tNoise, vec2(hc * 0.85, vWp.y * 0.045 + 0.4)).b;
            float st2 = texture2D(tNoise, vec2(hc * 2.2, vWp.y * 0.1 + 0.9)).a;
            vec3 loam = vec3(0.42, 0.27, 0.16), ochre = vec3(0.60, 0.40, 0.22), sandC = vec3(0.70, 0.55, 0.36);
            vec3 sc = mix(loam, ochre, smoothstep(0.3, 0.7, n1));
            sc = mix(sc, sandC, smoothstep(0.6, 0.85, n2) * 0.45);
            float layerMask = smoothstep(0.62, 0.8, texture2D(tNoise, vec2(hc * 0.018, 0.37)).r);
            float ny = vWp.y + (n1 - 0.5) * 0.7 + (st2 - 0.5) * 0.2;
            sc *= 1.0 + layerMask * 0.08 * (smoothstep(0.7, 0.95, sin(ny * 3.3) * 0.5 + 0.5) - 0.4);
            sc *= 0.74 + 0.38 * smoothstep(0.2, 0.85, st);
            // fake relief: light and shade of vertical ribs and hollows (the face is lit as a whole otherwise)
            float rA = texture2D(tNoise, vec2(hc * 0.5, vWp.y * 0.018 + 0.21)).r, rB = texture2D(tNoise, vec2(hc * 0.5 + 0.025, vWp.y * 0.018 + 0.21)).r;
            sc *= 1.0 + clamp((rB - rA) * 5.0, -0.14, 0.14);
            // thin dark runnels down the face
            float rn = texture2D(tNoise, vec2(hc * 3.1, vWp.y * 0.07 + 0.55)).r;
            sc *= 1.0 - 0.28 * smoothstep(0.72, 0.9, rn);
            sc = mix(sc, sandC * 0.97, smoothstep(0.74, 0.93, st2) * 0.3);
            sc *= 0.9 + 0.2 * texture2D(tNoise, vWp.xz * 2.1 + vWp.y * 1.3).g;
            #ifdef CLIFF
            {
              float dTop = vCl.x;
              float soil = (1.0 - smoothstep(0.38 + 0.12 * st2, 0.72 + 0.25 * n2, dTop)) * step(0.5, vCl.y);
              sc = mix(sc, vec3(0.16, 0.11, 0.075) * (0.85 + 0.3 * n1), soil);
              float rt = smoothstep(0.86, 0.97, texture2D(tNoise, vec2(hc * 5.5, dTop * 0.35 + 0.2)).r) * (1.0 - smoothstep(0.5, 1.7, dTop)) * step(0.35, dTop);
              sc = mix(sc, vec3(0.13, 0.095, 0.065), rt * 0.75 * step(0.5, vCl.y));
              vec2 cp = vec2(hc * 4.0, dTop * 5.5), ci = floor(cp), cf = fract(cp) - 0.5;
              float rnd = texture2D(tNoise, ci * 0.0713 + 0.31).r;
              float hole = step(0.8, rnd) * (1.0 - smoothstep(0.16, 0.24, length(cf * vec2(1.0, 1.25))))
                         * smoothstep(0.45, 0.6, dTop) * (1.0 - smoothstep(1.3, 1.6, dTop)) * smoothstep(0.6, 0.7, texture2D(tNoise, vec2(hc * 0.04, 0.81)).g) * step(0.8, vCl.y);
              sc = mix(sc, vec3(0.05, 0.035, 0.025), hole);
            }
            #endif
            float wetB = 1.0 - smoothstep(0.12, 0.55 + 0.25 * n2, vWp.y);
            sc = mix(sc, sc * 0.55, wetB);
            sc = mix(sc, vec3(0.15, 0.12, 0.095), 1.0 - smoothstep(0.02, 0.25, vWp.y));
            diffuseColor.rgb = mix(diffuseColor.rgb, sc, steep);
          }
        }
      #endif
      #ifdef MTN
        float snl = vWp.y + (texture2D(tNoise, vWp.xz * 0.0011).r - 0.5) * 240.0 + (texture2D(tNoise, vWp.xz * 0.0067).a - 0.5) * 70.0;
        float snow = smoothstep(640.0, 700.0, snl) * smoothstep(0.52, 0.72, normalize(vWN).y);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.94, 0.98) * (0.5 + 0.5 * uSunVis) * (1.0 - 0.35 * uCover), snow); // snow greys at night and under clouds
      #endif`).replace('#include <opaque_fragment>', `
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
          // uMtnK: x = haze brightness vs the sky (<1 at night / under clouds), y = max haze share, z = slope light
          float fogK = smoothstep(0.45, 0.95, uFogSky); // real fog: the plain fog colour wins
          f = min(f, mix(min(fMax, uMtnK.y), 1.0, uFogSky));
          outgoingLight *= mix(uMtnK.z, 1.0, fogK);
          vec3 haze = mix(uSkyFog, uHaze + uGlow * pow(sd, 4.0) * 0.22 * (1.0 - uDark) * (1.0 - uCover * 0.8), 0.55 * (1.0 - uFogSky));
          haze = mix(haze, haze * 0.62, back) * mix(uMtnK.x, 1.0, fogK);
          outgoingLight = mix(outgoingLight, haze, f);
        #endif
        #ifdef DETAIL
          if (vWp.y < -0.02) {
            float uw = (1.0 - smoothstep(-0.25, -0.02, vWp.y));
            float peb = texture2D(tNoise, vWp.xz * 2.7).a, peb2 = texture2D(tNoise, vWp.xz * 6.1 + 0.3).r;
            float stones = smoothstep(0.62, 0.7, peb) * 0.6 + smoothstep(0.66, 0.72, peb2) * 0.4;
            float ripple = 0.5 + 0.5 * sin(dot(vWp.xz, vec2(3.1, 1.3)) + texture2D(tNoise, vWp.xz * 0.2).r * 6.0);
            float weed = smoothstep(0.55, 0.75, texture2D(tNoise, vWp.xz * 0.11 + 0.5).g);
            vec3 bed = outgoingLight * (0.88 + 0.16 * ripple);
            bed = mix(bed, outgoingLight * vec3(0.42, 0.4, 0.36), stones * 0.75);
            bed = mix(bed, outgoingLight * vec3(0.45, 0.7, 0.32), weed * 0.6);
            float ca = texture2D(tNoise, vWp.xz * 0.45 + vec2(uTime * 0.03, uTime * 0.017)).r, cb = texture2D(tNoise, vWp.xz * 0.52 - vec2(uTime * 0.021, -uTime * 0.025)).g;
            float caus = pow(max(1.0 - abs(ca - cb) * 2.6, 0.0), 14.0);
            bed *= vec3(0.74, 0.78, 0.7);
            bed += uSunCol * vec3(1.0, 0.85, 0.55) * caus * 0.1 * uSunVis * uSunOcc * smoothstep(-1.6, -0.35, vWp.y) * (1.0 - smoothstep(-0.35, -0.12, vWp.y));
            outgoingLight = mix(outgoingLight, bed, uw);
          }
          float dn = texture2D(tNoise, vWp.xz*0.19).a*0.55 + texture2D(tNoise, vWp.xz*0.83).g*0.45;
          outgoingLight *= 0.74 + 0.5*dn;
          outgoingLight *= 1.0 - uWet*0.32*smoothstep(-0.5, 0.6, vWp.y + 1.0);
        #endif
        #ifdef LEAF
          float ln = texture2D(tNoise, vWp.xz*1.7 + vWp.y*0.9).a*0.6 + texture2D(tNoise, vWp.zy*2.3 + vWp.x*0.5).g*0.4;
          outgoingLight *= 0.72 + 0.56*ln;
          outgoingLight *= 1.0 - uWet*0.15;
        #endif
        #ifdef FOLI
          {
            vec3 vdir = normalize(vWp - cameraPosition);
            float back = pow(max(dot(vdir, uSunDir), 0.0), 3.0);
            outgoingLight += diffuseColor.rgb * uSunCol * back * 0.9 * uSunVis * uSunOcc * (1.0 - cs * 0.6);
            outgoingLight *= 1.0 - uWet * 0.15;
          }
        #endif
        #ifdef LEAFI
          outgoingLight = max(outgoingLight, diffuseColor.rgb * (uAmb * 1.15 + uSunCol * uSunVis * uSunOcc * 0.3)); // underside never goes black
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
      uniform sampler2D tNoise; uniform vec2 uCloudOff; uniform float uCover, uDark, uSunVis, uNight, uMoonPhase, uMoonVis, uTime, uFlash, uSunOccM, uRainbow;
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
              float s = (1.0 - smoothstep(0.0, 0.17, dist)) * (0.35 + (h-0.965)/0.035);
              float tw = 0.65 + 0.35*sin(uTime*(1.5 + h*9.0) + h*80.0);
              col += vec3(0.85, 0.9, 1.0) * s * tw * 1.4 * uNight * smoothstep(0.0, 0.25, d.y);
            }
            vec3 ax = normalize(vec3(0.45, 0.35, -0.82));
            float band = exp(-pow(dot(d, ax), 2.0) * 16.0);
            // seamless: triplanar noise by direction (no azimuth angle, so no wrap-around seam)
            vec3 tw = pow(abs(d), vec3(4.0)); tw /= (tw.x + tw.y + tw.z);
            float n1 = texture2D(tNoise, d.yz * 0.55 + 0.3).r * tw.x + texture2D(tNoise, d.xz * 0.55 + 0.7).r * tw.y + texture2D(tNoise, d.xy * 0.55 + 0.1).r * tw.z;
            float n2 = texture2D(tNoise, d.yz * 2.0).g * tw.x + texture2D(tNoise, d.xz * 2.0).g * tw.y + texture2D(tNoise, d.xy * 2.0 + 0.5).g * tw.z;
            float mw = band * smoothstep(0.3, 0.9, n1 * 0.6 + n2 * 0.4);
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
              float edge = (1.0 - smoothstep(0.92, 1.0, r));
              col = mix(col, vec3(1.0, 0.97, 0.88) * maria * (0.08 + 1.4*lit), edge * uMoonVis);
            }
          }
          col += vec3(0.55, 0.65, 0.9) * (pow(max(md,0.0), 900.0)*0.35 + pow(max(md,0.0), 60.0)*0.04) * uMoonVis * (1.0 - uDark);
          // sun disk
          col += uSunCol * smoothstep(0.99955, 0.99975, sd) * 14.0 * uSunVis * uSunOccM;
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
        if (uRainbow > 0.001 && d.y > 0.0) {
          // primary bow: red outside at ~42 deg from the antisolar point, violet inside at ~40 deg
          float ang = acos(clamp(dot(d, -uSunDir), -1.0, 1.0));
          float t = (ang - 0.698) / 0.035;               // 0 = violet edge, 1 = red edge
          float hz = smoothstep(0.0, 0.08, d.y) * uRainbow * (1.0 - cov * 0.5);
          if (t > -0.35 && t < 1.35) {
            float wl = 400.0 + 300.0 * clamp(t, 0.0, 1.0); // wavelength, nm
            vec3 rb;                                        // spectral colour (Bruton's approximation)
            if (wl < 440.0) rb = vec3(-(wl - 440.0) / 40.0, 0.0, 1.0);
            else if (wl < 490.0) rb = vec3(0.0, (wl - 440.0) / 50.0, 1.0);
            else if (wl < 510.0) rb = vec3(0.0, 1.0, -(wl - 510.0) / 20.0);
            else if (wl < 580.0) rb = vec3((wl - 510.0) / 70.0, 1.0, 0.0);
            else if (wl < 645.0) rb = vec3(1.0, -(wl - 645.0) / 65.0, 0.0);
            else rb = vec3(1.0, 0.0, 0.0);
            float fe = wl < 420.0 ? 0.35 + 0.65 * (wl - 380.0) / 40.0 : (wl > 680.0 ? 0.35 + 0.65 * (720.0 - wl) / 40.0 : 1.0);
            rb *= fe;
            float a = smoothstep(-0.35, 0.05, t) * (1.0 - smoothstep(1.02, 1.25, t)) * hz;
            float lum = dot(col, vec3(0.3, 0.55, 0.15));
            col = mix(col, rb * (0.2 + 1.15 * lum), a * 0.62) + rb * a * 0.05;
          }
          // brighter sky inside the bow, darker Alexander band just outside it
          col *= 1.0 + 0.07 * (1.0 - smoothstep(0.62, 0.7, ang)) * smoothstep(0.2, 0.55, ang) * hz;
          col *= 1.0 - 0.06 * smoothstep(0.735, 0.76, ang) * (1.0 - smoothstep(0.82, 0.88, ang)) * hz;
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
      uniform vec3 uSunDir, uMoonDir, uZen, uHor, uGlow, uSunCol, uCloudLit, uCloudDark, uAmb, uCam, uSkyFog, uMtnK; uniform float uFogSky; uniform vec4 uLee; uniform vec3 uLeeS;
      uniform vec4 uRip[4]; uniform vec4 uDuck[6]; uniform vec4 uSnk[72]; uniform vec4 uSnB[3]; uniform vec4 uDepthBox, uRiver, uBolt;
      varying vec3 vWp;
      ${CLOUD}${SKYFN}
      float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float mzf(float x){ float s = sign(x), ax = abs(x); return uRiver.x * s * (125.0 * smoothstep(110.0, 430.0, ax) - 85.0 * smoothstep(620.0, 1050.0, ax)) + uRiver.z * sin(x * 0.019 + uRiver.y); }
      vec2 ripple(vec2 p, vec2 c, float age, float amp){
        vec2 dv = p - c; float d = length(dv); float r = age*1.4;
        float w = sin((d - r)*14.0) * exp(-abs(d - r)*5.0) * exp(-age*0.9) * amp;
        return d > 0.001 ? dv/d * w : vec2(0.0);
      }
      void main(){
        vec3 V = uCam - vWp; float dist = length(V); V /= dist;
        vec2 flow = normalize(vec2(1.0, (mzf(vWp.x + 2.0) - mzf(vWp.x - 2.0)) * 0.25));
        float sp = 0.035 + uWind*0.03;
        vec2 q = mat2(flow.x, -flow.y, flow.y, flow.x) * vWp.xz; // river frame: x along the current
        vec3 n1 = texture2D(tWaterN, q*0.045 - vec2(uTime*sp, 0.0)).xyz*2.0 - 1.0; // pattern moves downstream (+x)
        vec3 n2 = texture2D(tWaterN, vWp.xz*0.11 + vec2(0.3,-0.6)*uTime*sp*1.3 + uWindDir*uTime*0.01).xyz*2.0 - 1.0;
        vec3 n3 = texture2D(tWaterN, q*0.013 - vec2(uTime*0.012, 0.0)).xyz*2.0 - 1.0;
        // calm wake behind the island and its tail bar: the current's streaks fade, the water is smoother
        vec2 lp = vWp.xz - uLee.xy; float la = dot(lp, uLee.zw), lb = -lp.x * uLee.w + lp.y * uLee.z;
        float lee = smoothstep(uLeeS.x * 0.05, uLeeS.x * 0.3, la) * (1.0 - smoothstep(uLeeS.x + 10.0, uLeeS.x + 38.0, la))
                  * (1.0 - smoothstep(uLeeS.y + 2.5 + la * 0.1, uLeeS.y + 8.0 + la * 0.18, abs(lb - uLeeS.z * clamp(la / uLeeS.x, 0.0, 1.0))));
        vec2 nxy = n1.xy*0.55*(1.0 - 0.65*lee) + n2.xy*0.35*(0.5+uWind)*(1.0 - 0.25*lee) + n3.xy*0.5*(1.0 - 0.6*lee);
        // rain ripples
        if (uRain > 0.01) {
          // each drop's ring stays within 0.75 m, so the 3x3 neighbourhood sees every ring: no cell seams
          vec2 g0 = floor(vWp.xz / 0.7);
          for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
            vec2 id = g0 + vec2(float(i), float(j));
            float rnd = h21(id); if (rnd >= uRain) continue;
            float t = fract(uTime*0.9 + rnd);
            vec2 c = (id + 0.25 + 0.5*vec2(h21(id+3.1), h21(id+7.7))) * 0.7;
            vec2 dv = vWp.xz - c; float d = length(dv), r = t*0.55;
            float w = sin((d - r)*22.0) * exp(-abs(d - r)*9.0) * (1.0 - t) * (1.0 - t) * 0.5 * (1.0 - smoothstep(0.55, 0.75, d));
            if (d > 0.001) nxy += dv/d * w;
          }
        }
        // duck wakes: a small bow ring and a V of waves trailing behind each swimming duck
        for (int i = 0; i < 6; i++) {
          vec2 vel = uDuck[i].zw; float spd = length(vel); if (spd < 0.01) continue;
          vec2 fwd = vel / spd, lat = vec2(-fwd.y, fwd.x), dv = vWp.xz - uDuck[i].xy;
          float along = -dot(dv, fwd), l = dot(dv, lat), al = abs(l), dd = length(dv);
          if (dd > 6.0) continue;
          float k = min(1.0, spd / 0.3);
          float arm = al - max(along, 0.0) * 0.36 - 0.12;
          float vW = sin(arm * 38.0 - uTime * 5.0) * exp(-arm * arm * 30.0) * step(-0.15, along) * exp(-max(along, 0.0) * 0.55) * k;
          nxy += lat * sign(l) * vW * 0.5;
          float ring = sin((dd - 0.24) * 40.0 - uTime * 6.0) * exp(-(dd - 0.26) * (dd - 0.26) * 60.0) * k;
          nxy += dv / max(dd, 0.001) * ring * 0.15;
        }
        for (int i = 0; i < 4; i++) { float age = uTime - uRip[i].z; if (age > 0.0 && age < 4.0) nxy += ripple(vWp.xz, uRip[i].xy, age, uRip[i].w); }
        // grass snakes: each loop apex the body passes in the water becomes a fixed source of a half-circle of thin
        // crests on its convex side (alternating sides overlap into a wide wake); a curved bow wave ahead of the head;
        // a thin rim along the body; the water over the submerged body is clearer.  uSnk: 10 body points + 8 sources
        float snkClr = 0.0, snkRim = 0.0, snkCrest = 0.0;
        for (int sI = 0; sI < 3; sI++) {
          vec4 B = uSnB[sI]; if (B.z <= 0.0) continue;
          if (length(vWp.xz - B.xy) > B.z + 1.4) continue;
          float dB = 9.0; vec2 dirB = vec2(0.0);
          for (int q = 0; q < 15; q++) {
            vec4 a = uSnk[sI * 24 + q], b = uSnk[sI * 24 + q + 1];
            vec2 ab = b.xy - a.xy; float h = clamp(dot(vWp.xz - a.xy, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
            vec2 c = a.xy + ab * h, dv = vWp.xz - c; float d = length(dv);
            if (d < dB) { dB = d; dirB = dv / max(d, 1e-4); }
          }
          float rr = 0.0125, xb = dB - rr;
          // 1-2 thin lines hugging the body
          // half-circles from loop apexes
          for (int q = 0; q < 8; q++) {
            vec4 e = uSnk[sI * 24 + 16 + q];
            float age = uTime - e.z; if (age < 0.0 || age > 3.2) continue;
            vec2 dv = vWp.xz - e.xy; float r = length(dv); if (r < 1e-4) continue;
            vec2 nd = dv / r;
            float R0 = 0.03 + 0.3 * age, x = r - R0;
            if (abs(x) > 0.08) continue;
            float side = dot(nd, vec2(cos(e.w), sin(e.w)));
            float arc = smoothstep(-0.4, 0.1, side);               // ~220 degrees toward the convex side
            float w = sin(x * 290.0) * exp(-x * x * 1400.0) * exp(-age * 1.0) * arc * (1.0 - smoothstep(2.6, 3.2, age));
            nxy += nd * w * 0.35; snkCrest = max(snkCrest, abs(w));
          }
          // curved bow wave ahead of the head
          vec2 hp = uSnk[sI * 24].xy, hd = uSnk[sI * 24].xy - uSnk[sI * 24 + 1].xy; float hl = length(hd);
          if (hl > 1e-4) {
            vec2 fw = hd / hl, dv = vWp.xz - hp; float r = length(dv);
            if (r > 1e-4) {
              float front = smoothstep(-0.3, 0.4, dot(dv / r, fw));
              float bw = sin(r * 300.0 - uTime * 8.0) * exp(-r * 22.0) * front * B.w;
              nxy += dv / r * bw * 0.25; snkCrest = max(snkCrest, abs(bw));
            }
          }
        }
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
          float mtn = (1.0 - smoothstep(hz - 0.004, hz + 0.004, rel));
          vec3 vdf = normalize(vec3(R.x, max(R.y, 0.015), R.z));
          float sdm = max(dot(vdf, uSunDir), 0.0), sunLow = 1.0 - smoothstep(0.04, 0.4, uSunDir.y);
          vec3 mcol = mix(uSkyFog, uHor + uGlow * pow(sdm, 4.0) * 0.22 * (1.0 - uDark), 0.55 * (1.0 - uFogSky)) * (0.8 - 0.32 * pow(sdm, 3.0) * sunLow * (1.0 - uDark)) * mix(uMtnK.x, 1.0, smoothstep(0.45, 0.95, uFogSky));
          refl = mix(refl, mcol, mtn * (1.0 - uFogSky * 0.6));
        }
        refl = mix(refl, uSkyFog, uFogSky*0.75);
        if (uBolt.w > 0.01 && uBolt.z > 0.5) {
          vec2 bd = normalize(uBolt.xy - uCam.xz), rd = normalize(R.xz);
          float da = 1.0 - dot(bd, rd);
          refl += vec3(0.85, 0.9, 1.0) * exp(-da * 9000.0) * smoothstep(0.0, 0.02, R.y) * uBolt.w * 2.5;
        }
        // reflected forest wall along banks
        // one ray decides the bank, the hit point and the height; it uses a calmer normal so wind waves don't punch hard sky patches
        vec3 Rs = reflect(-V, normalize(vec3(nxy.x * 0.35, 1.0, nxy.y * 0.35))); Rs.y = abs(Rs.y);
        float side = sign(Rs.z + 1e-4);
        float mz = mzf(vWp.x);
        float bankZ = mz + side*(uRiver.w + 14.0);
        float tz = min((bankZ - vWp.z) / (Rs.z + side*1e-4), 3000.0);
        if (tz > 0.0) {
          float hx = vWp.x + Rs.x*tz;
          float th = 15.0 + 9.0*texture2D(tNoise, vec2(hx*0.004, side*0.3)).g + 7.0*texture2D(tNoise, vec2(hx*0.017, 0.2)).r;
          float hs = Rs.y * tz, ew = 2.5 + min(fwidth(hs) * 2.0, 6.0);
          float tree = (1.0 - smoothstep(th - ew, th + ew, hs));
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
        float fn = texture2D(tNoise, vWp.xz*0.35 - vec2(uTime*0.05, 0.0)).a; // drifts downstream (+x)
        float foam = (1.0 - smoothstep(0.0, 0.07, depth + (fn - 0.5)*0.06 + 0.03*sin(uTime*0.9 + fn*5.0))) * (0.5 + 0.5*fn);
        col = mix(col, (uAmb + uSunCol*uSunVis)*vec3(0.55, 0.55, 0.5), clamp(foam, 0.0, 1.0)*0.22);
        col += vec3(0.75, 0.8, 1.0) * uFlash * 0.5;
        float clearW = 1.0 - smoothstep(0.35, 1.7, depth); // ~5 m strip along the shore
        float alpha = clamp(mix(0.42, 0.97, smoothstep(0.0, 1.4, depth)) * (1.0 - clearW * 0.82) + fres * mix(0.5, 0.25, clearW) + foam*0.15, 0.0, 1.0);
        col += (uAmb + uSunCol * uSunVis * 0.4) * (snkRim * 0.2 + snkCrest * 0.22);
        alpha = mix(alpha, alpha * 0.28, snkClr);
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
        { vec4 c_ = gl_FragColor; if (!(abs(c_.r) < 1e4 && abs(c_.g) < 1e4 && abs(c_.b) < 1e4 && abs(c_.a) < 1e4)) gl_FragColor = vec4(0.04, 0.07, 0.065, 1.0); } // never feed NaN/Inf to bloom
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
          // slow glow: ~2-3 s lit with soft fade in/out, then a few seconds dark
          float ph = fract(uTime * (0.09 + seed.w * 0.06) + seed.x * 7.13);
          vB = smoothstep(0.0, 0.08, ph) * (1.0 - smoothstep(0.26, 0.4, ph)) * (0.85 + 0.15 * sin(uTime * 3.0 + seed.y * 30.0));
        ` : `
          vec3 box = vec3(14.0, 6.0, 14.0);
          vec3 q = seed.xyz*box + vec3(uTime*0.12, sin(uTime*0.3 + seed.w*6.0)*0.4 + uTime*0.03, uTime*0.07);
          p = uCam + mod(q - uCam, box) - box*0.5;
          vB = 0.4 + 0.6*sin(uTime*2.0 + seed.w*30.0)*0.5 + 0.3;
        `}
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = ${ff ? '0.32' : '0.03'} * uPx / -mv.z;
        ${ff ? 'vB *= clamp(gl_PointSize / 4.0, 0.4, 1.0); gl_PointSize = clamp(gl_PointSize, 2.5, 30.0);' : 'gl_PointSize = clamp(gl_PointSize, 1.0, 3.0); vB *= (1.0 - smoothstep(1.5, 7.0, -mv.z));'}
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uFF, uDust, uSunVis; uniform vec3 uSunCol; varying float vB;
      void main(){
        vec2 c = gl_PointCoord - 0.5; float r = length(c);
        ${ff ? `
          float g = (1.0 - smoothstep(0.0, 0.5, r)); g = g*g*0.6 + (1.0 - smoothstep(0.0, 0.09, r));
          gl_FragColor = vec4(vec3(0.75, 1.0, 0.35) * g * vB * uFF * 1.6, 1.0);
        ` : `
          float g = (1.0 - smoothstep(0.1, 0.5, r));
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
        a *= smoothstep(3.0, 14.0, d) * (1.0 - smoothstep(300.0, 900.0, d));
        gl_FragColor = vec4(uFogCol*1.05, a*0.55);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}
