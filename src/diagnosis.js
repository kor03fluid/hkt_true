// Rule engine of the AI maintenance mode: scores defects, propagates part -> function -> equipment
// readiness, builds repair plans from the knowledge base (web/maintenance.json) and applies repair /
// re-inspection feedback. Pure ES module (no DOM, no three.js, no node imports): JSON is passed in by
// the caller, so the same code runs in the viewer and in tools/test_diagnosis.mjs.
// Every weight, threshold and minute value here is demonstration data (예시), not a real standard.

export const TYPES = {
  crack:     { ko: '크랙',     en: 'Crack',       measure: '길이' },
  scratch:   { ko: '스크래치', en: 'Scratch',     measure: '길이' },
  dent:      { ko: '찍힘',     en: 'Dent',        measure: '지름' },
  wear:      { ko: '마모',     en: 'Wear',        measure: '길이' },
  corrosion: { ko: '부식',     en: 'Corrosion',   measure: '지름' },
  deform:    { ko: '변형',     en: 'Deformation', measure: '지름' },
  // SQUAD LINK signals (src/squad.js): where to inspect, not a measured defect (no size)
  impact:    { ko: '충격 감지', en: 'Impact',     measure: '', signal: true },
  fault:     { ko: '전자부 이상', en: 'Fault',    measure: '', signal: true },
};
export const SEVERITY = {
  high: { ko: '위험', en: 'CRITICAL', color: '#ff4d5e', rank: 3 },
  mid:  { ko: '주의', en: 'WARNING',  color: '#ff9f43', rank: 2 },
  low:  { ko: '경미', en: 'MINOR',    color: '#ffd84d', rank: 1 },
};
export const SOURCES = { sample: { ko: '예시' }, manual: { ko: '수동 입력' }, import: { ko: '불러옴' }, live: { ko: '실시간' } };
export const STATUS = { open: { ko: '미조치' }, repaired: { ko: '검사 대기', color: '#7fb2ff' }, closed: { ko: '해결', color: '#5be38a' } };
export const ACTIONS = { replace: { ko: '교체' }, repair: { ko: '보수' }, monitor: { ko: '관찰(추적 점검)' } };
export const PRIORITY = { P1: { ko: '긴급', desc: '운용 중지·즉시 정비', color: '#ff4d5e' }, P2: { ko: '우선', desc: '다음 운용 전', color: '#ff9f43' }, P3: { ko: '통상', desc: '정기 점검 시', color: '#ffd84d' } };
export const LEVELS = { unit: { ko: '부대정비', desc: '운용부대 — 점검·조정·구성품 교환' }, field: { ko: '야전정비', desc: '정비부대 — 부품 수리·교환·정렬' }, depot: { ko: '창정비', desc: '정비창 — 분해 수리(오버홀)·재생' } };
export const PART_STATUS = { ok: { ko: '정상', color: '#5be38a' }, watch: { ko: '관찰', color: '#ffd84d' }, verify: { ko: '검사 대기', color: '#7fb2ff' }, repair: { ko: '정비 필요', color: '#ff9f43' }, replace: { ko: '교체 필요', color: '#ff4d5e' } };
export const FUNC_STATUS = { ok: { ko: '정상', color: '#5be38a' }, watch: { ko: '관찰', color: '#ffd84d' }, degraded: { ko: '기능 저하', color: '#ff9f43' }, down: { ko: '기능 상실', color: '#ff4d5e' } };
export const READINESS = { GO: { ko: '운용 가능 (가동)', short: '가동', color: '#5be38a' }, LIMITED: { ko: '제한 운용 (부분 가동)', short: '부분 가동', color: '#ff9f43' }, NOGO: { ko: '운용 불가 (비가동)', short: '비가동', color: '#ff4d5e' } };
export const STEP_KINDS = { prep: '준비', remove: '분해', work: '정비 작업', install: '조립', verify: '작동 점검', record: '기록' };
export const NOTICE = '예시 데이터 포함 — 실제 점검·정비 결과가 아님';
export const DEFERRED = '이월 정비 (운용 영향 없음)';

