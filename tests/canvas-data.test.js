// tests/canvas-data.test.js
const { buildChains } = require('../renderer/canvas-data');

function rec(id, newId, oldId, extra = {}) {
  return { id, fields: { 'New ID': newId, 'Old ID': oldId, Name: id, ...extra } };
}

test('a self-referencing record (Old ID === New ID) is a root with no children', () => {
  const chains = buildChains([rec('rec1', '100', '100')]);
  expect(chains).toHaveLength(1);
  expect(chains[0].record.id).toBe('rec1');
  expect(chains[0].children).toEqual([]);
});

test('a child is nested under its parent via Old ID -> New ID', () => {
  const root = rec('root', '100', '100');
  const child = rec('child', '101', '100');
  const chains = buildChains([root, child]);
  expect(chains).toHaveLength(1);
  expect(chains[0].record.id).toBe('root');
  expect(chains[0].children).toHaveLength(1);
  expect(chains[0].children[0].record.id).toBe('child');
});

test('a record whose Old ID matches nothing is treated as its own root, not dropped', () => {
  const orphan = rec('orphan', '200', '999');
  const chains = buildChains([orphan]);
  expect(chains).toHaveLength(1);
  expect(chains[0].record.id).toBe('orphan');
});

test('a record with a blank Old ID is treated as a root', () => {
  const noParent = rec('noParent', '300', null);
  const chains = buildChains([noParent]);
  expect(chains).toHaveLength(1);
  expect(chains[0].record.id).toBe('noParent');
});

test('a NEW-typed record with a real parent is nested under it, not treated as a root', () => {
  const root = rec('root', '100', '100');
  const fakeNew = rec('fakeNew', '101', '100', { Type: 'NEW' });
  const chains = buildChains([root, fakeNew]);
  expect(chains).toHaveLength(1);
  expect(chains[0].children[0].record.id).toBe('fakeNew');
});

test('fan-out: one root with multiple direct children', () => {
  const root = rec('root', '100', '100');
  const kids = [rec('k1', '101', '100'), rec('k2', '102', '100'), rec('k3', '103', '100')];
  const chains = buildChains([root, ...kids]);
  expect(chains[0].children).toHaveLength(3);
});

test('multi-generation chain: grandchild nests under child, not root', () => {
  const root = rec('root', '100', '100');
  const child = rec('child', '101', '100');
  const grandchild = rec('grandchild', '102', '101');
  const chains = buildChains([root, child, grandchild]);
  expect(chains[0].children[0].record.id).toBe('child');
  expect(chains[0].children[0].children[0].record.id).toBe('grandchild');
});

test('a two-node cycle with no valid root anchors to nothing, and does not hang', () => {
  const a = rec('a', '1', '2');
  const b = rec('b', '2', '1');
  const chains = buildChains([a, b]);
  expect(chains).toEqual([]);
});

test('a duplicate New ID reappearing deeper in the same chain is excluded by the cycle guard', () => {
  const root = rec('root', '0', '0');
  const child = rec('child', '1', '0');
  const duplicateOfRoot = rec('dup', '0', '1');
  const chains = buildChains([root, child, duplicateOfRoot]);
  expect(chains).toHaveLength(1);
  expect(chains[0].children).toHaveLength(1);
  expect(chains[0].children[0].record.id).toBe('child');
  expect(chains[0].children[0].children).toEqual([]);
});

test('multiple independent chains in the same table stay separate', () => {
  const rootA = rec('rootA', '100', '100');
  const rootB = rec('rootB', '200', '200');
  const childA = rec('childA', '101', '100');
  const chains = buildChains([rootA, rootB, childA]);
  expect(chains).toHaveLength(2);
});
