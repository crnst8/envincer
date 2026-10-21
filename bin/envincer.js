#!/usr/bin/env node
// Headless use without the web UI:
//   node bin/envincer.js URL "prompt" [--preset ID] [--out DIR] [--review] [--plan-only]
// Plans, shoots, and writes images plus manifest.json and snippet.md to DIR.
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../server/paths');

if (fs.existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));

const capture = require('../server/capture');
const devices = require('../server/devices');
const planner = require('../server/planner');
const runs = require('../server/runs');
const store = require('../server/store');

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--preset' || a === '--out') out[a.slice(2)] = argv[++i];
    else if (a === '--review' || a === '--plan-only' || a === '--help' || a === '-h') out[a.replace(/^-+/, '')] = true;
    else out._.push(a);
  }
  return out;
}

async function main() {
  const a = args(process.argv.slice(2));
  if (a.help || a.h || !a._[0]) {
    console.log('usage: envincer URL "prompt" [--preset ID] [--out DIR] [--review] [--plan-only]');
    console.log(`presets: ${store.presets().map((p) => p.id).join(', ')}`);
    process.exit(a._[0] ? 0 : 1);
  }
  let url = a._[0];
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const prompt = a._.slice(1).join(' ');
  const devs = await devices.all();
  const preset = a.preset ? store.preset(a.preset) : null;
  if (a.preset && !preset) throw new Error(`unknown preset "${a.preset}"`);

  console.error(`[envincer] reading ${url}`);
  const discovery = await capture.discover(url).catch((err) => { console.error(`[envincer] page read failed: ${err.message.split('\n')[0]}`); return null; });
  const plan = await planner.plan({ url, prompt, preset, discovery, presets: store.presets(), devices: devs, session: 'cli' });
  if (plan.warning) console.error(`[envincer] ${plan.warning}`);
  console.error(`[envincer] ${plan.source} plan: ${plan.features.length} features × ${plan.targets.length} targets`);
  if (a['plan-only']) { console.log(JSON.stringify(plan, null, 2)); return capture.close(); }

  const run = await runs.create({ url, prompt, plan, discovery, autoReview: a.review });
  const busy = () => run.shots.some((s) => s.status === 'queued' || s.status === 'shooting' || s.reviewing);
  let last = -1;
  while (busy()) {
    const done = run.shots.filter((s) => s.status === 'done' || s.status === 'error').length;
    if (done !== last) { console.error(`[envincer] ${done}/${run.shots.length}`); last = done; }
    await new Promise((r) => setTimeout(r, 500));
  }

  const out = path.resolve(a.out || `envincer-${run.id}`);
  fs.mkdirSync(out, { recursive: true });
  for (const e of runs.exportEntries(run, { approvedOnly: false })) fs.writeFileSync(path.join(out, e.name), e.data);
  for (const s of run.shots) {
    if (s.status !== 'done') { console.error(`[envincer] ✗ ${s.name}: ${s.error}`); continue; }
    const notes = [...(s.findings || []).filter((f) => f.level !== 'info').map((f) => f.text), ...(s.review?.verdict === 'fix' ? s.review.issues : [])];
    console.error(`[envincer] ${notes.length ? '!' : '✓'} ${s.file} ${s.width}×${s.height}${notes.length ? ` — ${notes.join('; ')}` : ''}`);
  }
  console.error(`[envincer] wrote ${out} (run ${run.id} is also in the web UI)`);
  console.log(out);
  await capture.close();
}

main().catch(async (err) => { console.error(`[envincer] ${err.message}`); await capture.close(); process.exit(1); });
