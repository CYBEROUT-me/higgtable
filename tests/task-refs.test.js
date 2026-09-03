const {
  CREATIVE_LINK_FIELD, FIGMA_LINK_FIELD,
  extractTaskRefs, matchRefToRecords, linkFieldForRecord, resolveFieldName,
} = require('../renderer/task-refs');

// The Cyrillic М in "М689" is taken verbatim from a real task name, and is the
// reason segment matching cannot be restricted to ASCII.
const FULL = 'PL_6940_6940_М689_S0_EN_usr_KRU_PRI_Video_NEW_9x16';

describe('extractTaskRefs', () => {
  test('finds a full task name', () => {
    expect(extractTaskRefs(`See ${FULL} for the source`)).toEqual([FULL]);
  });

  test('keeps Cyrillic characters inside a name intact', () => {
    expect(extractTaskRefs(FULL)[0]).toContain('М689');
  });

  test('finds a shorthand reference', () => {
    expect(extractTaskRefs('based on PL_6940')).toEqual(['PL_6940']);
  });

  test('finds several references and de-duplicates', () => {
    expect(extractTaskRefs('PL_6940 and TV_13286 and PL_6940 again'))
      .toEqual(['PL_6940', 'TV_13286']);
  });

  test('strips trailing prose punctuation', () => {
    expect(extractTaskRefs('reuse PL_6940.')).toEqual(['PL_6940']);
    expect(extractTaskRefs('reuse PL_6940, please')).toEqual(['PL_6940']);
  });

  test('ignores text with no reference', () => {
    expect(extractTaskRefs('make it brighter and louder')).toEqual([]);
    expect(extractTaskRefs('')).toEqual([]);
    expect(extractTaskRefs(null)).toEqual([]);
  });

  test('does not match a bare number or a bare word', () => {
    expect(extractTaskRefs('6940')).toEqual([]);
    expect(extractTaskRefs('Video')).toEqual([]);
  });
});

describe('matchRefToRecords', () => {
  const records = [
    { id: 'r1', name: 'PL_6940_6940_M689_S0_EN_usr_KRU_PRI_Video_NEW_9x16' },
    { id: 'r2', name: 'PL_6940_6940_M689_S0_EN_usr_KRU_PRI_Stat_VAR_9x16' },
    { id: 'r3', name: 'PL_69400_1_Video_NEW_9x16' },
    { id: 'r4', name: 'TV_13286_1_Video_NEW_9x16' },
  ];

  test('a shorthand reference matches every task sharing that prefix', () => {
    expect(matchRefToRecords('PL_6940', records).map(r => r.id)).toEqual(['r1', 'r2']);
  });

  test('the prefix must end on a segment boundary', () => {
    // PL_6940 must NOT match PL_69400_...
    expect(matchRefToRecords('PL_6940', records).map(r => r.id)).not.toContain('r3');
  });

  test('a full name matches exactly that task', () => {
    expect(matchRefToRecords(records[0].name, records).map(r => r.id)).toEqual(['r1']);
  });

  test('an unknown reference matches nothing', () => {
    expect(matchRefToRecords('ZZ_1', records)).toEqual([]);
    expect(matchRefToRecords('', records)).toEqual([]);
  });
});

describe('linkFieldForRecord', () => {
  test('Stat uses the Figma/Canvas field', () => {
    expect(linkFieldForRecord({ format: 'Stat' })).toBe(FIGMA_LINK_FIELD);
  });

  test('Video uses the Creative Link field', () => {
    expect(linkFieldForRecord({ format: 'Video' })).toBe(CREATIVE_LINK_FIELD);
  });

  test('Format wins over the name', () => {
    expect(linkFieldForRecord({ format: 'Video', name: 'X_1_Stat_NEW_9x16' })).toBe(CREATIVE_LINK_FIELD);
  });

  test('falls back to the name when Format is empty', () => {
    expect(linkFieldForRecord({ format: '', name: 'X_1_Stat_NEW_9x16' })).toBe(FIGMA_LINK_FIELD);
    expect(linkFieldForRecord({ format: '  ', name: 'X_1_Video_NEW_9x16' })).toBe(CREATIVE_LINK_FIELD);
  });

  test('defaults to Creative Link when nothing is known', () => {
    expect(linkFieldForRecord({})).toBe(CREATIVE_LINK_FIELD);
  });
});

describe('resolveFieldName', () => {
  test('prefers an exact match', () => {
    expect(resolveFieldName(['Creative Link', 'Figma/Canvas link'], 'Figma/Canvas link'))
      .toBe('Figma/Canvas link');
  });

  test('falls back to a case-insensitive match', () => {
    expect(resolveFieldName(['Figma/Canvas Link'], 'Figma/Canvas link')).toBe('Figma/Canvas Link');
  });

  test('falls back to a field containing every word', () => {
    expect(resolveFieldName(['Figma / Canvas link (board)'], 'Figma/Canvas link'))
      .toBe('Figma / Canvas link (board)');
  });

  test('returns null when the field is absent rather than guessing', () => {
    expect(resolveFieldName(['Creative Link', 'Preview'], 'Figma/Canvas link')).toBeNull();
    expect(resolveFieldName([], 'Figma/Canvas link')).toBeNull();
    expect(resolveFieldName(['Anything'], '')).toBeNull();
  });
});
