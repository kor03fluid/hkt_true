import './styles.css';
import { StlScene } from './scene.js';
import { repoModels, localModels } from './library.js';
import { HandTracker } from './handTracking.js';
import { GestureEngine, HAND_CONNECTIONS } from './gestureEngine.js';
import { clamp } from './utils.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const fxCanvas = $('fx');
const ctx = fxCanvas.getContext('2d');
const banner = $('banner');

let W = innerWidth, H = innerHeight, DPR = 1;
function sizeFx() {
  W = innerWidth;
  H = innerHeight;
  DPR = Math.min(devicePixelRatio || 1, 2);
  fxCanvas.width = W * DPR;
  fxCanvas.height = H * DPR;
}
sizeFx();
addEventListener('resize', sizeFx);

function showBanner(msg, info = false) {
  banner.textContent = msg;
  banner.className = info ? 'info' : '';
  banner.style.display = msg ? 'block' : 'none';
}
let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
}

// ------------------------------------------------------------------ scene + models
let scene;
try {
  scene = new StlScene($('scene'));
} catch (e) {
  console.error(e);
  showBanner('WebGL을 쓸 수 없습니다. 하드웨어 가속이 켜진 최신 Chrome / Edge / Firefox를 사용하세요.');
  throw e;
}

if (import.meta.env.DEV) window.__scene = scene; // for debugging in the browser console

const ui = { skeleton: true, labels: true, feed: true, handExplode: true };
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
    showBanner(e.message || String(e));
  });
}

scene.onLoading = (name, frac, label) => {
  $('loading').classList.toggle('show', !!name);
  if (!name) return;
  $('ld-bar').style.width = `${100 * frac}%`;
  $('ld-text').textContent = `${name} 불러오는 중… ${label}`;
};

scene.onModel = (i, entry) => {
  const def = entry.def;
  $('m-name').textContent = def.name;
  $('m-sub').textContent = def.subtitle;
  $('m-count').textContent = `${entry.parts.length} 부품`;
  chipBox.querySelectorAll('button').forEach((b) => b.classList.toggle('active', +b.dataset.i === i));
  buildPartList();
  showPart(-1);
  toast(def.name);
  if (entry.failed.length) showBanner(`읽지 못한 STL ${entry.failed.length}개: ${entry.failed.join(', ')}`, true);
};

