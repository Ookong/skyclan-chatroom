#!/usr/bin/env node
'use strict';
/**
 * wrapper 三守卫测试用例（8/24 冰爪备，供 20:00 龙井终确 + 周三守卫上线用）
 *
 * 背景：8/24 trigger.js stash 冲突事故——脚本语法坏 → wrapper 把崩溃当 fire:false，
 * cron 全绿实聋 3.5h（「绿灯哑巴」第三层变种）。
 *
 * 测法：黑盒 mock tools.call，eval client/trigger-wrapper.js 的真实源码，
 * 喂三种坏输出。不动 wrapper 本体（终确前主逻辑冻结）。
 *
 * 当前基线（无守卫）：三分支全部 fire:false = 哑巴——这就是要修的缺陷。
 * 守卫上线后同用例应变为：fire:false + error 信号（或非零退出）→ 用例转绿标准。
 */

const fs = require('fs');
const path = require('path');

const WRAPPER_SRC = fs.readFileSync(path.join(__dirname, '..', 'trigger-wrapper.js'), 'utf8');

// 三分支 fixture：模拟 exec 调 trigger.js 的三种故障形态
const CASES = [
  {
    name: 'case1: 非零退出（脚本崩溃，如 8/24 语法错误）',
    execResult: { result: { details: { status: 'failed', exitCode: 1, aggregated: 'client/skyclan-trigger.js:66\n<<<<<<< Updated upstream\n^^\n\nSyntaxError: Unexpected token\n___MARK___' } } },
    expectCurrent: 'fire:false 静默（哑巴——缺陷基线）',
    expectGuarded: '报错/失败信号（exit!=0 → error）',
  },
  {
    name: 'case2: 非 FIRE·QUIET 格式（协议漂移/垃圾输出）',
    execResult: { result: { details: { status: 'completed', exitCode: 0, aggregated: 'hello world this is not the protocol\n___MARK___' } } },
    expectCurrent: 'fire:false 静默（哑巴——缺陷基线）',
    expectGuarded: '报错（输出既非 FIRE 开头也非 QUIET → error）',
  },
  {
    name: 'case3: 超时无输出（挂起，如 CF 冷启动 30s+）',
    execResult: { result: { details: { status: 'timeout', exitCode: null, aggregated: '___MARK___', noOutputTimedOut: true } } },
    expectCurrent: 'fire:false 静默（哑巴——缺陷基线）',
    expectGuarded: '报错（无有效输出 → error）',
  },
];

function runWrapperWith(execResult) {
  // mock cron trigger 沙箱：提供 tools.call 与 json()
  let captured = null;
  const sandboxTools = { call: async () => execResult };
  const json = (obj) => { captured = obj; };
  // 用 Function 构造执行，注入 mock（wrapper 源码用 await，需 async 包裹）
  const fn = new Function('tools', 'json', 'return (async () => {' + WRAPPER_SRC + '})()');
  return fn(sandboxTools, json).then(() => captured);
}

(async () => {
  console.log('═'.repeat(64));
  console.log('wrapper 三守卫测试 · 基线记录（' + new Date().toISOString() + '）');
  console.log('被测源码: client/trigger-wrapper.js（未改动，git 干净区）');
  console.log('═'.repeat(64));
  for (const c of CASES) {
    const out = await runWrapperWith(c.execResult);
    const fire = out && out.fire;
    const hasErrorSignal = out && (out.error || out.fire === undefined);
    console.log('\n▶ ' + c.name);
    console.log('  wrapper 输出: ' + JSON.stringify(out).slice(0, 160));
    console.log('  判定: fire=' + fire + ' | errorSignal=' + !!hasErrorSignal);
    console.log('  基线预期(无守卫): ' + c.expectCurrent);
    console.log('  守卫后预期: ' + c.expectGuarded);
    console.log('  基线符合: ' + (fire === false && !hasErrorSignal ? '✅ 复现哑巴缺陷' : '❌ 意外行为，需人工看'));
  }
  console.log('\n' + '═'.repeat(64));
  console.log('结论: 三分支在当前 wrapper 下全部静默 fire:false。');
  console.log('守卫上线（周三）后重跑本文件，判定应从「✅ 复现哑巴」变为带 error 信号。');
})();
