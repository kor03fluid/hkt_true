// Three.js renderer for STL assemblies: one mesh per part, hologram or solid look, two explode modes
// (spherical expansion by Euclidean distance, or the hand-tuned moves from tools/explode.json),
// per-part drag / twist, ray picking (BVH accelerated), highlight, x-ray and isolate.
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { clamp, damp } from './utils.js';
import { partLabel } from './library.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const CAM_Z = 9.5;
const FOV = 38;
const FIT = 3.0; // radius of the exploded model in world units
const EDGE_TRI_LIMIT = 150000; // skip feature edges on very dense parts
const DEFAULT_VIEW = { x: 0.38, y: -0.62, z: 0, zoom: 1 };
const UP_ROT = { z: [-Math.PI / 2, 0, 0], y: [0, 0, 0], x: [0, 0, Math.PI / 2] };
// spherical explode: every part moves away from the assembly centre by SPHERE_GAIN x its Euclidean
// distance from it (at 100 %), so the assembly inflates like a sphere and far parts travel furthest
const SPHERE_GAIN = 1.4;
const SPHERE_MIN = 0.08; // parts closer to the centre than this share of the radius still move a little
const HOT = new THREE.Color('#ffb547'); // selection accent (amber, like the HUD in the references)

// ---------------------------------------------------------------- defects (AI maintenance mode)
// Each defect is drawn by the part's own material: the fragment shader projects the fragment onto
// the defect's tangent plane (part-local coordinates, i.e. STL mm minus the part centre) and draws
// a procedural crack / scratch / dent / wear / corrosion / deformation pattern plus an "AI detection"
// ring there. No extra geometry, so it follows the surface exactly and moves with explode / drag.
const MAX_DEF = 8; // defects drawn per part
export const DEFECT_CODES = { crack: 0, scratch: 1, dent: 2, wear: 3, corrosion: 4, deform: 5 };
const hashId = (s) => {
  let h = 2166136261;
  for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
};

const DEFECT_GLSL = /* glsl */ `
#define MAX_DEF ${MAX_DEF}
uniform int uDefN;
uniform vec4 uDefA[MAX_DEF]; // centre (part local, mm), radius
uniform vec4 uDefB[MAX_DEF]; // outward normal, type code
uniform vec4 uDefC[MAX_DEF]; // tangent (main direction), seed
uniform vec4 uDefD[MAX_DEF]; // colour, reveal 0..1 (+10 = repaired, awaiting inspection)
uniform float uDefSel;
uniform float uDefHover;
uniform float uMaint;
uniform vec4 uHealth;
uniform float uScanY;
uniform float uScanOn;
uniform float uTime;
varying vec3 vLocal;
varying vec3 vNrm;
varying vec3 vWorldP;

float dHash1(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float dHash2(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float dNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(dHash2(i), dHash2(i + vec2(1, 0)), u.x), mix(dHash2(i + vec2(0, 1)), dHash2(i + vec2(1, 1)), u.x), u.y);
}
float dFbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int k = 0; k < 4; k++) { s += a * dNoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
// coverage of a line of half-width w (in the same units as dist); px = one pixel in those units.
// Lines thinner than a pixel stay ~1 px wide but fade, so far-away cracks remain visible.
float dLine(float dist, float w, float px) {
  float ww = max(w, px * 0.75);
  return (1.0 - smoothstep(ww - px * 0.5, ww + px * 0.5, dist)) * clamp(w / (px * 0.75), 0.45, 1.0);
}
float dCrackY(float u, float seed) {
  return (dFbm(vec2(u * 2.6, seed)) - 0.5) * 0.55 + (dNoise(vec2(u * 12.0, seed + 7.0)) - 0.5) * 0.09;
}
// distance from q to a jagged crack running along x over [u0, u1] (units of the defect radius)
float dCrack(vec2 q, float seed, float u0, float u1) {
  float u = clamp(q.x, u0, u1);
  float y0 = dCrackY(u, seed), y1 = dCrackY(u + 0.01, seed);
  float slope = (y1 - y0) / 0.01;
  return length(vec2(q.x - u, (q.y - y0) / sqrt(1.0 + slope * slope)));
}

// Accumulates every defect on this part at the fragment: emit = glow (added), mark/markCol = the
// "physical" look (mixed over the solid colour).
void defectLayer(vec3 p, vec3 nrm, out vec3 emit, out vec3 markCol, out float mark) {
  emit = vec3(0.0); markCol = vec3(0.0); mark = 0.0;
  for (int k = 0; k < MAX_DEF; k++) {
    if (k >= uDefN) break;
    vec4 A = uDefA[k], B = uDefB[k], C = uDefC[k], D = uDefD[k];
    float repaired = step(9.5, D.w);
    float reveal = D.w - 10.0 * repaired;
    if (reveal <= 0.001) continue;
    float r = A.w;
    vec3 d = p - A.xyz;
    vec3 bt = cross(B.xyz, C.xyz);
    vec2 q = vec2(dot(d, C.xyz), dot(d, bt)) / r;
    float px = max(length(fwidth(q)), 1e-4); // before any per-fragment branch (derivatives)
    float h = dot(d, B.xyz);
    if (abs(h) > 0.5 + 0.25 * r) continue;            // other layers of the part (curved patch allowed)
    if (dot(nrm, B.xyz) < 0.3) continue;              // inside of a thin wall / side faces
    float rho = length(q);
    if (rho > 1.3) continue;
    float seed = C.w;
    int type = int(B.w + 0.5);
    float on = 1.0 - smoothstep(reveal * 1.25 - 0.08, reveal * 1.25, rho); // grows with the reveal
    float sel = float(k) == uDefSel ? 1.0 : 0.0;
    float hov = float(k) == uDefHover ? 1.0 : 0.0;
    vec3 col = D.rgb;
    float core = 0.0, halo = 0.0;
    vec3 look = vec3(0.0); float lookA = 0.0;
    if (type == 0) {            // crack: jagged tapered line + two branches + heat halo
      float dm = dCrack(q, seed, -0.85, 0.85);
      float taper = 1.0 - pow(clamp(abs(q.x) / 0.85, 0.0, 1.0), 2.0);
      core = dLine(dm, 0.006 + 0.026 * taper, px);
      for (int b = 0; b < 2; b++) {
        float sgn = b == 0 ? 1.0 : -1.0;
        float ub = 0.22 * sgn + 0.1 * (dHash1(seed + 3.0) - 0.5);
        vec2 o = vec2(ub, dCrackY(ub, seed));
        float ang = sgn * (0.55 + 0.3 * dHash1(seed + float(b) * 5.0));
        vec2 e = q - o;
        vec2 qb = vec2(e.x * cos(ang) + e.y * sin(ang), -e.x * sin(ang) + e.y * cos(ang));
        float db = dCrack(qb * vec2(sgn, 1.0), seed + 11.0 + float(b), 0.0, 0.42);
        core = max(core, dLine(db, 0.004 + 0.014 * (1.0 - clamp(qb.x * sgn / 0.42, 0.0, 1.0)), px));
      }
      halo = exp(-dm * 9.0) * 0.55 * (1.0 - smoothstep(0.85, 1.05, rho));
      look = vec3(0.02, 0.015, 0.015); lookA = core;
    } else if (type == 1) {     // scratch: thin near-parallel strokes
      for (int s = 0; s < 6; s++) {
        float fs = float(s);
        float ang = (dHash1(seed + fs * 3.1) - 0.5) * 0.14;
        vec2 qq = vec2(q.x * cos(ang) - q.y * sin(ang), q.x * sin(ang) + q.y * cos(ang));
        float off = (dHash1(seed + fs * 1.7) - 0.5) * 1.1;
        float a0 = -0.95 + 0.55 * dHash1(seed + fs * 5.3), a1 = 0.95 - 0.55 * dHash1(seed + fs * 7.9);
        float dx = max(0.0, max(a0 - qq.x, qq.x - a1));
        float dist = length(vec2(dx, qq.y - off - 0.07 * qq.x * qq.x));
        core = max(core, dLine(dist, 0.006 + 0.008 * dHash1(seed + fs * 9.1), px) * (0.5 + 0.5 * dHash1(seed + fs * 11.3)));
      }
      halo = 0.12 * (1.0 - smoothstep(0.6, 1.0, rho));
      look = vec3(0.86, 0.87, 0.88); lookA = core * 0.9;
    } else if (type == 2) {     // dent: depth heat map with contour rings
      float fall = 1.0 - smoothstep(0.0, 1.0, rho);
      float cd = abs(fract(rho * 4.0 + 0.5) - 0.5) / 4.0;
      core = dLine(cd, 0.006, px) * step(rho, 1.0) * 0.9;
      halo = fall * fall * 0.6;
      look = vec3(0.0); lookA = fall * fall * 0.55;
    } else if (type == 3) {     // wear: streaks along the main direction
      float n = dFbm(vec2(q.x * 1.6, q.y * 9.0) + seed);
      float m = smoothstep(0.42, 0.68, n) * (1.0 - smoothstep(0.55, 1.0, rho));
      core = m * 0.7;
      halo = 0.2 * (1.0 - smoothstep(0.5, 1.0, rho));
      look = vec3(0.78, 0.76, 0.72); lookA = m * 0.6;
    } else if (type == 4) {     // corrosion: blotch with an irregular edge and pits
      float n = dFbm(q * 3.2 + seed);
      float edge = rho + (n - 0.5) * 0.7;
      float m = 1.0 - smoothstep(0.62, 0.8, edge);
      float pit = step(0.86, dHash2(floor(q * 26.0 + seed))) * m;
      core = m * (0.45 + 0.55 * n) + pit * 0.6;
      halo = 0.25 * m;
      look = mix(vec3(0.42, 0.16, 0.05), vec3(0.12, 0.05, 0.02), pit); lookA = clamp(m * 0.85 + pit * 0.3, 0.0, 1.0);
    } else {                    // deform: elliptical contour map along the main direction
      float e = length(vec2(q.x * 0.72, q.y * 1.35));
      float cd = abs(fract(e * 5.0 + 0.5) - 0.5) / 5.0;
      float inside = 1.0 - smoothstep(0.88, 1.0, e);
      core = dLine(cd, 0.005, px) * inside;
      halo = (1.0 - e) * inside * 0.35;
      col = mix(col, vec3(0.45, 0.6, 1.0), smoothstep(0.2, 0.9, e) * 0.6);
      look = vec3(0.0); lookA = 0.0;
    }
    // AI detection ring at the defect radius: dashed, slowly turning; brighter when selected
    float ang = atan(q.y, q.x);
    float dash = step(0.42, fract(ang * 2.2282 + uTime * (0.25 + 0.6 * sel)));
    float ringR = clamp(reveal, 0.0, 1.0);
    float ring = dLine(abs(rho - ringR), mix(0.016, 0.03, max(sel, hov)), px) * (0.3 + 0.7 * dash);
    float pulse = 0.75 + 0.25 * sin(uTime * 5.0);
    float k2 = on * (repaired > 0.5 ? 0.35 : 1.0);
    vec3 ringCol = repaired > 0.5 ? vec3(0.36, 0.89, 0.54) : col;
    emit += (col * (core * 1.6 + halo) * (1.0 + 0.6 * sel * pulse) * k2 + ringCol * ring * (1.0 + 0.8 * max(sel, hov)) * on) * uMaint;
    mark = max(mark, lookA * k2 * uMaint);
    markCol = look;
  }
}
// cyan band at the AI scan plane; 'scanned' = the plane has passed this point
float scanBand() { return exp(-abs(vWorldP.y - uScanY) * 26.0) * uScanOn; }
float scanned() { return step(uScanY, vWorldP.y); }
`;

