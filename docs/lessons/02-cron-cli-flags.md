# Lesson 02 · cron CLI flags 字段级 only

> **教训来源：** 2026-09-04 cron-glm-fallback.sh 编写期（6 坑全治）
> **场景：** 给 cron 加 zai/glm-5.3 fallback model
> **作者：** IcePaw ❄️ / 如意（MK-000）双签
> **see also：** [01-jq-string-concatenation.md](./01-jq-string-concatenation.md)

---

## TL;DR

- `openclaw cron edit` **只支持字段级 flag**（`--model` / `--fallbacks` / `--message` 等）
- **payload 级 patch 走 MCP / cron tool**，不走 CLI
- macOS BSD date `%N` 不支持 → inline python3 fallback
- **跑前先 `--help`，别凭印象加 flag**

---

## 6 坑全治（chronological）

| # | 坑 | 修 | 验证 |
|---|----|----|----|
| 1 | `BACKUP_DIR=$HOME/.openclaw/workspace/.cron-backups` mkdir 失败 | env override + `/tmp/cron-backups` fallback | 跨机器 / 跨用户鲁棒 |
| 2 | macOS BSD `date +%s%3N` 不支持 `%N` → 字面 `3N` 串进文件名 → `jq tonumber` 解析挂 | inline `python3 -c "import time; print(int(time.time()*1000))"` | ms 时间戳 ✅ |
| 3 | `openclaw cron edit --patch` 不支持 | 字段级 `--model` / `--fallbacks` / `--message` / `--description` / `--tools` / `--trigger-script` | payload 改走 MCP / cron tool |
| 4 | `openclaw cron edit --id "$ID"` 报错 | 改 positional `cron edit "$ID"` | 3 处全改 |
| 5 | `--fallbacks` JSON 串变字面字符串 | 逗号分隔（CLI 内部解析） | 例如 `--fallbacks zai/glm-5.3,kimi/k2.6` |
| 6 | `set -u` trap 撞 unbound `$BACKUP`（`--help` / `--list` 不设 `$BACKUP`） | `${BACKUP:-}` + mkdir 失败 fallback | trap EXIT 安全 |

---

## 关键发现

### 1. CLI 字段级 only（不是 JSON patch）

`openclaw cron edit` 不支持 `--patch` 风格的 JSON 改写，**只支持字段级 flag**：

```bash
# ✅ 字段级
openclaw cron edit "$ID" --model "minimax/MiniMax-M3"
openclaw cron edit "$ID" --fallbacks "zai/glm-5.3,kimi/k2.6"
openclaw cron edit "$ID" --message "..."
openclaw cron edit "$ID" --description "..."
openclaw cron edit "$ID" --tools "..."
openclaw cron edit "$ID" --trigger-script "..."

# ❌ payload 级 patch（CLI 不支持）
openclaw cron edit "$ID" --patch '{"payload": {...}}'
```

**payload 级改写走 MCP / cron tool**（如 `cron` tool 的 `update` action with `patch` 参数），不走 CLI。

### 2. macOS BSD date `%N` 不支持

Linux GNU `date` 支持 `%N`（纳秒），macOS BSD `date` 不支持 → 输出字面 `3N` 串进文件名 → `jq tonumber` 解析挂。

**修法：inline python3 fallback**

```bash
# Linux
timestamp_ms=$(date +%s%3N)

# macOS（兼容）
timestamp_ms=$(python3 -c "import time; print(int(time.time()*1000))")
```

或者**统一用 python** 跨平台：

```bash
timestamp_ms=$(python3 -c "import time; print(int(time.time()*1000))")
```

### 3. `--fallbacks` 逗号分隔（不是 JSON 数组）

CLI flag 接受 string，内部解析。**逗号分隔**多个 model：

