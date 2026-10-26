const {
  STANDARD_RESIZE_SIZES, evenSize, parseCustomSize, targetFromKey, resolveTargets, rememberCustomSize,
  isNineBySixteen, layerGeometry, backgroundChain, parseProbe, chooseEncoders,
  resizeOutputName, buildResizePlan, pickResizeSource, progressFromLine, resizeSummary, formatSeconds,
  standardTarget,
} = require('../renderer/resize-plan');

// The sources seen in the owner's folders: H.264 Main, 1080x1920, yuv420p,
// BT.709 tv range, AAC.
const SOURCE_INFO = {
  codec: 'h264', profile: 'Main', level: 41, pixFmt: 'yuv420p',
  width: 1080, height: 1920, videoBitrate: 12804800, duration: 14.1,
  hasAudio: true, audioCodec: 'aac',
  colorRange: 'tv', colorSpace: 'bt709', colorTransfer: 'bt709', colorPrimaries: 'bt709',
};
const T = key => standardTarget(key);

describe('delivery sizes', () => {
  test('standard sizes are fixed, not derived from the source', () => {
    expect(STANDARD_RESIZE_SIZES).toEqual({
      '1x1': { width: 1080, height: 1080 },
      '4x5': { width: 1080, height: 1350 },
      '16x9': { width: 1920, height: 1080 },
    });
  });

  test('custom sizes are exact pixels, rounded to even numbers', () => {
    expect(parseCustomSize(1200, 628)).toEqual({ key: '1200x628', width: 1200, height: 628, custom: true });
    expect(parseCustomSize('1201', '627')).toMatchObject({ key: '1202x628' });
  });

  test('a custom size matching a standard ratio still keeps its pixel key', () => {
    expect(parseCustomSize(1080, 1080)).toMatchObject({ key: '1080x1080', custom: true });
  });

  test('unusable custom sizes are rejected', () => {
    expect(parseCustomSize('', 628)).toBeNull();
    expect(parseCustomSize('abc', 628)).toBeNull();
    expect(parseCustomSize(10, 628)).toBeNull();
    expect(parseCustomSize(5000, 628)).toBeNull();
  });

  test('keys round-trip to targets', () => {
    expect(targetFromKey('4x5')).toEqual({ key: '4x5', width: 1080, height: 1350, custom: false });
    expect(targetFromKey('1200x628')).toMatchObject({ width: 1200, height: 628, custom: true });
    expect(targetFromKey('1201x628')).toBeNull();
    expect(targetFromKey('nonsense')).toBeNull();
  });

  test('targets come out standard first, in order, without duplicates', () => {
    const keys = resolveTargets(['1200x628', '16x9', '1x1', '1200x628']).map(t => t.key);
    expect(keys).toEqual(['1x1', '16x9', '1200x628']);
  });

  test('remembered custom sizes are most recent first and capped at 5', () => {
    let list = [];
    ['100x100', '200x200', '300x300', '400x400', '500x500', '600x600'].forEach(k => { list = rememberCustomSize(list, k); });
    expect(list).toEqual(['600x600', '500x500', '400x400', '300x300', '200x200']);
    expect(rememberCustomSize(list, '300x300')[0]).toBe('300x300');
    expect(rememberCustomSize(list, '300x300')).toHaveLength(5);
  });

  test('evenSize rounds to the nearest even number, at least 2', () => {
    expect(evenSize(607.5)).toBe(608);
    expect(evenSize(3413.33)).toBe(3414);
    expect(evenSize(0.4)).toBe(2);
  });
});

describe('source ratio', () => {
  test('1080x1920 is 9:16', () => expect(isNineBySixteen(1080, 1920)).toBe(true));
  test('a 1% error is tolerated', () => expect(isNineBySixteen(1090, 1920)).toBe(true));
  test('1080x1350 is not', () => expect(isNineBySixteen(1080, 1350)).toBe(false));
  test('a missing size is not', () => expect(isNineBySixteen(0, 0)).toBe(false));
});

