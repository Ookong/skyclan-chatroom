/**
 * SkyClan Chatroom - KV Storage Module (v3.0)
 *
 * Changes from v1.3:
 *   - Removed chatroom:index:messages JSON array (concurrent-write risk)
 *   - Added chatroom:counter:seq for monotonic server_seq assignment
 *   - getMessages now uses KV.list prefix scan + server_seq filtering
 *   - Message key unchanged: chatroom:msg:<unix_ms>_<rand4>
 *   - Backward compat: since=<timestamp> still works alongside since_seq=<int>
 *   - Exported MEMBER_ID_RE for use in worker.js mention parsing
 *
 * Uses existing TPG_KV namespace with `chatroom:` prefix.
 *
 * Key patterns:
 *   chatroom:msg:<msg_id>          - message JSON (7-day TTL)
 *   chatroom:counter:seq           - monotonic counter (next seq to assign)
 *   chatroom:member:<member_id>     - member profile JSON
 *   chatroom:token:<api_token>      -> member_id (reverse lookup)
 *   chatroom:index:members          - JSON array of member_ids
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
      `invalid member_id "${memberId}": must be 8-digit numeric (e.g. "10000001") per TPG HQ schema v1.3`
    );
  }
}

export { MEMBER_ID_RE };

// --- Messages ---

/**
 * Get the next monotonic server_seq.
 *
 * Race condition note (MVP — Option A):
 *   KV has no atomic INCR. Two concurrent putMessage calls might read the
 *   same counter value and get the same seq. Dedup safety net: msg_id remains
 *   unique (timestamp + random). Client treats duplicate seq as "already seen".
 *   Acceptable for 0.04 QPS (1 message per 25 seconds average).
 */
async function getNextSeq(env) {
  const current = await env.TPG_KV.get(`${PREFIX}counter:seq`);
  const next = (parseInt(current) || 0) + 1;
  await env.TPG_KV.put(`${PREFIX}counter:seq`, String(next));
  return next;
}

/**
 * Store a new message in KV.
 * TTL: 7 days (604800 seconds).
 *
 * msg_id format: <unix_ms>_<random4> — unique, used as KV key.
 * server_seq: monotonic integer assigned at write time.
 *
 * No longer maintains chatroom:index:messages — KV.list prefix scan replaces it.
 */
export async function putMessage(env, { sender, sender_name, channel, content, mentions }) {
  const now = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);
  const msg_id = now + '_' + rand;
  const timestamp = new Date(now).toISOString();

  // Assign monotonic seq (see race condition note above)
  const server_seq = await getNextSeq(env);

  const msg = {
    msg_id,
    server_seq,
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
 * Get messages since a given server_seq.
 *
 * Uses KV.list prefix scan (replaces old chatroom:index:messages JSON array).
 * KV.list returns keys sorted lexicographically; since our keys are
 * <unix_ms>_<rand4>, they are naturally time-ordered.
 *
 * Filters by channel: 'all' messages + DMs involving the requesting member.
 *
 * Backward compat: if since_seq is 0 or absent, returns all messages
 * (for legacy clients that haven't migrated yet).
 */
export async function getMessages(env, since_seq, limit, member_id) {
  const sinceSeq = parseInt(since_seq) || 0;
  const messages = [];

  // KV.list prefix scan — one call, no manual index needed
  const list = await env.TPG_KV.list({
    prefix: `${PREFIX}msg:`,
    limit: 500,
  });

  // Iterate newest-first (avoid slice().reverse() copy)
  const keys = list.keys;

  for (let i = keys.length - 1; i >= 0; i--) {
    const raw = await env.TPG_KV.get(keys[i].name);
    if (!raw) continue;

    const msg = JSON.parse(raw);

    // Filter by server_seq (skip messages at or below the threshold)
    // Old messages without server_seq are treated as seq=0
    const msgSeq = msg.server_seq || 0;
    if (msgSeq <= sinceSeq) continue;

    // Filter by channel visibility
    if (msg.channel === 'all') {
      messages.unshift(msg); // prepend for chronological order
    } else if (msg.channel === `dm:${member_id}` || msg.sender === member_id) {
      messages.unshift(msg);
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

/**
 * Get the timestamp of the last message sent by any of the given members.
 * Used by /chat/stale-messages to check if a member replied after a @mention.
 * Returns max unix_ms of any of the listed members' sent messages, or null.
 */
export async function getMemberLastReply(env, memberIds) {
  const ids = Array.isArray(memberIds) ? memberIds : [memberIds];
  if (ids.length === 0) return null;

  const list = await env.TPG_KV.list({ prefix: `${PREFIX}msg:`, limit: 500 });
  let maxTs = null;

  // Iterate newest-first
  for (let i = list.keys.length - 1; i >= 0; i--) {
    const raw = await env.TPG_KV.get(list.keys[i].name);
    if (!raw) continue;
    let msg;
    try { msg = JSON.parse(raw); } catch { continue; }
    if (!ids.includes(msg.sender)) continue;
    const ts = parseInt(msg.msg_id.split('_')[0]) || 0;
    if (ts > 0 && (maxTs === null || ts > maxTs)) {
      maxTs = ts;
    }
  }
  return maxTs;
}

// --- Helpers ---

function generateTokenHex() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
