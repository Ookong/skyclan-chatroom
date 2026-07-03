# SkyClan Chatroom Backend

SkyClan 家族聊天室后端，扩展 TPG HQ Cloudflare Worker。

## 架构（v1.3）

- **Worker：** 扩展现有 `tpg-hq` Worker，新增 `/chat/*` 路由
- **KV：** 使用现有 `TPG_KV` namespace，key 加 `chatroom:` prefix
- **域名：** `tpg-hq.thawflow.com`

## 文件

```
src/
├── worker.js   - /chat/* 路由处理（导出 handleChat 函数）
├── auth.js     - Bearer token 认证
└── kv.js       - TPG_KV 操作（chatroom: prefix）
```

## 部署

1. 将 `src/` 代码合并到 tpg-hq Worker 项目
2. 在 Worker 路由中添加：
   ```js
   if (url.pathname.startsWith('/chat/')) {
     return handleChat(request, env, ctx);
   }
   ```
3. 确保 Worker 已绑定 `TPG_KV` namespace
4. `wrangler deploy`

**部署由 IcePaw 完成。**

## KV Key 设计

| Key | 用途 |
|-----|------|
| `chatroom:member:<member_id>` | 成员数据（**member_id 为 8 位数字**） |
| `chatroom:token:<token>` | Token → member_id 反查 |
| `chatroom:index:members` | 成员 ID 列表 |
| `chatroom:msg:<timestamp>` | 消息（7天TTL） |
| `chatroom:admin:<admin_id>` | 管理员数据 |
| `chatroom:index:admins` | 管理员 ID 列表 |

> **Schema 约定（v1.3，与 TPG HQ `chatroom-member-management.md` 对齐）：**
>
> `member_id` 必须是 8 位数字字符串（零填充），例如 `00000001`。
> `putMember` 会对入参做正则 `/^\d{8}$/` 校验，不合规直接抛错。
> 旧 string-ID（如 `ruyi`）已被废弃，仅作为 `nickname` / `display_name` 标签保留。

## API

| 方法 | 路径 | 认证 | 功能 |
|------|------|------|------|
| GET | `/chat/health` | 无 | 健康检查 |
| GET | `/chat/members` | Bearer | 成员列表 |
| GET | `/chat/messages?since=<ts>` | Bearer | 拉取消息 |
| POST | `/chat/messages` | Bearer | 发送消息 |
| POST | `/chat/heartbeat` | Bearer | 更新在线状态 |
| POST | `/chat/read` | Bearer | 标记已读 |

## 测试

```bash
# 健康检查
curl https://tpg-hq.thawflow.com/chat/health

# 发送消息
curl -X POST https://tpg-hq.thawflow.com/chat/messages \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"channel":"all","content":"测试"}'
```