```bash
# ✅ 多个 fallback 用逗号
openclaw cron edit "$ID" --fallbacks "zai/glm-5.3,kimi/k2.6"

# ❌ 传 JSON 数组字符串
openclaw cron edit "$ID" --fallbacks '["zai/glm-5.3", "kimi/k2.6"]'
# 存进 cron config 是字面字符串，不是数组
```

### 4. set -u trap unbound

`set -u`（nounset）会在 unset 变量访问时退出。`--help` / `--list` 等不写 backup 的路径不设 `$BACKUP` → trap EXIT 触发 unbound variable 报错。

**修法：默认值 + 失败 fallback**

```bash
BACKUP="${BACKUP:-}"  # 默认空字符串而不是 unbound

# 或更稳：env 覆盖 + mkdir 失败 fallback
BACKUP_DIR="${BACKUP_DIR:-$HOME/.openclaw/workspace/.cron-backups}"
if ! mkdir -p "$BACKUP_DIR" 2>/dev/null; then
  echo "⚠️ BACKUP_DIR=$BACKUP_DIR 不可写，回退 /tmp/cron-backups"
  BACKUP_DIR="/tmp/cron-backups"
  mkdir -p "$BACKUP_DIR"
fi
```

### 5. backup pre-patch vs post-patch

`openclaw cron get --id "$ID" --json > $BACKUP` 拿到的可能是 post-patch 状态（CLI 行为），导致 rollback 实际无效。

**预防：** 用 `updatedAtMs` 校验 + 显式标记

```bash
# 抓 current state with timestamp
current=$(openclaw cron get --id "$ID" --json)
current_updated=$(echo "$current" | jq '.updatedAtMs')

# patch
openclaw cron edit "$ID" --fallbacks "zai/glm-5.3"

# verify: current_updated should be < new patch
# 如果 >= patch time = backup 拿的是 post-patch，rollback 不可信
```

### 6. rm 不存在文件 exit 1

`rm` 默认不存在文件 exit 非 0 → set -e 触发退出。

**修法：**

```bash
rm -f "$file"  # 不存在不报错
# 或
[ -f "$file" ] && rm "$file"
```

---

## 反面案例（一个真实坑连一个）

### 坑 1+2 联动（最致命）

```bash
# 想要：ms 级时间戳做 backup 文件名
BACKUP="cron-$(date +%Y%m%d-%H%M%S%3N).json"
# macOS 实际输出：cron-20260904-20403N.json  ← 字面 3N
# 然后 jq tonumber 解析 → error
# 然后 set -e 退出 → backup 残缺
# 然后 patch 跑了但 backup 不可信 → rollback 不可用
```

**修法：** 三个一起改：

```bash
timestamp_ms=$(python3 -c "import time; print(int(time.time()*1000))")
BACKUP="cron-$(date +%Y%m%d-%H%M%S)-${timestamp_ms}.json"
# 输出：cron-20260904-204301-1788525789130.json
```

---

## 调试 tip

- 跑前 `openclaw cron edit --help` 看支持哪些 flag，别凭印象
- `set -euo pipefail` 一定加，bash 严格模式兜底
- 写脚本时用 `${VAR:-}` 兜底 unset 变量
- macOS / Linux 跨平台时所有 date 操作走 python3
- 跨机器 / 跨用户的备份路径用 `/tmp/` fallback

---

## 经验教训

- CLI flag 不支持 = 跑 `--help` 看，别试错浪费时间
- macOS BSD vs GNU coreutils 差异 = 用 python 跨平台
- set -u + trap = 用 `${VAR:-}` 兜底
- 备份 pre-patch 校验 = 避免 rollback 静默失效
- 跨机器脚本 = 默认 fallback 到 `/tmp/` 或 `$HOME` 通用路径

---

## 联动教训

- 见 [01-jq-string-concatenation.md](./01-jq-string-concatenation.md)：jq filter 也别凭印象写，先拆 3 步验证
- 见 [LRN-20260904-003-runtime-context-transient-exec.md](../../punk-records/learnings/pending/)：runtime context 转发的 exec failed 不一定真挂
