// renderer/resize-plan.js
// Pure logic for the video Resizer: delivery sizes, layer geometry, output
// names, the ffmpeg filter graph and arguments, encoder choice, source picking
// and progress parsing. No DOM, no IO. main.js requires it to build the ffmpeg
// command; the renderer loads it with a <script> tag for sizes, names and the
// summary line. See docs/superpowers/specs/2026-10-26-video-resizer-design.md.

// Fixed delivery sizes, not derived from the source: they match HiggTable's
// ratio-fix CANONICAL_SIZES, so every task's resizes come out the same size.
const STANDARD_RESIZE_SIZES = {
  '1x1': { width: 1080, height: 1080 },
  '4x5': { width: 1080, height: 1350 },
  '16x9': { width: 1920, height: 1080 },
};
const STANDARD_RESIZE_ORDER = ['1x1', '4x5', '16x9'];

// Bounds for a typed custom size. The lower bound rejects typos ("108"), the
// upper keeps H.264 within what every encoder here accepts.
const MIN_CUSTOM_SIDE = 64;
const MAX_CUSTOM_SIDE = 4096;
const MAX_REMEMBERED_CUSTOM_SIZES = 5;

// The source must be 9:16 to within this relative error (1080x1920 exactly,
// in practice). Anything else is skipped rather than resized into the wrong look.
const SOURCE_RATIO_TOLERANCE = 0.015;

// The After Effects template's look (spec §4): Gaussian Blur 50 with Repeat
// Edge Pixels, then CC Vignette, both in the 1080x1920 layer's own space.
// sigma = Blurriness * 0.5, computed on a copy downscaled by `d` (sigma/4,
// clamped) because a blur that strong looks identical at 1/6 size and costs a
// fraction. The vignette angle PI/4.5 (40°) is the value that matched the AE
// stills best; ffmpeg's vignette model is not CC Vignette's, so it is not 45°.
// It runs in RGB: in YUV it darkens only luma and the colours drift.
const AE_BLURRINESS = 50;
const AE_BLUR_TO_SIGMA = 0.5;
const VIGNETTE_ANGLE = 'PI/4.5';

// Audio codecs the MP4 muxer takes as-is. Anything else is re-encoded to AAC
// instead of failing the whole render.
const MP4_COPYABLE_AUDIO = ['aac', 'mp3', 'ac3', 'eac3', 'alac'];

// H.264 levels VideoToolbox accepts.
const VIDEOTOOLBOX_LEVELS = [30, 31, 32, 40, 41, 42, 50, 51, 52];

function evenSize(v) {
  return Math.max(2, Math.round(v / 2) * 2);
}

// A target is { key, width, height, custom }. The key is what goes in the file
// name: the ratio for standard sizes, exact pixels ("1200x628") for custom ones,
// even when a custom size happens to match a known ratio (the owner's call).
function standardTarget(key) {
  const size = STANDARD_RESIZE_SIZES[key];
  return size ? { key, width: size.width, height: size.height, custom: false } : null;
}

// Parses typed width/height into a custom target, rounded to even numbers
// because H.264 4:2:0 needs that. Returns null for anything unusable.
function parseCustomSize(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  const ew = evenSize(w);
  const eh = evenSize(h);
  if (ew < MIN_CUSTOM_SIDE || eh < MIN_CUSTOM_SIDE) return null;
  if (ew > MAX_CUSTOM_SIDE || eh > MAX_CUSTOM_SIDE) return null;
  return { key: `${ew}x${eh}`, width: ew, height: eh, custom: true };
}

// Turns a key back into a target: "1x1" → standard, "1200x628" → custom.
function targetFromKey(key) {
  const std = standardTarget(key);
  if (std) return std;
  const m = /^(\d+)x(\d+)$/.exec(String(key || ''));
  if (!m) return null;
  const t = parseCustomSize(Number(m[1]), Number(m[2]));
  return t && t.key === key ? t : null;
}

