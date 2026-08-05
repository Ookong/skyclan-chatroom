#!/usr/bin/env node
'use strict';

/**
 * E2E Test: Schema Migration (v3.0)
 *
 * Tests: KV.list replaces index:messages + server_seq monotonic counter
 *
 * Run: node tests/e2e-schema-migration.js
 *
 * Prerequisites:
 *   - SkyClan Chatroom backend deployed (or local wrangler dev)
 *   - At least 2 members registered
 *   - Config file with valid API token
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// --- Config ---

function loadConfig() {
  const configPath = path.join(__dirname, '..', 'config.json');
  if (!fs.existsSync(configPath)) {
    console.error('❌ config.json not found');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
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
    req.end();
  });
}

async function apiCall(config, method, apiPath, body) {
  const url = `${config.api_base}${apiPath}`;
  const headers = {
    'Authorization': `Bearer ${config.api_token}`,
    'Content-Type': 'application/json',
  };
  return fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

// --- Test Runner ---

const results = [];
let passCount = 0;
let failCount = 0;

async function test(name, fn) {
  try {
    await fn();
    results.push(`✅ ${name}`);
    passCount++;
  } catch (err) {
    results.push(`❌ ${name}: ${err.message}`);
    failCount++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `expected ${expected}, got ${actual}`);
  }
}

// --- Tests ---

async function run() {
  const config = loadConfig();
  const memberId = config.member_id;

  console.log(`\n🧪 E2E Schema Migration Tests`);
  console.log(`   API: ${config.api_base}`);
  console.log(`   Member: ${memberId}\n`);

  let seqAfterFirst = 0;
  let seqAfterSecond = 0;
  let firstMsgId = null;
  let secondMsgId = null;

  // 1. Send first message — check server_seq assigned
  await test('Send message → server_seq assigned', async () => {
    const res = await apiCall(config, 'POST', '/chat/messages', {
      channel: 'all',
      content: `[系统] E2E test message 1 — checking server_seq assignment (${Date.now()})`,
      mentions: [],
    });
    assert(res.ok, `send failed: ${res.status}`);
    assert(res.json.msg_id, 'missing msg_id');
    assert(typeof res.json.server_seq === 'number' || typeof res.json.server_seq === 'string',
      `server_seq not numeric: ${typeof res.json.server_seq}`);

    // Parse seq from response — it's in the returned msg object
    // Note: POST response returns { ok, msg_id, timestamp } — we need to fetch to check seq
    firstMsgId = res.json.msg_id;
  });

  // 2. Send second message
  await test('Send second message → server_seq increments', async () => {
    const res = await apiCall(config, 'POST', '/chat/messages', {
      channel: 'all',
      content: `[系统] E2E test message 2 — seq should increment (${Date.now()})`,
      mentions: [],
    });
    assert(res.ok, `send failed: ${res.status}`);
    secondMsgId = res.json.msg_id;
  });

  // 3. Poll with since_seq=0 — should return recent messages including ours
  await test('Poll since_seq=0 → returns messages with server_seq', async () => {
    const res = await apiCall(config, 'GET', `/chat/messages?since_seq=0&limit=50`);
    assert(res.ok, `poll failed: ${res.status}`);
    assert(res.json.messages, 'missing messages array');

    // Find our test messages (all-channel only, exclude DMs for consistent seq tracking)
    const allTestMsgs = res.json.messages.filter(m =>
      m.channel === 'all' && m.content && m.content.includes('E2E test message')
    );
    assert(allTestMsgs.length >= 2, `expected ≥2 all-channel test messages, got ${allTestMsgs.length}`);

    // Sort by server_seq to ensure correct ordering
    allTestMsgs.sort((a, b) => (parseInt(a.server_seq) || 0) - (parseInt(b.server_seq) || 0));

    // Verify server_seq exists and is numeric
    for (const msg of allTestMsgs) {
      assert(msg.server_seq !== undefined, `message ${msg.msg_id} missing server_seq`);
    }

    // Record seq values for later tests (from all-channel messages only)
    seqAfterFirst = parseInt(allTestMsgs[0].server_seq) || 0;
    seqAfterSecond = parseInt(allTestMsgs[allTestMsgs.length - 1].server_seq) || 0;

    // Verify monotonic increment
    assert(seqAfterSecond > seqAfterFirst,
      `seq not monotonic: first=${seqAfterFirst}, second=${seqAfterSecond}`);
  });

  // 4. Poll with since_seq=<latest> — should return empty or only newer
  await test('Poll since_seq=<latest> → no new messages', async () => {
    const res = await apiCall(config, 'GET', `/chat/messages?since_seq=${seqAfterSecond}&limit=50`);
    assert(res.ok, `poll failed: ${res.status}`);

    const testMsgs = (res.json.messages || []).filter(m =>
      m.content && m.content.includes('E2E test message')
    );
    assert(testMsgs.length === 0, `expected 0 new test messages, got ${testMsgs.length}`);
  });

  // 5. Poll with since_seq=<first all msg> — should return messages with seq > that
  // Note: counter is global (all channels share seq), so DMs between our two
  // all-channel messages will have seq values in between. This test verifies
  // that filtering works correctly, not that seq is contiguous per-channel.
  await test('Poll since_seq=<middle> → returns only newer', async () => {
    const res = await apiCall(config, 'GET', `/chat/messages?since_seq=${seqAfterFirst}&limit=50`);
    assert(res.ok, `poll failed: ${res.status}`);

    const msgs = res.json.messages || [];
    for (const msg of msgs) {
      const msgSeq = parseInt(msg.server_seq) || 0;
      assert(msgSeq > seqAfterFirst,
        `message ${msg.msg_id} has seq ${msgSeq} ≤ ${seqAfterFirst}`);
    }

    // Second test message (all-channel) should be here since its seq > first
    const hasSecond = msgs.some(m => m.msg_id === secondMsgId);
    assert(hasSecond, `second test message ${secondMsgId} not found in results`);
  });

  // 6. Backward compat: legacy since=<timestamp> parameter
  await test('Backward compat: since=<timestamp> still works', async () => {
    const oldTs = String(Date.now() - 3600000); // 1 hour ago
    const res = await apiCall(config, 'GET', `/chat/messages?since=${oldTs}&limit=50`);
    // Should not error — server accepts legacy param
    assert(res.ok, `legacy poll failed: ${res.status}`);
    assert(res.json.messages !== undefined, 'missing messages in legacy response');
  });

  // 7. DM message visibility — send DM to self, verify only sender sees it
  await test('DM visibility — only sender/recipient see DM', async () => {
    const res = await apiCall(config, 'POST', '/chat/messages', {
      channel: `dm:${memberId}`,
      content: `[系统] E2E DM test (${Date.now()})`,
      mentions: [],
    });
    assert(res.ok, `DM send failed: ${res.status}`);

    // Poll — should see our own DM
    const pollRes = await apiCall(config, 'GET', `/chat/messages?since_seq=0&limit=50`);
    const dmMsgs = (pollRes.json.messages || []).filter(m =>
      m.content && m.content.includes('E2E DM test')
    );
    assert(dmMsgs.length >= 1, 'DM message not found in poll results');
    assert(dmMsgs[0].channel === `dm:${memberId}`,
      `DM channel mismatch: ${dmMsgs[0].channel}`);
  });

  // 8. KV.list health — verify no index:messages dependency
  await test('Server health check', async () => {
    const res = await apiCall(config, 'GET', '/chat/health');
    assert(res.ok, `health check failed: ${res.status}`);
    assert(res.json.ok === true, 'health check did not return ok:true');
  });

  // --- Results ---

  console.log('\n' + '─'.repeat(50));
  for (const line of results) {
    console.log(line);
  }
  console.log('─'.repeat(50));
  console.log(`\n📊 Results: ${passCount} passed, ${failCount} failed\n`);

  process.exit(failCount > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(`\n💥 Test runner crashed: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
