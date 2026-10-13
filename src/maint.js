// AI 정비 mode (AI maintenance diagnostic network), UI side.
//
// Owns the defect rows of every model (sample rows from web/defects.json + manual / imported rows and the
// technician's feedback, kept in localStorage), runs the rule engine in diagnosis.js after every change and
// presents the result: the #diag panel (readiness, fleet, next action, 결함 / 기능망 / 수리 / 이력 tabs), the
// canvas markers / callout / scan HUD / procedure caption, the report and JSON import / export.
// main.js keeps the input routing and calls the hooks (onKey, click, hover, pointBadge, airPoint, pointEnd,
// cta, release, noteInput, update, draw, hud); the 3D side is scene.js (setMaint, setDefects, focusDefect...).
// Sample defects, confidences and the knowledge base are demonstration data and are labelled as such.
// SQUAD LINK (squad.js) adds live inspection rows (source 'live') from the team's control server when a
// bridge serves the read-only API next to the page; a signal says where to look and never closes a defect.
import SAMPLE from '/web/defects.json';
import KB from '/web/maintenance.json';
import ANCHORS from '/web/live_anchors.json';
import {
  TYPES, SEVERITY, SOURCES, STATUS, ACTIONS, PRIORITY, LEVELS, PART_STATUS, FUNC_STATUS, READINESS, STEP_KINDS, NOTICE,
  diagnose, repairPlan, applyFeedback, reinspect, assess,
} from './diagnosis.js';
import { clamp } from './utils.js';
import { SquadLink, liveSignals, reconcile, nodesOf, DEFAULT_MAP, RULES } from './squad.js';

