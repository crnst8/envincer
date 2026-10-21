// sharp side: put raw screenshots into device frames or a browser window, then size them for output.
const sharp = require('sharp');

const MAX_SIDE = 8000;

// iOS-style status bar (time, signal, battery) in the page's own top colour.
async function statusBar(raw, cssHeight, scale) {
  const { width: W } = await sharp(raw).metadata();
  const H = Math.round(cssHeight * scale);
  const { dominant } = await sharp(raw).extract({ left: 0, top: 0, width: W, height: Math.min(4, H) }).stats();
  const bg = `rgb(${dominant.r},${dominant.g},${dominant.b})`;
  const fg = 0.299 * dominant.r + 0.587 * dominant.g + 0.114 * dominant.b > 140 ? '#000' : '#fff';
  const u = scale, cy = H * 0.56, w = W / u;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="${bg}"/>
    <text x="${w * 0.155 * u}" y="${cy + 6 * u}" font-family="Helvetica, Arial, sans-serif" font-weight="600" font-size="${17 * u}" fill="${fg}" text-anchor="middle">9:41</text>
    <g fill="${fg}" transform="translate(${W - 92 * u}, ${cy - 6 * u}) scale(${u})">
      <rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="6" width="3" height="6" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/>
      <path d="M31 3.2a11 11 0 0 1 15 0l-1.6 1.7a8.6 8.6 0 0 0-11.8 0zM34.3 6.6a6.4 6.4 0 0 1 8.4 0L38.5 11z"/>
      <rect x="53" y="0.5" width="24" height="11.5" rx="3.5" fill="none" stroke="${fg}" stroke-opacity="0.45"/><rect x="55" y="2.5" width="20" height="7.5" rx="2"/><rect x="78.5" y="4" width="1.6" height="4.5" rx="0.8" fill-opacity="0.45"/>
    </g>
  </svg>`;
  const meta = await sharp(raw).metadata();
  return sharp({ create: { width: W, height: H + meta.height, channels: 4, background: bg } })
    .composite([{ input: Buffer.from(svg), left: 0, top: 0 }, { input: raw, left: 0, top: H }]).png().toBuffer();
}

// Raw screenshot inside a device template, at the scale where the screen matches the screenshot width.
async function frameDevice(raw, dev, { bar = 0, scale = 1 } = {}) {
  if (bar) raw = await statusBar(raw, bar, scale);
  const meta = await sharp(raw).metadata();
  const s = Math.min(meta.width / dev.screen.width, MAX_SIDE / dev.frame.width, MAX_SIDE / dev.frame.height);
  const W = Math.round(dev.frame.width * s), H = Math.round(dev.frame.height * s);
  const sw = Math.round(dev.screen.width * s), sh = Math.round(dev.screen.height * s);
  const screen = await sharp(raw).resize(sw, sh, { fit: 'cover', position: 'top' }).ensureAlpha()
    .composite([{ input: await sharp(dev.maskPng).resize(sw, sh, { fit: 'fill' }).toBuffer(), blend: 'dest-in' }])
    .png().toBuffer();
  const frame = await sharp(dev.file).resize(W, H, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();
  return sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: screen, left: Math.round(dev.screen.left * s), top: Math.round(dev.screen.top * s) }, { input: frame, left: 0, top: 0 }])
    .png().toBuffer();
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// A plain browser window (title bar, three dots, address pill) around the screenshot.
async function frameBrowser(raw, { scale = 1, dark = false, url = '' } = {}) {
  const meta = await sharp(raw).metadata();
  const W = meta.width, bar = Math.round(38 * scale), r = Math.round(10 * scale), H = meta.height + bar;
  const c = dark ? { bar: '#26272b', line: '#3a3b40', pill: '#1b1c1f', text: '#a0a3ab' } : { bar: '#ececee', line: '#d6d6da', pill: '#ffffff', text: '#6b6e76' };
  let host = url; try { host = new URL(url).host; } catch {}
  const dot = (i, fill) => `<circle cx="${(18 + i * 20) * scale}" cy="${bar / 2}" r="${6 * scale}" fill="${fill}"/>`;
  const pillW = Math.min(W * 0.42, 420 * scale);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" rx="${r}" fill="${c.bar}"/>
    <rect y="${bar - 1}" width="${W}" height="1" fill="${c.line}"/>
    ${dot(0, '#ff5f57')}${dot(1, '#febc2e')}${dot(2, '#28c840')}
    <rect x="${(W - pillW) / 2}" y="${bar * 0.2}" width="${pillW}" height="${bar * 0.6}" rx="${bar * 0.3}" fill="${c.pill}"/>
    <text x="${W / 2}" y="${bar / 2 + 4.5 * scale}" font-family="Helvetica, Arial, sans-serif" font-size="${12.5 * scale}" fill="${c.text}" text-anchor="middle">${esc(host)}</text>
  </svg>`;
  const clip = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" rx="${r}" fill="#000"/></svg>`);
  return sharp(Buffer.from(svg)).composite([{ input: raw, left: 0, top: bar }, { input: clip, blend: 'dest-in' }]).png().toBuffer();
}

