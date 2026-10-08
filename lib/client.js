// dsh-restart-button — client 半
// 形态：window.__ModuleLoader__.load 自注册 bundle（ESM named export 浏览器不识别）。
// 只 require("react")，不依赖 ui-primitives，避免宿主版本差异导致白屏。
// 适配 dsh 0.1.7-rc.1 客户端槽位契约：ctx.slots.inject("settings.section", ...)。
window.__ModuleLoader__.load({
  id: "dsh-restart-button",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");
    var h = React.createElement;
    // 陷阱防线：useState 一律直接解构/下标取值（两段式重写会丢 value 行，渲染崩溃被槽位吞成空白页）
    var useState = React.useState;
    var useEffect = React.useEffect;

    var API = "/api/dsh-restart";
    var STYLE_ID = "dsh-restart-button-style";

    function injectStyles() {
      try {
        if (document.getElementById(STYLE_ID)) return;
        var el = document.createElement("style");
        el.id = STYLE_ID;
        el.textContent = [
          ".drs-root{display:flex;flex-direction:column;gap:12px;padding:4px 2px;color:var(--dsw-alias-text,inherit);font-size:13px;line-height:1.6}",
          ".drs-card{border:1px solid var(--dsw-alias-border,rgba(128,128,128,.28));border-radius:8px;padding:12px 14px;background:var(--dsw-alias-surface,rgba(128,128,128,.06))}",
          ".drs-title{font-weight:600;margin-bottom:8px}",
          ".drs-kv{display:flex;gap:10px;padding:2px 0}",
          ".drs-k{min-width:92px;color:var(--dsw-alias-muted,rgba(128,128,128,.9))}",
          ".drs-v{flex:1;word-break:break-all}",
          ".drs-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
          ".drs-hint{color:var(--dsw-alias-muted,rgba(128,128,128,.9));font-size:12px}",
          ".drs-btn{border:1px solid var(--dsw-alias-border,rgba(128,128,128,.28));border-radius:6px;padding:6px 14px;background:var(--dsw-alias-btn,rgba(128,128,128,.12));color:inherit;cursor:pointer;font-size:13px}",
          ".drs-btn:hover{background:var(--dsw-alias-btn-hover,rgba(128,128,128,.22))}",
          ".drs-btn[disabled]{opacity:.5;cursor:not-allowed}",
          ".drs-btn-danger{border-color:rgba(220,80,80,.55);color:#e08585}",
          ".drs-badge{display:inline-block;border-radius:999px;padding:1px 8px;font-size:12px;border:1px solid transparent}",
          ".drs-ok{background:rgba(60,160,90,.16);border-color:rgba(60,160,90,.4);color:#6cc48c}",
          ".drs-bad{background:rgba(220,80,80,.14);border-color:rgba(220,80,80,.4);color:#e08585}",
          ".drs-neutral{background:rgba(128,128,128,.14);border-color:rgba(128,128,128,.35)}",
          ".drs-msg{margin-top:2px}",
          ".drs-msg.err{color:#e08585}",
          ".drs-msg.ok{color:#6cc48c}",
          ".drs-warn{color:#d9a441}",
          ".drs-link{color:var(--dsw-alias-accent,#4f8cff);word-break:break-all}",
          ".drs-check{display:flex;align-items:center;gap:8px;margin-top:8px}",
        ].join("");
        document.head.appendChild(el);
      } catch (e) { /* 样式失败不致命 */ }
    }

    function api(path, opts) {
      return fetch(API + path, opts).then(function (r) {
        return r.text().then(function (t) {
          var j = null;
          try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; }
          if (!r.ok) throw new Error((j && j.error) || ("HTTP " + r.status));
          return j;
        });
      });
    }

    function glyph(v) {
      return v === null || v === undefined ? "—" : String(v);
    }

    function kv(key, value, cls) {
      return h("div", { className: "drs-kv", key: key }, [
        h("span", { className: "drs-k", key: "k" }, key),
        h("span", { className: "drs-v " + (cls || ""), key: "v" }, value),
      ]);
    }

    function RestartSection() {
      var s0 = useState(null); var status = s0[0]; var setStatus = s0[1];
      var e0 = useState(null); var loadErr = e0[0]; var setLoadErr = e0[1];
      var c0 = useState(false); var confirming = c0[0]; var setConfirming = c0[1];
      var b0 = useState(false); var busy = b0[0]; var setBusy = b0[1];
      var m0 = useState(null); var msg = m0[0]; var setMsg = m0[1];
      var w0 = useState(false); var working = w0[0]; var setWorking = w0[1];

      useEffect(function () {
        injectStyles();
        var alive = true;
        api("/status").then(function (s) {
          if (!alive) return;
          setStatus(s); setLoadErr(null);
          if (s && s.pending) setWorking(true);
        }).catch(function (e) {
          if (!alive) return;
          setLoadErr(String(e && e.message || e));
        });
        return function () { alive = false; };
      }, []);

      var inProgress = working || !!(status && status.pending);

      // 重启窗口内轮询：宿主被重启则本页会失联（catch 忽略）；
      // 若宿主没重启（多半 polkit 拒绝），自愈后这里会看到 pending 变 false → 如实报「未生效」
      useEffect(function () {
        if (!inProgress) return undefined;
        var alive = true;
        var id = setInterval(function () {
          api("/status").then(function (s) {
            if (!alive) return;
            setStatus(s);
            if (!s.pending) setWorking(false);
          }).catch(function () { /* 宿主可能正在重启 */ });
        }, 3000);
        return function () { alive = false; clearInterval(id); };
      }, [inProgress]);

      function toggleAutoOpen(next) {
        setStatus(function (prev) { return prev ? Object.assign({}, prev, { autoOpen: next }) : prev; });
        api("/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ autoOpen: next }),
        }).catch(function (e) {
          setMsg({ kind: "err", text: "保存设置失败：" + String(e && e.message || e) });
        });
      }

      function doRestart() {
        setBusy(true); setMsg(null);
        var autoOpen = !(status && status.autoOpen === false);
        api("/restart", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ autoOpen: autoOpen }),
        }).then(function () {
          setBusy(false); setConfirming(false); setWorking(true);
          setMsg({ kind: "ok", text: "已发出重启指令，宿主正在重启…" + (autoOpen ? " 新页面会自动打开，本页稍后失效。" : " 本页稍后失效，请用桌面「DSH Web」快捷方式重新打开。") });
        }).catch(function (e) {
          setBusy(false); setConfirming(false);
          setMsg({ kind: "err", text: "重启失败：" + String(e && e.message || e) });
        });
      }

      // ---- 顶部：授权提示 ----
      var badge = null;
      if (status) {
        if (status.ruleHint === "readable") badge = h("span", { className: "drs-badge drs-ok", key: "b" }, "polkit 规则已就绪");
        else if (status.ruleHint === "missing") badge = h("span", { className: "drs-badge drs-bad", key: "b" }, "缺少 polkit 规则");
        else badge = h("span", { className: "drs-badge drs-neutral", key: "b" }, "授权由 polkit 决定");
      }
      if (loadErr) badge = h("span", { className: "drs-badge drs-bad", key: "b" }, "状态读取失败");

      var children = [];
      children.push(h("div", { className: "drs-card", key: "head" }, [
        h("div", { className: "drs-title", key: "t" }, "DSH Web 宿主重启"),
        h("div", { className: "drs-row", key: "b" }, [
          badge,
          h("span", { className: "drs-hint", key: "h" }, "重启权归 systemd；本按钮只负责下发 systemctl restart"),
        ]),
      ]));

      var info = [];
      info.push(kv("服务单元", status && status.unit ? status.unit : "dsh-web.service"));
      info.push(kv("授权方式", "polkit 常驻规则（仅运行 dsh 的用户 + 仅该单元 + 仅 restart）"));
      if (!status && !loadErr) info.push(kv("状态", "读取中…"));
      if (loadErr) info.push(kv("错误", loadErr, "drs-warn"));
      children.push(h("div", { className: "drs-card", key: "info" }, info));

      if (status) {
        var action = [];
        if (inProgress) {
          action.push(h("div", { className: "drs-msg drs-warn", key: "wk" },
            "重启进行中… 本页若一直没断，说明重启未生效（多半是 polkit 规则缺失或被改），稍后会给出结论。"));
        } else if (confirming) {
          action.push(h("div", { className: "drs-row", key: "cf" }, [
            h("button", { key: "go", className: "drs-btn drs-btn-danger", disabled: busy, onClick: doRestart },
              busy ? "正在发出…" : "确认重启"),
            h("button", { key: "cancel", className: "drs-btn", disabled: busy, onClick: function () { setConfirming(false); } }, "取消"),
          ]));
        } else {
          action.push(h("div", { className: "drs-row", key: "row" }, [
            h("button", { key: "btn", className: "drs-btn drs-btn-danger", disabled: busy,
              onClick: function () { setConfirming(true); setMsg(null); } }, "重启 DSH Web"),
            h("span", { className: "drs-hint", key: "hint" }, "当前页面会在重启后失效"),
          ]));
        }

        action.push(h("label", { className: "drs-check", key: "ao" }, [
          h("input", { key: "cb", type: "checkbox", checked: !(status.autoOpen === false), disabled: inProgress,
            onChange: function (ev) { toggleAutoOpen(!!(ev.target && ev.target.checked)); } }),
          h("span", { key: "lb" }, "重启完成后自动打开新地址（token 每次启动都会变）"),
        ]));

        children.push(h("div", { className: "drs-card", key: "action" }, action));
      }

      var last = status && status.lastRestart;
      var hist = [];
      if (last) {
        hist.push(kv("上次重启", last.finishedAt ? String(last.finishedAt).replace("T", " ").replace(/\..*$/, "") : "—"));
        if (last.url) hist.push(kv("新地址", h("a", { className: "drs-link", href: last.url, target: "_blank", rel: "noreferrer" }, last.url)));
        else hist.push(kv("新地址", "未取到", "drs-warn"));
        if (last.ok === false && last.reason === "restart-not-taken") {
          hist.push(kv("结论", "重启未生效：宿主并未重启，请检查 polkit 规则是否在位", "drs-warn"));
        } else if (last.ok === false) {
          hist.push(kv("结论", "重启已发生，但未能从 journald 取到新地址", "drs-warn"));
        } else {
          hist.push(kv("结论", "重启成功" + (last.opened ? "，已自动打开新地址" : "")));
        }
      } else {
        hist.push(kv("上次重启", "本宿主尚未通过此按钮重启过"));
      }
      children.push(h("div", { className: "drs-card", key: "hist" }, [
        h("div", { className: "drs-title", key: "t" }, "记录"),
      ].concat(hist)));

      if (msg) children.push(h("div", { className: "drs-msg " + (msg.kind === "err" ? "err" : "ok"), key: "msg" }, msg.text));

      return h("div", { className: "drs-root" }, children);
    }

    var inject = ["slots"];

    function apply(ctx) {
      try {
        ctx.slots.inject("settings.section", function () {
          return ctx.slots.register({
            name: "settings.section",
            id: "dsh-restart-button",
            order: 210,
            label: function () { return "重启 DSH"; },
          }, RestartSection);
        });
      } catch (error) {
        try { console.error("dsh-restart-button: client apply failed", error); } catch (_) {}
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