// Values validated in the spike against the After Effects renders of PL_7456
// and OL_14835 (spec §4).
describe('layer geometry matches the After Effects template', () => {
  test('4x5: background at 100% (cover), foreground at 70.313% (contain)', () => {
    expect(layerGeometry(T('4x5'), 1080, 1920)).toEqual({
      width: 1080, height: 1350, bgWidth: 1080, bgHeight: 1920, fgWidth: 760, fgHeight: 1350, x: 160, y: 0,
    });
  });

  test('16x9: background at 177.778%, foreground at 56.25%', () => {
    expect(layerGeometry(T('16x9'), 1080, 1920)).toEqual({
      width: 1920, height: 1080, bgWidth: 1920, bgHeight: 3414, fgWidth: 608, fgHeight: 1080, x: 656, y: 0,
    });
  });

  test('1x1 is the centre crop of the 16x9 composite', () => {
    const sq = layerGeometry(T('1x1'), 1080, 1920);
    const wide = layerGeometry(T('16x9'), 1080, 1920);
    expect(sq).toEqual({
      width: 1080, height: 1080, bgWidth: 1920, bgHeight: 3414, fgWidth: 608, fgHeight: 1080, x: 236, y: 0,
    });
    // Same background scale and foreground as the 16x9, shifted by the crop offset.
    expect(sq.bgWidth).toBe(wide.bgWidth);
    expect(sq.fgWidth).toBe(wide.fgWidth);
    expect(wide.x - (1920 - 1080) / 2).toBe(sq.x);
  });

  test('a custom size uses the general rule (cover / contain), even when square', () => {
    expect(layerGeometry(parseCustomSize(1080, 1080), 1080, 1920)).toEqual({
      width: 1080, height: 1080, bgWidth: 1080, bgHeight: 1920, fgWidth: 608, fgHeight: 1080, x: 236, y: 0,
    });
    expect(layerGeometry(parseCustomSize(1200, 628), 1080, 1920)).toEqual({
      width: 1200, height: 628, bgWidth: 1200, bgHeight: 2134, fgWidth: 354, fgHeight: 628, x: 423, y: 0,
    });
  });
});

describe('background chain', () => {
  test('blur on a 1/6 copy at sigma 25 source px, then vignette in RGB at layer size', () => {
    expect(backgroundChain(1080, 1920, 'yuv420p')).toBe(
      'scale=180:320:flags=area,gblur=sigma=4.1667:steps=3,'
      + 'scale=1080:1920:flags=bicubic,format=gbrp,vignette=angle=PI/4.5,format=yuv420p'
    );
  });
});

describe('parseProbe', () => {
  const probe = {
    streams: [
      { codec_type: 'video', codec_name: 'h264', profile: 'Main', level: 41, pix_fmt: 'yuv420p',
        width: 1080, height: 1920, bit_rate: '12804800', color_range: 'tv', color_space: 'bt709',
        color_transfer: 'bt709', color_primaries: 'bt709' },
      { codec_type: 'audio', codec_name: 'aac', bit_rate: '188795' },
    ],
    format: { duration: '14.100000', bit_rate: '13000000' },
  };

  test('reads the fields the plan needs', () => {
    expect(parseProbe(probe)).toEqual(SOURCE_INFO);
  });

  test('a ±90° rotation swaps width and height', () => {
    const rotated = JSON.parse(JSON.stringify(probe));
    Object.assign(rotated.streams[0], { width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] });
    expect(parseProbe(rotated)).toMatchObject({ width: 1080, height: 1920 });
  });

  test('missing stream bitrate falls back to format minus audio', () => {
    const p = JSON.parse(JSON.stringify(probe));
    delete p.streams[0].bit_rate;
    expect(parseProbe(p).videoBitrate).toBe(13000000 - 188795);
  });

  test('unknown colour tags are dropped', () => {
    const p = JSON.parse(JSON.stringify(probe));
    p.streams[0].color_space = 'unknown';
    expect(parseProbe(p).colorSpace).toBeNull();
  });

  test('a cover image is not the video track', () => {
    expect(() => parseProbe({ streams: [{ codec_type: 'video', disposition: { attached_pic: 1 } }] }))
      .toThrow('no video track');
  });
});

