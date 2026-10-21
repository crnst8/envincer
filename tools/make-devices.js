#!/usr/bin/env node
// Draws the built-in device frames in devices/. Generic shapes, no product artwork.
// Screen holes match common CSS viewports: phone 393×852, tablet 820×1180, laptop 1440×900.
// Run: node tools/make-devices.js
const path = require('node:path');
const sharp = require('sharp');

const OUT = path.join(__dirname, '..', 'devices');

const phone = () => {
  const sw = 920, sh = Math.round(sw * 852 / 393), b = 40, W = sw + b * 2, H = sh + b * 2;
  return { W, H, svg: `
    <path fill-rule="evenodd" fill="#1c1c1e" d="${rr(0, 0, W, H, 170)} ${rr(b, b, sw, sh, 132)}"/>
    <path fill="none" stroke="#5a5a60" stroke-width="6" d="${rr(3, 3, W - 6, H - 6, 167)}"/>
    <rect x="${W / 2 - 150}" y="${b + 34}" width="300" height="88" rx="44" fill="#000"/>
    <circle cx="${W / 2 + 100}" cy="${b + 78}" r="16" fill="#15192b"/>
    <rect x="-1" y="520" width="7" height="120" rx="3" fill="#3a3a3e"/><rect x="-1" y="680" width="7" height="190" rx="3" fill="#3a3a3e"/>
    <rect x="${W - 6}" y="620" width="7" height="260" rx="3" fill="#3a3a3e"/>` };
};

const tablet = () => {
  const sw = 1230, sh = Math.round(sw * 1180 / 820), b = 64, W = sw + b * 2, H = sh + b * 2;
  return { W, H, svg: `
    <path fill-rule="evenodd" fill="#1c1c1e" d="${rr(0, 0, W, H, 110)} ${rr(b, b, sw, sh, 48)}"/>
    <path fill="none" stroke="#5a5a60" stroke-width="5" d="${rr(2.5, 2.5, W - 5, H - 5, 108)}"/>
    <circle cx="${W / 2}" cy="${b / 2}" r="9" fill="#15192b"/>` };
};

const laptop = () => {
  const sw = 1600, sh = 1000, side = 44, top = 52, bottom = 56, lidW = sw + side * 2, lidH = sh + top + bottom;
  const W = 2000, baseH = 64, H = lidH + baseH, lx = (W - lidW) / 2;
  return { W, H, svg: `
    <path fill-rule="evenodd" fill="#1c1c1e" d="M${lx} ${lidH} V40 Q${lx} 0 ${lx + 40} 0 H${lx + lidW - 40} Q${lx + lidW} 0 ${lx + lidW} 40 V${lidH} Z ${rr(lx + side, top, sw, sh, 10)}"/>
    <circle cx="${W / 2}" cy="${top / 2}" r="7" fill="#15192b"/>
    <path fill="#2c2c30" d="M0 ${lidH} H${W} V${lidH + 22} Q${W} ${H} ${W - 120} ${H} H120 Q0 ${H} 0 ${lidH + 22} Z"/>
    <rect x="0" y="${lidH}" width="${W}" height="6" fill="#45454b"/>
    <path fill="#1f1f22" d="M${W / 2 - 170} ${lidH + 6} H${W / 2 + 170} Q${W / 2 + 160} ${lidH + 28} ${W / 2 + 130} ${lidH + 28} H${W / 2 - 130} Q${W / 2 - 160} ${lidH + 28} ${W / 2 - 170} ${lidH + 6} Z"/>` };
};

// Rounded-rect path, so two of them in one evenodd path cut the screen hole.
function rr(x, y, w, h, r) {
  return `M${x + r} ${y} H${x + w - r} A${r} ${r} 0 0 1 ${x + w} ${y + r} V${y + h - r} A${r} ${r} 0 0 1 ${x + w - r} ${y + h} H${x + r} A${r} ${r} 0 0 1 ${x} ${y + h - r} V${y + r} A${r} ${r} 0 0 1 ${x + r} ${y} Z`;
}

(async () => {
  for (const [name, make] of [['iphone', phone], ['ipad', tablet], ['laptop', laptop]]) {
    const { W, H, svg } = make();
    const file = path.join(OUT, `${name}.png`);
    await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${svg}</svg>`)).png({ compressionLevel: 9 }).toFile(file);
    console.log(`${file} ${W}×${H}`);
  }
})();
