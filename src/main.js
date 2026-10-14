import './styles.css';
import { StlScene } from './scene.js';
import { repoModels, localModels } from './library.js';
import { HandTracker } from './handTracking.js';
import { GestureEngine, HAND_CONNECTIONS } from './gestureEngine.js';
import { Maint } from './maint.js';
import { clamp } from './utils.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const fxCanvas = $('fx');
const ctx = fxCanvas.getContext('2d');
// behind the hologram: the sharp hands cut out of the camera image, and the HUD rings
const backCanvas = $('back');
const bctx = backCanvas.getContext('2d');
const maskCanvas = document.createElement('canvas'); // low-res hand silhouette (feathered)
const mctx = maskCanvas.getContext('2d');
const MASK_SCALE = 0.25;
const banner = $('banner');

let W = innerWidth, H = innerHeight, DPR = 1;
// screen px covered by the left panel and the AI maintenance panel; the model and the overlays centre
// between them (relayout() keeps scene, CSS and canvas in step)
const insets = { l: 300, r: 0 };
let maint = null;
function relayout() {
  const wide = innerWidth > 900;
  insets.l = wide ? 300 : 0;
  const diag = maint?.on ? maint.diagWidth() : 0;
  insets.r = wide && diag ? diag + 28 : 0;
  document.body.style.setProperty('--inset-l', insets.l + 'px');
  document.body.style.setProperty('--inset-r', insets.r + 'px');
  scene?.setInsets(insets.l, insets.r);
}
function sizeFx() {
  W = innerWidth;
  H = innerHeight;
  DPR = Math.min(devicePixelRatio || 1, 2);
  fxCanvas.width = W * DPR;
  fxCanvas.height = H * DPR;
  backCanvas.width = W;
  backCanvas.height = H;
  maskCanvas.width = Math.ceil(W * MASK_SCALE);
  maskCanvas.height = Math.ceil(H * MASK_SCALE);
}
sizeFx();
addEventListener('resize', () => {
  sizeFx();
  relayout();
});

// narrow screens: the left panel starts folded so the model is visible (☰ opens it)
if (innerWidth <= 900) document.body.classList.add('panel-hide');
$('b-panel').addEventListener('click', () => document.body.classList.toggle('panel-hide'));

let bannerTimer = 0;
let bannerKind = ''; // 'model' (about a model load), 'sticky' (a mode prompt), '' (anything else)
function showBanner(msg, info = false, kind = '') {
  if (!msg && kind && bannerKind !== kind) return; // clearing 'my' banner never removes someone else's message
  banner.textContent = msg;
  banner.className = info ? 'info' : '';
  banner.style.display = msg ? 'block' : 'none';
  banner.title = msg ? '눌러서 닫기' : '';
  bannerKind = msg ? kind : '';
  clearTimeout(bannerTimer);
  // notices go away by themselves; errors and mode prompts stay
  if (msg && info && kind !== 'sticky') bannerTimer = setTimeout(() => banner.textContent === msg && showBanner(''), 9000);
}
banner.addEventListener('click', () => showBanner('')); // errors stay until read and tapped
let toastTimer = 0;
function toast(msg, ms = 1600) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ------------------------------------------------------------------ scene + models
let scene;
try {
  scene = new StlScene($('scene'));
} catch (e) {
  console.error(e);
  const msg = 'WebGL을 쓸 수 없습니다. 하드웨어 가속이 켜진 최신 Chrome / Edge / Firefox를 사용하세요.';
  showBanner(msg);
  // the start card covers the banner and its buttons would do nothing: put the message there instead
  $('found').textContent = msg;
  document.querySelectorAll('#start button').forEach((b) => (b.disabled = true));
  throw e;
}


// settings that survive a reload (best effort: storage can be unavailable)
const UI_VERSION = 2; // bump to reset saved values whose meaning or default changed
const saved = (() => {
  try {
    const v = JSON.parse(localStorage.getItem('holohand-ui') || '{}');
    if (v.v !== UI_VERSION) delete v.sens; // older versions saved a twitchier default
    return v;
  } catch {
    return {};
  }
})();
const ui = { skeleton: true, labels: true, feed: true, handExplode: true, blur: true, holo: true, sens: 0.35, mode: 'sphere', ...saved };
function saveUi() {
  try {
    const { blur, holo, sens, mode } = ui;
    localStorage.setItem('holohand-ui', JSON.stringify({ v: UI_VERSION, blur, holo, sens, mode }));
  } catch {
    /* private mode etc. */
  }
}
scene.setHolo(ui.holo);
scene.explodeMode = ui.mode;
scene.modeBlend = ui.mode === 'sphere' ? 1 : 0;
document.body.classList.toggle('holo', ui.holo);
document.body.classList.toggle('blur', ui.blur);
const chipBox = $('chip-models');

function addModels(defs) {
  if (!defs.length) return -1;
  const start = scene.addModels(defs);
  defs.forEach((m, k) => {
    const b = document.createElement('button');
    b.textContent = m.name;
    b.dataset.i = start + k;
    b.onclick = () => switchModel(start + k);
    chipBox.appendChild(b);
  });
  return start;
}

function switchModel(i) {
  scene.setModel(i).catch((e) => {
    console.error(e);
    showBanner(e.message || String(e), false, 'model');
  });
}

scene.onLoading = (name, frac, label) => {
  $('loading').classList.toggle('show', !!name);
  if (!name) return;
  $('ld-bar').style.width = `${100 * frac}%`;
  $('ld-text').textContent = `${name} 불러오는 중… ${label}`;
};

scene.onError = (e) => showBanner(e?.message || String(e), false, 'model');
scene.onModel = (i, entry) => {
  const def = entry.def;
  if (bannerKind === 'model') showBanner(''); // an error about another model no longer applies (others stay)
  $('m-name').textContent = def.name;
  $('m-sub').textContent = def.subtitle;
  $('m-about').textContent = def.manifest?.about || '';
  $('m-count').textContent = `${entry.parts.length} 부품`;
  chipBox.querySelectorAll('button').forEach((b) => b.classList.toggle('active', +b.dataset.i === i));
  buildPartList();
  showPart(-1);
  toast(def.name);
  if (entry.failed.length) showBanner(`읽지 못한 STL ${entry.failed.length}개: ${entry.failed.join(', ')}`, true, 'model');
  maint?.onModel(i, entry);
};

const fmt = (v) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
/** Display name of a part's group ("B 계열 · 베이스"), from the model's group table. */
function groupName(p) {
  const groups = scene.entry?.def.manifest?.groups || [];
  return groups.find((g) => g.id === p?.group)?.name || '';
}
function showPart(i) {
  const p = i >= 0 ? scene.parts[i] : null;
  $('pc-name').textContent = p ? p.name : '선택된 부품 없음';
  $('pc-group').textContent = p ? groupName(p) : '';
  $('pc-alt').textContent = p?.alt || '';
  $('pc-desc').textContent = p ? p.desc || '' : '부품을 가리키거나 클릭하세요.';
  $('pc-meta').textContent = p
    ? [`파일  ${p.file}`, `크기  ${fmt(p.size.x)} × ${fmt(p.size.y)} × ${fmt(p.size.z)} mm`, `삼각형  ${p.tris.toLocaleString()}`].join('\n')
    : '';
  $('pc-dot').style.background = p ? p.color : '#555a70';
  const mi = p && maint ? maint.partInfo(i) : null; // health line in maintenance mode
  $('pc-maint').textContent = mi ? mi.text : '';
  $('pc-maint').style.color = mi ? mi.color : '';
  $('pc-btns').classList.toggle('show', !!p && i === scene.sel);
  $('pc-iso').classList.toggle('on', scene.isolate);
  $('plist').querySelectorAll('li').forEach((li) => li.classList.toggle('sel', +li.dataset.i === scene.sel));
}
function select(i) {
  scene.setSel(i);
  if (i < 0) scene.isolate = false;
  showPart(i);
  const li = $('plist').querySelector(`li[data-i="${i}"]`);
  li?.scrollIntoView({ block: 'nearest' });
}

