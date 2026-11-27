const {
  STALE_AFTER_MS, OPEN_STATUSES, shortTableName, freshnessText, taskLine,
  findTasks, getTask, resolveDesigner, myTasks, workload, TOOL_DEFINITIONS, runTool,
} = require('../renderer/mcp-tools');
const { computeWorkload } = require('../renderer/workload-data');

const NO_CACHE = 'No HiggTable data found. Open HiggTable once and let it load the tables.';

const rec = (id, fields, createdTime = '2026-11-01T10:00:00.000Z') => ({ id, createdTime, fields });

const NOW = new Date(2026, 10, 27, 15, 0);
const VCP_SYNC = new Date(2026, 10, 27, 14, 32).getTime();
const PLM_SYNC = new Date(2026, 10, 24, 14, 32).getTime();

function fixture() {
  return [
    {
      tableName: 'VCP Creatives', syncedAt: VCP_SYNC, records: [
        rec('rec00000000000001', {
          Name: 'LO_15945_13140_M0_S0_GR_usr_ARI_ILU_Video_VAR_Mix_9x16',
          Status: 'In work', DES: 'Olena', Priority: 'High', Deadline: '2026-11-29',
          Type: 'VAR', Format: 'Video', Project: 'LO', Hours: '01:30',
          'Old ID': 13140, 'New ID': 15945,
          Description: 'Make the cat intro\\_v2 shorter',
          'Creative Link': 'https://drive.google.com/drive/folders/abc',
          REF: 'https://ref.example/1',
        }, '2026-11-20T10:00:00.000Z'),
        rec('rec00000000000002', {
          Name: 'LO_15946_13140_M0_S0_DE_usr_ARI_ILU_Video_VAR_Mix_9x16',
          Status: 'Ready for Design', DES: 'Olena', Priority: 'Medium', Deadline: '2026-12-05',
          Description: 'Dog outro',
        }, '2026-11-21T10:00:00.000Z'),
        rec('rec00000000000003', { Status: 'To accept', DES: 'Olena', Description: 'cat intro without a name' }),
        rec('rec00000000000004', {
          Name: 'LO_16001_13140_M0_S0_EN_usr_ARI_ILU_Video_VAR_Mix_9x16', Status: 'Done', DES: 'Ivan',
        }),
      ],
    },
    {
      tableName: 'PLM Creatives', syncedAt: PLM_SYNC, records: [
        rec('rec00000000000005', {
          Name: 'PL_7001_7001_M1_S1_EN_usr_KRU_VER_Video_NEW_9x16', Status: 'In work', DES: 'Ivan',
          Description: 'Bright palette',
        }),
        rec('rec00000000000006', {
          Name: 'PL_7002_7001_M1_S1_EN_usr_KRU_VER_Video_VAR_9x16', Status: 'Rework', DES: 'Ivan',
          Deadline: '2026-11-26',
        }),
      ],
    },
    {
      tableName: 'LB Creatives', syncedAt: VCP_SYNC, records: [
        rec('rec00000000000007', {
          Name: 'LB_500_500_M2_S2_EN_usr_NOV_PRI_Stat_NEW_1x1', Status: 'In work', DES: 'Ivan',
          Format: 'Stat', 'Figmа Link': 'https://figma.com/file/lb',
        }),
      ],
    },
  ];
}

const ctx = (over = {}) => ({ sources: fixture(), defaultDesigner: 'Olena', now: NOW, ...over });
const taskLines = text => text.split('\n').filter(l => / · /.test(l) && !l.startsWith('From HiggTable'));

describe('shortTableName', () => {
  test('drops the " Creatives" suffix', () => {
    expect(shortTableName('VCP Creatives')).toBe('VCP');
  });
  test('leaves other names alone', () => {
    expect(shortTableName('tblX')).toBe('tblX');
  });
});

describe('freshnessText', () => {
  test('names each table with its sync time', () => {
    expect(freshnessText(fixture(), NOW)).toContain('VCP synced 27 Nov 14:32');
  });
  test('warns about a table not synced for over a day', () => {
    expect(freshnessText(fixture(), NOW)).toContain('PLM was last synced 3 days ago; open HiggTable to refresh it.');
    expect(freshnessText(fixture(), NOW)).not.toContain('VCP was last synced');
  });
  test('says there is no data when nothing is cached', () => {
    expect(freshnessText([], NOW)).toBe(NO_CACHE);
  });
  test('stale threshold is 24 hours', () => {
    expect(STALE_AFTER_MS).toBe(86400000);
    expect(OPEN_STATUSES).toEqual(['Rework', 'Ready for Design', 'In work']);
  });
});

