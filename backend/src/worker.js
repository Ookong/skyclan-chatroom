/**
 * SkyClan Chatroom - Cloudflare Worker (v1.3)
 *
 * Designed to be merged into the existing tpg-hq Worker.
 * All routes are under /chat/* prefix.
 *
 * Schema aligned with TPG HQ `chatroom-member-management.md` v1.3:
 *   - member_id is **8-digit numeric string** (e.g. "00000001")
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
 */

import { authenticate } from './auth.js';
import {
  putMessage,
  getMessages,
  getMember,
  getMemberList,
  updateLastSeen,
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

      const mentions = body.mentions || parseMentions(body.content);

      const msg = await putMessage(env, {
        sender: auth.member_id,
        sender_name: auth.display_name,
        channel,
        content: body.content,
        mentions,
      });

      return jsonResponse({ ok: true, msg_id: msg.msg_id, timestamp: msg.timestamp });
    }

    // GET /chat/messages?since=<ts>&limit=<n>
    if (path === '/chat/messages' && method === 'GET') {
      const since = url.searchParams.get('since') || '0';
      const limit = Math.min(
        parseInt(url.searchParams.get('limit') || String(MAX_MESSAGES_PER_PULL)),
        MAX_MESSAGES_PER_PULL
      );

      const messages = await getMessages(env, since, limit, auth.member_id);
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
 * Supports @all, @<member_id> (8-digit numeric), @<nickname>.
 *
 * TPG HQ v1.3: prefer @<member_id> (8 digits, e.g. @00000001) for
 * deterministic routing; nickname mentions are best-effort and require
 * the client side to resolve them via display_name -> member_id.
 */
function parseMentions(content) {
  const mentions = [];
  const regex = /@(\w+)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    mentions.push(match[1]);
  }
  return [...new Set(mentions)];
}
