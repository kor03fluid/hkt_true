// SQUAD LINK live link: follows the team's control server (CLIKA_1 squad-link) in the AI 정비 mode. The control
// server has no CORS headers and speaks plain http on the LAN, so the viewer reaches it through a same-origin
// path: tools/squad_bridge.mjs (serves the single-file viewer, relays GET /squad/api/{config,state,stream} and
// POST /squad/api/maintenance) or the Vite dev proxy (SQUAD_URL).
//
// liveSignals() turns a /api/state snapshot into field signals (impact event, sensor failure, link lost,
// installation shock, heat exposure); reconcile() turns signals into inspection rows for the maintenance
// network. Both are pure (no DOM) so tools/test_diagnosis.mjs runs them. A signal says where to look, it
// never confirms damage (data spec: "impact는 충격 관측이며 부상을 확정하지 않는다"; a lost link does not
// tell power off from radio loss), so every row is an inspection item that a technician closes.
// The only thing sent back is the maintenance result: maintReports() gives each mapped soldier's equipment
// state (운용 가능 / 제한 운용 / 운용 불가 from those rows) and the impact incidents whose inspection is done.

/** Default node -> equipment (model key) mapping; the viewer keeps the user's choice in localStorage. */
export const DEFAULT_MAP = { halo_01: 'hailo-Modern', halo_02: 'hailo-Legacy', env_01: 'Turret' };
export const HEAT_ON = 35; // °C, the data spec's heat_exposure threshold (생성 35 / 해제 34)
export const HEAT_OFF = 34;
const SEEN_MAX = 300;
export const EVENTS_MAX = 50; // control-server event ids kept on one row (its repeats), for closing them after inspection

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
const own = (o, k) => k != null && Object.prototype.hasOwnProperty.call(o, k);
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
 * /api/state snapshot -> { signals, restored, held, skip }.
 *   signals: [{ key, kind, node, model, at, sim, cond, text }] for nodes mapped to a model.
 *     key: 'ev:<event_id>' for an event (handled once), 'cond:<kind>:<node>' for a condition (one row per
 *     episode: it starts when the condition appears and ends on a fresh report without it).
 *   restored: nodes that report normally again (connection_state connected), for the auto-clear.
 *   held: running episodes whose node has no fresh data (lost, waiting after a server restart, stale
 *     telemetry): unknown is not recovered, so the episode is kept instead of ending.
 *   skip: event keys of unmapped nodes: marked as handled so mapping a node later starts from new signals.
 * active: condition keys of the episodes running now (the heat hysteresis keeps an episode until 34 °C).
 */