const TYPE_W = { crack: 1.0, fault: 0.85, deform: 0.8, corrosion: 0.7, dent: 0.6, impact: 0.6, wear: 0.55, scratch: 0.3 };
const SEV_W = { high: 1.0, mid: 0.6, low: 0.3 };
const CRIT_W = { 3: 1.0, 2: 0.75, 1: 0.5 };
const SEV_DOWN = { high: 'mid', mid: 'low', low: 'low' };
const LEVEL_IDS = ['unit', 'field', 'depot'];
const UNIT_REPLACE_ROLES = ['cover', 'interface', 'demo', 'mount'];
const REPAIR_MIN = { crack: 40, scratch: 15, dent: 25, wear: 20, corrosion: 30, deform: 30, impact: 20, fault: 30 };
const NUM = '①②③④⑤⑥⑦⑧⑨';
// the KB marks axis-carrying parts with this precaution (B-04, B-05, Y-01, Y-03, H-01v4); they get
// an axis re-zero after replacement even when their role is not 'drive' (H-01v4 is 'structure')
const SERVO_SAFETY = '서보 전원 차단 후 선회·고각 축을 손으로 고정 (급회전 방지)';
const BATTERY_SAFETY = '배터리 팽창·발열 확인 — 이상 시 즉시 격리';
const TORQUE = '규정 토크 (기술교범 확인)';
const VERIFY_DEFECT = '결함 부위 육안·계측 재확인 — 잔여 결함 없음';
const VERIFY_REASSEMBLY = '분해 부품 전수 재조립·체결 확인';
const RESTORE = '공구·이물 회수 → 「조작 금지」 표지 제거 · 축 고정 해제 · 전원 재연결 (작동 점검 준비)';

const WORK = {
  crack: ['균열 길이·끝점 측정, 사진 기록', '균열 끝 정지 홀 가공 (∅1 mm, 예시)', '세척 후 2액형 에폭시 보강, 제품 규정 경화 시간 준수',
    "'임시 수리 — 다음 정기 점검 시 재측정·교체 검토' 기록"],
  scratch: ['깊이 확인 (손톱 걸림·측정)', '거스러미 제거·표면 정리', '결합면이면 간섭 확인'],
  dent: ['깊이·범위 측정', '인접 결합면·체결부 간섭 확인', '간섭 없으면 표면 정리 후 관찰 등록, 간섭 시 교체 전환'],
  wear: ['유격·마모량 측정', '윤활 또는 심(shim) 조정', '전 구간 작동 시 걸림 확인'],
  deform: ['직각도·평탄도 측정 (정반·직각자)', '체결 이완 후 재체결로 조립 응력 해소', '회복 안 되면 소성 변형 — 교체 전환'],
  corrosion: ['부식 생성물·오염 제거', '모재 재질 확인 — 금속이면 방청 처리, 비금속이면 오염·변색으로 재분류', '녹슨 체결구 교체',
    '습기·이종금속 접촉 원인 제거'],
  impact: ['충격 부위와 주변 균열·찍힘·변형 육안 점검 (확대경, 사진 기록)', '내부 기판·배터리 고정 상태와 커넥터 체결 확인',
    '손상 발견 시 해당 결함으로 별도 등록 (결함 추가) — 없으면 「이상 없음」 처리'],
  fault: ['전원 재인가 후 기동·상태 표시 확인', '커넥터 체결·배선 도통 점검 (멀티미터)', '센서·모듈 재장착 — 같은 증상 반복 시 교체 검토'],
};
const WORK_MONITOR = ['현 상태 측정·사진 기록', '재점검 시기 등록', '보수 전환 기준 기록 (예: 크기 20% 증가, 예시)'];
const WORK_MONITOR_SIGNAL = ['신호 상태 기록 (관제 최종 수신 시각·사유)', '재점검 시기 등록', '보수 전환 기준 기록 (예: 같은 증상 2회 반복, 예시)'];
const REPAIR_TOOLS = {
  crack: ['버니어 캘리퍼스'], scratch: ['버니어 캘리퍼스'], dent: ['버니어 캘리퍼스', '다이얼 게이지'],
  wear: ['틈새 게이지', '다이얼 게이지'], deform: ['직각자', '다이얼 게이지'], corrosion: ['버니어 캘리퍼스'],
  impact: ['확대경', '버니어 캘리퍼스'], fault: ['멀티미터'],
};
const REPAIR_MATERIALS = {
  crack: ['IPA 세척제', '2액형 에폭시'], scratch: ['IPA 세척제'], dent: [], wear: ['윤활제'], deform: [],
  corrosion: ['IPA 세척제', '방청제'], impact: [], fault: [],
};

