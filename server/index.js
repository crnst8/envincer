// envincer HTTP server: static UI + JSON API. node:http, no framework.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');
const { ROOT } = require('./paths');

if (fs.existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));

const capture = require('./capture');
const devices = require('./devices');
const planner = require('./planner');
const runs = require('./runs');
const store = require('./store');
const llm = require('./llm');
const ocr = require('./ocr');
const { id } = require('./util');

const PORT = Number(process.env.PORT) || 4190;
const PUBLIC = path.join(ROOT, 'public');
const PASSWORD = process.env.ENVINCER_PASSWORD || '';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json' };

// Discovery results (with the preview image) kept briefly between "plan" and "shoot".
const discoveries = new Map();
const remember = (d) => { const k = id(8); discoveries.set(k, d); setTimeout(() => discoveries.delete(k), 30 * 60 * 1000).unref(); return k; };

function hosts() {
  if (process.env.HOST) return process.env.HOST.split(',').map((h) => h.trim()).filter(Boolean);
  const ts = (os.networkInterfaces().tailscale0 || []).find((a) => a.family === 'IPv4')?.address;
  return ['127.0.0.1', ...(ts ? [ts] : [])];
}

const send = (res, code, body, headers = {}) => {
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(code, { 'content-type': isBuf ? 'application/octet-stream' : 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(isBuf ? body : JSON.stringify(body));
};

async function body(req, limit = 1 << 20) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw Object.assign(new Error('request too large'), { status: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
}
const json = async (req) => { const b = await body(req); if (!b.length) return {}; try { return JSON.parse(b); } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); } };

function checkUrl(u) {
  let url; try { url = new URL(u); } catch { throw Object.assign(new Error('enter a full URL, e.g. https://example.com'), { status: 400 }); }
  if (!/^https?:$/.test(url.protocol)) throw Object.assign(new Error('only http and https URLs'), { status: 400 });
  return url.href;
}

function authorised(req) {
  if (!PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const pass = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
  const a = Buffer.from(pass), b = Buffer.from(PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getRun(rid) {
  const r = store.loadRun(rid);
  if (!r) throw Object.assign(new Error('run not found'), { status: 404 });
  return r;
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
  const m = req.method;
  const [a, b, c, d, e] = parts;

  if (a === 'config' && m === 'GET') {
    const devs = await devices.all();
    return send(res, 200, { llm: llm.enabled(), model: llm.model(), ocr: await ocr.isAvailable(), devices: devs.map(devices.publicView), presets: store.presets() });
  }

  if (a === 'devices') {
    if (m === 'POST' && !b) {
      const name = url.searchParams.get('name') || '';
      const dev = await devices.add(name, await body(req, 30 << 20));
      return send(res, 200, devices.publicView(dev));
    }
    if (m === 'GET' && b && c === 'image') {
      const dev = await devices.get(b);
      if (!dev) return send(res, 404, { error: 'not found' });
      return send(res, 200, fs.readFileSync(dev.file), { 'content-type': 'image/png', 'cache-control': 'max-age=300' });
    }
    if (m === 'DELETE' && b) { devices.remove(b); return send(res, 200, { ok: true }); }
  }

  if (a === 'presets') {
    if (m === 'GET' && !b) return send(res, 200, store.presets());
    if (m === 'POST' && b === 'generate') {
      const { text } = await json(req);
      if (!text?.trim()) return send(res, 400, { error: 'describe the preset' });
      return send(res, 200, await planner.presetFromText({ text: text.slice(0, 2000), devices: await devices.all() }));
    }
    if ((m === 'POST' && !b) || (m === 'PUT' && b)) {
      const p = await json(req);
      const devs = await devices.all();
      const targets = (p.targets || []).slice(0, 20).map((t) => planner.normTarget(t, devs));
      if (!targets.length) return send(res, 400, { error: 'a preset needs at least one target' });
      return send(res, 200, store.savePreset({ id: b, name: p.name, description: p.description, targets }));
    }
    if (m === 'DELETE' && b) { store.deletePreset(b); return send(res, 200, { ok: true }); }
  }

  if (a === 'plan' && m === 'POST') {
    const p = await json(req);
    const target = checkUrl(p.url);
    const devs = await devices.all();
    const presets = store.presets();
    const preset = p.presetId ? store.preset(p.presetId) : null;
    let discovery = null, discoveryError = null;
    try { discovery = await capture.discover(target, { setup: p.setup }); } catch (err) { discoveryError = err.message.split('\n')[0]; }
    const plan = await planner.plan({ url: target, prompt: p.prompt || '', preset, discovery, presets, devices: devs, session: `plan-${id(6)}` });
    const discoveryId = discovery ? remember(discovery) : null;
    return send(res, 200, {
      url: target, plan, discoveryId, discoveryError,
      discovery: discovery ? { title: discovery.title, status: discovery.status, links: discovery.links, sections: discovery.sections, toggles: discovery.toggles, darkModeCss: discovery.darkModeCss } : null,
      shots: planner.expand(planner.normPlan(plan, devs)).length,
    });
  }

  if (a === 'runs') {
    if (m === 'GET' && !b) return send(res, 200, store.listRuns());
    if (m === 'POST' && !b) {
      const p = await json(req);
      const run = await runs.create({ url: checkUrl(p.url), prompt: p.prompt, plan: p.plan, discovery: p.discoveryId ? discoveries.get(p.discoveryId) : null, autoReview: p.autoReview });
      return send(res, 200, run);
    }
    if (!b) return send(res, 405, { error: 'method not allowed' });
    const run = getRun(b);
    if (m === 'GET' && !c) return send(res, 200, run);
    if (m === 'DELETE' && !c) { store.deleteRun(b); return send(res, 200, { ok: true }); }
    if (c === 'files' && d && m === 'GET') {
      const p = store.filePath(b, d);
      if (!p) return send(res, 404, { error: 'not found' });
      const headers = { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream', 'cache-control': 'private, max-age=31536000, immutable' };
      if (url.searchParams.has('download')) headers['content-disposition'] = `attachment; filename="${d.replace(/-[a-z0-9]{6}-v\d+(?=\.)/, '')}"`;
      return send(res, 200, fs.readFileSync(p), headers);
    }
    if (c === 'zip' && m === 'GET') {
      const approvedOnly = url.searchParams.get('approved') === '1';
      return send(res, 200, runs.bundle(run, { approvedOnly }), { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="envincer-${run.id}${approvedOnly ? '-approved' : ''}.zip"` });
    }
    if (c === 'preset' && m === 'POST') {
      const p = await json(req);
      return send(res, 200, store.savePreset({ name: p.name || `From ${new URL(run.url).host}`, description: p.description || run.prompt, targets: run.plan.targets }));
    }
    if (c === 'approve-all' && m === 'POST') {
      const { approved = true } = await json(req);
      for (const s of run.shots) if (s.status === 'done') s.approved = Boolean(approved);
      store.saveRun(run);
      return send(res, 200, run);
    }
    if (c === 'review-all' && m === 'POST') {
      if (!llm.enabled()) return send(res, 400, { error: 'AI review needs OPENCODE_API_KEY' });
      for (const s of run.shots) if (s.status === 'done') runs.reviewShot(run, s.id).catch(() => {});
      return send(res, 200, { ok: true });
    }
    if (c === 'shots' && d) {
      const s = runs.findShot(run, d);
      if (m === 'DELETE' && !e) { runs.removeShot(run, d); return send(res, 200, run); }
      if (m !== 'POST') return send(res, 405, { error: 'method not allowed' });
      const p = await json(req);
      switch (e) {
        case 'approve': s.approved = p.approved !== false; store.saveRun(run); break;
        case 'retake': runs.queueShot(run, d, 'Retake'); break;
        case 'adjust': {
          if (!p.instruction?.trim()) return send(res, 400, { error: 'say what to change' });
          const r = await runs.adjustShot(run, d, p.instruction.slice(0, 1000));
          return send(res, 200, { run, ...r });
        }
        case 'edit': await runs.editShot(run, d, p.spec || {}); break;
        case 'review': await runs.reviewShot(run, d); break;
        case 'fix': await runs.applyFix(run, d); break;
        case 'restore': runs.restore(run, d, p.version); break;
        case 'duplicate': await runs.duplicateShot(run, d); break;
        default: return send(res, 404, { error: 'unknown action' });
      }
      return send(res, 200, run);
    }
  }
  return send(res, 404, { error: 'not found' });
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC, path.normalize(p));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, { error: 'not found' });
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': p.startsWith('/fonts/') ? 'max-age=86400' : 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  if (!authorised(req)) return send(res, 401, { error: 'password required' }, { 'www-authenticate': 'Basic realm="envincer"' });
  try {
    if (url.pathname === '/health') return send(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
    return serveStatic(req, res, url);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    if (!res.headersSent) send(res, status, { error: String(err.message || err).split('\n')[0] });
  }
});

// One listener per address so the server is reachable on localhost and the tailnet only.
const addrs = hosts();
let listening = 0;
for (const h of addrs) {
  const s = listening === 0 ? server : http.createServer(server.listeners('request')[0]);
  s.listen(PORT, h, () => console.log(`[envincer] http://${h}:${PORT}  llm=${llm.enabled() ? llm.model() : 'off'}`));
  listening++;
}

// Analyse the device templates now so the first page load is not waiting on it.
devices.all().catch(() => {});

const shutdown = async () => { await capture.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
