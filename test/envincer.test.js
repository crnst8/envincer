// node --test. Uses a throwaway data dir and a local fixture site; needs Chromium and tesseract.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ENVINCER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'envincer-test-'));
delete process.env.OPENCODE_API_KEY;

const sharp = require('sharp');
const { extractJson } = require('../server/util');
const devices = require('../server/devices');
const planner = require('../server/planner');
const compose = require('../server/compose');
const capture = require('../server/capture');
const store = require('../server/store');
const runs = require('../server/runs');

const FIXTURE = `<!doctype html><html><head><title>Fixture App</title>
<style>body{font:18px/1.5 sans-serif;margin:0} nav{display:flex;gap:16px;padding:16px} section{min-height:600px;padding:40px}
@media (prefers-color-scheme: dark){body{background:#111;color:#eee}}</style></head><body>
<nav><a href="/">Home</a><a href="/pricing">Pricing</a><a href="/docs">Docs</a><a href="/privacy">Privacy</a></nav>
<section id="hero"><h1>Ship faster with Fixture</h1><p>Fixture turns plain text into dashboards your whole team can read.</p></section>
<section id="features"><h2>Features</h2><p>Search, filters, exports and sharing.</p></section>
<div id="cookie-consent" style="position:fixed;bottom:0;left:0;right:0;background:#000;color:#fff;padding:20px">We use cookies <button>OK</button></div>
</body></html>`;

