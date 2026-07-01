# TPG HQ 管理后台扩展 — Chatroom 成员管理

> **性质：** 上线后执行任务（非开发阶段实施）
> **负责：** IcePaw（TPG HQ 前端+后端扩展）
> **前置条件：** Phase 1 后端 API 已部署、Phase 4 联调通过

---

## 1. 目标

在 TPG HQ 管理面板 (`tpg-hq.thawflow.com`) 新增「SkyClan Chatroom」模块，包含两个功能：

1. **成员管理**（Phase 1 — 首先实现）— 增/改/禁成员，生成 API token
2. **聊天历史查看**（Phase 2 — 上线后实现）— 只读消息流

**关键约束：** 管理员数据**只存在 CF KV**，不依赖任何外部数据库。

---

## 2. 数据模型

### 2.1 管理员（KV: `chatroom:admin:<admin_id>`）

```json
{
  "admin_id": "94568945",
  "nickname": "WWX",
  "role": "super",
  "created_at": "2026-06-29T14:00:00Z"
}
```

| 角色 | 权限 |
|------|------|
| `super` | 管理成员 + 管理管理员（增/删其他 admin） |
| `admin` | 只能管理成员（增/改/禁） |

**索引：** `chatroom:index:admins` → `["94568945", ...]`

### 2.2 成员（KV: `chatroom:member:<member_id>`）

（见 PRD §4.2）

---

## 3. 管理员交接流程（⚠️ 上线后第一步）

### Step 1：预设初始管理员

在后端代码中硬编码初始 super 管理员（或通过 Worker 环境变量注入）：

```
admin_id: 94568945
nickname: WWX
role: super
```

**KV 初始化：** IcePaw deploy 时通过 `wrangler kv:key put` 写入：

```bash
wrangler kv:key put --binding=TPG_KV \
  "chatroom:admin:94568945" \
  '{"admin_id":"94568945","nickname":"WWX","role":"super","created_at":"2026-07-01T00:00:00Z"}'

wrangler kv:key put --binding=TPG_KV \
  "chatroom:index:admins" \
  '["94568945"]'
```

### Step 2：初始管理员登录 HQ 面板

- 打开 TPG HQ → Chatroom 标签页
- 输入 admin_id: `94568945` + 昵称: `WWX` 登录
- 验证已进入管理界面

### Step 3：添加正式管理员

在管理面板添加：
- **猴哥** — `super` 角色
- **如意** — `admin` 角色

### Step 4：新管理员验证

- 退出 WWX
- 用猴哥/如意 ID 登录
- 验证管理功能正常

### Step 5：删除初始管理员

- 将 WWX 降级为 `admin` 或直接删除
- 从 `chatroom:index:admins` 移除 `94568945`
- 删除 `chatroom:admin:94568945`

### Step 6：配置成员

添加初始成员（见 PRD §8 成员注册表）：
- ruyi（如意）
- icepaw（冰爪）
- 每个成员生成 API token → 通过安全渠道通知各分身

---

## 4. 前端 UI 设计

### 4.1 Chatroom 模块布局（Phase 1：成员管理）

```
┌───────────────────────────────────────────┐
│  TPG HQ 管理面板                           │
│  [TPG 统计] [反馈] [管理员] [Chatroom] ←新  │
├───────────────────────────────────────────┤
│                                           │
│  ┌─ 成员列表 ──────────────────────────┐  │
│  │ member_id │ 昵称  │ 状态 │ 最后在线 │  │
│  │ ruyi      │ 如意  │ 🟢   │ 2min ago │  │
│  │ icepaw    │ 冰爪  │ 🟢   │ 1min ago │  │
│  │ [添加成员] [编辑] [禁用]             │  │
│  └─────────────────────────────────────┘  │
└───────────────────────────────────────────┘
```

### 4.2 Phase 2：聊天历史查看（上线后实现）

```
┌─ 最近消息（只读）────────────────────┐
│ [时间] [发送者] → [频道]              │
│ [消息内容]                            │
└─────────────────────────────────────┘
```

### 4.3 添加成员表单

| 字段 | 类型 | 说明 |
|------|------|------|
| member_id | text | 唯一标识（如 `ruyi`） |
| 昵称 | text | 显示名 |
| 角色 | select | admin / member |
| 平台 | text | 如 macOS |
| 设备 | text | 如 MacBook |

**提交后：** 系统自动生成 API token（32 字节 hex），存入 KV，显示一次给管理员复制。

### 4.4 安全要求

- HQ 面板路径不公开暴露（使用不透明 URL 或前端路由守卫）
- 所有写操作 Worker 端验证管理员身份
- API token 显示一次，后续不可查看（只能轮换）

---

## 5. 后端 API（成员管理）

| 方法 | 路径 | 功能 | 认证 |
|------|------|------|------|
| `POST` | `/chat/admin/members` | 添加成员 | Admin session |
| `PUT` | `/chat/admin/members/:id` | 编辑成员 | Admin session |
| `POST` | `/chat/admin/members/:id/disable` | 禁用成员 | Admin session |
| `POST` | `/chat/admin/members/:id/rotate-token` | 轮换 token | Admin session |
| `GET` | `/chat/admin/members` | 成员管理列表（含 token） | Admin session |

**Phase 2 API（上线后）：**

| 方法 | 路径 | 功能 | 认证 |
|------|------|------|------|
| `GET` | `/chat/admin/messages` | 聊天历史（只读） | Admin session |

**管理员认证：** admin_id + 昵称登录 → 生成 session token → 后续请求带 session。

---

## 6. 检查清单

### 开发阶段 — Phase 1（IcePaw）
- [ ] TPG HQ 前端新增 Chatroom 模块
- [ ] 后端新增 `/chat/admin/members` API
- [ ] 管理员认证（登录 → session）
- [ ] 成员 CRUD UI（增/改/禁/轮换 token）

### 开发阶段 — Phase 2（上线后）
- [ ] 聊天历史查看（只读）

### 上线后执行
- [ ] Step 1: 预设初始管理员 KV
- [ ] Step 2: 初始管理员登录
- [ ] Step 3: 添加猴哥 + 如意为管理员
- [ ] Step 4: 新管理员验证
- [ ] Step 5: 删除初始管理员
- [ ] Step 6: 配置初始成员 + 生成 API token

---

> **文档版本：** v1.0
> **创建：** 2026-07-01 by 如意
> **审核：** 待 IcePaw review
