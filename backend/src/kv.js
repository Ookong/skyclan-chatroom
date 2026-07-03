/**
 * SkyClan Chatroom - KV Storage Module (v1.3)
 *
 * Uses existing TPG_KV namespace with `chatroom:` prefix.
 *
 * Schema aligned with TPG HQ `chatroom-member-management.md` v1.3:
 *   - member_id is **8-digit numeric string** (zero-padded), e.g. "00000001"
 *   - core fields: member_id / api_token / display_name / created_at / last_seen
 *   - token reverse-index: chatroom:token:<api_token> -> member_id
 *   - member list index : chatroom:index:members (JSON array of member_ids)
 *
 * Extra chatroom-only fields retained (not in TPG HQ base schema, but useful
 * for chatroom-specific behaviour and not conflicting):
 *   nickname, role, platform, device, status
 *
 * Key patterns:
 *   chatroom:member:<member_id>     - member profile JSON
 *   chatroom:token:<api_token>      -> member_id (reverse lookup)
 *   chatroom:index:members          - JSON array of member_ids
 *   chatroom:msg:<unix_ms>          - message JSON (7-day TTL)
 *   chatroom:admin:<admin_id>       - admin record
 *   chatroom:index:admins           - JSON array of admin_ids
 */

const PREFIX = 'chatroom:';
const TTL_7DAYS = 604800;

// TPG HQ schema: member_id is exactly 8 ASCII digits (zero-padded).
const MEMBER_ID_RE = /^\d{8}$/;

function assertMemberId(memberId) {
  if (!MEMBER_ID_RE.test(String(memberId))) {
    throw new Error(
      `invalid member_id "${memberId}": must be 8-digit numeric (e.g. "00000001") per TPG HQ schema v1.3`
    );
  }
}

// --- Messages ---

/**
 * Store a new message in KV.
 * TTL: 7 days (604800 seconds).
 *
 * msg_id format: <unix_ms>_<random4> to avoid collision on concurrent sends.
 * Maintains chatroom:index:messages (last 500 entries) for efficient polling.
 */
export async function putMessage(env, { sender, sender_name, channel, content, mentions }) {
  const now = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);
  const msg_id = now + '_' + rand;
  const timestamp = new Date(now).toISOString();

  const msg = {
    msg_id,
    timestamp,
    sender,
    sender_name,
    channel,
    content,
    mentions: mentions || [],
    read_by: [],
  };

  await env.TPG_KV.put(`${PREFIX}msg:${msg_id}`, JSON.stringify(msg), {
    expirationTtl: TTL_7DAYS,
  });

  // Append to message index (keep last 500)
  const idxRaw = await env.TPG_KV.get(`${PREFIX}index:messages`);
  const idx = idxRaw ? JSON.parse(idxRaw) : [];
  idx.push(msg_id);
  if (idx.length > 500) idx.splice(0, idx.length - 500);
  await env.TPG_KV.put(`${PREFIX}index:messages`, JSON.stringify(idx));

  return msg;
}

/**
 * Get messages since a given timestamp.
 * Uses chatroom:index:messages (not KV.list prefix scan) for efficiency.
 * Filters by channel: 'all' messages + DMs involving the requesting member.
 */
export async function getMessages(env, since, limit, member_id) {
  const sinceTs = parseInt(since) || 0;
  const messages = [];

  const idxRaw = await env.TPG_KV.get(`${PREFIX}index:messages`);
  const idx = idxRaw ? JSON.parse(idxRaw) : [];

  for (const msgId of idx) {
    // msg_id format: <unix_ms>_<random4>
    const msgTs = parseInt(msgId.split('_')[0]) || 0;
    if (msgTs <= sinceTs) continue;

    const raw = await env.TPG_KV.get(`${PREFIX}msg:${msgId}`);
    if (!raw) continue;

    const msg = JSON.parse(raw);

    // Filter by channel visibility
    if (msg.channel === 'all') {
      messages.push(msg);
    } else if (msg.channel === `dm:${member_id}` || msg.sender === member_id) {
      messages.push(msg);
    }

    if (messages.length >= limit) break;
  }

  return messages;
}

// --- Members ---

/**
 * Register a new member.
 * Creates member record + token index.
 *
 * member_id MUST be an 8-digit numeric string (TPG HQ schema v1.3).
 * Throws if not.
 */
export async function putMember(env, memberData) {
  const { nickname, display_name, role, platform, device } = memberData;
  const member_id = memberData.member_id;

  assertMemberId(member_id);

  const api_token = memberData.api_token || generateTokenHex();

  const member = {
    member_id,
    nickname,
    display_name: display_name || nickname,
    role: role || 'member',
    platform: platform || 'unknown',
    device: device || 'unknown',
    api_token,
    status: 'active',
    last_seen: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  await env.TPG_KV.put(`${PREFIX}member:${member_id}`, JSON.stringify(member));
  await env.TPG_KV.put(`${PREFIX}token:${api_token}`, member_id);

  // Update member index
  const indexRaw = await env.TPG_KV.get(`${PREFIX}index:members`);
  const index = indexRaw ? JSON.parse(indexRaw) : [];
  if (!index.includes(member_id)) {
    index.push(member_id);
    await env.TPG_KV.put(`${PREFIX}index:members`, JSON.stringify(index));
  }

  return member;
}

/**
 * Get a single member by ID (with token, for internal use).
 */
export async function getMemberRaw(env, member_id) {
  const raw = await env.TPG_KV.get(`${PREFIX}member:${member_id}`);
  if (!raw) return null;
  return JSON.parse(raw);
}

/**
 * Get a single member by ID (without token, for API responses).
 */
export async function getMember(env, member_id) {
  const member = await getMemberRaw(env, member_id);
  if (!member) return null;
  delete member.api_token;
  return member;
}

/**
 * Get all members (without tokens).
 */
export async function getMemberList(env) {
  const indexRaw = await env.TPG_KV.get(`${PREFIX}index:members`);
  const index = indexRaw ? JSON.parse(indexRaw) : [];
  const members = [];

  for (const memberId of index) {
    const member = await getMember(env, memberId);
    if (member) members.push(member);
  }

  return members;
}

/**
 * Update member's last_seen timestamp.
 */
export async function updateLastSeen(env, member_id) {
  const member = await getMemberRaw(env, member_id);
  if (!member) return;

  member.last_seen = new Date().toISOString();
  await env.TPG_KV.put(`${PREFIX}member:${member_id}`, JSON.stringify(member));
}

/**
 * Look up member_id by API token (reverse index).
 */
export async function getMemberByToken(env, token) {
  const memberId = await env.TPG_KV.get(`${PREFIX}token:${token}`);
  return memberId;
}

// --- Helpers ---

function generateTokenHex() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
