#!/usr/bin/env node
/**
 * generate-icon.js
 *
 * Generates app icons from assets/dingo-mascot.png (or .svg) on macOS.
 * Uses only tools that ship with macOS (qlmanage, sips, iconutil) —
 * no Homebrew or npm packages required.
 *
 * Prerequisites:
 *   Xcode Command Line Tools:  xcode-select --install
 *
 * Usage:
 *   node scripts/generate-icon.js
 *
 * Output:
 *   assets/icon.png    – 1024×1024 master PNG  (electron-builder uses this)
 *   assets/icon.icns   – macOS ICNS bundle
 */

'use strict';

const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const ROOT   = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');

// ── Helpers ──────────────────────────────────────────────────────────────────
function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  const r = spawnSync(cmd, { shell: true, stdio: 'inherit', cwd: ROOT, ...opts });
  if (r.status !== 0) { console.error(`Failed: ${cmd}`); process.exit(1); }
}

function hasTool(name) {
  return spawnSync(`which ${name}`, { shell: true }).status === 0;
}

// ── Platform check ───────────────────────────────────────────────────────────
if (process.platform !== 'darwin') {
  console.log('⚠  This script is macOS-only (uses qlmanage + iconutil).');
  console.log('   On other platforms electron-builder auto-generates icons');
  console.log('   if you supply a 1024×1024 PNG at assets/icon.png.\n');
  process.exit(0);
}

if (!hasTool('iconutil')) {
  console.error('Missing: iconutil (install Xcode CLT: xcode-select --install)');
  process.exit(1);
}

console.log('\n🐕  Dingo Browser — Icon Generator\n');

// ── 1. Resolve source image ───────────────────────────────────────────────────
const srcPng = path.join(ASSETS, 'dingo-mascot.png');
const srcSvg = path.join(ASSETS, 'dingo-mascot.svg');

let sourcePng;

if (fs.existsSync(srcPng)) {
  console.log('✓ Using dingo-mascot.png as source');
  sourcePng = srcPng;
} else if (fs.existsSync(srcSvg)) {
  console.log('⚙  Converting dingo-mascot.svg → PNG via qlmanage…');

  // qlmanage renders SVG via Quick Look — works on all modern macOS versions.
  // It outputs to a folder as "<filename>.png", so we use a temp dir.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingo-icon-'));
  run(`qlmanage -t -s 1024 -o "${tmpDir}" "${srcSvg}" 2>/dev/null`);

  const rendered = path.join(tmpDir, 'dingo-mascot.svg.png');
  if (!fs.existsSync(rendered)) {
    console.error('qlmanage did not produce a PNG. Try placing a PNG at assets/dingo-mascot.png manually.');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  }

  sourcePng = srcPng;
  fs.copyFileSync(rendered, sourcePng);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`  ✓ Saved to ${sourcePng}`);
} else {
  console.error('\nERROR: No source image found.');
  console.error('Place a high-resolution PNG (≥ 1024×1024) at:');
  console.error('  assets/dingo-mascot.png');
  process.exit(1);
}

// ── 2. Master 1024×1024 icon.png ─────────────────────────────────────────────
console.log('\n[1/2] Generating assets/icon.png (1024×1024)…');
const iconPng = path.join(ASSETS, 'icon.png');
run(`sips -s format png "${sourcePng}" --out "${iconPng}" --resampleHeightWidth 1024 1024`);
console.log(`  ✓ ${iconPng}`);

// ── 3. ICNS via iconutil ──────────────────────────────────────────────────────
console.log('\n[2/2] Generating assets/icon.icns…');
const iconsetDir = path.join(ASSETS, 'icon.iconset');
fs.mkdirSync(iconsetDir, { recursive: true });

// iconutil expects this exact set of filenames
const iconsetSizes = [
  { file: 'icon_16x16.png',      size: 16   },
  { file: 'icon_16x16@2x.png',   size: 32   },
  { file: 'icon_32x32.png',      size: 32   },
  { file: 'icon_32x32@2x.png',   size: 64   },
  { file: 'icon_128x128.png',    size: 128  },
  { file: 'icon_128x128@2x.png', size: 256  },
  { file: 'icon_256x256.png',    size: 256  },
  { file: 'icon_256x256@2x.png', size: 512  },
  { file: 'icon_512x512.png',    size: 512  },
  { file: 'icon_512x512@2x.png', size: 1024 },
];

for (const { file, size } of iconsetSizes) {
  run(`sips -s format png "${iconPng}" --out "${path.join(iconsetDir, file)}" --resampleHeightWidth ${size} ${size}`);
}

const icnsOut = path.join(ASSETS, 'icon.icns');
run(`iconutil -c icns "${iconsetDir}" -o "${icnsOut}"`);
fs.rmSync(iconsetDir, { recursive: true, force: true });
console.log(`  ✓ ${icnsOut}`);

console.log('\n✅  Done! Now run:\n');
console.log('  npm run build:mac          # arm64 DMG');
console.log('  npm run build:mac-universal # arm64 + x64 universal\n');
