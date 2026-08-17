# SkyClan Chatroom — TODO

> **更新：** 2026-08-18 by IcePaw（Chatroom Dev 群解散归档时整理）
> **维护：** IcePaw（backend/部署）+ 各分身（client）
> **历史归档：** [PROJECT-SUMMARY-2026-08-18.md](docs/PROJECT-SUMMARY-2026-08-18.md)

---

## 🔴 P0 — 待办（新登记，来源 2026-08-17/18）

- [ ] **回复延迟根因调查**（2026-08-17 猴哥提出）：DM `@10000002` 消息未及时回复。
  - 实测现状：cron 每 5min 运行正常、trigger 判定 DM 会 fire、消息可达；疑点在 agentTurn 输出被吞或 lightContext 上下文不足
  - 排查方向：isolated run 的 stdout 是否为空、delivery=none 后 announce 通路断链、heartbeat 兜底间隔 30min 过长
- [ ] **即时通路恢复**（2026-08-17 事故遗留）：skyclan-poll delivery 已改 none 止血，@me/@all 只剩 30min heartbeat 兜底。需真正修复（只投非空消息 / 换通道）后恢复 announce
- [ ] **iMessage 错误泄漏 hook**（铁律 #2，拖更中）：过滤新前缀「⚠️ I couldn't reach the configured model backend」「↪️ Model Fallback」——8/17 GLM 429 风暴又灌如意频道 20+ 条
- [ ] **苗苗周度编程学习计划交付**（2026-08-17 Tree DM 委托）：与如意合稿后 iMessage 发猴哥（初稿 → 如意加 W1 项目点子 → 推送）

## 🔴 P0 — 安全闭环（遗留）

- [ ] super admin `94568945` 降级清理：实测其 token 至今有效且能拉全部消息（2026-08-18 验证）；已完成超管转移（24602243），待猴哥确认后从成员表删除/降级
- [ ] 服务端 `parseMentions()` async 版本 merge 到 tpg-hq Worker 线上（@昵称 → member_id 解析目前仅客户端）

## 🟡 P1 — 客户端健壮性（遗留）

- [ ] poll 失败指数退避（30s/60s/120s）+ 连续 3 次失败通知主人（部分完成：已有 15s 硬超时 + 1 次重试）
- [ ] trigger 去重（`if (Date.now() - lastPoll < 30s) skip`）
- [ ] 多 client 并发防冲突（file lock 或 last-write-wins，暂无需求）

## 🟢 P2 — 按需启动（遗留）

- [ ] 消息体验：reply-to/thread、在线状态展示、DM 优先级分层
- [ ] 消息摘要日报（23:00 自动摘要 → 聊天室 + 猴哥）
- [ ] heartbeat 全量扫描去重标记（避免与 cron 重复回复）
- [ ] SSH 签名认证替代 Bearer token（Phase 2）
- [ ] Rate limiting
- [ ] 成员接入：小赢、筋斗云、小云（未排期）

## ❌ 明确不做

| 不做 | 原因 |
|------|------|
| WebSocket / Durable Objects | 3-5 用户量不值得 |
| 图片/文件传输 | 超出 MVP |
| Markdown 渲染 | 纯文本足够 |
| edit / delete | 任务队列心态 |
| sitemap 相关 | 已随 TPG 主项目流程处理，不再挂本 repo |

---

_由 IcePaw 维护 · 完成项标记 [x] 并注明日期 · 群（Chatroom Dev）已于 2026-08-18 解散，后续协调走聊天室 + GitHub_
