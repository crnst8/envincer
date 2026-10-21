// Playwright side: discover a page's features and take one raw screenshot per shot spec.
const { chromium, devices: pwDevices } = require('playwright-core');
const { limiter } = require('./util');

const CHROMIUM = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
const MAX_FULLPAGE = 16000;
const limit = limiter(Number(process.env.ENVINCER_CONCURRENCY) || 2);

let browserP = null;
function browser() {
  if (!browserP) {
    browserP = chromium.launch({ executablePath: CHROMIUM, headless: true, args: ['--hide-scrollbars', '--font-render-hinting=none'] })
      .then((b) => { b.on('disconnected', () => { browserP = null; }); return b; })
      .catch((err) => { browserP = null; throw err; });
  }
  return browserP;
}

async function close() { if (browserP) { const b = await browserP.catch(() => null); browserP = null; await b?.close(); } }

const UA = {
  phone: pwDevices['iPhone 15'].userAgent,
  tablet: pwDevices['iPad Pro 11'].userAgent,
};

const resolve = (base, p) => { try { return new URL(p || '/', base).href; } catch { return base; } };

const BASE_CSS = `
  *, *::before, *::after { caret-color: transparent !important; }
  html { scrollbar-width: none !important; }
  ::-webkit-scrollbar { display: none !important; }
`;

// Hides fixed/sticky overlays that look like cookie or consent banners.
function hideBannersInPage() {
  const re = /cookie|consent|gdpr|onetrust|cmp-|truste|didomi|usercentrics|cookiebot|privacy-banner/i;
  let n = 0;
  for (const el of document.querySelectorAll('body *')) {
    const s = getComputedStyle(el);
    if (s.position !== 'fixed' && s.position !== 'sticky') continue;
    const sig = `${el.id} ${el.className} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('role') || ''}`;
    const text = (el.innerText || '').slice(0, 400);
    if (re.test(sig) || (/cookie|consent/i.test(text) && text.length < 1200)) { el.style.setProperty('display', 'none', 'important'); n++; }
  }
  return n;
}

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.evaluate(async () => {
    await document.fonts?.ready;
    const imgs = [...document.images].filter((i) => !i.complete);
    await Promise.race([Promise.all(imgs.map((i) => new Promise((r) => { i.onload = i.onerror = r; }))), new Promise((r) => setTimeout(r, 4000))]);
  }).catch(() => {});
}

// Scroll every lazy-loaded section into view once so full-page shots are not half empty.
async function primeLazy(page) {
  await page.evaluate(async () => {
    const step = innerHeight * 0.8;
    for (let y = 0; y < Math.min(document.documentElement.scrollHeight, 16000); y += step) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); }
    scrollTo(0, 0);
  }).catch(() => {});
}

async function runActions(page, base, actions = []) {
  for (const a of actions) {
    const t = 10000;
    switch (a.type) {
      case 'goto': await page.goto(resolve(base, a.value || a.path), { waitUntil: 'load', timeout: 30000 }); await settle(page); break;
      case 'click': await page.locator(a.selector).first().click({ timeout: t }); break;
      case 'hover': await page.locator(a.selector).first().hover({ timeout: t }); break;
      case 'fill': case 'type': await page.locator(a.selector).first().fill(String(a.value ?? ''), { timeout: t }); break;
      case 'press': await (a.selector ? page.locator(a.selector).first().press(a.value || 'Enter', { timeout: t }) : page.keyboard.press(a.value || 'Enter')); break;
      case 'select': await page.locator(a.selector).first().selectOption(String(a.value ?? ''), { timeout: t }); break;
      case 'scroll':
        if (a.selector) await page.locator(a.selector).first().scrollIntoViewIfNeeded({ timeout: t });
        else await page.evaluate((y) => scrollTo(0, y), Number(a.value) || 0);
        break;
      case 'waitFor': await page.locator(a.selector).first().waitFor({ state: 'visible', timeout: Number(a.ms) || 15000 }); break;
      case 'wait': await page.waitForTimeout(Math.min(Number(a.ms ?? a.value) || 500, 15000)); break;
      default: throw new Error(`unknown action "${a.type}"`);
    }
    if (a.type !== 'wait') await page.waitForTimeout(250);
  }
}

