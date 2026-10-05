#!/usr/bin/env bash
# Chạy API local (dev) cho desktop: đăng nhập qua genai.vnpay.vn, JWT KHÔNG kiểm chữ ký (chỉ dev; prod từ chối).
# Đặt GENAI_JWT_KEY (base64) và bỏ GENAI_DEV_TRUST_UNVERIFIED để kiểm chữ ký thật.
set -euo pipefail
cd "$(cd "$(dirname "$0")" && pwd)/services/api"
export APP_ENV="${APP_ENV:-dev}"
export CORS_ORIGINS="${CORS_ORIGINS:-tauri://localhost,http://tauri.localhost,http://localhost:5173}"
export GENAI_LOGIN_URL="${GENAI_LOGIN_URL:-https://genai.vnpay.vn/create-jwt-token}"
[[ -n "${GENAI_JWT_KEY:-}" ]] || export GENAI_DEV_TRUST_UNVERIFIED="${GENAI_DEV_TRUST_UNVERIFIED:-1}"
export ALLOWED_EMAIL_DOMAINS="${ALLOWED_EMAIL_DOMAINS:-vnpay.vn}"
# User duyệt (leader) giả, tạo lại mỗi lần chạy (DB in-memory). Đặt DEV_SEED_LEADERS="" để tắt.
export DEV_SEED_LEADERS="${DEV_SEED_LEADERS-leader1@vnpay.vn:Nguyễn Văn Duyệt,leader2@vnpay.vn:Trần Thị Lãnh Đạo,leader3@vnpay.vn:Lê Quang Phê}"
# (Agent chạy hoàn toàn trong app desktop: LLM / OpenMetadata cấu hình ở config.json của desktop, xem run-desktop-dev.sh.)
exec go run ./cmd/server