describe('taskLine', () => {
  test('shows status, designer, days left, priority and table', () => {
    const r = fixture()[0].records[0];
    expect(taskLine(r, 'VCP Creatives', NOW)).toBe(
      'LO_15945_13140_M0_S0_GR_usr_ARI_ILU_Video_VAR_Mix_9x16 · In work · Olena · due 29 Nov (in 2 days) · High · VCP');
  });
  test('marks an overdue deadline as late', () => {
    const r = fixture()[1].records[1];
    expect(taskLine(r, 'PLM Creatives', NOW)).toContain('due 26 Nov (1 day late)');
  });
  test('does not call a finished task late', () => {
    const r = rec('recX', { Name: 'LO_1_Video', Status: 'Done', Deadline: '2026-10-05' });
    expect(taskLine(r, 'VCP Creatives', NOW)).toBe('LO_1_Video · Done · due 5 Oct · VCP');
  });
  test('leaves out empty parts', () => {
    const r = fixture()[1].records[0];
    expect(taskLine(r, 'PLM Creatives', NOW)).toBe('PL_7001_7001_M1_S1_EN_usr_KRU_VER_Video_NEW_9x16 · In work · Ivan · PLM');
  });
});

describe('findTasks', () => {
  test('finds a task by its number and ends with the freshness line', () => {
    const { text, isError } = findTasks(ctx(), { query: 'LO_15945' });
    expect(isError).toBe(false);
    expect(taskLines(text)[0]).toMatch(/^LO_15945_13140_/);
    expect(text.endsWith(freshnessText(fixture(), NOW))).toBe(true);
  });
  test('falls back to briefs that mention the query', () => {
    const { text } = findTasks(ctx(), { query: 'cat intro' });
    expect(text).toContain('Brief mentions it:\nLO_15945_13140_M0_S0_GR_usr_ARI_ILU_Video_VAR_Mix_9x16');
  });
  test('filters by designer regardless of case and spaces', () => {
    const lines = taskLines(findTasks(ctx(), { query: 'LO', designer: '  olena ' }).text);
    expect(lines.length).toBe(2);
    lines.forEach(l => expect(l).toContain(' · Olena · '));
  });
  test('filters by status', () => {
    const lines = taskLines(findTasks(ctx(), { query: '_EN_', status: 'in work' }).text);
    expect(lines.length).toBe(2);
    lines.forEach(l => expect(l).toContain(' · In work · '));
  });
  test('filters by table short name', () => {
    const lines = taskLines(findTasks(ctx(), { query: '_EN_', table: 'PLM' }).text);
    expect(lines.length).toBe(2);
    lines.forEach(l => expect(l.endsWith(' · PLM')).toBe(true));
  });
  test('rejects a one-character query', () => {
    const { text, isError } = findTasks(ctx(), { query: 'x' });
    expect(isError).toBe(true);
    expect(text).toMatch(/at least 2 characters/);
  });
  test('caps the result at 50 tasks', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      rec(`recM${String(i).padStart(13, '0')}`, { Name: `LO_${20000 + i}_1_Video_NEW_9x16`, Status: 'In work' }));
    const c = ctx({ sources: [...fixture(), { tableName: 'OMGF Creatives', syncedAt: VCP_SYNC, records: many }] });
    expect(taskLines(findTasks(c, { query: 'LO', limit: 500 }).text).length).toBe(50);
  });
  test('never lists a record without a name', () => {
    const { text } = findTasks(ctx(), { query: 'cat intro' });
    expect(text).not.toContain('without a name');
    expect(taskLines(text).length).toBe(1);
  });
  test('says there is no data when nothing is cached', () => {
    expect(findTasks(ctx({ sources: [] }), { query: 'LO' }).text).toBe(NO_CACHE);
  });
});

describe('getTask', () => {
  test('shows the cleaned brief, links and table', () => {
    const { text, isError } = getTask(ctx(), { task: 'LO_15945_13140_M0_S0_GR_usr_ARI_ILU_Video_VAR_Mix_9x16' });
    expect(isError).toBe(false);
    expect(text).toContain('Brief:\nMake the cat intro_v2 shorter');
    expect(text).toContain('Creative Link: https://drive.google.com/drive/folders/abc');
    expect(text).toContain('REF: https://ref.example/1');
    expect(text).toContain('Table: VCP');
    expect(text).toContain('Hours: 01:30');
  });
  test("finds LB's Figma link spelled with a Cyrillic letter", () => {
    expect(getTask(ctx(), { task: 'LB_500' }).text).toContain('Figma: https://figma.com/file/lb');
  });
  test('resolves a record id', () => {
    expect(getTask(ctx(), { task: 'rec00000000000001' }).text)
      .toMatch(/^LO_15945_13140_M0_S0_GR_usr_ARI_ILU_Video_VAR_Mix_9x16\n/);
  });
  test('lists the candidates when several tasks match', () => {
    const { text, isError } = getTask(ctx(), { task: 'LO_159' });
    expect(isError).toBe(false);
    expect(text).toMatch(/^Several tasks match/);
    expect(text).toContain('LO_15945_13140_');
    expect(text).toContain('LO_15946_13140_');
  });
  test('reports a task that does not exist', () => {
    const { text, isError } = getTask(ctx(), { task: 'NOPE_1' });
    expect(isError).toBe(true);
    expect(text).toContain('No task matches');
  });
});