function contextOptions(shot, kind) {
  const mobile = shot.mobile ?? (kind ? kind !== 'laptop' : shot.viewport.width < 768);
  return {
    viewport: { width: shot.viewport.width, height: shot.viewport.height },
    deviceScaleFactor: shot.scale,
    isMobile: mobile,
    hasTouch: mobile,
    userAgent: mobile ? (kind === 'tablet' || shot.viewport.width >= 700 ? UA.tablet : UA.phone) : undefined,
    colorScheme: shot.colorScheme === 'dark' ? 'dark' : 'light',
    reducedMotion: 'reduce',
    ignoreHTTPSErrors: true,
    locale: shot.locale || 'en-US',
  };
}

// Takes the raw (unframed) screenshot for one shot spec and runs DOM checks.
async function shoot(shot, { url, setup = [], headers, kind, autoHideBanners = true, onStart } = {}) {
  return limit(async () => {
    onStart?.();
    const b = await browser();
    const ctx = await b.newContext({ ...contextOptions(shot, kind), extraHTTPHeaders: headers || undefined });
    const consoleErrors = [];
    const failed = [];
    try {
      const page = await ctx.newPage();
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
      page.on('pageerror', (e) => consoleErrors.push(String(e.message).slice(0, 200)));
      page.on('response', (r) => { if (r.status() >= 400 && ['image', 'stylesheet', 'font', 'script'].includes(r.request().resourceType())) failed.push(`${r.status()} ${r.url().slice(0, 120)}`); });
      await page.addInitScript((css) => {
        const add = () => { const s = document.createElement('style'); s.dataset.envincer = '1'; s.textContent = css; document.documentElement.appendChild(s); };
        if (document.documentElement) add(); else document.addEventListener('DOMContentLoaded', add);
      }, BASE_CSS);

      await runActions(page, url, setup);
      const target = resolve(url, shot.path);
      const resp = await page.goto(target, { waitUntil: 'load', timeout: 45000 });
      await settle(page);
      if (shot.mode === 'fullpage') await primeLazy(page);

      // Locators rather than a stylesheet, so Playwright selectors (text=, :has-text) work here too.
      for (const sel of (shot.hide || []).filter(Boolean)) {
        await page.locator(sel).evaluateAll((els) => els.forEach((e) => e.style.setProperty('display', 'none', 'important'))).catch(() => {});
      }
      let bannersHidden = 0;
      if (autoHideBanners) bannersHidden = await page.evaluate(hideBannersInPage).catch(() => 0);

      await runActions(page, url, shot.actions);
      if (shot.selector && shot.mode !== 'element') {
        const loc = page.locator(shot.selector).first();
        await loc.scrollIntoViewIfNeeded({ timeout: 10000 });
        await loc.evaluate((el, off) => scrollTo(0, Math.max(0, el.getBoundingClientRect().top + scrollY - off)), Number(shot.scrollOffset) || 24).catch(() => {});
      }
      await settle(page);
      if (shot.delay) await page.waitForTimeout(Math.min(shot.delay, 15000));

      let buf;
      if (shot.mode === 'element' && shot.selector) {
        buf = await page.locator(shot.selector).first().screenshot({ animations: 'disabled', timeout: 15000 });
      } else if (shot.mode === 'fullpage') {
        const h = await page.evaluate(() => document.documentElement.scrollHeight);
        buf = await page.screenshot({ fullPage: true, animations: 'disabled', clip: h > MAX_FULLPAGE ? { x: 0, y: 0, width: shot.viewport.width, height: MAX_FULLPAGE } : undefined });
      } else {
        buf = await page.screenshot({ animations: 'disabled' });
      }

      const dom = await page.evaluate(() => {
        const vw = innerWidth;
        const overflowX = document.documentElement.scrollWidth - vw;
        const broken = [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && i.getBoundingClientRect().width > 0).length;
        let clipped = 0;
        for (const el of document.querySelectorAll('h1,h2,h3,h4,p,a,button,span,li,td,label')) {
          if (!el.childElementCount && el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflow !== 'visible' && el.textContent.trim()) clipped++;
        }
        return { overflowX: overflowX > 1 ? overflowX : 0, brokenImages: broken, clippedText: clipped, title: document.title };
      }).catch(() => ({}));

      return {
        buffer: buf,
        checks: { status: resp?.status() ?? null, finalUrl: page.url(), ...dom, bannersHidden, consoleErrors: consoleErrors.slice(0, 10), failedRequests: failed.slice(0, 10) },
      };
    } finally {
      await ctx.close().catch(() => {});
    }
  });
}

