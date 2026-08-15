/**
 * SkyClan Chatroom - Cloudflare Worker (v1.3)
 *
 * Designed to be merged into the existing tpg-hq Worker.
 * All routes are under /chat/* prefix.
 *
 * Schema aligned with TPG HQ `chatroom-member-management.md` v1.3:
 *   - member_id is **8-digit numeric string** (e.g. "10000001")
 *   - mentions in message content use `@<member_id>` syntax (8 digits)
 *   - DM channel: `dm:<member_id>` with 8-digit recipient id
 *
 * Routes:
 *   GET  /chat/health         - 健康检查（无认证）
 *   GET  /chat/members         - 获取成员列表
 *   POST /chat/messages        - 发送消息
 *   GET  /chat/messages        - 拉取消息（since timestamp）
 *   POST /chat/heartbeat       - 更新在线状态
 *   POST /chat/read            - 标记消息已读
 *   GET  /chat/stale-messages   - 查询未回复的 @ 消息（cron 失败人工兜底）
 */

import { authenticate } from './auth.js';
import {
  putMessage,
  getMessages,
  getMember,
  getMemberList,
  updateLastSeen,
  getMemberLastReply,
  MEMBER_ID_RE,
} from './kv.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const MAX_MESSAGE_LENGTH = 2000;
const MAX_MESSAGES_PER_PULL = 50;

/**
 * Chat handler - to be called from tpg-hq Worker's router for /chat/* paths.
 * 
 * Usage in tpg-hq worker.js:
 *   import { handleChat } from './chat/worker.js';
 *   if (url.pathname.startsWith('/chat/')) {
 *     return handleChat(request, env, ctx);
 *   }
 */
export async function handleChat(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    // --- Public routes ---
    if (path === '/chat/health' && method === 'GET') {
      return jsonResponse({ ok: true, timestamp: new Date().toISOString() });
    }

    // --- Authenticated routes ---
    let auth = null;
    if (path.startsWith('/chat/') && path !== '/chat/health') {
      auth = await authenticate(request, env);
      if (!auth.ok) {
        return jsonResponse({ ok: false, error: auth.error }, 401);
      }
    }

    // GET /chat/members
    if (path === '/chat/members' && method === 'GET') {
      const members = await getMemberList(env);
      return jsonResponse({ ok: true, members });
    }

    // POST /chat/messages
    if (path === '/chat/messages' && method === 'POST') {
      const body = await request.json();

      if (!body.content || typeof body.content !== 'string') {
        return jsonResponse({ ok: false, error: 'content is required' }, 400);
      }
      if (body.content.length > MAX_MESSAGE_LENGTH) {
        return jsonResponse({ ok: false, error: `message exceeds ${MAX_MESSAGE_LENGTH} chars` }, 400);
      }

      const channel = body.channel || 'all';
      if (channel !== 'all' && !channel.startsWith('dm:')) {
        return jsonResponse({ ok: false, error: 'invalid channel' }, 400);
      }

      // For DM, verify recipient exists
      if (channel.startsWith('dm:')) {
        const recipientId = channel.slice(3);
        const recipient = await getMember(env, recipientId);
        if (!recipient) {
          return jsonResponse({ ok: false, error: 'recipient not found' }, 404);
        }
      }

      // Always parse mentions from content (server-side resolution).
      // Client may pass explicit mentions, but we also parse to catch @nickname.
      const explicitMentions = Array.isArray(body.mentions) ? body.mentions : [];
      const parsedMentions = await parseMentions(body.content, env);
      const mentions = [...new Set([...explicitMentions, ...parsedMentions])];

      const msg = await putMessage(env, {
        sender: auth.member_id,
        sender_name: auth.display_name,
        channel,
        content: body.content,
        mentions,
      });

      return jsonResponse({ ok: true, msg_id: msg.msg_id, timestamp: msg.timestamp });
    }

    // GET /chat/messages?since_seq=<int>&limit=<n>
    // Backward compat: ?since=<ts> still works (legacy clients)
    if (path === '/chat/messages' && method === 'GET') {
      const since_seq = url.searchParams.get('since_seq') || url.searchParams.get('since') || '0';
      const limit = Math.min(
        parseInt(url.searchParams.get('limit') || String(MAX_MESSAGES_PER_PULL)),
        MAX_MESSAGES_PER_PULL
      );

      const messages = await getMessages(env, since_seq, limit, auth.member_id);
      return jsonResponse({
        ok: true,
        messages,
        has_more: messages.length === limit,
        server_time: new Date().toISOString(),
      });
    }

    // POST /chat/heartbeat
    if (path === '/chat/heartbeat' && method === 'POST') {
      await updateLastSeen(env, auth.member_id);
      return jsonResponse({ ok: true, member_id: auth.member_id });
    }

    // POST /chat/read
    if (path === '/chat/read' && method === 'POST') {
      const body = await request.json();
      if (!body.msg_id) {
        return jsonResponse({ ok: false, error: 'msg_id is required' }, 400);
      }
      // Read tracking is optional in MVP
      return jsonResponse({ ok: true });
    }

    // GET /chat/stale-messages?minutes=<n>
    // 列出「已发送 N 分钟、@提及某个 member 但该 member 还没回复」的消息
    // 用于 cron 失败后人工兜底（admin/IcePaw 巡检用）
    if (path === '/chat/stale-messages' && method === 'GET') {
      const minutes = parseInt(url.searchParams.get('minutes') || '15');
      const targetMember = url.searchParams.get('member_id'); // 可选，过滤某个 member
      const staleMs = minutes * 60 * 1000;
      const thresholdTs = Date.now() - staleMs;

      const allMsgs = await getMessages(env, 0, 100, auth.member_id);
      const stale = [];

      for (const msg of allMsgs) {
        const msgTs = parseInt(msg.msg_id.split('_')[0]) || 0;
        if (msgTs >= thresholdTs) continue; // 不够老

        // 是 @all 或者 @指定的 member
        const mentions = msg.mentions || [];
        const targets = [];
        if (mentions.includes('all')) targets.push('all');
        if (targetMember && mentions.includes(targetMember)) targets.push(targetMember);
        if (!targetMember && mentions.length > 0) {
          for (const m of mentions) if (m !== 'all' && m !== msg.sender) targets.push(m);
        }
        if (targets.length === 0) continue;

        // 检查目标 member 在该消息之后是否发过消息
        const targetLastReply = await getMemberLastReply(env, targets);
        if (targetLastReply && targetLastReply >= msgTs) continue; // 已回复

        stale.push({
          msg_id: msg.msg_id,
          sender: msg.sender,
          sender_name: msg.sender_name,
          content: msg.content.slice(0, 200),
          mentioned_members: targets,
          minutes_ago: Math.round((Date.now() - msgTs) / 60000),
        });
      }

      return jsonResponse({ ok: true, count: stale.length, stale });
    }

    // 404
    return jsonResponse({ ok: false, error: 'not found' }, 404);

  } catch (err) {
    return jsonResponse({ ok: false, error: 'internal error', detail: err.message }, 500);
  }
}

