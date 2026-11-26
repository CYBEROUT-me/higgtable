// tests/pack-data.test.js
const { packKey, packLayout } = require('../renderer/pack-data');

const rec = fields => ({ id: Math.random().toString(36), fields });

test('packKey uses Old ID and Date', () => {
  expect(packKey(rec({ 'Old ID': 13330, Date: '2026-11-24', Name: 'LO_15894_13330_A138' }))).toBe('13330|2026-11-24');
});

test('packKey falls back to the parent id in the name', () => {
  expect(packKey(rec({ Date: '2026-11-24', Name: 'OL_15889_15885_A0_S2069_EN' }))).toBe('15885|2026-11-24');
  expect(packKey(rec({ Name: 'OL_15754____EN_usr' }))).toBeNull();
});

test('packLayout groups consecutive rows of the same pack', () => {
  const rows = [
    rec({ 'Old ID': 1, Date: 'd1' }),
    rec({ 'Old ID': 1, Date: 'd1' }),
    rec({ 'Old ID': 1, Date: 'd1' }),
    rec({ 'Old ID': 1, Date: 'd2' }),
    rec({ Name: 'no parent' }),
    rec({ Name: 'no parent' }),
    rec({ 'Old ID': 2, Date: 'd1' }),
    rec({ 'Old ID': 2, Date: 'd1' }),
  ];
  expect(packLayout(rows)).toEqual([
    { size: 3, index: 0 }, { size: 3, index: 1 }, { size: 3, index: 2 },
    { size: 1, index: 0 },
    { size: 1, index: 0 }, { size: 1, index: 0 },
    { size: 2, index: 0 }, { size: 2, index: 1 },
  ]);
  expect(packLayout([])).toEqual([]);
});

const { packSummary } = require('../renderer/pack-data');

test('packSummary reads parent, concept, languages and day', () => {
  const recs = [
    rec({ Name: 'LO_15945_13140_M0_S0_GR_usr_ARI_ILU_Video_VAR_Mix_9x16', 'Old ID': 13140, Date: '2026-11-24' }),
    rec({ Name: 'LO_15943_13140_M0_S0_CZ_usr_ARI_PRI_Video_ITR_Mix_9x16', 'Old ID': 13140, Date: '2026-11-24' }),
    rec({ Name: 'LO_15935_13140_M0_S0_CZ_usr_ARI_PRI_Video_VAR_Mix_9x16', 'Old ID': 13140, Date: '2026-11-24' }),
  ];
  expect(packSummary(recs)).toEqual({ parent: '13140', concept: 'Mix', languages: ['GR', 'CZ'], date: '2026-11-24', count: 3 });
});

test('packSummary copes with half-filled names', () => {
  expect(packSummary([rec({ Name: 'OL_15754_15750____EN_usr__PAN___9x16', Date: 'd' })]).concept).toBe('');
});

test('groupIntoPacks joins same-pack tasks that are not next to each other', () => {
  const { groupIntoPacks } = require('../renderer/pack-data');
  const a1 = rec({ 'Old ID': 1, Date: 'd1' });
  const b1 = rec({ 'Old ID': 2, Date: 'd1' });
  const a2 = rec({ 'Old ID': 1, Date: 'd1' });
  const n1 = rec({ Name: 'no parent' });
  const n2 = rec({ Name: 'no parent' });
  const a3 = rec({ 'Old ID': 1, Date: 'd2' });
  const groups = groupIntoPacks([a1, b1, a2, n1, n2, a3]);
  expect(groups.map(g => g.records)).toEqual([[a1, a2], [b1], [n1], [n2], [a3]]);
  expect(groups[0].key).toBe('1|d1');
  expect(groups[2].key).toBeNull();
  expect(groupIntoPacks([])).toEqual([]);
});