function buildPartList() {
  const ul = $('plist');
  ul.innerHTML = '';
  // grouped by series (B / Y / H / L, common Pod / helmet specific), in the order of the group table
  const g0 = scene.entry?.def.manifest?.groups;
  const groups = Array.isArray(g0) ? g0.filter((g) => g && typeof g === 'object') : [];
  const order = (p) => {
    const k = groups.findIndex((g) => g.id === p.group);
    return k < 0 ? groups.length : k;
  };
  const sorted = [...scene.parts].sort((a, b) => order(a) - order(b) || String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
  let lastGroup = null;
  for (const p of sorted) {
    if (groups.length && p.group !== lastGroup) {
      lastGroup = p.group;
      const h = document.createElement('li');
      h.className = 'grp';
      h.textContent = groupName(p) || '기타';
      ul.appendChild(h);
    }
    const li = document.createElement('li');
    li.dataset.i = p.i;
    li.className = p.visible ? '' : 'off';
    li.innerHTML = '<i></i><span></span><button title="보이기 / 숨기기">👁</button>';
    li.querySelector('i').style.background = p.color;
    li.querySelector('span').textContent = p.name;
    li.querySelector('button').onclick = (e) => {
      e.stopPropagation();
      setPartVisible(p.i, !p.visible);
    };
    li.onclick = () => select(scene.sel === p.i ? -1 : p.i);
    li.onmouseenter = () => scene.setHover(p.i);
    li.onmouseleave = () => scene.setHover(-1);
    ul.appendChild(li);
  }
}
function setPartVisible(i, v) {
  scene.setVisible(i, v);
  $('plist').querySelector(`li[data-i="${i}"]`)?.classList.toggle('off', !v);
  if (!v && scene.sel === i) select(-1);
}

$('pl-all').onclick = () => scene.parts.forEach((p) => setPartVisible(p.i, true));
$('pc-hide').onclick = () => scene.sel >= 0 && setPartVisible(scene.sel, false);
$('pc-iso').onclick = () => {
  scene.isolate = !scene.isolate;
  showPart(scene.sel);
};
$('pc-home').onclick = () => {
  const p = scene.parts[scene.sel];
  if (p) {
    p.offsetT.set(0, 0, 0);
    p.qT.identity();
  }
};

const rExplode = $('r-explode');
const rInt = $('r-int');
let draggingExplode = false;
rExplode.addEventListener('pointerdown', () => (draggingExplode = true));
addEventListener('pointerup', () => (draggingExplode = false));
rExplode.addEventListener('input', () => (scene.explodeTarget = rExplode.value / 100));
rInt.addEventListener('input', () => {
  scene.intensity = rInt.value / 100;
  $('v-int').textContent = rInt.value + '%';
});

function toggleBtn(id, get, set) {
  $(id).onclick = () => {
    set(!get());
    $(id).classList.toggle('on', get());
  };
}
$('b-explode').onclick = () => (scene.explodeTarget = scene.explodeTarget > 0.5 ? 0 : 1);
toggleBtn('b-handx', () => ui.handExplode, (v) => (ui.handExplode = v));
toggleBtn('b-xray', () => scene.xray, (v) => (scene.xray = v));
toggleBtn('b-spin', () => scene.autoSpin, (v) => (scene.autoSpin = v));
const modeLabel = () => ($('b-mode').textContent = ui.mode === 'sphere' ? '전개: 구형' : '전개: 정렬');
modeLabel();
$('b-mode').onclick = () => {
  ui.mode = ui.mode === 'sphere' ? 'tuned' : 'sphere';
  scene.explodeMode = ui.mode;
  modeLabel();
  saveUi();
  toast(ui.mode === 'sphere' ? '구형 전개: 중심에서 멀수록 멀리' : '정렬 전개: 부품이 겹치지 않게');
};

// hand sensitivity: 0.2 (calm) .. 1.5 (twitchy)
const rSens = $('r-sens');
function setSens(v) {
  ui.sens = v;
  engine.sens = v;
  rSens.value = Math.round(v * 100);
  $('v-sens').textContent = Math.round(v * 100) + '%';
}
rSens.addEventListener('input', () => {
  setSens(rSens.value / 100);
  saveUi();
});
$('b-parts').onclick = () => scene.resetParts();
$('b-reset').onclick = () => {
  scene.resetView();
  select(-1);
};

toggleBtn('t-feed', () => ui.feed, (v) => {
  ui.feed = v;
  document.body.classList.toggle('feed', v && camOn);
});
toggleBtn('t-skel', () => ui.skeleton, (v) => (ui.skeleton = v));
toggleBtn('t-labels', () => ui.labels, (v) => (ui.labels = v));
toggleBtn('t-edges', () => scene.edges, (v) => (scene.edges = v));
toggleBtn('t-holo', () => ui.holo, (v) => {
  ui.holo = v;
  scene.setHolo(v);
  document.body.classList.toggle('holo', v);
  buildPartList();
  showPart(scene.sel);
  saveUi();
});
toggleBtn('t-blur', () => ui.blur, (v) => {
  ui.blur = v;
  document.body.classList.toggle('blur', v);
  saveUi();
});
$('t-holo').classList.toggle('on', ui.holo);
$('t-blur').classList.toggle('on', ui.blur);
$('t-full').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.());

// local folders: picker + drag & drop
async function openLocal(source) {
  const defs = await localModels(source);
  const bytes = defs.reduce((n, m) => n + m.parts.reduce((k, x) => k + x.blob.size, 0), 0);
  if (bytes > 300e6 && !confirm(`STL ${Math.round(bytes / 1e6)} MB — 원본 그대로는 브라우저가 멈출 수 있습니다. web/models 의 경량 STL을 권장합니다. 계속할까요?`)) return;
  if (!defs.length) {
    showBanner('STL 파일을 찾지 못했습니다.', true);
    return;
  }
  // a folder opened again (same name) replaces its model instead of adding a duplicate chip
  let start = -1;
  for (const def of defs) {
    const i = def.folder ? scene.models.findIndex((m) => !m.key && m.folder === def.folder) : -1;
    let k = i;
    if (i >= 0) {
      scene.replaceModel(i, def);
      const chip = chipBox.querySelector(`button[data-i="${i}"]`);
      if (chip) chip.textContent = def.name; // its parts.json may name it differently now
    } else k = addModels([def]);
    if (start < 0) start = k;
  }
  $('start').classList.add('gone');
  if (!camOn) enterMouseMode('');
  switchModel(start);
}
$('b-open').onclick = () => $('f-dir').click();
const openFailed = (e) => {
  console.error(e);
  showBanner(`폴더를 읽지 못했습니다: ${e?.message || e}`);
};
$('f-dir').onchange = (e) => {
  openLocal([...e.target.files]).catch(openFailed);
  e.target.value = '';
};
let dragDepth = 0;
addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  $('drop').classList.add('show');
});
addEventListener('dragleave', () => {
  if (--dragDepth <= 0) $('drop').classList.remove('show'), (dragDepth = 0);
});
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').classList.remove('show');
  openLocal(e.dataTransfer).catch(openFailed);
});

