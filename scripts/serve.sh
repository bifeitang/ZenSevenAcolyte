#!/usr/bin/env bash
# scripts/serve.sh — 本機預覽 public/（DESIGN.md 第 10 節第 5 點）
#
# 用法：
#   ./scripts/serve.sh
# 然後開瀏覽器造訪 http://localhost:8746/

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -d "$ROOT_DIR/public" ]; then
  echo "[serve] 找不到 public/，請先執行 npm run build" >&2
  exit 1
fi

echo "[serve] 於 http://localhost:8746/ 提供 public/ …（Ctrl+C 結束）"
exec python3 -m http.server 8746 -d "$ROOT_DIR/public"