export function liveSignals(snap, map = DEFAULT_MAP, active = []) {
  const out = [];
  const restored = [];
  const held = [];
  const skip = [];
  const on = new Set(active);
  const hold = (key) => {
    if (on.has(key)) held.push(key);
  };
  const sim = (src) => (src || snap?.source) === 'simulation';
  const add = (kind, node, at, src, text, cond) => {
    const model = map[node];
    if (!model) {
      if (cond) hold(`cond:${kind}:${node}`); // unmapped for a while: the condition did not stop, keep its episode
      return;
    }
    out.push({ key: cond ? `cond:${kind}:${node}` : null, kind, node, model, at: at || snap?.server_time || null, sim: sim(src), cond, text });
  };
  for (const s of arr(snap?.soldiers)) {
    const node = s?.assigned_node_id;
    if (!node) continue;
    if (s.connection_state === 'connected') restored.push(node);
    if (s.connection_state === 'lost') {
      const seen = hhmm(s.last_seen_at);
      add('link', node, s.last_seen_at, s.source, `${node} 통신 두절${seen ? ` (최종 수신 ${seen})` : ''} — 전원 꺼짐·무선 장애·송신 누락을 구분할 수 없어 원격 상태 미확보`, true);
    } else if (s.connection_state !== 'connected') hold(`cond:link:${node}`); // 'waiting' (server restart, reboot): not back yet
    // sensor readings of a node that is not reporting are stale: only a live report counts
    const fresh = s.connection_state === 'connected' && !s.data_stale;
    const st = fresh ? s.payload?.sensor_status : null;
    const bad = st ? Object.keys(SENSOR_KO).filter((k) => st[k] === 'unavailable') : [];
    if (bad.length) add('fault', node, s.last_seen_at, s.source, `${node} 센서 상태 보고: ${bad.map((k) => SENSOR_KO[k]).join('·')} 읽기 실패 (unavailable)`, true);
    else if (!fresh) hold(`cond:fault:${node}`);
  }
  for (const e of arr(snap?.events)) {
    if (e?.event_type !== 'impact' || !e.event_id || !e.node_id) continue;
    // closed by a maintenance report already (another viewer, or this one before its storage was cleared)
    if (e.event_state === 'resolved' && e.resolved_by === 'maintenance') {
      skip.push(`ev:${e.event_id}`);
      continue;
    }
    const t = hhmm(e.first_received_at);
    const sig = { key: `ev:${e.event_id}`, kind: 'impact', node: e.node_id, model: map[e.node_id], at: e.first_received_at || snap?.server_time || null, sim: sim(e.source), cond: false };
    sig.text = `${e.node_id} 충격 사건${t ? ` (${t})` : ''}${e.repeat_count > 1 ? ` ×${e.repeat_count}` : ''} — 충격은 관측일 뿐 손상 확정 아님`;
    if (sig.model) out.push(sig);
    else skip.push(sig.key);
  }
  const envFresh = new Set();
  for (const t of arr(snap?.telemetry)) {
    if (t?.packet_type !== 'environment' || !t.node_id || t.data_stale) continue;
    envFresh.add(t.node_id);
    const p = t.payload || {};
    if (p.shock_detected === true) add('shock', t.node_id, t.received_at, t.source, `${t.node_id} 설치 지점 충격 감지 (${hhmm(t.received_at)}) — 설치물 고정부·다리 점검`, true);
    else if (p.shock_detected !== false) hold(`cond:shock:${t.node_id}`); // null / missing: the sensor could not tell
    const temp = Number.isFinite(p.air_temperature_c) ? p.air_temperature_c : null;
    const hot = temp != null && (temp >= HEAT_ON || (on.has(`cond:heat:${t.node_id}`) && temp > HEAT_OFF));
    if (hot) add('heat', t.node_id, t.received_at, t.source, `${t.node_id} 공기 온도 ${temp.toFixed(1)}°C (기준 ${HEAT_ON}°C 이상) — 제어부 과열 이력 관찰`, true);
    else if (temp == null && on.has(`cond:heat:${t.node_id}`)) held.push(`cond:heat:${t.node_id}`); // DHT11 read failure: unknown
  }
  // environment episodes of a node with no fresh telemetry (stale or gone) are kept
  for (const key of on) {
    const [, kind, node] = key.split(':');
    if ((kind === 'shock' || kind === 'heat') && !envFresh.has(node)) held.push(key);
  }
  return { signals: out, restored, held, skip };
}

// a row the technician has acted on (switched, escalated, waiting for parts, re-worked) is never auto-closed
const untouched = (r) => !r.forceReplace && !r.forceMonitor && !r.wait && !r.condemned && !(r.escalated > 0) && !(r.rework > 0);

/**
 * Signals -> changes to the maintenance rows (pure; the caller writes them and assigns ids).
 *   rows: { [model]: rows of that model, overrides applied (status, source, live) }
 *   seen: keys handled so far (events and running condition episodes)
 *   anchors: web/live_anchors.json ({ [model]: [{ id: kind, part, p, n, t, size }] })
 * -> { seen, add: [{ model, row, sig }], bump: [{ model, id, sig }], clear: [{ model, id, sig }] }
 * A new signal on equipment that already has an unresolved row of the same kind from the same node adds a
 * count to that row instead of a second marker.
 */
