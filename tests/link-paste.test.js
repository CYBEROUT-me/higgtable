const { parseLinkList, compareByName, pairLinksToTasks, describeMismatch } =
  require('../renderer/link-paste');

// The exact shape a list arrives in when copied out of Drive.
const PASTED = [
  'https://drive.google.com/drive/folders/1mBTy6aeaYwsUJYRwgT9fijDtrLKft4lu?usp=drive_link',
  'https://drive.google.com/drive/folders/11E03nZFRq6EzsGqEIkhswXLFW9pbeOfr?usp=drive_link',
  'https://drive.google.com/drive/folders/1HVfbfCv1S3yaagbl14mqc-a8dAWfRQkU?usp=drive_link',
].join(', ');

const task = (name, existingLink = '') => ({ id: name, name, existingLink });

describe('parseLinkList', () => {
  test('parses a comma-separated paste', () => {
    const r = parseLinkList(PASTED);
    expect(r.links).toHaveLength(3);
    expect(r.invalid).toEqual([]);
  });

  test('keeps each link exactly as pasted, query string included', () => {
    expect(parseLinkList(PASTED).links[0]).toBe(
      'https://drive.google.com/drive/folders/1mBTy6aeaYwsUJYRwgT9fijDtrLKft4lu?usp=drive_link',
    );
  });

  test('accepts newline and space separated lists too', () => {
    expect(parseLinkList('https://a.com/1\nhttps://a.com/2  https://a.com/3').links)
      .toEqual(['https://a.com/1', 'https://a.com/2', 'https://a.com/3']);
  });

  test('preserves the pasted order', () => {
    expect(parseLinkList('https://a.com/2, https://a.com/1').links)
      .toEqual(['https://a.com/2', 'https://a.com/1']);
  });

  test('separates entries that are not URLs', () => {
    const r = parseLinkList('https://a.com/1, not-a-link, ftp://x.com/2');
    expect(r.links).toEqual(['https://a.com/1']);
    expect(r.invalid).toEqual(['not-a-link', 'ftp://x.com/2']);
  });

  test('drops duplicates and reports them', () => {
    const r = parseLinkList('https://a.com/1, https://a.com/1, https://a.com/2');
    expect(r.links).toEqual(['https://a.com/1', 'https://a.com/2']);
    expect(r.duplicates).toEqual(['https://a.com/1']);
  });

  test('handles empty input', () => {
    expect(parseLinkList('')).toEqual({ links: [], invalid: [], duplicates: [] });
    expect(parseLinkList(null).links).toEqual([]);
  });
});

describe('pairLinksToTasks', () => {
  const batch = [
    task('CMC_2222_2218_A621_S0_EN_usr_ELI_PRI_Stat_VAR_9x16'),
    task('CMC_2218_2218_M247_S0_EN_usr_ELI_PRI_Stat_NEW_9x16'),
    task('CMC_2220_2218_A786_S0_EN_usr_ELI_PRI_Stat_VAR_9x16'),
    task('CMC_2219_2218_A816_S0_EN_usr_ELI_PRI_Stat_VAR_9x16'),
    task('CMC_2221_2218_A739_S0_EN_usr_ELI_PRI_Stat_VAR_9x16'),
  ];
  const links = ['L1', 'L2', 'L3', 'L4', 'L5'];

  test('pairs the Nth link with the Nth task in name order', () => {
    const r = pairLinksToTasks(batch, links);
    expect(r.pairs.map(p => [p.task.name.slice(0, 8), p.link])).toEqual([
      ['CMC_2218', 'L1'],
      ['CMC_2219', 'L2'],
      ['CMC_2220', 'L3'],
      ['CMC_2221', 'L4'],
      ['CMC_2222', 'L5'],
    ]);
    expect(r.tasksWithoutLink).toEqual([]);
    expect(r.unusedLinks).toEqual([]);
  });

  test('does not mutate the caller\'s task array', () => {
    const original = [...batch];
    pairLinksToTasks(batch, links);
    expect(batch).toEqual(original);
  });

  test('sorts numerically so a shorter number comes first', () => {
    const r = pairLinksToTasks([task('X_1000'), task('X_999')], ['a', 'b']);
    expect(r.pairs.map(p => p.task.name)).toEqual(['X_999', 'X_1000']);
  });

  test('reports tasks left without a link when links run out', () => {
    const r = pairLinksToTasks(batch, ['L1', 'L2']);
    expect(r.pairs).toHaveLength(2);
    expect(r.tasksWithoutLink.map(t => t.name.slice(0, 8)))
      .toEqual(['CMC_2220', 'CMC_2221', 'CMC_2222']);
    expect(r.unusedLinks).toEqual([]);
  });

  test('reports leftover links when there are more links than tasks', () => {
    const r = pairLinksToTasks([task('X_1'), task('X_2')], ['a', 'b', 'c', 'd']);
    expect(r.pairs).toHaveLength(2);
    expect(r.unusedLinks).toEqual(['c', 'd']);
  });

  test('an already-linked task keeps its slot and is flagged', () => {
    // Dropping it would shift every later pairing onto the wrong task.
    const withExisting = [task('X_1', 'https://old/1'), task('X_2'), task('X_3')];
    const r = pairLinksToTasks(withExisting, ['n1', 'n2', 'n3']);
    expect(r.pairs[0]).toMatchObject({ link: 'n1', hasExisting: true, existingLink: 'https://old/1' });
    expect(r.pairs[1]).toMatchObject({ link: 'n2', hasExisting: false });
    expect(r.pairs[2].task.name).toBe('X_3');
  });

  test('a whitespace-only existing link does not count as existing', () => {
    const r = pairLinksToTasks([task('X_1', '   ')], ['n1']);
    expect(r.pairs[0].hasExisting).toBe(false);
  });

  test('handles no tasks and no links', () => {
    expect(pairLinksToTasks([], [])).toEqual({ pairs: [], tasksWithoutLink: [], unusedLinks: [] });
    expect(pairLinksToTasks(null, null).pairs).toEqual([]);
  });
});

describe('describeMismatch', () => {
  test('is null when everything lines up', () => {
    const r = pairLinksToTasks([task('X_1')], ['a']);
    expect(describeMismatch(r)).toBeNull();
  });

  test('counts tasks without links', () => {
    const r = pairLinksToTasks([task('X_1'), task('X_2')], ['a']);
    expect(describeMismatch(r)).toContain('1 task(s) have no link');
  });

  test('counts leftover links', () => {
    const r = pairLinksToTasks([task('X_1')], ['a', 'b']);
    expect(describeMismatch(r)).toContain('1 link(s) left over');
  });

  test('reports invalid entries and duplicates from parsing', () => {
    const r = pairLinksToTasks([task('X_1')], ['a']);
    const msg = describeMismatch(r, { invalid: ['nope'], duplicates: ['a'] });
    expect(msg).toContain('not URLs');
    expect(msg).toContain('duplicate');
  });
});
