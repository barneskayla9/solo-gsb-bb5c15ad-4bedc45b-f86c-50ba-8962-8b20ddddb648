// 岗位名与对象继承属性同名（constructor / __proto__ / toString）回归测试。
//
// 背景：以岗位名为键的记录（confirmations / substitutions / cueHistory 及共享
// 折叠内核的 confirmsMap / substitutionsMap）若使用普通对象字面量，读取会命中
// Object.prototype 继承属性（未确认被误判已确认、未替岗被误判已接管、有效目标
// 被映射成空值），写入 __proto__ 甚至会改动对象原型而非建立自有键（JSON 快照
// 与历史封存随之丢失该岗位记录）。修复后这些名称作为普通岗位保留原文。
//
// 覆盖：
//   A. 共享折叠内核（纯函数，Node require 实体与浏览器 <script> 形态各一份）：
//      同名岗位的确认 / 替岗 / 封存按日志重建，与服务端实时状态机结论一致；
//   B. 端到端（需服务已在 localhost:3000 启动）：同名岗位的确认、替岗、超时
//      标记移交、撤回新轮次无残留、推进后历史封存完整、WebSocket JSON 快照
//      与复盘接口重建结果均完整；
//   C. 前端静态约束：控制端 / 岗位端 / common.js 以 CueClient.own 安全读取
//      岗位键，服务端与内核使用无原型字典。
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const Core = require('../public/replay-core');

const URL = 'ws://localhost:3000/ws';
let passed = 0, failed = 0;

function check(name, cond) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.log(`  ✘ ${name}`); }
}
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 与 Object.prototype 继承属性同名的三个岗位
const P_CTOR = 'constructor';
const P_PROTO = '__proto__';
const P_TOSTR = 'toString';
const P_LIGHT = '灯光';

// ---------------------------------------------------------------------------
// A. 共享折叠内核：同名岗位按日志重建（Node 实体 + 浏览器形态同源断言）
// ---------------------------------------------------------------------------
function loadBrowserCore() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'replay-core.js'), 'utf8');
  const withoutExport = src.replace(/\nif \(typeof module[\s\S]*$/, '');
  const fn = new Function(withoutExport.replace('const ReplayCore = (() => {', 'return (() => {'));
  return fn();
}

const BASE_TS = Date.parse('2026-09-21T08:00:00.000Z');
let lineSeq = 0;
function ev(t, event, detail) {
  return { line: ++lineSeq, ts: new Date(BASE_TS + t).toISOString(), t, event, detail: detail || {} };
}

// 同名岗位全流程事件流：确认、替岗（含超时标记移交）、撤回封存、迟到确认
function protoEvents() {
  lineSeq = 0;
  return [
    ev(0, 'session-start', {}),
    ev(0, 'cue-started', { seq: 1, text: '同名岗位口令', targets: [P_CTOR, P_PROTO, P_TOSTR], revision: 1, attemptId: 'a1' }),
    ev(500, 'confirm', { seq: 1, position: P_CTOR, attemptId: 'a1' }),
    ev(600, 'position-substituted', { seq: 1, from: P_TOSTR, to: P_LIGHT, attemptId: 'a1', revision: 1 }),
    ev(700, 'confirm', { seq: 1, position: P_PROTO, attemptId: 'a1' }),
    ev(800, 'cue-recalled', { seq: 1, oldRevision: 1, newRevision: 2, oldAttemptId: 'a1', reason: '措辞修正', newText: '同名岗位口令（修订）' }),
    ev(800, 'cue-resent', { seq: 1, text: '同名岗位口令（修订）', reason: '措辞修正', revision: 2, attemptId: 'a2' }),
    ev(900, 'confirm', { seq: 1, position: P_CTOR, attemptId: 'a2' }),
    ev(1000, 'confirm', { seq: 1, position: P_PROTO, attemptId: 'a2' }),
    ev(1100, 'confirm', { seq: 1, position: P_TOSTR, attemptId: 'a2' }),
    ev(1200, 'cue-completed', { seq: 1, revision: 2, attemptId: 'a2' }),
    ev(1300, 'cue-started', { seq: 2, text: '单人口令', targets: [P_TOSTR], revision: 1, attemptId: 'b1' }),
    ev(1400, 'cue-timeout', { seq: 2, missing: [P_TOSTR], attemptId: 'b1', revision: 1 }),
    ev(1500, 'position-substituted', { seq: 2, from: P_TOSTR, to: P_LIGHT, attemptId: 'b1', revision: 1 }),
    ev(1600, 'confirm-late', { seq: 2, position: P_LIGHT, attemptId: 'b1', revision: 1 }),
    ev(1700, 'cue-completed', { seq: 2, revision: 1, attemptId: 'b1' }),
    ev(1800, 'sequence-finished', {}),
  ];
}

