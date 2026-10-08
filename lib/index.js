// dsh-restart-button — host 半
//
// 作用：为 DSH Web 提供一个「重启」按钮的后端。
//   POST /api/dsh-restart/restart  → 落盘 pending → 触发 systemctl restart dsh-web → 202
//   GET  /api/dsh-restart/status   → 上次重启结果、自动打开设置（含「未生效」自愈判定）
//   PUT  /api/dsh-restart/settings → 保存「重启完成后自动打开新地址」
//
// 授权模型（方案 C / polkit 常驻授权）：
//   宿主进程以 dsh 的运行用户（非 root）身份运行且 NoNewPrivileges=true，无法 sudo；
//   systemd 的 org.freedesktop.systemd1.manage-units 默认 auth_admin，
//   由 /etc/polkit-1/rules.d/49-dsh-web-restart.rules 放行
//   「仅该用户 + 仅 dsh-web.service + 仅 verb=restart」。
//
// 为何不需要「脱离终端的接管进程」：
//   本插件只负责**发出** systemctl restart；systemd（PID 1，在 cgroup 之外）
//   自己完成 停→起。即使本进程在 stop 阶段被 cgroup 一起杀掉，重启任务也已入队
//   并会跑完。重启后的收尾（取新 token URL、必要时开浏览器）由**新宿主启动时**
//   本插件的 apply() 完成，因此不依赖任何存活助手。
//
// 为何不做「规则文件存在性」预检（踩过的坑）：
//   /etc/polkit-1/rules.d 是 0750 root:polkitd，普通用户属于「others」，
//   连 stat 都 EACCES。若据此判定「规则缺失」并拦截，会导致**每一次重启都被误拦**。
//   因此改为：乐观下发 + 经验自愈——重启窗口（SETTLE_WINDOW_MS）过后 pending 仍在，
//   说明宿主没被重启（多半是 polkit 拒绝），由 /status 如实报告「未生效」。
//
// 铁律：命令写死（无任何用户输入进入 argv）；所有入口 try/catch 返回结构化错误；
//       模块顶层零 I/O。
import { execFile, spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const name = "重启按钮";
export const inject = ["webServer"];

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const STATE_DIR = join(PLUGIN_DIR, "state");
const STATE_PATH = join(STATE_DIR, "state.json");
const UNIT = "dsh-web.service";
const RULE_PATH = "/etc/polkit-1/rules.d/49-dsh-web-restart.rules";
const JOURNAL_TIMEOUT_MS = 20000;
const MAX_BODY = 8 * 1024;
// 重启窗口：超过这个时长 pending 仍在 ⇒ 宿主根本没重启（多半 polkit 拒绝）
const SETTLE_WINDOW_MS = 20000;
// token 为 URL-safe；正则同时用作「开浏览器前的白名单校验」
const URL_RE = /http:\/\/[^\s"']*token=[A-Za-z0-9_-]+/g;
const SAFE_URL_RE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?\/[^\s"']*$/;

// ---------- 状态读写 ----------

function readState() {
  try {
    const obj = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    if (obj && typeof obj === "object") return obj;
  } catch { /* 不存在或损坏 */ }
  return {};
}

function writeState(next) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(next, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error("dsh-restart-button: 状态写入失败:", err);
    return false;
  }
}

// 自愈：pending 超窗仍在 ⇒ 重启没生效。把结论落盘并清掉 pending。
function reconcile(st) {
  const p = st.pending;
  if (!p || typeof p !== "object") return st;
  const t = Date.parse(p.requestedAt || "");
  if (!Number.isFinite(t)) { const n = Object.assign({}, st); n.pending = null; writeState(n); return n; }
  if (Date.now() - t < SETTLE_WINDOW_MS) return st;
  const next = Object.assign({}, st);
  next.pending = null;
  next.lastRestart = {
    requestedAt: p.requestedAt,
    finishedAt: new Date().toISOString(),
    url: null,
    ok: false,
    opened: false,
    reason: "restart-not-taken",
  };
  writeState(next);
  return next;
}

// 「规则是否在位」只能尽力而为：目录 0750，普通用户通常读不到。
// 读得到 → 'readable'；ENOENT → 'missing'；EACCES 等 → 'unknown'（不据此拦截）。
function ruleHint() {
  try { readFileSync(RULE_PATH, "utf8"); return "readable"; }
  catch (err) {
    const code = err && err.code;
    if (code === "ENOENT") return "missing";
    return "unknown";
  }
}

// ---------- 工具 ----------

function sendJson(res, code, obj) {
  try {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  } catch { try { res.writeHead(500); res.end(); } catch { /* socket gone */ } }
}

function readBody(req, cap = MAX_BODY) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > cap) { rejectPromise(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectPromise);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isLoopbackAuthority(host) {
  if (typeof host !== "string") return false;
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i.test(host);
}

// 与 dsh-market 同一套同源/环回栅栏：重启是变更类端点，必须挡住代理转发与 DNS rebinding。
function isTrustedLocal(req) {
  const addr = req.socket && req.socket.remoteAddress;
  if (addr !== "127.0.0.1" && addr !== "::1" && addr !== "::ffff:127.0.0.1") return false;
  const h = req.headers || {};
  if (h.forwarded !== undefined || h["x-forwarded-for"] !== undefined || h["x-real-ip"] !== undefined) return false;
  const host = h.host;
  if (!isLoopbackAuthority(host)) return false;
  const origin = h.origin;
  if (origin === undefined) return false; // 变更类请求必须携带 Origin
  try {
    const u = new URL(origin);
    return (u.protocol === "http:" || u.protocol === "https:") && u.host === host;
  } catch { return false; }
}

// 从 journald 取最近一次启动打印的带 token URL
function latestUrl() {
  return new Promise((resolve) => {
    execFile("journalctl", ["-u", UNIT, "-b", "--no-pager"], { timeout: JOURNAL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const text = String(stdout || "");
      if (err && !text) { resolve(null); return; }
      const all = text.match(URL_RE);
      resolve(all && all.length ? all[all.length - 1] : null);
    });
  });
}

// 用 Windows 侧打开浏览器（脱离 systemd cgroup，复用既有互操作能力）
function openBrowser(url) {
  return new Promise((resolve) => {
    if (typeof url !== "string" || !SAFE_URL_RE.test(url)) { resolve(false); return; }
    try {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Start-Process '${url}'`], { timeout: 15000 }, (err) => resolve(!err));
    } catch { resolve(false); }
  });
}

// ---------- 启动收尾：重启是「两段式」，第二段在这里 ----------

async function settlePending() {
  const st = readState();
  const pending = st.pending;
  if (!pending || typeof pending !== "object") return;

  const fromUrl = typeof pending.fromUrl === "string" ? pending.fromUrl : null;
  let url = null;
  // 等 journald 里出现「与重启前不同」的新 token（最多约 30s）
  for (let i = 0; i < 40; i++) {
    const u = await latestUrl();
    if (u && u !== fromUrl) { url = u; break; }
    await sleep(750);
  }

  let opened = false;
  if (url && pending.autoOpen) opened = await openBrowser(url);

  const next = readState();
  next.pending = null;
  next.lastRestart = {
    requestedAt: pending.requestedAt || null,
    finishedAt: new Date().toISOString(),
    url,
    ok: !!url,
    opened,
    reason: url ? "restarted" : "url-not-found",
  };
  writeState(next);
  console.log("dsh-restart-button: 重启收尾 ok=" + String(!!url) + " opened=" + String(opened));
}

// ---------- 路由 ----------

function registerRoutes(ctx) {
  const routes = [];

  routes.push(ctx.webServer.register({
    kind: "exact", path: "/api/dsh-restart/status",
    handler: async (req, res) => {
      try {
        if (req.method !== "GET") { sendJson(res, 405, { error: "method not allowed" }); return; }
        const st = reconcile(readState());
        sendJson(res, 200, {
          ok: true,
          unit: UNIT,
          ruleHint: ruleHint(),
          rulePath: RULE_PATH,
          autoOpen: st.autoOpen !== false,
          pending: !!st.pending,
          lastRestart: st.lastRestart || null,
          settleWindowMs: SETTLE_WINDOW_MS,
        });
      } catch (err) { sendJson(res, 500, { error: String(err && err.message || err) }); }
    },
  }));

  routes.push(ctx.webServer.register({
    kind: "exact", path: "/api/dsh-restart/restart",
    handler: async (req, res) => {
      try {
        if (req.method !== "POST") { sendJson(res, 405, { error: "method not allowed" }); return; }
        if (!isTrustedLocal(req)) { sendJson(res, 403, { ok: false, error: "仅接受本机同源请求" }); return; }

        let autoOpen = true;
        try {
          const body = JSON.parse((await readBody(req)) || "{}");
          if (body && typeof body.autoOpen === "boolean") autoOpen = body.autoOpen;
        } catch { /* 空体按默认 */ }

        const st = reconcile(readState());
        if (st.pending) {
          sendJson(res, 409, { ok: false, error: "上一次重启尚未落定，请稍候再看状态" });
          return;
        }

        const fromUrl = await latestUrl();
        // 先落盘 pending，再触发重启：顺序反了就没有收尾线索
        st.autoOpen = autoOpen;
        st.pending = { requestedAt: new Date().toISOString(), fromUrl, autoOpen };
        if (!writeState(st)) { sendJson(res, 500, { ok: false, error: "状态写入失败，已中止重启" }); return; }

        // 先应答、后触发：重启会杀掉本进程，必须让 202 先落地。
        // 命令写死；detached 让 systemctl 客户端不受本请求生命周期影响。
        let fired = false;
        const fire = () => {
          if (fired) return;
          fired = true;
          try {
            const child = spawn("systemctl", ["restart", UNIT], { detached: true, stdio: "ignore" });
            child.unref();
          } catch (err) {
            console.error("dsh-restart-button: 触发重启失败:", err);
            const revert = reconcile(readState());
            revert.pending = null;
            writeState(revert);
          }
        };
        try { if (typeof res.on === "function") res.on("finish", fire); } catch { /* noop */ }
        setTimeout(fire, 400); // 兜底：finish 没来也要触发

        sendJson(res, 202, { ok: true, message: "重启指令已发出", unit: UNIT, autoOpen, settleWindowMs: SETTLE_WINDOW_MS });
      } catch (err) { sendJson(res, 500, { ok: false, error: String(err && err.message || err) }); }
    },
  }));

  routes.push(ctx.webServer.register({
    kind: "exact", path: "/api/dsh-restart/settings",
    handler: async (req, res) => {
      try {
        if (req.method !== "PUT") { sendJson(res, 405, { error: "method not allowed" }); return; }
        if (!isTrustedLocal(req)) { sendJson(res, 403, { ok: false, error: "仅接受本机同源请求" }); return; }
        const body = JSON.parse((await readBody(req)) || "{}");
        if (typeof body.autoOpen !== "boolean") { sendJson(res, 400, { ok: false, error: "autoOpen 必须是布尔值" }); return; }
        const st = readState();
        st.autoOpen = body.autoOpen;
        if (!writeState(st)) { sendJson(res, 500, { ok: false, error: "状态写入失败" }); return; }
        sendJson(res, 200, { ok: true, autoOpen: body.autoOpen });
      } catch (err) { sendJson(res, 500, { ok: false, error: String(err && err.message || err) }); }
    },
  }));

  return () => { for (const dispose of routes) { try { dispose(); } catch { /* already gone */ } } };
}

// ---------- 入口 ----------
// apply 必须同步完成全部注册（webServer.register 的路由名全局唯一；
// 让出执行权会导致热重载后 "duplicate exact route" 被吞掉、插件静默失效）。
export function apply(ctx) {
  const disposers = [];
  try {
    disposers.push(registerRoutes(ctx));
  } catch (err) {
    console.error("dsh-restart-button: route registration failed:", err);
  }
  // 重启收尾：异步执行，绝不让它阻塞/拖垮启动
  try { void settlePending().catch((err) => console.error("dsh-restart-button: settlePending failed:", err)); } catch { /* noop */ }

  ctx.effect(() => () => {
    for (const dispose of disposers.reverse()) { try { dispose(); } catch { /* noop */ } }
  }, "dsh-restart-button dispose");
}
