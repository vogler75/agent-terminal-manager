'use strict';
// Renders build/icon.svg into the app icons (run after changing the SVG):
//   npx electron scripts/make-icon.js
// build/icon.ico   Windows exe and installer (16-256 px, each size rendered from the SVG)
// build/icon.png   macOS (electron-builder makes the .icns from it), 1024 px
// src/main/icon.png window icon (dev runs, Linux), 256 px
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(ROOT, 'build', 'icon.svg'), 'utf8');
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

// 32-bit BMP entry (BITMAPINFOHEADER, bottom-up BGRA, empty AND mask): every Windows API reads these;
// PNG entries are only used for 256 px, where they are the norm.
function bmpEntry(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND mask
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      const d = ((size - 1 - y) * size + x) * 4;
      pixels[d] = rgba[s + 2];
      pixels[d + 1] = rgba[s + 1];
      pixels[d + 2] = rgba[s];
      pixels[d + 3] = rgba[s + 3];
    }
  }
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
  return Buffer.concat([header, pixels, mask]);
}

function ico(images) {
  const entries = images.map(({ size, png, rgba }) => ({ size, data: size >= 256 ? png : bmpEntry(size, rgba) }));
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4); // planes
    head.writeUInt16LE(32, e + 6); // bits per pixel
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...entries.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<body></body>');
  // Returns the PNG and the raw RGBA pixels (straight alpha) of the SVG at one size.
  const render = async (size) => {
    const r = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = ${size};
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0, ${size}, ${size});
        resolve({ png: c.toDataURL('image/png'), rgba: Array.from(g.getImageData(0, 0, ${size}, ${size}).data) });
      };
      img.onerror = reject;
      img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}';
    })`);
    return { size, png: Buffer.from(r.png.split(',')[1], 'base64'), rgba: Buffer.from(r.rgba) };
  };
  const images = [];
  for (const size of ICO_SIZES) images.push(await render(size));
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), ico(images));
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), (await render(1024)).png);
  fs.writeFileSync(path.join(ROOT, 'src', 'main', 'icon.png'), images.find((p) => p.size === 256).png);
  console.log('written build/icon.ico, build/icon.png, src/main/icon.png');
  app.quit();
});
