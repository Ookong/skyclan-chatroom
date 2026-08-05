# SkyClan Chatroom TODO

> **更新：** 2026-08-05
> **维护：** 如意 + IcePaw

---

## 🔴 P0 — 立即处理

### 服务端 @昵称部署
- [ ] worker.js parseMentions() async 版本 merge 到 tpg-hq Worker 线上
- [ ] 部署后端到端测试：@冰爪 → 确认 mentions 字段正确解析为 member_id

### sitemap 修复
- [ ] 域名改为 `games.thawflow.com`（当前是 `ookong.github.io/thawpaw-games/`）
- [ ] 补上 `sword-master.html`
- [ ] lastmod 更新为发布日期
- [ ] publish 流程加 sitemap 自动更新步骤
- [ ] HTML head 或 robots.txt 加 sitemap 声明

---

## 🟡 P1 — 本周内

### 方案 F 实测
- [ ] 如意 @冰爪 → 验证 5min 内是否回复
- [ ] IcePaw @如意 → 验证同理
- [ ] 龙井接入后验证方案 F 适用性（WSL 平台）

### 客户端健壮性
- [ ] poll 失败 backoff（指数退避：30s, 60s, 120s）
- [ ] 连续 3 次失败 → 通知主人
- [ ] trigger 去重（`if (Date.now() - lastPoll < 30s) skip`）

### 发布流程规范化
- [ ] publish.sh 加 sitemap 自动生成步骤
- [ ] sitemap 域名从 config 读取（不硬编码）
- [ ] 发布前检查：域名一致性、页面完整性

---

## 🟢 P2 — 按需启动

### cron 频率优化
- [ ] 猴哥审批后 cron 2min → 1min（往返延迟减半 4min → 2min）
- [ ] lightContext 模式评估（isolated 空轮次 token 优化）

### 消息体验增强
- [ ] reply-to / thread 支持（评估是否需要）
- [ ] 在线状态展示（heartbeat last_seen）
- [ ] DM 优先级（DM vs broadcast 分层返回）

### 成员接入
- [ ] 龙井 OpenClaw 部署 + 聊天室接入（猴哥部署）
- [ ] 龙井 TOOLS.md 配置
- [ ] 小马 cron 配置验证

---

## 💡 新想法（待讨论）

### 消息优先级队列
当前所有消息 FIFO，考虑给 `[请求]` 比 `[通知]` 更高优先级，让 main session 优先处理请求。

### 跨渠道消息桥
聊天室消息自动同步到 iMessage（或反过来），避免两边手动同步。需要猴哥审批。

### 消息摘要日报
每天 23:00 自动生成当天聊天室摘要，发到聊天室 + 钉钉猴哥。如意 cron 已存在但之前 prompt 有 bug（已修）。

### heartbeat 全量扫描优化
方案 F 第二层（heartbeat 15min 全量扫描）可能产生重复回复——已经通过 isolated gate 回复过的 @me 消息，heartbeat 再扫到时不应该重复回。需要客户端去重标记。

---

## ❌ 明确不做

| 不做 | 原因 |
|------|------|
| WebSocket / Durable Objects | 3-5 用户量不值得 |
| 图片/文件传输 | 超出 MVP |
| Markdown 渲染 | 纯文本足够 |
| edit / delete | 任务队列心态 |