// --- Default export (standalone mode, for testing) ---
export default { fetch: handleChat };

// --- Helpers ---

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

/**
 * Parse @mentions from message content.
 * Supports: @all, @<8-digit-member_id>, @<nickname> (including CJK).
 *
 * Nickname resolution: loads member list from KV, builds nickname→member_id map.
 * Matches case-insensitively for ASCII nicknames (icepaw ≈ IcePaw).
 *
 * Regex: /@([^\s@,，。.!！?？]+)/g
 *   - Captures @ followed by non-whitespace, non-punctuation chars
 *   - Handles CJK: @如意, @冰爪, @小马, @龙井
 *   - Handles ASCII: @icepaw, @IcePaw, @10000002, @all
 */
async function parseMentions(content, env) {
  // Extract raw @tokens from content
  const regex = /@([^\s@,，。.!！?？]+)/g;
  const raw = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    raw.push(match[1]);
  }
  const unique = [...new Set(raw)];

  // Fast path: if no @ at all
  if (unique.length === 0) return [];

  // Build nickname→member_id map from KV member list
  const members = await getMemberList(env);
  const nameToId = new Map();
  for (const m of members) {
    // Chinese nicknames
    if (m.nickname) nameToId.set(m.nickname, m.member_id);
    if (m.display_name && m.display_name !== m.nickname) {
      nameToId.set(m.display_name, m.member_id);
    }
    // ASCII nicknames (case-insensitive)
    if (m.nickname) nameToId.set(m.nickname.toLowerCase(), m.member_id);
    if (m.display_name) nameToId.set(m.display_name.toLowerCase(), m.member_id);
  }

  const resolved = [];
  for (const token of unique) {
    if (token === 'all') {
      resolved.push('all');
    } else if (MEMBER_ID_RE.test(token)) {
      // Already a valid 8-digit member_id
      resolved.push(token);
    } else {
      // Try nickname resolution (case-insensitive for ASCII)
      const id = nameToId.get(token) || nameToId.get(token.toLowerCase());
      if (id) {
        resolved.push(id);
      }
      // Unresolved @tokens are silently skipped
    }
  }

  return resolved;
}
