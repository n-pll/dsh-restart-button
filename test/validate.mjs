import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';

import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
// 本文件位于 <plugin>/test/validate.mjs → 插件根目录
const PLUG = dirname(dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

console.log('[1] package.json');
const pkg = JSON.parse(readFileSync(PLUG + '/package.json', 'utf8'));
ok(pkg.name === 'dsh-restart-button' && pkg.type === 'module', 'name/type 正确');
ok(pkg.exports && pkg.exports['./client'], 'exports ./client 已声明');
ok(pkg.dsh.bundle.patch && pkg.dsh.client.platform === 'web', 'bundle patch + platform=web');

console.log('[2] host 半：加载与导出');
const host = await import('file://' + PLUG + '/lib/index.js');
ok(typeof host.apply === 'function' && host.inject.includes('webServer'), 'apply/inject 正确');

console.log('[3] host 半：apply 注册路由');
const routes = []; const byPath = {}; let effectRegistered = false;
host.apply({
  webServer: { register: (def) => { routes.push(def); byPath[def.path] = def; return () => {}; } },
  effect: () => { effectRegistered = true; },
});
ok(effectRegistered && routes.length === 3, '注册 3 条路由 + ctx.effect');
ok(routes.map(r => r.path).sort().join(',') === '/api/dsh-restart/restart,/api/dsh-restart/settings,/api/dsh-restart/status', '路径正确');
ok(routes.every(r => r.kind === 'exact' && typeof r.handler === 'function'), '全部 exact + handler');

console.log('[4] host 半：HTTP 栅栏（只跑拒绝路径，绝不触发真实重启）');
const STATE = PLUG + '/state/state.json';
function mockRes() { const r = { code: null, body: null }; r.writeHead = (c) => { r.code = c; }; r.end = (b) => { r.body = b; }; return r; }
const mockReq = (m, hdrs, remote) => ({ method: m, headers: hdrs, url: '/', socket: { remoteAddress: remote || '127.0.0.1' }, on: () => {}, destroy: () => {} });
const stateBefore = existsSync(STATE) ? readFileSync(STATE, 'utf8') : null;
for (const [label, req] of [
  ['缺 Origin（DNS rebinding）', mockReq('POST', { host: '127.0.0.1:3099' })],
  ['非环回来源', mockReq('POST', { host: '127.0.0.1:3099', origin: 'http://127.0.0.1:3099' }, '10.0.0.5')],
  ['带转发头（代理）', mockReq('POST', { host: '127.0.0.1:3099', origin: 'http://127.0.0.1:3099', 'x-forwarded-for': '1.2.3.4' })],
  ['Host 非环回', mockReq('POST', { host: 'evil.com', origin: 'http://evil.com' })],
  ['跨源 Origin', mockReq('POST', { host: '127.0.0.1:3099', origin: 'http://evil.com' })],
]) {
  const res = mockRes(); await byPath['/api/dsh-restart/restart'].handler(req, res);
  ok(res.code === 403, label + ' → 403');
}
{ const res = mockRes(); await byPath['/api/dsh-restart/restart'].handler(mockReq('GET', { host: '127.0.0.1:3099', origin: 'http://127.0.0.1:3099' }), res); ok(res.code === 405, 'restart GET → 405'); }
{ const res = mockRes(); await byPath['/api/dsh-restart/settings'].handler(mockReq('PUT', { host: '127.0.0.1:3099' }), res); ok(res.code === 403, 'settings 缺 Origin → 403'); }
ok((existsSync(STATE) ? readFileSync(STATE, 'utf8') : null) === stateBefore, '被拒请求未写入 state.json（零副作用）');

console.log('[5] host 半：status 端点 + ruleHint（修复「读不到规则就误拦」的坑）');
{
  const res = mockRes(); await byPath['/api/dsh-restart/status'].handler(mockReq('GET', { host: '127.0.0.1:3099' }), res);
  const j = JSON.parse(res.body);
  ok(res.code === 200, 'GET status → 200');
  ok(j.unit === 'dsh-web.service', 'unit = dsh-web.service');
  ok(['readable', 'missing', 'unknown'].includes(j.ruleHint), 'ruleHint 三态合法（实测: ' + j.ruleHint + '）');
  ok(j.ruleHint !== 'missing', 'ruleHint 不误报 missing（目录 0750 → 应为 unknown）');
  ok(typeof j.autoOpen === 'boolean' && j.settleWindowMs === 20000, 'autoOpen + settleWindowMs 正确');
}

console.log('[6] host 半：自愈（pending 超窗 ⇒ 判定「重启未生效」）');
{
  mkdirSync(PLUG + '/state', { recursive: true });
  const old = new Date(Date.now() - 25000).toISOString();
  writeFileSync(STATE, JSON.stringify({ autoOpen: true, pending: { requestedAt: old, fromUrl: 'http://x/?token=A', autoOpen: true } }), 'utf8');
  const res = mockRes(); await byPath['/api/dsh-restart/status'].handler(mockReq('GET', { host: '127.0.0.1:3099' }), res);
  const j = JSON.parse(res.body);
  ok(j.pending === false, '超窗 pending 已被自愈清除');
  ok(j.lastRestart && j.lastRestart.ok === false && j.lastRestart.reason === 'restart-not-taken', '结论 = 重启未生效(restart-not-taken)');

  const fresh = new Date().toISOString();
  writeFileSync(STATE, JSON.stringify({ autoOpen: true, pending: { requestedAt: fresh, fromUrl: 'http://x/?token=A', autoOpen: true } }), 'utf8');
  const res2 = mockRes(); await byPath['/api/dsh-restart/status'].handler(mockReq('GET', { host: '127.0.0.1:3099' }), res2);
  ok(JSON.parse(res2.body).pending === true, '窗口内 pending 保持不变（不误判）');
}

console.log('[7] client 半：bundle 自注册');
let captured = null;
globalThis.window = { __ModuleLoader__: { load: (d) => { captured = d; } } };
globalThis.document = { getElementById: () => null, createElement: () => ({ set textContent(v) {}, id: '' }), head: { appendChild() {} } };
await import('file://' + PLUG + '/lib/client.js');
ok(captured && captured.id === 'dsh-restart-button', 'bundle 自注册 id 正确');

console.log('[8] client 半：渲染（4 条状态路径）');
function renderWith(status) {
  const queue = [status, null, false, false, null, false];
  let i = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => { const v = queue[i] !== undefined ? queue[i] : init; i++; return [v, () => {}]; },
    useEffect: () => {}, useRef: () => ({ current: null }),
  };
  const mod = captured.factory((n) => { if (n === 'react') return React; throw new Error('unexpected require ' + n); });
  let registered = null, slot = null;
  mod.apply({ slots: { inject: (s, fn) => { slot = s; fn(); }, register: (meta, comp) => { registered = { meta, comp }; return {}; } } });
  const texts = [];
  const walk = (n) => {
    if (n === null || n === undefined || typeof n === 'boolean') return;
    if (typeof n === 'string' || typeof n === 'number') { texts.push(String(n)); return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.children) walk(n.children);
  };
  walk(registered.comp());
  return { text: texts.join(' | '), meta: registered.meta, slot, mod };
}
const empty = renderWith(null);
ok(empty.mod.inject.includes('slots') && empty.slot === 'settings.section', 'inject/slot 正确');
ok(empty.meta.id === 'dsh-restart-button' && empty.meta.label() === '重启 DSH', '注册元数据正确');
ok(empty.text.includes('读取中') && !empty.text.includes('重启 DSH Web'), '未加载态渲染正常、不抛异常');