function checkKernel(name, K) {
  console.log(name);
  const events = protoEvents();

  // 中途现场：constructor 已确认，__proto__ / toString 未确认（不得误判已确认）
  const mid = K.foldUntil(events, 550);
  check('constructor 确认后计入确认表', hasOwn(mid.confirmations, P_CTOR) && mid.confirmations[P_CTOR].late === false);
  check('__proto__ 未确认时不出现在确认表（不读继承属性）', !hasOwn(mid.confirmations, P_PROTO) && mid.confirmations[P_PROTO] === undefined);
  check('toString 未确认时不出现在确认表', !hasOwn(mid.confirmations, P_TOSTR) && mid.confirmations[P_TOSTR] === undefined);
  const midView = K.viewOf(mid);
  check('有效目标保留三个同名岗位原文（不映射为空值）',
    JSON.stringify(midView.effective) === JSON.stringify([P_CTOR, P_PROTO, P_TOSTR]));
  check('待确认分组含 __proto__ 与 toString', midView.pending.includes(P_PROTO) && midView.pending.includes(P_TOSTR));

  // 替岗后：toString 的确认权移交灯光，有效目标原文替换
  const subbed = K.foldUntil(events, 650);
  check('替岗记录以 toString 为自有键', hasOwn(subbed.substitutions, P_TOSTR) && subbed.substitutions[P_TOSTR].substitute === P_LIGHT);
  check('替岗后有效目标为 constructor / __proto__ / 灯光',
    JSON.stringify(K.viewOf(subbed).effective) === JSON.stringify([P_CTOR, P_PROTO, P_LIGHT]));

  // 撤回：旧轮次封存完整（含 __proto__ 确认与 toString→灯光 替岗），新轮次无残留
  const resent = K.foldUntil(events, 850);
  check('撤回后新轮次确认表无旧记录', Object.keys(resent.confirmations).length === 0);
  check('撤回后新轮次替岗表无旧记录', Object.keys(resent.substitutions).length === 0);
  check('撤回封存保留 constructor 与 __proto__ 确认',
    resent.attempts.length === 1 &&
    hasOwn(resent.attempts[0].confirmations, P_CTOR) && hasOwn(resent.attempts[0].confirmations, P_PROTO));
  check('撤回封存保留 toString→灯光 替岗',
    hasOwn(resent.attempts[0].substitutions, P_TOSTR) &&
    resent.attempts[0].substitutions[P_TOSTR].substitute === P_LIGHT);
  check('封存快照经 JSON 序列化仍完整（__proto__ 为自有键）',
    JSON.stringify(resent.attempts[0].confirmations).includes('"__proto__"'));

  // 全场结束：三个同名岗位确认齐全；替岗轮次的超时标记随确认权移交灯光
  const done = K.foldEvents(events);
  const cue1Round2 = done.rounds.find((r) => r.attemptId === 'a2');
  check('修订轮次三个同名岗位均确认',
    hasOwn(cue1Round2.confirmsMap, P_CTOR) && hasOwn(cue1Round2.confirmsMap, P_PROTO) && hasOwn(cue1Round2.confirmsMap, P_TOSTR));
  const cue2Round = done.rounds.find((r) => r.attemptId === 'b1');
  check('超时轮次替岗以 __proto__ 级名称为键（toString 原岗位）',
    hasOwn(cue2Round.substitutionsMap, P_TOSTR) && cue2Round.substitutionsMap[P_TOSTR].substitute === P_LIGHT);
  // 超时标记移交发生在替补迟到确认之前（确认后超时表按服务端口径清空）
  const atSub = K.foldUntil(events, 1550);
  check('超时标记随确认权移交灯光', atSub.timedOut.length === 1 && atSub.timedOut[0] === P_LIGHT);
  check('替补迟到确认计入灯光', hasOwn(cue2Round.confirmsMap, P_LIGHT) && cue2Round.confirmsMap[P_LIGHT].late === true);
  check('超时后替岗的有效目标为灯光', JSON.stringify(K.viewOf(atSub).effective) === JSON.stringify([P_LIGHT]));
  const lateView = K.viewOf(K.foldUntil(events, 1650));
  check('迟到确认分组计入灯光', lateView.confirmed.length === 1 && lateView.confirmed[0].position === P_LIGHT && lateView.confirmed[0].late === true);
}