// Ordered, de-duplicated targets for a set of ticked keys: standard sizes first
// in their usual order, then custom sizes in the order given.
function resolveTargets(keys) {
  const wanted = new Set(keys || []);
  const out = STANDARD_RESIZE_ORDER.filter(k => wanted.has(k)).map(standardTarget);
  wanted.forEach(k => {
    if (STANDARD_RESIZE_SIZES[k]) return;
    const t = targetFromKey(k);
    if (t && !out.some(o => o.key === t.key)) out.push(t);
  });
  return out;
}

// Most-recent-first list of remembered custom keys, capped.
function rememberCustomSize(list, key, max = MAX_REMEMBERED_CUSTOM_SIZES) {
  const rest = (list || []).filter(k => k !== key && targetFromKey(k) && !STANDARD_RESIZE_SIZES[k]);
  return [key, ...rest].slice(0, max);
}

function isNineBySixteen(width, height) {
  if (!(width > 0 && height > 0)) return false;
  const want = 9 / 16;
  return Math.abs(width / height - want) / want < SOURCE_RATIO_TOLERANCE;
}

// Layer geometry for one output, for a W×H source. Background covers, foreground
// fits ("contain"), both centred. The canvas is the output itself except for the
// standard 1x1, which in the template is the 16x9 comp at 100%, i.e. the centre
// crop of the 16x9 composite: its canvas is 16:9 at the output's height, and the
// output is the centre crop of that canvas.
function layerGeometry(target, W, H) {
  const tw = target.width;
  const th = target.height;
  const sixteenNineCanvas = !target.custom && target.key === '1x1';
  const cw = sixteenNineCanvas ? evenSize(th * 16 / 9) : tw;
  const ch = th;
  const fill = Math.max(cw / W, ch / H);
  const fit = Math.min(cw / W, ch / H);
  const bgWidth = Math.max(cw, evenSize(W * fill));
  const bgHeight = Math.max(ch, evenSize(H * fill));
  const fgWidth = Math.min(tw, evenSize(W * fit));
  const fgHeight = Math.min(th, evenSize(H * fit));
  return {
    width: tw,
    height: th,
    bgWidth,
    bgHeight,
    fgWidth,
    fgHeight,
    x: Math.trunc((tw - fgWidth) / 2),
    y: Math.trunc((th - fgHeight) / 2),
  };
}

// The blurred, vignetted background layer at the source's own size, computed
// once per task and split to every output.
function backgroundChain(W, H, pixFmt) {
  const sigma = AE_BLURRINESS * AE_BLUR_TO_SIGMA;
  const d = Math.max(1, Math.min(8, Math.floor(sigma / 4)));
  const sw = evenSize(W / d);
  const sh = evenSize(H / d);
  const smallSigma = (sigma * sw / W).toFixed(4);
  return `scale=${sw}:${sh}:flags=area,gblur=sigma=${smallSigma}:steps=3,`
    + `scale=${W}:${H}:flags=bicubic,format=gbrp,vignette=angle=${VIGNETTE_ANGLE},format=${pixFmt}`;
}

// ── ffprobe ───────────────────────────────────────────────────────────────

// Reads `ffprobe -print_format json -show_streams -show_format` output into the
// fields the plan needs. Width and height are the DISPLAY size: a ±90° rotation
// swaps them, since ffmpeg rotates frames before the filter graph.
function parseProbe(json) {
  const streams = (json && json.streams) || [];
  const format = (json && json.format) || {};
  const v = streams.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  if (!v) throw new Error('The file has no video track');
  const audio = streams.filter(s => s.codec_type === 'audio');
  const rotData = (v.side_data_list || []).find(d => d.rotation != null);
  const rot = Number(rotData ? rotData.rotation : (v.tags && v.tags.rotate) || 0);
  const swap = Math.abs(rot) % 180 === 90;
  let bitrate = v.bit_rate ? Number(v.bit_rate) : null;
  if (bitrate == null && format.bit_rate) {
    const total = Number(format.bit_rate);
    const a = audio.reduce((sum, s) => sum + Number(s.bit_rate || 0), 0);
    bitrate = Math.max(total - a, total / 2);
  }
  const known = x => (x && x !== 'unknown' && x !== 'reserved' ? x : null);
  const pixFmt = v.pix_fmt || 'yuv420p';
  return {
    codec: v.codec_name,
    profile: v.profile || null,
    level: v.level > 0 ? v.level : null,
    pixFmt,
    width: swap ? v.height : v.width,
    height: swap ? v.width : v.height,
    videoBitrate: bitrate,
    duration: Number(format.duration || v.duration || 0),
    hasAudio: audio.length > 0,
    audioCodec: audio.length ? audio[0].codec_name : null,
    colorRange: known(v.color_range),
    colorSpace: known(v.color_space),
    colorTransfer: known(v.color_transfer),
    colorPrimaries: known(v.color_primaries),
  };
}

