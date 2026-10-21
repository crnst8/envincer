// A run: one URL, one plan, many shots. Shoots, composes, checks and reviews each shot.
const sharp = require('sharp');
const capture = require('./capture');
const compose = require('./compose');
const ocr = require('./ocr');
const planner = require('./planner');
const devices = require('./devices');
const store = require('./store');
const llm = require('./llm');
const { id } = require('./util');

const DEFAULT_DISPLAY = 1000;
// Pixel density of the person looking at the published image. 2 = a retina laptop or phone.
const VIEWER_DPR = Number(process.env.ENVINCER_VIEWER_DPR) || 2;

async function create({ url, prompt, plan, discovery, autoReview = false }) {
  const devs = await devices.all();
  const p = planner.normPlan(plan, devs);
  const shots = planner.expand(p);
  const seen = new Map();
  for (const s of shots) { const n = (seen.get(s.file) || 0) + 1; seen.set(s.file, n); if (n > 1) s.file += `-${n}`; }
  const run = {
    id: id(8), url, prompt: prompt || '', createdAt: new Date().toISOString(),
    plan: p, autoReview: Boolean(autoReview) && llm.enabled(),
    discovery: discovery ? { ...discovery, preview: undefined } : null,
    shots: shots.map((s) => ({ ...s, status: 'queued', version: 0, approved: false, history: [] })),
  };
  store.saveRun(run, true);
  for (const s of run.shots) queueShot(run, s.id);
  return run;
}

function findShot(run, sid) {
  const s = run.shots.find((x) => x.id === sid);
  if (!s) throw Object.assign(new Error('shot not found'), { status: 404 });
  return s;
}

function queueShot(run, sid, note) {
  const s = findShot(run, sid);
  s.status = 'queued';
  s.error = null;
  if (note) s.note = note;
  store.saveRun(run);
  shootShot(run, sid).catch((err) => console.error(`[run ${run.id}] ${sid}: ${err.stack || err.message}`));
}