const arr = (v) => (Array.isArray(v) ? v : []);
const uniq = (list) => [...new Set(list.filter(Boolean))];
const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// rounds x.5 up even when float error lands it at x.4999999 (e.g. 0.55 * 0.3 * 100)
const round = (v) => Math.round(Number(v.toFixed(6)));
const isHelmet = (code) => /^DH-/.test(code || '');
const sevOf = (d) => (SEV_W[d && d.sev] ? d.sev : 'mid');
const stateOf = (d) => (d.fp || d.status === 'closed' ? 'closed' : d.status === 'repaired' ? 'repaired' : 'open');
const typeKo = (d) => (TYPES[d.type] ? TYPES[d.type].ko : d.type || '결함');
const defLabel = (d) => `${d.part} ${typeKo(d)}(${SEVERITY[sevOf(d)].ko})`;

/** Part entry of a model KB with defaults filled in (KB may be null or partial: never throws). */
export function kbPart(kb, code) {
  return normPart(kb && kb.parts ? kb.parts[code] : null, code);
}

function normPart(raw, code) {
  if (raw && raw._norm) return raw;
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    _norm: true,
    crit: [1, 2, 3].includes(r.crit) ? r.crit : 2,
    role: r.role || 'structure',
    functions: r.functions && typeof r.functions === 'object' ? r.functions : {},
    links: arr(r.links), access: arr(r.access),
    remove: num(r.remove, 5), replace: num(r.replace, 15),
    tools: arr(r.tools), materials: arr(r.materials),
    spare: r.spare || `${code || '부품'} 예비품 (동일 형상 · 재질은 원 설계 확인)`,
    safety: arr(r.safety), note: r.note || '', name: r.name || '',
  };
}

/** Removal order to reach `code`: transitive prerequisites first, deduped, without `code` itself. */
export function accessOrder(code, kb) {
  const out = [];
  const seen = new Set([code]);
  const visit = (c) => {
    const p = kb && kb.parts && kb.parts[c];
    for (const a of arr(p && p.access)) {
      if (seen.has(a)) continue; // also stops cycles in a malformed KB
      seen.add(a);
      visit(a);
      out.push(a);
    }
  };
  visit(code);
  return out;
}

/** 'Turret-T1-01' */
export function workOrder(modelKey, defectId, seq = 1) {
  return `${modelKey || 'local'}-${defectId}-${String(seq == null ? 1 : seq).padStart(2, '0')}`;
}

/** Raw defect (web/defects.json row, import row, manual entry) -> runtime defect object. */
export function runtimeDefect(raw, source = 'sample') {
  return {
    status: 'open', escalated: 0, wait: null, rework: 0, condemned: false, fp: false,
    ...raw,
    conf: raw && raw.conf != null ? raw.conf : null,
    source,
  };
}

/** 0..100 */
export function riskOf(defect, partKb) {
  const pk = normPart(partKb, defect && defect.part);
  const typeW = TYPE_W[defect.type] != null ? TYPE_W[defect.type] : 0.5;
  const sizeF = clamp(0.75 + num(defect.size, 0) / 40, 0.75, 1.25);
  return clamp(round(100 * typeW * SEV_W[sevOf(defect)] * CRIT_W[pk.crit] * sizeF), 0, 100);
}

function actionOf(d, pk, code) {
  if (d.condemned || d.forceReplace) return 'replace'; // condemned, or the technician switched to replacement
  if (d.forceMonitor) return 'monitor'; // the technician judged it does not need work now
  const sev = sevOf(d);
  if (isHelmet(code)) return sev === 'high' ? 'replace' : 'monitor'; // helmet shells are never repaired
  switch (d.type) {
    case 'crack': return sev === 'low' || (sev === 'mid' && pk.crit === 1) ? 'repair' : 'replace';
    case 'corrosion': return sev === 'high' ? 'replace' : 'repair';
    case 'scratch': return sev === 'low' ? 'monitor' : 'repair';
    case 'impact': return sev === 'low' ? 'monitor' : 'repair'; // an observation: inspect, never replace blind
    default: return sev === 'high' ? 'replace' : sev === 'mid' ? 'repair' : 'monitor'; // deform, dent, wear
  }
}