const fmt = (v) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
function showPart(i) {
  const p = i >= 0 ? scene.parts[i] : null;
  $('pc-name').textContent = p ? p.name : '선택된 부품 없음';
  $('pc-desc').textContent = p
    ? [p.desc, `파일  ${p.file}`, `크기  ${fmt(p.size.x)} × ${fmt(p.size.y)} × ${fmt(p.size.z)}`, `삼각형  ${p.tris.toLocaleString()}`]
        .filter(Boolean)
        .join('\n')
    : '부품을 가리키거나 클릭하세요.';
  $('pc-dot').style.background = p ? p.color : '#555a70';
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
  for (const p of scene.parts) {
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
  const start = addModels(defs);
  $('start').classList.add('gone');
  if (!camOn) enterMouseMode('');
  switchModel(start);
}
$('b-open').onclick = () => $('f-dir').click();
$('f-dir').onchange = (e) => {
  openLocal([...e.target.files]);
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
  openLocal(e.dataTransfer);
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
let camOn = false;
let lastVideoTime = -1;
let perc = { hands: [] };

async function startCamera() {
  $('start').classList.add('gone');
  setTracking('시작 중…', 'warn');
  if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
    enterMouseMode('카메라는 http://localhost 또는 https 에서만 동작합니다.');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false });
    video.srcObject = stream;
    await video.play();
    camOn = true;
    ui.feed = true;
    $('t-feed').classList.add('on');
    document.body.classList.add('feed');
  } catch (e) {
    console.warn(e);
    enterMouseMode(e && e.name === 'NotAllowedError' ? '카메라 권한이 거부되었습니다. 주소창에서 허용한 뒤 새로고침하세요.' : '카메라를 찾지 못했습니다.');
    return;
  }
  setTracking('손 모델 로딩…', 'warn');
  try {
    await tracker.init();
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

function setTracking(text, cls) {
  const el = $('s-track');
  el.textContent = text;
  el.className = cls || '';
}

$('btn-cam').onclick = startCamera;
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
const prevPalm = new Map();
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

  // two hands: distance between palms = zoom
  if (live.length >= 2) {
    const a = live[0].palm, b = live[1].palm;
    const dist = Math.hypot((a.x - b.x) * W, (a.y - b.y) * H);
    if (!zoomRef) zoomRef = { d0: Math.max(60, dist), s0: scene.scaleTarget };
    scene.scaleTarget = clamp((zoomRef.s0 * dist) / zoomRef.d0, 0.3, 6);
    scene.holdVel = true;
    scene.idle = 0;
    endGrab();
    scene.setHover(-1);
    prevPalm.clear();
    setActive('TWO');
    return;
  }
  zoomRef = null;

  const h = live[0];
  if (!h) {
    endGrab();
    scene.holdVel = draggingMouse;
    prevPalm.clear();
    fistT = 0;
    setActive('');
    return;
  }

  scene.holdVel = true;
  scene.idle = 0;
  const g = h.gesture;
  const palmPx = { x: h.palm.x * W, y: h.palm.y * H };
  fistT = g === 'FIST' ? fistT + dt : 0;

  if (g === 'OPEN' || g === 'FIST' || g === 'NONE') {
    // openness drives the explosion
    if (g === 'FIST') scene.explodeTarget = 0;
    else if (ui.handExplode) scene.explodeTarget = clamp((h.openness - 0.12) / 0.78, 0, 1);
    // a held fist also brings moved parts home
    if (fistT > 0.6 && scene.movedParts) {
      scene.resetParts();
      toast('부품 원위치');
    }
    // moving the hand rotates the model
    const prev = prevPalm.get(h.id);
    if (prev) {
      const dx = palmPx.x - prev.x, dy = palmPx.y - prev.y;
      if (Math.hypot(dx, dy) > 1.5) scene.rotateBy(dx * 0.0048, dy * 0.0032, dt);
    }
    if (h.rollDelta) scene.rollBy(h.rollDelta * 0.7);
    scene.setHover(-1);
    setActive(g === 'NONE' ? 'MOVE' : g);
    if (g === 'OPEN' && prev && Math.hypot(palmPx.x - prev.x, palmPx.y - prev.y) > 6) setActive('MOVE');
  } else {
    if (g === 'POINT') {
      const idx = scene.pick(h.tip.x * W, h.tip.y * H, 95);
      scene.setHover(idx);
      if (idx >= 0) {
        lastHover = { i: idx, t };
        if (scene.sel < 0 || idx === scene.sel) showPart(idx);
      }
      if (idx >= 0 && idx === dwell.i) {
        dwell.t += dt;
        if (dwell.t > 0.7 && scene.sel !== idx) select(idx);
      } else dwell = { i: idx, t: 0 };
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
        scene.dragPart(grab.part, pp.x - grab.last.x, pp.y - grab.last.y);
        if (h.rollDelta) scene.twistPart(grab.part, h.rollDelta);
        grab.last = pp;
      }
    } else if (g === 'PEACE') {
      if (t > peaceCool) {
        peaceCool = t + 1.6;
        scene.next();
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
const onUi = (e) => e.target.closest && e.target.closest('#panel,#chips,#toolbar,#start');

addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || onUi(e)) return;
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
  if (!draggingMouse) {
    if (!onUi(e) && !perc.hands.length) scene.setHover(scene.pick(e.clientX, e.clientY, 0));
    return;
  }
  const dx = e.clientX - mouseLast.x, dy = e.clientY - mouseLast.y;
  if (mousePart?.mode === 'move') scene.dragPart(mousePart.i, dx, dy);
  else if (mousePart) scene.spinPart(mousePart.i, dx, dy);
  else {
    scene.holdVel = true;
    scene.rotateBy(dx * 0.006, dy * 0.004, 1 / 60);
  }
  mouseLast = { x: e.clientX, y: e.clientY };
});
addEventListener('pointerup', (e) => {
  if (!draggingMouse) return;
  draggingMouse = false;
  scene.holdVel = false;
  scene.grabbed = -1;
  if (!mousePart && Math.hypot(e.clientX - mouseStart.x, e.clientY - mouseStart.y) < 5) {
    const idx = scene.pick(e.clientX, e.clientY, 0);
    select(idx === scene.sel ? -1 : idx);
  }
  mousePart = null;
});
addEventListener(
  'wheel',
  (e) => {
    if (onUi(e)) return;
    scene.zoomBy(Math.exp(-e.deltaY * 0.0012));
  },
  { passive: true },
);
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const k = e.key.toLowerCase();
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
  else if (k === 'i' && scene.sel >= 0) $('pc-iso').click();
  else if (k === 'h' && scene.sel >= 0) setPartVisible(scene.sel, false);
  else if (k === 'escape') select(-1);
  else if (e.key >= '1' && e.key <= '9' && +e.key <= scene.models.length) switchModel(+e.key - 1);
});