export function reconcile({ signals = [], restored = [], held = [], skip = [], seen = [], rows = {}, anchors = {}, at = new Date().toISOString() } = {}) {
  const next = new Set(arr(seen));
  for (const key of arr(skip)) next.add(key);
  const add = [], bump = [], clear = [];
  const openRow = (model, kind, node) => arr(rows[model]).find((r) => r && r.source === 'live' && r.live?.kind === kind && r.live?.node === node && r.status !== 'closed');
  const pending = new Map(); // rows created in this pass, by model|kind|node
  // oldest first (the server lists events newest first): counts and history then follow time
  const ordered = [...signals].sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  for (const sig of ordered) {
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
      // several events in one snapshot (it lists the newest first): keep the time span and the newest cause
      const row = pending.get(pk), live = row.live, t = sig.at || at;
      live.count++;
      if (key.startsWith('ev:')) live.events = [...arr(live.events), key.slice(3)].slice(-EVENTS_MAX);
      if (t < live.first) live.first = t;
      if (t >= live.last) {
        live.last = t;
        row.cause = sig.text;
      }
    } else {
      const row = {
        part: anchor.part, type: rule.type, sev: rule.sev, p: anchor.p, n: anchor.n, t: anchor.t, size: anchor.size || 6,
        conf: null, confirm: rule.confirm, found: String(sig.at || at).slice(0, 10), added: at, cause: sig.text,
        source: 'live', status: 'open', escalated: 0, wait: null, rework: 0, condemned: false, fp: false,
        live: { kind: sig.kind, node: sig.node, sim: !!sig.sim, key, count: 1, first: sig.at || at, last: sig.at || at, ...(key.startsWith('ev:') ? { events: [key.slice(3)] } : {}) },
      };
      pending.set(pk, row);
      add.push({ model: sig.model, row, sig });
    }
  }
  // condition episodes that ended on a fresh report: forget them (the next occurrence is a new episode)
  const now = new Set([...signals.filter((s) => s.cond).map((s) => s.key), ...arr(held)]);
  for (const key of [...next]) if (key.startsWith('cond:') && !now.has(key)) next.delete(key);
  // a node that reports again closes its open link rows on every equipment (also after a remap, an unmap or a
  // server restart dropped the episode), unless the technician has already acted on the row
  const back = new Set(restored);
  for (const [model, list] of Object.entries(rows)) {
    for (const r of arr(list)) {
      const kind = r?.live?.kind;
      if (r?.source === 'live' && RULES[kind]?.clears && back.has(r.live.node) && r.status === 'open' && untouched(r)) clear.push({ model, id: r.id, sig: { kind, node: r.live.node } });
    }
  }
  // keep every running episode and every key the server still lists; forget the oldest of the rest
  const current = new Set([...signals.map((s) => s.key), ...arr(skip), ...now]);
  const old = [...next].filter((k) => !current.has(k));
  const drop = new Set(old.slice(0, Math.max(0, old.length - SEEN_MAX)));
  return { seen: [...next].filter((k) => !drop.has(k)), add, bump, clear };
}

/** Control-server event ids behind a row (rows made before ids were kept have only the first, in the key). */
export const rowEvents = (r) => {
  const ids = arr(r?.live?.events).filter((x) => typeof x === 'string');
  if (!ids.length && typeof r?.live?.key === 'string' && r.live.key.startsWith('ev:')) ids.push(r.live.key.slice(3));
  return ids;
};
const STATUS = { GO: 'go', LIMITED: 'limited', NOGO: 'nogo' };

const RANK = { GO: 0, LIMITED: 1, NOGO: 2 };