// ── Encoders ──────────────────────────────────────────────────────────────

function x26xPixFmt(pix) {
  if (pix.startsWith('yuvj')) return { pixFmt: pix.replace('yuvj', 'yuv'), colorRange: 'pc' };
  if (['yuv420p', 'yuv422p', 'yuv444p', 'yuv420p10le', 'yuv422p10le', 'yuv444p10le'].includes(pix)) return { pixFmt: pix };
  if (pix === 'p010le') return { pixFmt: 'yuv420p10le' };
  return { pixFmt: 'yuv420p' };
}

// -profile:v only for 8-bit 4:2:0; for 10-bit or 4:2:2 x264 picks high10/high422.
function h264Profile(profile, pixFmt) {
  if (pixFmt !== 'yuv420p') return null;
  const p = String(profile || '').toLowerCase();
  if (p.includes('baseline')) return 'baseline';
  if (p === 'main' || p === 'high') return p;
  return null;
}

// The software (or, for HEVC on macOS, VideoToolbox) encoder that matches the
// source, in the guide's "speed" mode. The container is always MP4, so codecs
// other than H.264 and HEVC become H.264.
function baseEncoder(info, platform) {
  const pix = info.pixFmt || 'yuv420p';
  if (info.codec === 'hevc') {
    const ten = /10|12/.test(pix);
    const is420 = pix.includes('420') || pix === 'nv12' || pix === 'p010le';
    if (platform === 'darwin' && is420) {
      return {
        name: 'hevc_videotoolbox',
        args: ['-c:v', 'hevc_videotoolbox', '-profile:v', ten ? 'main10' : 'main', '-tag:v', 'hvc1'],
        pixFmt: ten ? 'p010le' : 'yuv420p',
        colorRange: null,
      };
    }
    const f = x26xPixFmt(pix);
    return {
      name: 'libx265',
      args: ['-c:v', 'libx265', '-preset', 'fast', '-tag:v', 'hvc1', '-x265-params', 'log-level=error'],
      pixFmt: f.pixFmt,
      colorRange: f.colorRange || null,
    };
  }
  const f = x26xPixFmt(info.codec === 'h264' ? pix : 'yuv420p');
  const args = ['-c:v', 'libx264', '-preset', 'veryfast'];
  if (info.codec === 'h264') {
    const p = h264Profile(info.profile, f.pixFmt);
    if (p) args.push('-profile:v', p);
  }
  return { name: 'libx264', args, pixFmt: f.pixFmt, colorRange: f.colorRange || null };
}

