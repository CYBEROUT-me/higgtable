const { MIN_QUERY_LENGTH, normalizeForSearch, compareTaskNames, searchTasks } =
  require('../renderer/task-search');

const recs = [
  { id: 'a', name: 'CMC_2218_2218_M247_S0_EN_usr_ELI_PRI_Stat_NEW_9x16', table: 'CMC Creatives' },
  { id: 'b', name: 'CMC_2219_2218_A816_S0_EN_usr_ELI_PRI_Stat_VAR_9x16', table: 'CMC Creatives' },
  { id: 'c', name: 'OL_10838_10835_M0_S1251_EN_usr_KRU_VER_Video_VAR_9x16', table: 'VCP Creatives' },
  { id: 'd', name: 'TV_999_1_Video_NEW_9x16', table: 'VCP Creatives' },
  { id: 'e', name: 'TV_1000_1_Video_NEW_9x16', table: 'VCP Creatives' },
];

describe('normalizeForSearch', () => {
  test('undoes markdown escaping so an escaped name still matches', () => {
    expect(normalizeForSearch('OL\\_10838')).toBe('ol_10838');
  });

  test('trims and lowercases', () => {
    expect(normalizeForSearch('  CMC_2218  ')).toBe('cmc_2218');
  });

  test('handles empty input', () => {
    expect(normalizeForSearch(null)).toBe('');
  });
});

describe('compareTaskNames', () => {
  test('sorts numerically, not lexicographically', () => {
    // A plain text sort would put TV_1000 before TV_999.
    expect(['TV_1000', 'TV_999'].sort(compareTaskNames)).toEqual(['TV_999', 'TV_1000']);
  });

  test('sorts the reference batch in the expected order', () => {
    const names = [
      'CMC_2220_2218_A786_S0_EN_usr_ELI_PRI_Stat_VAR_9x16',
      'CMC_2218_2218_M247_S0_EN_usr_ELI_PRI_Stat_NEW_9x16',
      'CMC_2219_2218_A816_S0_EN_usr_ELI_PRI_Stat_VAR_9x16',
    ];
    expect(names.sort(compareTaskNames)[0]).toContain('CMC_2218');
    expect(names.sort(compareTaskNames)[2]).toContain('CMC_2220');
  });
});

describe('searchTasks', () => {
  test('ignores a query shorter than the minimum', () => {
    expect(searchTasks('C', recs)).toEqual([]);
    expect(MIN_QUERY_LENGTH).toBe(2);
  });

  test('finds tasks across every table it is given', () => {
    const hits = searchTasks('9x16', recs);
    expect(new Set(hits.map(h => h.table))).toEqual(new Set(['CMC Creatives', 'VCP Creatives']));
  });

  test('ranks an exact name first', () => {
    const hits = searchTasks(recs[1].name, recs);
    expect(hits[0].id).toBe('b');
  });

  test('ranks starts-with above contains', () => {
    const hits = searchTasks('cmc_2219', recs);
    expect(hits[0].id).toBe('b');
  });

  test('matches on a substring from the middle of a name', () => {
    expect(searchTasks('KRU', recs).map(h => h.id)).toEqual(['c']);
  });

  test('is case-insensitive', () => {
    expect(searchTasks('cmc_2218', recs).map(h => h.id)).toEqual(['a']);
  });

  test('finds a task when the query carries markdown escaping', () => {
    expect(searchTasks('OL\\_10838', recs).map(h => h.id)).toEqual(['c']);
  });

  test('orders equally-ranked matches numerically by name', () => {
    expect(searchTasks('TV_', recs).map(h => h.id)).toEqual(['d', 'e']);
  });

  test('respects the result limit', () => {
    expect(searchTasks('9x16', recs, { limit: 2 })).toHaveLength(2);
  });

  test('returns nothing for an unmatched query', () => {
    expect(searchTasks('zzzzz', recs)).toEqual([]);
  });

  test('tolerates missing input', () => {
    expect(searchTasks('cmc', null)).toEqual([]);
    expect(searchTasks('cmc', [{ id: 'x' }])).toEqual([]);
  });
});
