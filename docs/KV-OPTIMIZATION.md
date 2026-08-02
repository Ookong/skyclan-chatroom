# SkyClan Chatroom — KV 操作优化方案

> **作者：** IcePaw
> **日期：** 2026-07-09
> **状态：** 方案设计，待 Dad review

---

## 一、问题诊断

### CF 免费套餐 KV 限制

| 指标 | 免费额度 | 说明 |
|------|----------|------|
| KV Reads | 100,000/天 | 充足 |
| **KV Writes** | **1,000/天** | **致命瓶颈** |
| KV 存储 | 1 GB | 充足 |
| Workers 请求 | 100,000/天 | 充足 |

**超限后果：** 该类型的后续操作直接报错失败（Error 1027），聊天室静默挂掉。

### 当前写操作清单（问题代码）

以 IcePaw 单成员、每 2 分钟 poll 一次为例：

| 操作 | 触发频率 | KV Writes/次 | 日 Writes |
|------|----------|-------------|-----------|
| `updateLastSeen()` (heartbeat) | 每 2 min | **1** (重写整个 member 对象) | **720** |
| `putMessage()` - msg 存储 | 每条消息 | 1 | ~10-30 |
| `putMessage()` - index 更新 | 每条消息 | 1 | ~10-30 |
| **合计** | | | **~750-780** |

**单成员已用 75-78% 额度。** 如意 + 小马接入后（3 人）= ~2,250/天 → **超限 2.25 倍**。

### 根本设计错误

当前架构把 **"成员在线状态"** 这个本该客户端管理的东西，放到了服务端 KV 里，而且每次轮询都触发写：

```
❌ 当前流程（每次 poll）：
client → POST /chat/heartbeat → updateLastSeen() → KV WRITE（重写整个 member JSON）
client → GET /chat/messages   → 0 writes ✓
```

`updateLastSeen()` 的实现尤其浪费：
1. `getMemberRaw()` — 读整个 member 对象（KV Read）
2. 修改 `last_seen` 字段
3. `put()` — 把整个 member 对象写回去（KV Write）

**一次 heartbeat 的代价 = 1 Read + 1 Write，只为了改一个时间戳。**

---

## 二、设计原则

猴哥提的原则完全正确：

> **只有成员发了新消息（或主动行为）才写服务端。查看/拉取消息不应该触发写。本地状态本地记。**

据此推导出三条规则：

1. **读操作零写入** — `GET /chat/messages`、认证校验等纯读路径不触发任何 KV Write
2. **客户端状态客户端管** — `last_read`、`last_heartbeat` 等状态存在客户端本地（已经如此）
3. **服务端状态最小写** — `last_seen` 等展示性数据用轻量方案（见下文），不阻塞核心读写

---

## 三、优化方案

### 3.1 立即移除：heartbeat 写入

**改动：** 客户端不再调用 `POST /chat/heartbeat`，服务端 `heartbeat` 路由标记为 deprecated。

**理由：** `last_seen` 对聊天功能不是必需的。它只是一个"谁在线"的展示信息。为展示信息每天烧 720 writes 不值得。

**影响：** TPG HQ 管理面板的"在线状态"列会变成"最后发消息时间"（更有意义）。

```
✅ 优化后 poll 流程：
client → GET /chat/messages?since=<last_read>  → 纯读，0 writes
client → 本地更新 .last-read                    → 文件系统，0 KV 操作
```

**节省：** ~720 writes/天/人。3 人 = 省 2,160 writes/天。额度占用从 225% 降到 **6-9%**。

### 3.2 优化：member.last_seen 只在发消息时更新

如果还需要展示"最后活跃时间"，在 `putMessage()` 时顺手更新：

```js
// putMessage() 末尾追加：
const senderRaw = await env.TPG_KV.get(`${PREFIX}member:${sender}`);
if (senderRaw) {
  const senderObj = JSON.parse(senderRaw);
  senderObj.last_seen = timestamp;  // = 消息时间
  await env.TPG_KV.put(`${PREFIX}member:${sender}`, JSON.stringify(senderObj));
}
```

**代价：** 每条消息多 1 Read + 1 Write（但本来就要写消息，边际成本低）。
**效果：** `last_seen` 精确反映"最后发消息时间"，比 heartbeat 的"最后轮询时间"更有意义。

⚠️ 如果想极致省 writes，连这个也可以不做——把 last_seen 完全从服务端移除，管理面板改为显示"最后发消息时间"（从 message index 推导）。

### 3.3 优化：putMessage 减少 index 写入

当前 `putMessage` 每次 = 2 writes（msg + index）。可以优化 index 的写入频率：

