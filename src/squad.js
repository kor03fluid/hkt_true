// SQUAD LINK live link: one-way, read-only feed from the team's control server (CLIKA_1 squad-link) into the
// AI 정비 mode. The control server has no CORS headers and speaks plain http on the LAN, so the viewer
// reads it through a same-origin path: tools/squad_bridge.mjs (serves the single-file viewer and proxies
// GET /squad/api/{config,state,stream}) or the Vite dev proxy (SQUAD_URL). Nothing is ever posted back.
//
// liveSignals() turns a /api/state snapshot into field signals (impact event, sensor failure, link lost,
// installation shock, heat exposure); reconcile() turns signals into inspection rows for the maintenance
// network. Both are pure (no DOM) so tools/test_diagnosis.mjs runs them. A signal says where to look, it
// never confirms damage (data spec: "impact는 충격 관측이며 부상을 확정하지 않는다"; a lost link does not
// tell power off from radio loss), so every row is an inspection item that a technician closes.

/** Default node -> equipment (model key) mapping; the viewer keeps the user's choice in localStorage. */
export const DEFAULT_MAP = { halo_01: 'hailo-Modern', halo_02: 'hailo-Legacy', env_01: 'Turret' };
export const HEAT_ON = 35; // °C, the data spec's heat_exposure threshold (생성 35 / 해제 34)
export const HEAT_OFF = 34;
const SEEN_MAX = 300;

/**
 * Signal kind -> inspection row. node: which node class raises it; type/sev feed the rule engine
 * (diagnosis.js); confirm: the plan starts with a hands-on check; clears: the row closes by itself when
 * the condition is gone (only for a lost link: once the node reports again there is nothing to inspect).
 */
export const RULES = {
  impact: { node: 'soldier', type: 'impact', sev: 'mid', confirm: true, clears: false, ko: '충격 감지' },
  fault: { node: 'soldier', type: 'fault', sev: 'mid', confirm: true, clears: false, ko: '센서 고장 보고' },
  link: { node: 'soldier', type: 'fault', sev: 'low', confirm: false, clears: true, ko: '통신 두절' },
  shock: { node: 'env', type: 'impact', sev: 'mid', confirm: true, clears: false, ko: '설치 지점 충격' },
  heat: { node: 'env', type: 'fault', sev: 'low', confirm: false, clears: false, ko: '고온 노출' },
};
const SENSOR_KO = { imu: 'IMU(움직임)', heart_rate: '심박' };