describe('encoder choice', () => {
  const three = ['1x1', '4x5', '16x9'].map(T);

  test('macOS: the largest output goes to VideoToolbox, the rest to libx264 veryfast', () => {
    const enc = chooseEncoders(SOURCE_INFO, three, 'darwin');
    expect(enc.map(e => e.name)).toEqual(['libx264', 'libx264', 'h264_videotoolbox']);
    expect(enc[0].args).toEqual(['-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-level:v', '4.1']);
    expect(enc[2].args).toEqual(['-c:v', 'h264_videotoolbox', '-allow_sw', '1', '-profile:v', 'main', '-level:v', '4.1']);
  });

  test('Windows: everything on libx264', () => {
    expect(chooseEncoders(SOURCE_INFO, three, 'win32').map(e => e.name)).toEqual(['libx264', 'libx264', 'libx264']);
  });

  test('a single output is not split across encoders', () => {
    expect(chooseEncoders(SOURCE_INFO, [T('4x5')], 'darwin').map(e => e.name)).toEqual(['libx264']);
  });

  test('a full-range (yuvj) source stays in software and is tagged pc', () => {
    const enc = chooseEncoders({ ...SOURCE_INFO, pixFmt: 'yuvj420p' }, three, 'darwin');
    expect(enc.map(e => e.name)).toEqual(['libx264', 'libx264', 'libx264']);
    expect(enc[0]).toMatchObject({ pixFmt: 'yuv420p', colorRange: 'pc' });
  });

  test('an output larger than the source drops the source level', () => {
    const big = parseCustomSize(2160, 3840);
    const [enc] = chooseEncoders(SOURCE_INFO, [big], 'win32');
    expect(enc.args).not.toContain('-level:v');
  });

  test('HEVC: VideoToolbox on macOS, libx265 on Windows, both tagged hvc1', () => {
    const hevc = { ...SOURCE_INFO, codec: 'hevc', profile: 'Main 10', pixFmt: 'yuv420p10le' };
    const [mac] = chooseEncoders(hevc, [T('1x1')], 'darwin');
    const [win] = chooseEncoders(hevc, [T('1x1')], 'win32');
    expect(mac).toMatchObject({ name: 'hevc_videotoolbox', pixFmt: 'p010le' });
    expect(mac.args).toEqual(expect.arrayContaining(['main10', 'hvc1']));
    expect(win).toMatchObject({ name: 'libx265', pixFmt: 'yuv420p10le' });
  });

  test('other codecs become H.264 4:2:0 for the MP4 container', () => {
    const [enc] = chooseEncoders({ ...SOURCE_INFO, codec: 'vp9', pixFmt: 'yuv444p' }, [T('1x1')], 'win32');
    expect(enc).toMatchObject({ name: 'libx264', pixFmt: 'yuv420p' });
    expect(enc.args).not.toContain('-profile:v');
  });
});

describe('naming', () => {
  const base = 'PL_7456_7071_A0_S0_EN_usr_KRU_PRI_Video_ITR_TalkingHead';
  test('standard sizes use the ratio', () => {
    expect(resizeOutputName(base, T('4x5'))).toBe(`${base}_4x5.mp4`);
    expect(resizeOutputName(base, T('1x1'), 'png')).toBe(`${base}_1x1.png`);
  });
  test('custom sizes use exact pixels', () => {
    expect(resizeOutputName(base, parseCustomSize(1200, 628))).toBe(`${base}_1200x628.mp4`);
  });
});