// models committed to the repo (Turret/, hailo/, ...)
const found = repoModels();
addModels(found);
$('found').innerHTML = found.length
  ? '찾은 모델: ' + found.map((m) => `<b>${m.name}</b> (${m.parts.length} STL)`).join(', ')
  : '내장 모델이 없습니다. <b>python3 tools/build_models.py</b> 로 web/models 를 만들거나, 실행 후 STL 폴더를 화면에 끌어다 놓으세요.';
if (found.length) switchModel(0);

// ------------------------------------------------------------------ camera + tracking
const tracker = new HandTracker();
const engine = new GestureEngine();
setSens(clamp(+ui.sens || 0.35, 0.2, 1.5));

// AI maintenance mode (src/maint.js): panel, defect markers, repair loop
maint = new Maint({
  scene,
  ui,
  toast,
  select,
  showPart,
  switchModel,
  setActive,
  banner: (msg, info, kind) => showBanner(msg, info, kind),
  insets,
  relayout,
  setPartVisible,
  dwellTime: () => dwellTime(),
});
// a clicked button outside the panel gives the keyboard back, so Enter / M / N never re-click it
addEventListener('click', (e) => e.target.closest?.('#start button, #chips button, #toolbar button, #panel button, #dg-open, #b-panel')?.blur());
relayout();

// for debugging in the browser console (dev server only)
if (import.meta.env.DEV) Object.assign(window, { __scene: scene, __tracker: tracker, __engine: engine, __ui: ui, __maint: maint });
let camOn = false;
let lastVideoTime = -1;
let perc = { hands: [] };

let cameraStarting = false; // the getUserMedia phase only (the hand-model download may still be running)
let trackerInit = null;
async function startCamera() {
  if (cameraStarting || camOn) return;
  await startCameraNow();
}
async function startCameraNow() {
  $('start').classList.add('gone');
  setTracking('시작 중…', 'warn');
  if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
    enterMouseMode('카메라는 http://localhost 또는 https 에서만 동작합니다.');
    return;
  }
  cameraStarting = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false });
    video.srcObject = stream;
    await video.play();
    camOn = true;
    // unplugged, privacy switch, another app took it: drop the hands it last saw, offer a restart
    for (const tr of stream.getVideoTracks()) tr.addEventListener('ended', cameraLost);
    cameraStarting = false;
    ui.feed = true;
    $('t-feed').classList.add('on');
    document.body.classList.add('feed');
  } catch (e) {
    console.warn(e);
    const why = {
      NotAllowedError: '카메라 권한이 거부되었습니다. 주소창에서 허용한 뒤 다시 시도하세요.',
      NotReadableError: '카메라를 다른 앱이 쓰고 있습니다. 그 앱을 닫고 왼쪽 「손 인식」을 눌러 다시 시도하세요.',
      AbortError: '카메라를 다른 앱이 쓰고 있습니다. 그 앱을 닫고 왼쪽 「손 인식」을 눌러 다시 시도하세요.',
      SecurityError: '이 페이지에서는 카메라 사용이 막혀 있습니다.',
    }[e?.name] || '카메라를 찾지 못했습니다.';
    cameraStarting = false;
    enterMouseMode(why);
    return;
  }
  setTracking('손 모델 로딩…', 'warn');
  try {
    // one download, shared by a restart that happens while it runs; a restart later keeps the loaded model
    if (!tracker.ready) await (trackerInit ??= tracker.init().finally(() => (trackerInit = null)));
    if (!camOn) return; // the camera went away during the download: keep the 카메라 끊김 state and notice
    setTracking('켜짐', 'ok');
    showBanner('');
  } catch (e) {
    console.error(e);
    setTracking('마우스만', 'warn');
    showBanner('손 인식 모델을 불러오지 못했습니다(처음 한 번은 인터넷 필요). 마우스 조작은 계속 됩니다.');
  }
}

function enterMouseMode(msg) {
  setTracking('마우스만', 'warn');
  if (msg) showBanner(msg + ' 마우스 조작으로 전환합니다.', true);
}
function cameraLost() {
  if (!camOn) return;
  camOn = false;
  perc = { hands: [] };
  engine.reset();
  ui.feed = false;
  $('t-feed').classList.remove('on');
  document.body.classList.remove('feed');
  setTracking('카메라 끊김', 'warn');
  showBanner('카메라 연결이 끊겼습니다. 왼쪽 「손 인식」을 눌러 다시 시작할 수 있습니다. 마우스 조작은 계속 됩니다.', true);
}
// the tracking status doubles as a (re)start button while the camera is off
$('s-track').addEventListener('click', () => {
  if (!camOn) startCamera();
});

function setTracking(text, cls) {
  const el = $('s-track');
  el.textContent = text;
  el.className = cls || '';
}

$('btn-cam').onclick = startCamera;
// AI 정비 demo: camera when possible (falls back to the mouse by itself), then maintenance mode
$('btn-maint').onclick = () => {
  startCamera();
  maint.toggle(true);
};
if (location.hash === '#maint') $('btn-maint').click(); // kiosk link
$('btn-mouse').onclick = () => {
  $('start').classList.add('gone');
  enterMouseMode('');
};

/** raw camera landmark -> viewport 0..1 (mirrored, matches object-fit: cover) */
function mapPoint(p) {
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const s = Math.max(W / vw, H / vh);
  const ox = (W - vw * s) / 2, oy = (H - vh * s) / 2;
  return { x: ((1 - p.x) * vw * s + ox) / W, y: (p.y * vh * s + oy) / H };
}

// ------------------------------------------------------------------ gesture -> action
let zoomRef = null;
let grab = null;
let lastHover = { i: -1, t: 0 };
let dwell = { i: -1, t: 0 };
let peaceCool = 0;
let fistT = 0;
let handExplode = null; // smoothed hand-driven explode target
const prevPalm = new Map();
const calmPalm = new Map(); // extra smoothing of the palm, stronger at low sensitivity
const calmRoll = new Map(); // wrist twist averaged over a few frames: shake cancels out, a real twist stays
// ignore wrist twists slower than this (rad / frame): landmark shake of ~3 px reads as ~0.01-0.015 rad
// after smoothing, a deliberate twist is ~0.05 rad
const dead = () => 0.006 + 0.016 * (1.5 - ui.sens);
const dwellTime = () => 0.6 + Math.max(0, 1 - ui.sens) * 0.6;
// rotation by hand gets its own gain on top of the sensitivity, so it can be livelier than the rest
const ROT_GAIN = 2.2; // hand move -> yaw / pitch
const ROLL_GAIN = 1.5; // wrist twist -> roll
const WARMUP = 0.4; // s: a hand that just came into view is ignored while its tracking settles...
const WARMUP_FRAMES = 8; // ...and for at least this many tracking frames
const STILL = 110; // px/s: the explode only follows the hand while the palm is about this still
const handSince = new Map(); // hand id -> { t: time it appeared, n: tracking frames since }
let lastPerc = null;
const palmSpeed = new Map(); // hand id -> smoothed palm speed (px/s)
const prevRaw = new Map(); // hand id -> last palm position before the extra smoothing (for the speed)
let lastGesture = '';
let activeKey = '';

