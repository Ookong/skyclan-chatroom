#!/usr/bin/env node
'use strict';

/**
 * SkyClan Chatroom - Message Poller (v3 — trigger.script mode)
 *
 * Design change from v2:
 *   - v2: Output ALL messages from others → agent decides what to reply
 *   - v3: ONLY output messages that @me or @all → everything else silently acked
 *
 * This means:
 *   - Empty output (no @me/@all) → cron agent sees nothing → NO_REPLY → zero token waste
 *   - Non-empty output → cron agent knows it must respond
 *   - Two-phase ack simplified: advance last_read for non-actionable messages immediately,
 *     only use .pending for messages that need a reply
 *
 * Called by OpenClaw cron every 2 minutes.
 *
 * Usage:
 *   node skyclan-poll.js                    # normal poll (quiet mode for cron)
 *   node skyclan-poll.js --once             # single poll, verbose output
 *   node skyclan-poll.js --ack              # manually ack pending (for testing)
 *   node skyclan-poll.js --config <path>    # custom config path
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// --- Config ---

// Ack timeout: how long to wait before assuming the previous poll was processed.
// If .pending file is older than this, we ack it (advance last_read).
// Should be > typical agent response time but < cron interval * safety margin.
// Default: 180 seconds (3 min) — aligned with cron timeoutSeconds: 180
// (covers zhipu cold start + 2-3 LLM round-trips + tool exec)
const ACK_TIMEOUT_MS = 180 * 1000;

function loadConfig(configPath) {
  const defaultPath = path.join(__dirname, '..', 'config.json');
  const p = configPath || defaultPath;

  if (!fs.existsSync(p)) {
    console.error(`❌ Config not found: ${p}`);
    process.exit(1);
  }

  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function getStateDir(config) {
  // State files stored alongside config
  const stateDir = path.join(__dirname, '..');
  return stateDir;
}

function getLastRead(stateDir, memberId) {
  const file = path.join(stateDir, '.last-read');
  if (!fs.existsSync(file)) return '0';
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const val = String(data[memberId] || '0');
  // Migration: old format was small integer (server_seq), new format is unix_ms timestamp
  // If val is a small integer (< 1e12), it's legacy server_seq → reset to 0 (fetch all)
  if (!val.includes('_') && parseInt(val) > 0 && parseInt(val) < 1e12) {
    console.error(`[migration] last_read legacy server_seq detected: ${val}, resyncing from 0`);
    return '0';
  }
  return val;
}

function setLastRead(stateDir, memberId, ts) {
  const file = path.join(stateDir, '.last-read');
  let data = {};
  if (fs.existsSync(file)) {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  data[memberId] = String(ts);
  fs.writeFileSync(file, JSON.stringify(data));
}

function getLastHeartbeat(stateDir, memberId) {
  const file = path.join(stateDir, '.heartbeat');
  if (!fs.existsSync(file)) return 0;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return data[memberId] || 0;
}

function setLastHeartbeat(stateDir, memberId) {
  const file = path.join(stateDir, '.heartbeat');
  let data = {};
  if (fs.existsSync(file)) {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  data[memberId] = Date.now();
  fs.writeFileSync(file, JSON.stringify(data));
}

// --- Two-phase ack state ---

function getPendingFile(stateDir, memberId) {
  return path.join(stateDir, `.pending-${memberId}`);
}

function writePending(stateDir, memberId, messages, lastTs) {
  const file = getPendingFile(stateDir, memberId);
  const data = {
    created_at: Date.now(),
    last_ts: String(lastTs),
    msg_count: messages.length,
    // v4.1: keep message payloads so the ack-guard below can redeliver them
    // if the agent run that carried them timed out / died without replying.
    messages,
  };
  fs.writeFileSync(file, JSON.stringify(data));
}

function readPending(stateDir, memberId) {
  const file = getPendingFile(stateDir, memberId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function ackPending(stateDir, memberId) {
  const file = getPendingFile(stateDir, memberId);
  if (fs.existsSync(file)) {
    const pending = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.unlinkSync(file);
    return pending;
  }
  return null;
}

// --- Actionable message formatter (v4.1: shared by Step 5 + ack-guard redelivery) ---

function formatActionable(messages, memberId) {
  const TYPE_ICONS = {
    '请求': '⚡',
    '通知': '📋',
    '讨论': '💬',
    '汇报': '📊',
    '系统': '🔧',
  };
  return messages.map(msg => {
    const target = msg.channel === 'all' ? '@all' : `@me`;
    const time = new Date(parseInt(msg.msg_id)).toLocaleTimeString('zh-CN', { hour12: false });
    const sender = msg.sender_name || msg.sender;
    let typeIcon = '💬';
    const typeMatch = msg.content.match(/^\[([通知请求讨论汇报系统])\]/);
    if (typeMatch) {
      typeIcon = TYPE_ICONS[typeMatch[1]] || '💬';
    }
    const atMe = msg.mentions && msg.mentions.includes(memberId);
    const urgency = atMe ? ' ← @me 需回复' : '';
    return `${typeIcon} ${sender} → ${target}${urgency} (${time})\n${msg.content}`;
  });
}

// --- HTTP ---

// Merged 2026-08-23 (龙井): upstream canonical fix (1596b0c — hard timeout +
// retry, because CF Worker KV latency waves intermittently hang /chat/messages
// with 25s+ hangs and late 401s) + WSL2 hardening from 8/22 field debug:
// force IPv4 (WSL2 IPv6 egress broken → Node AAAA-first hangs), keep default
// ALPN (the old http/1.1 ALPN workaround made hangs consistent), jittered
// exponential backoff for transient edge flaps. Auth/4xx surface immediately.
const REQUEST_TIMEOUT_MS = 15 * 1000; // 15s > known CF cold-start worst case (~8s), still well under the 180s cron budget.
const MAX_RETRIES = 3;                // total attempts per call
const BASE_BACKOFF_MS = 600;

function fetchOnce(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const reqOpts = {
      method: options.method || 'GET',
      headers: options.headers || {},
      family: 4, // WSL2: IPv6 egress broken → Node tries AAAA first and hangs (ETIMEDOUT AggregateError). Force IPv4.
    };
    const req = lib.request(url, reqOpts, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json });
        } catch (e) {
          resolve({ ok: false, status: res.statusCode, json: null, raw: body });
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('request timeout after ' + REQUEST_TIMEOUT_MS + 'ms: ' + url));
    });
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetch(url, options = {}) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fetchOnce(url, options);
    } catch (err) {
      lastErr = err;
      // Only retry transient network errors; surface auth/4xx immediately.
      const transient = err && (
        err.code === 'ETIMEDOUT' ||
        err.code === 'ECONNRESET' ||
        err.code === 'EAI_AGAIN' ||
        err.code === 'ECONNREFUSED' ||
        /timeout/i.test(String(err.message || ''))
      );
      if (!transient) throw err;
      if (attempt < MAX_RETRIES - 1) {
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 200);
        await sleep(backoff);
      }
    }
  }
  throw lastErr || new Error('fetch failed after retries');
}

// Domain fallback chain — 2026-08-24 12:01 龙井 spec（冰爪实现，周三 review）：
//   bases = [api_base, api_base_backup].filter(Boolean)
// 顺序由 config 字段决定，每 host 保留 15s×3 退避（fetch() 负责，见上）。
// 背景：双域名间歇抖动成常态——8/22 thawflow 自定义域挂 / 8/24 workers.dev 挂 3.5h。
// apiCall 只负责按 base 链 failover，per-request 重试由 fetch() 各归其位。
function getApiBases(config) {
  return [config.api_base, config.api_base_backup].filter(Boolean);
}

async function apiCall(config, method, reqPath, body) {
  const headers = {
    'Authorization': `Bearer ${config.api_token}`,
    'Content-Type': 'application/json',
  };
  // Retry (transient errors, exponential backoff) lives inside fetch().
  // apiCall adds domain failover: primary (workers.dev) → fallback (api_base).
  let lastErr;
  const bases = getApiBases(config);
  for (let baseIdx = 0; baseIdx < bases.length; baseIdx++) {
    const base = bases[baseIdx];
    const url = `${base}${reqPath}`;
    try {
      return await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      lastErr = e;
      if (baseIdx < bases.length - 1) {
        console.warn(`[poll] ${base} failed → falling back to ${bases[baseIdx + 1]}`);
      }
    }
  }
  throw lastErr;
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--once') || args.includes('--verbose');
  const ackOnly = args.includes('--ack');
  const configIdx = args.indexOf('--config');
  const configPath = configIdx >= 0 ? args[configIdx + 1] : null;

  const config = loadConfig(configPath);
  const stateDir = getStateDir(config);
  const memberId = config.member_id;

  if (verbose) console.log(`[${new Date().toISOString()}] Polling as ${memberId}...`);

  try {
    // --- Two-phase ack: check previous pending ---
    const pending = readPending(stateDir, memberId);
    if (pending) {
      const pendingAge = Date.now() - pending.created_at;
      if (pendingAge >= ACK_TIMEOUT_MS) {
        // v4.1 ack-guard (2026-08-29 incident: an @me DM was fetched, the agent
        // run timed out at 180s before replying, and the next run force-acked
        // by age alone → message silently lost). Now verify a reply was
        // actually sent before acking; otherwise redeliver, then log loss.
        let replied = null; // true/false = verified; null = network unverifiable
        try {
          const chk = await apiCall(config, 'GET', `/chat/messages?since=${pending.created_at}&limit=50`);
          if (chk.ok) {
            replied = (chk.json.messages || []).some(m => String(m.sender) === String(memberId));
          }
        } catch (_) { /* keep null */ }

        const retries = pending.retries || 0;
        const MAX_REDELIVER = 3;

        if (replied === true) {
          if (verbose) console.log(`   ack pending (reply verified, age: ${Math.round(pendingAge / 1000)}s)`);
          ackPending(stateDir, memberId);
          setLastRead(stateDir, memberId, pending.last_ts);
        } else if (replied === false && Array.isArray(pending.messages) && retries < MAX_REDELIVER) {
          // No reply from me since delivery → agent likely died mid-turn. Redeliver.
          pending.retries = retries + 1;
          pending.created_at = Date.now();
          fs.writeFileSync(getPendingFile(stateDir, memberId), JSON.stringify(pending));
          console.log(`⚠️ 上轮消息未确认回复（agent 可能超时被杀），第 ${retries + 1}/${MAX_REDELIVER} 次重投递——以下消息仍需处理：\n`);
          console.log(formatActionable(pending.messages, memberId).join('\n\n'));
          process.exit(0);
        } else if (replied === false) {
          // Redelivery exhausted, or legacy pending without payloads → ack,
          // but leave an auditable trail and surface the loss loudly.
          try {
            fs.appendFileSync(path.join(stateDir, `.lost-${memberId}`),
              JSON.stringify({ at: new Date().toISOString(), reason: Array.isArray(pending.messages) ? 'redeliver-exhausted' : 'legacy-no-payload', last_ts: pending.last_ts, messages: pending.messages || null }) + '\n');
          } catch (_) { /* non-fatal */ }
          if (Array.isArray(pending.messages)) {
            console.log(`⚠️ LOST: 重投递 ${MAX_REDELIVER} 次仍无回复，以下消息按已读 ack（已记 .lost-${memberId}）——如仍需回复请立即处理：\n`);
            console.log(formatActionable(pending.messages, memberId).join('\n\n'));
          } else {
            if (verbose) console.log(`   ack pending (legacy no-payload, age: ${Math.round(pendingAge / 1000)}s)`);
          }
          ackPending(stateDir, memberId);
          setLastRead(stateDir, memberId, pending.last_ts);
        } else {
          // replied === null: network unverifiable → never swallow; retry next round
          if (verbose) console.log(`   ⏳ ack guard: network unverifiable, pending kept for next round`);
          process.exit(0);
        }
      } else {
        // Previous poll might still be processing → skip this round
        if (verbose) console.log(`   ⏳ pending not yet acked (age: ${Math.round(pendingAge / 1000)}s < ${ACK_TIMEOUT_MS / 1000}s), skipping poll`);
        process.exit(0);
      }
    }

    // Manual ack mode (for testing)
    if (ackOnly) {
      console.log('✅ ack completed');
      process.exit(0);
    }

    // Step 0: Throttled heartbeat — update last_seen every 30 min max
    const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
    const lastHb = getLastHeartbeat(stateDir, memberId);
    if (Date.now() - lastHb >= HEARTBEAT_INTERVAL_MS) {
      try {
        const hbRes = await apiCall(config, 'POST', '/chat/heartbeat');
        if (hbRes.ok) {
          setLastHeartbeat(stateDir, memberId);
          if (verbose) console.log('   heartbeat sent ✅');
        }
      } catch (_) { /* non-fatal */ }
    }

    // Step 1: Pull messages (v4.0: using timestamp-based filtering)
    const since_ts = getLastRead(stateDir, memberId);
    const limit = Math.min(config.max_messages_per_poll || 50, 20);
    const msgRes = await apiCall(config, 'GET', `/chat/messages?since=${since_ts}&limit=${limit}`);

    if (!msgRes.ok) {
      if (verbose) console.error(`❌ poll failed: ${msgRes.status}`);
      if (msgRes.status === 401) {
        console.error('❌ Authentication failed - check API token');
      }
      process.exit(1);
    }

    const messages = msgRes.json.messages || [];

    // Sort by msg_id (unix_ms timestamp prefix) ascending — don't rely on server_seq
    messages.sort((a, b) => {
      const tsA = parseInt(a.msg_id) || 0;
      const tsB = parseInt(b.msg_id) || 0;
      return tsA - tsB;
    });

    if (messages.length === 0) {
      if (verbose) console.log('✅ poll: 0 new messages');
      process.exit(0);
    }

    // Step 2: Filter messages from others (not my own)
    const fromOthers = messages.filter(msg => String(msg.sender) !== String(memberId));

    // Compute last_read: use max msg_id timestamp across ALL messages
    const maxTs = messages.reduce((mx, m) => {
      const ts = parseInt(m.msg_id) || 0;
      return (ts > mx) ? ts : mx;
    }, 0);
    const lastVal = maxTs > 0 ? String(maxTs) : since_ts;

    if (fromOthers.length === 0) {
      // Only my own messages - advance last_read immediately
      setLastRead(stateDir, memberId, lastVal);
      if (verbose) console.log('✅ poll: only own messages, acked silently');
      process.exit(0);
    }

    // Step 3 (v3 core change): Split messages into actionable vs informational
    //   actionable = @me or @all → needs reply, use two-phase ack
    //   informational = everything else → silently advance last_read
    const actionable = fromOthers.filter(msg => {
      const atMe = msg.mentions && msg.mentions.includes(memberId);
      const atAll = msg.mentions && msg.mentions.includes('all');
      const isDM = msg.channel === `dm:${memberId}`;
      // @me, @all, or DM to me → actionable
      return atMe || atAll || isDM;
    });

    if (actionable.length === 0) {
      // No messages need my reply - advance last_read immediately
      setLastRead(stateDir, memberId, lastVal);
      if (verbose) console.log(`✅ poll: ${fromOthers.length} messages (none @me/@all), acked silently`);
      process.exit(0);
    }

    // Step 4: Write pending for actionable messages (two-phase ack)
    writePending(stateDir, memberId, actionable, lastVal);

    // Step 5: Output ONLY actionable messages as categorized chat bubbles
    const lines = formatActionable(actionable, memberId);

    // Output to stdout (cron captures this)
    console.log(lines.join('\n\n'));

    if (verbose) console.log(`\n✅ poll: ${actionable.length} actionable messages (pending ack in ${ACK_TIMEOUT_MS / 1000}s)`);

  } catch (err) {
    console.error(`❌ poll error: ${err.message}`);
    process.exit(1);
  }
}

main();