// ---------------------------------------------------------------------------
// B. 端到端（WebSocket，需服务运行中）
// ---------------------------------------------------------------------------
function client(role, position, cid) {
  const ws = new WebSocket(URL);
  const c = {
    ws,
    state: null,
    errors: [],
    leaseToken: null,
    leaseGranted: null,
    ready: new Promise((res) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'hello', role, position, clientId: cid || ('pk-' + role + '-' + (position || '')) }));
        res();
      });
    }),
    send(obj) { ws.send(JSON.stringify(obj)); },
    waitState(pred, timeout = 5000) {
      return new Promise((res, rej) => {
        const t0 = Date.now();
        const iv = setInterval(() => {
          if (c.state && pred(c.state)) { clearInterval(iv); res(c.state); }
          else if (Date.now() - t0 > timeout) { clearInterval(iv); rej(new Error('waitState 超时')); }
        }, 20);
      });
    },
  };
  ws.on('message', (m) => {
    const d = JSON.parse(m);
    if (d.type === 'state') c.state = d.state;
    if (d.type === 'error') c.errors.push(d.message);
    if (d.type === 'lease-granted') { c.leaseToken = d.token; c.leaseGranted = d; }
  });
  return c;
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function e2e() {
  const director = client('director');
  const control = client('control');
  const pCtor = client('position', P_CTOR);
  const pProto = client('position', P_PROTO);
  const pToStr = client('position', P_TOSTR);
  const pLight = client('position', P_LIGHT);
  await Promise.all([director.ready, control.ready, pCtor.ready, pProto.ready, pToStr.ready, pLight.ready]);
  await sleep(200);

  console.log('B1. 租约与干净起点（兼容上一场遗留草稿）');
  control.send({ type: 'lease-acquire', name: '同名岗位测试' });
  const hb = setInterval(() => { if (control.leaseToken) control.send({ type: 'lease-heartbeat', token: control.leaseToken }); }, 2000);
  await control.waitState((s) => s.lease && s.lease.holderId === 'pk-control-');
  control.send({ type: 'reset', resetMode: 'keep' });
  await control.waitState((s) => s.phase === 'idle');
  check('租约申请成功并重置回 idle', !!control.leaseGranted);

  console.log('B2. 同名岗位作为目标：有效目标保留原文，未确认不得推进');
  director.send({ type: 'setSequence', timeoutSec: 30, cues: [
    { text: '同名岗位全员口令', targets: [P_CTOR, P_PROTO, P_TOSTR] },
    { text: 'toString 单人口令', targets: [P_TOSTR] },
  ]});
  let st = await control.waitState((s) => s.sequence.length === 2);
  check('序列保存成功（同名岗位作为普通岗位）',
    st.sequence[0].targets.join(',') === [P_CTOR, P_PROTO, P_TOSTR].join(','));
  control.send({ type: 'start' });
  st = await control.waitState((s) => s.phase === 'active' && s.currentCue && s.currentCue.seq === 1);
  check('有效目标为三个同名岗位原文（不为空值）',
    JSON.stringify(st.effectiveTargets) === JSON.stringify([P_CTOR, P_PROTO, P_TOSTR]));
  check('未确认前确认表无同名岗位自有键',
    !hasOwn(st.confirmations, P_CTOR) && !hasOwn(st.confirmations, P_PROTO) && !hasOwn(st.confirmations, P_TOSTR));
  check('未确认前确认表为空（快照不含同名岗位键）', Object.keys(st.confirmations).length === 0);
  control.send({ type: 'advance' });
  await sleep(300);
  check('未全员确认时推进被拒并逐一点名',
    control.errors.some((e) => e.includes('禁止推进') && e.includes(P_CTOR) && e.includes(P_PROTO) && e.includes(P_TOSTR)));

  console.log('B3. constructor / __proto__ 确认计入全员确认');
  pCtor.send({ type: 'confirm', attemptId: st.attemptId });
  st = await control.waitState((s) => hasOwn(s.confirmations, P_CTOR));
  check('constructor 确认成功（自有键记录）', st.confirmations[P_CTOR].late === false);
  check('constructor 确认不冒充其他同名岗位', !hasOwn(st.confirmations, P_PROTO) && !hasOwn(st.confirmations, P_TOSTR));
  pProto.send({ type: 'confirm', attemptId: st.attemptId });
  st = await control.waitState((s) => hasOwn(s.confirmations, P_PROTO));
  check('__proto__ 确认成功且经 JSON 快照完整下发', st.confirmations[P_PROTO].late === false);
  control.send({ type: 'advance' });
  await sleep(300);
  check('toString 未确认时推进仍被拒', control.errors.some((e) => e.includes('禁止推进') && e.includes(P_TOSTR)));

  console.log('B4. toString 替岗给灯光：确认权与有效目标移交');
  control.send({ type: 'substitute', from: P_TOSTR, to: P_LIGHT, attemptId: st.attemptId });
  st = await control.waitState((s) => hasOwn(s.substitutions, P_TOSTR));
  check('替岗记录以 toString 为自有键', st.substitutions[P_TOSTR].substitute === P_LIGHT);
  check('替岗后有效目标为 constructor / __proto__ / 灯光',
    JSON.stringify(st.effectiveTargets) === JSON.stringify([P_CTOR, P_PROTO, P_LIGHT]));
  pToStr.send({ type: 'confirm', attemptId: st.attemptId });
  await sleep(300);
  check('被替岗的 toString 确认被拒（确认权已移交）',
    pToStr.errors.some((e) => e.includes('已移交')));
  pLight.send({ type: 'confirm', attemptId: st.attemptId });
  st = await control.waitState((s) => hasOwn(s.confirmations, P_LIGHT));
  check('替补灯光确认计入全员确认', st.confirmations[P_LIGHT].attemptId === st.attemptId);

  console.log('B5. 推进后：新轮次无残留，旧轮次封存完整');
  const cue1Id = st.currentCue.id;
  control.send({ type: 'advance' });
  st = await control.waitState((s) => s.currentCue && s.currentCue.seq === 2);
  check('推进后确认表无旧记录', Object.keys(st.confirmations).length === 0);
  check('推进后替岗表无旧记录', Object.keys(st.substitutions).length === 0);
  const hist1 = st.cueHistory[cue1Id];
  check('封存轮次保留 constructor / __proto__ / 灯光 确认（自有键）',
    hist1 && hist1.attempts.length === 1 &&
    hasOwn(hist1.attempts[0].confirmations, P_CTOR) &&
    hasOwn(hist1.attempts[0].confirmations, P_PROTO) &&
    hasOwn(hist1.attempts[0].confirmations, P_LIGHT));
  check('封存轮次保留 toString→灯光 替岗（自有键）',
    hist1 && hasOwn(hist1.attempts[0].substitutions, P_TOSTR) &&
    hist1.attempts[0].substitutions[P_TOSTR].substitute === P_LIGHT);
  check('封存轮次经 JSON 快照完整（含 __proto__ 键）',
    JSON.stringify(hist1.attempts[0].confirmations).includes('"__proto__"'));

  console.log('B6. 第二条：toString 直接确认后完成全场');
  check('第二条有效目标恢复为原编排 toString（替岗不串场）',
    JSON.stringify(st.effectiveTargets) === JSON.stringify([P_TOSTR]));
  pToStr.send({ type: 'confirm', attemptId: st.attemptId });
  st = await control.waitState((s) => hasOwn(s.confirmations, P_TOSTR));
  check('toString 确认成功（自有键记录）', st.confirmations[P_TOSTR].late === false);
  control.send({ type: 'advance' });
  st = await control.waitState((s) => s.phase === 'done');
  check('全场完成', st.phase === 'done');

  console.log('B7. 短时限场次：超时标记随替岗移交同名岗位');
  control.send({ type: 'reset', resetMode: 'keep' });
  await control.waitState((s) => s.phase === 'idle');
  director.send({ type: 'setSequence', timeoutSec: 3, cues: [
    { text: '超时移交口令', targets: [P_PROTO] },
  ]});
  await control.waitState((s) => s.sequence.length === 1 && s.timeoutSec === 3);
  control.send({ type: 'start' });
  st = await control.waitState((s) => s.phase === 'active' && s.currentCue);
  st = await control.waitState((s) => s.timedOut.includes(P_PROTO), 8000);
  check('__proto__ 超时未确认被标记', st.timedOut.length === 1 && st.timedOut[0] === P_PROTO);
  control.send({ type: 'substitute', from: P_PROTO, to: P_LIGHT, attemptId: st.attemptId });
  st = await control.waitState((s) => hasOwn(s.substitutions, P_PROTO));
  check('超时标记随确认权移交灯光', st.timedOut.length === 1 && st.timedOut[0] === P_LIGHT);
  check('替岗后有效目标为灯光', JSON.stringify(st.effectiveTargets) === JSON.stringify([P_LIGHT]));
  pLight.send({ type: 'confirm', attemptId: st.attemptId });
  st = await control.waitState((s) => hasOwn(s.confirmations, P_LIGHT));
  check('替补迟到确认被接受且标记 late', st.confirmations[P_LIGHT].late === true);
  control.send({ type: 'advance' });
  st = await control.waitState((s) => s.phase === 'done');
  check('短时限场次完成', st.phase === 'done');

  console.log('B8. 复盘接口按日志重建相同确认 / 替岗结果');
  const sessionId = st.sessionId;
  const list = await httpGetJson('http://localhost:3000/api/replay/sessions');
  const mine = list.sessions.filter((s) => s.fileId === sessionId);
  check('本服务场次出现在复盘列表（两段已结束场次）', mine.length >= 2);
  const runTimeout = mine[0]; // 列表按开始时间倒序：最新为短时限场次
  const runMain = mine[1];
  const detailMain = await httpGetJson(`http://localhost:3000/api/replay/sessions/${sessionId}/${runMain.runId}`);
  const foldedMain = Core.foldEvents(detailMain.events, { timeoutSec: detailMain.timeoutSec });
  const mainRound1 = foldedMain.rounds.find((r) => r.seq === 1);
  check('复盘重建：constructor / __proto__ / 灯光 确认齐全',
    hasOwn(mainRound1.confirmsMap, P_CTOR) && hasOwn(mainRound1.confirmsMap, P_PROTO) && hasOwn(mainRound1.confirmsMap, P_LIGHT));
  check('复盘重建：toString→灯光 替岗一致',
    hasOwn(mainRound1.substitutionsMap, P_TOSTR) && mainRound1.substitutionsMap[P_TOSTR].substitute === P_LIGHT);
  const mainRound2 = foldedMain.rounds.find((r) => r.seq === 2);
  check('复盘重建：第二条 toString 确认一致', hasOwn(mainRound2.confirmsMap, P_TOSTR));
  const detailTimeout = await httpGetJson(`http://localhost:3000/api/replay/sessions/${sessionId}/${runTimeout.runId}`);
  const foldedTimeout = Core.foldEvents(detailTimeout.events, { timeoutSec: detailTimeout.timeoutSec });
  const timeoutRound = foldedTimeout.rounds[0];
  check('复盘重建：__proto__→灯光 替岗一致',
    hasOwn(timeoutRound.substitutionsMap, P_PROTO) &&
    timeoutRound.substitutionsMap[P_PROTO].substitute === P_LIGHT);
  // 超时标记移交发生在替补迟到确认之前：按日志行截断到替岗事件核对
  const subIdx = detailTimeout.events.findIndex((e) => e.event === 'position-substituted');
  const atSub = Core.foldUntilIndex(detailTimeout.events, subIdx, { timeoutSec: detailTimeout.timeoutSec });
  check('复盘重建：超时标记随确认权移交灯光', atSub.timedOut.length === 1 && atSub.timedOut[0] === P_LIGHT);
  check('复盘重建：替补迟到确认标记一致',
    hasOwn(timeoutRound.confirmsMap, P_LIGHT) && timeoutRound.confirmsMap[P_LIGHT].late === true);

  clearInterval(hb);
  for (const c of [director, control, pCtor, pProto, pToStr, pLight]) c.ws.close();
}