// ------------------------------------------------------------------ overlay drawing
const ringR = new Map();

function drawHand(h) {
  const pts = h.lm.map((p) => ({ x: p.x * W, y: p.y * H }));
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(236, 232, 255, 0.78)';
  ctx.shadowColor = 'rgba(176, 164, 255, 0.95)';
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
  ctx.shadowColor = 'rgba(242, 201, 76, 0.9)';
  ctx.shadowBlur = 14;
  if (g === 'POINT') {
    const x = h.tip.x * W, y = h.tip.y * H;
    ctx.strokeStyle = '#f2c94c';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(x, y, 20, 0, Math.PI * 2);
    ctx.stroke();
    // dwell progress towards selecting the part
    if (dwell.i >= 0 && dwell.i !== scene.sel) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.arc(x, y, 20, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(dwell.t / 0.7, 0, 1));
      ctx.stroke();
    }
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  } else if (g === 'PINCH') {
    const x = h.pinchPt.x * W, y = h.pinchPt.y * H;
    ctx.strokeStyle = '#f2c94c';
    ctx.fillStyle = grab ? 'rgba(242, 201, 76, 0.55)' : 'rgba(242, 201, 76, 0.25)';
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
    ctx.strokeStyle = 'rgba(242, 201, 76, 0.95)';
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
  ctx.strokeStyle = 'rgba(242, 201, 76, 0.85)';
  ctx.setLineDash([6, 6]);
  ctx.lineWidth = 2;
  ctx.shadowColor = 'rgba(242, 201, 76, 0.8)';
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
  const hotOnly = e <= 0.01 || pts.length > MAX_LABELS;
  if (hotOnly) pts = pts.filter((p) => p.i === scene.hover || p.i === scene.sel);
  if (!pts.length) return;
  const c = scene.centerScreen();
  const panelR = W > 900 ? 310 : 0;
  const left = [], right = [];
  for (const p of pts) (p.x < c.x ? left : right).push(p);
  const maxX = Math.max(...pts.map((p) => p.x), c.x);
  const minX = Math.min(...pts.map((p) => p.x), c.x);
  // keep whole names on screen: columns are placed by the widest label on each side
  ctx.font = LABEL_FONT(true);
  const textW = (list) => Math.max(0, ...list.map((p) => ctx.measureText(p.name).width)) + 12;
  const colR = clamp(maxX + 80, panelR + 360, W - 16 - textW(right));
  const colL = clamp(minX - 80, panelR + 16 + textW(left), W - 400);
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
      ctx.strokeStyle = hot ? p.color : 'rgba(255,255,255,0.38)';
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
      ctx.fillStyle = hot ? '#fff' : 'rgba(255,255,255,0.82)';
      ctx.font = LABEL_FONT(hot);
      ctx.textAlign = dir > 0 ? 'left' : 'right';
      ctx.fillText(p.name, colX + dir * 6, ly);
    });
  };
  place(right, colR, 1);
  place(left, colL, -1);
  ctx.restore();
}

function drawOverlay() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (ui.labels) drawLabels();
  const live = perc.hands.filter((h) => !h.held);
  if (ui.skeleton) for (const h of live) drawHand(h);
  for (const h of live) drawRing(h);
  if (live.length >= 2) drawZoom(live[0], live[1]);
}

// ------------------------------------------------------------------ main loop
let lastT = performance.now() / 1000;
function frame(now) {
  const t = now / 1000;
  const dt = Math.min(0.05, Math.max(0.001, t - lastT));
  lastT = t;

  if (camOn && tracker.ready && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const hands = tracker.detect(video, now);
    perc = engine.update(hands, t, mapPoint, (video.videoWidth || 16) / (video.videoHeight || 9));
  }
  control(t, dt);

  if (!draggingExplode) rExplode.value = Math.round(clamp(scene.explode, 0, 1) * 100);
  $('v-explode').textContent = Math.round(clamp(scene.explode, 0, 1) * 100) + '%';
  $('b-explode').textContent = scene.explodeTarget > 0.5 ? '조립' : '분해';

  scene.update(dt);
  drawOverlay();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
