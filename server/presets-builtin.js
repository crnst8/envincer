// Built-in presets. A preset is a list of targets (sizes, frames, formats);
// the features to shoot (pages, sections) come from each plan.
// Heights left out of device targets are derived from the device screen.
module.exports = [
  {
    id: 'github-readme', name: 'GitHub README', builtin: true,
    description: 'Hero and feature images for a README: laptop mockup, browser window, phone, laptop+phone combo. 2x for retina at the ~880px README column.',
    targets: [
      { name: 'Laptop', device: 'laptop', viewport: { width: 1440 }, scale: 2, output: { width: 1760, format: 'png', displayWidth: 880 } },
      { name: 'Browser', style: 'browser', viewport: { width: 1280, height: 800 }, scale: 2, output: { width: 1760, format: 'png', displayWidth: 880 } },
      { name: 'Phone', device: 'iphone', viewport: { width: 393 }, scale: 3, output: { width: 640, format: 'png', displayWidth: 320 } },
      { name: 'Laptop + phone', device: 'laptop', viewport: { width: 1440 }, scale: 2, combo: { device: 'iphone', viewport: { width: 393 }, scale: 3 }, output: { width: 1760, format: 'png', displayWidth: 880 } },
    ],
  },
  {
    id: 'app-store', name: 'App Store', builtin: true,
    description: 'Apple App Store screenshot sizes, no alpha channel: iPhone 6.9", iPhone 6.5", iPad 13".',
    targets: [
      { name: 'iPhone 6.9"', viewport: { width: 440, height: 956 }, scale: 3, mobile: true, output: { width: 1320, height: 2868, format: 'png', background: '#ffffff', displayWidth: 400 } },
      { name: 'iPhone 6.5"', viewport: { width: 428, height: 926 }, scale: 3, mobile: true, output: { width: 1284, height: 2778, format: 'png', background: '#ffffff', displayWidth: 400 } },
      { name: 'iPad 13"', viewport: { width: 1032, height: 1376 }, scale: 2, mobile: true, output: { width: 2064, height: 2752, format: 'png', background: '#ffffff', displayWidth: 700 } },
    ],
  },
  {
    id: 'google-play', name: 'Google Play', builtin: true,
    description: 'Google Play phone and 10" tablet screenshots.',
    targets: [
      { name: 'Phone', viewport: { width: 360, height: 640 }, scale: 3, mobile: true, output: { width: 1080, height: 1920, format: 'png', background: '#ffffff', displayWidth: 360 } },
      { name: 'Tablet 10"', viewport: { width: 800, height: 1280 }, scale: 2, mobile: true, output: { width: 1600, height: 2560, format: 'png', background: '#ffffff', displayWidth: 600 } },
    ],
  },
  {
    id: 'social', name: 'Social cards', builtin: true,
    description: 'Open Graph 1200x630, X/Twitter 1600x900, Product Hunt gallery 1270x760.',
    targets: [
      { name: 'Open Graph', viewport: { width: 1200, height: 630 }, scale: 2, output: { width: 1200, height: 630, format: 'png', displayWidth: 600 } },
      { name: 'X / Twitter', viewport: { width: 1280, height: 720 }, scale: 2, output: { width: 1600, height: 900, format: 'png', displayWidth: 600 } },
      { name: 'Product Hunt', viewport: { width: 1270, height: 760 }, scale: 2, output: { width: 1270, height: 760, format: 'png', displayWidth: 635 } },
    ],
  },
  {
    id: 'responsive', name: 'Responsive check', builtin: true,
    description: 'Common breakpoints at 1x for checking layout: small phone to 1080p desktop.',
    targets: [
      { name: 'Phone S 375', viewport: { width: 375, height: 667 }, scale: 1, mobile: true },
      { name: 'Phone 390', viewport: { width: 390, height: 844 }, scale: 1, mobile: true },
      { name: 'Tablet 768', viewport: { width: 768, height: 1024 }, scale: 1, mobile: true },
      { name: 'Tablet L 1024', viewport: { width: 1024, height: 768 }, scale: 1, mobile: true },
      { name: 'Laptop 1366', viewport: { width: 1366, height: 768 }, scale: 1 },
      { name: 'Desktop 1440', viewport: { width: 1440, height: 900 }, scale: 1 },
      { name: 'Desktop 1920', viewport: { width: 1920, height: 1080 }, scale: 1 },
    ],
  },
  {
    id: 'mockups', name: 'Device mockups', builtin: true,
    description: 'Every device template, transparent background.',
    targets: [
      { name: 'Laptop', device: 'laptop', viewport: { width: 1440 }, scale: 2, output: { width: 2400, format: 'png', displayWidth: 1000 } },
      { name: 'iPad', device: 'ipad', viewport: { width: 820 }, scale: 2, output: { width: 1400, format: 'png', displayWidth: 600 } },
      { name: 'iPhone', device: 'iphone', viewport: { width: 393 }, scale: 3, output: { width: 900, format: 'png', displayWidth: 320 } },
    ],
  },
  {
    id: 'full-page', name: 'Full page', builtin: true,
    description: 'Whole-page captures for docs and design review, desktop and phone.',
    targets: [
      { name: 'Desktop full', viewport: { width: 1280, height: 800 }, scale: 1, mode: 'fullpage', output: { format: 'png' } },
      { name: 'Phone full', viewport: { width: 390, height: 844 }, scale: 2, mobile: true, mode: 'fullpage', output: { format: 'png' } },
    ],
  },
  {
    id: 'light-dark', name: 'Light + dark', builtin: true,
    description: 'Browser-window pairs in light and dark colour scheme, for <picture> theme switching.',
    targets: [
      { name: 'Light', style: 'browser', viewport: { width: 1280, height: 800 }, scale: 2, colorScheme: 'light', output: { width: 1760, format: 'png', displayWidth: 880 } },
      { name: 'Dark', style: 'browser', viewport: { width: 1280, height: 800 }, scale: 2, colorScheme: 'dark', output: { width: 1760, format: 'png', displayWidth: 880 } },
    ],
  },
];