let server, base;
test.before(async () => {
  server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(FIXTURE.replace('Fixture App', `Fixture ${req.url}`)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
});
test.after(async () => { server.close(); await capture.close(); fs.rmSync(process.env.ENVINCER_DATA, { recursive: true, force: true }); });

test('extractJson reads fenced and prose-wrapped JSON', () => {
  assert.deepEqual(extractJson('Sure!\n```json\n{"a": [1, "}"]}\n```'), { a: [1, '}'] });
  assert.deepEqual(extractJson('plan: {"x": {"y": 2}} done'), { x: { y: 2 } });
  assert.equal(extractJson('no json here'), null);
});

test('device templates: screen found by flood fill', async () => {
  const all = await devices.all();
  const byId = Object.fromEntries(all.map((d) => [d.id, d]));
  assert.ok(byId.iphone && byId.ipad && byId.laptop);
  assert.equal(byId.iphone.kind, 'phone');
  assert.equal(byId.iphone.defaults.height, 852);
  assert.equal(byId.laptop.kind, 'laptop');
});

test('targets: device height comes from the screen minus the status bar', async () => {
  const devs = await devices.all();
  const t = planner.normTarget({ device: 'iphone', viewport: { width: 393, height: 9999 } }, devs);
  assert.equal(t.statusBar, 54);
  assert.equal(t.viewport.height, 852 - 54);
  assert.equal(t.mode, 'viewport');
  const plain = planner.normTarget({ viewport: { width: 99999, height: 10 }, scale: 9, output: { format: 'gif' } }, devs);
  assert.equal(plain.viewport.width, 3840);
  assert.equal(plain.viewport.height, 240);
  assert.equal(plain.scale, 4);
  assert.equal(plain.output.format, 'png');
});

test('expand honours feature.targets', async () => {
  const devs = await devices.all();
  const p = planner.normPlan({ features: [{ name: 'A', path: '/' }, { name: 'B', path: '/b', targets: ['Phone'] }], targets: [{ name: 'Desk', viewport: { width: 1280, height: 800 } }, { name: 'Phone', device: 'iphone' }] }, devs);
  const shots = planner.expand(p);
  assert.deepEqual(shots.map((s) => s.name), ['A · Desk', 'A · Phone', 'B · Phone']);
});

test('rules planner picks a preset from the prompt and skips legal links', async () => {
  const devs = await devices.all();
  const discovery = { links: [{ path: '/pricing', text: 'Pricing', inNav: true }, { path: '/privacy', text: 'Privacy', inNav: true }] };
  const p = await planner.plan({ url: base, prompt: 'screens for the app store listing', discovery, presets: store.presets(), devices: devs });
  assert.equal(p.source, 'rules');
  assert.equal(p.presetId, 'app-store');
  assert.deepEqual(p.features.map((f) => f.path), ['/', '/pricing']);
});

test('rules adjust handles dark mode, sizes and frames', async () => {
  const devs = await devices.all();
  const [shot] = planner.expand(planner.normPlan({ features: [{ name: 'Home' }], targets: [{ name: 'Desk', viewport: { width: 1280, height: 800 } }] }, devs));
  const r = planner.adjust ? await planner.adjust({ shot, instruction: 'dark mode at 1440x900 2x', devices: devs }) : null;
  assert.equal(r.shot.colorScheme, 'dark');
  assert.deepEqual(r.shot.viewport, { width: 1440, height: 900 });
  assert.equal(r.shot.scale, 2);
  const framed = await planner.adjust({ shot, instruction: 'put it in the ipad', devices: devs });
  assert.equal(framed.shot.device, 'ipad');
});

test('finish: exact canvas, width-only, formats', async () => {
  const img = await sharp({ create: { width: 800, height: 600, channels: 4, background: '#3366ff' } }).png().toBuffer();
  const exact = await compose.finish(img, { width: 1200, height: 630, format: 'jpeg' });
  assert.equal(exact.width, 1200); assert.equal(exact.height, 630); assert.equal(exact.ext, 'jpeg');
  const w = await compose.finish(img, { width: 400, padding: 20, background: '#ffffff' });
  assert.equal(w.width, 400);
  assert.equal(w.height, Math.round(360 * 600 / 800) + 40);
});

test('zip: valid structure', () => {
  const z = store.zip([{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'b.txt', data: Buffer.from('world!') }]);
  assert.equal(z.readUInt32LE(0), 0x04034b50);
  const end = z.length - 22;
  assert.equal(z.readUInt32LE(end), 0x06054b50);
  assert.equal(z.readUInt16LE(end + 10), 2);
  const cdOffset = z.readUInt32LE(end + 16);
  assert.equal(z.readUInt32LE(cdOffset), 0x02014b50);
});

test('discover finds nav links, sections and dark-mode CSS', async () => {
  const d = await capture.discover(base);
  assert.match(d.title, /Fixture/);
  assert.ok(d.links.some((l) => l.path === '/pricing' && l.inNav));
  assert.ok(d.sections.some((s) => s.selector === '#features'));
  assert.equal(d.darkModeCss, true);
  assert.ok(d.preview.length > 1000);
});

test('run: shoots, frames, hides the cookie banner, checks text', async () => {
  const run = await runs.create({
    url: base, prompt: 'test',
    plan: { features: [{ name: 'Home', path: '/' }, { name: 'Features', path: '/', selector: '#features' }], targets: [{ name: 'Phone', device: 'iphone', output: { width: 600, displayWidth: 320 } }, { name: 'Desk', viewport: { width: 1280, height: 800 }, scale: 1, style: 'browser' }] },
  });
  const t0 = Date.now();
  while (run.shots.some((s) => s.status === 'queued' || s.status === 'shooting') && Date.now() - t0 < 90000) await new Promise((r) => setTimeout(r, 300));
  for (const s of run.shots) assert.equal(s.status, 'done', `${s.name}: ${s.error}`);
  const phone = run.shots.find((s) => s.target === 'Phone');
  assert.equal(phone.width, 600);
  assert.equal(phone.checks.bannersHidden, 1);
  assert.equal(phone.checks.status, 200);
  assert.equal(phone.ocr.available, true);
  assert.ok(phone.ocr.words > 5, 'OCR read the page text');
  const desk = run.shots.find((s) => s.target === 'Desk' && s.feature === 'Home');
  assert.equal(desk.width, 1280);
  assert.equal(desk.height, 800 + 38);
  const entries = runs.exportEntries(run, { approvedOnly: false });
  assert.ok(entries.some((e) => e.name === 'home--phone.png'));
  assert.ok(entries.some((e) => e.name === 'snippet.md'));
});

test('LLM plan: Messages request shape, session header, JSON parsing', async () => {
  const seen = [];
  const mock = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    const plan = { summary: 'Mock plan', features: [{ name: 'Pricing', path: '/pricing' }], targets: [{ name: 'Phone', device: 'iphone' }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: `Here you go:\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`` }] }));
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  process.env.OPENCODE_BASE_URL = `http://127.0.0.1:${mock.address().port}`;
  process.env.OPENCODE_API_KEY = 'test-key';
  try {
    const devs = await devices.all();
    const p = await planner.plan({ url: base, prompt: 'readme', discovery: { title: 'X', preview: Buffer.from('jpeg') }, presets: store.presets(), devices: devs, session: 'sess-1' });
    assert.equal(p.source, 'llm');
    assert.equal(p.features[0].path, '/pricing');
    assert.equal(p.targets[0].device, 'iphone');
    const r = seen[0];
    assert.equal(r.url, '/anthropic/v1/messages');
    assert.equal(r.headers['x-opencode-session'], 'sess-1');
    assert.match(r.headers['user-agent'], /^envincer\//);
    assert.equal(r.body.model, 'claude-haiku-5-5');
    assert.equal(r.body.messages[0].content[0].type, 'image');
  } finally {
    delete process.env.OPENCODE_API_KEY;
    delete process.env.OPENCODE_BASE_URL;
    mock.close();
  }
});