async function rounded(raw, radius) {
  const { width: W, height: H } = await sharp(raw).metadata();
  const clip = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" rx="${radius}" fill="#000"/></svg>`);
  return sharp(raw).ensureAlpha().composite([{ input: clip, blend: 'dest-in' }]).png().toBuffer();
}

async function withShadow(img, blur) {
  const { width: W, height: H } = await sharp(img).metadata();
  const pad = blur * 3;
  const alpha = await sharp(img).ensureAlpha().extractChannel(3).toBuffer();
  const shadow = await sharp({ create: { width: W, height: H, channels: 3, background: '#000' } })
    .joinChannel(alpha).png().toBuffer();
  const soft = await sharp(shadow).extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .blur(blur).ensureAlpha().linear([1, 1, 1, 0.35], [0, 0, 0, 0]).png().toBuffer();
  return sharp(soft).composite([{ input: img, left: pad, top: Math.round(pad - blur * 0.6) }]).png().toBuffer();
}

// Laptop with a phone overlapping its lower right corner.
async function combo(big, small) {
  const a = await sharp(big).metadata();
  const ph = Math.round(a.height * 0.72);
  const phone = await sharp(small).resize({ height: ph }).png().toBuffer();
  const p = await sharp(phone).metadata();
  const W = a.width + Math.round(p.width * 0.3), H = a.height + Math.round(ph * 0.04);
  return sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: big, left: 0, top: 0 }, { input: phone, left: W - p.width, top: H - ph }]).png().toBuffer();
}

const parseColor = (bg) => {
  if (!bg || bg === 'transparent') return { r: 0, g: 0, b: 0, alpha: 0 };
  return bg;
};

// Padding, background, exact canvas size, output width and file format.
async function finish(img, out = {}, { framed = false } = {}) {
  const bg = parseColor(out.background);
  const pad = Math.max(0, Number(out.padding) || 0);
  let pipeline;
  if (out.width && out.height) {
    const fit = out.fit || (framed ? 'contain' : 'cover');
    const inner = await sharp(img).resize(out.width - pad * 2, out.height - pad * 2, { fit, position: 'top', background: bg, kernel: 'lanczos3' }).png().toBuffer();
    pipeline = sharp(inner).extend({ top: pad, bottom: pad, left: pad, right: pad, background: bg });
  } else if (out.width) {
    const inner = await sharp(img).resize({ width: Math.max(16, out.width - pad * 2), kernel: 'lanczos3' }).png().toBuffer();
    pipeline = sharp(inner).extend({ top: pad, bottom: pad, left: pad, right: pad, background: bg });
  } else {
    pipeline = sharp(img).extend({ top: pad, bottom: pad, left: pad, right: pad, background: bg });
  }
  let buf = await pipeline.png().toBuffer();
  if (out.background && out.background !== 'transparent') buf = await sharp(buf).flatten({ background: out.background }).png().toBuffer();
  const fmt = out.format || 'png';
  let s = sharp(buf);
  if (fmt === 'jpeg' || fmt === 'jpg') s = s.flatten({ background: out.background && out.background !== 'transparent' ? out.background : '#ffffff' }).jpeg({ quality: 90, mozjpeg: true });
  else if (fmt === 'webp') s = s.webp({ quality: 90 });
  else s = s.png({ compressionLevel: 9, adaptiveFiltering: true });
  const { data, info } = await s.toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height, ext: fmt === 'jpg' ? 'jpeg' : fmt };
}

// Raw screenshot → styled image (before output sizing).
async function style(raw, shot, dev, url) {
  if (dev) return frameDevice(raw, dev, { bar: shot.statusBar || 0, scale: shot.scale });
  if (shot.style === 'browser') return frameBrowser(raw, { scale: shot.scale, dark: shot.colorScheme === 'dark', url });
  if (shot.style === 'rounded') return rounded(raw, Math.round(12 * shot.scale));
  return raw;
}

module.exports = { style, finish, combo, withShadow };
