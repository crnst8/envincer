// OpenCode Go client. One function, three wire formats, chosen by model family.
//
// Model choice (researched 2026-10-21 against opencode.ai/docs/go):
//   default  claude-haiku-5-5 — Messages API, image input, $0.10/$0.50 per 1M tokens, fast.
//   runner-up gpt-6-luna      — Responses API, same price; switch with ENVINCER_MODEL.
// Planning, adjusting and reviewing are short JSON tasks with one small image,
// so the cheapest fast vision model wins over larger reasoning models.
const BASE = () => (process.env.OPENCODE_BASE_URL || 'https://opencode.ai/inference/go').replace(/\/$/, '');
const MODEL = () => process.env.ENVINCER_MODEL || 'claude-haiku-5-5';
const KEY = () => process.env.OPENCODE_API_KEY || '';
const UA = 'envincer/0.1';
const TIMEOUT = 90000;

function apiFor(model) {
  if (process.env.ENVINCER_MODEL_API) return process.env.ENVINCER_MODEL_API;
  if (/^(claude|qwen|minimax)/.test(model)) return 'messages';
  if (/^(gpt|grok|muse)/.test(model)) return 'responses';
  return 'chat';
}

const enabled = () => Boolean(KEY());

function request(api, model, { system, text, images, maxTokens }) {
  const b64 = (buf) => buf.toString('base64');
  if (api === 'messages') {
    return {
      url: `${BASE()}/anthropic/v1/messages`,
      body: {
        model, max_tokens: maxTokens, system,
        messages: [{ role: 'user', content: [...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64(i) } })), { type: 'text', text }] }],
      },
      read: (j) => (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''),
    };
  }
  if (api === 'responses') {
    return {
      url: `${BASE()}/openai/v1/responses`,
      body: {
        model, instructions: system, max_output_tokens: maxTokens,
        input: [{ role: 'user', content: [{ type: 'input_text', text }, ...images.map((i) => ({ type: 'input_image', image_url: `data:image/jpeg;base64,${b64(i)}` }))] }],
      },
      read: (j) => j.output_text || (j.output || []).flatMap((o) => o.content || []).filter((c) => c.text).map((c) => c.text).join(''),
    };
  }
  return {
    url: `${BASE()}/openai/v1/chat/completions`,
    body: {
      model, max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, { role: 'user', content: images.length ? [{ type: 'text', text }, ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64(i)}` } }))] : text }],
    },
    read: (j) => j.choices?.[0]?.message?.content || '',
  };
}

// session: a stable id per run, sent as x-opencode-session for routing and prompt caching.
async function ask({ system, text, images = [], maxTokens = 4000, session = 'envincer' }) {
  if (!enabled()) throw new Error('OPENCODE_API_KEY is not set');
  const model = MODEL();
  const api = apiFor(model);
  const attempt = async (imgs) => {
    const r = request(api, model, { system, text, images: imgs, maxTokens });
    const res = await fetch(r.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${KEY()}`,
        'x-api-key': KEY(),
        'anthropic-version': '2023-06-01',
        'user-agent': UA,
        'x-opencode-session': session,
      },
      body: JSON.stringify(r.body),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const body = await res.text();
    let j; try { j = JSON.parse(body); } catch { j = null; }
    if (!res.ok) {
      const msg = j?.error?.message || j?.message || body.slice(0, 200);
      const err = new Error(`OpenCode ${res.status}: ${msg}`);
      err.status = res.status;
      throw err;
    }
    return r.read(j || {});
  };
  try {
    return await attempt(images);
  } catch (err) {
    // A text-only model rejects image parts; retry once without them.
    if (images.length && err.status === 400 && /image|vision|multimodal|content/i.test(err.message)) return attempt([]);
    throw err;
  }
}

module.exports = { ask, enabled, model: MODEL };