const HOLO_VERT = /* glsl */ `
varying vec3 vView;
varying vec3 vWorld;
varying vec3 vLocal;
varying vec3 vNrm;
varying vec3 vWorldP;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = -mv.xyz;
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  vWorldP = vWorld;
  vLocal = position;
  vNrm = normal;
  gl_Position = projectionMatrix * mv;
}`;
const HOLO_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uHotColor;
uniform float uOpacity;
uniform float uHot;
varying vec3 vView;
varying vec3 vWorld;
${DEFECT_GLSL}
void main() {
  vec3 n = normalize(cross(dFdx(vView), dFdy(vView))); // facet normal, works for any mesh
  float facing = abs(dot(n, normalize(vView)));
  float rim = pow(1.0 - facing, 2.0);
  float scan = 0.82 + 0.18 * sin(gl_FragCoord.y * 1.6 + uTime * 6.0);   // fine projector lines
  float band = smoothstep(0.93, 1.0, fract(vWorld.y * 0.22 - uTime * 0.18)); // slow sweep
  vec3 col = uColor * (0.35 + 0.35 * facing + 1.6 * rim) + vec3(0.75, 0.95, 1.0) * band * 0.35;
  col = mix(col, uHotColor * (0.7 + 1.4 * rim), uHot * 0.75);
  float a = uOpacity * (0.16 + 0.55 * rim + 0.12 * band) * scan;
  // maintenance mode: health tint once the scan has passed, healthy parts step back a little
  float tint = uHealth.a * uMaint * scanned();
  // this material writes its colours raw, the status / severity colours are linear: convert them
  vec3 hc = linearToOutputTexel(vec4(uHealth.rgb, 1.0)).rgb;
  col = mix(col, hc * (0.45 + 1.2 * rim), tint * 0.8);
  a *= mix(1.0, 0.6, uMaint * (1.0 - uHealth.a));
  vec3 emit, markCol; float mark;
  defectLayer(vLocal, normalize(vNrm), emit, markCol, mark);
  float sb = scanBand();
  vec3 add = linearToOutputTexel(vec4(emit, 1.0)).rgb * max(uOpacity, 0.45) + vec3(0.45, 0.95, 1.0) * sb * 0.9;
  float addA = clamp(max(max(add.r, add.g), add.b), 0.0, 1.0);
  gl_FragColor = vec4(col * a + add, clamp(a + addA, 0.0, 1.0));
}`;

/** Solid look: MeshStandardMaterial + the same defect layer injected after lighting. */
function solidDefects(shader, uniforms) {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vLocal;\nvarying vec3 vNrm;\nvarying vec3 vWorldP;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocal = position;\nvNrm = normal;\nvWorldP = (modelMatrix * vec4(position, 1.0)).xyz;');
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + DEFECT_GLSL).replace(
    '#include <opaque_fragment>',
    `#include <opaque_fragment>
    {
      vec3 base = gl_FragColor.rgb;
      float lum = dot(base, vec3(0.299, 0.587, 0.114));
      base = mix(base, vec3(lum) * 0.85, 0.4 * uMaint * (1.0 - uHealth.a)); // healthy parts go grey
      base = mix(base, base * 0.45 + uHealth.rgb * 0.55, uHealth.a * uMaint * scanned() * 0.7);
      vec3 emit, markCol; float mark;
      defectLayer(vLocal, normalize(vNrm), emit, markCol, mark);
      base = mix(base, markCol, mark) + emit * 0.85 + vec3(0.3, 0.85, 1.0) * scanBand() * 0.8;
      gl_FragColor.rgb = base;
    }`,
  );
}

/** Packed part (see tools/build_models.py) -> indexed geometry in the original assembly coordinates. */
function unpack(bin, p) {
  const q = new Uint16Array(bin, p.pos, p.verts * 3);
  const pos = new Float32Array(p.verts * 3);
  for (let a = 0; a < 3; a++) {
    const mn = p.min[a], step = (p.max[a] - p.min[a]) / 65535;
    for (let k = a; k < pos.length; k += 3) pos[k] = mn + q[k] * step;
  }
  const idx = p.index === 16 ? new Uint16Array(bin, p.idx, p.tris * 3) : new Uint32Array(bin, p.idx, p.tris * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return geo;
}

const partColor = (i) => '#' + new THREE.Color().setHSL((0.09 + i * 0.618034) % 1, 0.6, 0.62).getHexString();
// hologram: every part in the cyan / blue family, still told apart by a small hue step
const holoColor = (i) => '#' + new THREE.Color().setHSL(0.52 + (((i * 0.618034) % 1) - 0.5) * 0.16, 0.95, 0.6).getHexString();

/** Soft round sprite for the glowing dots on the sphere. */
function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.25, 'rgba(160,240,255,0.9)');
  r.addColorStop(1, 'rgba(60,200,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** Unit wireframe sphere (poles on +-Z, the model's up) with glowing dots, shown while exploding. */
function makeGlobe() {
  const pts = [];
  const seg = 72;
  for (let lat = -75; lat <= 75; lat += 25) {
    const z = Math.sin((lat * Math.PI) / 180), r = Math.cos((lat * Math.PI) / 180);
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
      pts.push(r * Math.cos(a0), r * Math.sin(a0), z, r * Math.cos(a1), r * Math.sin(a1), z);
    }
  }
  for (let m = 0; m < 12; m++) {
    const a = (m / 12) * Math.PI * 2;
    for (let k = 0; k < seg / 2; k++) {
      const b0 = -Math.PI / 2 + (k / (seg / 2)) * Math.PI, b1 = -Math.PI / 2 + ((k + 1) / (seg / 2)) * Math.PI;
      pts.push(Math.cos(b0) * Math.cos(a), Math.cos(b0) * Math.sin(a), Math.sin(b0), Math.cos(b1) * Math.cos(a), Math.cos(b1) * Math.sin(a), Math.sin(b1));
    }
  }
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const lines = new THREE.LineSegments(
    lineGeo,
    new THREE.LineBasicMaterial({ color: '#4fd8ff', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  // evenly spread dots (Fibonacci sphere)
  const n = 420, dots = [];
  for (let i = 0; i < n; i++) {
    const z = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(1 - z * z), a = i * 2.399963;
    dots.push(r * Math.cos(a), r * Math.sin(a), z);
  }
  const dotGeo = new THREE.BufferGeometry();
  dotGeo.setAttribute('position', new THREE.Float32BufferAttribute(dots, 3));
  const points = new THREE.Points(
    dotGeo,
    new THREE.PointsMaterial({ map: dotTexture(), color: '#7fe8ff', size: 9, sizeAttenuation: false, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  const g = new THREE.Group();
  g.add(lines, points);
  lines.raycast = points.raycast = () => {};
  g.userData = { lines, points };
  return g;
}

export class StlScene {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 200);
    this.camera.position.set(0, 0, CAM_Z);
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.HemisphereLight(0xe4e9ff, 0x1c1e2a, 1.25));
    const key = new THREE.DirectionalLight(0xffffff, 1.9);
    key.position.set(3, 4, 6);
    const rim = new THREE.DirectionalLight(0x8fb4ff, 1.1);
    rim.position.set(-4, 2, -5);
    this.scene.add(key, rim);
    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.ray = new THREE.Raycaster();
    this.ray.firstHitOnly = true;
    this.occRay = new THREE.Raycaster(); // marker occlusion (own near / far)
    this.occRay.firstHitOnly = true;

    this.models = [];
    this.cache = new Map(); // model index -> built entry | Promise
    this.entry = null;
    this.parts = [];
    this.index = -1;
    this.pending = -1;
    this.pop = 0; // 0 = hidden, 1 = shown (model switch animation)

    this.explode = 0;
    this.explodeTarget = 0;
    this.intensity = 1;
    this.rot = { ...DEFAULT_VIEW };
    this.vel = { x: 0, y: 0 };
    this.scale = 1;
    this.scaleTarget = 1;
    this.holdVel = false;
    this.autoSpin = false;
    this.idle = 0;
    this.hover = -1;
    this.sel = -1;
    this.grabbed = -1;
    this.xray = false;
    this.isolate = false;
    this.edges = true;
    this.holo = true; // hologram look (false = solid CAD look)
    this.explodeMode = 'sphere'; // 'sphere' (Euclidean expansion) | 'tuned' (tools/explode.json)
    this.modeBlend = 1; // 1 = sphere, 0 = tuned; animated when the mode changes
    this.shift = 0;
    this.time = { value: 0 }; // shared shader clock
    this.globe = makeGlobe();
    this.globeR = 0; // current sphere radius in assembly units

    // AI maintenance mode
    this.maint = false;
    this.uMaint = { value: 0 }; // shared by every part material
    this.uScanY = { value: -1e5 }; // world y of the scan plane (far below = everything scanned)
    this.uScanOn = { value: 0 };
    this.scan = null; // { t: 0..1, dur, top, bottom } while the AI scan sweeps
    this.defects = []; // resolved defects of the shown model (see setDefects)
    this.defectSel = null;
    this.defectHover = null;
    this.focus = null; // focused defect (camera turned to it, others ghosted)
    this.rotGoal = null; // animated view turn towards the focused defect
    this.anchorRel = new THREE.Vector3(); // root origin -> focused defect (world), last known
    this.anchorF = 0; // 0..1 blend of the anchoring (keeps the focused defect in the middle)
    this.preFocusScale = null;
    this.proc = null; // repair procedure step view { target, removed: [], current }
    this.insets = null; // [left, right] px covered by panels; null = the default left panel
    this._occFrame = 0;
    this.onReveal = null; // (id) when the scan reaches a defect
    this.onScanEnd = null;
    this.procBlend = 0;

    this.onModel = null; // (index, entry)
    this.onLoading = null; // (name, fraction 0..1, label) | null when finished

    this.resize();
    addEventListener('resize', () => this.resize());
  }

  get shownExplode() {
    return this.explode * this.intensity;
  }

  resize() {
    const W = innerWidth, H = innerHeight;
    this.W = W;
    this.H = H;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.setSize(W, H, false);
    this.camera.aspect = W / H;
    this.camera.updateProjectionMatrix();
    this.unitsPerPx = (2 * Math.tan((FOV * Math.PI) / 360) * CAM_Z) / H;
    const [l, r] = this.insets || [W > 900 ? 300 : 0, 0];
    this.shift = ((l - r) / 2) * this.unitsPerPx; // the model sits in the middle of the free area
  }
  /** Screen px covered by side panels (left, right); the model is centred between them. */
  setInsets(left, right) {
    this.insets = [left, right];
    this.resize();
  }

  // ------------------------------------------------------------------ models
  addModels(defs) {
    const start = this.models.length;
    this.models.push(...defs);
    return start;
  }

  async _build(i) {
    const def = this.models[i];
    const loader = new STLLoader();
    const man = def.manifest?.parts || {};
    const raw = [];
    const failed = [];
    const bin = def.binUrl ? await this._fetchBin(def) : null;
    for (let k = 0; k < def.parts.length; k++) {
      const src = def.parts[k];
      try {
        let geo;
        if (src.packed) geo = unpack(bin, src.packed);
        else {
          this.onLoading?.(def.name, k / def.parts.length, `${k}/${def.parts.length}`);
          let buf;
          if (src.blob) buf = await src.blob.arrayBuffer();
          else {
            const r = await fetch(src.url);
            if (!r.ok) throw new Error('HTTP ' + r.status);
            buf = await r.arrayBuffer();
          }
          geo = loader.parse(buf);
          await new Promise((r) => setTimeout(r)); // keep the page responsive on big assemblies
        }
        if (!geo.attributes.position?.count) throw new Error('empty mesh');
        geo.computeBoundingBox();
        raw.push({ src, geo, info: man[src.file] || man[src.file.split('/').pop()] || {} });
      } catch (e) {
        console.warn('part load failed:', src.file, e);
        failed.push(src.file);
      }
    }
    this.onLoading?.(null);
    if (!raw.length) throw new Error(`${def.name}: STL을 하나도 읽지 못했습니다`);

    const box = new THREE.Box3();
    for (const r of raw) box.union(r.geo.boundingBox);
    const c = box.getCenter(new THREE.Vector3());
    const R = Math.max(1e-6, box.getSize(new THREE.Vector3()).length() / 2);

    const asm = new THREE.Group();
    const up = UP_ROT[def.up] || UP_ROT.z;
    asm.rotation.set(up[0], up[1], up[2]);

    let maxR = R;
    const parts = raw.map((r, idx) => {
      const { src, geo, info } = r;
      const pc = r.geo.boundingBox.getCenter(new THREE.Vector3()).sub(c);
      const size = r.geo.boundingBox.getSize(new THREE.Vector3());
      // geometry in pivot space: the pivot sits at the part centre so a part twists about itself,
      // i.e. part-local = STL coordinates - part bbox centre
      const center = pc.clone().add(c);
      geo.translate(-center.x, -center.y, -center.z);
      geo.computeBoundingSphere();
      geo.computeBoundsTree();
      // smooth outward normals (all parts have outward winding); only the defect shader reads them,
      // the materials keep flat shading
      geo.computeVertexNormals();

      let dir; // hand-tuned move (tools/explode.json), or a fallback away from the centre
      if (Array.isArray(info.offset)) dir = new THREE.Vector3(...info.offset);
      else if (Array.isArray(info.explode)) dir = new THREE.Vector3(...info.explode).multiplyScalar(R * 0.7);
      else {
        const len = pc.length();
        dir = len < R * 0.02 ? new THREE.Vector3() : pc.clone().multiplyScalar(1.3).addScaledVector(pc.clone().normalize(), R * 0.2);
      }
      // spherical move: along the ray from the centre, length = gain x Euclidean distance
      const dist = pc.length();
      const away = dist > R * 1e-4 ? pc.clone().divideScalar(dist) : dir.lengthSq() > 0 ? dir.clone().normalize() : new THREE.Vector3(0, 0, 1);
      const dirSphere = away.multiplyScalar(SPHERE_GAIN * Math.max(dist, R * SPHERE_MIN));
      const rad = size.length() / 2;
      maxR = Math.max(maxR, pc.clone().add(dir).length() + rad, pc.clone().add(dirSphere).length() + rad);

      const color = info.color || partColor(idx);
      const holoCol = holoColor(idx);
      // defect uniforms, the same objects in both materials of the part
      const vec4s = () => Array.from({ length: MAX_DEF }, () => new THREE.Vector4());
      const defU = {
        uDefN: { value: 0 },
        uDefA: { value: vec4s() },
        uDefB: { value: vec4s() },
        uDefC: { value: vec4s() },
        uDefD: { value: vec4s() },
        uDefSel: { value: -1 },
        uDefHover: { value: -1 },
        uMaint: this.uMaint,
        uHealth: { value: new THREE.Vector4(0, 0, 0, 0) },
        uScanY: this.uScanY,
        uScanOn: this.uScanOn,
        uTime: this.time,
      };
      const holoMat = new THREE.ShaderMaterial({
        vertexShader: HOLO_VERT,
        fragmentShader: HOLO_FRAG,
        uniforms: {
          uColor: { value: new THREE.Color(holoCol) },
          uHotColor: { value: HOT },
          uOpacity: { value: 1 },
          uHot: { value: 0 },
          ...defU,
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const mat = new THREE.MeshStandardMaterial({
        color,
        metalness: 0.28,
        roughness: 0.46,
        emissive: color,
        emissiveIntensity: 0.05,
        flatShading: true, // CAD look: one normal per facet, for STL and packed meshes alike
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      mat.onBeforeCompile = (shader) => solidDefects(shader, defU);
      const mesh = new THREE.Mesh(geo, this.holo ? holoMat : mat);
      mesh.userData.i = idx;
      const pivot = new THREE.Group();
      pivot.add(mesh);
      const tris = (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
      let edges = null;
      if (tris <= EDGE_TRI_LIMIT) {
        edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 28), new THREE.LineBasicMaterial({ transparent: true, opacity: 0.4 }));
        edges.userData.solid = new THREE.Color(color).lerp(new THREE.Color('#ffffff'), 0.55);
        edges.userData.holo = new THREE.Color(holoCol).lerp(new THREE.Color('#ffffff'), 0.35);
        edges.raycast = () => {};
        pivot.add(edges);
      }
      asm.add(pivot);
      return {
        i: idx,
        code: info.code || src.file.replace(/\.stl$/i, ''), // file path for local models (unique per model)
        center, // part bbox centre in STL coordinates (mm)
        defU,
        remove: 0, // procedure view: 0 in place .. 1 taken out along `dir`
        name: info.name || partLabel(src.file.split('/').pop()),
        alt: info.alt || '', // Korean name from the file, when the display name is English
        group: info.group || '',
        file: src.file,
        desc: info.desc || '',
        color: this.holo ? holoCol : color,
        colorSolid: color,
        colorHolo: holoCol,
        size,
        rad,
        tris,
        base: pc,
        dir,
        dirSphere,
        mesh,
        edges,
        mat,
        holoMat,
        hot: 0,
        pivot,
        visible: true,
        offset: new THREE.Vector3(),
        offsetT: new THREE.Vector3(),
        q: new THREE.Quaternion(),
        qT: new THREE.Quaternion(),
        look: '',
      };
    });
    const r0 = Math.max(...parts.map((p) => p.base.length() + p.rad * 0.5));
    return { def, asm, parts, fit: FIT / maxR, failed, r0 };
  }

  /** Downloads a packed model (.bin) with a progress bar. */
  async _fetchBin(def) {
    this.onLoading?.(def.name, 0, '');
    const r = await fetch(def.binUrl);
    if (!r.ok) throw new Error(`${def.name}: HTTP ${r.status}`);
    // content-length is the transfer size; with gzip the body is larger, so it only drives the bar
    const total = +r.headers.get('content-length') || 0;
    if (!r.body || !total) return r.arrayBuffer();
    const reader = r.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      this.onLoading?.(def.name, Math.min(1, got / total), `${(got / 1e6).toFixed(1)} MB`);
    }
    const out = new Uint8Array(got);
    let at = 0;
    for (const c of chunks) out.set(c, at), (at += c.length);
    return out.buffer;
  }

  /** Loads (once) and returns the built model. */
  load(i) {
    if (!this.cache.has(i)) {
      const p = this._build(i).then(
        (e) => (this.cache.set(i, e), e),
        (err) => (this.cache.delete(i), Promise.reject(err)),
      );
      this.cache.set(i, p);
    }
    return Promise.resolve(this.cache.get(i));
  }

  async setModel(i) {
    const n = this.models.length;
    if (!n) return;
    i = ((i % n) + n) % n;
    if (i === this.index && this.pending < 0) return;
    this.pending = i;
    this.pendingReady = false;
    try {
      await this.load(i);
    } catch (e) {
      if (this.pending === i) this.pending = -1;
      throw e;
    }
    if (this.pending === i) this.pendingReady = true;
  }
  next(d = 1) {
    this.setModel((this.pending >= 0 ? this.pending : this.index) + d).catch((e) => console.error(e));
  }

  _show(i) {
    const e = this.cache.get(i);
    if (this.entry) this.root.remove(this.entry.asm);
    this.entry = e;
    this.parts = e.parts;
    this.index = i;
    this.root.add(e.asm);
    e.asm.add(this.globe);
    this.globeR = 0;
    this.hover = this.sel = this.grabbed = -1;
    this.defects = [];
    this.defectSel = this.defectHover = null;
    this.focus = this.rotGoal = this.proc = this.scan = null;
    this.anchorF = 0;
    this.preFocusScale = null;
    this.uScanOn.value = 0;
    this.uScanY.value = -1e5;
    for (const p of e.parts) (p.remove = 0), (p.look = '');
    this.resetView(true);
    this.onModel?.(i, e);
  }

  // ------------------------------------------------------------------ interaction API
  setHover(i) {
    this.hover = i;
  }
  setSel(i) {
    this.sel = i;
  }
  setVisible(i, v) {
    if (this.parts[i]) this.parts[i].visible = v;
  }
  /** Hologram or solid look, for every loaded model. */
  setHolo(v) {
    this.holo = v;
    for (const e of this.cache.values()) {
      if (!e.parts) continue; // still loading
      for (const p of e.parts) {
        p.color = v ? p.colorHolo : p.colorSolid;
        p.look = '';
      }
    }
  }
  rotateBy(dyaw, dpitch, dt = 1 / 60) {
    this.rotGoal = null; // the user takes over from the focus animation
    this.rot.y += dyaw;
    this.rot.x = clamp(this.rot.x + dpitch, -1.5, 1.5);
    this.vel.y += (dyaw / Math.max(dt, 0.008) - this.vel.y) * 0.3;
    this.vel.x += (dpitch / Math.max(dt, 0.008) - this.vel.x) * 0.3;
    this.idle = 0;
  }
  rollBy(d) {
    this.rotGoal = null;
    this.rot.z = clamp(this.rot.z + d, -1.4, 1.4);
    this.idle = 0;
  }
  /** Largest zoom: closer while a defect is focused. */
  get maxScale() {
    return this.focus ? 14 : 6;
  }
  zoomBy(f) {
    this.scaleTarget = clamp(this.scaleTarget * f, 0.3, this.maxScale);
  }
  resetView(snap = false) {
    this.focus = this.rotGoal = null;
    this.preFocusScale = null;
    if (snap) this.anchorF = 0;
    const v = { ...DEFAULT_VIEW, ...this.entry?.def.manifest?.view };
    this.rot.x = v.x;
    this.rot.y = v.y;
    this.rot.z = v.z;
    this.vel.x = this.vel.y = 0;
    this.scaleTarget = v.zoom;
    if (snap) this.scale = v.zoom;
    this.resetParts(snap);
    this.setSel(-1);
  }
  /** Moved / twisted parts fly back to their assembly position. */
  resetParts(snap = false) {
    for (const p of this.parts) {
      p.offsetT.set(0, 0, 0);
      p.qT.identity();
      if (snap) {
        p.offset.set(0, 0, 0);
        p.q.identity();
      }
    }
  }
  get movedParts() {
    return this.parts.filter((p) => p.offsetT.lengthSq() > 1e-12 || p.qT.angleTo(_qI) > 1e-3).length;
  }

  _toAsm(v) {
    // world-space vector -> assembly-local vector
    const q = this.entry.asm.getWorldQuaternion(new THREE.Quaternion()).invert();
    return v.applyQuaternion(q).divideScalar(Math.max(1e-6, this.root.scale.x));
  }
  /** Move a part by a screen-space pixel delta (stays where it is dropped). */
  dragPart(i, dx, dy) {
    const p = this.parts[i];
    if (!p) return;
    p.offsetT.add(this._toAsm(new THREE.Vector3(dx * this.unitsPerPx, -dy * this.unitsPerPx, 0)));
    this.idle = 0;
  }
  /** Turn a part about the camera axis (wrist twist while pinching). */
  twistPart(i, angle) {
    const p = this.parts[i];
    if (!p || !angle) return;
    const axis = this._toAsm(new THREE.Vector3(0, 0, 1)).normalize();
    p.qT.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, angle));
  }
  /** Turn a part by a screen drag (mouse). */
  spinPart(i, dx, dy) {
    const p = this.parts[i];
    if (!p) return;
    const qy = new THREE.Quaternion().setFromAxisAngle(this._toAsm(new THREE.Vector3(0, 1, 0)).normalize(), dx * 0.01);
    const qx = new THREE.Quaternion().setFromAxisAngle(this._toAsm(new THREE.Vector3(1, 0, 0)).normalize(), dy * 0.01);
    p.qT.premultiply(qy).premultiply(qx);
  }

  // ------------------------------------------------------------------ AI maintenance
  /** Maintenance look on / off. The selection accent turns cyan-white so it never reads as a severity colour. */
  setMaint(on) {
    this.maint = !!on;
    HOT.set(on ? '#bff6ff' : '#ffb547');
    for (const p of this.parts) p.look = '';
  }

  /**
   * Defects of the shown model. list: [{ id, part (index), p: [x,y,z] STL mm, n?, t?, type, size,
   * color: '#hex', status: 'open' | 'repaired' | 'closed' }], in priority order (the 8-per-part cap
   * keeps the first ones). Each point is snapped onto the part's surface; the winding normal of the
   * closest triangle is used when n is missing or points into the material, the STL +Z axis (else +X)
   * projected onto the surface when t is missing. Every row is kept in this.defects (drawn: false
   * for closed / over-cap rows); reveal state is kept per id across calls. Returns the list.
   */
  setDefects(list) {
    if (!this.entry) return [];
    for (const p of this.parts) p.defU.uDefN.value = 0;
    const prev = new Map(this.defects.map((d) => [d.id, d]));
    const out = [];
    const target = {};
    const tri = new THREE.Triangle();
    for (const d of list || []) {
      const p = this.parts[d.part];
      if (!p || !Array.isArray(d.p)) continue;
      const geo = p.mesh.geometry;
      const want = new THREE.Vector3(...d.p).sub(p.center);
      const hit = geo.boundsTree.closestPointToPoint(want, target);
      if (!hit) continue;
      const local = hit.point.clone();
      const idx = geo.index.array, f = hit.faceIndex * 3;
      tri.setFromAttributeAndIndices(geo.attributes.position, idx[f], idx[f + 1], idx[f + 2]);
      const wn = tri.getNormal(new THREE.Vector3()); // outward (winding)
      let n = Array.isArray(d.n) && Math.hypot(...d.n) > 1e-6 ? new THREE.Vector3(...d.n).normalize() : null;
      const flipped = !!n && n.dot(wn) < 0.5;
      if (!n || flipped) n = wn;
      let t = Array.isArray(d.t) ? new THREE.Vector3(...d.t) : new THREE.Vector3(0, 0, 1);
      t.addScaledVector(n, -t.dot(n));
      if (t.lengthSq() < 0.04) t = new THREE.Vector3(1, 0, 0).addScaledVector(n, -n.x);
      if (t.lengthSq() < 0.04) t = new THREE.Vector3(0, 1, 0).addScaledVector(n, -n.y);
      t.normalize();
      const was = prev.get(d.id);
      const fresh = this.scan ? 0 : 1;
      const rd = {
        id: d.id,
        part: d.part,
        local,
        n,
        t,
        r: Math.max(1.5, 0.6 * (+d.size || 5)),
        type: d.type,
        color: new THREE.Color(d.color || '#ff4d5e'),
        status: d.status || 'open',
        snap: local.distanceTo(want), // mm the point moved onto the surface
        flipped, // the given normal pointed into the material and was replaced
        drawn: false,
        slot: -1,
        reveal: was ? was.reveal : fresh,
        revealT: was ? was.revealT : fresh,
        world: was ? was.world : new THREE.Vector3(),
        occluded: was ? was.occluded : false,
      };
      if (rd.status !== 'closed') {
        const u = p.defU;
        if (u.uDefN.value < MAX_DEF) {
          rd.slot = u.uDefN.value++;
          rd.drawn = true;
          u.uDefA.value[rd.slot].set(local.x, local.y, local.z, rd.r);
          u.uDefB.value[rd.slot].set(n.x, n.y, n.z, DEFECT_CODES[d.type] ?? 0);
          u.uDefC.value[rd.slot].set(t.x, t.y, t.z, (hashId(d.id) % 1000) / 1000 * 97.3);
        } else console.warn(`part ${p.name}: more than ${MAX_DEF} defects, ${d.id} not drawn`);
      }
      if (!was) rd.world.copy(local).applyMatrix4(p.mesh.matrixWorld);
      out.push(rd);
    }
    this.defects = out;
    if (this.focus) this.focus = out.find((d) => d.id === this.focus.id) || null;
    this._defectUniforms();
    return out;
  }

  /** Status colour tint of a part in maintenance mode (null = no tint). */
  setHealth(i, hex) {
    const p = this.parts[i];
    if (!p) return;
    const v = p.defU.uHealth.value;
    if (!hex) v.w = 0;
    else {
      const c = new THREE.Color(hex);
      v.set(c.r, c.g, c.b, 1);
    }
  }

  /** AI scan: a plane (world y) sweeps the model top to bottom and reveals the defects it passes. */
  startScan(seconds = 2.4) {
    if (!this.entry) return false;
    this.root.updateMatrixWorld(true);
    let top = -Infinity, bottom = Infinity;
    const w = new THREE.Vector3();
    for (const p of this.parts) {
      if (!p.visible) continue;
      const y = p.pivot.getWorldPosition(w).y, r = p.rad * this.root.scale.x;
      top = Math.max(top, y + r);
      bottom = Math.min(bottom, y - r);
    }
    const lim = (this.H / 2) * this.unitsPerPx;
    this.scan = { t: 0, dur: Math.max(0.3, seconds), top: Math.min(top, lim), bottom: Math.max(bottom, -lim) };
    for (const d of this.defects) d.reveal = d.revealT = 0;
    return true;
  }
  get scanProgress() {
    return this.scan ? this.scan.t : 1;
  }

  /** Turn the view to a defect (its normal towards the camera), centre and zoom on it; null releases. */
  focusDefect(id) {
    const d = id == null ? null : this.defects.find((x) => x.id === id);
    if (!d || !this.entry) {
      if (this.focus && this.preFocusScale != null) this.scaleTarget = Math.min(6, this.preFocusScale);
      this.focus = this.rotGoal = null;
      this.preFocusScale = null;
      return false;
    }
    if (!this.focus) this.preFocusScale = this.scaleTarget;
    this.focus = d;
    const p = this.parts[d.part];
    // defect normal in root-local coordinates
    const n = d.n.clone().applyQuaternion(p.pivot.quaternion).applyQuaternion(this.entry.asm.quaternion);
    // root rotation is Euler 'YXZ' (R = Ry Rx Rz) with roll 0: solve Ry Rx n = +Z (towards the camera)
    const s = n.z >= 0 ? 1 : -1;
    const x = clamp(Math.atan2(s * n.y, s * n.z), -1.45, 1.45);
    let y = Math.atan2(-n.x, s * Math.hypot(n.y, n.z));
    y += Math.round((this.rot.y - y) / (2 * Math.PI)) * 2 * Math.PI; // nearest equivalent turn
    this.rotGoal = { x, y, z: 0 };
    this.vel.x = this.vel.y = 0;
    // zoom so the detection ring is ~48 px, unless the part would then reach the camera
    const k = this.entry.fit / this.unitsPerPx; // px per mm at scale 1
    const bb = p.mesh.geometry.boundingBox || p.mesh.geometry.computeBoundingBox() || p.mesh.geometry.boundingBox;
    let front = 0;
    for (let c = 0; c < 8; c++) {
      const corner = new THREE.Vector3(c & 1 ? bb.max.x : bb.min.x, c & 2 ? bb.max.y : bb.min.y, c & 4 ? bb.max.z : bb.min.z);
      front = Math.max(front, corner.sub(d.local).dot(d.n));
    }
    const sRing = 48 / (d.r * k);
    const sClip = (CAM_Z - 1.5) / (this.entry.fit * (front + d.r));
    this.scaleTarget = clamp(sRing, 1, Math.min(14, sClip));
    return true;
  }

  /** Scale at which the assembly fills `share` of the free area between the panels. */
  fitScale(share = 0.7) {
    if (!this.entry) return 1;
    const [l, r] = this.insets || [this.W > 900 ? 300 : 0, 0];
    const free = Math.min(this.W - l - r, this.H);
    return clamp((share * free) / 2 / ((this.entry.r0 * this.entry.fit) / this.unitsPerPx), 0.3, 6);
  }

  /**
   * Repair procedure view: { target, removed: [part indices], current, phase: 'out' | 'in' } or null.
   * Removed parts sit out along their removal path and are ghosted; the current part is highlighted and
   * moves out ('out') or back in ('in'); the target is never ghosted. Explode is suppressed meanwhile.
   */
  setProcedure(spec) {
    this.proc = spec
      ? { target: spec.target ?? -1, removed: new Set(spec.removed || []), current: spec.current ?? -1, phase: spec.phase === 'in' ? 'in' : 'out' }
      : null;
  }

  /** Markers: screen position of every drawn defect, whether something hides it, ring radius in px. */
  defectScreen() {
    if (!this.entry || this.pop < 0.5) return [];
    const check = this._occFrame++ % 3 === 0;
    const meshes = check ? this.parts.filter((p) => p.pivot.visible && !this._ghost(p)).map((p) => p.mesh) : null;
    const cam = this.camera.position;
    const out = [];
    for (const d of this.defects) {
      if (!d.drawn || !this.parts[d.part].pivot.visible) continue;
      const w = d.world;
      const toCam = cam.clone().sub(w);
      const dist = toCam.length();
      if (check) {
        this.occRay.set(cam, toCam.clone().negate().divideScalar(dist));
        this.occRay.far = Math.max(0, dist - 0.6 * this.root.scale.x);
        d.occluded = this.occRay.intersectObjects(meshes, false).length > 0;
      }
      const s = this._screen(w);
      const wn = d.n.clone().transformDirection(this.parts[d.part].mesh.matrixWorld);
      const depth = Math.max(0.1, CAM_Z - w.z);
      out.push({
        id: d.id,
        x: s.x,
        y: s.y,
        occluded: d.occluded,
        facing: wn.dot(toCam.divideScalar(dist)),
        reveal: d.reveal,
        r: ((d.r * this.root.scale.x) / this.unitsPerPx) * (CAM_Z / depth),
        status: d.status,
      });
    }
    return out;
  }

  /** Surface point under the cursor, for adding a defect: { part, code, p: STL mm, n, local } or null. */
  pickSurface(px, py) {
    if (!this.entry || this.pop < 0.5) return null;
    this.root.updateMatrixWorld(true);
    this.ray.setFromCamera(new THREE.Vector2((px / this.W) * 2 - 1, -(py / this.H) * 2 + 1), this.camera);
    const meshes = this.parts.filter((p) => this._pickable(p) && !this._ghost(p)).map((p) => p.mesh);
    const hit = this.ray.intersectObjects(meshes, false)[0];
    if (!hit) return null;
    const p = this.parts[hit.object.userData.i];
    const local = hit.object.worldToLocal(hit.point.clone());
    const n = hit.face.normal; // winding normal in object space (outward), not the smooth hit.normal
    const stl = local.clone().add(p.center);
    const r2 = (v) => Math.round(v * 100) / 100;
    return { part: p.i, code: p.code, p: [r2(stl.x), r2(stl.y), r2(stl.z)], n: [n.x, n.y, n.z].map((v) => Math.round(v * 1e4) / 1e4), local };
  }

  _defectUniforms() {
    const sel = this.defectSel, hov = this.defectHover;
    for (const p of this.parts) (p.defU.uDefSel.value = -1), (p.defU.uDefHover.value = -1);
    for (const d of this.defects) {
      if (!d.drawn) continue;
      const u = this.parts[d.part].defU;
      u.uDefD.value[d.slot].set(d.color.r, d.color.g, d.color.b, d.reveal + (d.status === 'repaired' ? 10 : 0));
      if (d.id === sel) u.uDefSel.value = d.slot;
      if (d.id === hov) u.uDefHover.value = d.slot;
    }
  }

  /** Parts drawn see-through: isolate / x-ray as before, plus the maintenance focus and procedure. */
  _ghost(p) {
    if (this.isolate && this.sel >= 0 && p.i !== this.sel) return true;
    if (this.xray && p.i !== this.sel && p.i !== this.hover) return true;
    if (this.proc) {
      if (p.i === this.proc.target || p.i === this.proc.current) return false;
      if (this.proc.removed.has(p.i)) return true;
    }
    return !!this.focus && p.i !== this.focus.part;
  }
  get focused() {
    return !!this.focus;
  }

  // ------------------------------------------------------------------ projection / picking
  _screen(world) {
    const v = world.clone().project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * this.W, y: (-v.y * 0.5 + 0.5) * this.H };
  }
  _pickable(p) {
    return p.visible && !(this.isolate && this.sel >= 0 && p.i !== this.sel);
  }

  /** Part under a screen point (ray hit first, else nearest part centre within maxDist px). */
  pick(px, py, maxDist = 100) {
    if (!this.entry || this.pop < 0.5) return -1;
    this.root.updateMatrixWorld(true);
    this.ray.setFromCamera(new THREE.Vector2((px / this.W) * 2 - 1, -(py / this.H) * 2 + 1), this.camera);
    const meshes = this.parts.filter((p) => this._pickable(p)).map((p) => p.mesh);
    const hit = this.ray.intersectObjects(meshes, false)[0];
    if (hit) return hit.object.userData.i;
    let best = -1, bd = maxDist;
    const w = new THREE.Vector3();
    for (const p of this.parts) {
      if (!this._pickable(p)) continue;
      const s = this._screen(p.pivot.getWorldPosition(w));
      const d = Math.hypot(s.x - px, s.y - py);
      if (d < bd) (bd = d), (best = p.i);
    }
    return best;
  }

  labelPoints() {
    const w = new THREE.Vector3();
    return this.parts
      .filter((p) => this._pickable(p))
      .map((p) => ({ i: p.i, name: p.name, color: p.color, ...this._screen(p.pivot.getWorldPosition(w)) }));
  }
  centerScreen() {
    return this._screen(this.root.getWorldPosition(new THREE.Vector3()));
  }
  /** Screen centre and radius (px) of the assembly sphere, for the HUD rings. */
  hud() {
    if (!this.entry) return null;
    const c = this._screen(this.entry.asm.getWorldPosition(new THREE.Vector3()));
    const r = (Math.max(this.globeR, this.entry.r0) * this.root.scale.x) / this.unitsPerPx;
    return { ...c, r, explode: clamp(this.explode, 0, 1), scale: this.scale, sphere: this.modeBlend };
  }

  // ------------------------------------------------------------------ frame
  _look(p) {
    const ghost = this._ghost(p);
    const iso = ghost && this.isolate && this.sel >= 0 && p.i !== this.sel;
    const deep = ghost && !iso && !!this.focus && p.i !== this.focus.part; // context only, around a focused defect
    const hot = p.i === this.hover || p.i === this.sel || p.i === this.grabbed || (!!this.proc && p.i === this.proc.current);
    const key = `${p.visible}|${ghost}|${iso}|${deep}|${hot}|${this.edges}|${this.holo}`;
    if (key === p.look) return;
    p.look = key;
    p.pivot.visible = p.visible;
    p.mesh.material = this.holo ? p.holoMat : p.mat;
    p.holoMat.uniforms.uOpacity.value = ghost ? (iso ? 0.06 : deep ? 0.14 : 0.3) : 1;
    p.mat.transparent = ghost;
    p.mat.opacity = ghost ? (iso ? 0.08 : deep ? 0.12 : 0.22) : 1;
    p.mat.depthWrite = !ghost;
    p.mat.emissiveIntensity = hot ? 0.55 : 0.05;
    p.mat.needsUpdate = true;
    if (p.edges) {
      const m = p.edges.material;
      p.edges.visible = this.edges && !iso;
      m.color.copy(hot && this.holo ? HOT : this.holo ? p.edges.userData.holo : p.edges.userData.solid);
      m.blending = this.holo ? THREE.AdditiveBlending : THREE.NormalBlending;
      m.depthWrite = !this.holo;
      m.opacity = this.holo ? (hot ? 0.95 : deep ? 0.06 : ghost ? 0.1 : 0.42) : hot ? 0.9 : deep ? 0.08 : ghost ? 0.18 : 0.4;
      m.needsUpdate = true;
    }
  }

  update(dt) {
    this.idle += dt;
    this.explode = damp(this.explode, this.explodeTarget, 5, dt);
    this.scale = damp(this.scale, this.scaleTarget, 6, dt);

    // model switch: shrink the old one, swap, grow the new one
    const swapping = this.pending >= 0 && this.pendingReady;
    this.pop = damp(this.pop, swapping || !this.entry ? 0 : 1, swapping ? 9 : 5, dt);
    if (swapping && (this.pop < 0.04 || !this.entry)) {
      const i = this.pending;
      this.pending = -1;
      this.pendingReady = false;
      this._show(i);
    }

    if (this.rotGoal) {
      // focus animation: turn the defect towards the camera, roll back to level
      const g = this.rotGoal;
      this.rot.x = damp(this.rot.x, g.x, 4, dt);
      this.rot.y = damp(this.rot.y, g.y, 4, dt);
      this.rot.z = damp(this.rot.z, g.z, 4, dt);
      this.vel.x = this.vel.y = 0;
      if (Math.abs(this.rot.x - g.x) + Math.abs(this.rot.y - g.y) + Math.abs(this.rot.z - g.z) < 1e-3) this.rotGoal = null;
    } else if (!this.holdVel) {
      this.rot.y += this.vel.y * dt;
      this.rot.x = clamp(this.rot.x + this.vel.x * dt, -1.5, 1.5);
      const k = Math.exp(-2.6 * dt);
      this.vel.x *= k;
      this.vel.y *= k;
      if (this.autoSpin && !this.focus && this.idle > 2.0 && Math.hypot(this.vel.x, this.vel.y) < 0.05) this.rot.y += 0.14 * dt;
    }

    this.time.value += dt;
    this.uMaint.value = damp(this.uMaint.value, this.maint ? 1 : 0, 5, dt);
    this.modeBlend = damp(this.modeBlend, this.explodeMode === 'sphere' ? 1 : 0, 4, dt);
    this.procBlend = damp(this.procBlend || 0, this.proc ? 1 : 0, 4, dt);
    if (this.entry) {
      const e = this.shownExplode * (1 - this.procBlend); // a procedure view takes over from the explode
      const m = this.modeBlend;
      let reach = 0;
      for (const p of this.parts) {
        const fast = p.i === this.grabbed ? 18 : 6;
        p.offset.lerp(p.offsetT, 1 - Math.exp(-fast * dt));
        p.q.slerp(p.qT, 1 - Math.exp(-fast * dt));
        // procedure view: parts taken off in this or an earlier step sit out along their removal path
        const pr = this.proc;
        const out = pr && (pr.removed.has(p.i) || (pr.current === p.i && pr.phase === 'out')) ? 1 : 0;
        p.remove = damp(p.remove, out, 4, dt);
        p.pivot.position.copy(p.base).addScaledVector(p.dir, e * (1 - m)).addScaledVector(p.dirSphere, e * m).add(p.offset);
        if (p.remove > 1e-4) p.pivot.position.addScaledVector(this._removePath(p), p.remove);
        p.pivot.quaternion.copy(p.q);
        if (p.visible) reach = Math.max(reach, p.pivot.position.length() + p.rad * 0.5);
        const hot = p.i === this.hover || p.i === this.sel || p.i === this.grabbed || (this.proc && p.i === this.proc.current) ? 1 : 0;
        p.hot = damp(p.hot, hot, 10, dt);
        p.holoMat.uniforms.uHot.value = p.hot;
        this._look(p);
      }
      // the sphere wraps the expanding parts; it fades in with the explode (sphere mode only)
      this.globeR = this.globeR ? damp(this.globeR, reach, 8, dt) : reach;
      const show = clamp((e - 0.04) / 0.3, 0, 1) * m * (this.holo ? 1 : 0.6);
      this.globe.visible = show > 0.01;
      this.globe.scale.setScalar(Math.max(1e-3, this.globeR));
      this.globe.rotation.z += dt * 0.12;
      this.globe.userData.lines.material.opacity = 0.16 * show;
      this.globe.userData.points.material.opacity = 0.75 * show;
      const ease = 1 - Math.pow(1 - clamp(this.pop, 0, 1), 3);
      this.root.rotation.set(this.rot.x, this.rot.y + (1 - ease) * 0.8, this.rot.z, 'YXZ');
      this.root.scale.setScalar(this.entry.fit * this.scale * Math.max(1e-3, ease));
      this.root.position.set(this.shift, 0, 0).addScaledVector(this.anchorRel, -this.anchorF);
      this.root.updateMatrixWorld(true);
      this._updateDefects(dt);
    }
    this.root.updateMatrixWorld(true);
    this.renderer.render(this.scene, this.camera);
  }

  /** Removal path of a part (mm, assembly coordinates): its tuned explode move, else straight out. */
  _removePath(p) {
    if (p.dir.lengthSq() >= 1) return p.dir;
    return (p._outDir ||= p.dirSphere.clone().normalize().multiplyScalar(p.rad * 1.2));
  }

  /** Scan sweep, defect reveal, world positions and the anchoring that keeps a focused defect centred. */
  _updateDefects(dt) {
    if (this.scan) {
      this.scan.t = Math.min(1, this.scan.t + dt / this.scan.dur);
      this.uScanY.value = this.scan.top + (this.scan.bottom - this.scan.top) * this.scan.t;
      this.uScanOn.value = Math.min(1, this.scan.t * 8, (1 - this.scan.t) * 8);
    }
    for (const d of this.defects) d.world.copy(d.local).applyMatrix4(this.parts[d.part].mesh.matrixWorld);
    // anchoring: put the focused defect exactly at (free-area centre, 0, 0) in world space, so it stays
    // put while the view turns, zooms or explodes (blend in / out with anchorF)
    if (this.focus) this.anchorRel.copy(this.focus.world).sub(this.root.position);
    this.anchorF = damp(this.anchorF, this.focus ? 1 : 0, 6, dt);
    const moved = _v.copy(this.root.position);
    this.root.position.set(this.shift, 0, 0).addScaledVector(this.anchorRel, -this.anchorF);
    moved.subVectors(this.root.position, moved);
    if (moved.lengthSq() > 0) {
      this.root.updateMatrixWorld(true);
      for (const d of this.defects) d.world.add(moved);
    }
    for (const d of this.defects) {
      if (this.scan && d.revealT === 0 && d.drawn && d.world.y >= this.uScanY.value) {
        d.revealT = 1;
        this.onReveal?.(d.id);
      }
      d.reveal = d.revealT ? Math.min(1, d.reveal + dt / 0.3) : d.reveal; // 0 -> 1 in 0.3 s, never back
    }
    if (this.scan && this.scan.t >= 1) {
      for (const d of this.defects) d.revealT = 1;
      this.scan = null;
      this.uScanOn.value = 0;
      this.uScanY.value = -1e5;
      this.onScanEnd?.();
    }
    this._defectUniforms();
  }
}

const _qI = new THREE.Quaternion();
const _v = new THREE.Vector3();
