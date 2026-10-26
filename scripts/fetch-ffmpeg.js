// Downloads the ffmpeg + ffprobe builds HiggTable ships for the video Resizer
// into vendor/<os>-<arch>/, which electron-builder copies to resources/bin
// (see "extraResources" in package.json). vendor/ is git-ignored; this runs
// before every build/release (npm pre-hooks) and skips binaries already present.
//
//   node scripts/fetch-ffmpeg.js           fetch what is missing
//   node scripts/fetch-ffmpeg.js --force   re-download everything
//
// Sources (static GPL builds with libx264, libx265, gblur and vignette):
//   macOS arm64  ffmpeg.martin-riedl.de  (also has VideoToolbox)
//   Windows x64  gyan.dev release essentials
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FORCE = process.argv.includes('--force');

const TARGETS = [
  {
    dir: 'mac-arm64',
    exe: '',
    archives: [
      'https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip',
      'https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffprobe.zip',
    ],
    encoders: ['libx264', 'libx265', 'h264_videotoolbox'],
  },
  {
    dir: 'win-x64',
    exe: '.exe',
    archives: ['https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'],
    encoders: ['libx264', 'libx265'],
  },
];
const FILTERS = ['gblur', 'vignette'];
const HOST_DIR = `${process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'}-${process.arch}`;

async function download(url, file) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return fs.statSync(file).size;
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

// Runs the binary when it is for this machine; otherwise looks for the
// component names in the binary itself (a static build embeds them).
function verify(target, outDir) {
  const ffmpeg = path.join(outDir, `ffmpeg${target.exe}`);
  const want = [...target.encoders, ...FILTERS];
  let haystack;
  if (target.dir === HOST_DIR) {
    haystack = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' })
      + execFileSync(ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8' });
    const version = execFileSync(ffmpeg, ['-hide_banner', '-version'], { encoding: 'utf8' }).split('\n')[0];
    console.log(`  ${version}`);
  } else {
    haystack = fs.readFileSync(ffmpeg).toString('latin1');
  }
  const missing = want.filter(w => !haystack.includes(w));
  if (missing.length) throw new Error(`${target.dir} ffmpeg lacks: ${missing.join(', ')}`);
  console.log(`  ${target.dir}: has ${want.join(', ')}`);
}

async function fetchTarget(target) {
  const outDir = path.join(ROOT, 'vendor', target.dir);
  const names = ['ffmpeg', 'ffprobe'].map(n => n + target.exe);
  if (!FORCE && names.every(n => fs.existsSync(path.join(outDir, n)))) {
    console.log(`fetch-ffmpeg: ${target.dir} already present`);
    return;
  }
  console.log(`fetch-ffmpeg: ${target.dir}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'higgtable-ffmpeg-'));
  try {
    for (const [i, url] of target.archives.entries()) {
      const zip = path.join(tmp, `${i}.zip`);
      const size = await download(url, zip);
      console.log(`  downloaded ${url} (${(size / 1e6).toFixed(1)} MB)`);
      const into = path.join(tmp, String(i));
      fs.mkdirSync(into);
      // bsdtar reads zip on macOS and on Windows 10+.
      execFileSync('tar', ['-xf', zip, '-C', into]);
    }
    fs.mkdirSync(outDir, { recursive: true });
    for (const name of names) {
      const found = findFile(tmp, name);
      if (!found) throw new Error(`${name} not found in the downloaded archive(s)`);
      const dest = path.join(outDir, name);
      fs.copyFileSync(found, dest);
      fs.chmodSync(dest, 0o755);
      if (process.platform === 'darwin') {
        try { execFileSync('xattr', ['-c', dest]); } catch {}
      }
    }
    verify(target, outDir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

(async () => {
  for (const target of TARGETS) await fetchTarget(target);
})().catch(err => {
  console.error(`fetch-ffmpeg: FAILED — ${err.message}`);
  process.exit(1);
});
