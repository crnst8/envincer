// envincer UI. Plain DOM, no framework. Every string from the network goes through text nodes.

const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

async function api(path, opts = {}) {
  const init = { method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'), headers: {} };
  if (opts.body !== undefined) {
    if (opts.body instanceof Blob) init.body = opts.body;
    else { init.body = JSON.stringify(opts.body); init.headers['content-type'] = 'application/json'; }
  }
  const res = await fetch(`/api/${path}`, init);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${err ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, err ? 5000 : 2600);
}

const store = {
  get(k, d) { try { const v = sessionStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const fmtBytes = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);
const host = (u) => { try { return new URL(u).host; } catch { return u; } };

let config = { llm: false, devices: [], presets: [] };
async function loadConfig() {
  config = await api('config');
  const chips = $('#chips');
  chips.replaceChildren(
    h('span', { class: `chip ${config.llm ? 'on' : 'off'}`, title: config.llm ? 'OpenCode Go' : 'Set OPENCODE_API_KEY in .env' }, config.llm ? config.model : 'LLM off'),
    h('span', { class: `chip ${config.ocr ? 'on' : 'off'}` }, config.ocr ? 'OCR' : 'OCR off'),
  );
}

function targetTags(t) {
  const dev = config.devices.find((d) => d.id === t.device);
  const out = [];
  out.push(dev ? dev.label : `${t.viewport.width}×${t.viewport.height}`);
  if (dev) out.push(`${t.viewport.width}w`);
  out.push(`@${t.scale}x`);
  if (t.combo) out.push(`+ ${config.devices.find((d) => d.id === t.combo.device)?.label || t.combo.device}`);
  if (t.style && t.style !== 'plain') out.push(t.style);
  if (t.mode && t.mode !== 'viewport') out.push(t.mode);
  if (t.colorScheme === 'dark') out.push('dark');
  const o = t.output || {};
  if (o.width) out.push(o.height ? `→ ${o.width}×${o.height}` : `→ ${o.width}w`);
  if (o.format && o.format !== 'png') out.push(o.format);
  return out.map((s) => h('span', { class: 'tag' }, s));
}

// ---------- shoot ----------

let draft = store.get('draft', null);
const saveDraft = () => store.set('draft', draft);

function countShots(plan) {
  const ts = plan.targets.filter((t) => !t.off);
  let n = 0;
  for (const f of plan.features.filter((x) => !x.off)) n += ts.filter((t) => !f.targets || f.targets.includes(t.name)).length;
  return n;
}

function cleanPlan(plan) {
  return { ...plan, features: plan.features.filter((f) => !f.off).map(({ off, ...f }) => f), targets: plan.targets.filter((t) => !t.off).map(({ off, ...t }) => t) };
}

function renderShoot(prefill = {}) {
  const form = store.get('form', { url: '', prompt: '', presetId: '', autoReview: false });
  if (prefill.presetId) form.presetId = prefill.presetId;
  const url = h('input', { class: 'url', type: 'text', inputmode: 'url', spellcheck: 'false', autocapitalize: 'off', name: 'url', placeholder: 'https://', required: true, value: form.url, autocomplete: 'url', 'aria-label': 'App URL' });
  const prompt = h('textarea', { name: 'prompt', rows: 2, placeholder: 'Full suite at a resolution suitable for a GitHub README', 'aria-label': 'What to shoot' }, form.prompt);
  const preset = h('select', { name: 'preset', 'aria-label': 'Preset' },
    h('option', { value: '' }, 'Preset from prompt'),
    config.presets.map((p) => h('option', { value: p.id, selected: p.id === form.presetId }, p.name)));
  const review = config.llm ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'review', checked: form.autoReview }), 'AI review') : null;
  const status = h('div', { class: 'status-line' });
  const planBtn = h('button', { class: 'btn', type: 'submit', value: 'plan' }, 'Plan');
  const goBtn = h('button', { class: 'btn primary', type: 'submit', value: 'go' }, 'Plan & shoot');
  const planBox = h('div');

  const remember = () => store.set('form', { url: url.value, prompt: prompt.value, presetId: preset.value, autoReview: review ? review.querySelector('input').checked : false });
  for (const el of [url, prompt, preset]) el.addEventListener('change', remember);
  review?.addEventListener('change', remember);

  const f = h('form', {
    class: 'compose',
    onsubmit: async (e) => {
      e.preventDefault();
      remember();
      const go = e.submitter?.value === 'go';
      let target = url.value.trim();
      if (target && !/^https?:\/\//i.test(target)) { target = `https://${target}`; url.value = target; }
      planBtn.disabled = goBtn.disabled = true;
      status.className = 'status-line';
      status.replaceChildren(h('span', { class: 'spin' }), config.llm ? 'Reading the page and planning…' : 'Reading the page…');
      try {
        const r = await api('plan', { body: { url: target, prompt: prompt.value, presetId: preset.value || undefined } });
        draft = { url: r.url, prompt: prompt.value, plan: r.plan, discoveryId: r.discoveryId, discovery: r.discovery };
        saveDraft();
        const notes = [r.plan.source === 'llm' ? 'Planned by the LLM' : 'Planned by keyword rules', r.plan.warning, r.discoveryError && `Page read failed: ${r.discoveryError}`].filter(Boolean);
        status.textContent = notes.join(' · ');
        if (go) return shoot(status);
        renderPlan(planBox, status);
      } catch (err) {
        status.className = 'status-line err';
        status.textContent = err.message;
      } finally {
        planBtn.disabled = goBtn.disabled = false;
      }
    },
  }, url, prompt, h('div', { class: 'row' }, preset, review, h('span', { class: 'grow' }), planBtn, goBtn));

  view.replaceChildren(h('h1', {}, 'Shoot'), f, status, planBox);
  if (draft) renderPlan(planBox, status);
  if (!form.url) url.focus();
}

async function shoot(status) {
  const plan = cleanPlan(draft.plan);
  if (!plan.features.length || !plan.targets.length) return toast('Pick at least one feature and one target', true);
  const autoReview = store.get('form', {}).autoReview;
  try {
    const run = await api('runs', { body: { url: draft.url, prompt: draft.prompt, plan, discoveryId: draft.discoveryId, autoReview } });
    location.hash = `#/run/${run.id}`;
  } catch (err) {
    status.className = 'status-line err';
    status.textContent = err.message;
  }
}

function renderPlan(box, status) {
  const p = draft.plan;
  const count = h('span');
  const shootBtn = h('button', { class: 'btn primary', onclick: () => shoot(status) });
  const refresh = () => {
    const n = countShots(p);
    shootBtn.textContent = `Shoot ${n} ${n === 1 ? 'shot' : 'shots'}`;
    shootBtn.disabled = n === 0;
    saveDraft();
  };

  const featureRow = (f) => {
    const row = h('div', { class: `item${f.off ? ' off' : ''}` });
    const bind = (key, ph, cls) => h('input', { class: cls, value: f[key] || '', placeholder: ph, 'aria-label': ph, oninput: (e) => { f[key] = e.target.value || undefined; saveDraft(); } });
    row.append(
      h('input', { type: 'checkbox', checked: !f.off, 'aria-label': 'Include', onchange: (e) => { f.off = !e.target.checked; row.classList.toggle('off', f.off); refresh(); } }),
      h('div', { class: 'fields' }, bind('name', 'Name'), bind('path', 'Path'), bind('selector', 'Selector', 'sel'),
        f.targets ? h('div', { class: 'tchips' }, f.targets.map((t) => h('span', { class: 'tag' }, t))) : null),
      h('button', { class: 'btn icon small ghost', 'aria-label': 'Remove', title: 'Remove', onclick: () => { p.features.splice(p.features.indexOf(f), 1); row.remove(); refresh(); } }, '×'),
    );
    return row;
  };

  const targetRow = (t) => {
    const row = h('div', { class: `item${t.off ? ' off' : ''}` });
    const json = h('textarea', { class: 'code', rows: 10 }, JSON.stringify((({ off, ...x }) => x)(t), null, 2));
    const tags = h('div', { class: 'tchips' }, targetTags(t));
    const name = h('div', { class: 'tname' }, t.name);
    const det = h('details', {}, h('summary', { class: 'label' }, 'JSON'), h('div', { class: 'json-edit' }, json, h('div', { class: 'row' }, h('button', {
      class: 'btn small', onclick: () => {
        try { const nt = JSON.parse(json.value); Object.keys(t).forEach((k) => delete t[k]); Object.assign(t, nt); name.textContent = t.name; tags.replaceChildren(...targetTags(t)); det.open = false; refresh(); } catch (err) { toast(err.message, true); }
      },
    }, 'Apply'))));
    row.append(
      h('input', { type: 'checkbox', checked: !t.off, 'aria-label': 'Include', onchange: (e) => { t.off = !e.target.checked; row.classList.toggle('off', t.off); refresh(); } }),
      h('div', {}, name, tags, det),
      h('button', { class: 'btn icon small ghost', 'aria-label': 'Remove', title: 'Remove', onclick: () => { p.targets.splice(p.targets.indexOf(t), 1); row.remove(); refresh(); } }, '×'),
    );
    return row;
  };

  const fList = h('div', { class: 'list' }, p.features.map(featureRow));
  const tList = h('div', { class: 'list' }, p.targets.map(targetRow));

  const d = draft.discovery || {};
  const addFeature = h('select', {
    'aria-label': 'Add feature',
    onchange: (e) => {
      const v = e.target.value; e.target.value = '';
      if (!v) return;
      const [kind, i] = v.split(':');
      let f = { name: 'Page', path: '/' };
      if (kind === 'link') { const l = d.links[i]; f = { name: l.text || l.path, path: l.path }; }
      if (kind === 'section') { const s = d.sections[i]; f = { name: s.heading, path: '/', selector: s.selector }; }
      p.features.push(f); fList.append(featureRow(f)); refresh();
    },
  }, h('option', { value: '' }, '+ Feature'), h('option', { value: 'blank:0' }, 'Blank'),
  d.links?.length ? h('optgroup', { label: 'Links' }, d.links.map((l, i) => h('option', { value: `link:${i}` }, `${l.text || l.path} — ${l.path}`))) : null,
  d.sections?.length ? h('optgroup', { label: 'Sections' }, d.sections.map((s, i) => h('option', { value: `section:${i}` }, s.heading))) : null);

  const addTarget = h('select', {
    'aria-label': 'Add target',
    onchange: (e) => {
      const v = e.target.value; e.target.value = '';
      if (!v) return;
      const [pi, ti] = v.split(':').map(Number);
      const t = structuredClone(config.presets[pi].targets[ti]);
      if (!t.viewport.height) { const dev = config.devices.find((x) => x.id === t.device); t.viewport.height = dev ? dev.defaults.height : 800; }
      p.targets.push(t); tList.append(targetRow(t)); refresh();
    },
  }, h('option', { value: '' }, '+ Target'), config.presets.map((pr, pi) => h('optgroup', { label: pr.name }, pr.targets.map((t, ti) => h('option', { value: `${pi}:${ti}` }, t.name)))));

  const planJson = h('textarea', { class: 'code' });
  const jsonBox = h('details', { ontoggle: (e) => { if (e.target.open) planJson.value = JSON.stringify(p, null, 2); } },
    h('summary', { class: 'label' }, 'Plan JSON'),
    h('div', { class: 'json-edit' }, planJson, h('div', { class: 'row' }, h('button', {
      class: 'btn small', onclick: () => { try { draft.plan = JSON.parse(planJson.value); saveDraft(); renderPlan(box, status); } catch (err) { toast(err.message, true); } },
    }, 'Apply'))));

  box.replaceChildren(h('section', { class: 'plan' },
    h('div', { class: 'plan-head' }, h('h2', {}, d.title || host(draft.url)), h('span', { class: 'muted' }, p.summary || ''), count),
    h('div', { class: 'plan-cols' },
      h('div', { class: 'panel' }, h('div', { class: 'list-head' }, h('span', { class: 'label' }, 'Features')), fList, h('div', { class: 'add-row' }, addFeature)),
      h('div', { class: 'panel' }, h('div', { class: 'list-head' }, h('span', { class: 'label' }, 'Targets')), tList, h('div', { class: 'add-row' }, addTarget))),
    h('div', { class: 'row' }, shootBtn,
      h('button', { class: 'btn', onclick: async () => {
        const name = prompt('Preset name', draft.prompt.slice(0, 40) || host(draft.url));
        if (!name) return;
        try { await api('presets', { body: { name, description: draft.prompt, targets: cleanPlan(p).targets } }); await loadConfig(); toast('Preset saved'); } catch (err) { toast(err.message, true); }
      } }, 'Save targets as preset'),
      h('button', { class: 'btn ghost', onclick: () => { draft = null; saveDraft(); box.replaceChildren(); status.textContent = ''; } }, 'Clear'),
      h('span', { class: 'grow' })),
    jsonBox));
  refresh();
}

// ---------- run ----------

let poll = null;
let runState = null;
const cards = new Map();

function fileUrl(run, name, download) { return `/api/runs/${run.id}/files/${encodeURIComponent(name)}${download ? '?download=1' : ''}`; }

async function shotAction(sid, action, body = {}) {
  try {
    const r = await api(`runs/${runState.id}/shots/${sid}/${action}`, { body });
    const run = r.run || r;
    if (r.note && r.changed === false) toast(r.note, true); else if (r.note) toast(r.note);
    if (run?.shots) applyRun(run);
    startPoll();
  } catch (err) { toast(err.message, true); }
}

function buildCard(s) {
  const refs = {};
  refs.img = h('img', { alt: '', loading: 'lazy' });
  refs.state = h('div', { class: 'state', hidden: true });
  refs.thumb = h('div', { class: 'thumb checker', onclick: () => openLightbox(s.id) }, refs.img, refs.state);
  refs.title = h('h3');
  refs.dims = h('span', { class: 'mono muted' });
  refs.badges = h('div', { class: 'badges' });
  refs.note = h('div', { class: 'note' });
  refs.approve = h('button', { class: 'btn small', onclick: () => shotAction(s.id, 'approve', { approved: !cards.get(s.id).shot.approved }) }, 'Approve');
  refs.retake = h('button', { class: 'btn small', onclick: () => shotAction(s.id, 'retake') }, 'Retake');
  refs.fix = h('button', { class: 'btn small', hidden: true, onclick: () => shotAction(s.id, 'fix') }, 'Apply fix');
  refs.review = config.llm ? h('button', { class: 'btn small ghost', onclick: () => shotAction(s.id, 'review') }, 'Review') : null;
  refs.versions = h('div', { class: 'versions', hidden: true });
  refs.spec = h('textarea', { class: 'code' });
  refs.specBox = h('div', { class: 'spec-edit', hidden: true }, refs.spec, h('div', { class: 'row' },
    h('button', { class: 'btn small', onclick: () => { try { shotAction(s.id, 'edit', { spec: JSON.parse(refs.spec.value) }); refs.specBox.hidden = true; } catch (err) { toast(err.message, true); } } }, 'Save & retake'),
    h('button', { class: 'btn small ghost', onclick: () => { refs.specBox.hidden = true; } }, 'Cancel')));
  refs.download = h('a', { class: 'menu-item' }, 'Download');
  const menu = h('div', { class: 'menu panel', hidden: true },
    refs.download,
    h('button', { onclick: () => { menu.hidden = true; shotAction(s.id, 'duplicate'); } }, 'Duplicate'),
    h('button', { onclick: () => { menu.hidden = true; const sh = cards.get(s.id).shot; refs.spec.value = JSON.stringify(editable(sh), null, 2); refs.specBox.hidden = false; refs.spec.focus(); } }, 'Edit spec'),
    h('button', { onclick: () => { menu.hidden = true; refs.versions.hidden = !refs.versions.hidden; } }, 'Versions'),
    h('button', { class: 'danger', onclick: async () => { menu.hidden = true; try { applyRun(await api(`runs/${runState.id}/shots/${s.id}`, { method: 'DELETE' })); } catch (err) { toast(err.message, true); } } }, 'Remove'));
  const moreBtn = h('button', { class: 'btn small icon ghost', 'aria-label': 'More', title: 'More', onclick: (e) => { e.stopPropagation(); document.querySelectorAll('.menu').forEach((m) => { if (m !== menu) m.hidden = true; }); menu.hidden = !menu.hidden; } }, '…');
  refs.input = h('input', { placeholder: 'Adjust', 'aria-label': 'Adjust this shot', autocomplete: 'off' });
  const adjust = h('form', { class: 'adjust', onsubmit: (e) => { e.preventDefault(); const v = refs.input.value.trim(); if (!v) return; refs.input.value = ''; shotAction(s.id, 'adjust', { instruction: v }); } }, refs.input);
  refs.root = h('article', { class: 'card panel' }, refs.thumb, h('div', { class: 'card-body' },
    h('div', { class: 'card-title' }, refs.title, refs.dims),
    refs.badges, refs.note,
    h('div', { class: 'actions' }, refs.approve, refs.retake, refs.fix, refs.review, h('span', { class: 'grow' }), h('div', { class: 'more' }, moreBtn, menu)),
    refs.versions, refs.specBox, adjust));
  return refs;
}

const EDIT_KEYS = ['path', 'selector', 'actions', 'hide', 'mode', 'delay', 'scrollOffset', 'device', 'viewport', 'scale', 'style', 'colorScheme', 'mobile', 'statusBar', 'output', 'combo'];
const editable = (s) => Object.fromEntries(EDIT_KEYS.filter((k) => s[k] !== undefined).map((k) => [k, s[k]]));

function updateCard(refs, s, run) {
  const busy = s.status === 'queued' || s.status === 'shooting';
  if (s.thumb) { const src = fileUrl(run, s.thumb); if (refs.img.getAttribute('src') !== src) refs.img.src = src; }
  refs.img.hidden = !s.thumb;
  refs.state.hidden = !(busy || s.status === 'error' || s.reviewing);
  refs.state.className = `state${s.status === 'error' ? ' err' : ''}`;
  refs.state.replaceChildren(...(s.status === 'error' ? [s.error || 'Failed'] : busy ? [h('span', {}, h('span', { class: 'spin' }), s.status === 'queued' ? 'Queued' : 'Shooting')] : s.reviewing ? [h('span', {}, h('span', { class: 'spin' }), 'Reviewing')] : []));
  refs.title.textContent = s.target;
  refs.title.title = s.name;
  refs.dims.textContent = s.width ? `${s.width}×${s.height} · ${s.image.split('.').pop()} · ${fmtBytes(s.bytes)}` : '';
  const badges = [];
  for (const f of s.findings || []) badges.push(h('span', { class: `badge ${f.level === 'error' ? 'error' : f.level === 'warn' ? 'warn' : ''}` }, f.text));
  if (s.ocr?.ratio !== null && s.ocr?.ratio !== undefined && s.ocr.ratio >= 0.6) badges.push(h('span', { class: `badge ${s.ocr.ratio >= 0.8 ? 'good' : ''}`, title: `${s.ocr.wordsAtDisplay}/${s.ocr.words} words read by OCR at ${s.ocr.displayWidth}px on a 2x screen` }, `Legible ${Math.round(s.ocr.ratio * 100)}%`));
  if (s.review?.verdict === 'good') badges.push(h('span', { class: 'badge good' }, 'AI: good'));
  for (const i of s.review?.verdict !== 'good' ? s.review?.issues || [] : []) badges.push(h('span', { class: `badge ${s.review.verdict === 'error' ? 'error' : 'warn'}` }, i));
  refs.badges.replaceChildren(...badges);
  refs.note.textContent = s.note && s.version > 1 ? `v${s.version} · ${s.note}` : '';
  refs.note.title = s.note || '';
  refs.approve.className = `btn small${s.approved ? ' on' : ''}`;
  refs.approve.textContent = s.approved ? '✓ Approved' : 'Approve';
  refs.approve.disabled = s.status !== 'done';
  refs.retake.disabled = busy;
  refs.fix.hidden = !s.review?.patch || busy;
  if (refs.review) refs.review.disabled = busy || s.status !== 'done' || s.reviewing;
  refs.root.classList.toggle('approved', Boolean(s.approved));
  if (s.image) { refs.download.href = fileUrl(run, s.image, true); refs.download.hidden = false; } else refs.download.hidden = true;
  refs.versions.replaceChildren(...(s.history || []).map((v) => h('button', { class: 'btn small', title: v.note, onclick: () => shotAction(s.id, 'restore', { version: v.version }) }, `v${v.version}`)));
}

function applyRun(run) {
  runState = run;
  const groupsEl = $('#groups');
  if (!groupsEl) return;
  const done = run.shots.filter((s) => s.status === 'done').length;
  const approved = run.shots.filter((s) => s.approved).length;
  $('#progress').style.width = `${run.shots.length ? (done / run.shots.length) * 100 : 0}%`;
  $('#count').textContent = `${done}/${run.shots.length} shot · ${approved} approved`;
  $('#zip-approved').toggleAttribute('aria-disabled', approved === 0);
  $('#zip-approved').classList.toggle('disabled', approved === 0);

  const seen = new Set();
  const groups = new Map([...groupsEl.children].map((g) => [g.dataset.feature, g]));
  for (const s of run.shots) {
    seen.add(s.id);
    let g = groups.get(s.feature);
    if (!g) { g = h('section', { class: 'group', dataset: { feature: s.feature } }, h('h2', {}, s.feature), h('div', { class: 'grid' })); groupsEl.append(g); groups.set(s.feature, g); }
    let c = cards.get(s.id);
    if (!c) { c = { refs: buildCard(s) }; cards.set(s.id, c); }
    const grid = $('.grid', g);
    const prev = run.shots[run.shots.indexOf(s) - 1];
    const prevEl = prev && prev.feature === s.feature ? cards.get(prev.id)?.refs.root : null;
    if (c.refs.root.parentNode !== grid || (prevEl ? c.refs.root.previousSibling !== prevEl : c.refs.root !== grid.firstChild)) {
      if (prevEl) prevEl.after(c.refs.root); else grid.prepend(c.refs.root);
    }
    c.shot = s;
    updateCard(c.refs, s, run);
  }
  for (const [sid, c] of cards) if (!seen.has(sid)) { c.refs.root.remove(); cards.delete(sid); }
  for (const g of groupsEl.children) g.hidden = !$('.grid', g).children.length;
  if ($('#lightbox').open) syncLightbox();
}

function startPoll() {
  clearTimeout(poll);
  const tick = async () => {
    if (!runState || !location.hash.startsWith(`#/run/${runState.id}`)) return;
    try { applyRun(await api(`runs/${runState.id}`)); } catch { /* keep polling */ }
    if (runState.shots.some((s) => s.status === 'queued' || s.status === 'shooting' || s.reviewing)) poll = setTimeout(tick, 1200);
  };
  poll = setTimeout(tick, 600);
}

async function renderRun(rid) {
  cards.clear();
  let run;
  try { run = await api(`runs/${rid}`); } catch (err) { view.replaceChildren(h('div', { class: 'empty' }, err.message)); return; }
  runState = run;
  const runAll = async (path, body = {}, msg) => { try { const r = await api(`runs/${run.id}/${path}`, { body }); if (r.shots) applyRun(r); if (msg) toast(msg); startPoll(); } catch (err) { toast(err.message, true); } };
  view.replaceChildren(
    h('div', { class: 'run-head' }, h('h1', {}, host(run.url))),
    h('div', { class: 'run-meta' },
      h('a', { class: 'mono muted', href: run.url, target: '_blank', rel: 'noopener' }, run.url),
      run.prompt ? h('span', { class: 'muted' }, run.prompt) : null,
      h('div', { class: 'progress' }, h('i', { id: 'progress' })), h('span', { class: 'mono muted', id: 'count' })),
    h('div', { class: 'toolbar' },
      h('a', { class: 'btn primary', id: 'zip-approved', href: `/api/runs/${run.id}/zip?approved=1`, onclick: (e) => { if (e.currentTarget.classList.contains('disabled')) { e.preventDefault(); toast('Approve shots first'); } } }, 'Download approved'),
      h('a', { class: 'btn', href: `/api/runs/${run.id}/zip` }, 'Download all'),
      h('button', { class: 'btn', onclick: () => runAll('approve-all', { approved: true }) }, 'Approve all'),
      config.llm ? h('button', { class: 'btn', onclick: () => runAll('review-all', {}, 'Reviewing') }, 'Review all') : null,
      h('button', { class: 'btn', onclick: () => openLightbox(runState.shots.find((s) => s.status === 'done')?.id) }, 'Step through'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn ghost', onclick: () => {
        draft = { url: run.url, prompt: run.prompt, plan: structuredClone(run.plan), discoveryId: null, discovery: run.discovery };
        saveDraft(); location.hash = '#/';
      } }, 'Re-plan'),
      h('button', { class: 'btn ghost', onclick: async () => {
        const name = prompt('Preset name', run.prompt.slice(0, 40) || host(run.url));
        if (!name) return;
        try { await api(`runs/${run.id}/preset`, { body: { name } }); await loadConfig(); toast('Preset saved'); } catch (err) { toast(err.message, true); }
      } }, 'Save as preset')),
    h('div', { id: 'groups' }));
  applyRun(run);
  startPoll();
}

