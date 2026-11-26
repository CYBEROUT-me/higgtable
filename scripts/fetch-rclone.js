// Downloads the rclone HiggTable ships (Google Drive links, read only) into
// vendor/<os>-<arch>/, next to ffmpeg; electron-builder copies it to
// resources/bin (see "extraResources" in package.json). vendor/ is
// git-ignored; this runs before every build/release (npm pre-hooks) and skips
// a binary already present. Each archive is checked against rclone's own
// SHA256SUMS before anything is unpacked.
//
//   node scripts/fetch-rclone.js           fetch what is missing
//   node scripts/fetch-rclone.js --force   re-download
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const VERSION = 'v1.76.0';
const BASE = `https://downloads.rclone.org/${VERSION}`;
const ROOT = path.join(__dirname, '..');
const FORCE = process.argv.includes('--force');
const HOST_DIR = `${process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'}-${process.arch}`;

const TARGETS = [
  { dir: 'mac-arm64', exe: '', archive: `rclone-${VERSION}-osx-arm64.zip` },
  { dir: 'win-x64', exe: '.exe', archive: `rclone-${VERSION}-windows-amd64.zip` },
];

async function fetchBuffer(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

async function fetchTarget(target, sums) {
  const outDir = path.join(ROOT, 'vendor', target.dir);
  const dest = path.join(outDir, `rclone${target.exe}`);
  if (!FORCE && fs.existsSync(dest)) {
    console.log(`fetch-rclone: ${target.dir} already present`);
    return;
  }
  const want = sums.get(target.archive);
  if (!want) throw new Error(`${target.archive} is not listed in SHA256SUMS`);
  const buf = await fetchBuffer(`${BASE}/${target.archive}`);
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (got !== want) throw new Error(`${target.archive}: checksum mismatch`);
  console.log(`fetch-rclone: ${target.dir} downloaded ${target.archive} (${(buf.length / 1e6).toFixed(1)} MB), checksum ok`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'higgtable-rclone-'));
  try {
    const zip = path.join(tmp, 'rclone.zip');
    fs.writeFileSync(zip, buf);
    const into = path.join(tmp, 'x');
    fs.mkdirSync(into);
    execFileSync('tar', ['-xf', zip, '-C', into]); // bsdtar reads zip on macOS and Windows 10+
    const found = findFile(into, `rclone${target.exe}`);
    if (!found) throw new Error(`rclone${target.exe} not found in ${target.archive}`);
    fs.mkdirSync(outDir, { recursive: true });
    fs.copyFileSync(found, dest);
    fs.chmodSync(dest, 0o755);
    if (process.platform === 'darwin') {
      try { execFileSync('xattr', ['-c', dest]); } catch {}
    }
    if (target.dir === HOST_DIR) {
      console.log(`  ${execFileSync(dest, ['version'], { encoding: 'utf8' }).split('\n')[0]}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

(async () => {
  const needed = TARGETS.filter(t => FORCE || !fs.existsSync(path.join(ROOT, 'vendor', t.dir, `rclone${t.exe}`)));
  if (!needed.length) {
    TARGETS.forEach(t => console.log(`fetch-rclone: ${t.dir} already present`));
    return;
  }
  // "<sha256>  <file>" lines inside a PGP-signed text.
  const sums = new Map();
  (await fetchBuffer(`${BASE}/SHA256SUMS`)).toString('utf8').split('\n').forEach(line => {
    const m = /^([0-9a-f]{64})\s+(\S+)$/.exec(line.trim());
    if (m) sums.set(m[2], m[1]);
  });
  for (const target of needed) await fetchTarget(target, sums);
})().catch(err => {
  console.error(`fetch-rclone: FAILED — ${err.message}`);
  process.exit(1);
});