function baseLevelOf(d, pk, code, action, kb) {
  if (action === 'monitor') return ['unit', '운용자 점검'];
  if (isHelmet(code)) return ['unit', '교환 청구'];
  if (action === 'replace') {
    // without the model KB only the direct prerequisites are known
    const n = kb ? accessOrder(code, kb).length : pk.access.length;
    if (pk.crit <= 2 && UNIT_REPLACE_ROLES.includes(pk.role) && n <= 1) return ['unit', '구성품 교환'];
    if (['electronics', 'drive'].includes(pk.role)) return ['field', '전자·구동부 교환'];
    return ['field', n > 1 ? '부품 교환 — 분해·정렬 필요' : pk.crit === 3 ? '주요 부품 교환' : '부품 교환'];
  }
  const hard = ['electronics', 'drive'].includes(pk.role);
  if (d.type === 'impact') return ['unit', '충격 부위 점검'];
  if (['scratch', 'wear', 'corrosion'].includes(d.type) && pk.crit <= 2 && !hard) return ['unit', '표면 보수·윤활'];
  if (hard) return ['field', '전자·구동부 보수'];
  if (pk.crit === 3) return ['field', '주요 부품 보수'];
  return ['field', '구조 결함 보수'];
}

/** -> { risk, priority, action, level, baseLevel, needsConfirm, why }. Pass the model KB as `kb` so
 *  the replace echelon can use the full access path (assess(defect, partKb, code) works without it). */
export function assess(defect, partKb, code = defect && defect.part, kb = null) {
  const pk = normPart(partKb, code);
  const risk = riskOf(defect, pk);
  const sev = sevOf(defect);
  let priority = risk >= 60 ? 'P1' : risk >= 30 ? 'P2' : 'P3';
  let why = `위험도 ${risk}`;
  if (defect.type === 'crack' && sev !== 'low' && pk.crit === 3) {
    priority = 'P1';
    why = '주 구조 균열 — 진전 위험, 운용 중지';
  }
  if (pk.crit === 1 && priority === 'P1') {
    priority = 'P2';
    why = `위험도 ${risk} · 보조 부품(중요도 1) — 최대 P2`;
  }
  const action = actionOf(defect, pk, code);
  const [baseLevel, levelWhy] = baseLevelOf(defect, pk, code, action, kb);
  // a condemned defect stays at depot whatever its (forced) replace action would normally need
  const level = defect.condemned ? 'depot' : LEVEL_IDS[Math.min(2, LEVEL_IDS.indexOf(baseLevel) + clamp(num(defect.escalated, 0), 0, 2))];
  // low AI confidence, or a field signal (SQUAD LINK) that only says where to look
  const needsConfirm = (defect.conf != null && defect.conf < 0.8) || !!defect.confirm;
  return { risk, priority, action, level, baseLevel, needsConfirm, why: { priority: why, level: levelWhy } };
}

