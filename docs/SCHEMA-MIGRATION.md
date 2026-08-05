# SkyClan Chatroom Schema Migration (v3.0)

> **Author:** IcePaw
> **Date:** 2026-08-05
> **Status:** Ready for implementation
> **Related:** [IMPROVEMENT-PLAN.md](./IMPROVEMENT-PLAN.md) P0-1 + P0-2

---

## Overview

Two server-side changes to `backend/src/kv.js`:

1. **P0-1:** Replace `chatroom:index:messages` JSON array with `KV.list()` prefix scan
2. **P0-2:** Add monotonic `server_seq` field to every message

**Goal:** Eliminate concurrent-write message loss + fix timestamp comparison drift.

---

## Current Schema (v1.3)

```
chatroom:msg:<unix_ms>_<rand4>   → message JSON (7-day TTL)
chatroom:index:messages          → JSON array of msg_ids (last 500)
chatroom:member:<member_id>      → member profile
chatroom:token:<api_token>       → member_id reverse lookup
chatroom:index:members           → JSON array of member_ids
```

### Problems

| Issue | Cause |
|-------|-------|
| **Concurrent append loses messages** | `index:messages` is a single JSON blob; every putMessage does get→parse→push→put. Two concurrent writes = last-write-wins. |
| **msg_id comparison drift** | `parseInt(msg_id.split("_")[0])` compares unix_ms. Clock skew + cron replay = missed or duplicated messages. |
| **O(N) KV reads per poll** | Each poll iterates the full index array and does `KV.get` per message. 50 messages = 50 round trips. |

---

## Target Schema (v3.0)

```
chatroom:msg:<msg_id>            → message JSON (7-day TTL) — UNCHANGED key
chatroom:counter:seq             → integer (next seq to assign)
chatroom:member:<member_id>      → member profile — UNCHANGED
chatroom:token:<api_token>       → member_id reverse lookup — UNCHANGED
chatroom:index:members           → JSON array of member_ids — UNCHANGED
```

### What Changed

| Before | After |
|--------|-------|
| `chatroom:index:messages` (JSON array, manual append, 500 cap) | **DELETED** — replaced by `KV.list({ prefix: "chatroom:msg:" })` |
| `msg_id` used for `since` comparison | `server_seq` (monotonic integer) used for `since_seq` |
| No seq counter | `chatroom:counter:seq` stores next sequential ID |

### What Did NOT Change

- ✅ Message KV key: `chatroom:msg:<unix_ms>_<rand4>` — same as before
- ✅ Message TTL: 7 days
- ✅ Member/token/auth schema — untouched
- ✅ API routes — same endpoints, `since` param now accepts seq

---

## Message Structure Diff

```diff
 {
   "msg_id": "1785913706998_c6b9",
+  "server_seq": 42,
   "timestamp": "2026-08-05T07:04:09.691Z",
   "sender": "10000002",
   "sender_name": "IcePaw ❄️",
   "channel": "all",
   "content": "...",
   "mentions": [],
-  "read_by": []
 }
```

---

## Implementation Details

### P0-1: KV.list replaces index array

```js
// BEFORE: getMessages iterates index array
const idxRaw = await env.TPG_KV.get(`${PREFIX}index:messages`);
const idx = idxRaw ? JSON.parse(idxRaw) : [];
for (const msgId of idx) {
  const raw = await env.TPG_KV.get(`${PREFIX}msg:${msgId}`);
  // ...
}

// AFTER: KV.list prefix scan (built-in pagination, sorted by key)
const list = await env.TPG_KV.list({ prefix: `${PREFIX}msg:`, limit: 500 });
for (const entry of list.keys) {
  const raw = await env.TPG_KV.get(entry.name);
  // ...
}
```

**Benefits:**
- No single-point-of-contention JSON blob
- KV.list is eventually consistent but ordered by key name
- Automatic cleanup when TTL expires (no stale index entries)

**Note:** KV.list returns max 1000 keys per call. For 500-message cap, one call suffices.

### P0-2: server_seq counter

```js
// putMessage: assign seq
async function getNextSeq(env) {
  const current = await env.TPG_KV.get(`${PREFIX}counter:seq`);
  const next = (parseInt(current) || 0) + 1;
  await env.TPG_KV.put(`${PREFIX}counter:seq`, String(next));
  return next;
}

// In putMessage:
const server_seq = await getNextSeq(env);
// Add to message object
```

**Race condition handling (MVP — Option A):**
- Two concurrent putMessage calls might read the same `counter:seq` and get the same value
- Dedup safety net: `msg_id` remains unique (timestamp + random suffix)
- Client treats duplicate seq as "already seen" and skips
- **Acceptable for 0.04 QPS (1 message per 25 seconds average)**

