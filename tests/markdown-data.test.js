const { escapeHtml, linkifyUrls, renderMarkdownLite } = require('../renderer/markdown-data');

test('escapeHtml escapes &, <, and > but leaves quotes alone', () => {
  expect(escapeHtml('Tom & Jerry <script> "quoted"')).toBe('Tom &amp; Jerry &lt;script&gt; "quoted"');
});

test('linkifyUrls wraps a bare URL with no surrounding punctuation', () => {
  expect(linkifyUrls('See https://example.com/path for details')).toBe(
    'See <a href="https://example.com/path" class="record-markdown-link">https://example.com/path</a> for details'
  );
});

test('linkifyUrls strips a trailing closing paren, matching the reported (url) pattern', () => {
  const input = '(https://drive.google.com/file/d/XYZ/view?usp=sharing)';
  expect(linkifyUrls(input)).toBe(
    '(<a href="https://drive.google.com/file/d/XYZ/view?usp=sharing" class="record-markdown-link">https://drive.google.com/file/d/XYZ/view?usp=sharing</a>)'
  );
});

test('linkifyUrls strips trailing sentence punctuation', () => {
  expect(linkifyUrls('Link: https://example.com/a.')).toBe(
    'Link: <a href="https://example.com/a" class="record-markdown-link">https://example.com/a</a>.'
  );
  expect(linkifyUrls('Link: https://example.com/a,')).toBe(
    'Link: <a href="https://example.com/a" class="record-markdown-link">https://example.com/a</a>,'
  );
});

test('linkifyUrls leaves text with no URL unchanged', () => {
  expect(linkifyUrls('No links here.')).toBe('No links here.');
});

test('renderMarkdownLite combines escaping, linkification, bold, and line breaks', () => {
  const input = 'Розвиток TTOne\n[TikTok One_0486]\n(https://drive.google.com/file/d/XYZ/view?usp=sharing)\n**Що робимо:** перегенеруємо відео креатора';
  const result = renderMarkdownLite(input);
  expect(result).toBe(
    'Розвиток TTOne<br>' +
    '[TikTok One_0486]<br>' +
    '(<a href="https://drive.google.com/file/d/XYZ/view?usp=sharing" class="record-markdown-link">https://drive.google.com/file/d/XYZ/view?usp=sharing</a>)<br>' +
    '<strong>Що робимо:</strong> перегенеруємо відео креатора'
  );
});

test('renderMarkdownLite still escapes HTML-significant characters in plain text', () => {
  expect(renderMarkdownLite('a < b && b > c')).toBe('a &lt; b &amp;&amp; b &gt; c');
});
