// JSON files on disk: user presets and runs. No database; a run is a folder.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { DATA_DIR } = require('./paths');
const builtin = require('./presets-builtin');
const { id, slug } = require('./util');

const PRESETS_FILE = path.join(DATA_DIR, 'presets.json');
const RUNS_DIR = path.join(DATA_DIR, 'runs');
fs.mkdirSync(RUNS_DIR, { recursive: true });

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// ---------- presets ----------

const userPresets = () => { try { return JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8')); } catch { return []; } };
const presets = () => [...builtin, ...userPresets()];
const preset = (pid) => presets().find((p) => p.id === pid) || null;

function savePreset({ id: pid, name, description, targets }) {
  const list = userPresets();
  if (builtin.some((p) => p.id === pid)) throw new Error('built-in presets are read-only; save a copy');
  const existing = pid && list.find((p) => p.id === pid);
  const p = { id: existing ? pid : `${slug(name)}-${id(4)}`, name: String(name || 'Preset').slice(0, 60), description: String(description || '').slice(0, 300), targets };
  writeAtomic(PRESETS_FILE, JSON.stringify(existing ? list.map((x) => (x.id === pid ? p : x)) : [...list, p], null, 2));
  return p;
}

function deletePreset(pid) {
  if (builtin.some((p) => p.id === pid)) throw new Error('built-in presets cannot be deleted');
  writeAtomic(PRESETS_FILE, JSON.stringify(userPresets().filter((p) => p.id !== pid), null, 2));
}

// ---------- runs ----------

const runs = new Map();
const timers = new Map();
const validId = (rid) => /^[a-z0-9]{4,16}$/.test(rid);
const runDir = (rid) => path.join(RUNS_DIR, rid);

function loadRun(rid) {
  if (!validId(rid)) return null;
  if (runs.has(rid)) return runs.get(rid);
  try {
    const r = JSON.parse(fs.readFileSync(path.join(runDir(rid), 'run.json'), 'utf8'));
    // A restart interrupts shots that were in flight.
    for (const s of r.shots) if (s.status === 'queued' || s.status === 'shooting') { s.status = 'error'; s.error = 'Interrupted by a restart'; }
    runs.set(rid, r);
    return r;
  } catch { return null; }
}

function saveRun(run, now = false) {
  runs.set(run.id, run);
  clearTimeout(timers.get(run.id));
  const write = () => { timers.delete(run.id); fs.mkdirSync(runDir(run.id), { recursive: true }); writeAtomic(path.join(runDir(run.id), 'run.json'), JSON.stringify(run, null, 2)); };
  if (now) write(); else timers.set(run.id, setTimeout(write, 300));
}

function listRuns() {
  return fs.readdirSync(RUNS_DIR).filter(validId).map(loadRun).filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((r) => ({
      id: r.id, url: r.url, prompt: r.prompt, createdAt: r.createdAt, shots: r.shots.length,
      done: r.shots.filter((s) => s.status === 'done').length, approved: r.shots.filter((s) => s.approved).length,
      cover: r.shots.find((s) => s.thumb)?.thumb || null,
    }));
}

function deleteRun(rid) {
  if (!validId(rid)) return;
  runs.delete(rid);
  fs.rmSync(runDir(rid), { recursive: true, force: true });
}

function writeFile(rid, name, buf) { fs.writeFileSync(path.join(runDir(rid), name), buf); }

function filePath(rid, name) {
  if (!validId(rid) || !/^[\w.-]+$/.test(name)) return null;
  const p = path.join(runDir(rid), name);
  return fs.existsSync(p) ? p : null;
}

// ---------- zip (stored, no compression: PNGs are already compressed) ----------

function zip(entries) {
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const parts = [], central = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name), data = e.data, crc = zlib.crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
    h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    parts.push(h, name, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
    c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(off, 42);
    central.push(c, name);
    off += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

module.exports = { presets, preset, savePreset, deletePreset, loadRun, saveRun, listRuns, deleteRun, writeFile, filePath, runDir, zip };