const ready = renderWith({ unit: 'dsh-web.service', ruleHint: 'readable', autoOpen: true, pending: false,
  lastRestart: { finishedAt: '2026-10-08T14:00:12.000Z', url: 'http://127.0.0.1:3099/?token=AbC_-123', ok: true, opened: true } });
ok(ready.text.includes('重启 DSH Web'), '就绪态：渲染出重启按钮');
ok(ready.text.includes('polkit 规则已就绪'), '就绪态：徽标 ok');
ok(ready.text.includes('自动打开新地址'), '就绪态：开关存在');
ok(ready.text.includes('http://127.0.0.1:3099/?token=AbC_-123'), '就绪态：显示新地址');
ok(ready.text.includes('重启成功'), '就绪态：结论=重启成功');

const missing = renderWith({ unit: 'dsh-web.service', ruleHint: 'missing', autoOpen: false, pending: false, lastRestart: null });
ok(missing.text.includes('缺少 polkit 规则'), 'ruleHint=missing → 警示徽标');
ok(missing.text.includes('重启 DSH Web'), 'missing 时按钮仍可用（不误拦）');

const failed = renderWith({ unit: 'dsh-web.service', ruleHint: 'unknown', autoOpen: true, pending: false,
  lastRestart: { finishedAt: '2026-10-08T14:00:12.000Z', url: null, ok: false, opened: false, reason: 'restart-not-taken' } });
ok(failed.text.includes('重启未生效'), '自愈结论在 UI 上可见');

// 清理
rmSync(STATE, { force: true });
try { rmSync(PLUG + '/state', { recursive: true, force: true }); } catch {}
console.log('');
console.log(fail === 0 ? ('ALL PASS (' + pass + '/' + (pass + fail) + ')') : ('FAILED: ' + fail + ' 项'));
process.exit(fail === 0 ? 0 : 1);