// ---------- lightbox ----------

let lbId = null;
const lb = $('#lightbox');
const lbShots = () => (runState?.shots || []).filter((s) => s.status === 'done' || s.image);

function openLightbox(sid) {
  if (!sid) return toast('Nothing shot yet');
  lbId = sid;
  if (!lb.open) lb.showModal();
  syncLightbox();
}

function syncLightbox() {
  const s = runState.shots.find((x) => x.id === lbId);
  if (!s) { lb.close(); return; }
  const list = lbShots();
  const i = list.indexOf(s);
  $('#lb-title').textContent = s.name;
  $('#lb-meta').textContent = `${i + 1}/${list.length}${s.width ? ` · ${s.width}×${s.height}` : ''}${s.status !== 'done' ? ` · ${s.status}` : ''}`;
  if (s.image) { const src = fileUrl(runState, s.image); if ($('#lb-img').getAttribute('src') !== src) $('#lb-img').src = src; }
  const ap = $('[data-lb=approve]');
  ap.textContent = s.approved ? '✓ Approved' : 'Approve';
  ap.className = `btn${s.approved ? ' on' : ''}`;
}

function lbStep(d) {
  const list = lbShots();
  const i = list.findIndex((s) => s.id === lbId);
  const next = list[(i + d + list.length) % list.length];
  if (next) { lbId = next.id; $('.lb-stage').classList.remove('zoom'); syncLightbox(); }
}