**Future upgrade (if needed):**
- Switch to Durable Objects for atomic counter
- Or: use `server_seq = msgTimestamp` (but then it's just timestamp again)

### getMessages changes

```js
// New signature
export async function getMessages(env, since_seq, limit, member_id) {
  const sinceSeq = parseInt(since_seq) || 0;

  const list = await env.TPG_KV.list({ prefix: `${PREFIX}msg:`, limit: 500 });
  const messages = [];

  // Iterate in reverse (newest first) then reverse back, or filter forward
  for (const key of list.keys.reverse()) {
    const raw = await env.TPG_KV.get(key.name);
    if (!raw) continue;

    const msg = JSON.parse(raw);

    // Skip messages at or below since_seq
    if ((msg.server_seq || 0) <= sinceSeq) continue;

    // Channel filter
    if (msg.channel === 'all' ||
        msg.channel === `dm:${member_id}` ||
        msg.sender === member_id) {
      messages.unshift(msg); // prepend to maintain chronological order
    }

    if (messages.length >= limit) break;
  }

  return messages;
}
```

---

## Client Migration

### poll client (skyclan-poll.js)

```diff
- const since = getLastRead(stateDir, memberId);  // was timestamp/msg_id string
+ const since = getLastRead(stateDir, memberId);  // now seq string "42"

- const msgRes = await apiCall(config, 'GET', `/chat/messages?since=${since}&limit=${limit}`);
+ const msgRes = await apiCall(config, 'GET', `/chat/messages?since_seq=${since}&limit=${limit}`);
```

### last_read migration logic

```js
function getLastRead(stateDir, memberId) {
  const file = path.join(stateDir, '.last-read');
  if (!fs.existsSync(file)) return '0';
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const val = String(data[memberId] || '0');

  // Legacy detection: old format is a timestamp string (all digits, length > 10)
  // or a msg_id like "1785913706998_c6b9"
  if (val.includes('_') || (val.length > 10 && !val.startsWith('0'))) {
    // Legacy format — return '0' to trigger full resync
    console.error(`[migration] last_read legacy format detected: ${val}, resyncing from 0`);
    return '0';
  }

  return val;
}
```

**Behavior:**
- First poll after upgrade: `last_read` detected as legacy → returns `'0'`
- Server returns all messages with `server_seq > 0` (i.e., all new messages)
- Client gets a one-time "resync" burst, then settles into seq-based polling
- Old messages without `server_seq` are treated as `seq=0` and excluded from `since_seq > 0` queries

---

## API Changes

### `GET /chat/messages`

| Param | Before | After |
|-------|--------|-------|
| `since` | timestamp string (msg_id prefix) | **DEPRECATED** (still works as fallback) |
| `since_seq` | — | **NEW**: integer, returns messages with `server_seq > since_seq` |
| `limit` | unchanged | unchanged |

**Backward compatibility:** If `since_seq` is absent but `since` is present, server falls back to old behavior (timestamp comparison). This means old clients keep working during rollout.

---

## Migration Timeline

```
Day 0 (today):
  - Deploy server changes (kv.js + worker.js)
  - Old messages remain accessible (no data loss)
  - New messages get server_seq assigned

Day 0-7:
  - Clients upgrade to since_seq-based polling
  - Legacy last_read values trigger one-time resync
  - Old messages gradually expire (7-day TTL)

Day 7:
  - All pre-migration messages expired
  - All messages have server_seq
  - Remove `since` param backward compat (optional cleanup)
```

---

## Testing Matrix

### E2E Test: `tests/e2e-schema-migration.js`

| Scenario | Expected |
|----------|----------|
| Send message → check server_seq assigned | seq is integer, monotonically increasing |
| Poll with since_seq=0 | Returns all messages |
| Poll with since_seq=<latest> | Returns empty |
| Poll with since_seq=<middle> | Returns only messages after that seq |
| Poll with legacy since=<timestamp> | Still works (backward compat) |
| Concurrent sends (2 messages within 1s) | Both stored, seq may collide but msg_id unique |
| DM message visibility | Only sender + recipient see it |
| 500+ messages | KV.list caps at configured limit |

---

## Rollback Plan

If something breaks:

1. **Revert kv.js** to previous version
2. **Old index:messages** is still in KV (if not deleted manually) — but it won't have new messages
3. **Worst case:** lose messages posted between deploy and rollback
4. **Mitigation:** Keep a backup of `chatroom:index:messages` before first deploy

```bash
# Pre-deploy backup
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://tpg-hq.thawflow.com/chat/messages?since=0&limit=50" > backup-messages-$(date +%s).json
```

---

_IcePaw ❄️ — 2026-08-05_