/** Whole-equipment diagnosis -> Report (see MAINT_SPEC §4). */
export function diagnose({ parts = [], defects = [], kb = null } = {}) {
  defects = arr(defects).filter((d) => d && d.id != null && d.part != null);
  const codes = [];
  const addCode = (c) => { if (c != null && !codes.includes(c)) codes.push(c); };
  arr(parts).forEach((p) => p && addCode(p.code));
  Object.keys((kb && kb.parts) || {}).forEach(addCode);
  defects.forEach((d) => addCode(d.part));
  const pk = Object.fromEntries(codes.map((c) => [c, kbPart(kb, c)]));

  const A = {};
  for (const d of defects) A[d.id] = assess(d, pk[d.part], d.part, kb);
  const open = defects.filter((d) => stateOf(d) === 'open');
  const repaired = defects.filter((d) => stateOf(d) === 'repaired');
  const closed = defects.filter((d) => stateOf(d) === 'closed');

  const reportDefects = {};
  for (const d of defects) reportDefects[d.id] = stateOf(d) === 'closed' ? { ...A[d.id], risk: 0 } : A[d.id];

  const reportParts = {};
  for (const c of codes) {
    const o = open.filter((d) => d.part === c);
    const r = repaired.filter((d) => d.part === c);
    const acts = o.map((d) => A[d.id].action);
    const health = round(100 * o.reduce((h, d) => h * (1 - 0.9 * A[d.id].risk / 100), 1));
    const status = acts.includes('replace') ? 'replace' : acts.includes('repair') ? 'repair'
      : acts.includes('monitor') ? 'watch' : r.length ? 'verify' : 'ok';
    const worst = o.reduce((w, d) => (!w || SEVERITY[sevOf(d)].rank > SEVERITY[w].rank ? sevOf(d) : w), null);
    reportParts[c] = { health, status, open: o.length, worst, crit: pk[c].crit, defects: [...o, ...r].map((d) => d.id) };
  }

  // the open defect that drives a part to `level` ('replace' | 'repair'), highest risk first
  const causeOn = (c, acts) => open.filter((d) => d.part === c && acts.includes(A[d.id].action))
    .sort((a, b) => A[b.id].risk - A[a.id].risk)[0];

  const functions = arr(kb && kb.functions).map((f) => {
    const ess = codes.filter((c) => pk[c].functions[f.id] === 'essential');
    const deg = codes.filter((c) => pk[c].functions[f.id] === 'degrade');
    const st = (c) => reportParts[c].status;
    let status = 'ok', by = [];
    const down = ess.filter((c) => st(c) === 'replace');
    const degraded = [...ess.filter((c) => st(c) === 'repair'), ...deg.filter((c) => st(c) === 'replace')];
    const watch = [...ess, ...deg].filter((c) => ['watch', 'verify', 'repair'].includes(st(c)));
    if (down.length) { status = 'down'; by = down; }
    else if (degraded.length) { status = 'degraded'; by = degraded; }
    else if (watch.length) { status = 'watch'; by = watch; }
    return { id: f.id, name: f.name || f.id, critical: !!f.critical, status, check: f.check || '', parts: by };
  });

  // readiness: flags decide the status; reasons are listed most severe first, each defect cited once
  let isNogo = false, isLimited = false;
  const nogo = [], limited = [], cited = new Set(), contrib = new Set();
  const funcCause = (f) => {
    const list = f.parts.map((c) => {
      const ess = pk[c].functions[f.id] === 'essential';
      const acts = f.status === 'down' ? ['replace'] : ess ? ['repair'] : ['replace'];
      return causeOn(c, acts);
    }).filter(Boolean).sort((a, b) => A[b.id].risk - A[a.id].risk);
    return list[0];
  };
  for (const f of functions) {
    if (f.status !== 'down' && f.status !== 'degraded') continue;
    const d = funcCause(f);
    const text = `${f.name} 기능 ${f.status === 'down' ? '상실' : '저하'}` + (d ? ` — ${defLabel(d)}` : '');
    if (d) cited.add(d.id);
    if (f.status === 'down' && f.critical) { isNogo = true; nogo.push(text); }
    else { isLimited = true; limited.push(text); }
  }
  const nogoP1 = [], nogoVerify = [], limitedP = [], limitedSupply = [], limitedVerify = [];
  for (const d of open) {
    const a = A[d.id], p = pk[d.part];
    // 관찰 등록 done: tracked at the next inspection, no readiness impact (P1 can never be put on watch)
    if (d.monitored && a.action === 'monitor' && a.priority !== 'P1') continue;
    const hasFn = Object.keys(p.functions).length > 0;
    if (a.action === 'replace' && hasFn) contrib.add(d.id);
    if (a.action === 'repair' && Object.values(p.functions).includes('essential')) contrib.add(d.id);
    if (a.priority === 'P1' && p.crit === 3) {
      isNogo = true;
      contrib.add(d.id);
      if (!cited.has(d.id)) nogoP1.push(`${d.part} ${typeKo(d)} 긴급 미조치`);
    } else if ((a.priority === 'P1' || a.priority === 'P2') && (p.crit >= 2 || hasFn)) {
      isLimited = true;
      contrib.add(d.id);
      if (!cited.has(d.id)) limitedP.push(`${d.part} ${typeKo(d)} ${PRIORITY[a.priority].ko} 미조치`);
    }
    if (d.wait === 'supply') {
      isLimited = true;
      contrib.add(d.id);
      limitedSupply.push(`${d.part} 보급 대기`);
    }
  }
  const verifyNogoParts = new Set();
  const holds = []; // repaired defects that keep the equipment NO-GO until they pass re-inspection
  for (const d of repaired) {
    if (A[d.id].priority === 'P1' && pk[d.part].crit === 3) {
      isNogo = true;
      holds.push(d.id);
      if (verifyNogoParts.has(d.part)) continue;
      verifyNogoParts.add(d.part);
      nogoVerify.push(`${d.part} 정비 후 검사 대기 — 검사 합격 전 운용 금지`);
    }
  }
  for (const c of codes) {
    if (reportParts[c].status !== 'verify' || pk[c].crit !== 3) continue;
    isLimited = true;
    if (!verifyNogoParts.has(c)) limitedVerify.push(`${c} 정비 후 검사 대기`);
  }
  nogo.push(...nogoP1, ...nogoVerify);
  limited.push(...limitedP, ...uniq(limitedSupply), ...limitedVerify);
  const status = isNogo ? 'NOGO' : isLimited ? 'LIMITED' : 'GO';
  const deferred = open.filter((d) => !contrib.has(d.id)).sort((a, b) => A[b.id].risk - A[a.id].risk).map((d) => d.id);
  const readiness = { status, ...READINESS[status], reasons: uniq([...nogo, ...limited]).slice(0, 4), deferred, deferredLabel: DEFERRED, holds };

  let wsum = 0, hsum = 0;
  for (const c of codes) { wsum += pk[c].crit; hsum += pk[c].crit * reportParts[c].health; }
  const health = wsum ? round(hsum / wsum) : 100;

  const counts = {
    open: open.length, high: 0, mid: 0, low: 0, repaired: repaired.length, closed: closed.length,
    fp: closed.filter((d) => d.fp && d.source !== 'live').length, // AI misreads only (a live signal that checked out fine is not one)
    escalated: defects.filter((d) => stateOf(d) !== 'closed' && num(d.escalated, 0) > 0).length,
    supply: open.filter((d) => d.wait === 'supply').length, P1: 0, P2: 0, P3: 0,
  };
  for (const d of open) { counts[sevOf(d)]++; counts[A[d.id].priority]++; }

  const byRisk = (a, b) => A[b.id].risk - A[a.id].risk || String(a.id).localeCompare(String(b.id), 'en', { numeric: true });
  const order = [
    ...[...open].sort(byRisk), ...[...repaired].sort(byRisk),
    ...closed.filter((d) => !d.fp), ...closed.filter((d) => d.fp),
  ].map((d) => d.id);

  return { defects: reportDefects, parts: reportParts, functions, readiness, health, counts, order };
}