lb.addEventListener('click', (e) => {
  const b = e.target.closest('[data-lb]');
  if (e.target === lb) return lb.close();
  if (!b) return;
  const s = runState.shots.find((x) => x.id === lbId);
  ({ prev: () => lbStep(-1), next: () => lbStep(1), close: () => lb.close(),
    approve: () => shotAction(s.id, 'approve', { approved: !s.approved }),
    retake: () => shotAction(s.id, 'retake') })[b.dataset.lb]?.();
});
$('#lb-img').addEventListener('click', () => $('.lb-stage').classList.toggle('zoom'));
lb.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return;
  const s = runState?.shots.find((x) => x.id === lbId);
  if (e.key === 'ArrowRight') lbStep(1);
  else if (e.key === 'ArrowLeft') lbStep(-1);
  else if (e.key === 'a' && s) shotAction(s.id, 'approve', { approved: !s.approved });
  else if (e.key === 'r' && s) shotAction(s.id, 'retake');
  else if (e.key === 'z') $('.lb-stage').classList.toggle('zoom');
});
$('#lb-adjust').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = e.target.instruction;
  if (!input.value.trim()) return;
  shotAction(lbId, 'adjust', { instruction: input.value.trim() });
  input.value = '';
});

document.addEventListener('click', (e) => { if (!e.target.closest('.more')) document.querySelectorAll('.menu').forEach((m) => { m.hidden = true; }); });