const STORE = 'holohand-maint-v1';
const STORE_BY = 'holohand-maint-by';
const STORE_SQUAD = 'holohand-squad-v1'; // { map: { node: model key | '' }, seen: [signal keys] }
const BRIDGE = 'http://localhost:8095/squad/api/'; // tools/squad_bridge.mjs default, tried when the user asks
const GREEN = '#5be38a', BLUE = '#7fb2ff', ACCENT = '#bff6ff', GREY = '#8f95aa';
const RD_EN = { GO: 'GO', LIMITED: 'LIMITED', NOGO: 'NO-GO' };
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const SANS = 'ui-sans-serif, system-ui, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
const STEP_TIME = { remove: 2.2, install: 2.2, work: 3.5, verify: 3.5 }; // s per step while the procedure plays (else 3)
const KIND = { repair: '정비', fp: '오탐', inspect: '재검사', reinspect: '재검사', add: '등록', import: '불러오기', remove: '삭제', live: '실시간', clear: '이상 없음' };
const FIELDS = ['status', 'sev', 'origSev', 'size', 'escalated', 'wait', 'rework', 'condemned', 'fp', 'memo', 'monitored', 'forceReplace', 'forceMonitor']; // persisted per id
/** Result choices for an open defect (labels follow the planned action and the source). */
function resultsFor(r, action, priority) {
  const out = [['done', action === 'monitor' ? '관찰 등록' : '완료']];
  // a condemned part is only ever replaced; a signal row has no size to reduce
  if (!r.condemned && !TYPES[r.type]?.signal) out.push(['partial', '부분 수리']);
  out.push(['fail', '수리 불가']);
  if (action !== 'replace' && !r.condemned) out.push(['replace', '교체 전환']);
  if (action !== 'monitor' && !r.condemned && priority !== 'P1') out.push(['monitor', '관찰 전환']); // P1 is never deferred
  out.push(['false', r.source === 'manual' ? '등록 취소(결함 아님)' : r.source === 'live' ? '이상 없음(점검 종료)' : '오탐(결함 아님)']);
  return out;
}
/** Storage key of a model: repo models by file, dropped ones by name + their part list. */
function keyOf(def) {
  if (def.key) return def.key;
  let h = 2166136261;
  for (const ch of (def.parts || []).map((p) => p.file).sort().join('|')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return `local:${def.name}:${(h >>> 0).toString(36)}`;
}
// gesture list copy while maintenance mode is on (title, hint)
const GEST = {
  OPEN: ['편 손 움직이기', '모델 회전 (정비 중 분해 꺼짐)'],
  FIST: ['주먹 꽉 쥐기', '초점 해제 · 부품 원위치'],
  POINT: ['검지로 결함 가리키기', '번호 위에서 멈추면 선택'],
  PINCH: ['부품 집기', '절차 재생 중에는 꺼짐'],
  PEACE: ['브이', '다음 할 일 (패널의 파란 버튼)'],
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nowS = () => performance.now() / 1000;
const pad2 = (n) => String(n).padStart(2, '0');
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const stamp = (iso, year = false) => {
  const d = new Date(iso);
  if (isNaN(d)) return String(iso || '');
  return `${year ? d.getFullYear() + '-' : ''}${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const mm = (v) => (Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : (+v).toFixed(1));
const koShort = (s) => (READINESS[s]?.ko || String(s)).split(' (')[0];
const rdLabel = (s) => `${koShort(s)} · ${RD_EN[s] || s}`;
const isVec = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => x !== null && x !== '' && Number.isFinite(+x));
const inkOn = (hex) => (String(hex).toLowerCase() === SEVERITY.high.color.toLowerCase() ? '#fff' : '#10121c'); // white on red only
const fileKey = (k) => String(k).replace(/[^\w.-]+/g, '_');
const easeBack = (k) => 1 + 2.70158 * (k - 1) ** 3 + 1.70158 * (k - 1) ** 2;
function rgba(hex, a) {
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = h.replace(/./g, '$&$&');
  const n = parseInt(h, 16) || 0;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
function download(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
const measureCtx = document.createElement('canvas').getContext('2d');
function fit(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}
function wrap(ctx, text, maxW, maxLines) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    const tryLine = line ? line + ' ' + word : word;
    if (ctx.measureText(tryLine).width <= maxW || !line) line = tryLine;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = fit(ctx, lines[maxLines - 1] + ' …', maxW);
  }
  return lines.map((l) => fit(ctx, l, maxW));
}

export class Maint {
  /**
   * opts: { scene, ui, toast(msg, ms), select(partIndex), showPart(partIndex), switchModel(modelIndex),
   *   setActive?, banner?(msg, info), insets: { l, r } (shared, live), relayout?(), dwellTime?() }
   */
  constructor(opts) {
    this.scene = opts.scene;
    this.ui = opts.ui;
    this.toast = opts.toast || (() => {});
    this.select = opts.select || (() => {});
    this.showPart = opts.showPart || (() => {});
    this.switchModel = opts.switchModel || (() => {});
    this.setActive = opts.setActive || (() => {});
    this.setPartVisible = opts.setPartVisible || ((i, v) => this.scene.setVisible(i, v));
    this.banner = opts.banner || (() => {});
    this.insets = opts.insets || { l: 0, r: 0 };
    this.relayout = opts.relayout || (() => {});
    this.dwellTime = opts.dwellTime || (() => 0.8);

    this.on = false;
    this.store = this._load();
    this.by = (() => {
      try {
        return localStorage.getItem(STORE_BY) || '';
      } catch {
        return '';
      }
    })();
    this.def = null;
    this.key = '';
    this.rows = [];
    this.byId = new Map();
    this.parts = [];
    this.report = null;
    this.fleet = [];
    this.sdefs = [];
    this.selId = null;
    this.hoverId = null;
    this.tab = 'defects';
    this.scan = 'idle'; // idle (maint off) | pending | running | done
    this.scanKind = 'full'; // 'full' (detection) | 'reinspect'
    this.scanEndAt = -1;
    this.revealed = new Set();
    this.popAt = new Map();
    this.readyShown = false;
    this.flipAt = 0;
    this.lastReady = null;
    this.hp = { from: 0, to: 0, t0: -1, shown: null };
    this.firstEntry = true;
    this.autoFirst = false;
    this.autoAt = 0;
    this.hinted = false;
    this.checks = new Map(); // `${key}|${wo}` -> Set of checked step ids
    this.stepIdx = -1;
    this.plan = null;
    this.planKey = '';
    this.formOpen = false;
    this.form = { result: 'done', reason: 'capability', measured: '', minutes: null, memo: '', by: null, insp: null };
    this.play = null;
    this.addMode = false;
    this.addPick = null;
    this.addVals = { type: 'crack', sev: 'mid', size: '8', memo: '' };
    this.float = null;
    this.reinspectId = null;
    this.passAnim = null;
    this.netAll = false;
    this.hits = [];
    this.callout = null;
    this.pt = { id: null, t: 0, armed: true, x: 0, y: 0, hand: false };
    this.air = { el: null, t: 0, fired: false, x: 0, y: 0 };
    this.frame = 0;
    this.now = nowS();
    this.squad = this._loadSquad();
    this.liveTry = [];
    this.liveMapOpen = false;
    this.link = new SquadLink({ onState: (snap) => this._onSquad(snap), onStatus: (st) => this._onLinkStatus(st) });
    this._dom();
    this.scene.onReveal = (id) => this._onReveal(id);
    this.scene.onScanEnd = () => this._onScanEnd();
  }

  // ------------------------------------------------------------------ public hooks
  get procedureShown() {
    return !!this.scene.proc;
  }
  diagWidth() {
    return this.$diag.offsetWidth || 0;
  }

  /** Maintenance mode on / off (chip, M key, start card, #maint). */
  toggle(on = !this.on) {
    on = !!on;
    if (on === this.on) return;
    const sc = this.scene;
    this.on = on;
    document.body.classList.toggle('maint', on);
    this.$chip.classList.toggle('active', on);
    sc.setMaint(on);
    if (on) {
      this.saved = { explode: sc.explodeTarget, scale: sc.scaleTarget, index: sc.index };
      sc.explodeTarget = 0;
      sc.isolate = false;
      this._showAll();
      this._gestCopy(true);
      this.relayout();
      if (sc.entry) sc.scaleTarget = sc.fitScale(0.7);
      this.scan = 'pending';
      this.readyShown = false;
      this.lastReady = null;
      this.revealed.clear();
      this.autoFirst = this.firstEntry;
      this.firstEntry = false;
      this._recompute();
      this._render(true);
      this._liveConnect(false);
    } else {
      this.link.stop();
      this.liveTry = [];
      this._stopPlay();
      this._closeFloat();
      this._setAdd(false);
      sc.focusDefect(null);
      sc.setProcedure(null);
      if (sc.scan) sc.scan.dur = 1e-3; // finish a running sweep on the next frame
      sc.defectSel = sc.defectHover = null;
      this.selId = this.hoverId = null;
      this.stepIdx = -1;
      this.scan = 'idle';
      this.flipAt = this.autoAt = 0;
      this.autoFirst = false;
      this.passAnim = this.reinspectId = null;
      sc.explodeTarget = this.saved?.explode ?? 0;
      if (this.saved && this.saved.index === sc.index) sc.scaleTarget = Math.min(this.saved.scale, 6);
      else sc.scaleTarget = Math.min(6, sc.entry?.def.manifest?.view?.zoom ?? 1);
      this._gestCopy(false);
      this.air.el?.classList.remove('air-hot');
      document.body.classList.remove('mt-pointer');
      this.relayout();
      this.showPart(sc.sel);
    }
  }

  /** scene.onModel: a model was shown (also while maintenance mode is off). */
  onModel(i, entry) {
    this.def = entry.def;
    this.key = keyOf(entry.def);
    this.selId = this.hoverId = null;
    this.stepIdx = -1;
    this._stopPlay();
    this._closeFloat();
    this._setAdd(false);
    this.passAnim = this.reinspectId = null;
    if (this.firstShown) this.autoFirst = false; // only the very first scan after entering auto-selects
    this.autoAt = this.flipAt = 0;
    this.revealed.clear();
    this.popAt.clear();
    this.readyShown = false;
    this.lastReady = null;
    this.scan = this.on ? 'pending' : 'idle';
    if (this.on) {
      this.scene.isolate = false;
      this._showAll();
    }
    this._recompute();
    if (this.on) {
      this.scene.scaleTarget = this.scene.fitScale(0.7);
      this._render(true);
    }
  }

  /** Any user input: cancels the first-entry auto selection and pauses the procedure playback. */
  noteInput() {
    this.autoAt = 0;
    this.autoFirst = false;
    if (this.play) this._stopPlay();
  }

  /** Per frame, before scene.update. */
  update(t, dt) {
    this.frame++;
    this.now = nowS();
    if (!this.on) return;
    this.link.tick();
    const sc = this.scene, now = this.now;
    // the AI scan starts once the model has popped in and the start card is gone
    if (this.scan === 'pending' && this.report && sc.entry?.def === this.def && sc.pending < 0 && sc.pop >= 0.95 && this._started()) this._startScan('full');
    if (this.flipAt && now >= this.flipAt) {
      this.flipAt = 0;
      this.readyShown = true;
      this.firstShown = true;
      this.lastReady = this.report.readiness.status;
      this.hp = { from: 0, to: this.report.health, t0: now, shown: 0 };
      this._render();
      this.showPart(sc.sel);
      if (this.autoFirst) this.autoAt = now + 1.5;
      this.autoFirst = false;
    }
    if (this.autoAt && now >= this.autoAt) {
      this.autoAt = 0;
      const first = this._nextOpen(null);
      if (first) {
        this.selectDefect(first.id);
        if (!this.hinted) {
          this.hinted = true;
          this.toast('✌️ 브이 = 다음 · ☝️ 번호 위에서 멈추면 선택', 4000);
        }
      }
    }
    if (this.passAnim && now - this.passAnim.t0 >= 1.2) this._passDone();
    if (this.play && now >= this.play.next) this._playStep();
    if (this.hp.t0 >= 0) {
      const k = clamp((now - this.hp.t0) / 0.6, 0, 1);
      this.hp.shown = this.hp.from + (this.hp.to - this.hp.from) * (1 - (1 - k) ** 3);
      if (k >= 1) this.hp.t0 = -1;
      this._renderHealth();
    }
    this._renderNext();
  }

  /** Readiness / health / focus for the HUD rings in main.js (null while nothing is shown). */
  hud() {
    if (!this.on || !this.report) return null;
    const rd = this.report.readiness, shown = this.readyShown;
    let focus = null;
    const f = this.scene.focus;
    if (f) {
      const s = this._screen().find((x) => x.id === f.id);
      const r = this.byId.get(f.id);
      if (s) focus = { x: s.x, y: s.y, r: s.r, color: r ? SEVERITY[r.sev]?.color || ACCENT : ACCENT };
    }
    const c = this.report.counts;
    return {
      color: shown ? rd.color : GREY,
      status: shown ? RD_EN[rd.status] || rd.status : this.scan === 'running' ? 'SCANNING' : 'STANDBY',
      health: shown ? Math.round(this.hp.shown ?? this.report.health) : null,
      defects: (c.open || 0) + (c.repaired || 0),
      focus,
    };
  }

  /** Part card line in maintenance mode: { text, color } or null. */
  partInfo(i) {
    if (!this.on || !this.report || !this.readyShown) return null;
    const p = this.scene.parts[i];
    const pr = p && this.report.parts[p.code];
    if (!pr) return null;
    const st = PART_STATUS[pr.status] || PART_STATUS.ok;
    return { text: `건강도 ${pr.health}% · ${st.ko} · 결함 ${pr.open}건`, color: st.color };
  }

  /** Keyboard. Returns true when the key was used. (Not `key`: that is the model's storage key.) */
  onKey(e) {
    const k = e.key.toLowerCase();
    if ((k === 'm' || e.code === 'KeyM') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      this.toggle();
      return true;
    }
    if (!this.on) return false;
    this.noteInput();
    if (k === 'n' || e.code === 'KeyN' || e.key === ']') return this.step(1), true;
    if (e.key === '[') return this.step(-1), true;
    if (e.key === 'Delete') {
      if (this.selId) this._remove(this.selId);
      return true;
    }
    if (e.key === 'Enter') {
      // a keyboard-focused control keeps its own Enter
      // (mouse-clicked buttons are blurred by main.js, so only a keyboard-focused control lands here)
      if (e.target.closest?.('button, a, summary')) return false;
      e.preventDefault();
      this.cta();
      return true;
    }
    if (e.key === 'Escape') return this.escape();
    if (k === 'r' || e.code === 'KeyR') {
      this.scene.resetView();
      this.select(-1);
      this.release();
      this.scene.scaleTarget = this.scene.fitScale(0.7);
      return true;
    }
    return false;
  }

  /** Esc, layered: add form / crosshair -> playback -> focus -> defect selection (-> part selection in main). */
  escape() {
    if (this.float || this.addMode) {
      this._closeFloat();
      this._setAdd(false);
      return true;
    }
    if (this.play) {
      this._stopPlay();
      return true;
    }
    if (this.scene.focus) {
      this.scene.focusDefect(null);
      return true;
    }
    if (this.selId) {
      this.selectDefect(null);
      return true;
    }
    return false;
  }

  /** Mouse click (no drag) on the scene. Returns true when it was used. */
  click(x, y) {
    if (!this.on) return false;
    if (this.addMode) {
      const hit = this.scene.pickSurface(x, y);
      if (hit) this._addForm(hit, x, y);
      else this.toast('부품 표면을 클릭하세요');
      return true;
    }
    const c = this.callout;
    if (c && x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) {
      this._proceed(c.id);
      return true;
    }
    const id = this._hit(x, y, 13);
    if (id) {
      this.selectDefect(id);
      return true;
    }
    return false;
  }

  /** Mouse hover: badge / anchor / callout. Returns true when over one of them. */
  hover(x, y) {
    if (!this.on) return false;
    let id = Number.isFinite(x) ? this._hit(x, y, 13) : null;
    const c = this.callout;
    const onCallout = !!c && x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h;
    if (!id && onCallout) id = c.id;
    this._setHover(id);
    this.pt.hand = false;
    document.body.classList.toggle('mt-pointer', !!id);
    return !!id;
  }

  /**
   * Hand POINT over the scene: badges first (acquire within 32 px, keep until 48 px, nearest wins); held for
   * the dwell time selects + focuses, then disarmed until the tip moves > 40 px or the gesture changes.
   * Returns the targeted defect id or null.
   */
  pointBadge(x, y, dt) {
    if (!this.on) return null;
    const P = this.pt;
    let id = null;
    if (P.id) {
      const h = this.hits.find((q) => q.id === P.id);
      if (h && Math.min(Math.hypot(h.bx - x, h.by - y), Math.hypot(h.ax - x, h.ay - y)) <= 48) id = P.id;
    }
    if (!id) id = this._hit(x, y, 32);
    if (id !== P.id) {
      P.id = id;
      P.t = 0;
    }
    if (!P.armed && Math.hypot(x - P.x, y - P.y) > 40) P.armed = true;
    if (id) {
      this._setHover(id);
      P.hand = true;
      const done = id === this.selId && this.scene.focus?.id === id;
      if (P.armed && !done) {
        P.t += dt;
        if (P.t >= this.dwellTime()) {
          this.selectDefect(id);
          Object.assign(P, { armed: false, x, y, t: 0 });
        }
      }
    } else if (P.hand) {
      this._setHover(null);
      P.hand = false;
    }
    return id;
  }

  /**
   * Hand POINT over the panels: held on a [data-air] control in #diag / a floating form for the dwell time
   * clicks it once; the next air-click needs the tip to move > 40 px (or a new gesture).
   */
  airPoint(el, x, y, dt) {
    const A = this.air;
    const tgt = (this.on && el?.closest?.('#diag [data-air], .mt-float [data-air]')) || null;
    if (tgt !== A.el) {
      A.el?.classList.remove('air-hot');
      A.el = tgt;
      A.t = 0;
      tgt?.classList.add('air-hot');
    }
    if (A.fired && Math.hypot(x - A.x, y - A.y) > 40) A.fired = false;
    if (!tgt || A.fired || tgt.disabled) return;
    A.t += dt;
    if (A.t >= this.dwellTime()) {
      Object.assign(A, { fired: true, x, y, t: 0 });
      tgt.click();
    }
  }

  /** The hand stopped pointing (or left): reset the badge / air-click dwell. */
  pointEnd() {
    const P = this.pt, A = this.air;
    if (P.hand) this._setHover(null);
    Object.assign(P, { id: null, t: 0, armed: true, hand: false });
    A.el?.classList.remove('air-hot');
    Object.assign(A, { el: null, t: 0, fired: false });
  }

  /** Dwell progress 0..1 for the POINT ring (air-click or badge), or null. */
  ringProgress() {
    if (!this.on) return null;
    if (this.air.el && !this.air.fired) return clamp(this.air.t / this.dwellTime(), 0, 1);
    if (this.pt.id && this.pt.armed && !(this.pt.id === this.selId && this.scene.focus?.id === this.pt.id)) return clamp(this.pt.t / this.dwellTime(), 0, 1);
    return null;
  }

  /** FIST / R: release the focus, end the procedure view, parts back home. True if anything changed. */
  release() {
    const sc = this.scene;
    const did = !!sc.focus || !!sc.proc || !!this.play || this.stepIdx >= 0;
    this._stopPlay();
    sc.focusDefect(null);
    sc.setProcedure(null);
    sc.resetParts();
    this.stepIdx = -1;
    if (did) this._markSteps();
    return did;
  }

  /** The primary "next action" (CTA button, Enter, PEACE). Never submits a form. */
  cta() {
    if (!this.on) return false;
    const st = this._cta();
    this.noteInput();
    if (st.disabled || !st.run) return false;
    st.run();
    this._renderNext();
    return true;
  }

  /** N / ] and [: next / previous unresolved defect. */
  step(d) {
    if (!this.report) return;
    const open = this.report.order.filter((id) => this.byId.get(id)?.status !== 'closed');
    const list = open.length ? open : this.report.order;
    if (!list.length) return;
    const k = list.indexOf(this.selId);
    this.selectDefect(list[k < 0 ? (d > 0 ? 0 : list.length - 1) : (k + d + list.length) % list.length]);
  }

  /** Select a defect (null clears): its part is selected too, and the view focuses on it. */
  selectDefect(id, { focus = true } = {}) {
    const r = id != null ? this.byId.get(id) : null;
    const next = r ? r.id : null;
    if (next !== this.selId) {
      this._stopPlay();
      this.scene.setProcedure(null);
      this.stepIdx = -1;
      this._resetForm();
    }
    this.selId = next;
    this.scene.defectSel = next;
    this.autoAt = 0;
    if (r) {
      const i = this._pidx(r.part);
      if (i >= 0 && this.scene.sel !== i) this.select(i);
      if (focus) this.scene.focusDefect(r.id);
    } else this.scene.focusDefect(null);
    this._render();
  }

  setTab(tab) {
    if (tab === this.tab) return;
    if (this.tab === 'repair') {
      this._stopPlay();
      this.scene.setProcedure(null);
      this.stepIdx = -1;
    }
    this.tab = tab;
    this._render(true);
  }

  collapse(v) {
    this.$diag.classList.toggle('collapsed', v);
    this.relayout();
  }

  // ------------------------------------------------------------------ data
  _load() {
    try {
      const v = JSON.parse(localStorage.getItem(STORE) || '{}');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }
  _save() {
    try {
      localStorage.setItem(STORE, JSON.stringify(this.store));
    } catch {
      /* storage full or blocked: the session keeps working */
    }
  }
  _saveBy(by) {
    this.by = by;
    try {
      localStorage.setItem(STORE_BY, by);
    } catch {
      /* ignore */
    }
  }
  _st(key = this.key) {
    let s = this.store[key];
    if (!s || typeof s !== 'object') s = this.store[key] = {};
    if (!Array.isArray(s.added)) s.added = [];
    if (!s.overrides || typeof s.overrides !== 'object') s.overrides = {};
    if (!Array.isArray(s.removed)) s.removed = [];
    if (!Array.isArray(s.history)) s.history = [];
    if (!Number.isFinite(s.seq)) s.seq = 0;
    return s;
  }
  _hist(key = this.key) {
    const h = this.store[key]?.history;
    return Array.isArray(h) ? h : [];
  }
  _kb(key = this.key) {
    return KB[key] && typeof KB[key] === 'object' && !Array.isArray(KB[key]) ? KB[key] : null;
  }

  /** Sample rows + added rows, minus removed ones, with the saved state applied. */
  _rowsFor(key) {
    const st = this.store[key] || {};
    const removed = new Set(Array.isArray(st.removed) ? st.removed : []);
    const ov = st.overrides || {};
    const sample = (Array.isArray(SAMPLE[key]) ? SAMPLE[key] : []).map((r) => ({
      ...r, source: 'sample', status: 'open', escalated: 0, wait: null, rework: 0, condemned: false, fp: false,
    }));
    const added = Array.isArray(st.added) ? st.added : [];
    return [...sample, ...added].filter((r) => !removed.has(r.id)).map((r) => ({ ...r, ...(ov[r.id] || {}) }));
  }

  /** Parts for the engine: the shown entry, else the packed part table of a model not loaded yet. */
  _partsFor(def) {
    if (!def) return [];
    if (this.scene.entry?.def === def) return this.scene.parts.map((p) => ({ code: p.code, name: p.name, group: p.group, alt: p.alt || '' }));
    return (def.parts || [])
      .filter((p) => p.packed)
      .map((p) => ({ code: p.packed.code || p.file.replace(/\.stl$/i, ''), name: p.packed.name || p.file, group: p.packed.group || '', alt: p.packed.alt || '' }));
  }

  _diagnose(parts, rows, kb) {
    try {
      return diagnose({ parts, defects: rows, kb });
    } catch (e) {
      console.error('diagnose failed', e);
      const counts = { open: 0, high: 0, mid: 0, low: 0, repaired: 0, closed: 0, fp: 0, escalated: 0, supply: 0, P1: 0, P2: 0, P3: 0 };
      return { defects: {}, parts: {}, functions: [], readiness: { status: 'LIMITED', ...READINESS.LIMITED, reasons: ['진단 엔진 오류'], deferred: [] }, health: 0, counts, order: rows.map((r) => r.id) };
    }
  }

  _recompute() {
    if (!this.def) return;
    this.parts = this._partsFor(this.def);
    const codes = new Set(this.parts.map((p) => p.code));
    this.rows = this._rowsFor(this.key).filter((r) => codes.has(r.part));
    this.byId = new Map(this.rows.map((r) => [r.id, r]));
    this.report = this._diagnose(this.parts, this.rows, this._kb());
    this.fleet = this.scene.models
      .map((def, index) => ({ def, index }))
      .filter(({ def }) => def.key && !def.key.startsWith('local:'))
      .map(({ def, index }) => ({
        def, index, key: def.key,
        report: def === this.def ? this.report : this._diagnose(this._partsFor(def), this._rowsFor(def.key), this._kb(def.key)),
      }));
    // work left per equipment (open defects not merely under monitoring, plus repaired ones awaiting inspection)
    for (const f of this.fleet) {
      const rows = f.def === this.def ? this.rows : this._rowsFor(f.key);
      f.todo = rows.filter((r) => r.status === 'repaired' || (r.status === 'open' && !(r.monitored && f.report.defects[r.id]?.action === 'monitor'))).length;
    }
    if (this.selId && !this.byId.has(this.selId)) {
      this.selId = null;
      this.scene.defectSel = null;
    }
    if (!this.on) return;
    this._sync();
    const rd = this.report.readiness.status;
    const changed = this.readyShown && this.lastReady && rd !== this.lastReady ? this.lastReady : null;
    if (this.readyShown) {
      if (this.hp.to !== this.report.health || changed) this._animHealth();
      this.lastReady = rd;
    }
    this._render();
    this.showPart(this.scene.sel);
    if (changed) this._payoff(changed, rd);
  }

  /** Pushes the rows (report order) and the part tints to the scene. */
  _sync() {
    const sc = this.scene;
    if (!this.on || !sc.entry || sc.entry.def !== this.def || !this.report) return;
    const list = [];
    for (const id of this.report.order) {
      const r = this.byId.get(id);
      const part = r ? this._pidx(r.part) : -1;
      if (part < 0) continue;
      list.push({ id, part, p: r.p, n: r.n, t: r.t, type: r.type, size: r.size, color: SEVERITY[r.sev]?.color || SEVERITY.high.color, status: r.status });
    }
    this.sdefs = sc.setDefects(list);
    const hidden = this.scan === 'pending' || this.scan === 'idle';
    if (hidden) for (const d of this.sdefs) d.reveal = d.revealT = 0; // nothing shows before the AI scan passes
    this._tint(!hidden);
    sc.defectSel = this.selId;
    sc.defectHover = this.hoverId;
  }
  _tint(on) {
    const sc = this.scene;
    sc.parts.forEach((p, i) => {
      const s = on ? this.report.parts[p.code]?.status : null;
      sc.setHealth(i, s && s !== 'ok' ? PART_STATUS[s]?.color || null : null);
    });
  }

  _pidx(code) {
    if (this.scene.entry?.def !== this.def) return -1;
    return this.scene.parts.findIndex((p) => p.code === code);
  }
  _label(code) {
    const p = this.parts.find((x) => x.code === code);
    return p ? (p.alt ? `${code} ${p.alt}` : p.name) : String(code);
  }
  _seq(id) {
    return 1 + this._hist().filter((h) => h.id === id && h.kind === 'repair').length;
  }
  _repeat(r) {
    if (r.source === 'sample' || !r.added) return false;
    return this._hist().some((h) => h.closed && h.part === r.part && h.id !== r.id && String(h.at) < String(r.added));
  }
  _srcTag() {
    if (this.rows.some((r) => r.source === 'sample')) return '(예시)';
    if (this.rows.some((r) => r.source === 'import')) return '(불러온 결과)';
    return this.rows.length ? '(수동 등록)' : '';
  }
  _started() {
    return !!document.getElementById('start')?.classList.contains('gone');
  }
  /** First unresolved defect in report order after `fromId` (open ones come first), or null. */
  _nextOpen(fromId) {
    const ids = this.report?.order || [];
    // defects still needing work (open, or repaired awaiting inspection); monitored ones wait for the next inspection
    const todo = ids.filter((id) => id !== fromId && this.byId.get(id) && this.byId.get(id).status !== 'closed' && !this._watched(this.byId.get(id)));
    return todo.length ? this.byId.get(todo[0]) : null;
  }
  /** Next equipment of the fleet to look at: the next one with unresolved defects, else simply the next. */
  _nextEquipment() {
    const f = this.fleet;
    if (f.length < 2) return null;
    const k = f.findIndex((x) => x.def === this.def);
    const order = k < 0 ? f : [...f.slice(k + 1), ...f.slice(0, k)]; // a dropped model: every fleet member
    return order.find((x) => x.todo > 0) || order[0];
  }

  /** Writes a defect state change (+ log) and recomputes everything. */
  _commit(d, log) {
    const st = this._st();
    const o = {};
    for (const k of FIELDS) if (d[k] !== undefined) o[k] = d[k];
    st.overrides[d.id] = o;
    if (log) st.history.push({ part: d.part, id: d.id, ...log, closed: d.status === 'closed' && !d.fp });
    st.seq++;
    this._save();
    this._recompute();
  }

  // ------------------------------------------------------------------ SQUAD LINK (live link, read-only)
  _loadSquad() {
    let v = null;
    try {
      v = JSON.parse(localStorage.getItem(STORE_SQUAD) || 'null');
    } catch {
      v = null;
    }
    const map = v && v.map && typeof v.map === 'object' && !Array.isArray(v.map) ? { ...DEFAULT_MAP, ...v.map } : { ...DEFAULT_MAP };
    return { map, seen: Array.isArray(v?.seen) ? v.seen.filter((k) => typeof k === 'string') : [] };
  }
  _saveSquad() {
    try {
      localStorage.setItem(STORE_SQUAD, JSON.stringify(this.squad));
    } catch {
      /* ignore */
    }
  }
  /** Same-origin bridge path first (squad_bridge.mjs / Vite proxy); when the user asks, also the default local bridge. */
  _liveConnect(user) {
    let here = false;
    try {
      here = location.origin === new URL(BRIDGE).origin;
    } catch {
      /* file:// */
    }
    this.liveTry = user && !here ? [BRIDGE] : [];
    this.liveUser = !!user;
    this.link.start('squad/api/');
  }
  _onLinkStatus(st) {
    if (st === 'unavailable' && this.liveTry.length) {
      this.link.start(this.liveTry.shift());
      return;
    }
    if (st === 'lost') this.toast('SQUAD LINK 연결 끊김 — 재연결 중', 2600);
    else if (st === 'live' && this.liveWas === 'lost') this.toast('SQUAD LINK 다시 연결됨', 2200);
    else if (st === 'unavailable' && this.liveUser) this.toast('SQUAD LINK 중계 서버를 찾지 못했습니다 (tools/squad_bridge.mjs)', 3200);
    if (st === 'live' || st === 'unavailable') this.liveUser = false;
    this.liveWas = st;
    this._renderLive();
    this._renderFleet();
  }
  /** A control-server snapshot: signals -> inspection rows of the mapped equipment (only when something changed). */
  _onSquad(snap) {
    const map = this.squad.map;
    let res;
    try {
      const { signals, restored } = liveSignals(snap, map, this.squad.seen.filter((k) => k.startsWith('cond:')));
      const rows = {};
      for (const key of new Set(Object.values(map).filter(Boolean))) rows[key] = this._rowsFor(key);
      res = reconcile({ signals, restored, seen: this.squad.seen, rows, anchors: ANCHORS, at: new Date().toISOString() });
    } catch (e) {
      console.error('SQUAD LINK reconcile failed', e);
      return;
    }
    const old = this.squad.seen;
    if (res.seen.length !== old.length || res.seen.some((k, i) => k !== old[i])) {
      this.squad.seen = res.seen;
      this._saveSquad();
    }
    if (res.add.length || res.bump.length || res.clear.length) this._applyLive(res);
    this._renderLive();
    this._renderFleet();
  }
  _applyLive({ add, bump, clear }) {
    const at = new Date().toISOString();
    const name = (key) => this.scene.models.find((m) => m.key === key)?.name || key;
    const notes = [], fresh = [];
    for (const { model, row, sig } of add) {
      const st = this._st(model);
      const taken = new Set([...this._rowsFor(model).map((r) => r.id), ...st.removed, ...st.history.map((h) => h.id)]);
      row.id = this._newId('S', taken);
      st.added.push(row);
      const R = RULES[sig.kind];
      st.history.push({ at, kind: 'live', id: row.id, part: row.part, wo: '', by: '', text: `실시간 신호 → 점검 항목 등록 — ${R.ko}${sig.sim ? ' (가상 데이터)' : ''}: ${sig.text}` });
      notes.push(`${sig.node} ${R.ko} → ${name(model)} ${row.part} 점검 (#${row.id})`);
      if (model === this.key) fresh.push(row.id);
    }
    for (const { model, id, sig } of bump) {
      const st = this._st(model);
      const row = st.added.find((r) => r.id === id);
      if (!row?.live) continue;
      row.live.count = (row.live.count || 1) + 1;
      row.live.last = sig.at || at;
      row.cause = sig.text;
      st.history.push({ at, kind: 'live', id, part: row.part, wo: '', by: '', text: `실시간 신호 반복 (${row.live.count}회) — ${sig.text}` });
      notes.push(`${sig.node} ${RULES[sig.kind].ko} 반복 ${row.live.count}회 → #${id}`);
    }
    for (const { model, id, sig } of clear) {
      const st = this._st(model);
      const row = st.added.find((r) => r.id === id);
      if (!row) continue;
      // nothing to inspect once the node reports again: closed like a checked-out signal (not a repair)
      st.overrides[id] = { ...(st.overrides[id] || {}), status: 'closed', fp: true, wait: null, monitored: null };
      st.history.push({ at, kind: 'clear', id, part: row.part, wo: '', by: '', text: `${sig.node} 통신 복구 — 점검 불필요, 자동 종료` });
      notes.push(`${sig.node} 통신 복구 → #${id} 자동 종료`);
    }
    for (const model of new Set([...add, ...bump, ...clear].map((x) => x.model))) this._st(model).seq++;
    this._save();
    this._recompute();
    for (const id of fresh) this.popAt.set(id, nowS());
    if (notes.length && this.on) this.toast(`실시간 · ${notes[0]}${notes.length > 1 ? ` 외 ${notes.length - 1}건` : ''}`, 3600);
  }
  /** Nodes of the control server with their mapping and state. */
  _liveNodes() {
    const snap = this.link.snap;
    const { soldiers, env } = nodesOf(snap, this.link.config);
    const out = [];
    for (const node of soldiers) {
      const s = (snap?.soldiers || []).find((x) => x.assigned_node_id === node);
      const st = s?.connection_state || 'waiting';
      out.push({ node, cls: 'soldier', model: this.squad.map[node] || '', state: st, ko: { connected: '연결', lost: '두절', waiting: '대기' }[st] || st, color: { connected: GREEN, lost: SEVERITY.mid.color }[st] || GREY });
    }
    for (const node of env) {
      const t = (snap?.telemetry || []).find((x) => x.node_id === node && x.packet_type === 'environment');
      const st = !t ? 'none' : t.data_stale ? 'stale' : 'recv';
      out.push({ node, cls: 'env', model: this.squad.map[node] || '', state: st, ko: { recv: '수신', stale: '끊김', none: '미수신' }[st], color: st === 'recv' ? GREEN : st === 'stale' ? SEVERITY.mid.color : GREY });
    }
    return out;
  }
  _modelName(key) {
    return this.scene.models.find((m) => m.key === key)?.name || key;
  }
  _renderLive() {
    if (!this.on || !this.$live) return;
    const st = this.link.status, snap = this.link.snap;
    let text, btn = '', title = '';
    if (st === 'live' && snap) {
      const sim = snap.source === 'simulation';
      const nodes = this._liveNodes().filter((n) => n.model);
      text = `SQUAD LINK 실시간 · <span class="${sim ? 'lv-sim' : 'lv-dev'}">${sim ? '가상 데이터' : '실장비'}</span>${nodes.map((n) => ` · ${esc(n.node)} <b style="color:${n.color}">${esc(n.ko)}</b>`).join('')}`;
      title = [...this._liveNodes().map((n) => `${n.node} → ${n.model ? this._modelName(n.model) : '연결 안 함'} (${n.ko})`), '읽기 전용 — 관제 서버로는 아무것도 보내지 않습니다'].join('\n');
      btn = this.liveMapOpen ? '닫기' : '연결 설정';
    } else if (st === 'connecting') text = 'SQUAD LINK 연결 중…';
    else if (st === 'lost') {
      const t = snap?.server_time ? new Date(snap.server_time) : null;
      text = `SQUAD LINK 연결 끊김 — 재연결 중${t && !Number.isNaN(t.getTime()) ? ` (마지막 수신 ${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())})` : ''}`;
    } else {
      text = '실시간 연동 꺼짐 — SQUAD LINK 중계 서버 없음';
      btn = '연결';
      title = 'SQUAD LINK 관제 서버를 실시간으로 따라가려면 node tools/squad_bridge.mjs 를 실행하고 http://localhost:8095/#maint 를 여세요 (이 화면에서 연결을 누르면 localhost:8095 를 시도합니다)';
    }
    const html = `<i></i><span class="lv-t">${text}</span>${btn ? `<button data-live="${st === 'live' ? 'map' : 'connect'}" data-air>${btn}</button>` : ''}`;
    if (html !== this._liveHtml || this.$live.dataset.st !== st) {
      this._liveHtml = html;
      this.$live.innerHTML = html;
      this.$live.dataset.st = st;
      this.$live.className = `dg-live ${st}`;
    }
    this.$live.title = title;
    const showMap = this.liveMapOpen && st === 'live';
    this.$map.hidden = !showMap;
    if (showMap) this._renderMap();
  }
  /** Node -> equipment selects (soldier nodes: HaloPod models; environment nodes: the installation, Turret). */
  _renderMap() {
    const nodes = this._liveNodes();
    const kinds = (cls) => Object.keys(RULES).filter((k) => RULES[k].node === cls);
    const fits = (cls) => this.scene.models.filter((m) => m.key && (ANCHORS[m.key] || []).some((a) => kinds(cls).includes(a.id)));
    const html = nodes
      .map((n) => `<label>${esc(n.node)}</label><select data-node="${esc(n.node)}"><option value="">연결 안 함</option>${fits(n.cls).map((m) => `<option value="${esc(m.key)}"${m.key === n.model ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select>`)
      .join('') + '<p>병사 노드(halo) = HaloPod · 환경 노드(env) = 설치 지점(Turret 가정) · 변경은 이후 신호부터 적용</p>';
    if (html !== this._mapHtml) {
      this._mapHtml = html;
      this.$map.innerHTML = html;
    }
  }

  // ------------------------------------------------------------------ scan
  _startScan(kind = 'full') {
    const sc = this.scene;
    if (!this.on || !sc.entry || sc.entry.def !== this.def || this.scan === 'running') return;
    this.scanKind = kind;
    if (kind === 'full') {
      this.revealed.clear();
      this.readyShown = false;
      this.flipAt = 0;
      this.hp.shown = null;
    }
    this.scan = 'running';
    this.popAt.clear();
    this._tint(true); // the shader shows the tint where the sweep has passed
    sc.startScan(2.4);
    this._render();
  }
  _onReveal(id) {
    if (!this.on) return;
    this.popAt.set(id, nowS());
    if (this.scanKind === 'full') {
      this.revealed.add(id);
      if (this.tab === 'defects') this._renderBody();
    }
    if (id === this.reinspectId && !this.passAnim) this.passAnim = { id, t0: nowS() };
  }
  _onScanEnd() {
    if (!this.on || this.scan !== 'running') return;
    this.scan = 'done';
    this.scanEndAt = nowS();
    if (this.scanKind === 'full') this.flipAt = nowS() + 0.3;
    if (this.reinspectId && !this.passAnim) this.passAnim = { id: this.reinspectId, t0: nowS() };
    this._render();
  }

  // ------------------------------------------------------------------ readiness payoff
  _animHealth() {
    const from = this.hp.shown ?? this.report.health;
    this.hp = { from, to: this.report.health, t0: this.now, shown: from };
  }
  _payoff(from, to) {
    const el = this.$ready;
    el.classList.remove('pay');
    void el.offsetWidth; // restart the animation
    el.classList.add('pay');
    this.toast(`${this.def.name}: ${koShort(from)} → ${koShort(to)}`, 3000);
    const pill = this.$fleet.querySelector(`[data-key="${CSS.escape(this.key)}"]`);
    if (pill) {
      pill.classList.remove('pulse');
      void pill.offsetWidth;
      pill.classList.add('pulse');
    }
  }

  // ------------------------------------------------------------------ CTA
  _cta() {
    const sc = this.scene;
    if (!this.report || !sc.entry || sc.entry.def !== this.def) return { label: '모델 불러오는 중…', disabled: true };
    if (this.scan === 'running') {
      const pct = Math.round(sc.scanProgress * 100);
      return { label: this.scanKind === 'reinspect' ? `AI 재검사 중… ${pct}%` : `AI 판독 결과 표시 중… ${pct}%`, disabled: true };
    }
    if (this.passAnim) return { label: 'AI 재검사 — 결함 미검출', disabled: true };
    if (this.scan !== 'done' || !this.readyShown) return { label: 'AI 판독 결과 표시', disabled: !this._started() || this.flipAt > 0, run: () => this._startScan('full') };
    const r = this.byId.get(this.selId);
    const T = (x) => TYPES[x.type]?.ko || x.type;
    if (r && r.status === 'open' && !(this._watched(r) && !this.formOpen)) {
      if (this.tab !== 'repair') return { label: '수리 절차 보기', run: () => this._proceed(r.id) };
      const plan = this._getPlan();
      if (this.formOpen) return { label: '결과 입력 후 등록 ↓', run: () => this._openForm() };
      if (!plan) return { label: '정비 결과 입력', run: () => this._openForm() };
      const set = this._checks(), n = plan.steps.length;
      if (set.size < n) {
        if (this.stepIdx < 0) return { label: `다음 단계 (${plan.steps.findIndex((s) => !set.has(s.id)) + 1}/${n})`, run: () => this._nextStep() };
        const k = plan.steps.findIndex((s, j) => j !== this.stepIdx && !set.has(s.id));
        return { label: k < 0 ? `단계 완료 (${n}/${n})` : `다음 단계 (${k + 1}/${n})`, run: () => this._nextStep() };
      }
      return { label: '정비 결과 입력', run: () => this._openForm() };
    }
    if (r && r.status === 'repaired') {
      if (r.source === 'sample') return { label: 'AI 재검사', run: () => this._reinspectAI(r.id) };
      return { label: '검사 결과 입력', run: () => this._openForm() };
    }
    const next = this._nextOpen(r?.id ?? null);
    if (next) return { label: `${r ? '다음 결함' : '최우선 결함 보기'} · ${next.id} ${T(next)}`, run: () => this.selectDefect(next.id) };
    if (this.fleet.find((f) => f.def === this.def)?.todo === 0 && this.fleet.every((f) => f.todo === 0)) return { label: '점검할 결함 없음', disabled: true };
    const eq = this._nextEquipment();
    if (eq) {
      return {
        label: `다음 장비 점검 · ${eq.def.name}`,
        run: () => {
          this.toast(`다음 장비: ${eq.def.name}`);
          this.switchModel(eq.index);
        },
      };
    }
    return { label: '점검할 결함 없음', disabled: true };
  }
  /** Stepper stage: 0 검출, 1 진단, 2 수리, 3 재검사, 4 all done (follows the selected defect). */
  _stage() {
    if (!this.readyShown) return 0;
    const r = this.byId.get(this.selId);
    if (!r) return 1;
    return r.status === 'open' ? 2 : r.status === 'repaired' ? 3 : 4;
  }
  /** "Go on" with a defect: open -> 수리 tab at its first open step; awaiting inspection -> the CTA. */
  _proceed(id) {
    if (id !== this.selId) this.selectDefect(id);
    const r = this.byId.get(id);
    if (!r) return;
    if (r.status === 'open') {
      if (this.tab !== 'repair') this.setTab('repair');
      const plan = this._getPlan();
      if (plan && this.stepIdx < 0) {
        const set = this._checks();
        const k = plan.steps.findIndex((s) => !set.has(s.id));
        if (k >= 0) this._showStep(k);
      }
    } else if (r.status === 'repaired') this.cta();
  }

  // ------------------------------------------------------------------ repair plan + procedure
  _getPlan() {
    const r = this.byId.get(this.selId);
    if (!r) return null;
    const seq = this._seq(r.id);
    const key = [this.key, r.id, r.status, r.sev, r.size, r.escalated, r.condemned, r.wait, seq].join('|');
    if (key !== this.planKey) {
      this.planKey = key;
      try {
        this.plan = repairPlan({ defect: r, parts: this.parts, kb: this._kb(), modelKey: this.key, seq });
      } catch (e) {
        console.error('repairPlan failed', e);
        this.plan = null;
      }
    }
    return this.plan;
  }
  _checks() {
    const p = this._getPlan();
    const k = `${this.key}|${p?.wo || this.selId}`;
    if (!this.checks.has(k)) this.checks.set(k, new Set());
    return this.checks.get(k);
  }

  /** Shows step k: the scene takes the access parts out per §5 of the spec. */
  _showStep(k) {
    const plan = this._getPlan();
    const s = plan?.steps[k];
    if (!s) return;
    this.stepIdx = k;
    const idx = (code) => this._pidx(code);
    const many = (codes) => codes.map(idx).filter((i) => i >= 0);
    const target = idx(plan.part);
    const replace = plan.action === 'replace';
    let spec;
    if (s.kind === 'remove' && s.part === plan.part) spec = { target, removed: many(plan.access), current: target, phase: 'out' };
    else if (s.kind === 'remove') {
      const j = plan.access.indexOf(s.part);
      spec = { target, removed: many(j < 0 ? [] : plan.access.slice(0, j)), current: idx(s.part), phase: 'out' };
    } else if (s.kind === 'work') spec = { target, removed: [...many(plan.access), ...(replace ? [target] : [])].filter((i) => i >= 0), current: -1 };
    else spec = { target, removed: [], current: -1 }; // prep / install (everything flies back) / verify / record
    this.scene.setProcedure(spec);
    // close-up while working on the defect, the whole assembly while parts come off or go back
    const sc = this.scene;
    if (s.kind === 'work') sc.focusDefect(this.selId);
    else if (s.kind === 'remove' || s.kind === 'install') {
      if (sc.focus) sc.focusDefect(null);
      sc.scaleTarget = sc.fitScale(0.7);
    }
    this._markSteps();
  }
  _nextStep() {
    const plan = this._getPlan();
    if (!plan) return;
    const set = this._checks();
    if (this.stepIdx >= 0 && plan.steps[this.stepIdx]) set.add(plan.steps[this.stepIdx].id);
    const nx = plan.steps.findIndex((s) => !set.has(s.id));
    if (nx < 0) this._openForm();
    else this._showStep(nx);
  }
  _check(k, on) {
    const plan = this._getPlan();
    const s = plan?.steps[k];
    if (!s) return;
    const set = this._checks();
    if (on) set.add(s.id);
    else set.delete(s.id);
    if (set.size >= plan.steps.length) this._openForm();
    else this._markSteps();
  }
  _togglePlay() {
    if (this.play) return this._stopPlay();
    const plan = this._getPlan();
    if (!plan) return;
    if (this.stepIdx < 0 || this.stepIdx >= plan.steps.length - 1) this._showStep(0);
    this.play = { next: this.now + (STEP_TIME[plan.steps[this.stepIdx]?.kind] || 3) };
    this._markSteps();
  }
  _playStep() {
    const plan = this._getPlan();
    const k = this.stepIdx + 1;
    if (!plan || k >= plan.steps.length) return this._stopPlay();
    this._showStep(k);
    this.play.next = this.now + (STEP_TIME[plan.steps[k].kind] || 3);
  }
  _stopPlay() {
    if (!this.play) return;
    this.play = null;
    this._markSteps();
  }
  /** Updates the step list in place (no re-render, so a half-filled form keeps its focus). */
  _markSteps() {
    if (!this.on || this.tab !== 'repair') return;
    const plan = this._getPlan();
    const set = plan ? this._checks() : new Set();
    let cur = null;
    this.$body.querySelectorAll('.mt-step').forEach((li) => {
      const k = +li.dataset.k, s = plan?.steps[k];
      li.classList.toggle('cur', k === this.stepIdx);
      li.classList.toggle('done', !!s && set.has(s.id));
      const cb = li.querySelector('input');
      if (cb) cb.checked = !!s && set.has(s.id);
      if (k === this.stepIdx) cur = li;
    });
    const pb = this.$body.querySelector('[data-act="play"]');
    if (pb) pb.textContent = this.play ? '❚❚ 일시 정지' : '▶ 절차 재생';
    const pg = this.$body.querySelector('.mt-prog');
    if (pg && plan) pg.textContent = `${set.size}/${plan.steps.length} 완료`;
    cur?.scrollIntoView({ block: 'nearest' });
    this._renderNext();
  }

  /** Maintenance shows every part (defects on a hidden part could not be seen or focused). */
  _showAll() {
    this.scene.parts.forEach((p) => !p.visible && this.setPartVisible(p.i, true));
  }
  _resetForm() {
    this.formOpen = false;
    Object.assign(this.form, { result: 'done', reason: 'capability', memo: '', measured: '', minutes: null });
  }
  _openForm() {
    const r = this.byId.get(this.selId);
    if (!r) return;
    if (this.formOpen && this.tab === 'repair') {
      // already open: never touch the technician's choices, just bring the submit button into view
      const btn = this.$body.querySelector('.mt-form [data-act="submit"], .mt-form [data-act="reinspect"], .mt-form [data-act="pass"]');
      btn?.scrollIntoView({ block: 'nearest' });
      btn?.classList.add('air-hot');
      setTimeout(() => btn?.classList.remove('air-hot'), 900);
      this._markSteps();
      return;
    }
    this.formOpen = true;
    if (this.tab !== 'repair') {
      this.tab = 'repair';
      this._render(true);
    } else this._renderBody();
    this.$body.querySelector('.mt-form')?.scrollIntoView({ block: 'nearest' });
  }

  // ------------------------------------------------------------------ feedback loop
  _submit() {
    const r = this.byId.get(this.selId);
    if (!r || r.status !== 'open') return;
    const plan = this._getPlan();
    const f = this.form;
    const by = String(f.by ?? this.by ?? '').trim();
    const typed = f.minutes == null ? plan?.minutes : f.minutes === '' ? null : +f.minutes; // untouched = plan value
    const fb = { result: f.result, at: new Date().toISOString(), by, memo: String(f.memo || '').trim(), minutes: typed > 0 ? typed : null };
    if (f.result === 'fail') fb.reason = f.reason === 'supply' ? 'supply' : 'capability';
    if (f.result === 'partial' && +f.measured > 0) fb.measured = +f.measured;
    let out;
    try {
      out = applyFeedback(r, fb, { modelKey: this.key, seq: this._seq(r.id), planned: plan?.minutes, kb: this._kb(), level: this.report.defects[r.id]?.level });
    } catch (e) {
      console.error('applyFeedback failed', e);
      this.toast('정비 결과를 등록하지 못했습니다');
      return;
    }
    if (by !== this.by) this._saveBy(by);
    const d = out.defect;
    const msg = d.monitored && d.status === 'open' && f.result === 'done'
      ? `#${r.id} 관찰 등록 — 다음 정기 점검 시 재측정`
      : {
          done: `#${r.id} 정비 완료 — 검사 대기`,
          partial: `#${r.id} 부분 수리 — 심각도 ${SEVERITY[d.sev]?.ko || d.sev}`,
          false: r.source === 'manual' ? `#${r.id} 등록 취소 — 결함 아님` : r.source === 'live' ? `#${r.id} 이상 없음 — 점검 종료` : `#${r.id} 오탐 처리 — AI 재학습 데이터로 기록`,
        }[f.result] || out.log?.text || '정비 결과 등록';
    this.toast(msg, 2600);
    this._resetForm();
    this._stopPlay();
    this.scene.setProcedure(null);
    this.scene.resetParts();
    this.stepIdx = -1;
    this._commit(d, out.log);
  }

  /** Sample rows only: a simulated AI re-inspection replays the scan; the defect closes when it is reached. */
  _reinspectAI(id) {
    const r = this.byId.get(id);
    if (!r || r.status !== 'repaired' || r.source !== 'sample' || this.scan === 'running') return;
    this.reinspectId = id;
    this._startScan('reinspect');
  }
  _passDone() {
    const id = this.passAnim.id;
    this.passAnim = this.reinspectId = null;
    const r = this.byId.get(id);
    if (!r || r.status !== 'repaired' || r.source !== 'sample') return this._render();
    let out;
    try {
      out = reinspect(r, { at: new Date().toISOString(), pass: true, by: this.by, simulated: true });
    } catch (e) {
      console.error('reinspect failed', e);
      return this._render();
    }
    this.toast(`#${id} AI 재검사(시뮬레이션·예시): 결함 미검출 → 해결`, 2600);
    this._commit(out.defect, out.log);
  }
  /** Manual / imported rows: an inspector records pass or fail (never simulated). */
  _inspect(pass) {
    const r = this.byId.get(this.selId);
    if (!r || r.status !== 'repaired') return;
    const by = String(this.form.insp ?? this.by ?? '').trim();
    let out;
    try {
      out = reinspect(r, { at: new Date().toISOString(), pass, by, simulated: false });
    } catch (e) {
      console.error('reinspect failed', e);
      return;
    }
    if (by && by !== this.by) this._saveBy(by);
    this._resetForm();
    this.toast(pass ? `#${r.id} 재검사 합격 → 해결` : `#${r.id} 재검사 불합격 → 재작업 지시`, 2600);
    this._commit(out.defect, out.log);
  }

  // ------------------------------------------------------------------ add / remove / import / export
  _setAdd(on) {
    if (on === this.addMode) return;
    if (on && !this.scene.entry) return;
    this.addMode = on;
    document.body.classList.toggle('mt-adding', on);
    this.banner(on ? '결함 위치를 클릭하세요 · Esc 취소' : '', true);
    if (!on && this.float?.classList.contains('mt-add')) this._closeFloat();
  }
  _addForm(hit, x, y) {
    this._closeFloat();
    this.addPick = { x, y, hit };
    const f = this.addVals;
    f.size = '8';
    f.memo = '';
    const el = document.createElement('div');
    el.className = 'mt-float mt-add';
    const opts = (table, cur) => Object.entries(table).map(([k, v]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${esc(v.ko)}</option>`).join('');
    el.innerHTML = `
      <div class="mf-h"><b>결함 추가</b><span>${esc(this._label(hit.code))}</span><button data-fa="x" title="취소 (Esc)">✕</button></div>
      <p class="mf-xyz">STL ${hit.p.map((v) => (+v).toFixed(2)).join(', ')} mm</p>
      <div class="mf-grid">
        <label>유형<select data-ff="type">${opts(TYPES, f.type)}</select></label>
        <label>심각도<select data-ff="sev">${opts(SEVERITY, f.sev)}</select></label>
        <label>크기(mm)<input type="number" data-ff="size" min="0.5" step="0.5" value="8" /></label>
      </div>
      <input type="text" data-ff="memo" placeholder="메모 (선택)" />
      <p class="mf-pre"></p>
      <button class="mf-ok" data-fa="ok" data-air>등록</button>`;
    document.body.appendChild(el);
    this.float = el;
    const preview = () => {
      let a = null;
      try {
        a = assess({ id: 'new', part: hit.code, type: f.type, sev: f.sev, size: +f.size || 8, conf: null, source: 'manual', status: 'open', escalated: 0, condemned: false }, this._kb()?.parts?.[hit.code] || null, hit.code, this._kb());
      } catch {
        /* preview only */
      }
      el.querySelector('.mf-pre').textContent = a ? `예상 판정: ${a.priority} ${PRIORITY[a.priority]?.ko || ''} · ${ACTIONS[a.action]?.ko || ''} · ${LEVELS[a.level]?.ko || ''}` : '';
    };
    const read = (e) => {
      const k = e.target.dataset.ff;
      if (!k) return;
      f[k] = e.target.value;
      preview();
    };
    el.addEventListener('input', read);
    el.addEventListener('change', read);
    el.addEventListener('click', (e) => {
      const a = e.target.closest('[data-fa]')?.dataset.fa;
      if (a === 'x') this.escape();
      else if (a === 'ok') this._addRow(hit);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.escape();
      else if (e.key === 'Enter' && e.target.tagName === 'INPUT') this._addRow(hit);
    });
    preview();
    this._placeFloat(el, x, y);
    el.querySelector('select')?.focus({ preventScroll: true });
  }
  _placeFloat(el, x, y) {
    const W = innerWidth, H = innerHeight, w = el.offsetWidth || 240, h = el.offsetHeight || 220;
    let left = x + 22;
    if (left + w > W - this.insets.r - 8) left = x - 22 - w;
    el.style.left = `${clamp(left, 8, W - w - 8)}px`;
    el.style.top = `${clamp(y - 48, 60, H - h - 12)}px`;
  }
  _addRow(hit) {
    const f = this.addVals;
    const st = this._st();
    const taken = new Set([...this.rows.map((r) => r.id), ...st.removed, ...st.history.map((h) => h.id)]);
    const id = this._newId('U', taken);
    const at = new Date().toISOString();
    const row = {
      id, part: hit.code, type: TYPES[f.type] ? f.type : 'crack', sev: SEVERITY[f.sev] ? f.sev : 'mid', p: hit.p, n: hit.n, size: +f.size > 0 ? +f.size : 8,
      conf: null, memo: String(f.memo || '').trim(), found: today(), added: at,
      source: 'manual', status: 'open', escalated: 0, wait: null, rework: 0, condemned: false, fp: false,
    };
    st.added.push(row);
    st.history.push({ at, kind: 'add', id, part: row.part, wo: '', text: `결함 수동 등록 — ${TYPES[row.type].ko} · ${SEVERITY[row.sev].ko} · ${mm(row.size)} mm`, by: this.by, memo: row.memo });
    this._save();
    this._closeFloat();
    this._setAdd(false);
    this.tab = 'defects';
    this._recompute();
    this.popAt.set(id, nowS());
    this.selectDefect(id);
    this.toast(`#${id} 결함 등록 (수동)`);
  }
  _newId(prefix, taken) {
    let n = 0;
    const re = new RegExp(`^${prefix}(\\d+)$`);
    for (const id of taken) {
      const m = re.exec(String(id));
      if (m) n = Math.max(n, +m[1]);
    }
    return prefix + (n + 1);
  }
  _remove(id) {
    const r = this.byId.get(id);
    if (!r) return;
    if (r.source !== 'manual') {
      this.toast('수동 등록한 결함만 삭제할 수 있습니다');
      return;
    }
    const st = this._st();
    st.added = st.added.filter((x) => x.id !== id);
    delete st.overrides[id];
    st.history.push({ at: new Date().toISOString(), kind: 'remove', id, part: r.part, wo: '', text: '수동 등록 결함 삭제', by: this.by });
    this._save();
    if (this.selId === id) this.selectDefect(null);
    this._recompute();
    this.toast(`#${id} 삭제`);
  }

  _import(text, name = '') {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      this._notice('불러오기 실패', [`JSON 형식이 아닙니다 (${e.message})`]);
      return;
    }
    const groups = Array.isArray(data)
      ? [[this.key, data]]
      : data && typeof data === 'object'
        ? Object.entries(data).filter(([k, v]) => !k.startsWith('_') && Array.isArray(v))
        : [];
    if (!groups.length) {
      this._notice('불러올 결함이 없습니다', ['형식: web/defects.json 과 같은 { "Turret": [ … ] } 또는 현재 장비의 배열 [ … ]']);
      return;
    }
    const at = new Date().toISOString();
    const res = { added: 0, other: 0, skipped: [], renamed: [], ids: new Set() };
    for (const [key, list] of groups) {
      const def = this.scene.models.find((m) => keyOf(m) === key);
      if (!def) {
        res.skipped.push(`${key}: 알 수 없는 장비 (${list.length}건)`);
        continue;
      }
      const codes = new Set(this._partsFor(def).map((p) => p.code));
      const st = this._st(key);
      const taken = new Set([...this._rowsFor(key).map((r) => r.id), ...st.removed, ...st.history.map((h) => h.id)]);
      let n = 0;
      for (const raw of list) {
        const label = `${key === this.key ? '' : def.name + ' '}${raw?.id ?? '(id 없음)'}`;
        const why = raw?.source === 'sample' ? '예시 데이터는 불러오지 않음' : raw?.status === 'closed' || raw?.fp ? '해결·오탐 처리된 결함' : this._invalid(raw, codes);
        if (why) {
          res.skipped.push(`${label}: ${why}`);
          continue;
        }
        let id = String(raw.id ?? '').trim();
        if (!id || taken.has(id)) {
          const nid = this._newId('I', taken);
          res.renamed.push(`${label} → ${nid}`);
          id = nid;
        }
        taken.add(id);
        const conf = raw.conf === null || raw.conf === '' || raw.conf === undefined || !Number.isFinite(+raw.conf) ? null : clamp(+raw.conf, 0, 1);
        const row = {
          id, part: raw.part, type: raw.type, sev: raw.sev, p: raw.p.map(Number), size: +raw.size, conf,
          found: typeof raw.found === 'string' ? raw.found : today(), added: at,
          source: 'import', status: 'open', escalated: 0, wait: null, rework: 0, condemned: false, fp: false,
        };
        if (isVec(raw.n)) row.n = raw.n.map(Number);
        if (isVec(raw.t)) row.t = raw.t.map(Number);
        if (+raw.depth > 0) row.depth = +raw.depth;
        if (typeof raw.cause === 'string') row.cause = raw.cause;
        st.added.push(row);
        n++;
        if (key === this.key) res.ids.add(id);
        else res.other++;
      }
      if (n) st.history.push({ at, kind: 'import', id: '', part: '', wo: '', text: `결함 ${n}건 불러옴${name ? ` (${name})` : ''}`, by: this.by });
      res.added += n;
    }
    this._save();
    this.tab = 'defects';
    this._recompute();
    for (const id of res.ids) this.popAt.set(id, nowS());
    // the scene snaps every point onto the surface: list the rows that were far off or had a reversed normal
    const far = (this.sdefs || [])
      .filter((d) => res.ids.has(d.id) && (d.snap > 2 || d.flipped))
      .map((d) => `${d.id}: ${[d.snap > 2 ? `표면까지 ${d.snap.toFixed(1)} mm 보정` : '', d.flipped ? '법선 반대 → 표면 법선 사용' : ''].filter(Boolean).join(' · ')}`);
    const lines = [`추가 ${res.added}건${res.other ? ` (다른 장비 ${res.other}건 — 해당 장비를 열면 표시)` : ''}`];
    if (res.renamed.length) lines.push(`ID 변경 ${res.renamed.length}건: ${res.renamed.join(', ')}`);
    if (res.skipped.length) lines.push(`건너뜀 ${res.skipped.length}건: ${res.skipped.join(' / ')}`);
    if (far.length) lines.push(`위치 확인 필요 ${far.length}건: ${far.join(' / ')}`);
    this._notice('결함 불러오기', lines);
  }
  _invalid(r, codes) {
    if (!r || typeof r !== 'object') return '형식 오류';
    if (!TYPES[r.type]) return `유형 '${r.type}' 미지원`;
    if (!SEVERITY[r.sev]) return `심각도 '${r.sev}' 미지원`;
    if (!(+r.size > 0)) return '크기 없음';
    if (!isVec(r.p)) return '좌표(p) 오류';
    if (!codes.has(r.part)) return `부품 '${r.part}' 없음`;
    return '';
  }
  _notice(title, lines) {
    this._closeFloat();
    const el = document.createElement('div');
    el.className = 'mt-float mt-note';
    el.innerHTML = `<div class="mf-h"><b>${esc(title)}</b></div>${lines.map((l) => `<p>${esc(l)}</p>`).join('')}<button class="mf-ok" data-fa="ok" data-air>확인</button>`;
    el.addEventListener('click', (e) => e.target.closest('[data-fa]') && this._closeFloat());
    document.body.appendChild(el);
    this.float = el;
    const L = this.insets.l, R = innerWidth - this.insets.r;
    el.style.left = `${clamp((L + R) / 2 - el.offsetWidth / 2, 8, innerWidth - el.offsetWidth - 8)}px`;
    el.style.top = '64px';
  }
  _closeFloat() {
    this.float?.remove();
    this.float = null;
    this.addPick = null;
  }

  _exportRows() {
    return this.rows.map((r) => {
      const { added, ...rest } = r;
      return { ...rest, ...(added ? { added } : {}) };
    });
  }
  /** 내보내기: the defects in the web/defects.json format (can be imported again). */
  _export() {
    const data = { _comment: `${NOTICE} · 출처(source): sample = 예시, manual = 수동 입력, import = 불러옴, live = 실시간(SQUAD LINK)`, generated: new Date().toISOString(), [this.key]: this._exportRows() };
    download(`${fileKey(this.key)}-defects-${today()}.json`, JSON.stringify(data, null, 2));
    this.toast('결함 목록을 JSON으로 저장했습니다');
  }
  /** JSON 저장: everything (defects with source, history, the report, AI feedback rows). */
  _saveJson() {
    const rep = this.report;
    const data = {
      _notice: NOTICE,
      generated: new Date().toISOString(),
      kb: '예시 지식베이스',
      equipment: this.def?.name || '',
      key: this.key,
      readiness: { status: rep.readiness.status, ko: rep.readiness.ko, reasons: rep.readiness.reasons, deferred: rep.readiness.deferred },
      health: rep.health,
      defects: this._exportRows(),
      history: this._hist(),
      report: rep,
      aiFeedback: this.rows.filter((r) => r.fp && r.source !== 'manual' && r.source !== 'live').map((r) => ({ id: r.id, part: r.part, type: r.type, sev: r.origSev || r.sev, p: r.p, n: r.n, conf: r.conf ?? null, source: r.source, label: '오탐 (결함 아님)' })),
    };
    download(`${fileKey(this.key)}-maintenance-${today()}.json`, JSON.stringify(data, null, 2));
    this.toast('정비 기록을 JSON으로 저장했습니다');
  }
  _reset() {
    const name = this.def?.name || '';
    if (!confirm(`${name}의 정비 이력·추가 결함·조치 상태를 모두 지웁니다. 계속할까요?`)) return;
    delete this.store[this.key];
    this._save();
    for (const k of [...this.checks.keys()]) if (k.startsWith(this.key + '|')) this.checks.delete(k);
    this.selectDefect(null);
    this.scan = 'done';
    this._recompute();
    this._startScan('full');
    this.toast(`${name}: 초기화했습니다`);
  }

  /** True when this repaired defect keeps the equipment NO-GO until it passes re-inspection. */
  _holds(id) {
    return !!this.report?.readiness.holds?.includes(id);
  }
  /** 관찰 등록 done and still a monitor job: handled for the guided flow (tracked at the next inspection). */
  _watched(r) {
    return !!r && r.status === 'open' && !!r.monitored && this.report?.defects[r.id]?.action === 'monitor';
  }
  _statusKo(r) {
    return r.fp ? (r.source === 'live' ? '이상 없음' : '오탐') : STATUS[r.status]?.ko || r.status;
  }
  _confText(r) {
    if (r.source === 'manual') return '수동 등록';
    if (r.source === 'live') return `실시간 ${r.live?.node || ''}${r.live?.count > 1 ? ` · ${r.live.count}회` : ''}`.trim();
    return r.conf != null && Number.isFinite(+r.conf) ? `AI 신뢰도 ${Math.round(r.conf * 100)}%` : '신뢰도 없음';
  }
  _escalation(a) {
    return a.level && a.baseLevel && a.level !== a.baseLevel ? `${LEVELS[a.level]?.ko || a.level} 의뢰됨` : '';
  }

  /** Printable report in a new tab (Blob URL); falls back to a file when pop-ups are blocked. */
  _report() {
    if (!this.report) return;
    const html = this._reportHtml();
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const w = window.open(url, '_blank');
    if (!w) {
      download(`${fileKey(this.key)}-report-${today()}.html`, html, 'text/html');
      this.toast('팝업이 막혀 보고서를 파일로 저장했습니다');
    }
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }
  _reportHtml() {
    const rep = this.report, rd = rep.readiness;
    const rows = rep.order.map((id) => this.byId.get(id)).filter(Boolean);
    const hist = [...this._hist()].reverse();
    const sample = rows.some((r) => r.source === 'sample');
    const sim = hist.some((h) => /시뮬레이션/.test(h.text || ''));
    const liveSim = rows.some((r) => r.source === 'live' && r.live?.sim);
    const live = rows.some((r) => r.source === 'live');
    const T = (r) => TYPES[r.type] || { ko: r.type, measure: '크기' };
    const fleet = this.fleet
      .map((f) => {
        const c = f.report.counts, r = f.report.readiness;
        return `<tr><td>${esc(f.def.name)}</td><td><b style="color:${r.color}">${esc(rdLabel(r.status))}</b></td><td>${f.report.health}%</td><td>${c.open + c.repaired}</td><td>${c.P1}</td><td>${c.closed}</td></tr>`;
      })
      .join('');
    const defects = rows
      .map((r, k) => {
        const a = rep.defects[r.id] || {};
        const extra = [this._escalation(a), r.condemned ? '불용 판정' : '', r.wait === 'supply' ? '보급 대기' : '', a.needsConfirm && r.status === 'open' ? '확인 필요' : ''].filter(Boolean).join(', ');
        return `<tr class="${r.status}"><td>${k + 1}</td><td>${esc(r.id)}</td><td>${esc(this._label(r.part))}</td><td>${esc(T(r).ko)}</td><td>${esc(SEVERITY[r.sev]?.ko || r.sev)}</td><td>${T(r).measure ? `${esc(T(r).measure)} ${mm(r.size)} mm` : '—'}</td><td>${esc(this._confText(r))}</td><td>${esc(SOURCES[r.source]?.ko || r.source)}${r.live?.sim ? ' (가상)' : ''}${r.source === 'live' && r.cause ? `<br><small>${esc(r.cause)}</small>` : ''}</td><td>${r.status === 'closed' ? '—' : esc(`${a.priority || ''} ${PRIORITY[a.priority]?.ko || ''}`)}</td><td>${r.status === 'closed' ? '—' : esc(ACTIONS[a.action]?.ko || '')}</td><td>${r.status === 'closed' ? '—' : esc(LEVELS[a.level]?.ko || '')}</td><td>${esc(this._statusKo(r))}${extra ? `<br><small>${esc(extra)}</small>` : ''}</td></tr>`;
      })
      .join('');
    const plans = rows
      .filter((r) => r.status !== 'closed')
      .map((r) => {
        let p;
        try {
          p = repairPlan({ defect: r, parts: this.parts, kb: this._kb(), modelKey: this.key, seq: this._seq(r.id) });
        } catch {
          return '';
        }
        return `<tr><td>${esc(p.wo)}</td><td>${esc(r.id)} ${esc(T(r).ko)}</td><td>${esc(ACTIONS[p.action]?.ko || p.action)}</td><td>${esc(LEVELS[p.level]?.ko || p.level)}</td><td>${p.minutes}분 (예시)</td><td>${esc(p.access.join(' → ') || '—')}</td><td>${p.steps.length}단계</td></tr>`;
      })
      .join('');
    const history = hist
      .map((h) => `<tr><td>${esc(stamp(h.at, true))}</td><td>${esc(h.wo || '')}</td><td>${esc(KIND[h.kind] || h.kind || '')}</td><td>${esc(h.text || '')}${h.memo ? `<br><small>메모: ${esc(h.memo)}</small>` : ''}</td><td>${esc(h.by || '')}</td><td>${h.minutes ? `${h.minutes}분${h.planned ? ` / 계획 ${h.planned}분 (예시)` : ''}` : ''}</td></tr>`)
      .join('');
    const notice = sample || sim || liveSim;
    const css = `
      body { font: 13px/1.5 system-ui, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif; color: #1b1f2a; margin: 28px 32px ${notice ? '64px' : '28px'}; }
      h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 22px 0 8px; border-bottom: 1px solid #ccd; padding-bottom: 4px; }
      .meta { color: #556; font-size: 12px; } .rd { font-size: 18px; font-weight: 700; }
      table { width: 100%; border-collapse: collapse; font-size: 11.5px; } th, td { border: 1px solid #ccd3e0; padding: 4px 6px; text-align: left; vertical-align: top; }
      th { background: #eef2f8; } tr.closed td { color: #889; } small { color: #667; }
      ul { margin: 4px 0; padding-left: 18px; } .note { color: #a33; font-weight: 600; }
      .foot { position: fixed; left: 0; right: 0; bottom: 0; padding: 8px 32px; background: #fff3d6; border-top: 1px solid #e0b860; font-size: 11.5px; font-weight: 600; }
      @media print { body { margin: 12mm 10mm ${notice ? '18mm' : '12mm'}; } h2 { break-after: avoid; } tr { break-inside: avoid; } }`;
    const reasons = rd.reasons?.length ? `<ul>${rd.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
    const deferred = rd.deferred?.length ? `<p>이월 정비 (운용 영향 없음): ${rd.deferred.map(esc).join(', ')}</p>` : '';
    return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>정비 진단 보고서 (시연용)</title><style>${css}</style></head><body>
<h1>정비 진단 보고서 (시연용)</h1>
<p class="meta">장비: ${esc(this._kb()?.equipment || this.def?.name || '')} · 작성 ${esc(stamp(new Date().toISOString(), true))} · 지식베이스: 예시 지식베이스${sample ? ' · 결함 데이터: 예시 포함' : ''}${live ? ` · 실시간 연동: SQUAD LINK (${liveSim ? '가상 데이터' : '실장비'}) — 신호는 점검 위치 안내이며 손상 확정이 아님` : ''}</p>
<h2>장비 상태</h2>
<p><span class="rd" style="color:${rd.color}">${esc(rdLabel(rd.status))}</span> &nbsp; 건강도 ${rep.health}% &nbsp; 미조치 결함 ${rep.counts.open}건 (P1 ${rep.counts.P1} · P2 ${rep.counts.P2} · P3 ${rep.counts.P3}) · 검사 대기 ${rep.counts.repaired}건 · 해결 ${rep.counts.closed}건</p>
${reasons}${deferred}
<h2>전체 장비</h2>
<table><tr><th>장비</th><th>운용 상태</th><th>건강도</th><th>미해결 결함</th><th>P1</th><th>해결</th></tr>${fleet}</table>
<h2>결함 목록</h2>
<table><tr><th>#</th><th>ID</th><th>부품</th><th>유형</th><th>심각도</th><th>크기</th><th>신뢰도</th><th>출처</th><th>우선순위</th><th>조치</th><th>정비 단계</th><th>상태</th></tr>${defects || '<tr><td colspan="12">결함 없음</td></tr>'}</table>
<h2>정비 계획 요약</h2>
<table><tr><th>작업지시</th><th>결함</th><th>조치</th><th>정비 단계</th><th>예상 시간</th><th>분해 순서</th><th>절차</th></tr>${plans || '<tr><td colspan="7">미해결 결함 없음</td></tr>'}</table>
<h2>정비 이력</h2>
<table><tr><th>시각</th><th>작업지시</th><th>구분</th><th>내용</th><th>정비자</th><th>소요 / 계획</th></tr>${history || '<tr><td colspan="6">이력 없음</td></tr>'}</table>
${notice ? `<div class="foot">${esc(NOTICE)}${sim ? ' · AI 재검사는 시뮬레이션(예시)' : ''}${liveSim ? ' · 실시간 신호는 SQUAD LINK 가상 데이터' : ''} · 시연용 보고서</div>` : ''}
</body></html>`;
  }

  // ------------------------------------------------------------------ DOM: panel
  _dom() {
    const $ = (id) => document.getElementById(id);
    this.$diag = $('diag');
    this.$ready = $('dg-ready');
    this.$health = $('dg-health');
    this.$hbar = $('dg-hbar');
    this.$counts = $('dg-counts');
    this.$reason = $('dg-reason');
    this.$eq = $('dg-eq');
    this.$odot = $('dg-odot');
    this.$fleet = $('dg-fleet');
    this.$steps = $('dg-steps');
    this.$cta = $('dg-cta');
    this.$tabs = $('dg-tabs');
    this.$body = $('dg-body');
    this.$chip = $('b-maint');
    this.$live = $('dg-live');
    this.$map = $('dg-map');
    this.$live.addEventListener('click', (e) => {
      const b = e.target.closest('[data-live]');
      if (!b) return;
      if (b.dataset.live === 'map') {
        this.liveMapOpen = !this.liveMapOpen;
        this._renderLive();
      } else this._liveConnect(true);
    });
    this.$map.addEventListener('change', (e) => {
      const node = e.target.dataset?.node;
      if (!node) return;
      this.squad.map[node] = e.target.value;
      this._saveSquad();
      this.toast(`${node} → ${e.target.value ? this._modelName(e.target.value) : '연결 안 함'}`);
      if (this.link.snap) this._onSquad(this.link.snap);
    });
    this.$file = document.createElement('input');
    Object.assign(this.$file, { type: 'file', accept: '.json,application/json', hidden: true, id: 'mt-file' });
    document.body.appendChild(this.$file);
    this.$file.onchange = async () => {
      const f = this.$file.files[0];
      this.$file.value = '';
      if (!f) return;
      try {
        this._import(await f.text(), f.name);
      } catch (e) {
        this._notice('불러오기 실패', [String(e.message || e)]);
      }
    };
    this.$chip.onclick = () => this.toggle();
    this.$cta.onclick = () => this.cta();
    $('dg-col').onclick = () => this.collapse(true);
    $('dg-open').onclick = () => this.collapse(false);
    this.$tabs.onclick = (e) => {
      const b = e.target.closest('[data-tab]');
      if (b) this.setTab(b.dataset.tab);
    };
    this.$fleet.onclick = (e) => {
      const b = e.target.closest('[data-i]');
      if (b && +b.dataset.i !== this.scene.index) this.switchModel(+b.dataset.i);
    };
    this.$body.addEventListener('click', (e) => this._bodyClick(e));
    this.$body.addEventListener('change', (e) => this._bodyField(e));
    this.$body.addEventListener('input', (e) => this._bodyField(e));
    this.$body.addEventListener('mouseover', (e) => this._netHover(e.target));
    this.$body.addEventListener('mouseleave', () => this._netHover(null));
    // buttons hand the keyboard back to the page, so M / N / Enter keep working after a click
    // (radios keep the focus: arrow keys move inside the group instead of switching the equipment)
    this.$diag.addEventListener('click', (e) => e.target.closest?.('button, summary, input[type="checkbox"]')?.blur());
    // any pointer input pauses the procedure playback (except the play button itself)
    addEventListener('pointerdown', (e) => {
      if (this.on && !e.target.closest?.('[data-act="play"]')) this.noteInput();
    }, true);
  }

  _render(resetScroll = false) {
    if (!this.on) return;
    this._renderHead();
    this._renderLive();
    this._renderFleet();
    this._renderNext();
    this.$tabs.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === this.tab));
    this._renderBody(resetScroll);
  }

  _renderHead() {
    const rep = this.report;
    this.$eq.textContent = this.def?.name || '';
    if (!rep) return;
    const rd = rep.readiness, shown = this.readyShown;
    const label = shown ? rdLabel(rd.status) : this.scan === 'running' && this.scanKind === 'full' ? '판독 중…' : '판독 대기';
    if (this.$ready.textContent !== label) this.$ready.textContent = label;
    const col = shown ? rd.color : GREY;
    this.$ready.style.setProperty('--c', col);
    this.$diag.style.setProperty('--rd', col);
    this.$ready.classList.toggle('grey', !shown);
    const c = rep.counts;
    const n = (v, color) => `<b style="color:${color}">${v}</b>`;
    this.$counts.innerHTML = shown
      ? `위험 ${n(c.high, SEVERITY.high.color)} · 주의 ${n(c.mid, SEVERITY.mid.color)} · 경미 ${n(c.low, SEVERITY.low.color)}<i>|</i>P1 ${n(c.P1, PRIORITY.P1.color)} · P2 ${n(c.P2, PRIORITY.P2.color)} · P3 ${n(c.P3, PRIORITY.P3.color)}${c.repaired ? ` <i>|</i>검사 대기 ${n(c.repaired, BLUE)}` : ''}`
      : '<span class="muted">AI 판독 결과를 표시하면 집계됩니다</span>';
    const reasons = rd.reasons || [];
    const first = shown ? reasons[0] || (rd.status === 'GO' ? `운용 영향 결함 없음${rd.deferred?.length ? ` · 이월 정비 ${rd.deferred.length}건` : ''}` : '') : '';
    this.$reason.textContent = first;
    this.$reason.title = shown ? [...reasons, rd.deferred?.length ? `이월 정비 (운용 영향 없음): ${rd.deferred.join(', ')}` : ''].filter(Boolean).join('\n') : '';
    this.$odot.style.background = col;
    this._renderHealth();
  }
  _renderHealth() {
    const v = this.readyShown ? this.hp.shown ?? this.report?.health ?? 0 : null;
    const txt = v == null ? '—' : `${Math.round(v)}%`;
    if (this.$health.textContent !== txt) this.$health.textContent = txt;
    this.$hbar.style.width = `${v == null ? 0 : clamp(v, 0, 100)}%`;
  }

  _renderFleet() {
    if (!this.on) return;
    const live = this.link.status === 'live' ? this._liveNodes() : [];
    const html = this.fleet
      .map((f) => {
        const rd = f.report.readiness, c = f.report.counts, active = f.def === this.def;
        const pending = active && !this.readyShown;
        const open = (c.open || 0) + (c.repaired || 0);
        const sub = pending ? '판독 중…' : open ? (c.P1 ? `P1 ${c.P1}건 · 결함 ${open}건` : `결함 ${open}건`) : '미해결 결함 없음';
        const col = pending ? GREY : rd.color;
        const lv = live.filter((n) => n.model === f.key).map((n) => `<em style="color:${n.color}" title="SQUAD LINK ${esc(n.node)} ${esc(n.ko)}"> · ${esc(n.node)}</em>`).join('');
        return `<button class="dg-pill${active ? ' on' : ''}" data-i="${f.index}" data-key="${esc(f.key)}" data-air title="${esc(f.def.name)} — ${esc(pending ? '판독 중' : rdLabel(rd.status))}"><i style="background:${col};color:${col}"></i><span><b>${esc(f.def.name)}</b><small>${esc(sub)}${lv}</small></span></button>`;
      })
      .join('');
    if (html !== this._fleetHtml) {
      this._fleetHtml = html;
      this.$fleet.innerHTML = html;
    }
  }

  _renderNext() {
    if (!this.on) return;
    const st = this._cta();
    if (this.$cta.textContent !== st.label) this.$cta.textContent = st.label;
    if (this.$cta.disabled !== !!st.disabled) this.$cta.disabled = !!st.disabled;
    const stage = this._stage();
    if (stage !== this._stageShown) {
      this._stageShown = stage;
      this.$steps.querySelectorAll('li').forEach((li, k) => {
        li.classList.toggle('done', k < stage);
        li.classList.toggle('cur', k === stage);
      });
    }
  }

  _renderBody(resetScroll = false) {
    if (!this.on) return;
    const b = this.$body;
    const top = b.scrollTop;
    this._netKey = null;
    b.innerHTML = !this.report
      ? '<p class="mt-empty">모델을 불러오는 중입니다.</p>'
      : this.tab === 'net'
        ? this._htmlNet()
        : this.tab === 'repair'
          ? this._htmlRepair()
          : this.tab === 'history'
            ? this._htmlHistory()
            : this._htmlDefects();
    b.scrollTop = resetScroll ? 0 : top;
    b.querySelector(this.tab === 'repair' ? '.mt-step.cur' : '.mt-row.sel')?.scrollIntoView({ block: 'nearest' });
  }

  _htmlDefects() {
    const rep = this.report;
    const tools = `<div class="mt-tools">
      <button data-act="rescan" data-air${this.scan === 'running' || !this._started() ? ' disabled' : ''}>판독 결과 다시 보기</button>
      <button data-act="add" data-air>결함 추가</button>
      <button data-act="import">불러오기</button>
      <button data-act="export">내보내기</button>
      <button data-act="reset" class="warn">초기화</button>
    </div>`;
    if (this.scan === 'pending') return tools + '<p class="mt-empty">판독 대기 — AI 판독 결과를 표시하면 결함이 여기에 나열됩니다.</p>';
    const scanning = this.scan === 'running' && this.scanKind === 'full';
    const num = new Map(rep.order.map((id, k) => [id, k + 1]));
    const rows = rep.order.map((id) => this.byId.get(id)).filter((r) => r && (!scanning || this.revealed.has(r.id)));
    let html = rows.map((r) => this._htmlRow(r, num.get(r.id))).join('');
    if (scanning) html += `<li class="mt-wait">AI 판독 결과 표시 중… ${this.revealed.size}건</li>`;
    else if (!rows.length) html = '<li class="mt-wait">결함 없음 — 결함 추가 또는 불러오기로 등록할 수 있습니다.</li>';
    return `${tools}<ul class="mt-list">${html}</ul>`;
  }
  _htmlRow(r, n) {
    const a = this.report.defects[r.id] || {};
    const S = SEVERITY[r.sev] || SEVERITY.mid, T = TYPES[r.type] || { ko: r.type, measure: '크기' };
    const closed = r.status === 'closed';
    const chip = (text, cls = '', color = '') => `<span class="chip ${cls}"${color ? ` style="--c:${color}"` : ''}>${esc(text)}</span>`;
    const chips = [];
    if (r.source === 'sample') chips.push(chip('예시', 'src'));
    else if (r.source === 'import') chips.push(chip('불러옴', 'src'));
    else if (r.source === 'live') {
      chips.push(chip('실시간', 'live'));
      if (r.live?.sim) chips.push(chip('가상 데이터', 'src'));
    }
    if (!closed && a.priority) chips.push(chip(`${a.priority} ${PRIORITY[a.priority]?.ko || ''}`, 'col', PRIORITY[a.priority]?.color));
    const stc = r.fp ? GREY : r.status === 'open' ? '' : STATUS[r.status]?.color || '';
    chips.push(chip(this._statusKo(r), stc ? 'col' : 'st', stc));
    if (!closed && a.needsConfirm) chips.push(chip('확인 필요', 'warn'));
    const escl = !closed && this._escalation(a);
    if (escl) chips.push(chip(escl, 'warn'));
    if (r.condemned) chips.push(chip('불용 판정', 'col', SEVERITY.high.color));
    if (r.wait === 'supply' && !closed) chips.push(chip('보급 대기', 'warn'));
    if (this._watched(r)) chips.push(chip('관찰 등록', 'col', SEVERITY.low.color));
    if (this._repeat(r)) chips.push(chip('반복 결함', 'warn'));
    const badge = closed ? GREEN : r.status === 'repaired' ? BLUE : S.color;
    const pop = this.popAt.has(r.id) && this.now - this.popAt.get(r.id) < 0.6 ? ' pop' : '';
    return `<li class="mt-row${r.id === this.selId ? ' sel' : ''}${closed ? ' closed' : ''}${pop}" data-act="sel" data-id="${esc(r.id)}" data-air>
      <i class="mt-num" style="background:${badge};color:${inkOn(badge)}">${closed ? '✓' : r.status === 'repaired' ? '✓' : n}</i>
      <div class="mt-main">
        <div class="mt-l1"><b>#${esc(r.id)} ${esc(T.ko)}</b><span class="mt-sev" style="color:${S.color}">${esc(S.ko)}</span><span class="mt-code">${esc(r.part)}</span></div>
        <div class="mt-l2">${esc(this._label(r.part))}${T.measure ? ` · ${esc(T.measure)} ${mm(r.size)} mm` : ''} · ${esc(this._confText(r))}</div>
        ${r.source === 'live' && r.cause ? `<div class="mt-cause" title="${esc(r.cause)}">${esc(r.cause)}</div>` : ''}
        <div class="mt-chips">${chips.join('')}</div>
      </div>
      ${r.source === 'manual' ? `<button class="mt-del" data-act="del" data-id="${esc(r.id)}" title="수동 등록 결함 삭제 (Delete)">✕</button>` : ''}
    </li>`;
  }

  /** 기능망: parts -> functions -> equipment as an inline SVG (viewBox width = panel body width). */
  _htmlNet() {
    const rep = this.report, kb = this._kb();
    const head = `<div class="mt-net-head"><b>부품 → 기능 → 장비 영향</b><span class="seg"><button data-act="net" data-v="0" class="${this.netAll ? '' : 'on'}">문제 경로</button><button data-act="net" data-v="1" class="${this.netAll ? 'on' : ''}">전체 부품</button></span></div>`;
    const funcs = [...(rep.functions || [])].sort((a, b) => (b.critical ? 1 : 0) - (a.critical ? 1 : 0));
    if (!funcs.length || !kb) return head + '<p class="mt-empty">이 장비의 기능 정보(지식베이스)가 없습니다. 결함 판정은 기본값으로 계산됩니다.</p>';
    const W = Math.max(300, Math.round(this.$body.clientWidth - 6));
    const fIdx = new Map(funcs.map((f, k) => [f.id, k]));
    const links = (code) => Object.entries(kb.parts?.[code]?.functions || {}).filter(([fid]) => fIdx.has(fid));
    const status = (code) => rep.parts[code]?.status || 'ok';
    const mean = (code) => {
      const l = links(code);
      return l.length ? l.reduce((s, [fid]) => s + fIdx.get(fid), 0) / l.length : 1e3;
    };
    const parts = this.parts
      .filter((p) => this.netAll || status(p.code) !== 'ok')
      .map((p) => ({ ...p, m: mean(p.code) }))
      .sort((a, b) => a.m - b.m || a.code.localeCompare(b.code, undefined, { numeric: true }));
    const TOP = 20, ROW = 20;
    const py = new Map(parts.map((p, k) => [p.code, TOP + k * ROW + 10]));
    // function rows: barycentre of their parts, kept in order with >= 28 px between them
    const fy = new Map();
    let prev = -Infinity;
    for (const f of funcs) {
      const ys = parts.filter((p) => links(p.code).some(([fid]) => fid === f.id)).map((p) => py.get(p.code));
      let y = ys.length ? ys.reduce((s, v) => s + v, 0) / ys.length : prev + 28;
      y = Math.max(y, prev + 28, TOP + 11);
      fy.set(f.id, y);
      prev = y;
    }
    const firstY = fy.get(funcs[0].id), lastY = prev;
    const H = Math.max(TOP + parts.length * ROW, lastY + 11) + 34;
    const fcol = (f) => FUNC_STATUS[f.status]?.color || GREY;
    const pcol = (code) => PART_STATUS[status(code)]?.color || GREY;
    // edges: ok ones first (faint), problem ones last (2 px, part status colour)
    const edges = [];
    for (const p of parts) {
      for (const [fid, kind] of links(p.code)) {
        const y1 = py.get(p.code), y2 = fy.get(fid), bad = status(p.code) !== 'ok';
        const d = `M84 ${y1} C112 ${y1} 112 ${y2} 140 ${y2}`;
        edges.push({ bad, svg: `<path class="e" data-code="${esc(p.code)}" data-fid="${esc(fid)}" d="${d}" fill="none" stroke="${bad ? pcol(p.code) : 'rgba(255,255,255,0.18)'}" stroke-width="${bad ? 2 : 1}"${kind === 'degrade' ? ' stroke-dasharray="3 3"' : ''}/>` });
      }
    }
    edges.sort((a, b) => a.bad - b.bad);
    measureCtx.font = `600 11.5px ${SANS}`;
    const pnodes = parts
      .map((p) => {
        const y = py.get(p.code), pr = rep.parts[p.code];
        return `<g class="np" data-act="np" data-code="${esc(p.code)}"><title>${esc(p.name)}${p.alt ? ` (${esc(p.alt)})` : ''} · 건강도 ${pr?.health ?? 100}% · ${esc(PART_STATUS[status(p.code)]?.ko || '')}</title><rect x="0" y="${y - 10}" width="84" height="20" rx="4" class="hit"/><circle cx="6" cy="${y}" r="4" fill="${pcol(p.code)}"/><text x="14" y="${y + 3.5}" class="pc">${esc(p.code)}</text></g>`;
      })
      .join('');
    const fnodes = funcs
      .map((f) => {
        const y = fy.get(f.id), c = fcol(f);
        const name = fit(measureCtx, f.name, 106);
        return `<g class="nf${f.critical ? ' crit' : ''}" data-fid="${esc(f.id)}"><title>${esc(f.name)}${f.critical ? ' (핵심 기능)' : ''} — ${esc(FUNC_STATUS[f.status]?.ko || f.status)}\n점검: ${esc(f.check || '')}</title><rect x="140" y="${y - 11}" width="130" height="22" rx="6" fill="${rgba(c, f.status === 'ok' ? 0.06 : 0.16)}" stroke="${rgba(c, f.status === 'ok' ? 0.3 : 0.75)}"/>${f.critical ? `<rect x="140" y="${y - 11}" width="2" height="22" fill="${c}"/>` : ''}<circle cx="151" cy="${y}" r="3.5" fill="${c}"/><text x="159" y="${y + 4}" class="fn">${esc(name)}</text></g>`;
      })
      .join('');
    const rd = rep.readiness, rc = this.readyShown ? rd.color : GREY;
    const stubs = funcs.map((f) => `<line x1="270" y1="${fy.get(f.id)}" x2="292" y2="${fy.get(f.id)}" stroke="${f.status === 'ok' ? 'rgba(255,255,255,0.2)' : fcol(f)}" stroke-width="${f.status === 'ok' ? 1 : 2}"/>`).join('');
    const bus = `<rect x="292" y="${firstY - 11}" width="4" height="${lastY - firstY + 22}" rx="2" fill="${rc}"/><text x="294" y="${firstY - 16}" class="eq" text-anchor="middle">장비</text><text x="${W - 2}" y="${lastY + 26}" class="eq" text-anchor="end" fill="${rc}">${esc(this.readyShown ? rd.short || koShort(rd.status) : '판독 중')}</text>`;
    const empty = parts.length ? '' : `<text x="0" y="${TOP + 12}" class="pc dim">문제 부품 없음</text>`;
    const svg = `<svg class="mt-net" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><text x="0" y="11" class="cap">부품</text><text x="140" y="11" class="cap">기능</text>${edges.map((e) => e.svg).join('')}${pnodes}${empty}${stubs}${bus}${fnodes}</svg>`;
    return `${head}${svg}<p class="mt-legend"><span>— 필수</span> · <span>- - 성능 저하</span> · 점 색 = 부품 상태 · 굵은 테두리 = 핵심 기능</p>`;
  }
  _netHover(target) {
    const svg = this.$body.querySelector('svg.mt-net');
    if (!svg) return;
    const g = target?.closest?.('[data-code], [data-fid]');
    const code = g?.dataset.code || null, fid = g && !code ? g.dataset.fid : null;
    const key = code || fid ? `${code}|${fid}` : '';
    if (key === this._netKey) return;
    this._netKey = key;
    svg.classList.toggle('hov', !!key);
    svg.querySelectorAll('.e').forEach((p) => p.classList.toggle('hi', (!!code && p.dataset.code === code) || (!!fid && p.dataset.fid === fid)));
    if (code) {
      this.scene.setHover(this._pidx(code));
      this._netHovering = true;
    } else if (this._netHovering) {
      this.scene.setHover(-1);
      this._netHovering = false;
    }
  }
  /** 기능망 part click: select the part and its worst open defect. */
  _netPick(code) {
    const i = this._pidx(code);
    if (i >= 0) this.select(i);
    const id = this.report.order.find((x) => {
      const r = this.byId.get(x);
      return r && r.part === code && r.status !== 'closed';
    });
    if (id) this.selectDefect(id);
    else this.toast(`${code}: 미해결 결함 없음`);
  }

  _htmlRepair() {
    const r = this.byId.get(this.selId);
    if (!r) {
      const open = this.report.order.map((id) => this.byId.get(id)).filter((x) => x && x.status !== 'closed').slice(0, 6);
      return `<p class="mt-empty">결함을 선택하면 작업지시 · 분해 순서 · 정비 절차가 표시됩니다.</p>${open.length ? `<div class="mt-pick">${open.map((x) => `<button data-act="sel" data-id="${esc(x.id)}" data-air>#${esc(x.id)} ${esc(TYPES[x.type]?.ko || x.type)}</button>`).join('')}</div>` : ''}`;
    }
    const plan = this._getPlan();
    if (!plan) return '<p class="mt-empty">정비 계획을 만들지 못했습니다.</p>';
    const a = this.report.defects[r.id] || {};
    const T = TYPES[r.type] || { ko: r.type }, S = SEVERITY[r.sev] || SEVERITY.mid;
    const pri = plan.priority || a.priority, P = PRIORITY[pri] || {};
    const set = this._checks();
    const n = this.report.order.indexOf(r.id) + 1;
    const badge = r.status === 'closed' ? GREEN : r.status === 'repaired' ? BLUE : S.color;
    const head = `<div class="mt-wo">
      <div class="mt-wo1"><i class="mt-num" style="background:${badge};color:${inkOn(badge)}">${r.status === 'open' ? n : '✓'}</i><b>#${esc(r.id)} ${esc(T.ko)}</b><span class="mt-sev" style="color:${S.color}">${esc(S.ko)}</span><span class="mt-l2">${esc(this._label(r.part))}</span></div>
      <div class="mt-wo2">작업지시 <b>${esc(plan.wo)}</b> · 예상 ${plan.minutes}분 (예시) · ${esc(LEVELS[plan.level]?.ko || plan.level)} · ${esc(ACTIONS[plan.action]?.ko || plan.action)} · <b style="color:${P.color || '#fff'}">${esc(pri)} ${esc(P.ko || '')}</b></div>
    </div>`;
    const acc = plan.access.length
      ? `<div class="mt-acc"><span class="lbl">분해 순서</span>${plan.access.map((c) => `<span class="chip">${esc(c)}</span>`).join('<i>→</i>')}<i>→</i><span class="chip tgt">${esc(plan.part)}</span></div>`
      : `<div class="mt-acc"><span class="lbl">분해 없음</span><span class="chip tgt">${esc(plan.part)}</span><span class="muted">바로 작업</span></div>`;
    const safety = (plan.safety || []).length
      ? `<div class="mt-safety" title="${esc(plan.safety.join('\n'))}">${plan.safety.slice(0, 2).map((s) => `<p>⚠ ${esc(s)}</p>`).join('')}${plan.safety.length > 2 ? `<p class="more">외 ${plan.safety.length - 2}건 — 준비 단계 참조</p>` : ''}</div>`
      : '';
    const note = (r.source === 'live' && r.cause ? `<p class="mt-note live">실시간 신호 — ${esc(r.cause)}${r.live?.count > 1 ? ` (${r.live.count}회)` : ''}</p>` : '') + (plan.note ? `<p class="mt-note">${esc(plan.note)}</p>` : '');
    const steps = `<div class="mt-play"><button data-act="play" data-air>${this.play ? '❚❚ 일시 정지' : '▶ 절차 재생'}</button><span class="mt-prog">${set.size}/${plan.steps.length} 완료</span></div>
      <ol class="mt-steps">${plan.steps
        .map((s, k) => `<li class="mt-step${k === this.stepIdx ? ' cur' : ''}${set.has(s.id) ? ' done' : ''}" data-act="step" data-k="${k}" data-air><input type="checkbox" data-act="chk" data-k="${k}"${set.has(s.id) ? ' checked' : ''} aria-label="완료 표시" /><span class="k k-${esc(s.kind)}">${esc(STEP_KINDS[s.kind] || s.kind)}</span><span class="t">${esc(s.text)}</span></li>`)
        .join('')}</ol>`;
    const kb = this._kb()?.parts?.[plan.part];
    const det = `<details class="mt-det"><summary>공구·자재</summary><p><b>공구</b> ${esc((plan.tools || []).join(' · ') || '—')}</p><p><b>자재</b> ${esc((plan.materials || []).join(' · ') || '—')}</p>${plan.action === 'replace' && kb?.spare ? `<p><b>예비품</b> ${esc(kb.spare)}</p>` : ''}</details>
      <details class="mt-det"><summary>작동 점검 기준</summary><ul>${(plan.verify || []).map((v) => `<li>${esc(v)}</li>`).join('')}</ul></details>`;
    return head + acc + safety + note + steps + det + this._htmlForm(r, plan);
  }
  _htmlForm(r, plan) {
    if (r.status === 'closed') return `<div class="mt-form done"><p>${r.fp ? (r.source === 'manual' ? '등록 취소 — 결함 아님' : r.source === 'live' ? '이상 없음 — 실시간 신호 항목 종료' : '오탐 처리 — AI 재학습 데이터로 기록됨') : '해결 — 재검사 합격'}</p></div>`;
    if (r.status === 'repaired') {
      if (r.source === 'sample') {
        return `<div class="mt-form open insp"><p>정비 완료 — 검사 대기${this._holds(r.id) ? ' · 재검사 합격 전 운용 금지' : ''}</p><button class="mt-submit" data-act="reinspect" data-air${this.scan === 'running' ? ' disabled' : ''}>AI 재검사</button><small>시뮬레이션 재검사 — 예시 결함에만 사용합니다</small></div>`;
      }
      return `<div class="mt-form open insp"><p>정비 완료 — 검사 대기${this._holds(r.id) ? ' (합격 전 운용 금지)' : ''} · 검사자가 확인한 결과를 입력하세요</p>
        <label class="mt-insp">검사자<input type="text" data-f="insp" value="${esc(this.form.insp ?? this.by)}" placeholder="이름" /></label>
        <div class="mt-pf"><button class="mt-submit" data-act="pass" data-air>합격</button><button class="mt-submit bad" data-act="failInsp" data-air>불합격</button></div></div>`;
    }
    const f = this.form;
    const minutes = f.minutes ?? plan.minutes;
    return `<div class="mt-form${this.formOpen ? ' open' : ''}" data-res="${esc(f.result)}">
      <button class="mt-form-bar" data-act="form" data-air>정비 결과 등록 <span>${this.formOpen ? '▾' : '▴'}</span></button>
      <div class="mt-form-body">
        ${this._watched(r) ? `<p class="mt-mon">관찰 등록됨 (${esc(stamp(r.monitored))}) — 다음 정기 점검 때 다시 측정합니다</p>` : ''}
        <div class="mt-radios">${resultsFor(r, plan.action, plan.priority).map(([v, l]) => `<label data-air><input type="radio" name="mt-res" value="${v}"${f.result === v ? ' checked' : ''} />${l}</label>`).join('')}</div>
        <div class="mt-grid">
          <label class="f-fail">사유<select data-f="reason"><option value="capability"${f.reason !== 'supply' ? ' selected' : ''}>능력 부족 → 상급 정비 의뢰</option><option value="supply"${f.reason === 'supply' ? ' selected' : ''}>부품 없음 → 보급 대기</option></select></label>
          <label class="f-partial">잔여 크기 (mm)<input type="number" data-f="measured" min="0" step="0.1" value="${esc(f.measured)}" placeholder="${mm(r.size)}" /></label>
          <label>소요 시간 (분)<input type="number" data-f="minutes" min="0" step="1" value="${esc(minutes)}" /></label>
          <label>정비자<input type="text" data-f="by" value="${esc(f.by ?? this.by)}" placeholder="이름" /></label>
        </div>
        <div class="mt-row2"><input type="text" class="mt-memo" data-f="memo" value="${esc(f.memo)}" placeholder="메모 (선택)" /><button class="mt-submit" data-act="submit" data-air>정비 결과 등록</button></div>
      </div>
    </div>`;
  }

  _htmlHistory() {
    const hist = [...this._hist()].reverse();
    const tools = `<div class="mt-tools"><button data-act="report" data-air>보고서</button><button data-act="save" data-air>JSON 저장</button></div>`;
    if (!hist.length) return tools + '<p class="mt-empty">이력 없음 — 정비 결과를 등록하면 여기에 기록됩니다.</p>';
    const items = hist
      .map((h) => {
        const r = h.id ? this.byId.get(h.id) : null;
        const rep = h.kind === 'add' && r && this._repeat(r);
        const time = h.minutes ? `<span class="${h.planned && h.minutes > h.planned ? 'over' : ''}">${h.minutes}분${h.planned ? ` / 계획 ${h.planned}분 (예시)` : ''}</span>` : '';
        return `<li class="k-${esc(h.kind)}"><div class="h1"><span class="tm">${esc(stamp(h.at))}</span>${h.wo ? `<b>${esc(h.wo)}</b>` : h.id ? `<b>#${esc(h.id)}</b>` : ''}<span class="kd">${esc(KIND[h.kind] || h.kind || '')}</span>${rep ? '<span class="chip warn">반복 결함</span>' : ''}</div><div class="h2">${esc(h.text || '')}</div>${h.by || time || h.memo ? `<div class="h3">${h.by ? `정비자 ${esc(h.by)}` : ''}${h.by && time ? ' · ' : ''}${time}${h.memo ? ` · 메모: ${esc(h.memo)}` : ''}</div>` : ''}</li>`;
      })
      .join('');
    return `${tools}<ul class="mt-hist">${items}</ul>`;
  }

  _bodyClick(e) {
    const el = e.target.closest('[data-act]');
    if (!el || !this.$body.contains(el)) return;
    const { act, id, k, v } = el.dataset;
    switch (act) {
      case 'sel':
        this.selectDefect(id);
        break;
      case 'del':
        e.stopPropagation();
        this._remove(id);
        break;
      case 'rescan':
        this._startScan('full');
        break;
      case 'add':
        this._setAdd(true);
        break;
      case 'import':
        this.$file.click();
        break;
      case 'export':
        this._export();
        break;
      case 'reset':
        this._reset();
        break;
      case 'net':
        this.netAll = v === '1';
        this._renderBody();
        break;
      case 'np':
        this._netPick(el.dataset.code);
        break;
      case 'step':
        this._stopPlay();
        this._showStep(+k);
        break;
      case 'chk':
        this._check(+k, el.checked);
        break;
      case 'play':
        this._togglePlay();
        break;
      case 'form':
        this.formOpen = !this.formOpen;
        this._renderBody();
        if (this.formOpen) this.$body.querySelector('.mt-form')?.scrollIntoView({ block: 'nearest' });
        break;
      case 'submit':
        this._submit();
        break;
      case 'reinspect':
        this._reinspectAI(this.selId);
        break;
      case 'pass':
        this._inspect(true);
        break;
      case 'failInsp':
        this._inspect(false);
        break;
      case 'report':
        this._report();
        break;
      case 'save':
        this._saveJson();
        break;
    }
  }
  _bodyField(e) {
    const t = e.target;
    if (t.name === 'mt-res') {
      if (!t.checked) return;
      this.form.result = t.value;
      const fm = t.closest('.mt-form');
      if (fm) fm.dataset.res = t.value;
    } else if (t.dataset?.f) this.form[t.dataset.f] = t.value;
  }

  _gestCopy(on) {
    for (const li of document.querySelectorAll('#gest li')) {
      const m = GEST[li.dataset.g];
      const b = li.querySelector('b'), s = li.querySelector('span');
      if (!m || !b || !s) continue;
      if (on) {
        if (li.dataset.b == null) (li.dataset.b = b.textContent), (li.dataset.s = s.textContent);
        b.textContent = m[0];
        s.textContent = m[1];
      } else if (li.dataset.b != null) {
        b.textContent = li.dataset.b;
        s.textContent = li.dataset.s;
      }
    }
  }

  // ------------------------------------------------------------------ canvas overlay
  _screen() {
    if (this._scrFrame !== this.frame) {
      this._scrFrame = this.frame;
      this._scr = this.scene.defectScreen();
    }
    return this._scr;
  }
  _setHover(id) {
    id = id ?? null;
    if (id === this.hoverId) return;
    this.hoverId = id;
    this.scene.defectHover = id;
  }
  /** Defect whose badge centre or anchor is nearest to (x, y) within `rad` px. */
  _hit(x, y, rad) {
    let best = null, bd = rad;
    for (const h of this.hits) {
      const d = Math.min(Math.hypot(h.bx - x, h.by - y), Math.hypot(h.ax - x, h.ay - y));
      if (d <= bd) (bd = d), (best = h.id);
    }
    return best;
  }

  /** Markers (pins), the defect callout, the scan HUD and the procedure caption. Called from drawOverlay. */
  draw(ctx, W, H, t) {
    this.hits = [];
    this.callout = null;
    const sc = this.scene;
    if (!this.on || !this.report || !sc.entry || sc.entry.def !== this.def || sc.pending >= 0 || sc.pop < 0.6) return;
    const L = this.insets.l, R = W - this.insets.r, now = this.now;
    const hud = sc.hud();
    const num = new Map(this.report.order.map((id, k) => [id, k + 1]));
    const placed = [];
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const s of this._screen()) {
      if (s.reveal <= 0.02) continue;
      // a defect outside the free area gets no pin (it would pile up at the panel edge)
      if (s.x < L - 4 || s.x > R + 4 || s.y < -4 || s.y > H + 4) continue;
      const r = this.byId.get(s.id);
      if (!r) continue;
      // badge on a pin: away from the assembly centre, outside the detection ring, never on the defect
      let dx = s.x - (hud?.x ?? s.x), dy = s.y - (hud?.y ?? s.y);
      const len = Math.hypot(dx, dy);
      if (len < 1) (dx = 0.707), (dy = -0.707);
      else (dx /= len), (dy /= len);
      let off = Math.max(s.r, 4) + 16;
      let bx = s.x + dx * off, by = s.y + dy * off;
      for (let k = 0; k < 8 && placed.some((p) => Math.hypot(p.x - bx, p.y - by) < 22); k++) {
        off += 22;
        bx = s.x + dx * off;
        by = s.y + dy * off;
      }
      bx = clamp(bx, L + 12, R - 12);
      by = clamp(by, 12, H - 12);
      placed.push({ x: bx, y: by });
      this.hits.push({ id: s.id, bx, by, ax: s.x, ay: s.y, r: s.r });
      const a = this.report.defects[s.id] || {};
      const pass = this.passAnim?.id === s.id;
      const col = pass ? GREEN : r.status === 'repaired' ? BLUE : SEVERITY[r.sev]?.color || SEVERITY.high.color;
      const sel = s.id === this.selId, hov = s.id === this.hoverId;
      const pk = this.popAt.has(s.id) ? clamp((now - this.popAt.get(s.id)) / 0.18, 0, 1) : 1;
      const k = pk < 1 ? Math.max(0.01, easeBack(pk)) : 1;
      ctx.globalAlpha = s.occluded ? 0.5 : 1;
      // leader: anchor -> badge edge
      const ux = bx - s.x, uy = by - s.y, ul = Math.max(1, Math.hypot(ux, uy));
      ctx.strokeStyle = rgba(col, 0.7);
      ctx.lineWidth = 1;
      ctx.setLineDash(s.occluded ? [3, 3] : []);
      ctx.beginPath();
      ctx.moveTo(s.x + (ux / ul) * 3.5, s.y + (uy / ul) * 3.5);
      ctx.lineTo(bx - (ux / ul) * 9 * k, by - (uy / ul) * 9 * k);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
      // P1: pulsing halo
      if (a.priority === 'P1' && r.status === 'open') {
        const ph = (t % 1.2) / 1.2;
        ctx.strokeStyle = rgba(col, 0.6 * (1 - ph));
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(bx, by, (9 + 6 * ph) * k, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(bx, by, 9 * k * (hov && !sel ? 1.12 : 1), 0, Math.PI * 2);
      ctx.fill();
      if (sel || hov) {
        ctx.strokeStyle = sel ? ACCENT : rgba(ACCENT, 0.6);
        ctx.lineWidth = sel ? 2 : 1.5;
        ctx.beginPath();
        ctx.arc(bx, by, 12.5 * k, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (k > 0.5) {
        ctx.fillStyle = inkOn(col);
        ctx.font = `700 11px ${SANS}`;
        ctx.fillText(pass || r.status === 'repaired' ? '✓' : String(num.get(s.id) || ''), bx, by + 0.5);
      }
    }
    ctx.globalAlpha = 1;
    const cid = this.hoverId ?? this.selId;
    const ch = cid != null && this.hits.find((h) => h.id === cid);
    if (ch) this._drawCallout(ctx, ch, L, R, H);
    this._drawScanHud(ctx, L, R);
    this._drawCaption(ctx, L, R, H);
    if (this.addPick && this.float) {
      const { x, y } = this.addPick;
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.moveTo(x - 13, y);
      ctx.lineTo(x - 4, y);
      ctx.moveTo(x + 4, y);
      ctx.lineTo(x + 13, y);
      ctx.moveTo(x, y - 13);
      ctx.lineTo(x, y - 4);
      ctx.moveTo(x, y + 4);
      ctx.lineTo(x, y + 13);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawCallout(ctx, h, L, R, H) {
    const r = this.byId.get(h.id);
    if (!r) return;
    const a = this.report.defects[r.id] || {};
    const S = SEVERITY[r.sev] || SEVERITY.mid, T = TYPES[r.type] || { ko: r.type, measure: '크기' };
    const closed = r.status === 'closed';
    const l3 = closed
      ? r.fp ? (r.source === 'live' ? '이상 없음 (점검 종료)' : '오탐 처리 (결함 아님)') : '해결 — 재검사 합격'
      : [`${a.priority || ''} ${PRIORITY[a.priority]?.ko || ''}`.trim(), ACTIONS[a.action]?.ko, LEVELS[a.level]?.ko, r.status === 'repaired' ? '검사 대기' : ''].filter(Boolean).join(' · ');
    const l4 = r.status === 'open' ? '수리 절차 보기 ›' : r.status === 'repaired' ? (r.source === 'sample' ? 'AI 재검사 ›' : '검사 결과 입력 ›') : '';
    const lines = [
      { text: `#${r.id} ${T.ko} · ${S.ko}`, font: `700 14px ${SANS}`, color: S.color, h: 18 },
      { text: `${this._label(r.part)}${T.measure ? ` · ${T.measure} ${mm(r.size)} mm` : ''} · ${this._confText(r)}`, font: `500 11.5px ${SANS}`, color: '#d9edf5', h: 15 },
      { text: l3, font: `600 11.5px ${SANS}`, color: closed ? GREEN : PRIORITY[a.priority]?.color || '#fff', h: 15 },
      { text: l4, font: `600 11.5px ${SANS}`, color: ACCENT, h: 15 },
    ].filter((l) => l.text);
    const pad = 8, maxW = 248;
    let w = 0;
    for (const l of lines) {
      ctx.font = l.font;
      l.text = fit(ctx, l.text, maxW - pad * 2);
      w = Math.max(w, ctx.measureText(l.text).width);
    }
    w = Math.min(maxW, Math.ceil(w) + pad * 2);
    const bh = Math.min(72, pad + lines.reduce((s, l) => s + l.h, 0) + 4);
    // beside the badge, on the side away from the defect; never over the defect ring
    const ring = (x, y) => {
      const cx = clamp(h.ax, x, x + w), cy = clamp(h.ay, y, y + bh);
      return Math.hypot(cx - h.ax, cy - h.ay) < h.r + 10;
    };
    const yMid = clamp(h.by - bh / 2, 64, H - 140);
    const right = h.bx + 16, left = h.bx - 16 - w;
    const sides = h.bx >= h.ax ? [right, left] : [left, right];
    const cands = [];
    for (const x of sides) if (x >= L + 6 && x + w <= R - 12) cands.push([x, yMid]);
    const xr = clamp(sides[0], L + 6, R - 12 - w);
    cands.push([xr, clamp(h.ay - h.r - 14 - bh, 64, H - 140)], [xr, clamp(h.ay + h.r + 14, 64, H - 140)], [xr, yMid]);
    const [x, y] = cands.find(([cx, cy]) => !ring(cx, cy)) || cands[cands.length - 1];
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(3, 18, 30, 0.9)';
    ctx.strokeStyle = rgba(ACCENT, 0.45);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, w, bh, 8) : ctx.rect(x, y, w, bh);
    ctx.fill();
    ctx.stroke();
    if (r.id === this.selId) {
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2;
      const c = 9;
      ctx.beginPath();
      ctx.moveTo(x, y + c);
      ctx.lineTo(x, y);
      ctx.lineTo(x + c, y);
      ctx.moveTo(x + w - c, y + bh);
      ctx.lineTo(x + w, y + bh);
      ctx.lineTo(x + w, y + bh - c);
      ctx.stroke();
    }
    let ty = y + pad - 1;
    for (const l of lines) {
      ctx.font = l.font;
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, x + pad, ty);
      ty += l.h;
    }
    ctx.restore();
    this.callout = { x, y, w, h: bh, id: r.id };
  }

  _drawScanHud(ctx, L, R) {
    const running = this.scan === 'running';
    const fade = running ? 1 : this.scanEndAt > 0 ? clamp(1.6 - (this.now - this.scanEndAt), 0, 1) : 0;
    if (fade <= 0) return;
    const pct = Math.round((running ? this.scene.scanProgress : 1) * 100);
    const n = this.scanKind === 'full' ? this.revealed.size : 0;
    const text = this.scanKind === 'reinspect'
      ? `AI 재검사 (시뮬레이션·예시) ${pct}% · #${this.reinspectId || this.passAnim?.id || ''}`
      : `${running ? 'AI 판독 결과 표시' : 'AI 판독 완료'} ${pct}% · 결함 ${n}건 ${this._srcTag()}`.trim();
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.font = `600 13px ${MONO}`;
    const w = ctx.measureText(text).width + 26, cx = (L + R) / 2, y = 30;
    ctx.fillStyle = 'rgba(3, 18, 30, 0.86)';
    ctx.strokeStyle = 'rgba(95, 228, 255, 0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(cx - w / 2, y - 13, w, 26, 13) : ctx.rect(cx - w / 2, y - 13, w, 26);
    ctx.fill();
    ctx.stroke();
    if (running) {
      ctx.fillStyle = 'rgba(95, 228, 255, 0.18)';
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(cx - w / 2, y - 13, w * this.scene.scanProgress, 26, 13) : ctx.rect(cx - w / 2, y - 13, w * this.scene.scanProgress, 26);
      ctx.fill();
    }
    ctx.fillStyle = '#c9f6ff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cx, y + 0.5);
    ctx.restore();
  }

  _drawCaption(ctx, L, R, H) {
    if (this.tab !== 'repair' || this.stepIdx < 0) return;
    const plan = this._getPlan();
    const s = plan?.steps[this.stepIdx];
    if (!s) return;
    const text = `${this.stepIdx + 1}/${plan.steps.length} · ${STEP_KINDS[s.kind] || s.kind} · ${s.text}`;
    const w = Math.min(560, R - L - 32);
    if (w < 120) return;
    ctx.save();
    ctx.font = `600 15px ${SANS}`;
    const lines = wrap(ctx, text, w - 28, 2);
    const bh = lines.length * 21 + 16, cx = (L + R) / 2, y = H - 120 - bh;
    ctx.fillStyle = 'rgba(3, 18, 30, 0.88)';
    ctx.strokeStyle = rgba(ACCENT, 0.5);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(cx - w / 2, y, w, bh, 10) : ctx.rect(cx - w / 2, y, w, bh);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e8fbff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    lines.forEach((l, k) => ctx.fillText(l, cx, y + 9 + k * 21));
    ctx.restore();
  }
}

