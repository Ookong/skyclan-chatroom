/**
 * SkyClan Chatroom - Authentication Module (v1.3)
 *
 * Uses TPG_KV with `chatroom:` prefix.
 *
 * Schema aligned with TPG HQ `chatroom-member-management.md` v1.3:
 *   - member_id is **8-digit numeric string** (e.g. "00000001")
 *   - the resolve path still goes token -> member_id (format-agnostic)
 *
 * Scheme A (MVP): API Token (Bearer)
 * Scheme B (Phase 2): SSH Signature
 */

import { getMemberRaw, getMemberByToken } from './kv.js';

/**
 * Authenticate request via Bearer token.
 * 
 * @param {Request} request
 * @param {Object} env - Cloudflare env with TPG_KV binding
 * @returns {Promise<{ok: boolean, member_id?: string, display_name?: string, error?: string}>}
 */
export async function authenticate(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, error: 'missing or invalid Authorization header' };
  }

  const token = authHeader.slice(7);
  if (!token || token.length < 16) {
    return { ok: false, error: 'invalid token format' };
  }

  // Look up member by token reverse index
  const memberId = await getMemberByToken(env, token);
  if (!memberId) {
    return { ok: false, error: 'invalid token' };
  }

  const member = await getMemberRaw(env, memberId);
  if (!member) {
    return { ok: false, error: 'member not found' };
  }

  if (member.status !== 'active') {
    return { ok: false, error: 'member inactive' };
  }

  if (member.api_token !== token) {
    return { ok: false, error: 'token mismatch' };
  }

  return {
    ok: true,
    member_id: member.member_id,
    display_name: member.display_name || member.nickname,
  };
}

/**
 * Generate a random API token (32 bytes hex).
 */
export function generateToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