// ---------- runs list ----------

async function renderRuns() {
  const list = await api('runs');
  view.replaceChildren(h('h1', {}, 'Runs'), list.length ? h('div', { class: 'runs' }, list.map((r) => h('a', { class: 'run-card panel', href: `#/run/${r.id}` },
    h('div', { class: 'cover checker' }, r.cover ? h('img', { src: `/api/runs/${r.id}/files/${encodeURIComponent(r.cover)}`, alt: '', loading: 'lazy' }) : null),
    h('div', { class: 'b' },
      h('div', { class: 'u' }, host(r.url)),
      h('div', { class: 'p' }, r.prompt || '—'),
      h('div', { class: 'row' }, h('span', { class: 'mono muted' }, `${r.done}/${r.shots} · ${r.approved} approved · ${new Date(r.createdAt).toLocaleString()}`), h('span', { class: 'grow' }),
        h('button', { class: 'btn small ghost', onclick: async (e) => { e.preventDefault(); if (!confirm(`Delete run for ${host(r.url)}?`)) return; await api(`runs/${r.id}`, { method: 'DELETE' }); renderRuns(); } }, 'Delete')))))) : h('div', { class: 'empty' }, 'No runs yet.'));
}

// ---------- presets ----------

function renderPresets() {
  const describe = h('textarea', { rows: 2, placeholder: 'iPhone and iPad mockups plus a 1200×630 social card, dark mode', 'aria-label': 'Describe a preset' });
  const draftBox = h('div');
  const genBtn = h('button', { class: 'btn primary' }, 'Generate');
  genBtn.onclick = async () => {
    if (!describe.value.trim()) return describe.focus();
    genBtn.disabled = true;
    try { const p = await api('presets/generate', { body: { text: describe.value } }); presetEditor(draftBox, p); } catch (err) { toast(err.message, true); } finally { genBtn.disabled = false; }
  };

  const devCards = config.devices.map((d) => h('div', { class: 'device panel' },
    h('img', { src: `/api/devices/${d.id}/image`, alt: d.label }),
    h('div', {}, h('div', { class: 'tname' }, d.label), h('div', { class: 'mono muted' }, `${d.kind} · ${d.defaults.width}×${d.defaults.height} @${d.defaults.scale}x`)),
    d.builtin ? null : h('button', { class: 'btn small ghost', onclick: async () => { if (!confirm(d.overrides ? `Remove your ${d.label} template and use the built-in one?` : `Remove ${d.label}?`)) return; try { await api(`devices/${d.id}`, { method: 'DELETE' }); await loadConfig(); renderPresets(); } catch (err) { toast(err.message, true); } } }, 'Remove')));
  const upName = h('input', { placeholder: 'Name', 'aria-label': 'Template name' });
  const upFile = h('input', { type: 'file', accept: 'image/png', 'aria-label': 'Template PNG' });
  const upload = h('div', { class: 'upload panel' }, h('span', { class: 'label' }, 'Add template'), upName, upFile, h('button', {
    class: 'btn small', onclick: async () => {
      const file = upFile.files[0];
      if (!file || !upName.value.trim()) return toast('Name and PNG needed', true);
      try { await api(`devices?name=${encodeURIComponent(upName.value.trim())}`, { body: file }); await loadConfig(); renderPresets(); toast('Template added'); } catch (err) { toast(err.message, true); }
    },
  }, 'Upload'));

  view.replaceChildren(
    h('h1', {}, 'Presets'),
    h('div', { class: 'new-preset panel' }, describe, h('div', { class: 'row' }, h('span', { class: 'grow' }), genBtn), draftBox),
    h('div', { class: 'presets' }, config.presets.map(presetCard)),
    h('section', { class: 'section' }, h('div', { class: 'row' }, h('h2', {}, 'Device templates')), h('div', { class: 'devices' }, devCards, upload)));
}

