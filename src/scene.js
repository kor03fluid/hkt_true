// Three.js renderer for STL assemblies: one mesh per part, explode along part-centre directions,
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

const partColor = (i) => '#' + new THREE.Color().setHSL((0.09 + i * 0.618034) % 1, 0.6, 0.62).getHexString();

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
    this.shift = 0;

    this.onModel = null; // (index, entry)
    this.onLoading = null; // (name, done, total) | null when finished

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
    for (let k = 0; k < def.parts.length; k++) {
      const src = def.parts[k];
      this.onLoading?.(def.name, k, def.parts.length);
      try {
        let buf;
        if (src.blob) buf = await src.blob.arrayBuffer();
        else {
          const r = await fetch(src.url);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          buf = await r.arrayBuffer();
        }
        const geo = loader.parse(buf);
        if (!geo.attributes.position?.count) throw new Error('empty STL');
        geo.computeBoundingBox();
        raw.push({ src, geo, info: man[src.file] || man[src.file.split('/').pop()] || {} });
      } catch (e) {
        console.warn('STL load failed:', src.file, e);
        failed.push(src.file);
      }
      await new Promise((r) => setTimeout(r)); // keep the page responsive on big assemblies
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

      let dir;
      if (Array.isArray(info.offset)) dir = new THREE.Vector3(...info.offset);
      else if (Array.isArray(info.explode)) dir = new THREE.Vector3(...info.explode).multiplyScalar(R * 0.7);
      else {
        const len = pc.length();
        dir = len < R * 0.02 ? new THREE.Vector3() : pc.clone().multiplyScalar(1.3).addScaledVector(pc.clone().normalize(), R * 0.2);
      }
      maxR = Math.max(maxR, pc.clone().add(dir).length() + size.length() / 2);

      const color = info.color || partColor(idx);
      const mat = new THREE.MeshStandardMaterial({
        color,
        metalness: 0.28,
        roughness: 0.46,
        emissive: color,
        emissiveIntensity: 0.05,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData.i = idx;
      const pivot = new THREE.Group();
      pivot.add(mesh);
      const tris = geo.attributes.position.count / 3;
      let edges = null;
      if (tris <= EDGE_TRI_LIMIT) {
        edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(geo, 28),
          new THREE.LineBasicMaterial({ color: new THREE.Color(color).lerp(new THREE.Color('#ffffff'), 0.55), transparent: true, opacity: 0.4 }),
        );
        edges.raycast = () => {};
        pivot.add(edges);
      }
      asm.add(pivot);
      return {
        i: idx,
        name: info.name || partLabel(src.file.split('/').pop()),
        file: src.file,
        desc: info.desc || '',
        color,
        size,
        tris,
        base: pc,
        dir,
        mesh,
        edges,
        mat,
        pivot,
        visible: true,
        offset: new THREE.Vector3(),
        offsetT: new THREE.Vector3(),
        q: new THREE.Quaternion(),
        qT: new THREE.Quaternion(),
        look: '',
      };
    });
    return { def, asm, parts, fit: FIT / maxR, failed };
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

  // ------------------------------------------------------------------ frame
  _look(p) {
    const ghost = (this.isolate && this.sel >= 0 && p.i !== this.sel) || (this.xray && p.i !== this.sel && p.i !== this.hover);
    const hot = p.i === this.hover || p.i === this.sel || p.i === this.grabbed;
    const key = `${p.visible}|${ghost}|${hot}|${this.edges}|${this.isolate}`;
    if (key === p.look) return;
    p.look = key;
    p.pivot.visible = p.visible;
    p.mat.transparent = ghost;
    p.mat.opacity = ghost ? (this.isolate ? 0.08 : 0.22) : 1;
    p.mat.depthWrite = !ghost;
    p.mat.emissiveIntensity = hot ? 0.55 : 0.05;
    p.mat.needsUpdate = true;
    if (p.edges) {
      p.edges.visible = this.edges && !(ghost && this.isolate);
      p.edges.material.opacity = hot ? 0.9 : ghost ? 0.18 : 0.4;
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

    if (this.entry) {
      const e = this.shownExplode;
      for (const p of this.parts) {
        const fast = p.i === this.grabbed ? 18 : 6;
        p.offset.lerp(p.offsetT, 1 - Math.exp(-fast * dt));
        p.q.slerp(p.qT, 1 - Math.exp(-fast * dt));
        p.pivot.position.copy(p.base).addScaledVector(p.dir, e).add(p.offset);
        p.pivot.quaternion.copy(p.q);
        this._look(p);
      }
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
