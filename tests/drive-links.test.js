const { rewriteDriveLink } = require('../renderer/drive-links');

test('inserts /u/N/ into a Drive URL with no existing account segment', () => {
  const url = 'https://drive.google.com/drive/search?q=parent:X%20title:Y';
  expect(rewriteDriveLink(url, 2)).toBe('https://drive.google.com/drive/u/2/search?q=parent:X%20title:Y');
});

test('accepts a string accountIndex the same as a number', () => {
  const url = 'https://drive.google.com/drive/folders/ABC123';
  expect(rewriteDriveLink(url, '2')).toBe('https://drive.google.com/drive/u/2/folders/ABC123');
});

test('account index 0 rewrites — it is a valid value, distinct from unset', () => {
  const url = 'https://drive.google.com/drive/my-drive';
  expect(rewriteDriveLink(url, 0)).toBe('https://drive.google.com/drive/u/0/my-drive');
});

test('leaves a URL that already has its own /u/N/ segment untouched', () => {
  const url = 'https://drive.google.com/drive/u/5/folders/ABC123';
  expect(rewriteDriveLink(url, 2)).toBe(url);
});

test('leaves a non-Drive URL untouched', () => {
  const url = 'https://example.com/drive/search?q=parent:X';
  expect(rewriteDriveLink(url, 2)).toBe(url);
});

test('treats a blank, undefined, or non-numeric accountIndex as no rewriting', () => {
  const url = 'https://drive.google.com/drive/search?q=parent:X';
  expect(rewriteDriveLink(url, '')).toBe(url);
  expect(rewriteDriveLink(url, undefined)).toBe(url);
  expect(rewriteDriveLink(url, 'abc')).toBe(url);
});