function presetCard(p) {
  const box = h('div');
  return h('div', { class: 'preset panel' },
    h('div', { class: 'row' }, h('h3', { class: 'grow' }, p.name), p.builtin ? h('span', { class: 'tag' }, 'built-in') : null),
    p.description ? h('div', { class: 'd' }, p.description) : null,
    h('div', { class: 'tchips' }, p.targets.map((t) => h('span', { class: 'tag', title: targetTags(normalizeForTags(t)).map((x) => x.textContent).join(' ') }, t.name))),
    h('div', { class: 'row' },
      h('button', { class: 'btn small primary', onclick: () => { location.hash = `#/?preset=${p.id}`; } }, 'Use'),
      h('button', { class: 'btn small', onclick: () => presetEditor(box, p.builtin ? { ...p, id: undefined, name: `${p.name} copy` } : p) }, p.builtin ? 'Copy' : 'Edit'),
      p.builtin ? null : h('button', { class: 'btn small ghost', onclick: async () => { if (!confirm(`Delete ${p.name}?`)) return; await api(`presets/${p.id}`, { method: 'DELETE' }); await loadConfig(); renderPresets(); } }, 'Delete')),
    box);
}

const normalizeForTags = (t) => ({ scale: 1, ...t, viewport: { height: '', ...t.viewport } });

