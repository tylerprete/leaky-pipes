// Renders src/icon.svg into the icon files the page links to (home-screen, favicon, manifest).
// node tools/make-icons.js   (needs playwright; the outputs in docs/ are committed)
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const out = path.join(__dirname, '..', 'docs');
const svg = fs.readFileSync(path.join(__dirname, '..', 'src', 'icon.svg'), 'utf8');
(async () => {
  const browser = await chromium.launch();
  for (const [name, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await page.screenshot({ path: path.join(out, name) });
    await page.close();
  }
  await browser.close();
  // the browser-tab icon keeps rounded corners; home-screen icons are square (the device rounds them)
  fs.writeFileSync(path.join(out, 'icon.svg'), svg.replace('<rect width="512" height="512" fill="url(#bg)"/>', '<rect width="512" height="512" rx="96" fill="url(#bg)"/>'));
  fs.writeFileSync(path.join(out, 'manifest.webmanifest'), JSON.stringify({ name: 'Leaky Pipes', short_name: 'Leaky Pipes', start_url: '.', display: 'browser', background_color: '#141c22', theme_color: '#1a232a', icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }] }, null, 2) + '\n');
  console.log('icons written to docs/');
})();
