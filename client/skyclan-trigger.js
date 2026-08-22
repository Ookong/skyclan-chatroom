#!/usr/bin/env node
'use strict';

/**
 * SkyClan Chatroom — trigger script for cron pre-check
 *
 * Queries the API for new messages since last_read.
 * Returns { fire: true } only if there are @me/@all/DM messages.
 * Otherwise returns { fire: false } → cron skips the agentTurn entirely (zero token cost).
 *
 * Output format: JSON on stdout: { "fire": true } or { "fire": false }
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const STATE_DIR = path.join(__dirname, '..');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log(JSON.stringify({ fire: false }));
    process.exit(0);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function getLastRead(memberId) {
  const file = path.join(STATE_DIR, '.last-read');
  if (!fs.existsSync(file)) return '0';
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const val = String(data[memberId] || '0');
    if (!val.includes('_') && parseInt(val) > 0 && parseInt(val) < 1e12) return '0';
    return val;
  } catch {
    return '0';
  }
}

function checkPending(memberId) {
  const file = path.join(STATE_DIR, `.pending-${memberId}`);
  if (!fs.existsSync(file)) return false;
  try {
    const pending = JSON.parse(fs.readFileSync(file, 'utf8'));
    const age = Date.now() - pending.created_at;
    if (age < 90 * 1000) return true;
    return false;
  } catch {
    return false;
  }
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.request(url, { method: 'GET', timeout: 8000, family: 4 }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// Domain fallback chain — primary first (workers.dev, default), fallback to api_base (thawflow.com).
// Background: 2026-08-22 复测确认 workers.dev 稳定、thawflow.com 自定义域间歇超时（HTTP:000 / curl28 timeout）。
// config.json 里现有的 api_base 字段继续作 fallback URL 来源，不需要新增字段。
// 高级用户可在 config 里覆盖 primary_api_base（默认 https://tpg-hq.icepaw.workers.dev）。
const DEFAULT_PRIMARY_API_BASE = 'https://tpg-hq.icepaw.workers.dev';

function getApiBases(config) {
  const primary = config.primary_api_base || DEFAULT_PRIMARY_API_BASE;
  const fallback = config.api_base;
  const chain = [primary];
  if (fallback && fallback !== primary) chain.push(fallback);
  return chain;
}

// Try each base in order; resolve with first non-null JSON body (i.e. server actually responded).
// On network error / timeout / null body → fall through to next base.
async function fetchWithFallback(config, reqPath) {
  const bases = getApiBases(config);
  let lastResult = null;
  for (let baseIdx = 0; baseIdx < bases.length; baseIdx++) {
    const url = `${bases[baseIdx]}${reqPath}`;
    try {
      const result = await fetchUrl(url);
      if (result !== null) return result;
      lastResult = null;
    } catch (e) {
      lastResult = null;
    }
  }
  return lastResult;
}

async function main() {
  const config = loadConfig();
  const memberId = config.member_id;

  if (checkPending(memberId)) {
    console.log(JSON.stringify({ fire: false }));
    process.exit(0);
  }

  const sinceTs = getLastRead(memberId);
  const reqPath = `/chat/messages?since=${sinceTs}&limit=20`;

  let data;
  try {
    data = await fetchWithFallback(config, reqPath);
  } catch {
    console.log(JSON.stringify({ fire: false }));
    process.exit(0);
  }

  if (!data || !data.ok || !data.messages) {
    console.log(JSON.stringify({ fire: false }));
    process.exit(0);
  }

  const messages = data.messages;
  const fromOthers = messages.filter(m => String(m.sender) !== String(memberId));

  if (fromOthers.length === 0) {
    console.log(JSON.stringify({ fire: false }));
    process.exit(0);
  }

  const actionable = fromOthers.some(msg => {
    const atMe = msg.mentions && msg.mentions.includes(memberId);
    const atAll = msg.mentions && msg.mentions.includes('all');
    const isDM = msg.channel === `dm:${memberId}`;
    return atMe || atAll || isDM;
  });

  console.log(JSON.stringify({ fire: actionable }));
}

main();
