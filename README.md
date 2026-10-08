# dsh-restart-button

DSH Web 的**重启按钮**：在「设置」里点一下重启宿主 `dsh-web.service`，不用再去终端敲命令。

## 为什么需要它

当 dsh-web 由 **systemd 托管**（`Restart=always`）时，插件市场（dshmarket）会
**默认隐藏**它自己的一键重启按钮
（`GET /dsh-market/status` → `"restart": false, "supervisor": "systemd"`）。
原因是市场的做法为「拉起一个脱离终端的替代进程」，在 `KillMode=control-group` 下
该助手会被 cgroup 一起杀掉，还可能和 systemd 抢端口（市场 README 的 #229/#471）。

本插件换一条路：**只负责发出 `systemctl restart`，重启本身仍由 systemd 完成**。

## 结构

- **host 半**（`lib/index.js`）
  - `GET  /api/dsh-restart/status` — 上次重启结果、自愈判定、自动打开设置
  - `POST /api/dsh-restart/restart` — 落盘 pending → 触发 `systemctl restart dsh-web` → 202
  - `PUT  /api/dsh-restart/settings` — 保存「重启完成后自动打开新地址」
- **client 半**（`lib/client.js`）— 在 `settings.section` 注册「重启 DSH」分区
- **system/**（`49-dsh-web-restart.rules.tmpl` + `install-rule.sh`）— polkit 授权
- **test/validate.mjs** — 自测（`node test/validate.mjs`）

## 授权（polkit 常驻授权）

宿主进程以 **dsh 的运行用户**（非 root）身份运行且 `NoNewPrivileges=true`，**无法 sudo**；
systemd 的 `org.freedesktop.systemd1.manage-units` 默认 `auth_admin`，
而无头机器没有 polkit 认证 agent，于是重启必被拒。

规则是**模板**（用户名占位 `@DSH_USER@`），用安装脚本生成并落位：

```bash
./system/install-rule.sh            # 默认用当前用户
./system/install-rule.sh <username> # 指定运行 dsh 的用户
```

等价于手工执行：

```bash
sed "s/@DSH_USER@/$(id -un)/g" system/49-dsh-web-restart.rules.tmpl |
  sudo install -m 0644 -o root -g root /dev/stdin \
    /etc/polkit-1/rules.d/49-dsh-web-restart.rules
sudo systemctl restart polkit
```

授权范围收窄为：**仅 action=manage-units、仅「运行 dsh 的那个用户」、
仅 unit=dsh-web.service、仅 verb=restart**。卸载：删除该文件后 `systemctl restart polkit`。

## 三个踩过的坑（都已在实现里规避）

1. **unit 必须用规范名（Id）**。systemd 传给 polkit 的是规范 unit 名：例如 `chronyd.service`
   只是 `chrony.service` 的别名，实际 detail 里是 `chrony.service`。
   按别名写规则会出现「`pkcheck` 看着通过、真实重启仍被拒」。
   （抓法：`dbus-monitor --system` 抓 `CheckAuthorization` 看真实 detail。）
2. **`/etc/polkit-1/rules.d` 是 0750 root:polkitd**，普通用户属于 others，连 stat 都 EACCES。
   所以**绝不能**用「规则文件是否存在」来预检——否则每一次重启都会被自己误拦。
   本插件因此改为**乐观下发 + 经验自愈**（见下）。
3. **`systemctl --dry-run` 不做 polkit 检查**：对已授权与未授权都静默 exit 0，
   不能拿它当授权探针。

## 为什么不需要「脱离终端的助手」

`systemctl restart` 只把任务**入队**给 PID 1（systemd 在 cgroup 之外）；
即使本进程随后被 cgroup 停掉，重启任务照样跑完。
重启后的收尾——取新 token URL、必要时打开浏览器——由**新宿主启动时**本插件的
`apply()` 完成（读 `state.json` 里的 pending 标记），因此不依赖任何存活助手。

## 自愈：怎么发现「点了没反应」

按钮是乐观的（先回 202 再触发，因为重启会杀掉本进程，应答必须先落地）。
若重启因故未生效（例如 polkit 规则缺失），宿主根本不会重启，`pending` 会一直留着。
于是 `GET /status` 在 **超过 20 秒**仍见 `pending` 时判为
`restart-not-taken`，清掉 pending 并在界面上如实显示「**重启未生效**」。
前端在重启窗口内每 3 秒轮询一次，所以这条结论会自动出现。

## 安装

```bash
~/.dsh/scripts/install-local-plugin.sh dsh-restart-button ~/.dsh/plugins/dsh-restart-button web
```

随后重启一次宿主以加载插件（新增 bundle 无法靠 HMR 生效）：

```bash
dsh-restart          # 若已有该命令；否则 systemctl restart dsh-web
```

## 自测

```bash
node test/validate.mjs
```

覆盖：路由注册、HTTP 同源/环回栅栏（5 类拒绝）、自愈判定、client 渲染（4 条状态路径）。

## 安全边界

- 重启/设置接口只接受**本机环回 + 同源 Origin**，拒绝转发头（与 dsh-market 同一套栅栏）
- 命令写死为 `systemctl restart dsh-web.service`，**没有任何用户输入进入 argv**
- 打开浏览器前对 URL 做白名单校验（仅 `127.0.0.1|localhost|[::1]`）
- polkit 授权面收窄到单一用户 + 单一 unit + 单一 verb
- `state/` 是运行时数据（可能含启动 token），已在 `.gitignore` 中排除
- 界面路径：设置 → **重启 DSH**

## License

MIT
