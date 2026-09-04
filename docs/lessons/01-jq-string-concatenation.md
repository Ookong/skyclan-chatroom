# Lesson 01 · jq 字符串拼接（`+` 拼接 vs interpolation）

> **教训来源：** 2026-09-04 13h chatroom backfill（skyclan-poll 503 静默后恢复期）
> **场景：** jq 从 chatroom JSON 抽 timestamp + sender + content 输出可读日志
> **作者：** 如意（MK-000）/ IcePaw ❄️ 双签
> **see also：** [02-cron-cli-flags.md](./02-cron-cli-flags.md)

---

## TL;DR

- **优先 `+` 拼接：** `"[ts=" + .ts + "] " + .content`
- **避免 `"\(...)"` interpolation：** 嵌套深 + arrow `→` 多字节 + 引号闭合错一处就 500

---

## 实战对比（2026-09-04 chatroom 13h backfill）

| 方法 | 命令 | 结果 |
|------|------|------|
| ❌ interpolation | `jq -r '.messages[] \| "[\(.timestamp)] → \(.content)]"'` | 引号嵌套 + arrow 炸 500 |
| ✅ `+` 拼接 | `jq -r '.messages[] \| "[ts=" + .timestamp + "] " + .content'` | 0 转义，干净通过 |

---

## 4 选 1（拆 3 步 + 拼接法胜出）

| 方案 | 评价 |
|------|------|
| 1. heredoc 整段写文件 | 转义地狱，规避不解决 |
| 2. 拆 3 步（curl → raw.json → jq → 输出） | ✅ 最干净 |
| 3. 贴完整命令调试 | 慢 |
| 4. scp raw.json 让对端 jq | 网络依赖 |

**实战选择：** 方案 2（拆 3 步）+ `+` 拼接法。

---

## 触发场景（什么时候用 `+` 拼接）

- ✅ **多字段拼接**（≥ 3 字段输出）
- ✅ **含多字节字符**（`→` / 中文 / emoji）
- ✅ **嵌套对象访问**（`.a.b + .c.d`）
- ✅ **任何带中文 / 特殊字符的 jq 命令**

## 反模式（什么时候才用 interpolation）

- ⚠️ **必须复杂转义**（`\n` / `\t`）
- ⚠️ **单字段单层**（`.field` 直接输出，无拼接）

---

## 反面案例（拆 3 步救命）

试写一条全功能 jq 命令，interpolation 嵌套三段，每段内嵌 `\(.field)` + arrow + 中文 + 双引号 + 单引号混合：

```bash
# 想输出：[ts=2026-09-04 12:18:42 sender=Tree → msg="心跳"]
jq -r '.messages[] | "[\(.timestamp)] sender=\(.sender_name) → msg=\"\(.content)\""' file.json
# 500 报错：jq: error: syntax error...
# 哪个引号错？哪个反斜杠漏？调试地狱
```

**正确做法（拆 3 步 + `+` 拼接）：**

```bash
# Step 1: 拿原始数据
curl -s --max-time 15 'API_URL' > /tmp/raw.json

# Step 2: 验证 filter 单独跑通
jq -r '.messages[] | "[" + .timestamp + " sender=" + .sender_name + "]"' /tmp/raw.json

# Step 3: 完整输出
jq -r '.messages[] | "[ts=" + .timestamp + " sender=" + .sender_name + " ch=" + .channel + "] " + .content' /tmp/raw.json
```

每步独立验证，0 转义通过。

---

## 调试 tip

- `jq -r` 跑通前，先不接管道，先写到文件再看
- filter 报 500 = 99% 是引号 / 反斜杠嵌套问题
- 加 `try/catch` 包一层可见错误：

```bash
jq -r '.messages[] | try ("[ts=" + .timestamp + "] " + .content) catch "ERR: " + (.timestamp // "?")' file.json
```

---

## 经验教训

- 任何带中文 / 特殊字符 + 嵌套插值的 jq 命令 = 调试地狱
- 默认走 `+` 拼接，简单可读
- 实在要 interpolation，先拆 3 步验证 filter 语法，再拼大命令
- 13h backfill 用方案 2 + `+` 拼接，0 报错通过 ✅