/**
 * Maintenance report per soldier node, for POST /api/maintenance (pure).
 *   rows: { [model]: rows, overrides applied } of every equipment; map: node -> model; names: model -> name
 *   rate(model, rows) -> readiness { status: 'GO' | 'LIMITED' | 'NOGO', reasons } of the rule engine, or null
 *     (unknown equipment). It gets only that node's live rows: sample, manual and imported rows belong to the
 *     equipment type, not to one soldier. Rows on any equipment count (a node remapped with work still open),
 *     the worst one decides; rows from simulated data never count for real devices and the other way round.
 * -> [{ node_id, status, equipment, reasons, items, resolved_event_ids, sig }] for every mapped node and every
 *   node that still has live rows. items: rows still to do (open, repaired awaiting inspection, monitored).
 *   resolved_event_ids: impact events behind the node's closed rows (their ids, or received within the row's
 *   first..last span) that the server still lists as unresolved. sig: changes whenever the report or a row's
 *   signal count changes (not sent).
 */
export function maintReports({ snap, config, map = DEFAULT_MAP, rows = {}, names = {}, rate } = {}) {
  const out = [];
  const sim = (snap?.source ?? 'simulation') === 'simulation';
  const events = arr(snap?.events).filter((e) => e && e.event_id && e.event_type === 'impact' && e.event_state !== 'resolved');
  for (const node of nodesOf(snap, config).soldiers) {
    const home = map[node] || '';
    const byModel = Object.entries(rows)
      .map(([model, list]) => [model, arr(list).filter((r) => r && r.source === 'live' && r.live?.node === node && !!r.live.sim === sim)])
      .filter(([model, list]) => list.length || model === home);
    if (!home && !byModel.length) continue;
    if (home && !byModel.some(([m]) => m === home)) byModel.push([home, []]);
    let worst = null;
    for (const [model, list] of byModel) {
      const rd = rate(model, list);
      if (rd && own(RANK, rd.status) && (!worst || RANK[rd.status] > RANK[worst.status])) worst = rd;
    }
    if (!worst) continue;
    const mine = byModel.flatMap(([, list]) => list);
    const todo = mine.filter((r) => r.status !== 'closed');
    const items = todo.slice(0, 20).map((r) => ({
      id: String(r.id).slice(0, 20),
      kind: String(r.live.kind).slice(0, 20),
      label: `${r.part} ${RULES[r.live.kind]?.ko || r.live.kind}`.slice(0, 80),
      state: r.status === 'repaired' ? 'repaired' : r.monitored ? 'monitor' : 'open',
    }));
    const resolved = new Set();
    for (const r of mine) {
      if (r.status !== 'closed' || r.live.kind !== 'impact') continue;
      const ids = new Set(rowEvents(r));
      const { first, last } = r.live;
      for (const e of events) {
        if (e.node_id !== node) continue;
        const t = e.first_received_at;
        if (ids.has(e.event_id) || (typeof first === 'string' && typeof last === 'string' && t >= first && t <= last)) resolved.add(e.event_id);
      }
    }
    const status = STATUS[worst.status];
    const reasons = worst.status === 'GO' ? [] : arr(worst.reasons).slice(0, 4).map((t) => String(t).slice(0, 120));
    const equipment = String(names[home] || names[byModel[0][0]] || home || byModel[0][0]).slice(0, 60);
    out.push({
      node_id: node, status, equipment, reasons, items, resolved_event_ids: [...resolved].slice(0, 50),
      sig: JSON.stringify([status, equipment, reasons, items, todo.map((r) => r.live.count || 1)]),
    });
  }
  return out;
}

/** Send now? A changed report, a server without one (restart, demo reset) or impacts to close; not while one is in flight or backing off. */
export const reportDue = (rep, { sent, server, busy, retryAt = 0, now }) => !busy && now >= retryAt && (sent !== rep.sig || !server || rep.resolved_event_ids.length > 0);

/** Event ids of a row after one more event (rows made before ids were kept start from the id in their key). */
export const withEvent = (r, id) => [...rowEvents(r), id].slice(-EVENTS_MAX);

