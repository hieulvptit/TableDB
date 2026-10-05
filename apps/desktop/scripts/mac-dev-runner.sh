#!/usr/bin/env bash
# Cargo runner (macOS): ký ad-hoc binary dev với identifier + designated requirement CỐ ĐỊNH (không cần chứng chỉ).
# Mặc định binary có DR = cdhash (đổi mỗi build) nên Keychain hỏi mật khẩu lại sau mỗi lần build.
BIN="$1"
ID="vn.vnpay.tabledb"

if [[ -f "$BIN" && "$BIN" == */debug/tabledb-desktop ]]; then
  codesign --force --sign - --identifier "$ID" --requirements "=designated => identifier \"$ID\"" "$BIN" >/dev/null 2>&1 \
    || echo "cảnh báo: ký thất bại, Keychain có thể hỏi lại" >&2
fi
exec "$@"
