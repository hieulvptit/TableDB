#!/usr/bin/env bash
# Chạy TableDB desktop (Tauri) ở chế độ dev: Vite (VITE_TARGET=desktop, :5173) + tauri dev.
# Tuỳ chọn: TABLEDB_DEV_JAVA / TABLEDB_DEV_JAR để dùng JDBC sidecar cục bộ không cần bundle JRE.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PORT=5173
VITE_PID=""

cleanup() { [[ -n "$VITE_PID" ]] && kill "$VITE_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

[[ -d "$ROOT/node_modules" ]] || (cd "$ROOT" && npm install)
[[ -d "$ROOT/apps/desktop/node_modules" ]] || (cd "$ROOT/apps/desktop" && npm install)

# tauri.conf.json cố định devUrl = http://localhost:5173
if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "==> Cổng $PORT đã có dev server, dùng lại (đảm bảo nó chạy với VITE_TARGET=desktop)."
else
  echo "==> Khởi động Vite (desktop) trên :$PORT"
  (cd "$ROOT/apps/web" && VITE_TARGET=desktop npx vite --port $PORT --strictPort) &
  VITE_PID=$!
  for _ in $(seq 1 60); do
    lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

# OpenMetadata MCP demo cho Agent (chỉ endpoint; mỗi user tự nhập token cá nhân trong panel Agent). Đặt TABLEDB_OPENMETADATA_MCP_URL="" để tắt.
# LLM endpoint nằm ở mục "agent" của config.json (mẫu: apps/desktop/src-tauri/config.sample.json).
export TABLEDB_OPENMETADATA_MCP_URL="${TABLEDB_OPENMETADATA_MCP_URL-https://open-medata.backendoffice.vn/mcp}"
[[ -n "$TABLEDB_OPENMETADATA_MCP_URL" ]] || unset TABLEDB_OPENMETADATA_MCP_URL

# Sidecar dev (chỉ debug build): mặc định dùng JAR đã build nếu có
if [[ -z "${TABLEDB_DEV_JAR:-}" && -f "$ROOT/services/jdbc/target/tabledb-jdbc.jar" ]]; then
  export TABLEDB_DEV_JAR="$ROOT/services/jdbc/target/tabledb-jdbc.jar"
fi
if [[ -z "${TABLEDB_DEV_JAVA:-}" ]] && command -v java >/dev/null 2>&1; then
  export TABLEDB_DEV_JAVA="$(command -v java)"
fi

echo "==> tauri dev"
cd "$ROOT/apps/desktop" && npm run dev