/** Repair plan for one defect -> Plan (see MAINT_SPEC §4). */
export function repairPlan({ defect, parts = [], kb = null, modelKey = '', seq = 1 } = {}) {
  const code = defect.part;
  const pk = kbPart(kb, code);
  const a = assess(defect, pk, code, kb);
  const { action } = a;
  const monitor = action === 'monitor';
  const wo = workOrder(modelKey, defect.id, seq);
  // work card names: the KB's Korean name, else the Korean name from the file, else the display name
  const label = (c) => {
    const p = arr(parts).find((x) => x && x.code === c);
    const n = kbPart(kb, c).name || (p && (p.alt || p.name));
    return n ? (String(n).startsWith(c) ? n : `${c} ${n}`) : c;
  };
  const access = monitor ? [] : accessOrder(code, kb);
  const drive = pk.role === 'drive' || pk.safety.includes(SERVO_SAFETY);
  const extra = code === 'HP-01L' && (defect.type === 'dent' || defect.type === 'deform') ? [BATTERY_SAFETY] : [];
  const safety = uniq([...pk.safety, ...extra, ...access.flatMap((c) => kbPart(kb, c).safety)]);

  // functions fed by the target and by every part taken off on the way are all checked after reassembly
  const fed = new Set([code, ...access].flatMap((c) => Object.keys(kbPart(kb, c).functions)));
  const fns = arr(kb && kb.functions);
  const checks = fns.filter((f) => fed.has(f.id)).map((f) => f.check).filter(Boolean);
  const verify = uniq([VERIFY_DEFECT, ...checks, ...(access.length ? [VERIFY_REASSEMBLY] : [])]);

  let work;
  if (monitor) work = TYPES[defect.type]?.signal ? WORK_MONITOR_SIGNAL : WORK_MONITOR;
  else if (action === 'replace') {
    work = [`예비품 형상·부품번호(${code}) 대조`, '예비품 장착 (위치·방향 확인)', '체결 (규정 토크, 기술교범 확인)'];
    if (drive) work.push('선회/고각 원점·캘리브레이션');
    if (code === 'HP-01L') work.push('설정·동작 모드 유지 확인');
  } else work = WORK[defect.type] || WORK.dent;

  const steps = [];
  const add = (kind, part, text) => steps.push({ id: 's' + (steps.length + 1), kind, part, text });
  const confirm = defect.source === 'live'
    ? '실물 확인 — 실시간 신호는 관측일 뿐 손상 확정 아님 (이상 없으면 「이상 없음」 처리)'
    : `육안·계측으로 결함 확인 (AI 신뢰도 ${Math.round(num(defect.conf, 0) * 100)}%) — 결함 아니면 오탐 처리`;
  if (!monitor) {
    // isolate first (power, axes, stored energy), then touch and measure
    safety.forEach((s) => add('prep', null, s));
    if (a.needsConfirm) add('prep', code, confirm);
    access.forEach((c) => add('remove', c, `${label(c)} 분리`));
    if (action === 'replace') add('remove', code, `${label(code)} 분리 (교체 대상)`);
  }
  if (monitor && a.needsConfirm) add('prep', code, confirm);
  work.forEach((t, i) => add('work', code, `${NUM[i] || `${i + 1}.`} ${t}`));
  if (!monitor) {
    [...access].reverse().forEach((c) => add('install', c, `${label(c)} 역순 조립 — 체결 ${TORQUE}`));
    add('install', null, RESTORE); // the powered checks below need the isolation undone
    verify.forEach((t) => add('verify', code, t));
  }
  add('record', code, `${monitor ? '관찰 등록' : '정비 결과 기록'} — 작업지시 ${wo} · 소요 시간·측정값·사용 부품 정비 이력 등록`);

  const workMin = action === 'replace' ? pk.replace : action === 'repair' ? REPAIR_MIN[defect.type] || 25 : 5;
  const minutes = 5 + access.reduce((s, c) => s + kbPart(kb, c).remove * 2, 0) + workMin + 10;

  const tools = monitor ? ['버니어 캘리퍼스'] : uniq([
    ...access.flatMap((c) => kbPart(kb, c).tools), ...pk.tools,
    ...(action === 'repair' ? REPAIR_TOOLS[defect.type] || [] : ['버니어 캘리퍼스']), '토크 드라이버',
  ]);
  const materials = monitor ? [] : uniq([...(action === 'repair' ? REPAIR_MATERIALS[defect.type] || [] : []), ...pk.materials]);

  return {
    id: defect.id, part: code, wo, action, priority: a.priority, level: a.level, baseLevel: a.baseLevel, minutes,
    access, steps, tools, materials, safety, verify, note: pk.note,
    risk: a.risk, needsConfirm: a.needsConfirm, why: a.why, spare: action === 'replace' ? pk.spare : null,
  };
}

