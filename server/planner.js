// Turns a prompt into a plan (features × targets), edits single shots from an
// instruction, reviews results and drafts presets. Uses the LLM when a key is set;
// every path has a deterministic fallback so the tool works without one.
const llm = require('./llm');
const { clamp, slug, id, extractJson } = require('./util');

const ACTIONS = ['goto', 'click', 'hover', 'fill', 'type', 'press', 'select', 'scroll', 'waitFor', 'wait'];
const MAX_SHOTS = 60;
const str = (v, n = 200) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const scaleOf = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(4, Math.max(0.5, Math.round(n * 4) / 4)) : d; };

function normActions(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 20).filter((a) => a && ACTIONS.includes(a.type)).map((a) => {
    const o = { type: a.type };
    if (a.selector) o.selector = str(a.selector, 300);
    if (a.value !== undefined && a.value !== null && a.value !== '') o.value = String(a.value).slice(0, 500);
    if (a.ms !== undefined) o.ms = clamp(a.ms, 0, 15000, 500);
    if (a.path) o.value = str(a.path, 500);
    return o;
  });
}

function normOutput(o = {}) {
  const out = {};
  if (o.width) out.width = clamp(o.width, 64, 8000);
  if (o.height && out.width) out.height = clamp(o.height, 64, 8000);
  out.format = ['png', 'webp', 'jpeg'].includes(o.format) ? o.format : o.format === 'jpg' ? 'jpeg' : 'png';
  if (typeof o.background === 'string' && (/^#[0-9a-f]{3,8}$/i.test(o.background) || o.background === 'transparent')) out.background = o.background;
  if (o.padding) out.padding = clamp(o.padding, 0, 800, 0);
  if (o.displayWidth) out.displayWidth = clamp(o.displayWidth, 100, 4000);
  if (o.fit === 'cover' || o.fit === 'contain') out.fit = o.fit;
  return out;
}

function normTarget(t = {}, devices) {
  const dev = devices.find((d) => d.id === String(t.device || '').toLowerCase()) || null;
  const mode = dev ? 'viewport' : ['viewport', 'fullpage', 'element'].includes(t.mode) ? t.mode : 'viewport';
  const width = clamp(t.viewport?.width ?? t.width, 240, 3840, dev?.defaults.width || 1280);
  const bar = dev && t.statusBar !== false && t.statusBar !== 0 ? Math.round(dev.defaults.statusBar * width / dev.defaults.width) : 0;
  const height = dev ? Math.round(width * dev.ratio) - bar : clamp(t.viewport?.height ?? t.height, 240, 4000, 800);
  const out = {
    name: str(t.name, 60) || (dev ? dev.label : `${width}×${height}`),
    device: dev?.id || null,
    viewport: { width, height },
    scale: scaleOf(t.scale, dev?.defaults.scale || 1),
    mode,
    style: ['plain', 'browser', 'rounded'].includes(t.style) && !dev ? t.style : 'plain',
    colorScheme: t.colorScheme === 'dark' ? 'dark' : 'light',
    output: normOutput(t.output),
  };
  if (dev) out.statusBar = bar;
  if (typeof t.mobile === 'boolean') out.mobile = t.mobile;
  else if (dev) out.mobile = dev.defaults.mobile;
  if (t.combo && dev) {
    const cd = devices.find((d) => d.id === String(t.combo.device || '').toLowerCase());
    if (cd) {
      const w = clamp(t.combo.viewport?.width, 240, 3840, cd.defaults.width);
      const cbar = t.statusBar !== false && t.statusBar !== 0 ? Math.round(cd.defaults.statusBar * w / cd.defaults.width) : 0;
      out.combo = { device: cd.id, viewport: { width: w, height: Math.round(w * cd.ratio) - cbar }, scale: scaleOf(t.combo.scale, cd.defaults.scale), mobile: cd.defaults.mobile, statusBar: cbar };
    }
  }
  return out;
}

function normFeature(f = {}) {
  const out = { name: str(f.name, 60) || 'Page', path: str(f.path, 500) || '/' };
  if (f.selector) out.selector = str(f.selector, 300);
  const actions = normActions(f.actions);
  if (actions.length) out.actions = actions;
  if (Array.isArray(f.hide) && f.hide.length) out.hide = f.hide.slice(0, 20).map((s) => str(s, 300)).filter(Boolean);
  if (['viewport', 'fullpage', 'element'].includes(f.mode)) out.mode = f.mode;
  if (f.delay) out.delay = clamp(f.delay, 0, 15000, 0);
  if (f.scrollOffset !== undefined) out.scrollOffset = clamp(f.scrollOffset, 0, 2000, 24);
  if (Array.isArray(f.targets) && f.targets.length) out.targets = f.targets.map((s) => str(s, 60)).filter(Boolean);
  if (f.colorScheme === 'dark' || f.colorScheme === 'light') out.colorScheme = f.colorScheme;
  return out;
}

function normPlan(p = {}, devices) {
  const targets = (Array.isArray(p.targets) ? p.targets : []).slice(0, 20).map((t) => normTarget(t, devices));
  const features = (Array.isArray(p.features) ? p.features : []).slice(0, 30).map(normFeature);
  if (!features.length) features.push({ name: 'Home', path: '/' });
  if (!targets.length) targets.push(normTarget({ name: 'Desktop', viewport: { width: 1440, height: 900 }, scale: 2 }, devices));
  return {
    summary: str(p.summary, 400),
    setup: normActions(p.setup),
    autoHideBanners: p.autoHideBanners !== false,
    features, targets,
  };
}

// Feature × target, honouring a feature's own target list.
function expand(plan) {
  const shots = [];
  for (const f of plan.features) {
    for (const t of plan.targets) {
      if (f.targets && !f.targets.includes(t.name)) continue;
      const mode = t.device ? 'viewport' : f.mode || t.mode;
      const { targets: _, ...feat } = f;
      shots.push({
        id: id(6),
        ...t, ...feat,
        name: `${f.name} · ${t.name}`,
        feature: f.name, target: t.name,
        mode,
        colorScheme: f.colorScheme || t.colorScheme,
        file: `${slug(f.name)}--${slug(t.name)}`,
      });
      if (shots.length >= MAX_SHOTS) return shots;
    }
  }
  return shots;
}

// Shot fields the LLM (or the JSON editor) may change.
const EDITABLE = ['statusBar', 'path', 'selector', 'actions', 'hide', 'mode', 'delay', 'scrollOffset', 'device', 'viewport', 'scale', 'style', 'colorScheme', 'mobile', 'output', 'combo', 'name'];

function applyPatch(shot, patch, devices) {
  const merged = { ...shot };
  for (const k of EDITABLE) if (patch[k] !== undefined) merged[k] = k === 'output' ? { ...shot.output, ...patch.output } : patch[k];
  if (patch.viewport && merged.device === shot.device) merged.viewport = { ...shot.viewport, ...patch.viewport };
  const t = normTarget(merged, devices);
  const f = normFeature({ ...merged, name: shot.feature });
  delete f.targets;
  return { ...shot, ...t, ...f, name: str(merged.name, 120) || shot.name, feature: shot.feature, mode: t.device ? 'viewport' : f.mode || t.mode, colorScheme: merged.colorScheme === 'dark' ? 'dark' : 'light' };
}

// ---------- prompts ----------

const SCHEMA = `Target: {"name": str, "device": device id or null, "viewport": {"width": css px, "height": css px (ignored when device set; derived from the device screen)}, "scale": device pixel ratio 1-4, "mode": "viewport"|"fullpage"|"element", "style": "plain"|"browser"|"rounded" (browser = macOS-style window chrome; ignored with device), "colorScheme": "light"|"dark", "mobile": bool, "output": {"width": px, "height": px (exact canvas, optional), "format": "png"|"webp"|"jpeg", "background": "transparent"|"#rrggbb", "padding": px, "displayWidth": px the image is shown at}, "combo": {"device": second device id, "viewport": {"width": n}, "scale": n} (optional: laptop + phone composite), "statusBar": false to skip the drawn phone status bar}
Feature: {"name": str, "path": url path, "selector": Playwright selector to scroll to (or to crop to with mode "element"), "actions": [{"type": "click"|"hover"|"fill"|"press"|"select"|"scroll"|"waitFor"|"wait"|"goto", "selector": str, "value": str, "ms": n}], "hide": [selectors to hide], "delay": ms, "colorScheme": "light"|"dark" (overrides target), "targets": [target names] (optional; limit this feature to some targets)}`;

const PLAN_SYSTEM = `You plan product screenshots. Given a web page's structure and a request, choose the features worth showing and the target sizes/frames, then reply with ONLY a JSON object:
{"summary": one sentence, "setup": [actions run before every shot, e.g. a login; usually []], "autoHideBanners": true, "features": [Feature], "targets": [Target]}
${SCHEMA}
Rules:
- Pick 3-8 features that show what the product does: the landing view, main pages from the navigation, key sections (pricing, dashboard, editor, search results). Skip legal, blog posts, login pages unless asked.
- Use paths and selectors exactly as given in the page structure. Playwright selectors such as text="Pricing" or h2:has-text("Pricing") are fine.
- If a preset matches the request, copy its targets unchanged. Otherwise build targets that fit the stated destination (exact pixel sizes for stores and social cards; retina 2x for README/docs; frames for marketing).
- Only add dark colorScheme targets if the request asks for dark mode or the site has dark-mode CSS and the request asks for light and dark.
- Keep features × targets at or below 40. Use feature.targets to avoid pointless combinations.`;

function compactDiscovery(d) {
  if (!d) return {};
  return {
    url: d.url, title: d.title, description: d.description, pageHeight: d.height, darkModeCss: d.darkModeCss,
    links: d.links?.slice(0, 30), sections: d.sections?.slice(0, 25), toggles: d.toggles?.slice(0, 15), text: d.text?.slice(0, 1000),
  };
}

const devicesForPrompt = (devices) => devices.map((d) => ({ id: d.id, kind: d.kind, defaultWidth: d.defaults.width, defaultScale: d.defaults.scale, screenRatio: +d.ratio.toFixed(3) }));
const presetsForPrompt = (presets) => presets.map((p) => ({ id: p.id, name: p.name, description: p.description, targets: p.targets }));

async function plan({ url, prompt, preset, discovery, presets, devices, session }) {
  if (llm.enabled()) {
    const text = `Request: ${prompt || '(none — make a sensible general set)'}
${preset ? `Use this preset's targets: ${JSON.stringify(presetsForPrompt([preset])[0])}` : `Presets: ${JSON.stringify(presetsForPrompt(presets))}`}
Devices: ${JSON.stringify(devicesForPrompt(devices))}
Page structure: ${JSON.stringify(compactDiscovery(discovery))}`;
    try {
      const reply = await llm.ask({ system: PLAN_SYSTEM, text, images: discovery?.preview ? [discovery.preview] : [], session });
      const j = extractJson(reply);
      if (j && (j.features || j.targets)) {
        const p = normPlan(j, devices);
        if (preset) p.targets = preset.targets.map((t) => normTarget(t, devices));
        return { ...p, source: 'llm' };
      }
      return { ...fallbackPlan({ prompt, preset, discovery, presets, devices }), warning: 'LLM reply was not a plan; used keyword rules' };
    } catch (err) {
      return { ...fallbackPlan({ prompt, preset, discovery, presets, devices }), warning: `LLM unavailable (${err.message}); used keyword rules` };
    }
  }
  return fallbackPlan({ prompt, preset, discovery, presets, devices });
}

const KEYWORDS = [
  [/app ?store|ios store|testflight/i, 'app-store'],
  [/play ?store|google play|android/i, 'google-play'],
  [/social|open ?graph|\bog\b|twitter|\bx\b card|linkedin|product ?hunt/i, 'social'],
  [/responsive|breakpoint|all sizes|every size/i, 'responsive'],
  [/full[- ]?page|entire page|whole page|long/i, 'full-page'],
  [/dark/i, 'light-dark'],
  [/mock ?up|device|frame/i, 'mockups'],
  [/readme|github|docs|documentation/i, 'github-readme'],
];

function fallbackPlan({ prompt = '', preset, discovery, presets, devices }) {
  const chosen = preset || presets.find((p) => KEYWORDS.some(([re, pid]) => pid === p.id && re.test(prompt))) || presets.find((p) => p.id === 'github-readme') || presets[0];
  const features = [{ name: 'Home', path: '/' }];
  const nav = (discovery?.links || []).filter((l) => l.inNav && l.text && l.path !== '/' && !/login|sign ?in|sign ?up|privacy|terms|legal|cookie/i.test(`${l.text} ${l.path}`));
  for (const l of nav.slice(0, 4)) features.push({ name: l.text.slice(0, 40), path: l.path });
  return { ...normPlan({ summary: `${chosen.name} preset, home page and ${features.length - 1} navigation pages.`, features, targets: chosen.targets }, devices), source: 'rules', presetId: chosen.id };
}

// ---------- adjust ----------

const ADJUST_SYSTEM = `You edit one screenshot spec from a plain-English instruction. Reply with ONLY JSON: {"patch": {fields to change}, "note": short description of what you changed}.
Changeable fields: path, selector, actions, hide, mode, delay, scrollOffset, device, viewport, scale, style, colorScheme, mobile, output, combo.
${SCHEMA}
Include only fields that change. "actions" and "hide" replace the whole list, so repeat existing entries you keep. Use selectors from the page structure where possible.`;

async function adjust({ shot, instruction, image, discovery, devices, session }) {
  if (llm.enabled()) {
    const current = Object.fromEntries(EDITABLE.map((k) => [k, shot[k]]).filter(([, v]) => v !== undefined));
    const text = `Instruction: ${instruction}
Current spec: ${JSON.stringify(current)}
Devices: ${JSON.stringify(devicesForPrompt(devices))}
Page structure: ${JSON.stringify(compactDiscovery(discovery))}`;
    try {
      const j = extractJson(await llm.ask({ system: ADJUST_SYSTEM, text, images: image ? [image] : [], maxTokens: 1500, session }));
      if (j?.patch) return { shot: applyPatch(shot, j.patch, devices), note: str(j.note, 200) || 'Updated', source: 'llm' };
    } catch (err) {
      const r = fallbackAdjust(shot, instruction, devices);
      return { ...r, note: `${r.note} (LLM unavailable: ${err.message})` };
    }
  }
  return fallbackAdjust(shot, instruction, devices);
}

function fallbackAdjust(shot, instruction, devices) {
  const s = instruction.toLowerCase();
  const patch = {};
  const notes = [];
  if (/\bdark\b/.test(s)) { patch.colorScheme = 'dark'; notes.push('dark'); }
  if (/\blight\b/.test(s)) { patch.colorScheme = 'light'; notes.push('light'); }
  if (/full ?page/.test(s)) { patch.mode = 'fullpage'; notes.push('full page'); }
  const size = s.match(/(\d{3,4})\s*[x×]\s*(\d{3,4})/);
  if (size) { patch.viewport = { width: +size[1], height: +size[2] }; notes.push(`${size[1]}×${size[2]}`); }
  const dpr = s.match(/@?\b([1-4](?:\.5)?)x\b/);
  if (dpr) { patch.scale = +dpr[1]; notes.push(`${dpr[1]}x`); }
  const wait = s.match(/wait\s+(\d+)\s*(ms|s|sec|seconds?)?/);
  if (wait) { patch.delay = +wait[1] * (wait[2] && wait[2] !== 'ms' ? 1000 : 1); notes.push(`delay ${patch.delay}ms`); }
  const down = s.match(/scroll (?:down )?(?:by )?(\d+)/);
  if (down) { patch.actions = [...(shot.actions || []), { type: 'scroll', value: down[1] }]; notes.push(`scroll ${down[1]}px`); }
  const hide = instruction.match(/hide\s+([#.][\w-]+|"[^"]+")/i);
  if (hide) { const sel = hide[1].startsWith('"') ? `text=${hide[1]}` : hide[1]; patch.hide = [...(shot.hide || []), sel]; notes.push(`hide ${sel}`); }
  for (const d of devices) if (new RegExp(`\\b${d.id}\\b`).test(s)) { patch.device = d.id; patch.viewport = { width: d.defaults.width }; patch.scale = d.defaults.scale; notes.push(d.label); }
  if (/no frame|unframed|without (?:a )?frame/.test(s)) { patch.device = null; notes.push('no frame'); }
  if (/browser/.test(s)) { patch.device = null; patch.style = 'browser'; notes.push('browser window'); }
  if (!notes.length) return { shot, note: 'No change: set OPENCODE_API_KEY for plain-English edits, or edit the JSON', source: 'rules' };
  return { shot: applyPatch(shot, patch, devices), note: notes.join(', '), source: 'rules' };
}

// ---------- review ----------

// Deterministic findings from DOM checks and OCR. Each: {level: 'error'|'warn'|'info', text}.
function findings(shot) {
  const c = shot.checks || {}, o = shot.ocr || {};
  const out = [];
  if (c.status >= 400) out.push({ level: 'error', text: `HTTP ${c.status}` });
  if (o.blank) out.push({ level: 'error', text: 'Blank screenshot' });
  if (c.overflowX) out.push({ level: 'warn', text: `Page scrolls sideways by ${c.overflowX}px` });
  if (c.brokenImages) out.push({ level: 'warn', text: `${c.brokenImages} broken image${c.brokenImages > 1 ? 's' : ''}` });
  if (c.clippedText > 3) out.push({ level: 'warn', text: `${c.clippedText} clipped text elements` });
  if (o.ratio !== null && o.ratio !== undefined && o.ratio < 0.6) out.push({ level: 'warn', text: `Small text at ${o.displayWidth}px: ${Math.round(o.ratio * 100)}% of words legible` });
  if (c.failedRequests?.length) out.push({ level: 'warn', text: `${c.failedRequests.length} failed asset request${c.failedRequests.length > 1 ? 's' : ''}` });
  if (c.consoleErrors?.length) out.push({ level: 'info', text: `${c.consoleErrors.length} console error${c.consoleErrors.length > 1 ? 's' : ''}` });
  if (c.bannersHidden) out.push({ level: 'info', text: `Hid ${c.bannersHidden} cookie banner${c.bannersHidden > 1 ? 's' : ''}` });
  return out;
}

const REVIEW_SYSTEM = `You check a product screenshot before it is published. Look for: loading spinners or skeletons, empty states, cookie/consent or chat widgets covering content, cut-off headings, a scroll position that starts mid-element, unreadable text at the shown size, layout breakage, error pages, placeholder or lorem text.
Reply with ONLY JSON: {"verdict": "good"|"fix", "issues": [short strings], "patch": {spec fields to change to fix it, or {}}}.
${SCHEMA}
"hide" and "actions" in a patch replace the whole list. Prefer small fixes: hide an overlay, add a delay or waitFor, change the selector or scrollOffset.`;

async function review({ shot, image, purpose, session }) {
  if (!llm.enabled()) return null;
  const spec = Object.fromEntries(EDITABLE.map((k) => [k, shot[k]]).filter(([, v]) => v !== undefined));
  const text = `Purpose: ${purpose || 'product screenshots'}
Spec: ${JSON.stringify(spec)}
Automated checks: ${JSON.stringify(findings(shot).map((f) => f.text))}
OCR text: ${shot.ocr?.text?.slice(0, 400) || '(none)'}`;
  const j = extractJson(await llm.ask({ system: REVIEW_SYSTEM, text, images: image ? [image] : [], maxTokens: 1200, session }));
  if (!j) throw new Error('review reply was not JSON');
  return {
    verdict: j.verdict === 'fix' ? 'fix' : 'good',
    issues: (Array.isArray(j.issues) ? j.issues : []).slice(0, 8).map((s) => str(String(s), 200)).filter(Boolean),
    patch: j.patch && typeof j.patch === 'object' && Object.keys(j.patch).length ? j.patch : null,
  };
}

// ---------- presets ----------

const PRESET_SYSTEM = `You turn a plain-English description of screenshot sizes into a preset. Reply with ONLY JSON: {"name": short name, "description": one sentence, "targets": [Target]}.
${SCHEMA}
Use real published sizes for named destinations (store listings, social cards). Use device frames when the description mentions mockups or devices.`;

async function presetFromText({ text, devices }) {
  if (llm.enabled()) {
    try {
      const j = extractJson(await llm.ask({ system: PRESET_SYSTEM, text: `Description: ${text}\nDevices: ${JSON.stringify(devicesForPrompt(devices))}`, maxTokens: 2000 }));
      if (j?.targets?.length) return { name: str(j.name, 60) || 'New preset', description: str(j.description, 300) || text.slice(0, 300), targets: j.targets.slice(0, 20).map((t) => normTarget(t, devices)), source: 'llm' };
    } catch { /* fall through */ }
  }
  const targets = [];
  const s = text.toLowerCase();
  const dpr = s.match(/@?\b([1-4])x\b/);
  for (const m of s.matchAll(/(\d{3,4})\s*[x×]\s*(\d{3,4})/g)) targets.push(normTarget({ viewport: { width: +m[1], height: +m[2] }, scale: dpr ? +dpr[1] : 2, output: { width: +m[1], height: +m[2] } }, devices));
  for (const d of devices) if (s.includes(d.id) || s.includes(d.label.toLowerCase())) targets.push(normTarget({ device: d.id, scale: dpr ? +dpr[1] : undefined }, devices));
  if (/dark/.test(s)) targets.forEach((t) => { t.colorScheme = 'dark'; });
  if (/full ?page/.test(s)) targets.forEach((t) => { if (!t.device) t.mode = 'fullpage'; });
  return { name: text.slice(0, 40), description: text.slice(0, 300), targets, source: 'rules' };
}

module.exports = { plan, expand, adjust, review, findings, presetFromText, normPlan, normTarget, applyPatch };
