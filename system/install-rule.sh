#!/usr/bin/env bash
# install-rule.sh —— 安装 polkit 规则（最小授权：仅本用户 + 仅 dsh-web.service + 仅 restart）
#
# 用法:
#   ./install-rule.sh              # 使用当前用户
#   ./install-rule.sh <username>   # 指定运行 dsh 的用户
#
# 需要 sudo（写 /etc/polkit-1/rules.d 并重启 polkit）。
set -euo pipefail

DST=/etc/polkit-1/rules.d/49-dsh-web-restart.rules
UNIT=dsh-web.service
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMPL="$SRC_DIR/49-dsh-web-restart.rules.tmpl"

USER_NAME="${1:-$(id -un)}"

if [ ! -f "$TMPL" ]; then
  echo "找不到模板: $TMPL" >&2
  exit 1
fi

if ! id "$USER_NAME" >/dev/null 2>&1; then
  echo "用户不存在: $USER_NAME" >&2
  exit 1
fi

echo "==> 安装 polkit 规则"
echo "    用户   : $USER_NAME"
echo "    单元   : $UNIT（仅 restart）"
echo "    目标   : $DST"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
sed "s/@DSH_USER@/$USER_NAME/g" "$TMPL" > "$TMP"

sudo install -m 0644 -o root -g root "$TMP" "$DST"
sudo systemctl restart polkit

echo "==> 完成。验证："
echo "    pkcheck --action-id org.freedesktop.systemd1.manage-units \\"
echo "      --process \$\$ --detail unit $UNIT --detail verb restart"
echo "    （普通用户直接调用 pkcheck 会被拒：'Only trusted callers ...'，"
echo "      需以 root 指定目标进程 pid 来校验。）"

echo "==> 卸载：sudo rm -f $DST && sudo systemctl restart polkit"
