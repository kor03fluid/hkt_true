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

const HOLO_VERT = /* glsl */ `
varying vec3 vView;
varying vec3 vWorld;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = -mv.xyz;
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * mv;
}`;
const HOLO_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uHotColor;
uniform float uOpacity;
uniform float uHot;
uniform float uTime;
varying vec3 vView;
varying vec3 vWorld;
void main() {
  vec3 n = normalize(cross(dFdx(vView), dFdy(vView))); // facet normal, works for any mesh
  float facing = abs(dot(n, normalize(vView)));
  float rim = pow(1.0 - facing, 2.0);
  float scan = 0.82 + 0.18 * sin(gl_FragCoord.y * 1.6 + uTime * 6.0);   // fine projector lines
  float band = smoothstep(0.93, 1.0, fract(vWorld.y * 0.22 - uTime * 0.18)); // slow sweep
  vec3 col = uColor * (0.35 + 0.35 * facing + 1.6 * rim) + vec3(0.75, 0.95, 1.0) * band * 0.35;
  col = mix(col, uHotColor * (0.7 + 1.4 * rim), uHot * 0.75);
  float a = uOpacity * (0.16 + 0.55 * rim + 0.12 * band) * scan;
  gl_FragColor = vec4(col * a, a);
}`;

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
    this.shift = ((W > 900 ? 300 : 0) / 2) * this.unitsPerPx;
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
      // geometry in pivot space: the pivot sits at the part centre so a part twists about itself
      geo.translate(-c.x - pc.x, -c.y - pc.y, -c.z - pc.z);
      geo.computeBoundingSphere();
      geo.computeBoundsTree();

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
      const holoMat = new THREE.ShaderMaterial({
        vertexShader: HOLO_VERT,
        fragmentShader: HOLO_FRAG,
        uniforms: {
          uColor: { value: new THREE.Color(holoCol) },
          uHotColor: { value: HOT },
          uOpacity: { value: 1 },
          uHot: { value: 0 },
          uTime: this.time,
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
    this.rot.y += dyaw;
    this.rot.x = clamp(this.rot.x + dpitch, -1.5, 1.5);
    this.vel.y += (dyaw / Math.max(dt, 0.008) - this.vel.y) * 0.3;
    this.vel.x += (dpitch / Math.max(dt, 0.008) - this.vel.x) * 0.3;
    this.idle = 0;
  }
  rollBy(d) {
    this.rot.z = clamp(this.rot.z + d, -1.4, 1.4);
    this.idle = 0;
  }
  zoomBy(f) {
    this.scaleTarget = clamp(this.scaleTarget * f, 0.3, 6);
  }
  resetView(snap = false) {
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
    const ghost = (this.isolate && this.sel >= 0 && p.i !== this.sel) || (this.xray && p.i !== this.sel && p.i !== this.hover);
    const hot = p.i === this.hover || p.i === this.sel || p.i === this.grabbed;
    const key = `${p.visible}|${ghost}|${hot}|${this.edges}|${this.isolate}|${this.holo}`;
    if (key === p.look) return;
    p.look = key;
    p.pivot.visible = p.visible;
    p.mesh.material = this.holo ? p.holoMat : p.mat;
    p.holoMat.uniforms.uOpacity.value = ghost ? (this.isolate ? 0.06 : 0.3) : 1;
    p.mat.transparent = ghost;
    p.mat.opacity = ghost ? (this.isolate ? 0.08 : 0.22) : 1;
    p.mat.depthWrite = !ghost;
    p.mat.emissiveIntensity = hot ? 0.55 : 0.05;
    p.mat.needsUpdate = true;
    if (p.edges) {
      const m = p.edges.material;
      p.edges.visible = this.edges && !(ghost && this.isolate);
      m.color.copy(hot && this.holo ? HOT : this.holo ? p.edges.userData.holo : p.edges.userData.solid);
      m.blending = this.holo ? THREE.AdditiveBlending : THREE.NormalBlending;
      m.depthWrite = !this.holo;
      m.opacity = this.holo ? (hot ? 0.95 : ghost ? 0.1 : 0.42) : hot ? 0.9 : ghost ? 0.18 : 0.4;
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

    if (!this.holdVel) {
      this.rot.y += this.vel.y * dt;
      this.rot.x = clamp(this.rot.x + this.vel.x * dt, -1.5, 1.5);
      const k = Math.exp(-2.6 * dt);
      this.vel.x *= k;
      this.vel.y *= k;
      if (this.autoSpin && this.idle > 2.0 && Math.hypot(this.vel.x, this.vel.y) < 0.05) this.rot.y += 0.14 * dt;
    }

    this.time.value += dt;
    this.modeBlend = damp(this.modeBlend, this.explodeMode === 'sphere' ? 1 : 0, 4, dt);
    if (this.entry) {
      const e = this.shownExplode;
      const m = this.modeBlend;
      let reach = 0;
      for (const p of this.parts) {
        const fast = p.i === this.grabbed ? 18 : 6;
        p.offset.lerp(p.offsetT, 1 - Math.exp(-fast * dt));
        p.q.slerp(p.qT, 1 - Math.exp(-fast * dt));
        p.pivot.position.copy(p.base).addScaledVector(p.dir, e * (1 - m)).addScaledVector(p.dirSphere, e * m).add(p.offset);
        p.pivot.quaternion.copy(p.q);
        if (p.visible) reach = Math.max(reach, p.pivot.position.length() + p.rad * 0.5);
        const hot = p.i === this.hover || p.i === this.sel || p.i === this.grabbed ? 1 : 0;
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
      this.root.position.x = this.shift;
    }
    this.root.updateMatrixWorld(true);
    this.renderer.render(this.scene, this.camera);
  }
}

const _qI = new THREE.Quaternion();