/**
 * Technician result -> { defect: updated copy, log }. ctx = { modelKey, seq, planned, kb, level? }: pass the
 * model KB (or the defect's current level from the report), else the echelon of a failed repair is guessed
 * from default part data.
 */
export function applyFeedback(defect, fb = {}, ctx = {}) {
  const d = { ...defect };
  const result = fb.result || 'done';
  const wo = workOrder(ctx.modelKey, defect.id, ctx.seq);
  const kb = ctx.kb || null;
  const before = assess(defect, kbPart(kb, defect.part), defect.part, kb);
  // keeps the echelon already reached when the base echelon changes (severity or action changed)
  const rebase = () => {
    const base = assess({ ...d, escalated: 0 }, kbPart(kb, d.part), d.part, kb).baseLevel;
    const reached = LEVEL_IDS.indexOf(ctx.level || before.level);
    const wasEscalated = reached > LEVEL_IDS.indexOf(before.baseLevel); // a real referral happened
    d.escalated = wasEscalated ? Math.max(0, reached - LEVEL_IDS.indexOf(base)) : 0;
  };
  let reason = null, text = '', kind = 'repair';
  d.monitored = null; // only a fresh 관찰 등록 below marks the defect as monitored
  if (result === 'done' && before.action === 'monitor') {
    // monitoring is not a repair: the defect stays open (deferred) and is tracked at the next inspection
    d.status = 'open';
    d.wait = null;
    d.monitored = fb.at || new Date().toISOString();
    text = '관찰 등록 — 추적 점검 대상 유지 (다음 정기 점검 시 재측정)';
  } else if (result === 'done') {
    d.status = 'repaired';
    d.wait = null;
    text = '수리 완료 — 재검사 대기';
  } else if (result === 'partial') {
    const from = sevOf(defect);
    d.status = 'open';
    d.origSev = defect.origSev || from;
    d.sev = SEV_DOWN[from];
    d.wait = null; // work was carried out, so the defect no longer waits for parts
    const m = num(fb.measured, null);
    if (m != null) d.size = m;
    rebase();
    text = (d.sev === from ? `부분 수리 — 심각도 ${SEVERITY[from].ko} 유지` : `부분 수리 — 심각도 ${SEVERITY[from].ko} → ${SEVERITY[d.sev].ko}`) + (m != null ? ` · 잔여 ${m} mm` : '');
  } else if (result === 'replace') {
    d.status = 'open';
    d.forceReplace = true;
    d.forceMonitor = false;
    rebase();
    text = '교체 전환 — 보수로 회복 불가 판단, 교체로 변경';
  } else if (result === 'monitor' && defect.condemned) {
    d.status = 'open';
    text = '불용 판정 결함 — 관찰 전환 불가 (대체품 청구 유지)';
  } else if (result === 'monitor') {
    d.status = 'open';
    d.forceMonitor = true;
    d.forceReplace = false;
    d.wait = null;
    rebase();
    text = '관찰 전환 — 기능 영향 없음 판단, 추적 점검으로 변경';
  } else if (result === 'fail') {
    reason = fb.reason === 'supply' ? 'supply' : 'capability';
    d.status = 'open';
    if (reason === 'supply') {
      d.wait = 'supply';
      text = '부품 없음 — 보급 대기';
    } else {
      d.wait = null; // the attempt was made, so parts were there
      const level = ctx.level || before.level;
      if (!defect.condemned && level !== 'depot') {
        d.escalated = Math.min(2, num(defect.escalated, 0) + 1);
        text = level === 'unit' ? '수리 불가 → 야전정비 의뢰' : '수리 불가 → 창정비 후송';
      } else {
        d.condemned = true;
        text = '창정비 수리 불가 — 불용 판정, 대체품 청구';
      }
    }
  } else if (result === 'false') {
    d.status = 'closed';
    d.fp = true;
    kind = 'fp';
    // only an AI detection can be an AI misread; a manual entry is simply withdrawn, a field signal checked out fine
    if (defect.source === 'live') kind = 'clear';
    text = defect.source === 'manual' ? '등록 취소 — 결함 아님 (수동 등록)'
      : defect.source === 'live' ? '점검 결과 이상 없음 — 실시간 신호 항목 종료'
        : '오탐 판정 — AI 판독 오류 (재학습 데이터)';
  }
  if (fb.memo != null && fb.memo !== '') d.memo = fb.memo;
  const log = {
    at: fb.at || new Date().toISOString(), kind, id: defect.id, part: defect.part, wo, result, reason,
    by: fb.by || '', minutes: num(fb.minutes, null), planned: num(ctx.planned, null), measured: num(fb.measured, null),
    memo: fb.memo || '', text,
  };
  if (fb.partsUsed) log.partsUsed = fb.partsUsed;
  return { defect: d, log };
}

/** Re-inspection after a repair -> { defect: updated copy, log }. */
export function reinspect(defect, { at, pass = true, by = '', simulated = defect.source === 'sample' } = {}) {
  const d = { ...defect };
  const log = { at: at || new Date().toISOString(), kind: 'inspect', id: defect.id, part: defect.part, result: '', by, simulated, text: '' };
  if (simulated && defect.source !== 'sample') {
    // a simulated scan must never close a real (manual / imported) defect
    log.result = 'skip';
    log.text = '시뮬레이션 재검사는 예시 결함에만 사용';
    return { defect: d, log };
  }
  if (pass) {
    d.status = 'closed';
    d.wait = null;
    log.result = 'pass';
    log.text = simulated ? 'AI 재검사(시뮬레이션·예시): 결함 미검출' : `재검사 합격 — 검사자 ${by || '미기재'} 확인`;
  } else {
    d.status = 'open';
    d.monitored = null;
    d.rework = num(defect.rework, 0) + 1;
    log.result = 'fail';
    log.text = `재검사 불합격 — 재작업 지시 (${d.rework}회차)`;
  }
  return { defect: d, log };
}
