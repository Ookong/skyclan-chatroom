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
    const req = lib.request(url, { method: 'GET', timeout: 8000 }, (res) => {
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

async function main() {
  const config = loadConfig();
  const memberId = config.member_id;

  if (checkPending(memberId)) {
    console.log(JSON.stringify({ fire: false }));
    process.exit(0);
  }

  const sinceTs = getLastRead(memberId);
  const url = `${config.api_base}/chat/messages?since=${sinceTs}&limit=20`;

  let data;
  try {
    data = await fetchUrl(url);
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