// Per-output encoder choice. On macOS, for an 8-bit 4:2:0 tv-range H.264 source
// with two or more outputs, the largest output goes to h264_videotoolbox and
// the rest to libx264, so the CPU and the hardware encoder work in parallel
// (the guide measured 3.1 s against 4.1 s all-x264). Windows has no
// VideoToolbox, so everything stays in software there.
function chooseEncoders(info, targets, platform) {
  const base = baseEncoder(info, platform);
  const areas = targets.map(t => t.width * t.height);
  const hybrid = platform === 'darwin' && info.codec === 'h264' && base.name === 'libx264'
    && base.pixFmt === 'yuv420p' && !base.colorRange && targets.length >= 2;
  const hwIndex = hybrid ? areas.indexOf(Math.max(...areas)) : -1;
  const srcArea = (info.width || 0) * (info.height || 0);
  return targets.map((t, i) => {
    // The source's level only holds for outputs no larger than the source; a
    // bigger custom size would exceed it.
    const keepLevel = info.codec === 'h264' && info.level && t.width * t.height <= srcArea;
    if (i === hwIndex) {
      const args = ['-c:v', 'h264_videotoolbox', '-allow_sw', '1'];
      const p = h264Profile(info.profile, 'yuv420p');
      if (p) args.push('-profile:v', p);
      if (keepLevel && VIDEOTOOLBOX_LEVELS.includes(info.level)) args.push('-level:v', (info.level / 10).toFixed(1));
      return { name: 'h264_videotoolbox', args, pixFmt: 'yuv420p', colorRange: null };
    }
    const args = [...base.args];
    if (base.name === 'libx264' && keepLevel) args.push('-level:v', (info.level / 10).toFixed(1));
    return { ...base, args };
  });
}

// ── Naming ────────────────────────────────────────────────────────────────

function resizeOutputName(base, target, ext = 'mp4') {
  return `${base}_${target.key}.${ext}`;
}

function sourcePreviewName(base) {
  return `${base}_9x16.png`;
}

