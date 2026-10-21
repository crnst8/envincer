// Tesseract legibility check: how much of the text that reads at full resolution
// still reads at the size the image will be displayed.
const { spawn } = require('node:child_process');
const sharp = require('sharp');
const { limiter } = require('./util');

const TESSERACT = process.env.TESSERACT_PATH || 'tesseract';
const limit = limiter(2);
let available = null;

function run(buf) {
  return limit(() => new Promise((resolve, reject) => {
    const p = spawn(TESSERACT, ['stdin', 'stdout', '--psm', '3', 'tsv'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`tesseract exited ${code}`))));
    p.stdin.end(buf);
  }));
}

function words(tsv) {
  const out = [];
  for (const line of tsv.split('\n').slice(1)) {
    const c = line.split('\t');
    if (c[0] !== '5') continue;
    const conf = Number(c[10]), text = (c[11] || '').trim();
    if (text.length >= 2 && /[A-Za-z0-9]/.test(text)) out.push({ text, conf });
  }
  return out;
}

async function isAvailable() {
  if (available === null) available = await new Promise((r) => { const p = spawn(TESSERACT, ['--version'], { stdio: 'ignore' }); p.on('error', () => r(false)); p.on('close', (c) => r(c === 0)); });
  return available;
}

// raw: the unframed screenshot; cssWidth: the page's CSS width;
// shownWidth: how wide the screenshot itself appears once the final image is displayed
// (smaller than the display width when a frame or padding surrounds it).
async function legibility({ raw, cssWidth, shownWidth, displayWidth }) {
  const stats = await sharp(raw).stats();
  const spread = Math.max(...stats.channels.slice(0, 3).map((c) => c.stdev));
  const blank = spread < 4;
  if (!(await isAvailable())) return { blank, available: false };

  // Reference: the page at 1.5 px per CSS px, a little sharper than a 1x browser window.
  const ref = await sharp(raw).resize({ width: Math.round(Math.min(cssWidth * 1.5, 2400)) }).greyscale().png().toBuffer();
  const shown = await sharp(raw).resize({ width: Math.max(32, Math.round(shownWidth)) }).greyscale().png().toBuffer();
  const [a, b] = await Promise.all([run(ref).then(words), run(shown).then(words)]);
  const good = (ws) => ws.filter((w) => w.conf >= 60);
  const refN = good(a).length, shownN = good(b).length;
  const ratio = refN >= 8 ? Math.min(1, shownN / refN) : null;
  return {
    available: true,
    blank,
    words: refN,
    wordsAtDisplay: shownN,
    displayWidth: Math.round(displayWidth),
    shownWidth: Math.round(shownWidth),
    ratio,
    meanConf: b.length ? Math.round(b.reduce((s, w) => s + Math.max(0, w.conf), 0) / b.length) : null,
    text: good(a).map((w) => w.text).join(' ').slice(0, 600),
  };
}

module.exports = { legibility, isAvailable };