// Collects what a planner needs to pick features: links, sections, toggles, a preview image.
async function discover(url, { setup = [], headers } = {}) {
  return limit(async () => {
    const b = await browser();
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true, extraHTTPHeaders: headers || undefined });
    try {
      const page = await ctx.newPage();
      await runActions(page, url, setup);
      const resp = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
      await settle(page);
      await page.evaluate(hideBannersInPage).catch(() => 0);
      const info = await page.evaluate(() => {
        const origin = location.origin;
        const text = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        const cssPath = (el) => {
          if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `#${el.id}`;
          const t = text(el);
          const tag = el.tagName.toLowerCase();
          return t ? `${tag}:has-text("${t.replace(/"/g, '\\"').slice(0, 40)}")` : tag;
        };
        const seen = new Set();
        const links = [];
        for (const a of document.querySelectorAll('nav a[href], header a[href], [role=navigation] a[href], aside a[href], footer a[href], main a[href]')) {
          let u; try { u = new URL(a.href); } catch { continue; }
          if (u.origin !== origin || u.hash && u.pathname === location.pathname) continue;
          const p = u.pathname + u.search;
          if (seen.has(p) || /\.(pdf|zip|png|jpe?g|svg|xml|txt)$/i.test(u.pathname)) continue;
          seen.add(p);
          links.push({ path: p, text: text(a), inNav: !!a.closest('nav,header,[role=navigation]') });
          if (links.length >= 40) break;
        }
        const sections = [];
        for (const el of document.querySelectorAll('main section, body > section, [id]:is(section,article,div), h1, h2, h3')) {
          const r = el.getBoundingClientRect();
          if (r.height < 40 && !/^H\d$/.test(el.tagName)) continue;
          const heading = /^H\d$/.test(el.tagName) ? text(el) : text(el.querySelector('h1,h2,h3') || el).slice(0, 50);
          if (!heading) continue;
          sections.push({ selector: cssPath(el), heading, top: Math.round(r.top + scrollY), height: Math.round(r.height) });
          if (sections.length >= 30) break;
        }
        const toggles = [];
        for (const el of document.querySelectorAll('[aria-expanded], [role=tab], [aria-haspopup], [data-theme-toggle], button[aria-label*="theme" i], button[aria-label*="dark" i]')) {
          const t = text(el);
          if (!t) continue;
          toggles.push({ selector: cssPath(el), text: t, role: el.getAttribute('role') || el.tagName.toLowerCase() });
          if (toggles.length >= 20) break;
        }
        return {
          title: document.title,
          description: document.querySelector('meta[name=description]')?.content || '',
          height: document.documentElement.scrollHeight,
          darkModeCss: [...document.styleSheets].some((s) => { try { return [...s.cssRules].some((r) => r.media && /prefers-color-scheme:\s*dark/.test(r.media.mediaText)); } catch { return false; } }),
          links, sections, toggles,
          text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 1500),
        };
      });
      const preview = await page.screenshot({ type: 'jpeg', quality: 60 });
      return { url: page.url(), status: resp?.status() ?? null, ...info, preview };
    } finally {
      await ctx.close().catch(() => {});
    }
  });
}

module.exports = { shoot, discover, close };