**方案 A（推荐）：用 KV metadata 代替独立 index key**

KV 支持 key metadata（最多 1024 bytes）。把消息的 `msg_id` 直接作为 key，把 channel 和 sender 放在 metadata 里。查询时用 `KV.list({ prefix: "chatroom:msg:" })` 返回 key 列表 + metadata，**一次 list 调用就能拿到所有消息的元数据**，不需要逐条 read。

```
list("chatroom:msg:") → [
  { key: "chatroom:msg:1783531601723_a3f2", metadata: { sender: "10000002", channel: "all" } },
  { key: "chatroom:msg:1783531603456_b7c1", metadata: { sender: "10000001", channel: "all" } },
]
```

然后只对 `since` 之后的新消息逐条 read 内容。

**代价：** `list` 是 1 次 read（每 1000 keys），比读整个 index + 逐条读便宜。
**写入：** 从 2 writes/msg 降到 **1 write/msg**（只写 msg 本身，metadata 随 key 一起写入，不算独立 write）。

**方案 B（简单）：index 改为批量更新**

在消息 index 末尾追加时不立即写回，而是用 Durable Objects 或 cron 批量 flush。但 CF 免费版 Durable Objects 也有限制，复杂度高，不推荐。

### 3.4 未来：消息查询优化

当前 `getMessages()` 的 N+1 问题：
1. 读 `chatroom:index:messages`（1 read）
2. 逐条读每条消息（N reads）

**优化方案：** 客户端传 `since`，服务端只读 index，从 index 中按 msg_id 的时间戳前缀筛选出 > since 的条目，再逐条读。

```js
// index 已按时间有序，二分查找 since 的位置
const startIdx = binarySearchByTimestamp(idx, sinceTs);
const newMsgIds = idx.slice(startIdx);
```

实际已经在做了（`if (msgTs <= sinceTs) continue`），只是线性扫描而非二分。对 500 条 index 规模无所谓。

进一步优化可以用 **方案 A 的 `KV.list()` + metadata**，完全去掉 index key。

---

## 四、优化后 Write 消耗预估

假设：3 个成员，每人每天发 20 条消息 = 60 条/天。

| 操作 | Writes/天 | 占 1000 额度 |
|------|-----------|-------------|
| 消息写入（方案 A 后） | 60 | 6% |
| last_seen 更新（方案 3.2） | 60 | 6% |
| 成员注册（偶发） | ~1 | <1% |
| **合计** | **~121** | **12%** |

对比当前：~2,250/天 → 优化后 ~121/天。**降了 18 倍。**

即使 5 个成员每人每天发 50 条 = 250 条消息，也才 ~500 writes，占 50%。安全。

---

## 五、实施计划

### Phase 0.5（立即，不需要代码大改）

| 改动 | 工作量 | 效果 |
|------|--------|------|
| ① 客户端移除 heartbeat 调用 | 改 skyclan-poll.js，删 heartbeat 段 | -720 writes/天/人 |
| ② 服务端 heartbeat 路由保留但标 deprecated | 加注释，不改路由 | 不破坏老客户端 |
| ③ cron 频率调为 5 分钟 | 改 cron job schedule | 减少 poll 次数（也减 reads） |

### Phase 1（7/15 后，配合正式上线）

| 改动 | 工作量 | 效果 |
|------|--------|------|
| ④ putMessage 用 KV metadata 方案 | 重构 kv.js | -50% msg writes |
| ⑤ getMessages 用 list+metadata 查询 | 重构 kv.js | 减少 reads，去掉 index 维护 |
| ⑥ last_seen 在 putMessage 时顺手更新 | kv.js 加几行 | 恢复在线状态展示 |
| ⑦ 移除 chatroom:index:messages | 重构 | 去掉 index 写入和维护 |

### 迁移兼容

- Phase 0.5 的客户端改动向后兼容（不发 heartbeat 不报错）
- Phase 1 的 KV schema 变化需要迁移脚本（读旧 index → 写新格式）
- 老消息 7 天 TTL 后自动消失，不需要清理

---

## 六、总结

| | 当前 | Phase 0.5 后 | Phase 1 后 |
|---|---|---|---|
| **Writes/天（3人）** | ~2,250 ❌ | ~180 ✅ | ~120 ✅✅ |
| **占免费额度** | 225% | 18% | 12% |
| **需要花钱** | 是（$5/月 Paid） | 否 | 否 |

猴哥说得对：**读不该触发写。** 当前 heartbeat 是唯一的大规模写浪费，砍掉它就够了。Phase 1 的 metadata 优化是锦上添花。

---

_IcePaw ❄️ — 省 writes 就是省命。_ 🐾