describe('resolveDesigner', () => {
  test('matches regardless of case and spaces', () => {
    expect(resolveDesigner(fixture(), ' IVAN ')).toEqual({ name: 'Ivan' });
  });
  test('lists the known names for an unknown one', () => {
    expect(resolveDesigner(fixture(), 'Nobody').error).toContain('Ivan, Olena');
  });
});

describe('myTasks', () => {
  test("lists the default designer's open tasks, soonest deadline first", () => {
    const { text, isError } = myTasks(ctx(), {});
    expect(isError).toBe(false);
    const lines = taskLines(text);
    expect(lines.map(l => l.split(' · ')[0])).toEqual([
      'LO_15945_13140_M0_S0_GR_usr_ARI_ILU_Video_VAR_Mix_9x16',
      'LO_15946_13140_M0_S0_DE_usr_ARI_ILU_Video_VAR_Mix_9x16',
    ]);
    expect(text.endsWith(freshnessText(fixture(), NOW))).toBe(true);
  });
  test('a named designer overrides the default, undated tasks last', () => {
    const lines = taskLines(myTasks(ctx(), { designer: 'ivan' }).text).map(l => l.split(' · ')[0]);
    expect(lines).toEqual([
      'PL_7002_7001_M1_S1_EN_usr_KRU_VER_Video_VAR_9x16',
      'LB_500_500_M2_S2_EN_usr_NOV_PRI_Stat_NEW_1x1',
      'PL_7001_7001_M1_S1_EN_usr_KRU_VER_Video_NEW_9x16',
    ]);
  });
  test('asks for "I am" when no designer is known', () => {
    const { text, isError } = myTasks(ctx({ defaultDesigner: '' }), {});
    expect(isError).toBe(true);
    expect(text).toContain('Settings → Claude → "I am"');
    expect(text).toContain('Ivan, Olena');
  });
});

describe('workload', () => {
  test('counts open and High tasks per designer like the Workload tab', () => {
    const { text } = workload(ctx(), {});
    expect(text).toContain('Olena: 2 open (1 High)');
    const olena = computeWorkload(fixture()).rows.find(r => r.des === 'Olena');
    expect(text).toContain(`Ready for Design ${olena.statuses['Ready for Design']}, In work ${olena.statuses['In work']}`);
  });
  test('rejects an unknown table and lists the real ones', () => {
    const { text, isError } = workload(ctx(), { table: 'XYZ' });
    expect(isError).toBe(true);
    expect(text).toContain('LB, PLM, VCP');
  });
});

describe('tool definitions and dispatch', () => {
  test('exposes exactly the four read-only tools', () => {
    expect(TOOL_DEFINITIONS.map(t => t.name)).toEqual(['find_tasks', 'get_task', 'my_tasks', 'workload']);
    TOOL_DEFINITIONS.forEach(t => {
      expect(t.description.startsWith('Read-only. UT Marketing Team Airtable tasks as last synced by HiggTable on this computer.')).toBe(true);
      expect(t.inputSchema.type).toBe('object');
      expect(t.inputSchema.additionalProperties).toBe(false);
    });
    expect(TOOL_DEFINITIONS[0].inputSchema.required).toEqual(['query']);
    expect(TOOL_DEFINITIONS[1].inputSchema.required).toEqual(['task']);
  });
  test('runTool dispatches by name', () => {
    expect(runTool('get_task', { task: 'rec00000000000001' }, ctx()).text)
      .toBe(getTask(ctx(), { task: 'rec00000000000001' }).text);
  });
  test('runTool rejects an unknown tool', () => {
    expect(runTool('drop_table', {}, ctx())).toEqual({ isError: true, text: 'Unknown tool: drop_table' });
  });
});

describe('designer spellings that differ between tables', () => {
  const messy = () => {
    const sources = fixture();
    sources[2].records.push(rec('rec00000000000008', {
      Name: 'LB_501_500_M2_S2_EN_usr_NOV_PRI_Stat_VAR_1x1', Status: 'In work', DES: 'olena ', Deadline: '2026-11-28',
    }));
    return sources;
  };
  test('my_tasks includes every spelling of the designer', () => {
    const lines = taskLines(myTasks(ctx({ sources: messy() }), { designer: 'OLENA' }).text).map(l => l.split(' · ')[0]);
    expect(lines).toEqual([
      'LB_501_500_M2_S2_EN_usr_NOV_PRI_Stat_VAR_1x1',
      'LO_15945_13140_M0_S0_GR_usr_ARI_ILU_Video_VAR_Mix_9x16',
      'LO_15946_13140_M0_S0_DE_usr_ARI_ILU_Video_VAR_Mix_9x16',
    ]);
  });
  test('find_tasks designer filter includes every spelling', () => {
    expect(taskLines(findTasks(ctx({ sources: messy() }), { query: '_Stat_', designer: 'Olena' }).text)).toHaveLength(1);
  });
  test('known designers are listed once per person', () => {
    expect(resolveDesigner(messy(), 'Nobody').error).toContain('Known designers: Ivan, Olena.');
  });
});
