// scripts/install-webview2.js
// Downloads nuget.exe (if needed) and restores the Microsoft.Web.WebView2
// NuGet package so the native addon can compile and link on Windows.

'use strict';

if (process.platform !== 'win32') {
  console.log('WebView2 is only needed on Windows – skipping.');
  process.exit(0);
}

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const ROOT        = path.resolve(__dirname, '..');
const NUGET_EXE   = path.join(ROOT, 'deps', 'nuget.exe');
const NUGET_URL   = 'https://dist.nuget.org/win-x86-commandline/latest/nuget.exe';
const PACKAGES_DIR = path.join(ROOT, 'deps', 'packages');
const WEBVIEW2_DIR = path.join(ROOT, 'deps', 'webview2');

const PACKAGE_NAME    = 'Microsoft.Web.WebView2';
const PACKAGE_VERSION = '1.0.2739.15';

// ---- helpers ---------------------------------------------------------------

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          follow(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyRecursive(src, dest) {
  if (fs.statSync(src).isDirectory()) {
    ensureDir(dest);
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

// ---- main ------------------------------------------------------------------

async function main() {
  // 1. Download nuget.exe if missing
  if (!fs.existsSync(NUGET_EXE)) {
    console.log('Downloading nuget.exe …');
    ensureDir(path.dirname(NUGET_EXE));
    await download(NUGET_URL, NUGET_EXE);
    console.log('nuget.exe downloaded.');
  }

  // 2. Restore the WebView2 NuGet package
  console.log(`Restoring ${PACKAGE_NAME} ${PACKAGE_VERSION} via NuGet …`);
  ensureDir(PACKAGES_DIR);
  execFileSync(NUGET_EXE, [
    'install', PACKAGE_NAME,
    '-Version', PACKAGE_VERSION,
    '-OutputDirectory', PACKAGES_DIR,
    '-NonInteractive'
  ], { stdio: 'inherit' });

  // 3. Locate the extracted package
  const pkgDir = path.join(PACKAGES_DIR, `${PACKAGE_NAME}.${PACKAGE_VERSION}`);
  const nativeDir = path.join(pkgDir, 'build', 'native');

  if (!fs.existsSync(nativeDir)) {
    throw new Error(`Expected native dir not found: ${nativeDir}`);
  }

  // 4. Copy headers
  const srcInclude  = path.join(nativeDir, 'include');
  const destInclude = path.join(WEBVIEW2_DIR, 'include');
  ensureDir(destInclude);
  console.log('Copying headers …');
  copyRecursive(srcInclude, destInclude);

  // 5. Copy libs & DLLs for each architecture
  for (const arch of ['x64', 'x86', 'arm64']) {
    const srcDir  = path.join(nativeDir, arch);
    const destDir = path.join(WEBVIEW2_DIR, 'lib', arch);
    if (fs.existsSync(srcDir)) {
      ensureDir(destDir);
      console.log(`Copying native binaries for ${arch} …`);
      copyRecursive(srcDir, destDir);
    }
  }

  console.log('WebView2 SDK ready.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