function setActive(key) {
  if (key === activeKey) return;
  activeKey = key;
  document.querySelectorAll('#gest li').forEach((li) => li.classList.toggle('active', li.dataset.g === key));
}

function endGrab() {
  grab = null;
  scene.grabbed = -1;
}

function control(t, dt) {
  const live = perc.hands.filter((h) => !h.held);
  $('s-hands').textContent = String(live.length);
  // a hand the engine holds through a missed tracking frame keeps its warm-up and its grab
  for (const id of [...handSince.keys()]) if (!perc.hands.some((h) => h.id === id)) handSince.delete(id);
  if (!live.length && perc.hands.length) return;
  const fresh = perc !== lastPerc; // a new tracking result arrived this frame
  lastPerc = perc;
  for (const h of live) {
    if (!handSince.has(h.id)) handSince.set(h.id, { t, n: 0 });
    if (fresh) handSince.get(h.id).n++;
  }
  const settled = live.filter((h) => t - handSince.get(h.id).t >= WARMUP && handSince.get(h.id).n >= WARMUP_FRAMES);

  // two hands: distance between palms = zoom
  if (settled.length >= 2) {
    const a = live[0].palm, b = live[1].palm;
    const dist = Math.hypot((a.x - b.x) * W, (a.y - b.y) * H);
    if (!zoomRef) zoomRef = { d0: Math.max(60, dist), s0: scene.scaleTarget };
    const ratio = dist / zoomRef.d0;
    // small changes in hand distance are ignored, the rest is softened by the sensitivity
    if (Math.abs(ratio - 1) > 0.05 * (1.6 - ui.sens)) scene.scaleTarget = clamp(zoomRef.s0 * Math.pow(ratio, 0.55 + 0.45 * ui.sens), 0.3, scene.maxScale);
    scene.holdVel = true;
    scene.idle = 0;
    endGrab();
    scene.setHover(-1);
    maint.pointEnd();
    prevPalm.clear();
    setActive('TWO');
    return;
  }
  zoomRef = null;

  const h = live.length === 1 ? settled[0] : null; // one hand only (a second, unsettled hand pauses control)
  if (!h) {
    endGrab();
    scene.holdVel = draggingMouse;
    prevPalm.clear();
    calmPalm.clear();
    calmRoll.clear();
    palmSpeed.clear();
    prevRaw.clear();
    handExplode = null;
    fistT = 0;
    lastGesture = '';
    maint.pointEnd();
    setActive('');
    return;
  }

  scene.holdVel = true;
  scene.idle = 0;
  const g = h.gesture;
  const raw = { x: h.palm.x * W, y: h.palm.y * H };
  const prevCalm = calmPalm.get(h.id) || raw;
  const a = clamp(0.15 + 0.45 * ui.sens, 0.15, 0.85);
  const palmPx = { x: prevCalm.x + (raw.x - prevCalm.x) * a, y: prevCalm.y + (raw.y - prevCalm.y) * a };
  calmPalm.set(h.id, palmPx);
  const keep = 0.45 + 0.35 * clamp(1 - ui.sens, 0, 1);
  const roll = (calmRoll.get(h.id) || 0) * keep + h.rollDelta * (1 - keep);
  calmRoll.set(h.id, roll);
  const twist = Math.abs(roll) > dead() ? roll : 0;
  fistT = g === 'FIST' ? fistT + dt : 0;
  // a gesture change makes the palm centre jump; start measuring movement afresh
  if (g !== lastGesture) prevPalm.delete(h.id);
  if (g !== 'POINT') maint.pointEnd();
  lastGesture = g;
  const prev = prevPalm.get(h.id);
  const step = prev ? Math.hypot(palmPx.x - prev.x, palmPx.y - prev.y) : 0;
  // palm speed, measured before the extra smoothing so a move is noticed at once:
  // rises fast when the hand starts moving, falls slowly after it stops
  const pr = prevRaw.get(h.id);
  prevRaw.set(h.id, raw);
  const rawStep = pr && prev ? Math.hypot(raw.x - pr.x, raw.y - pr.y) : 0;
  const inst = rawStep / Math.max(dt, 1e-3), was = palmSpeed.get(h.id) ?? 0;
  const speed = inst > was ? was * 0.4 + inst * 0.6 : was * 0.85 + inst * 0.15;
  palmSpeed.set(h.id, speed);

  if (g === 'NONE') {
    // a relaxed or half-open hand does nothing, so a hand that is just in view doesn't move the model
    scene.setHover(-1);
    setActive('');
  } else if (g === 'OPEN' || g === 'FIST') {
    // openness drives the explosion
    if (g === 'FIST') {
      scene.explodeTarget = 0;
      handExplode = 0;
    } else if (ui.handExplode && !maint.on) {
      // (in maintenance mode the open hand only turns the model: the palm is the presenter's resting pose)
      const want = clamp((h.openness - 0.12) / 0.78, 0, 1);
      if (handExplode === null) handExplode = scene.explodeTarget;
      // follow the hand slowly, only while the palm is held still (not while it rotates the model),
      // and not at all for tiny finger movements
      if (speed < STILL && Math.abs(want - handExplode) > 0.05 * (1.6 - ui.sens)) handExplode += (want - handExplode) * (1 - Math.exp(-(1 + 3 * ui.sens) * dt));
      scene.explodeTarget = handExplode;
    }
    // a held fist also brings moved parts home (maintenance: also releases the focus and the procedure)
    if (fistT > 0.6 && maint.on) {
      const r = maint.release();
      if (r) toast(r === 'add' ? '결함 추가 취소' : '초점 해제');
      fistT = -1e9; // once per fist
    } else if (fistT > 0.6 && scene.movedParts) {
      scene.resetParts();
      toast('부품 원위치');
    }
    // moving the open hand rotates the model. The dead zone is a palm speed (px/s, so it does not
    // depend on the frame rate) and is subtracted, so there is no jump at its edge.
    if (g === 'OPEN' && prev && step > 0) {
      const dz = 30 + (1.5 - ui.sens) * 40;
      if (speed > dz) {
        maint.noteInput();
        const k = (1 - dz / speed) * ui.sens * ROT_GAIN;
        scene.rotateBy((palmPx.x - prev.x) * k * 0.0048, (palmPx.y - prev.y) * k * 0.0032, dt);
      }
      if (twist) scene.rollBy(twist * 0.7 * ui.sens * ROLL_GAIN);
    }
    scene.setHover(-1);
    setActive(g === 'OPEN' && speed > STILL ? 'MOVE' : g);
  } else {
    const tx = h.tip.x * W, ty = h.tip.y * H;
    // maintenance: the fingertip over a panel air-clicks its buttons; over the scene it targets defect badges first
    const overUi = maint.on && g === 'POINT' ? document.elementFromPoint(tx, ty)?.closest('#panel,#diag,#chips,#toolbar,.mt-float') : null;
    if (g === 'POINT' && overUi) {
      maint.airPoint(document.elementFromPoint(tx, ty), tx, ty, dt);
      scene.setHover(-1);
      dwell = { i: -1, t: 0 };
    } else if (g === 'POINT' && maint.on && (maint.airPoint(null, tx, ty, dt), maint.pointBadge(tx, ty, dt) || scene.focused)) {
      // a badge is targeted (dwell selects it), or a defect is focused (the other parts are ghosted): no part picking
      scene.setHover(-1);
      dwell = { i: -1, t: 0 };
    } else if (g === 'POINT') {
      const idx = scene.pick(h.tip.x * W, h.tip.y * H, 95);
      scene.setHover(idx);
      if (idx >= 0) {
        lastHover = { i: idx, t };
        if (scene.sel < 0 || idx === scene.sel) showPart(idx);
      }
      if (idx >= 0 && idx === dwell.i) {
        dwell.t += dt;
        if (dwell.t > dwellTime() && scene.sel !== idx) select(idx);
      } else dwell = { i: idx, t: 0 };
    } else if (g === 'PINCH' && maint.on && scene.proc) {
      // parts follow the repair procedure: no grabbing meanwhile
    } else if (g === 'PINCH') {
      const pp = { x: h.pinchPt.x * W, y: h.pinchPt.y * H };
      if (!grab) {
        let idx = scene.pick(pp.x, pp.y, 170);
        if (idx < 0 && t - lastHover.t < 0.9) idx = lastHover.i;
        if (idx >= 0) {
          grab = { part: idx, last: pp };
          scene.grabbed = idx;
          select(idx);
          scene.setHover(idx);
        }
      } else {
        const k = 0.5 + 0.5 * Math.min(1, ui.sens);
        scene.dragPart(grab.part, (pp.x - grab.last.x) * k, (pp.y - grab.last.y) * k);
        if (twist) scene.twistPart(grab.part, twist * ui.sens);
        grab.last = pp;
      }
    } else if (g === 'PEACE') {
      if (t > peaceCool) {
        peaceCool = t + 1.6;
        if (maint.on) maint.cta(); // the panel's "next action" (never submits a form)
        else scene.next();
      }
    }
    setActive(g);
  }
  if (g !== 'PINCH') endGrab();
  prevPalm.set(h.id, palmPx);
}