describe('buildResizePlan', () => {
  const dir = '/work/For GD/PL_7456_X_9x16';
  const base = 'PL_7456_X';
  const plan = (over = {}) => buildResizePlan({
    source: `${dir}/${base}_9x16.mp4`, dir, base, info: SOURCE_INFO,
    targets: ['1x1', '4x5', '16x9'].map(T), previews: true, sourcePreview: true, platform: 'darwin', sep: '/',
    ...over,
  });
  const graphOf = p => p.args[p.args.indexOf('-filter_complex') + 1].split(';');

  test('writes every output to a hidden temp next to the source', () => {
    const p = plan();
    expect(p.outputs.map(o => o.final)).toEqual([
      `${dir}/${base}_1x1.mp4`, `${dir}/${base}_1x1.png`,
      `${dir}/${base}_4x5.mp4`, `${dir}/${base}_4x5.png`,
      `${dir}/${base}_16x9.mp4`, `${dir}/${base}_16x9.png`,
      `${dir}/${base}_9x16.png`,
    ]);
    expect(p.outputs[0].temp).toBe(`${dir}/.${base}_1x1.mp4.resizing`);
    expect(p.videos).toEqual([`${dir}/${base}_1x1.mp4`, `${dir}/${base}_4x5.mp4`, `${dir}/${base}_16x9.mp4`]);
    p.outputs.forEach(o => expect(p.args).toContain(o.temp));
  });

  test('the filter graph computes the background once and splits it', () => {
    expect(graphOf(plan())).toEqual([
      '[0:v]split=3[fs][bs][ps]',
      '[ps]trim=end_frame=1,format=rgb24[psrc]',
      `[bs]${backgroundChain(1080, 1920, 'yuv420p')},split=3[b0][b1][b2]`,
      '[fs]split=3[f0][f1][f2]',
      '[b0]scale=1920:3414:flags=bicubic,crop=1080:1080[g0]',
      '[f0]scale=608:1080:flags=lanczos[h0]',
      '[g0][h0]overlay=x=236:y=0:format=auto,setsar=1,format=yuv420p,split=2[v0][pv0]',
      '[pv0]trim=end_frame=1,format=rgb24[p0]',
      '[b1]scale=1080:1920:flags=bicubic,crop=1080:1350[g1]',
      '[f1]scale=760:1350:flags=lanczos[h1]',
      '[g1][h1]overlay=x=160:y=0:format=auto,setsar=1,format=yuv420p,split=2[v1][pv1]',
      '[pv1]trim=end_frame=1,format=rgb24[p1]',
      '[b2]scale=1920:3414:flags=bicubic,crop=1920:1080[g2]',
      '[f2]scale=608:1080:flags=lanczos[h2]',
      '[g2][h2]overlay=x=656:y=0:format=auto,setsar=1,format=yuv420p,split=2[v2][pv2]',
      '[pv2]trim=end_frame=1,format=rgb24[p2]',
    ]);
  });

  test('without previews there are no PNG branches or outputs', () => {
    const p = plan({ previews: false, sourcePreview: false });
    expect(graphOf(p)[0]).toBe('[0:v]split=2[fs][bs]');
    expect(graphOf(p).some(s => s.includes('rgb24'))).toBe(false);
    expect(p.outputs.every(o => !o.isPreview)).toBe(true);
  });

  test('video outputs match the source: codec, bitrate, colour tags, timing, audio copy', () => {
    const p = plan({ targets: [T('4x5')], previews: false, sourcePreview: false });
    const out = p.args.slice(p.args.indexOf('-map'));
    expect(out).toEqual([
      '-map', '[v0]', '-map', '0:a?', '-c:a', 'copy',
      '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-level:v', '4.1',
      '-b:v', '12804800',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
      '-map_metadata', '0', '-fps_mode', 'passthrough', '-movflags', '+faststart', '-f', 'mp4',
      `${dir}/.${base}_4x5.mp4.resizing`,
    ]);
  });

  test('PNG previews are explicit image2 outputs of one frame', () => {
    const p = plan({ targets: [T('1x1')], sourcePreview: false });
    const i = p.args.indexOf('[p0]');
    expect(p.args.slice(i - 1, i + 10)).toEqual([
      '-map', '[p0]', '-frames:v', '1', '-c:v', 'png', '-update', '1', '-f', 'image2',
      `${dir}/.${base}_1x1.png.resizing`,
    ]);
  });

  test('audio the MP4 muxer cannot take is re-encoded to AAC', () => {
    const p = plan({ info: { ...SOURCE_INFO, audioCodec: 'pcm_s16le' }, targets: [T('1x1')], previews: false, sourcePreview: false });
    expect(p.args).toEqual(expect.arrayContaining(['-c:a', 'aac']));
  });

  test('Windows paths use backslashes', () => {
    const p = buildResizePlan({
      source: 'C:\\w\\X_9x16.mp4', dir: 'C:\\w', base: 'X', info: SOURCE_INFO, targets: [T('1x1')],
      previews: false, sourcePreview: false, platform: 'win32', sep: '\\',
    });
    expect(p.outputs[0]).toMatchObject({ final: 'C:\\w\\X_1x1.mp4', temp: 'C:\\w\\.X_1x1.mp4.resizing' });
  });

  test('refuses to plan nothing', () => {
    expect(() => plan({ targets: [] })).toThrow('No sizes');
  });
});

