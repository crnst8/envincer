// Device frame templates: any RGBA PNG whose screen is a transparent hole.
// The screen is found by flood-filling transparent pixels from the image centre,
// so new templates work without hand-measured coordinates.
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { DATA_DIR, ROOT } = require('./paths');

const BUILTIN_DIR = path.join(ROOT, 'devices');
const USER_DIR = path.join(DATA_DIR, 'devices');

// Defaults for the templates that ship with the repo. Uploaded templates get
// defaults inferred from the screen's aspect ratio.
const KNOWN = {
  laptop: { label: 'Laptop', kind: 'laptop', width: 1440, scale: 2 },
  iphone: { label: 'iPhone', kind: 'phone', width: 393, scale: 3 },
  ipad: { label: 'iPad', kind: 'tablet', width: 820, scale: 2 },
};

const cache = new Map();

async function analyse(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const mask = new Uint8Array(w * h);
  const clear = (i) => data[i * 4 + 3] < 128;
  let start = (h >> 1) * w + (w >> 1);
  if (!clear(start)) throw new Error(`${path.basename(file)}: centre pixel is not transparent`);
  const stack = [start];
  mask[start] = 1;
  let minX = w, minY = h, maxX = 0, maxY = 0, count = 0;
  while (stack.length) {
    const p = stack.pop();
    const x = p % w, y = (p / w) | 0;
    count++;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    for (const q of [p - 1, p + 1, p - w, p + w]) {
      if (q < 0 || q >= w * h || mask[q]) continue;
      if ((q === p - 1 && x === 0) || (q === p + 1 && x === w - 1)) continue;
      if (clear(q)) { mask[q] = 1; stack.push(q); }
    }
  }
  if (minX === 0 || minY === 0 || maxX === w - 1 || maxY === h - 1) throw new Error(`${path.basename(file)}: screen region touches the image edge`);
  const screen = { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  // Mask cropped to the screen box, as an RGBA PNG for a dest-in composite.
  const rgba = Buffer.alloc(screen.width * screen.height * 4);
  for (let y = 0; y < screen.height; y++) for (let x = 0; x < screen.width; x++) {
    if (mask[(y + minY) * w + x + minX]) rgba[(y * screen.width + x) * 4 + 3] = 255;
  }
  const maskPng = await sharp(rgba, { raw: { width: screen.width, height: screen.height, channels: 4 } }).png().toBuffer();
  return { width: w, height: h, screen, maskPng, fill: count / (screen.width * screen.height) };
}

// A template in data/devices replaces the built-in one with the same id.
function listFiles() {
  const byId = new Map();
  for (const [dir, builtin] of [[BUILTIN_DIR, true], [USER_DIR, false]]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.toLowerCase().endsWith('.png') || f.startsWith('.')) continue;
      const id = f.slice(0, -4).toLowerCase();
      byId.set(id, { id, file: path.join(dir, f), builtin, overrides: !builtin && byId.has(id) });
    }
  }
  return [...byId.values()];
}

async function load(entry) {
  const stat = fs.statSync(entry.file);
  const hit = cache.get(entry.id);
  if (hit && hit.mtime === stat.mtimeMs && hit.file === entry.file) return hit;
  const a = await analyse(entry.file);
  const ratio = a.screen.height / a.screen.width;
  const known = KNOWN[entry.id];
  const kind = known?.kind || (ratio > 1.6 ? 'phone' : ratio > 1.05 ? 'tablet' : 'laptop');
  const width = known?.width || { phone: 393, tablet: 820, laptop: 1440 }[kind];
  const dev = {
    id: entry.id, file: entry.file, builtin: entry.builtin, overrides: entry.overrides, mtime: stat.mtimeMs,
    label: known?.label || entry.id, kind,
    frame: { width: a.width, height: a.height }, screen: a.screen, ratio, maskPng: a.maskPng,
    // statusBar: CSS px at the top of the screen drawn as a phone/tablet status bar, so page content starts below the camera cutout.
    defaults: { width, height: Math.round(width * ratio), scale: known?.scale || (kind === 'laptop' ? 2 : 3), mobile: kind !== 'laptop', statusBar: { phone: 54, tablet: 24, laptop: 0 }[kind] },
  };
  cache.set(entry.id, dev);
  return dev;
}

async function all() {
  const out = [];
  for (const e of listFiles()) {
    try { out.push(await load(e)); } catch (err) { console.warn(`[devices] skipped ${e.id}: ${err.message}`); }
  }
  return out;
}

async function get(id) {
  if (!id) return null;
  const e = listFiles().find((d) => d.id === String(id).toLowerCase());
  return e ? load(e) : null;
}

async function add(name, buf) {
  const id = String(name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
  if (!id) throw new Error('name required');
  fs.mkdirSync(USER_DIR, { recursive: true });
  const tmp = path.join(USER_DIR, `.${id}.png`);
  await sharp(buf).png().toFile(tmp);
  try { await analyse(tmp); } catch (err) { fs.rmSync(tmp, { force: true }); throw err; }
  fs.renameSync(tmp, path.join(USER_DIR, `${id}.png`));
  cache.delete(id);
  return get(id);
}

function remove(id) {
  const e = listFiles().find((d) => d.id === id);
  if (!e) throw new Error('not found');
  if (e.builtin) throw new Error('built-in templates cannot be removed');
  // Removing an override brings the built-in back.
  fs.rmSync(e.file);
  cache.delete(id);
}

const publicView = (d) => ({ id: d.id, label: d.label, kind: d.kind, builtin: d.builtin, overrides: Boolean(d.overrides), frame: d.frame, screen: d.screen, defaults: d.defaults });

module.exports = { all, get, add, remove, publicView };
