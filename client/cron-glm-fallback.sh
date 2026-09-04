#!/usr/bin/env bash
# cron-glm-fallback.sh — 给指定 cron 加 zai/glm-5.3 到 fallbacks 首位
# 用途：minimax/MiniMax-M3 / kimi/k2.6 撞 503 / rate_limit 时临时切 GLM-5.3 备用
#
# 用法：
#   ./cron-glm-fallback.sh --list                       # 列所有 cron + model 状态
#   ./cron-glm-fallback.sh <cron-name>                  # 加 zai/glm-5.3 到 fallbacks 首位
#   ./cron-glm-fallback.sh <cron-name> --primary        # 切主（payload.model）
#   ./cron-glm-fallback.sh <cron-name> --rollback <file> # 从备份恢复
#
# 备份：${BACKUP_DIR:-$HOME/.openclaw/workspace/.cron-backups}/<cron-name>-<timestamp>.json
#       BACKUP_DIR 环境变量可覆盖；默认路径不可写时自动 fallback /tmp/cron-backups
# 验收：openclaw cron get <id> | jq '.payload.fallbacks'

set -euo pipefail

# cleanup .tmp on any exit（防中断留垃圾；set -u 友好）
trap 'rm -f "${BACKUP:-}.tmp" 2>/dev/null || true' EXIT

# --- helpers ---
get_cron_id() {
  local name="$1"
  openclaw cron list --json | jq -r --arg n "$name" '.jobs[] | select(.name == $n) | .id' | head -1
}

# 解析 backup 目录（env override + 不可写 fallback /tmp）
# 仅 --rollback 和默认 patch case 调用；--list/--help 不碰
resolve_backup_dir() {
  local dir="${BACKUP_DIR:-$HOME/.openclaw/workspace/.cron-backups}"
  if ! mkdir -p "$dir" 2>/dev/null; then
    dir="/tmp/cron-backups"
    mkdir -p "$dir"
  fi
  echo "$dir"
}

list_state() {
  echo "name | id | lastRunStatus | consecutiveErrors"
  openclaw cron list --json | jq -r '
    .jobs[] | [
      .name,
      (.id | .[0:8]),
      (.state.lastRunStatus // "n/a"),
      (.state.consecutiveErrors // 0)
    ] | @tsv
  ' | column -t -s $'\t' | sort
}

# --- main ---
case "${1:-}" in
  --list|"")
    list_state
    ;;
  --help|-h)
    sed -n '2,16p' "$0"
    ;;
  --rollback)
    NAME="$2"; FILE="$3"
    [ -z "$FILE" ] && { echo "Usage: $0 --rollback <cron-name> <backup-file>"; exit 1; }
    ID=$(get_cron_id "$NAME")
    [ -z "$ID" ] && { echo "❌ cron '$NAME' not found"; exit 1; }
    [ ! -f "$FILE" ] && { echo "❌ backup file not found: $FILE"; exit 1; }
    # rollback sanity check 1: 必须有 _meta（防旧格式/错文件）
    [ -z "$(jq -r '._meta.prePatchUpdatedAtMs // empty' "$FILE" 2>/dev/null)" ] && \
      { echo "❌ backup missing _meta.prePatchUpdatedAtMs (旧格式 or 错文件)"; exit 1; }
    # rollback sanity check 2: cron 当前 updatedAtMs 必须 > backup prePatchUpdatedAtMs
    PRE_UPDATED=$(jq -r '._meta.prePatchUpdatedAtMs' "$FILE")
    CUR_UPDATED=$(openclaw cron get "$ID" | jq -r '.updatedAtMs')
    [ "$CUR_UPDATED" -le "$PRE_UPDATED" ] && \
      { echo "❌ backup 不比当前老 (pre=$PRE_UPDATED, cur=$CUR_UPDATED) — 没 patch 过？拒 rollback"; exit 1; }
    echo "✓ backup is older than current (delta: $((CUR_UPDATED - PRE_UPDATED))ms)"
    # CLI 不支持 generic --patch，用字段级还原（launcher 只改 model + fallbacks）
    ORIG_MODEL=$(jq -r '.payload.model // empty' "$FILE")
    ORIG_FALLBACKS=$(jq -c '.payload.fallbacks // []' "$FILE")
    if [ -n "$ORIG_MODEL" ]; then
      openclaw cron edit "$ID" --model "$ORIG_MODEL"
    else
      openclaw cron edit "$ID" --clear-model
    fi
    openclaw cron edit "$ID" --fallbacks "$ORIG_FALLBACKS"
    echo "✓ Rolled back $NAME from $FILE (model='$ORIG_MODEL', fallbacks=$ORIG_FALLBACKS)"
    ;;
  *)
    CRON_NAME="$1"; MODE="${2:-fallback}"
    ID=$(get_cron_id "$CRON_NAME")
    if [ -z "$ID" ]; then
      echo "❌ cron '$CRON_NAME' not found. Use --list to see all."
      exit 1
    fi
    BDIR=$(resolve_backup_dir)
    BACKUP="$BDIR/${CRON_NAME}-$(date +%Y%m%d-%H%M%S).json"
    # pre-patch backup with _meta（防 post-patch backup 误判）
    # macOS BSD date 不支持 %N，用 python3 拿毫秒
    NOW_MS=$(python3 -c 'import time; print(int(time.time()*1000))')
    PRE_UPDATED=$(openclaw cron get "$ID" | tee "$BACKUP.tmp" | jq -r '.updatedAtMs')
    jq -c --arg preu "$PRE_UPDATED" --arg now "$NOW_MS" \
      '. + {_meta: {prePatchUpdatedAtMs: ($preu | tonumber), capturedAtMs: ($now | tonumber)}}' \
      "$BACKUP.tmp" > "$BACKUP"
    rm "$BACKUP.tmp"
    echo "✓ $CRON_NAME → $ID"
    echo "✓ Backup → $BACKUP (prePatchUpdatedAtMs: $PRE_UPDATED)"

    case "$MODE" in
      --primary)
        # CLI: --model 设主
        openclaw cron edit "$ID" --model "zai/glm-5.3"
        echo "✓ Primary switched to zai/glm-5.3"
        ;;
      fallback|*)
        # CLI: --fallbacks 接逗号分隔（不是 JSON 数组串 — 2026-09-04 格式 BUG 探明）
        CUR_FALLBACKS=$(jq -c '.payload.fallbacks // []' "$BACKUP")
        NEW_FALLBACKS=$(jq -c -n --argjson cur "$CUR_FALLBACKS" '(["zai/glm-5.3"] + $cur | unique)')
        CSV=$(printf '%s' "$NEW_FALLBACKS" | jq -r '. | join(",")')
        openclaw cron edit "$ID" --fallbacks "$CSV"
        echo "✓ Added zai/glm-5.3 to fallbacks (dedup, was: $CUR_FALLBACKS, now: $NEW_FALLBACKS)"
        ;;
    esac

    # post-patch delta verify
    POST_UPDATED=$(openclaw cron get "$ID" | jq -r '.updatedAtMs')
    if [ "$POST_UPDATED" -gt "$PRE_UPDATED" ]; then
      echo "✓ patch applied (delta: $((POST_UPDATED - PRE_UPDATED))ms)"
    else
      echo "⚠️ no updatedAtMs change (patch silent?)"
    fi

    echo "--- current state ---"
    openclaw cron get "$ID" | jq '{model: .payload.model, fallbacks: .payload.fallbacks}'
    echo ""
    echo "回滚：$0 --rollback $CRON_NAME $BACKUP"
    ;;
esac
