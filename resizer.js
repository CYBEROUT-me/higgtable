// Video Resizer engine for the main process: locating the bundled ffmpeg,
// probing sources, running one ffmpeg per task, and the temp → final file
// handling. The command itself is built by the pure renderer/resize-plan.js.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { parseProbe, progressFromLine } = require('./renderer/resize-plan');

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';

// Packaged: electron-builder copies vendor/<os>-<arch>/ to resources/bin
// (outside asar, where binaries can run). Dev: the same vendor folder, falling
// back to an ffmpeg on the machine so `npm start` works before the binaries
// have been fetched.
function resolveBinary(name, { isPackaged, resourcesPath, appDir }) {
  if (isPackaged) return path.join(resourcesPath, 'bin', name + EXE);
  const os = IS_WIN ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
  const vendored = path.join(appDir, 'vendor', `${os}-${process.arch}`, name + EXE);
  if (fs.existsSync(vendored)) return vendored;
  const local = ['/opt/homebrew/bin', '/usr/local/bin'].map(d => path.join(d, name)).find(p => fs.existsSync(p));
  return local || name;
}

// Spawns without a shell (task names contain spaces and brackets) and always
// drains both pipes while running: a full pipe blocks ffmpeg forever.
function run(bin, args, onStdout) {
  let child;
  const done = new Promise((resolve, reject) => {
    child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', d => {
      if (!onStdout) out += d; else onStdout(d);
    });
    child.stderr.setEncoding('utf8').on('data', d => { err = (err + d).slice(-4000); });
    child.on('error', e => {
      reject(e.code === 'ENOENT' ? new Error(`${path.basename(bin)} not found at ${bin}`) : e);
    });
    child.on('close', (code, signal) => {
      if (code === 0) resolve({ stdout: out, stderr: err });
      else {
        const tail = err.trim().split('\n').slice(-3).join('\n');
        reject(Object.assign(new Error(tail || `exited with ${code != null ? `code ${code}` : signal}`), { signal, stderr: err }));
      }
    });
  });
  return { child, done };
}

// Probes are cached by path, size and mtime: the dialog re-inspects every time a
// size chip changes, and the source does not change in between.
const probeCache = new Map();

async function probeVideo(ffprobe, file) {
  const st = fs.statSync(file);
  const stamp = `${st.size}:${st.mtimeMs}`;
  const hit = probeCache.get(file);
  if (hit && hit.stamp === stamp) return hit.info;
  const { stdout } = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]).done;
  const info = parseProbe(JSON.parse(stdout));
  probeCache.set(file, { stamp, info });
  return info;
}

function removeTemps(plan) {
  for (const o of plan.outputs) {
    try { fs.rmSync(o.temp, { force: true }); } catch {}
  }
}

// Runs one plan. Temps are renamed over the finals only after ffmpeg exits 0;
// on failure or cancel every temp is deleted, so no half-written delivery is
// ever left behind.
function renderPlan(ffmpeg, plan, duration, onProgress) {
  let buf = '';
  let cancelled = false;
  // Monotonic: ffmpeg's last progress block can report a smaller out_time (the
  // one-frame PNG outputs end at ~0), which would make the bar jump back.
  let best = 0;
  removeTemps(plan); // leftovers from a crash would otherwise be renamed into place
  const { child, done } = run(ffmpeg, plan.args, chunk => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const f = progressFromLine(line, duration);
      if (f != null && f > best) { best = f; onProgress(f); }
    }
  });
  const finished = done.then(() => {
    if (cancelled) throw new Error('Cancelled');
    for (const o of plan.outputs) {
      if (!fs.existsSync(o.temp)) throw new Error(`ffmpeg did not write ${path.basename(o.final)}`);
    }
    for (const o of plan.outputs) {
      // rm first: renaming over an existing file fails on Windows.
      fs.rmSync(o.final, { force: true });
      fs.renameSync(o.temp, o.final);
    }
  }).catch(err => {
    removeTemps(plan);
    throw cancelled ? Object.assign(new Error('Cancelled'), { cancelled: true }) : err;
  });
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    if (IS_WIN) { child.kill(); return; } // TerminateProcess: there is no graceful signal
    child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL'); }, 2000).unref();
  };
  // For app quit: no time to wait for 'close', so kill hard and clean up now.
  const kill = () => {
    cancelled = true;
    try { child.kill('SIGKILL'); } catch {}
    removeTemps(plan);
  };
  return { finished, cancel, kill };
}

module.exports = { resolveBinary, probeVideo, renderPlan };
