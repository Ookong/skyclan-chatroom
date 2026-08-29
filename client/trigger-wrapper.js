const r = await tools.call('exec', { command: 'node /Users/kaia/projects/skyclan-chatroom/client/skyclan-trigger.js 2>&1; echo ___MARK___' });
const d = (r && r.result && r.result.details) || {};
const s = String(d.aggregated ?? d.stdout ?? d.output ?? (r && r.result && r.result.output) ?? '');
const t = s.replace(/___MARK___[\s\S]*$/, '').trim();
if (t.startsWith('FIRE')) {
  json({ fire: true, message: '\n[SkyClan actionable msgs — 需冰爪处理]\n' + t.slice(5).trim() });
} else {
  json({ fire: false, state: { probe: JSON.stringify(d).slice(0, 1000), keys: Object.keys(d), at: Date.now() } });
}