// ------------------------------------------------------------------ mouse + keyboard
let draggingMouse = false;
let mouseStart = null;
let mouseLast = null;
let mousePart = null; // { i, mode: 'move' | 'spin' }
const onUi = (e) => e.target.closest?.('#panel,#chips,#toolbar,#start,#diag,#dg-open,.mt-float,#b-panel,#banner');

// touch: one finger drags (rotate), two fingers pinch (zoom); every other pointer id is ignored
const touches = new Map(); // pointerId -> { x, y }
let dragId = null;
let pinchDist = 0;
const touchSpan = () => {
  const [a, b] = [...touches.values()];
  return Math.hypot(a.x - b.x, a.y - b.y);
};
addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || onUi(e)) return;
  if (e.pointerType === 'touch') {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) {
      pinchDist = touchSpan(); // the second finger turns the drag into a pinch
      mousePart = null;
      scene.grabbed = -1;
      return;
    }
    if (touches.size > 2) return;
  }
  if (draggingMouse) return; // a drag already runs (another pointer)
  dragId = e.pointerId;
  draggingMouse = true;
  mouseStart = mouseLast = { x: e.clientX, y: e.clientY };
  mousePart = null;
  if (e.shiftKey || e.altKey || e.ctrlKey) {
    const i = scene.pick(e.clientX, e.clientY, 40);
    if (i >= 0) {
      mousePart = { i, mode: e.shiftKey ? 'move' : 'spin' };
      scene.grabbed = i;
      select(i);
    }
  }
});
addEventListener('pointermove', (e) => {
  if (touches.has(e.pointerId)) {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size >= 2) {
      const d = touchSpan();
      if (pinchDist > 0 && d > 0) scene.zoomBy(d / pinchDist);
      pinchDist = d;
      scene.holdVel = true;
      maint.noteInput();
      return;
    }
  }
  if (draggingMouse && e.pointerId !== dragId) return;
  if (!draggingMouse) {
    if (onUi(e) || perc.hands.some((h) => !h.held)) return;
    // maintenance: a defect badge / callout under the mouse wins over the part under it
    if (maint.hover(e.clientX, e.clientY)) scene.setHover(-1);
    else scene.setHover(scene.pick(e.clientX, e.clientY, 0));
    return;
  }
  maint.noteInput();
  const dx = e.clientX - mouseLast.x, dy = e.clientY - mouseLast.y;
  if (mousePart?.mode === 'move') scene.dragPart(mousePart.i, dx, dy);
  else if (mousePart) scene.spinPart(mousePart.i, dx, dy);
  else {
    scene.holdVel = true;
    scene.rotateBy(dx * 0.006, dy * 0.004, 1 / 60);
  }
  mouseLast = { x: e.clientX, y: e.clientY };
});
function endTouch(e) {
  const pinched = touches.size >= 2;
  touches.delete(e.pointerId);
  if (touches.size < 2) pinchDist = 0;
  if (pinched && touches.size === 1 && draggingMouse) {
    // back to one finger: carry on from where it is now (no jump), and it is no longer a tap
    const [only] = touches.values();
    mouseLast = { ...only };
    mouseStart = { x: -1e4, y: -1e4 };
  }
}
function pointerCancel(e) {
  endTouch(e);
  if (!draggingMouse || e.pointerId !== dragId) return;
  draggingMouse = false;
  scene.holdVel = false;
  scene.grabbed = -1;
  mousePart = null;
}
addEventListener('pointercancel', pointerCancel);
addEventListener('pointerup', (e) => {
  const wasPinch = touches.size >= 2;
  endTouch(e);
  if (!draggingMouse || e.pointerId !== dragId) return;
  if (wasPinch || touches.size) {
    // the drag finger lifted out of a pinch: end without a click or a fling
    draggingMouse = false;
    scene.holdVel = false;
    mousePart = null;
    return;
  }
  draggingMouse = false;
  scene.holdVel = false;
  scene.grabbed = -1;
  if (!mousePart && Math.hypot(e.clientX - mouseStart.x, e.clientY - mouseStart.y) < 5) {
    if (maint.click(e.clientX, e.clientY)) {
      mousePart = null;
      return;
    }
    const idx = scene.pick(e.clientX, e.clientY, 0);
    // in maintenance mode a click on empty space keeps the selected defect
    if (!(maint.on && idx < 0)) select(idx === scene.sel ? -1 : idx);
  }
  mousePart = null;
});
addEventListener(
  'wheel',
  (e) => {
    if (onUi(e)) return;
    if (e.ctrlKey) e.preventDefault(); // a trackpad pinch over the model: zoom the model, never the whole page
    const pinch = e.ctrlKey && e.deltaMode === 0 && Math.abs(e.deltaY) < 50; // a mouse notch is ~100
    scene.zoomBy(Math.exp(-e.deltaY * (pinch ? 0.01 : 0.0012)));
  },
  { passive: false },
);
const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
addEventListener('keydown', (e) => {
  // typing in a form field never triggers shortcuts; a focused range slider keeps only its arrow keys
  const tg = e.target;
  if (tg.isContentEditable || tg.tagName === 'TEXTAREA' || tg.tagName === 'SELECT') return;
  if (tg.tagName === 'INPUT' && (tg.type !== 'range' || ARROWS.includes(e.key))) return;
  // browser / OS combos (Ctrl+C, Cmd+H, Ctrl+2) are not ours; holding a toggle key must not flicker it
  // ([ and ] need AltGr / Option on many layouts: a typed symbol is not a combo)
  const symbol = e.key.length === 1 && /[[\]{}\\|;:'",.<>/?`~!@#$%^&*()\-_=+]/.test(e.key);
  if ((e.ctrlKey || e.metaKey || e.altKey) && !symbol) return;
  if (e.repeat && !(['ArrowLeft', 'ArrowRight', '[', ']'].includes(e.key) || e.code === 'KeyN')) return;
  if (maint.onKey(e)) return;
  // letters: as typed on Latin layouts (QWERTY, Dvorak, …), by position otherwise (Korean jamo etc.)
  const k = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
  const digit = /^Digit[1-9]$/.test(e.code) ? +e.code.slice(5) : e.key >= '1' && e.key <= '9' ? +e.key : 0;
  if (e.key === ' ') {
    e.preventDefault();
    scene.explodeTarget = scene.explodeTarget > 0.5 ? 0 : 1;
  } else if (e.key === 'ArrowRight') scene.next(1);
  else if (e.key === 'ArrowLeft') scene.next(-1);
  else if (k === 'r') {
    scene.resetView();
    select(-1);
  } else if (k === 'p') scene.resetParts();
  else if (k === 'x') $('b-xray').click();
  else if (k === 'e') $('t-edges').click();
  else if (k === 'i' && scene.sel >= 0 && !maint.on) $('pc-iso').click();
  else if (k === 'h' && scene.sel >= 0 && !maint.on) setPartVisible(scene.sel, false); // maintenance keeps every part shown
  else if (k === 'escape') select(-1);
  else if (digit && digit <= scene.models.length) switchModel(digit - 1);
});

// ------------------------------------------------------------------ overlay drawing
const ringR = new Map();

function drawHand(h) {
  const pts = h.lm.map((p) => ({ x: p.x * W, y: p.y * H }));
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(190, 245, 255, 0.8)';
  ctx.shadowColor = 'rgba(80, 220, 255, 0.95)';
  ctx.shadowBlur = 8;
  ctx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    ctx.moveTo(pts[a].x, pts[a].y);
    ctx.lineTo(pts[b].x, pts[b].y);
  }
  ctx.stroke();
  ctx.fillStyle = '#fff';
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawRing(h) {
  const pts = h.lm;
  const cx = h.palm.x * W, cy = h.palm.y * H;
  const g = h.gesture;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(80, 220, 255, 0.9)';
  ctx.shadowBlur = 14;
  if (g === 'POINT') {
    const x = h.tip.x * W, y = h.tip.y * H;
    ctx.strokeStyle = maint.on ? '#bff6ff' : '#ffb547';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(x, y, 20, 0, Math.PI * 2);
    ctx.stroke();
    // dwell progress towards selecting the part (or, in maintenance mode, a defect badge / panel button)
    const mp = maint.ringProgress();
    const prog = mp != null ? mp : dwell.i >= 0 && dwell.i !== scene.sel ? clamp(dwell.t / dwellTime(), 0, 1) : null;
    if (prog != null) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.arc(x, y, 20, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * prog);
      ctx.stroke();
    }
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  } else if (g === 'PINCH') {
    const x = h.pinchPt.x * W, y = h.pinchPt.y * H;
    ctx.strokeStyle = '#ffb547';
    ctx.fillStyle = grab ? 'rgba(255, 181, 71, 0.55)' : 'rgba(255, 181, 71, 0.25)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else {
    const len = Math.hypot((pts[0].x - pts[12].x) * W, (pts[0].y - pts[12].y) * H);
    const target = len * 0.95 + 22;
    const r = (ringR.get(h.id) ?? target) * 0.85 + target * 0.15;
    ringR.set(h.id, r);
    ctx.strokeStyle = 'rgba(95, 228, 255, 0.95)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    // white arc = how far it is exploded
    const e = clamp(scene.explode, 0, 1);
    if (e > 0.01) {
      ctx.shadowColor = 'rgba(255,255,255,0.9)';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 4.5;
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * e);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawZoom(a, b) {
  const x1 = a.palm.x * W, y1 = a.palm.y * H, x2 = b.palm.x * W, y2 = b.palm.y * H;
  ctx.save();
  ctx.strokeStyle = 'rgba(95, 228, 255, 0.85)';
  ctx.setLineDash([6, 6]);
  ctx.lineWidth = 2;
  ctx.shadowColor = 'rgba(80, 220, 255, 0.8)';
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#fff';
  ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.shadowBlur = 6;
  ctx.fillText(`zoom ${scene.scale.toFixed(2)}x`, (x1 + x2) / 2, (y1 + y2) / 2 - 12);
  ctx.restore();
}

const MAX_LABELS = 24; // with more parts only the hovered / selected one is labelled
const LABEL_FONT = (hot) => `${hot ? 600 : 500} ${hot ? 13 : 12}px ui-sans-serif, system-ui, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;
function drawLabels() {
  if (!scene.entry || scene.pending >= 0 || scene.pop < 0.6) return;
  const e = clamp((scene.shownExplode - 0.1) / 0.3, 0, 1);
  let pts = scene.labelPoints();
  const hotOnly = e <= 0.01 || pts.length > MAX_LABELS || maint.on;
  if (hotOnly) pts = pts.filter((p) => p.i === scene.hover || p.i === scene.sel);
  if (!pts.length) return;
  const c = scene.centerScreen();
  const panelR = W > 900 ? insets.l + 10 : document.body.classList.contains('panel-hide') ? 0 : 252; // 232 px panel when open
  const rightEdge = W - insets.r;
  const left = [], right = [];
  for (const p of pts) (p.x < c.x ? left : right).push(p);
  const maxX = Math.max(...pts.map((p) => p.x), c.x);
  const minX = Math.min(...pts.map((p) => p.x), c.x);
  // keep whole names on screen: columns are placed by the widest label on each side
  ctx.font = LABEL_FONT(true);
  const textW = (list) => Math.max(0, ...list.map((p) => ctx.measureText(p.name).width)) + 12;
  const colR = clamp(maxX + 80, panelR + 360, rightEdge - 16 - textW(right));
  const loL = panelR + 16 + textW(left), hiL = rightEdge - 400;
  // narrow screen: no room for both columns beside the model, keep the left one left of the centre
  const colL = hiL < loL ? Math.max(16 + textW(left), Math.min(minX - 80, c.x - 40)) : clamp(minX - 80, loL, hiL);
  ctx.save();
  ctx.globalAlpha = hotOnly ? 1 : e;
  ctx.textBaseline = 'middle';
  const place = (list, colX, dir) => {
    list.sort((a, b) => a.y - b.y);
    const ys = list.map((p) => p.y);
    for (let i = 1; i < ys.length; i++) if (ys[i] < ys[i - 1] + 20) ys[i] = ys[i - 1] + 20;
    const over = ys.length ? ys[ys.length - 1] - (H - 90) : 0;
    if (over > 0) for (let i = 0; i < ys.length; i++) ys[i] -= over;
    list.forEach((p, k) => {
      const hot = p.i === scene.hover || p.i === scene.sel;
      const ly = clamp(ys[k], 24, H - 24);
      ctx.strokeStyle = hot ? '#ffb547' : ui.holo ? 'rgba(120,230,255,0.45)' : 'rgba(255,255,255,0.38)';
      ctx.lineWidth = hot ? 1.6 : 1;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(colX - dir * 16, ly);
      ctx.lineTo(colX, ly);
      ctx.stroke();
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, hot ? 4 : 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = hot ? '#fff' : ui.holo ? 'rgba(190,245,255,0.9)' : 'rgba(255,255,255,0.82)';
      ctx.font = LABEL_FONT(hot);
      ctx.textAlign = dir > 0 ? 'left' : 'right';
      ctx.fillText(p.name, colX + dir * 6, ly);
    });
  };
  place(right, colR, 1);
  place(left, colL, -1);
  ctx.restore();
}

/** Hands cut sharp out of the camera image; the rest of the page shows the blurred <video>. */
function drawSharpHands(live) {
  if (!camOn || !ui.feed || !ui.blur || !live.length || video.readyState < 2) return;
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  mctx.setTransform(MASK_SCALE, 0, 0, MASK_SCALE, 0, 0);
  mctx.filter = `blur(${Math.max(1, 14 * MASK_SCALE)}px)`; // feathered edge
  mctx.fillStyle = mctx.strokeStyle = '#fff';
  mctx.lineCap = mctx.lineJoin = 'round';
  for (const h of live) {
    const pts = h.lm.map((p) => ({ x: p.x * W, y: p.y * H }));
    const size = Math.hypot(pts[0].x - pts[9].x, pts[0].y - pts[9].y);
    mctx.lineWidth = size * 0.62;
    mctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      mctx.moveTo(pts[a].x, pts[a].y);
      mctx.lineTo(pts[b].x, pts[b].y);
    }
    mctx.stroke();
    mctx.beginPath();
    for (const k of [0, 1, 2, 5, 9, 13, 17]) mctx.lineTo(pts[k].x, pts[k].y);
    mctx.closePath();
    mctx.fill();
  }
  mctx.filter = 'none';
  // the same mirrored "cover" placement as the <video> element (see mapPoint)
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const sc = Math.max(W / vw, H / vh);
  bctx.save();
  bctx.translate(W, 0);
  bctx.scale(-1, 1);
  bctx.filter = 'brightness(1.05) saturate(0.9)';
  bctx.drawImage(video, (W - vw * sc) / 2, (H - vh * sc) / 2, vw * sc, vh * sc);
  bctx.restore();
  bctx.save();
  bctx.globalCompositeOperation = 'destination-in';
  bctx.drawImage(maskCanvas, 0, 0, W, H);
  bctx.restore();
}

/** Rotating HUD rings around the model (hologram look). */
function drawHud(t) {
  const h = scene.hud();
  if (!h || scene.pop < 0.3 || scene.pending >= 0) return;
  const r = clamp(h.r * 1.06, 80, Math.min(W, H) * 0.37); // grows with the sphere; outer arcs (x1.18) stay on screen
  const cyan = (a) => `rgba(95, 228, 255, ${a})`;
  // maintenance: a reticle around the focused defect instead of the rings, else readiness-coloured rings
  const mh = maint.hud();
  if (mh?.focus) return drawReticle(mh.focus, t);
  bctx.save();
  bctx.translate(h.x, h.y);
  bctx.lineCap = 'round';
  bctx.shadowColor = cyan(0.8);
  bctx.shadowBlur = 8;
  // main ring with ticks, slowly turning
  bctx.strokeStyle = cyan(0.32);
  bctx.lineWidth = 1.2;
  bctx.beginPath();
  bctx.arc(0, 0, r, 0, Math.PI * 2);
  bctx.stroke();
  bctx.save();
  bctx.rotate(t * 0.06);
  bctx.beginPath();
  for (let k = 0; k < (mh ? 0 : 120); k++) {
    const a = (k / 120) * Math.PI * 2, long = k % 10 === 0;
    const r0 = r - (long ? 10 : 5);
    bctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    bctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  bctx.stroke();
  bctx.restore();
  // dashed outer ring, turning the other way
  bctx.save();
  bctx.rotate(-t * 0.11);
  bctx.strokeStyle = mh ? hexA(mh.color, 0.35) : cyan(0.45);
  bctx.lineWidth = 2;
  bctx.setLineDash([r * 0.18, r * 0.07, r * 0.04, r * 0.07]);
  bctx.beginPath();
  bctx.arc(0, 0, r * 1.1, 0, Math.PI * 2);
  bctx.stroke();
  bctx.restore();
  // inner faint ring with four brackets
  bctx.strokeStyle = cyan(0.18);
  bctx.lineWidth = 1;
  bctx.beginPath();
  bctx.arc(0, 0, r * 0.58, 0, Math.PI * 2);
  bctx.stroke();
  bctx.strokeStyle = cyan(0.5);
  for (let q = 0; q < 4; q++) {
    const a = q * (Math.PI / 2) + t * 0.03;
    bctx.beginPath();
    bctx.arc(0, 0, r * 0.62, a - 0.12, a + 0.12);
    bctx.stroke();
  }
  // amber arc = explode amount
  if (h.explode > 0.005) {
    bctx.strokeStyle = 'rgba(255, 181, 71, 0.9)';
    bctx.shadowColor = 'rgba(255, 181, 71, 0.9)';
    bctx.lineWidth = 3;
    bctx.beginPath();
    bctx.arc(0, 0, r * 1.18, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * h.explode);
    bctx.stroke();
  }
  // readouts
  bctx.shadowBlur = 4;
  bctx.fillStyle = cyan(0.85);
  bctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  bctx.textAlign = 'left';
  const tx = Math.cos(-0.6) * r * 1.22, ty = Math.sin(-0.6) * r * 1.22;
  if (mh) {
    // kept left of the maintenance panel and below the top bar
    const x = Math.min(tx + 8, W - insets.r - 140 - h.x);
    const y = clamp(h.y + ty, 76, H - 140) - h.y;
    bctx.fillStyle = mh.color;
    bctx.fillText(`READINESS ${mh.status}`, x, y);
    bctx.fillStyle = cyan(0.85);
    bctx.fillText(`HEALTH    ${mh.health == null ? '--' : mh.health + '%'}`, x, y + 15);
    bctx.fillText(`DEFECTS   ${mh.defects}`, x, y + 30);
  } else {
    bctx.fillText(`EXPLODE ${String(Math.round(h.explode * 100)).padStart(3, '0')}%`, tx + 8, ty);
    bctx.fillText(`SCALE   ${h.scale.toFixed(2)}x`, tx + 8, ty + 15);
    bctx.fillText(h.sphere > 0.5 ? 'MODE    SPHERE' : 'MODE    ALIGNED', tx + 8, ty + 30);
  }
  bctx.textAlign = 'center';
  bctx.fillText((scene.entry?.def.name || '').toUpperCase(), 0, r * 1.1 + 24);
  bctx.restore();
}

const hexA = (hex, a) => {
  const n = parseInt(String(hex).slice(1), 16) || 0;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
/** Two rotating arcs around the focused defect (maintenance mode). */
function drawReticle(f, t) {
  const r = Math.max(14, f.r) + 18;
  bctx.save();
  bctx.translate(f.x, f.y);
  bctx.lineCap = 'round';
  bctx.shadowColor = hexA(f.color, 0.8);
  bctx.shadowBlur = 8;
  bctx.strokeStyle = hexA(f.color, 0.85);
  bctx.lineWidth = 2;
  for (let k = 0; k < 2; k++) {
    const a = t * 0.9 + k * Math.PI;
    bctx.beginPath();
    bctx.arc(0, 0, r, a, a + Math.PI / 3);
    bctx.stroke();
  }
  bctx.strokeStyle = hexA(f.color, 0.25);
  bctx.lineWidth = 1;
  bctx.beginPath();
  bctx.arc(0, 0, r + 8, 0, Math.PI * 2);
  bctx.stroke();
  bctx.restore();
}

function drawBack(t) {
  bctx.setTransform(1, 0, 0, 1, 0, 0);
  bctx.clearRect(0, 0, W, H);
  drawSharpHands(perc.hands.filter((h) => !h.held));
  if (ui.holo) drawHud(t);
  else if (maint.hud()?.focus) drawReticle(maint.hud().focus, t);
}

/** Word-wrap for canvas text (Korean and English both break at spaces; long words break anywhere). */
function wrapText(text, maxW) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const tryLine = line ? line + ' ' + word : word;
    if (ctx.measureText(tryLine).width <= maxW) line = tryLine;
    else {
      if (line) lines.push(line);
      line = word;
      while (ctx.measureText(line).width > maxW) {
        let k = line.length - 1;
        while (k > 1 && ctx.measureText(line.slice(0, k)).width > maxW) k--;
        lines.push(line.slice(0, k));
        line = line.slice(k);
      }
    }
  }
  if (line) lines.push(line);
  return lines;
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const SANS = 'ui-sans-serif, system-ui, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
/** HUD box with the description of the highlighted part (pointed at / hovered, else selected). */
function drawCallout() {
  if (!scene.entry || scene.pending >= 0 || scene.pop < 0.6 || maint.on) return;
  const i = scene.hover >= 0 ? scene.hover : scene.sel;
  const p = scene.parts[i];
  if (!p || !p.visible || !p.desc) return;
  const at = scene.labelPoints().find((q) => q.i === i);
  if (!at) return;
  const BOX_W = Math.min(320, W - 40);
  const pad = 12;
  ctx.font = `500 12.5px ${SANS}`;
  const lines = wrapText(p.desc, BOX_W - pad * 2);
  const group = groupName(p);
  const boxH = pad + (group ? 16 : 0) + 20 + (p.alt ? 17 : 0) + 8 + lines.length * 18 + pad - 4;
  // to the right of the part, or to the left when there is no room; never under the panel
  const panelR = W > 900 ? insets.l : 250;
  const rightEdge = W - insets.r;
  let x = at.x + 70;
  if (x + BOX_W > rightEdge - 12) x = at.x - 70 - BOX_W;
  x = clamp(x, panelR, rightEdge - BOX_W - 12);
  const y = clamp(at.y - boxH / 2, 64, H - boxH - 80);
  const amber = '#ffb547', line = ui.holo ? 'rgba(95, 228, 255, 0.75)' : 'rgba(255,255,255,0.6)';
  ctx.save();
  // leader line from the part to the box
  const ex = x + (x > at.x ? 0 : BOX_W), ey = clamp(at.y, y + 14, y + boxH - 14);
  ctx.strokeStyle = amber;
  ctx.lineWidth = 1.4;
  ctx.shadowColor = 'rgba(255, 181, 71, 0.8)';
  ctx.shadowBlur = 6;
  ctx.beginPath();
  ctx.moveTo(at.x, at.y);
  ctx.lineTo(ex + (x > at.x ? -18 : 18), ey);
  ctx.lineTo(ex, ey);
  ctx.stroke();
  ctx.fillStyle = amber;
  ctx.beginPath();
  ctx.arc(at.x, at.y, 4.5, 0, Math.PI * 2);
  ctx.fill();
  // box
  ctx.shadowBlur = 0;
  ctx.fillStyle = ui.holo ? 'rgba(3, 18, 30, 0.86)' : 'rgba(13, 15, 26, 0.9)';
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, BOX_W, boxH, 8) : ctx.rect(x, y, BOX_W, boxH);
  ctx.fill();
  ctx.stroke();
  // corner brackets
  ctx.strokeStyle = amber;
  ctx.lineWidth = 2;
  const c = 10;
  ctx.beginPath();
  ctx.moveTo(x, y + c); ctx.lineTo(x, y); ctx.lineTo(x + c, y);
  ctx.moveTo(x + BOX_W - c, y + boxH); ctx.lineTo(x + BOX_W, y + boxH); ctx.lineTo(x + BOX_W, y + boxH - c);
  ctx.stroke();
  // text
  let ty = y + pad;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  if (group) {
    ctx.font = `600 10px ${MONO}`;
    ctx.fillStyle = 'rgba(95, 228, 255, 0.9)';
    ctx.fillText(group.toUpperCase(), x + pad, ty);
    ty += 16;
  }
  ctx.font = `700 14px ${SANS}`;
  ctx.fillStyle = amber;
  ctx.fillText(p.name, x + pad, ty, BOX_W - pad * 2);
  ty += 20;
  if (p.alt) {
    ctx.font = `500 11.5px ${SANS}`;
    ctx.fillStyle = 'rgba(200, 225, 235, 0.7)';
    ctx.fillText(p.alt, x + pad, ty);
    ty += 17;
  }
  ty += 6;
  ctx.font = `500 12.5px ${SANS}`;
  ctx.fillStyle = '#e4f7fc';
  for (const l of lines) {
    ctx.fillText(l, x + pad, ty);
    ty += 18;
  }
  ctx.restore();
}

function drawOverlay() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (ui.labels) drawLabels();
  drawCallout();
  maint.draw(ctx, W, H, performance.now() / 1000);
  const live = perc.hands.filter((h) => !h.held);
  if (ui.skeleton) for (const h of live) drawHand(h);
  for (const h of live) drawRing(h);
  if (live.length >= 2) drawZoom(live[0], live[1]);
}

// ------------------------------------------------------------------ main loop
let lastT = performance.now() / 1000;
let frameErr = false;
let lastVideoAt = 0;
function frame(now) {
  requestAnimationFrame(frame); // first: an exception below must not stop the app
  try {
    step(now);
  } catch (e) {
    if (!frameErr) {
      frameErr = true; // report once, keep running
      console.error(e);
      showBanner(`표시 중 오류가 났습니다: ${e?.message || e} — 새로고침하면 대부분 해결됩니다.`);
    }
  }
}
function step(now) {
  const t = now / 1000;
  const dt = Math.min(0.05, Math.max(0.001, t - lastT));
  lastT = t;

  if (camOn && tracker.ready && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    lastVideoAt = t;
    const hands = tracker.detect(video, now);
    perc = engine.update(hands, t, mapPoint, (video.videoWidth || 16) / (video.videoHeight || 9));
  } else if (perc.hands.length && t - lastVideoAt > 0.5) {
    perc = { hands: [] }; // the video stalled (camera stopped, tab throttled): no stale hands
    engine.reset();
  }
  control(t, dt);
  maint.update(t, dt);

  if (!draggingExplode) rExplode.value = Math.round(clamp(scene.explode, 0, 1) * 100);
  $('v-explode').textContent = Math.round(clamp(scene.explode, 0, 1) * 100) + '%';
  $('b-explode').textContent = scene.explodeTarget > 0.5 ? '조립' : '분해';

  scene.update(dt);
  drawBack(t);
  drawOverlay();
}
requestAnimationFrame(frame);