function presetEditor(box, p) {
  const name = h('input', { value: p.name || '', 'aria-label': 'Preset name', placeholder: 'Name' });
  const desc = h('input', { value: p.description || '', 'aria-label': 'Description', placeholder: 'Description' });
  const json = h('textarea', { class: 'code' }, JSON.stringify(p.targets || [], null, 2));
  box.replaceChildren(h('div', { class: 'spec-edit' }, name, desc, json, h('div', { class: 'row' },
    h('button', { class: 'btn small primary', onclick: async () => {
      try {
        const targets = JSON.parse(json.value);
        await api(p.id ? `presets/${p.id}` : 'presets', { method: p.id ? 'PUT' : 'POST', body: { name: name.value, description: desc.value, targets } });
        await loadConfig(); renderPresets(); toast('Preset saved');
      } catch (err) { toast(err.message, true); }
    } }, 'Save'),
    h('button', { class: 'btn small ghost', onclick: () => box.replaceChildren() }, 'Cancel'),
    p.source ? h('span', { class: 'mono muted' }, p.source === 'llm' ? 'LLM draft' : 'Rule draft') : null)));
  name.focus();
}

// ---------- router ----------

async function route() {
  clearTimeout(poll);
  if (lb.open) lb.close();
  const hash = location.hash || '#/';
  const [path, query] = hash.slice(1).split('?');
  const tab = path.startsWith('/run') && !path.startsWith('/runs') ? 'runs' : path === '/runs' ? 'runs' : path === '/presets' ? 'presets' : 'shoot';
  document.querySelectorAll('.tabs a').forEach((a) => { if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  try {
    if (path.startsWith('/run/')) return await renderRun(path.split('/')[2]);
    if (path === '/runs') return await renderRuns();
    if (path === '/presets') return renderPresets();
    const params = new URLSearchParams(query || '');
    renderShoot({ presetId: params.get('preset') || undefined });
  } catch (err) {
    view.replaceChildren(h('div', { class: 'empty' }, err.message));
  }
}

window.addEventListener('hashchange', route);
loadConfig().then(route).catch((err) => { view.replaceChildren(h('div', { class: 'empty' }, err.message)); });