async function shootShot(run, sid) {
  const s = findShot(run, sid);
  const opts = { url: run.url, setup: run.plan.setup, autoHideBanners: run.plan.autoHideBanners, onStart: () => { s.status = 'shooting'; store.saveRun(run); } };
  try {
    const dev = await devices.get(s.device);
    const main = await capture.shoot(s, { ...opts, kind: dev?.kind });
    let img = await compose.style(main.buffer, s, dev, run.url);
    const rawW = (await sharp(main.buffer).metadata()).width;
    if (s.combo) {
      const cdev = await devices.get(s.combo.device);
      const part = await capture.shoot({ ...s, ...s.combo, mode: 'viewport' }, { ...opts, kind: cdev?.kind });
      img = await compose.combo(img, await compose.style(part.buffer, { ...s, ...s.combo }, cdev, run.url));
    }
    const pre = await sharp(img).metadata();
    const final = await compose.finish(img, s.output, { framed: Boolean(dev) });

    const version = s.version + 1;
    const name = `${s.file}-${s.id}-v${version}.${final.ext}`;
    const thumb = `${s.file}-${s.id}-v${version}.thumb.webp`;
    store.writeFile(run.id, name, final.buffer);
    store.writeFile(run.id, thumb, await sharp(final.buffer).resize({ width: 900, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer());

    if (s.image) s.history = [...s.history, { version: s.version, image: s.image, thumb: s.thumb, width: s.width, height: s.height, note: s.note || '' }].slice(-10);
    Object.assign(s, {
      version, image: name, thumb, width: final.width, height: final.height, bytes: final.buffer.length,
      checks: main.checks, review: null, shotAt: new Date().toISOString(),
    });
    const displayWidth = s.output?.displayWidth || Math.min(final.width, DEFAULT_DISPLAY);
    // Width of the screenshot inside the final image, then at display size.
    const pad = s.output?.padding || 0;
    const fx = (final.width - pad * 2) / pre.width, fy = (final.height - pad * 2) / pre.height;
    const fit = s.output?.width && s.output?.height ? ((s.output.fit || (dev ? 'contain' : 'cover')) === 'cover' ? Math.max(fx, fy) : Math.min(fx, fy)) : fx;
    const devScale = dev ? Math.min(1, 8000 / (dev.frame.width * rawW / dev.screen.width), 8000 / (dev.frame.height * rawW / dev.screen.width)) : 1;
    const shownWidth = rawW * devScale * fit * displayWidth * VIEWER_DPR / final.width;
    s.ocr = await ocr.legibility({ raw: main.buffer, cssWidth: s.viewport.width, shownWidth, displayWidth }).catch((err) => ({ available: false, error: err.message }));
    s.findings = planner.findings(s);
    s.status = 'done';
    store.saveRun(run);

    if (run.autoReview) await reviewShot(run, sid, { autoFix: true });
  } catch (err) {
    s.status = 'error';
    s.error = String(err.message || err).split('\n')[0].slice(0, 300);
    store.saveRun(run);
  }
}

// A JPEG of the final image at a size a vision model reads well.
async function previewFor(run, s) {
  const p = s.image && store.filePath(run.id, s.image);
  if (!p) return null;
  return sharp(p).flatten({ background: '#ffffff' }).resize({ width: 1280, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
}

async function reviewShot(run, sid, { autoFix = false } = {}) {
  const s = findShot(run, sid);
  if (!llm.enabled()) throw Object.assign(new Error('AI review needs OPENCODE_API_KEY'), { status: 400 });
  s.reviewing = true;
  store.saveRun(run);
  try {
    s.review = await planner.review({ shot: s, image: await previewFor(run, s), purpose: run.prompt, session: run.id });
  } catch (err) {
    s.review = { verdict: 'error', issues: [err.message.slice(0, 200)], patch: null };
  } finally {
    s.reviewing = false;
    store.saveRun(run);
  }
  if (autoFix && s.review?.verdict === 'fix' && s.review.patch && !s.autoFixed) {
    s.autoFixed = true;
    await applyFix(run, sid);
  }
  return s.review;
}

async function applyFix(run, sid) {
  const s = findShot(run, sid);
  if (!s.review?.patch) throw Object.assign(new Error('no suggested fix'), { status: 400 });
  const devs = await devices.all();
  const next = planner.applyPatch(s, s.review.patch, devs);
  Object.assign(s, next);
  queueShot(run, sid, `AI fix: ${s.review.issues.join('; ').slice(0, 160)}`);
}

async function adjustShot(run, sid, instruction) {
  const s = findShot(run, sid);
  const devs = await devices.all();
  const r = await planner.adjust({ shot: s, instruction, image: await previewFor(run, s), discovery: run.discovery, devices: devs, session: run.id });
  if (r.shot === s) return { changed: false, note: r.note };
  Object.assign(s, r.shot);
  queueShot(run, sid, `${instruction.slice(0, 120)} → ${r.note}`);
  return { changed: true, note: r.note };
}

async function editShot(run, sid, spec) {
  const s = findShot(run, sid);
  const devs = await devices.all();
  Object.assign(s, planner.applyPatch(s, spec, devs));
  queueShot(run, sid, 'Edited spec');
}

function restore(run, sid, version) {
  const s = findShot(run, sid);
  const h = s.history.find((x) => x.version === Number(version));
  if (!h) throw Object.assign(new Error('version not found'), { status: 404 });
  s.history = [...s.history.filter((x) => x !== h), { version: s.version, image: s.image, thumb: s.thumb, width: s.width, height: s.height, note: s.note || '' }];
  Object.assign(s, { version: h.version, image: h.image, thumb: h.thumb, width: h.width, height: h.height, note: `Restored v${h.version}`, review: null });
  store.saveRun(run);
}

async function duplicateShot(run, sid) {
  const s = findShot(run, sid);
  const copy = { ...s, id: id(6), file: `${s.file}-copy`, status: 'queued', version: 0, approved: false, history: [], image: null, thumb: null, review: null, findings: [], checks: null, ocr: null, autoFixed: false };
  run.shots.splice(run.shots.indexOf(s) + 1, 0, copy);
  queueShot(run, copy.id, 'Copy');
  return copy;
}

function removeShot(run, sid) {
  run.shots = run.shots.filter((x) => x.id !== sid);
  store.saveRun(run);
}

// Final images under clean names, plus manifest.json and snippet.md (README-ready tags).
function exportEntries(run, { approvedOnly }) {
  const fs = require('node:fs');
  const picked = run.shots.filter((s) => s.status === 'done' && s.image && (!approvedOnly || s.approved));
  const nameOf = (s) => `${s.file}.${s.image.split('.').pop()}`;
  const entries = picked.map((s) => ({ name: nameOf(s), data: fs.readFileSync(store.filePath(run.id, s.image)) }));
  const manifest = picked.map((s) => ({
    file: nameOf(s), feature: s.feature, target: s.target, url: new URL(s.path || '/', run.url).href,
    width: s.width, height: s.height, viewport: s.viewport, scale: s.scale, device: s.device, colorScheme: s.colorScheme,
    findings: (s.findings || []).map((f) => f.text), review: s.review || null,
  }));
  const md = picked.map((s) => {
    const w = s.output?.displayWidth;
    return w && w < s.width ? `<img src="${nameOf(s)}" alt="${s.feature}" width="${w}">` : `![${s.feature}](${nameOf(s)})`;
  }).join('\n\n');
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) });
  entries.push({ name: 'snippet.md', data: Buffer.from(`${md}\n`) });
  return entries;
}

const bundle = (run, opts) => store.zip(exportEntries(run, opts));

module.exports = { create, queueShot, reviewShot, applyFix, adjustShot, editShot, restore, duplicateShot, removeShot, bundle, exportEntries, findShot };
