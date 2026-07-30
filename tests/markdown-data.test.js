const { escapeHtml, linkifyUrls, renderMarkdownLite, unescapeBackslashes, linkifyMarkdownLinks } = require('../renderer/markdown-data');

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

test('renderMarkdownLite combines escaping, a labeled link, bold, and line breaks', () => {
  const input = 'Розвиток TTOne\n[TikTok One_0486]\n(https://drive.google.com/file/d/XYZ/view?usp=sharing)\n**Що робимо:** перегенеруємо відео креатора';
  const result = renderMarkdownLite(input);
  expect(result).toBe(
    'Розвиток TTOne<br>' +
    '<a href="https://drive.google.com/file/d/XYZ/view?usp=sharing" class="record-markdown-link">TikTok One_0486</a><br>' +
    '<strong>Що робимо:</strong> перегенеруємо відео креатора'
  );
});

test('renderMarkdownLite still escapes HTML-significant characters in plain text', () => {
  expect(renderMarkdownLite('a < b && b > c')).toBe('a &lt; b &amp;&amp; b &gt; c');
});

test('unescapeBackslashes strips a backslash before any character', () => {
  expect(unescapeBackslashes('TikTok\\_One\\*Two')).toBe('TikTok_One*Two');
});

test('linkifyMarkdownLinks converts [label](url) with a newline between them', () => {
  const input = '[TikTok One\\_0486\\_LO\\_US\\_Campaign\\_30\\_12\\_24]\n(https://drive.google.com/file/d/XYZ/view?usp=sharing)';
  expect(linkifyMarkdownLinks(input)).toBe(
    '<a href="https://drive.google.com/file/d/XYZ/view?usp=sharing" class="record-markdown-link">TikTok One_0486_LO_US_Campaign_30_12_24</a>'
  );
});

test('linkifyMarkdownLinks also matches true adjacent markdown syntax with no whitespace', () => {
  expect(linkifyMarkdownLinks('[Docs](https://example.com/docs)')).toBe(
    '<a href="https://example.com/docs" class="record-markdown-link">Docs</a>'
  );
});

test('a bare URL alongside a labeled link is not double-wrapped and still linkifies with the URL as its own text', () => {
  const input = '[Drive](https://example.com/a) also see https://example.com/b';
  expect(renderMarkdownLite(input)).toBe(
    '<a href="https://example.com/a" class="record-markdown-link">Drive</a> also see <a href="https://example.com/b" class="record-markdown-link">https://example.com/b</a>'
  );
});