// ---------------------------------------------------------------------------
// C. 前端 / 服务端静态约束
// ---------------------------------------------------------------------------
function staticChecks() {
  console.log('C. 静态约束：岗位键读写一律安全');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const server = read('server.js');
  const common = read('public/common.js');
  const controlHtml = read('public/control.html');
  const positionHtml = read('public/position.html');
  const coreSrc = read('public/replay-core.js');
  check('服务端以无原型字典保存岗位键记录', server.includes('Object.create(null)'));
  check('common.js 提供 own() 自有键读取', /function own\(obj, key\)/.test(common));
  check('控制端以 CueClient.own 读取确认 / 替岗表',
    controlHtml.includes('CueClient.own(state.confirmations, t)') &&
    controlHtml.includes('CueClient.own(subs, t)'));
  check('岗位端以 CueClient.own 读取确认 / 替岗表',
    positionHtml.includes('CueClient.own(state.confirmations, myPosition)') &&
    positionHtml.includes('CueClient.own(subs, myPosition)'));
  check('共享内核以无原型字典保存岗位键记录', coreSrc.includes('Object.create(null)'));
}

(async () => {
  console.log('A. 共享折叠内核（Node require 实体）');
  checkKernel('A1. Node 实体', Core);
  console.log('A2. 浏览器 <script> 形态（同一文件）');
  checkKernel('A2. 浏览器形态', loadBrowserCore());

  staticChecks();

  await e2e();

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
