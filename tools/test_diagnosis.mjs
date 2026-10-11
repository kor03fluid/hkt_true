// Checks the maintenance rule engine (src/diagnosis.js) against the knowledge base, the manifests and
// the sample defects. Run: node tools/test_diagnosis.mjs  (no dependencies; exit 1 on failure)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TYPES, SEVERITY, riskOf, assess, diagnose, repairPlan, applyFeedback, reinspect, accessOrder, workOrder,
  runtimeDefect,
} from '../src/diagnosis.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const KB = readJson('web/maintenance.json');
const DEFECTS = readJson('web/defects.json');
const MODELS = ['Turret', 'hailo-Modern', 'hailo-Legacy'];
const PARTS = Object.fromEntries(MODELS.map((k) => [k, readJson(`web/models/${k}.json`).parts
  .map((p) => ({ code: p.code, name: p.name, group: p.group }))]));

let fails = 0, passes = 0;
const ok = (cond, msg) => {
  if (cond) passes++;
  else { fails++; console.log('  FAIL', msg); }
};
const eq = (got, want, msg) => ok(JSON.stringify(got) === JSON.stringify(want), `${msg}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const sample = (key) => DEFECTS[key].map((d) => runtimeDefect(d, 'sample'));
const run = (key, defects) => diagnose({ parts: PARTS[key], defects, kb: KB[key] });
const mk = (part, type, sev, size, extra = {}) => runtimeDefect({ id: 'X1', part, type, sev, size, conf: 0.9, ...extra }, 'manual');
const as = (key, d) => assess(d, KB[key].parts[d.part], d.part, KB[key]);

// --- knowledge base vs manifests -------------------------------------------------------------
console.log('KB');
for (const key of MODELS) {
  const kb = KB[key];
  ok(kb && kb.parts && Array.isArray(kb.functions), `${key}: KB present`);
  const codes = PARTS[key].map((p) => p.code);
  const fnIds = kb.functions.map((f) => f.id);
  for (const c of codes) ok(kb.parts[c], `${key}: KB entry for ${c}`);
  for (const [c, p] of Object.entries(kb.parts)) {
    ok(codes.includes(c), `${key}: KB part ${c} exists in manifest`);
    ok([1, 2, 3].includes(p.crit), `${key} ${c}: crit`);
    for (const f of Object.keys(p.functions)) ok(fnIds.includes(f), `${key} ${c}: function ${f} defined`);
    for (const v of Object.values(p.functions)) ok(v === 'essential' || v === 'degrade', `${key} ${c}: function link kind`);
    for (const a of p.access) ok(codes.includes(a) && a !== c, `${key} ${c}: access ${a} is a real code`);
    for (const l of p.links) {
      ok(codes.includes(l), `${key} ${c}: link ${l} is a real code`);
      ok(kb.parts[l] && kb.parts[l].links.includes(c), `${key} ${c}: link ${l} is symmetric`);
    }
    ok(p.remove > 0 && p.replace > 0, `${key} ${c}: minutes`);
    ok(p.tools.length > 0, `${key} ${c}: tools`);
    eq(p.spare, `${c} 예비품 (동일 형상 · 재질은 원 설계 확인)`, `${key} ${c}: spare text`);
  }
  // acyclic: DFS with colours over direct prerequisites
  const colour = {};
  let cyclic = false;
  const dfs = (c) => {
    colour[c] = 1;
    for (const a of kb.parts[c].access) {
      if (colour[a] === 1) cyclic = true;
      else if (!colour[a] && kb.parts[a]) dfs(a);
    }
    colour[c] = 2;
  };
  Object.keys(kb.parts).forEach((c) => colour[c] || dfs(c));
  ok(!cyclic, `${key}: access graph is acyclic`);
  // accessOrder is topological: every prerequisite of an entry comes before it
  for (const c of codes) {
    const order = accessOrder(c, kb);
    ok(!order.includes(c) && new Set(order).size === order.length, `${key} ${c}: accessOrder deduped, no self`);
    order.forEach((x, i) => kb.parts[x].access.forEach((y) => ok(order.indexOf(y) > -1 && order.indexOf(y) < i, `${key} ${c}: ${y} before ${x}`)));
  }
}
eq(accessOrder('B-02', KB.Turret), ['L-01', 'B-01'], 'Turret B-02 reached from below');
eq(accessOrder('HP-01L', KB['hailo-Modern']), ['HP-04'], 'HP-01L prerequisite');
for (const c of ['H-03', 'H-04', 'H-05', 'H-06']) ok(accessOrder(c, KB.Turret).includes('H-09'), `${c} sits inside H-09`);
eq(workOrder('Turret', 'T1', 1), 'Turret-T1-01', 'work order');

// --- risk / priority / action tables -------------------------------------------------------
console.log('Rules');
const pk3 = { crit: 3, role: 'structure' }, pk2 = { crit: 2, role: 'structure' }, pk1 = { crit: 1, role: 'demo' };
eq(riskOf({ type: 'crack', sev: 'high', size: 40 }, pk3), 100, 'risk crack/high/crit3/size40 (clamped sizeF)');
eq(riskOf({ type: 'crack', sev: 'high', size: 0 }, pk3), 75, 'risk sizeF floor');
eq(riskOf({ type: 'scratch', sev: 'low', size: 10 }, pk2), 7, 'risk scratch/low/crit2');
eq(riskOf({ type: 'wear', sev: 'low', size: 10 }, pk3), 17, 'risk wear/low/crit3 (16.5 rounds up)');
eq(riskOf({ type: 'deform', sev: 'mid', size: 14 }, pk3), 53, 'risk deform/mid');
eq(riskOf({ type: 'corrosion', sev: 'mid', size: 8 }, pk1), 20, 'risk corrosion/mid/crit1');
eq(riskOf({ type: 'dent', sev: 'high', size: 20 }, null), 56, 'risk with null KB (crit 2 default)');
const pa = (d, pk) => { const a = assess(d, pk, d.part || 'Z-01'); return [a.priority, a.action]; };
eq(pa({ type: 'crack', sev: 'high', size: 7 }, pk3), ['P1', 'replace'], 'crack high crit3');
eq(pa({ type: 'crack', sev: 'mid', size: 5 }, pk3), ['P1', 'replace'], 'override (a): crack mid crit3 -> P1');
eq(pa({ type: 'crack', sev: 'low', size: 40 }, pk3), ['P2', 'repair'], 'crack low -> repair, no override');
eq(pa({ type: 'crack', sev: 'mid', size: 10 }, pk1), ['P2', 'repair'], 'crack mid crit1 -> repair (risk 30)');
eq(pa({ type: 'crack', sev: 'high', size: 40 }, pk1), ['P2', 'replace'], 'override (b): crit1 capped at P2');
eq(pa({ type: 'deform', sev: 'high', size: 10 }, pk2), ['P1', 'replace'], 'deform high (risk 60)');
eq(pa({ type: 'deform', sev: 'mid', size: 10 }, pk2), ['P2', 'repair'], 'deform mid');
eq(pa({ type: 'deform', sev: 'low', size: 10 }, pk2), ['P3', 'monitor'], 'deform low');
eq(pa({ type: 'corrosion', sev: 'high', size: 10 }, pk3), ['P1', 'replace'], 'corrosion high');
eq(pa({ type: 'corrosion', sev: 'low', size: 10 }, pk3), ['P3', 'repair'], 'corrosion low -> repair');
eq(pa({ type: 'dent', sev: 'low', size: 10 }, pk3), ['P3', 'monitor'], 'dent low');
eq(pa({ type: 'wear', sev: 'high', size: 10 }, pk3), ['P2', 'replace'], 'wear high');
eq(pa({ type: 'scratch', sev: 'high', size: 10 }, pk3), ['P2', 'repair'], 'scratch high -> repair (risk 30)');
eq(pa({ type: 'scratch', sev: 'low', size: 10 }, pk3), ['P3', 'monitor'], 'scratch low');
eq(pa({ type: 'scratch', sev: 'low', size: 10, condemned: true }, pk3), ['P3', 'replace'], 'condemned forces replace');
const kbM = KB['hailo-Modern'];
eq(as('hailo-Modern', mk('DH-01', 'crack', 'mid', 10)).action, 'monitor', 'DH-* never repaired: mid -> monitor');
eq(['action', 'level'].map((k) => as('hailo-Modern', mk('DH-01', 'dent', 'high', 10))[k]), ['replace', 'unit'], 'DH-* high -> replace/unit');
ok(as('hailo-Modern', mk('DH-01', 'scratch', 'low', 5, { conf: 0.6 })).needsConfirm, 'needsConfirm conf < 0.8');
ok(!as('hailo-Modern', mk('DH-01', 'scratch', 'low', 5, { conf: null })).needsConfirm, 'manual (conf null) no confirm');

// hand cases
const al = (key, part, type, sev, size) => { const a = as(key, mk(part, type, sev, size)); return `${a.action}/${a.level}`; };
eq(al('hailo-Modern', 'HP-04', 'crack', 'high', 10), 'replace/unit', 'hand: HP-04 crack high');
eq(al('hailo-Modern', 'HP-01L', 'crack', 'high', 10), 'replace/field', 'hand: HP-01L crack high');
eq(al('Turret', 'B-04', 'wear', 'mid', 10), 'repair/field', 'hand: B-04 wear mid');
eq(al('Turret', 'Y-02', 'scratch', 'mid', 10), 'repair/unit', 'hand: Y-02 scratch mid');
{
  const d = mk('H-06', 'crack', 'high', 20);
  eq(as('Turret', d).priority, 'P2', 'hand: H-06 crack high size 20 -> P2');
  const r = run('Turret', [d]);
  eq(r.readiness.status, 'GO', 'hand: H-06 readiness unaffected');
  eq(r.readiness.deferred, ['X1'], 'hand: H-06 defect deferred');
}
{
  const d = mk('L-01', 'crack', 'mid', 5);
  eq(as('Turret', d).priority, 'P1', 'hand: L-01 crack mid size 5 -> P1');
  eq(run('Turret', [d]).readiness.status, 'NOGO', 'hand: L-01 crack mid -> NOGO');
}
eq(al('hailo-Modern', 'HP-02L', 'crack', 'high', 10), 'replace/field', 'HP-02L replace needs 2 removals -> field');
eq(al('hailo-Modern', 'HP-02R', 'crack', 'high', 10), 'replace/unit', 'HP-02R replace (1 removal) -> unit');
eq(al('Turret', 'B-02', 'scratch', 'mid', 10), 'repair/field', 'electronics repair -> field');
eq(al('Turret', 'H-10', 'scratch', 'mid', 10), 'repair/unit', 'demo scratch repair -> unit');

// partial / null KB never throws
{
  const r = diagnose({ parts: [{ code: 'A' }], defects: [mk('A', 'crack', 'high', 10)], kb: null });
  eq([r.parts.A.status, r.functions.length, r.readiness.status], ['replace', 0, 'LIMITED'], 'null KB: defaults (crit 2)');
  const p = repairPlan({ defect: mk('A', 'dent', 'mid', 10), parts: [], kb: null, modelKey: 'local:x', seq: 3 });
  ok(p.steps.length > 0 && p.wo === 'local:x-X1-03', 'null KB: plan');
}

// --- sample data readiness -----------------------------------------------------------------
console.log('Sample readiness');
const want = { Turret: 'NOGO', 'hailo-Modern': 'LIMITED', 'hailo-Legacy': 'GO' };
const reports = {};
for (const key of MODELS) {
  reports[key] = run(key, sample(key));
  eq(reports[key].readiness.status, want[key], `${key} readiness`);
  eq(reports[key].counts.open, DEFECTS[key].length, `${key} open count`);
}

// repaired P1 stays NO-GO until re-inspected, then the Turret is no longer NO-GO
{
  const key = 'Turret';
  let defs = sample(key);
  const r0 = reports[key];
  const p1 = defs.filter((d) => r0.defects[d.id].priority === 'P1');
  eq(p1.map((d) => d.id), ['T1', 'T2'], 'Turret P1 defects');
  defs = defs.map((d) => (p1.includes(d) ? applyFeedback(d, { result: 'done', at: 'T' }, { modelKey: key, seq: 1, kb: KB[key] }).defect : d));
  const r1 = run(key, defs);
  eq(r1.readiness.status, 'NOGO', 'Turret after repair, before re-inspection');
  ok(r1.readiness.reasons.includes('L-01 정비 후 검사 대기 — 검사 합격 전 운용 금지'), 'repaired-P1 NO-GO reason');
  eq([r1.parts['L-01'].status, r1.parts['L-01'].health], ['verify', 100], 'repaired part: verify, health ignores it');
  eq(r1.counts.repaired, 2, 'repaired count');
  defs = defs.map((d) => (d.status === 'repaired' ? reinspect(d, { at: 'T' }).defect : d));
  const r2 = run(key, defs);
  ok(r2.readiness.status !== 'NOGO', `Turret after repair + reinspect of P1: ${r2.readiness.status}`);
  eq(r2.counts.closed, 2, 'closed count');
  eq(r2.defects.T1.risk, 0, 'closed defect risk 0');
  eq(r2.order.slice(-2), ['T1', 'T2'], 'closed last in order');
}

// --- feedback loop -------------------------------------------------------------------------
console.log('Feedback');
{
  const d0 = sample('Turret').find((d) => d.id === 'T3');
  const { defect: d1 } = applyFeedback(d0, { result: 'done' }, { modelKey: 'Turret', seq: 1 });
  const fail = reinspect(d1, { pass: false, at: 'T' });
  eq([fail.defect.status, fail.defect.rework, fail.log.text], ['open', 1, '재검사 불합격 — 재작업 지시 (1회차)'], 'reinspect fail reopens');
  const pass = reinspect(d1, { at: 'T' });
  eq([pass.defect.status, pass.log.text], ['closed', 'AI 재검사(시뮬레이션·예시): 결함 미검출'], 'simulated reinspect closes sample');
  const real = reinspect({ ...d1, source: 'manual' }, { at: 'T', simulated: false, by: '김정비' });
  eq([real.defect.status, real.log.text], ['closed', '재검사 합격 — 검사자 김정비 확인'], 'manual reinspect');
  const sim = reinspect({ ...d1, source: 'import' }, { at: 'T', simulated: true });
  eq([sim.defect.status, sim.log.text], ['repaired', '시뮬레이션 재검사는 예시 결함에만 사용'], 'simulated reinspect never closes real defect');

  const part = applyFeedback(d0, { result: 'partial', measured: 9, at: 'T' }, { modelKey: 'Turret', seq: 2 });
  eq([part.defect.status, part.defect.sev, part.defect.origSev, part.defect.size], ['open', 'low', 'mid', 9], 'partial: sev down, size measured');
  const part2 = applyFeedback(part.defect, { result: 'partial' }, {});
  eq([part2.defect.sev, part2.defect.origSev], ['low', 'mid'], 'partial: low stays low, origSev kept');

  const legacy = sample('hailo-Legacy');
  const sup = applyFeedback(legacy[0], { result: 'fail', reason: 'supply', at: 'T' }, { modelKey: 'hailo-Legacy', seq: 1, kb: KB['hailo-Legacy'] });
  eq([sup.defect.status, sup.defect.wait, sup.defect.escalated, sup.log.text], ['open', 'supply', 0, '부품 없음 — 보급 대기'], 'fail/supply');
  const rs = run('hailo-Legacy', [sup.defect, ...legacy.slice(1)]);
  eq([rs.readiness.status, rs.counts.supply], ['LIMITED', 1], 'supply wait -> LIMITED');
  ok(rs.readiness.reasons.includes(`${legacy[0].part} 보급 대기`), 'supply reason');

  // escalation chain: unit -> field -> depot -> condemned
  const ctx = { modelKey: 'Turret', seq: 1, kb: KB.Turret };
  let d = mk('Y-02', 'scratch', 'mid', 10);
  eq(as('Turret', d).level, 'unit', 'chain start unit');
  const texts = [];
  for (let i = 0; i < 3; i++) {
    const r = applyFeedback(d, { result: 'fail', at: 'T' }, ctx);
    d = r.defect;
    texts.push(r.log.text);
    ok(r.log.reason === 'capability' && r.log.kind === 'repair' && r.log.wo === 'Turret-X1-01', 'fail log fields');
  }
  eq(texts, ['수리 불가 → 야전정비 의뢰', '수리 불가 → 창정비 후송', '창정비 수리 불가 — 불용 판정, 대체품 청구'], 'escalation texts');
  eq([d.escalated, d.condemned, as('Turret', d).action, as('Turret', d).level], [2, true, 'replace', 'depot'], 'escalation end state');
  eq(run('Turret', [d]).counts.escalated, 1, 'escalated count');

  const fp = applyFeedback(sample('hailo-Modern')[3], { result: 'false', at: 'T' }, { modelKey: 'hailo-Modern', seq: 1 });
  eq([fp.defect.status, fp.defect.fp, fp.log.kind, fp.log.text], ['closed', true, 'fp', '오탐 판정 — AI 판독 오류 (재학습 데이터)'], 'false -> fp');
  const rf = run('hailo-Modern', sample('hailo-Modern').map((x) => (x.id === fp.defect.id ? fp.defect : x)));
  eq([rf.counts.fp, rf.counts.closed, rf.order[rf.order.length - 1]], [1, 1, fp.defect.id], 'fp counted and last');
}

// --- plans ---------------------------------------------------------------------------------
console.log('Plans');
const BANNED = [/\bPLA\b/i, /\bPETG\b/i, /\bABS\b/i, /나일론/, /알루미늄/, /스틸/, /강철/, /플라스틱/, /금속제/, /3D ?프린팅/, /재출력/];
const banned = (text, where) => {
  for (const re of BANNED) ok(!re.test(text), `material word ${re} in ${where}`);
};
banned(JSON.stringify(KB), 'web/maintenance.json');
banned(JSON.stringify(DEFECTS), 'web/defects.json');
const plans = {};
for (const key of MODELS) {
  plans[key] = sample(key).map((d, i) => repairPlan({ defect: d, parts: PARTS[key], kb: KB[key], modelKey: key, seq: i + 1 }));
  for (const p of plans[key]) {
    const d = DEFECTS[key].find((x) => x.id === p.id);
    ok(p.steps.length >= 3, `${key} ${p.id}: plan has steps`);
    ok(p.steps.every((s, i) => s.id === `s${i + 1}` && s.text), `${key} ${p.id}: step ids/text`);
    eq(p.steps[p.steps.length - 1].kind, 'record', `${key} ${p.id}: ends with record`);
    if (d.conf < 0.8) ok(p.steps[0].text.startsWith('육안·계측으로 결함 확인 (AI 신뢰도'), `${key} ${p.id}: confirm first`);
    if (p.action === 'monitor') {
      ok(p.access.length === 0 && !p.steps.some((s) => s.kind === 'remove' || s.kind === 'install'), `${key} ${p.id}: monitor has no disassembly`);
      eq(p.minutes, 20, `${key} ${p.id}: monitor minutes`);
    } else {
      eq(p.steps.filter((s) => s.kind === 'remove').map((s) => s.part), [...p.access, ...(p.action === 'replace' ? [p.part] : [])], `${key} ${p.id}: remove steps`);
      eq(p.steps.filter((s) => s.kind === 'install').map((s) => s.part), [...p.access].reverse(), `${key} ${p.id}: install reversed`);
      const kinds = p.steps.map((s) => s.kind);
      ok(kinds.join(',').match(/^(prep,)*(remove,)*(work,)+(install,)*(verify,)+record$/), `${key} ${p.id}: step order ${kinds}`);
    }
    eq(p.verify[0], '결함 부위 육안·계측 재확인 — 잔여 결함 없음', `${key} ${p.id}: verify first`);
    eq(p.verify.includes('분해 부품 전수 재조립·체결 확인'), p.access.length > 0, `${key} ${p.id}: reassembly check`);
    banned(JSON.stringify(p), `${key} ${p.id} plan`);
  }
}
{
  // minutes formula and specific texts on known plans
  const t1 = plans.Turret.find((p) => p.id === 'T1');
  const kbT = KB.Turret;
  eq(t1.minutes, 5 + 0 + kbT.parts['L-01'].replace + 10, 'T1 minutes (L-01 replace, no access)');
  const t2 = plans.Turret.find((p) => p.id === 'T2');
  eq(t2.access, ['H-10', 'H-08', 'Y-02'], 'T2 access (tilt frame)');
  eq(t2.minutes, 5 + (5 + 5 + 8) * 2 + kbT.parts['H-01v4'].replace + 10, 'T2 minutes');
  ok(t2.steps.some((s) => s.text.endsWith('선회/고각 원점·캘리브레이션')), 'T2 axis calibration');
  ok(t2.verify.includes(kbT.functions.find((f) => f.id === 'vision').check), 'T2 verify includes vision check');
  const t3 = plans.Turret.find((p) => p.id === 'T3');
  ok(t3.steps.some((s) => s.text === '② 윤활 또는 심(shim) 조정') && t3.materials.includes('윤활제'), 'T3 wear repair steps');
  ok(t3.safety.includes('서보 전원 차단 후 선회·고각 축을 손으로 고정 (급회전 방지)'), 'T3 drive safety');
  const hp = repairPlan({ defect: mk('HP-01L', 'dent', 'high', 10), parts: PARTS['hailo-Modern'], kb: kbM, modelKey: 'hailo-Modern', seq: 1 });
  ok(hp.safety.includes('배터리 팽창·발열 확인 — 이상 시 즉시 격리') && hp.steps.some((s) => s.text.endsWith('설정·동작 모드 유지 확인')), 'HP-01L dent: battery safety + mode check');
  ok(hp.steps.some((s) => s.text.includes('규정 토크 (기술교범 확인)')), 'torque as 규정값');
  const cr = repairPlan({ defect: mk('B-03', 'crack', 'low', 10), parts: PARTS.Turret, kb: kbT, modelKey: 'Turret', seq: 1 });
  ok(cr.steps.some((s) => s.text === '② 균열 끝 정지 홀 가공 (∅1 mm, 예시)'), 'crack repair steps');
  // work cards name the parts in Korean (KB name), and verify every function touched on the way
  ok(t2.steps.some((s) => s.text === 'H-01v4 틸트 프레임 분리 (교체 대상)'), 'T2 Korean part name on the work card');
  ok(t3.verify.includes(kbT.functions.find((f) => f.id === 'vision').check), 'T3 verify includes the vision check (H-08 taken off)');
  ok(t1.safety.includes('다리 분리 전 본체를 작업대·받침에 고정 (전도·낙하 방지)'), 'T1 body support before removing the legs');
  ok(t2.safety.some((s) => s.startsWith('피스톤·래치 저장 에너지 해제')), 'T2 stored-energy precaution via H-01v4');
}

// --- regressions: condemnation is final; the level can come from the report ------------------
console.log('Regressions');
{
  const kbM = KB['hailo-Modern'];
  const ctx = { modelKey: 'hailo-Modern', seq: 1, planned: 30, kb: kbM };
  let d = mk('HP-05', 'dent', 'mid', 10);
  const texts = [];
  for (let k = 0; k < 3; k++) {
    const out = applyFeedback(d, { result: 'fail', reason: 'capability' }, ctx);
    d = out.defect;
    texts.push(out.log.text);
  }
  eq(texts, ['수리 불가 → 창정비 후송', '창정비 수리 불가 — 불용 판정, 대체품 청구', '창정비 수리 불가 — 불용 판정, 대체품 청구'], 'HP-05 dent fail chain ends condemned and stays there');
  eq(as('hailo-Modern', d).level, 'depot', 'condemned defect stays at depot');
  const b4 = mk('B-04', 'wear', 'mid', 16);
  const lvl = as('Turret', b4).level;
  eq(applyFeedback(b4, { result: 'fail' }, { modelKey: 'Turret', seq: 1, level: lvl }).log.text, '수리 불가 → 창정비 후송', 'level from the report decides the escalation');
  const noPart = diagnose({ parts: PARTS.Turret, defects: [{ id: 'Z1', type: 'crack', sev: 'high', size: 5 }], kb: KB.Turret });
  ok(noPart && noPart.counts.open === 0, 'a defect without a part is ignored, not a crash');
}

// --- summary ---------------------------------------------------------------------------------
console.log('\nSummary (예시 데이터)');
for (const key of MODELS) {
  const r = reports[key];
  const c = r.counts;
  console.log(`${key.padEnd(13)} ${r.readiness.status.padEnd(7)} health ${String(r.health).padStart(3)}  open ${c.open} (위험 ${c.high}/주의 ${c.mid}/경미 ${c.low})  P1 ${c.P1} P2 ${c.P2} P3 ${c.P3}  deferred [${r.readiness.deferred}]`);
  r.readiness.reasons.forEach((t) => console.log(`  · ${t}`));
  const top = plans[key].find((p) => p.id === r.order[0]);
  const d = DEFECTS[key].find((x) => x.id === top.id);
  console.log(`  top ${top.wo}: ${top.part} ${TYPES[d.type].ko}(${SEVERITY[d.sev].ko}) risk ${top.risk} ${top.priority} ${top.action}/${top.level} ${top.minutes}분(예시) access [${top.access.join(' → ')}] steps ${top.steps.length}`);
  console.log(`  order ${r.order.map((id) => `${id}:${r.defects[id].risk}${r.defects[id].priority}`).join(' ')}`);
}
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
