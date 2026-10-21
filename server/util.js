const crypto = require('node:crypto');

const id = (n = 8) => crypto.randomBytes(n).toString('base64url').replace(/[-_]/g, '').slice(0, n).toLowerCase() || id(n);

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'shot';

// Run `fn` over `items` with at most `n` in flight.
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// One shared limiter so the UI and CLI never open more browser contexts than the host can hold.
function limiter(n) {
  let active = 0; const queue = [];
  const next = () => { if (active >= n || !queue.length) return; active++; const { fn, res, rej } = queue.shift(); fn().then(res, rej).finally(() => { active--; next(); }); };
  return (fn) => new Promise((res, rej) => { queue.push({ fn, res, rej }); next(); });
}

// Pull the first JSON object or array out of an LLM reply (models wrap JSON in prose or fences).
function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fenced ? fenced[1] : text;
  const start = src.search(/[{[]/);
  if (start < 0) return null;
  const open = src[start], close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) { try { return JSON.parse(src.slice(start, i + 1)); } catch { return null; } }
  }
  return null;
}

module.exports = { id, clamp, slug, pool, limiter, extractJson };