describe('pickResizeSource', () => {
  const name = 'PL_7456_7071_A0_S0_EN_usr_KRU_PRI_Video_ITR_TalkingHead_9x16';
  const own = `/w/For GD/${name}/PL_7456_7071_A0_S0_EN_usr_KRU_PRI_Video_ITR_TalkingHead_9x16.mp4`;
  const copy = `/w/Collected/(Footage)/PL_7456_7071_A0_S0_EN_usr_KRU_PRI_Video_ITR_TalkingHead_9x16.mp4`;

  test('no match is missing', () => expect(pickResizeSource(name, [])).toEqual({ error: 'missing' }));
  test('one match is used wherever it is', () => expect(pickResizeSource(name, [copy])).toEqual({ path: copy }));
  test('several matches resolve to the one in the task folder', () => {
    expect(pickResizeSource(name, [copy, own])).toEqual({ path: own });
  });
  test('Windows separators work too', () => {
    const win = `C:\\w\\For GD\\${name}\\x_9x16.mp4`;
    expect(pickResizeSource(name, ['C:\\other\\x_9x16.mp4', win])).toEqual({ path: win });
  });
  test('several matches without exactly one task folder are not guessed', () => {
    expect(pickResizeSource(name, [copy, copy + '2'])).toEqual({ error: 'ambiguous', paths: [copy, copy + '2'] });
    expect(pickResizeSource(name, [own, own])).toMatchObject({ error: 'ambiguous' });
  });
});

describe('progress and text', () => {
  test('out_time_us is a fraction of the duration', () => {
    expect(progressFromLine('out_time_us=7050000', 14.1)).toBeCloseTo(0.5);
    expect(progressFromLine('out_time_ms=14100000', 14.1)).toBe(1);
    expect(progressFromLine('out_time_us=99000000', 14.1)).toBe(1);
  });
  test('other lines and unknown durations give null', () => {
    expect(progressFromLine('frame=10', 14.1)).toBeNull();
    expect(progressFromLine('out_time_us=100', 0)).toBeNull();
  });
  test('summary line', () => {
    expect(resizeSummary(4, 3, true)).toBe('4 tasks × 3 sizes + previews → next to each source');
    expect(resizeSummary(1, 1, false)).toBe('1 task × 1 size → next to each source');
    expect(resizeSummary(2, 0, true)).toBe('Choose at least one size');
  });
  test('formatSeconds', () => {
    expect(formatSeconds(1.64)).toBe('1.6s');
    expect(formatSeconds(75)).toBe('1m 15s');
  });
});