const arr = (v) => (Array.isArray(v) ? v : []);
const hhmm = (iso) => {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** Node ids of a snapshot (+ /api/config): { soldiers: [...], env: [...] }. */
export function nodesOf(snap, config) {
  const soldiers = new Set(arr(config?.squad?.node_ids));
  for (const s of arr(snap?.soldiers)) if (s?.assigned_node_id) soldiers.add(s.assigned_node_id);
  const env = new Set(arr(config?.environment?.node_ids));
  for (const t of arr(snap?.telemetry)) if (t?.packet_type === 'environment' && t.node_id) env.add(t.node_id);
  return { soldiers: [...soldiers], env: [...env] };
}

/**
 * /api/state snapshot -> { signals, restored }.
 *   signals: [{ key, kind, node, model, at, sim, cond, text }] for nodes mapped to a model.
 *     key: 'ev:<event_id>' for an event (handled once), 'cond:<kind>:<node>' for a condition (one row per
 *     episode: it starts when the condition appears and ends when it goes away).
 *   restored: nodes that report normally again (connection_state connected), for the auto-clear.
 * active: condition keys of the episodes running now (the heat hysteresis keeps an episode until 34 °C).
 */
export function liveSignals(snap, map = DEFAULT_MAP, active = []) {
  const out = [];
  const restored = [];
  const on = new Set(active);
  const sim = (src) => (src || snap?.source) === 'simulation';
  const add = (kind, node, at, src, text, cond) => {
    const model = map[node];
    if (!model) return;
    out.push({ key: cond ? `cond:${kind}:${node}` : null, kind, node, model, at: at || snap?.server_time || null, sim: sim(src), cond, text });
  };
  for (const s of arr(snap?.soldiers)) {
    const node = s?.assigned_node_id;
    if (!node) continue;
    if (s.connection_state === 'connected') restored.push(node);
    if (s.connection_state === 'lost') {
      const seen = hhmm(s.last_seen_at);
      add('link', node, s.last_seen_at, s.source, `${node} 통신 두절${seen ? ` (최종 수신 ${seen})` : ''} — 전원 꺼짐·무선 장애·송신 누락을 구분할 수 없어 원격 상태 미확보`, true);
    }
    // sensor readings of a node that is not reporting are stale: only a live report counts
    const st = s.connection_state === 'connected' && !s.data_stale ? s.payload?.sensor_status : null;
    const bad = st ? Object.keys(SENSOR_KO).filter((k) => st[k] === 'unavailable') : [];
    if (bad.length) add('fault', node, s.last_seen_at, s.source, `${node} 센서 상태 보고: ${bad.map((k) => SENSOR_KO[k]).join('·')} 읽기 실패 (unavailable)`, true);
  }
  for (const e of arr(snap?.events)) {
    if (e?.event_type !== 'impact' || !e.event_id || !e.node_id) continue;
    const t = hhmm(e.first_received_at);
    const sig = { key: `ev:${e.event_id}`, kind: 'impact', node: e.node_id, model: map[e.node_id], at: e.first_received_at || snap?.server_time || null, sim: sim(e.source), cond: false };
    sig.text = `${e.node_id} 충격 사건${t ? ` (${t})` : ''}${e.repeat_count > 1 ? ` ×${e.repeat_count}` : ''} — 충격은 관측일 뿐 손상 확정 아님`;
    if (sig.model) out.push(sig);
  }
  for (const t of arr(snap?.telemetry)) {
    if (t?.packet_type !== 'environment' || !t.node_id || t.data_stale) continue;
    const p = t.payload || {};
    if (p.shock_detected === true) add('shock', t.node_id, t.received_at, t.source, `${t.node_id} 설치 지점 충격 감지 (${hhmm(t.received_at)}) — 설치물 고정부·다리 점검`, true);
    const temp = Number.isFinite(p.air_temperature_c) ? p.air_temperature_c : null;
    const hot = temp != null && (temp >= HEAT_ON || (on.has(`cond:heat:${t.node_id}`) && temp > HEAT_OFF));
    if (hot) add('heat', t.node_id, t.received_at, t.source, `${t.node_id} 공기 온도 ${temp.toFixed(1)}°C (기준 ${HEAT_ON}°C 이상) — 제어부 과열 이력 관찰`, true);
  }
  return { signals: out, restored };
}

/**
 * Signals -> changes to the maintenance rows (pure; the caller writes them and assigns ids).
 *   rows: { [model]: rows of that model, overrides applied (status, source, live) }
 *   seen: keys handled so far (events and running condition episodes)
 *   anchors: web/live_anchors.json ({ [model]: [{ id: kind, part, p, n, t, size }] })
 * -> { seen, add: [{ model, row, sig }], bump: [{ model, id, sig }], clear: [{ model, id, sig }] }
 * A new signal on equipment that already has an unresolved row of the same kind from the same node adds a
 * count to that row instead of a second marker.
 */
export function reconcile({ signals = [], restored = [], seen = [], rows = {}, anchors = {}, at = new Date().toISOString() } = {}) {
  const next = new Set(arr(seen));
  const add = [], bump = [], clear = [];
  const openRow = (model, kind, node) => arr(rows[model]).find((r) => r && r.source === 'live' && r.live?.kind === kind && r.live?.node === node && r.status !== 'closed');
  const pending = new Map(); // rows created in this pass, by model|kind|node
  for (const sig of signals) {
    const key = sig.key || `ev:${sig.kind}:${sig.node}:${sig.at}`;
    if (next.has(key)) continue;
    const rule = RULES[sig.kind];
    const anchor = arr(anchors[sig.model]).find((a) => a && a.id === sig.kind);
    if (!rule || !anchor) continue; // no inspection spot for this kind on that equipment
    next.add(key);
    const pk = `${sig.model}|${sig.kind}|${sig.node}`;
    const open = openRow(sig.model, sig.kind, sig.node);
    if (open) bump.push({ model: sig.model, id: open.id, sig });
    else if (pending.has(pk)) {
      const live = pending.get(pk).live;
      live.count++;
      live.last = sig.at || at;
    } else {
      const row = {
        part: anchor.part, type: rule.type, sev: rule.sev, p: anchor.p, n: anchor.n, t: anchor.t, size: anchor.size || 6,
        conf: null, confirm: rule.confirm, found: String(sig.at || at).slice(0, 10), added: at, cause: sig.text,
        source: 'live', status: 'open', escalated: 0, wait: null, rework: 0, condemned: false, fp: false,
        live: { kind: sig.kind, node: sig.node, sim: !!sig.sim, key, count: 1, first: sig.at || at, last: sig.at || at },
      };
      pending.set(pk, row);
      add.push({ model: sig.model, row, sig });
    }
  }
  // condition episodes that ended: forget them (the next occurrence is a new episode)
  const now = new Set(signals.filter((s) => s.cond).map((s) => s.key));
  const back = new Set(restored);
  for (const key of [...next]) {
    if (!key.startsWith('cond:') || now.has(key)) continue;
    next.delete(key);
    const [, kind, node] = key.split(':');
    if (!RULES[kind]?.clears || !back.has(node)) continue; // e.g. node unmapped: no evidence it recovered
    for (const [model, list] of Object.entries(rows)) {
      for (const r of arr(list)) {
        if (r?.source === 'live' && r.live?.kind === kind && r.live?.node === node && r.status === 'open') clear.push({ model, id: r.id, sig: { kind, node } });
      }
    }
  }
  // keep every running episode, and the newest event keys
  const events = [...next].filter((k) => !k.startsWith('cond:'));
  const drop = new Set(events.slice(0, Math.max(0, events.length - SEEN_MAX)));
  return { seen: [...next].filter((k) => !drop.has(k)), add, bump, clear };
}

/**
 * Connection to the control server through the same-origin bridge path. status: 'off' (not started),
 * 'connecting', 'unavailable' (no bridge here, e.g. GitHub Pages), 'live', 'lost' (was live, retrying).
 * onState(snapshot) per received state; onStatus(status) on every change.
 */
export class SquadLink {
  constructor({ base = 'squad/api/', onState = () => {}, onStatus = () => {} } = {}) {
    this.base = base;
    this.onState = onState;
    this.onStatus = onStatus;
    this.status = 'off';
    this.config = null;
    this.snap = null;
    this.lastAt = 0; // performance.now() of the last state
    this.es = null;
    this.timer = 0;
    this.poll = 0;
    this.want = false;
    this.wasLive = false;
  }
  start(base) {
    if (base) this.base = base;
    this.want = true;
    if (this.status === 'off' || this.status === 'unavailable') this._connect();
  }
  stop() {
    this.want = false;
    this._close();
    this._set('off');
  }
  /** Per frame: a stream that went quiet (the server sends a state every second) counts as lost. */
  tick(now = performance.now()) {
    if (this.status === 'live' && now - this.lastAt > 6000) {
      this._close();
      this._set('lost');
      this._retry(3000);
    }
  }
  _set(s) {
    if (s === this.status) return;
    this.status = s;
    if (s === 'live') this.wasLive = true;
    this.onStatus(s);
  }
  _close() {
    clearTimeout(this.timer);
    clearInterval(this.poll);
    this.timer = this.poll = 0;
    if (this.es) {
      this.es.close();
      this.es = null;
    }
  }
  _retry(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.want && this._connect(), ms);
  }
  _take(text) {
    let snap;
    try {
      snap = JSON.parse(text);
    } catch {
      return;
    }
    if (!snap || !Array.isArray(snap.soldiers)) return;
    this.snap = snap;
    this.lastAt = performance.now();
    this._set('live');
    this.onState(snap);
  }
  async _connect() {
    this._close();
    if (!this.want) return;
    if (!this.wasLive) this._set('connecting');
    try {
      const r = await fetch(this.base + 'config', { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      this.config = await r.json();
    } catch {
      if (!this.want) return;
      if (this.wasLive) {
        this._set('lost');
        this._retry(3000);
      } else this._set('unavailable'); // no bridge: stay quiet until asked again
      return;
    }
    if (!this.want) return;
    if (typeof EventSource === 'undefined') {
      const get = () => fetch(this.base + 'state', { cache: 'no-store' }).then((r) => r.text()).then((t) => this._take(t)).catch(() => {});
      get();
      this.poll = setInterval(get, 2000);
      return;
    }
    const es = (this.es = new EventSource(this.base + 'stream'));
    es.addEventListener('state', (e) => this._take(e.data));
    es.onerror = () => {
      if (this.es !== es) return;
      this._close();
      this._set(this.wasLive ? 'lost' : 'unavailable');
      if (this.wasLive) this._retry(3000);
    };
  }
}