function joinPath(dir, name, sep) {
  if (!dir) return name;
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

function tempPathFor(dir, finalName, sep) {
  return joinPath(dir, `.${finalName}.resizing`, sep);
}

// ── Plan ──────────────────────────────────────────────────────────────────

// Builds the single ffmpeg command for one task: every chosen size, plus a PNG
// of each composite's first frame at full output size, plus <base>_9x16.png next
// to the source when asked. Every output is written to a hidden temp file with
// an explicit -f (ffmpeg cannot infer a format from ".resizing"); the caller
// renames temps over finals only after ffmpeg exits 0.
//
// opts: { source, dir, base, info, targets, previews, sourcePreview, platform, sep }
function buildResizePlan(opts) {
  const { source, dir, base, info, targets, previews, sourcePreview, platform } = opts;
  const sep = opts.sep || '/';
  if (!targets.length) throw new Error('No sizes chosen');
  const W = info.width;
  const H = info.height;
  const n = targets.length;
  const encoders = chooseEncoders(info, targets, platform);
  // One pixel format for the shared background: the encoders all agree except
  // when VideoToolbox HEVC wants p010le, which every output then shares.
  const bgPix = encoders[0].pixFmt;

  const g = [];
  g.push(sourcePreview ? '[0:v]split=3[fs][bs][ps]' : '[0:v]split=2[fs][bs]');
  // trim=end_frame=1 on every preview branch: without it the branch processes
  // every frame for a PNG that keeps only the first (~25% slower).
  if (sourcePreview) g.push('[ps]trim=end_frame=1,format=rgb24[psrc]');
  g.push(`[bs]${backgroundChain(W, H, bgPix)},split=${n}${targets.map((_, i) => `[b${i}]`).join('')}`);
  g.push(`[fs]split=${n}${targets.map((_, i) => `[f${i}]`).join('')}`);
  targets.forEach((t, i) => {
    const geo = layerGeometry(t, W, H);
    // Crop after scaling: cropping in the downscaled space shifts up to 1%.
    g.push(`[b${i}]scale=${geo.bgWidth}:${geo.bgHeight}:flags=bicubic,crop=${geo.width}:${geo.height}[g${i}]`);
    g.push(`[f${i}]scale=${geo.fgWidth}:${geo.fgHeight}:flags=lanczos[h${i}]`);
    const comp = `[g${i}][h${i}]overlay=x=${geo.x}:y=${geo.y}:format=auto,setsar=1,format=${encoders[i].pixFmt}`;
    if (previews) {
      g.push(`${comp},split=2[v${i}][pv${i}]`);
      g.push(`[pv${i}]trim=end_frame=1,format=rgb24[p${i}]`);
    } else {
      g.push(`${comp}[v${i}]`);
    }
  });

  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats',
    '-i', source, '-filter_complex', g.join(';')];
  const outputs = [];
  const addPreview = (label, finalName) => {
    const temp = tempPathFor(dir, finalName, sep);
    args.push('-map', `[${label}]`, '-frames:v', '1', '-c:v', 'png', '-update', '1', '-f', 'image2', temp);
    outputs.push({ temp, final: joinPath(dir, finalName, sep), isPreview: true });
  };

  const copyAudio = MP4_COPYABLE_AUDIO.includes(info.audioCodec);
  targets.forEach((t, i) => {
    const enc = encoders[i];
    const finalName = resizeOutputName(base, t);
    const temp = tempPathFor(dir, finalName, sep);
    args.push('-map', `[v${i}]`);
    if (info.hasAudio) args.push('-map', '0:a?', ...(copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']));
    args.push(...enc.args);
    if (info.videoBitrate) args.push('-b:v', String(Math.trunc(info.videoBitrate)));
    if (info.colorPrimaries) args.push('-color_primaries', info.colorPrimaries);
    if (info.colorTransfer) args.push('-color_trc', info.colorTransfer);
    if (info.colorSpace) args.push('-colorspace', info.colorSpace);
    const range = enc.colorRange || info.colorRange;
    if (range) args.push('-color_range', range);
    args.push('-map_metadata', '0', '-fps_mode', 'passthrough', '-movflags', '+faststart', '-f', 'mp4', temp);
    outputs.push({ temp, final: joinPath(dir, finalName, sep), isPreview: false, key: t.key });
    if (previews) addPreview(`p${i}`, resizeOutputName(base, t, 'png'));
  });
  if (sourcePreview) addPreview('psrc', sourcePreviewName(base));

  return {
    args,
    outputs,
    videos: outputs.filter(o => !o.isPreview).map(o => o.final),
    encoders: encoders.map(e => e.name),
  };
}

// ── Sources ───────────────────────────────────────────────────────────────

function pathParts(p) {
  return String(p).split(/[\\/]+/).filter(Boolean);
}

// Picks the 9x16 master for a task from every "<base>_9x16.mp4" found under the
// working directory. One match is used. Several matches are resolved only by
// the task folder convention (parent folder named exactly after the full task
// name); anything else is skipped, never guessed.
function pickResizeSource(taskName, paths) {
  const list = paths || [];
  if (!list.length) return { error: 'missing' };
  if (list.length === 1) return { path: list[0] };
  const inTaskFolder = list.filter(p => {
    const parts = pathParts(p);
    return parts.length >= 2 && parts[parts.length - 2] === taskName;
  });
  if (inTaskFolder.length === 1) return { path: inTaskFolder[0] };
  return { error: 'ambiguous', paths: list };
}

// ── Progress and text ─────────────────────────────────────────────────────

// One line of `-progress pipe:1` output → fraction done, or null. Older builds
// write out_time_ms, but its value is microseconds too.
function progressFromLine(line, duration) {
  const m = /^out_time_(?:us|ms)=(\d+)/.exec(String(line).trim());
  if (!m || !(duration > 0)) return null;
  return Math.max(0, Math.min(1, Number(m[1]) / 1e6 / duration));
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function resizeSummary(taskCount, sizeCount, previews) {
  if (!taskCount) return 'Nothing to render';
  if (!sizeCount) return 'Choose at least one size';
  return `${plural(taskCount, 'task')} × ${plural(sizeCount, 'size')}${previews ? ' + previews' : ''} → next to each source`;
}

function formatSeconds(s) {
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    STANDARD_RESIZE_SIZES, STANDARD_RESIZE_ORDER, MAX_REMEMBERED_CUSTOM_SIZES, MP4_COPYABLE_AUDIO,
    evenSize, standardTarget, parseCustomSize, targetFromKey, resolveTargets, rememberCustomSize,
    isNineBySixteen, layerGeometry, backgroundChain, parseProbe, chooseEncoders,
    resizeOutputName, sourcePreviewName, buildResizePlan, pickResizeSource, progressFromLine,
    resizeSummary, formatSeconds,
  };
}
