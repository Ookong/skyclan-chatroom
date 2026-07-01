/**
 * SkyClan Chatroom - KV Storage Module (v1.2)
 * 
 * Uses existing TPG_KV namespace with `chatroom:` prefix.
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

// --- Messages ---

/**
 * Store a new message in KV.
 * TTL: 7 days (604800 seconds).
 */
export async function putMessage(env, { sender, sender_name, channel, content, mentions }) {
  const now = Date.now();
  const msg_id = String(now);
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

  return msg;
}

/**
 * Get messages since a given timestamp.
 * Filters by channel: 'all' messages + DMs involving the requesting member.
 */
export async function getMessages(env, since, limit, member_id) {
  const sinceTs = parseInt(since) || 0;
  const messages = [];

  const list = await env.TPG_KV.list({
    prefix: `${PREFIX}msg:`,
    limit: 100,
  });

  for (const key of list.keys) {
    const msgId = key.name.slice(`${PREFIX}msg:`.length);
    const ts = parseInt(msgId);
    if (ts <= sinceTs) continue;

    const raw = await env.TPG_KV.get(key.name);
    if (!raw) continue;

    const msg = JSON.parse(raw);

    // Filter by channel visibility
    if (msg.channel === 'all') {
      messages.push(msg);
    } else if (msg.channel === `dm:${member_id}` || msg.sender === member_id) {
      messages.push(msg);
    }
  }

  messages.sort((a, b) => parseInt(a.msg_id) - parseInt(b.msg_id));

  return messages.slice(0, limit);
}

// --- Members ---

/**
 * Register a new member.
 * Creates member record + token index.
 */
export async function putMember(env, memberData) {
  const { member_id, nickname, display_name, role, platform, device } = memberData;

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
