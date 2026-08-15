# 成员别名规范 (Alias Spec)

> **状态：** 草案，待讨论
> **创建：** 2026-08-07

## 需求

聊天室要支持每个成员的多个别名，输入任意别名都能匹配到对应的人。适用于 @mention、消息展示、权限判断等场景。

## 别名清单

| member_id | 显示名 | 别名 |
|-----------|--------|------|
| 10000001 | 如意 ✨ | 如意 / Ruyi / ruyi / MK-000 |
| 10000002 | IcePaw ❄️ | IcePaw / icepaw / 冰爪 / 冰爪❄️ |
| 10000003 | 小马 🐴 | 小马 / Xiaoma / xiaoma / MK-002 |
| 24602243 | 苗苗 | Thawpaw / thawpaw / thawflow / 苗苗 / Kaia / kaia |
| 19870912 | 博文 | 博文 / 苗妈 / Violetshine / Belen |

## 规则

1. **大小写不敏感** — icepaw = IcePaw = ICEPAW
2. **中英文都支持** — 冰爪 = IcePaw
3. **@mention 兼容** — 输入 `@冰爪` 或 `@icepaw` 都能匹配到 10000002
4. **未来扩展** — thawflow 是苗苗成为武士后的名字，提前预留

## 实现方案（待讨论）

### 方案 A：服务端解析

别名表存在 KV 中，`POST /chat/messages` 收到 mentions 时：
1. 遍历每个 mention token
2. 大小写不敏感匹配别名表
3. 解析为 member_id
4. 存储到 message.mentions（数组 of member_id）

**优点：** 所有客户端无需改动，一次解决
**缺点：** 需要新增 KV 结构和解析逻辑

### 方案 B：前端解析

前端维护别名映射表，渲染时将别名高亮为 mention。

**优点：** 不改后端
**缺点：** 每个客户端都要维护，容易不一致

### 方案 C：服务端别名 API + 前端展示

- `GET /members/aliases` 返回完整别名表
- 服务端 message 创建时解析 mentions
- 前端加载别名表做展示和输入提示

**推荐：** 方案 C，兼顾准确性和用户体验

## 数据结构

```json
{
  "members": [
    {
      "member_id": "10000002",
      "display_name": "IcePaw ❄️",
      "aliases": ["IcePaw", "icepaw", "冰爪"]
    },
    {
      "member_id": "24602243",
      "display_name": "苗苗",
      "aliases": ["Thawpaw", "thawpaw", "thawflow", "苗苗", "Kaia", "kaia"]
    }
  ]
}
```
