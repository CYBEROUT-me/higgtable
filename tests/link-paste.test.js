const { parseLinkList, compareByName, pairLinksToTasks, describeMismatch, reorderFromDriveSelection } =
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

// Drive returns a shift-selection's links as: the folder clicked, the folder
// shift-clicked, then the range fill. Observed 2026-09-08 with five OL_ folders.
describe('reorderFromDriveSelection', () => {
  test('undoes the observed five-folder order', () => {
    // names sort 13999, 14000, 14001, 14002, 14003
    // Drive copied  13999, 14003, 14000, 14001, 14002
    const drive = ['L13999', 'L14003', 'L14000', 'L14001', 'L14002'];
    expect(reorderFromDriveSelection(drive))
      .toEqual(['L13999', 'L14000', 'L14001', 'L14002', 'L14003']);
  });

  test('pairs correctly end to end after reordering', () => {
    const tasks = ['OL_13999', 'OL_14000', 'OL_14001', 'OL_14002', 'OL_14003']
      .map(n => ({ id: n, name: n, existingLink: '' }));
    const drive = ['L13999', 'L14003', 'L14000', 'L14001', 'L14002'];
    const paired = pairLinksToTasks(tasks, reorderFromDriveSelection(drive));
    expect(paired.pairs.map(p => [p.task.name, p.link])).toEqual([
      ['OL_13999', 'L13999'],
      ['OL_14000', 'L14000'],
      ['OL_14001', 'L14001'],
      ['OL_14002', 'L14002'],
      ['OL_14003', 'L14003'],
    ]);
  });

  test('handles three links', () => {
    expect(reorderFromDriveSelection(['A', 'C', 'B'])).toEqual(['A', 'B', 'C']);
  });

  test('leaves one or two links untouched — there is nothing to undo', () => {
    expect(reorderFromDriveSelection(['A'])).toEqual(['A']);
    expect(reorderFromDriveSelection(['A', 'B'])).toEqual(['A', 'B']);
    expect(reorderFromDriveSelection([])).toEqual([]);
  });

  test('does not mutate the input', () => {
    const input = ['A', 'C', 'B'];
    reorderFromDriveSelection(input);
    expect(input).toEqual(['A', 'C', 'B']);
  });

  test('with three links it swaps the last two, so it is self-inverse there', () => {
    // Worth pinning: at n=3 the correction only exchanges positions 1 and 2, so
    // applying it twice returns the original. That is NOT true from n=4 up, so
    // the switch must never be applied twice to the same list.
    const once = reorderFromDriveSelection(['A', 'C', 'B']);
    expect(once).toEqual(['A', 'B', 'C']);
    expect(reorderFromDriveSelection(once)).toEqual(['A', 'C', 'B']);
  });

  test('from four links up it is a one-way correction', () => {
    const once = reorderFromDriveSelection(['A', 'B', 'C', 'D', 'E']);
    expect(once).toEqual(['A', 'C', 'D', 'E', 'B']);
    expect(reorderFromDriveSelection(once)).not.toEqual(['A', 'B', 'C', 'D', 'E']);
  });
});