/**
 * Connection to the control server through the same-origin bridge path. status: 'off' (not started),
 * 'connecting', 'unavailable' (no bridge here, e.g. GitHub Pages: stays quiet until asked again),
 * 'upstream' (the bridge answers but the control server does not: retrying), 'live', 'lost' (was live,
 * retrying). onState(snapshot) per received state; onStatus(status) on every change.
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
    this.wasLive = false; // live at least once since start(): failures retry instead of giving up
    this.gen = 0; // connection attempt; a stale attempt (stop / restart meanwhile) never touches the state
  }
  start(base) {
    if (base) this.base = base;
    this.want = true;
    if (this.status === 'off' || this.status === 'unavailable') this._connect();
  }
  stop() {
    this.want = false;
    this.wasLive = false;
    this.gen++;
    this._close();
    this.snap = null;
    this._set('off');
  }
  /** POST JSON through the same path (the maintenance report) -> { ok, status, data }; rejects on a network error. */
  async post(path, body) {
    const r = await fetch(this.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
    let data = null;
    try {
      data = await r.json();
    } catch {
      /* not JSON (an old bridge's plain error) */
    }
    return { ok: r.ok, status: r.status, data };
  }
  /** Per frame: a stream that went quiet (the server sends a state every second) counts as lost. */
  tick(now = performance.now()) {
    if (this.status === 'live' && now - this.lastAt > 6000) {
      this.gen++;
      this._close();
      this._set('lost');
      this._retry(3000);
    } else if (this.streamAt && this.status !== 'live' && now - this.streamAt > 10000) {
      // the relay answered but no state ever came: treat it like a dead upstream and retry
      this.streamAt = 0;
      this.gen++;
      this._close();
      this._fail(true);
    }
  }
  _set(s) {
    if (s === this.status) return;
    this.status = s;
    if (s === 'live') this.wasLive = true;
    this.onStatus(s);
  }
  _close() {
    this.streamAt = 0;
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
    if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return;
    // any object is a state (an environment-only setup has no soldiers); lists keep only object entries
    const list = (v) => arr(v).filter((x) => x && typeof x === 'object');
    snap = { ...snap, soldiers: list(snap.soldiers), events: list(snap.events), telemetry: list(snap.telemetry) };
    this.snap = snap;
    this.lastAt = performance.now();
    this.streamAt = 0;
    this._set('live');
    this.onState(snap);
  }
  /** A failed attempt: retry while the relay is known to exist, else go quiet. */
  _fail(relay) {
    if (this.wasLive) this._set('lost');
    else this._set(relay ? 'upstream' : 'unavailable');
    if (this.wasLive || relay) this._retry(3000);
  }
  async _connect() {
    this._close();
    if (!this.want) return;
    const gen = ++this.gen;
    if (!this.wasLive && this.status !== 'upstream') this._set('connecting');
    let relay = false;
    try {
      const r = await fetch(this.base + 'config', { cache: 'no-store' });
      relay = r.status >= 500; // 502 from squad_bridge.mjs / 5xx from the Vite proxy: the control server is down
      if (!r.ok) throw new Error(String(r.status));
      this.config = await r.json();
    } catch {
      if (this.want && gen === this.gen) this._fail(relay);
      return;
    }
    if (!this.want || gen !== this.gen) return;
    this.streamAt = performance.now(); // waiting for the first state (tick() gives up after 10 s)
    if (typeof EventSource === 'undefined') {
      const get = () => fetch(this.base + 'state', { cache: 'no-store' }).then((r) => r.text()).then((t) => gen === this.gen && this._take(t)).catch(() => {});
      get();
      this.poll = setInterval(get, 2000);
      return;
    }
    const es = (this.es = new EventSource(this.base + 'stream'));
    es.addEventListener('state', (e) => {
      if (this.es === es) this._take(e.data);
    });
    es.onerror = () => {
      if (this.es !== es) {
        es.close(); // an orphan of an earlier attempt: never let the browser keep reconnecting it
        return;
      }
      this.gen++;
      this._close();
      this._fail(true); // the config answered, so the relay exists
    };
  }
}
