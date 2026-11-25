// tests/icons.test.js
const { ICON_PATHS, iconSvg } = require('../renderer/icons');

test('every icon renders as a 16x16 stroked svg in currentColor', () => {
  Object.keys(ICON_PATHS).forEach(name => {
    const svg = iconSvg(name);
    expect(svg).toMatch(/^<svg class="icon-svg" viewBox="0 0 16 16"/);
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('stroke-width="1.5"');
    expect(svg.endsWith('</svg>')).toBe(true);
  });
});

test('an unknown icon name gives an empty string', () => {
  expect(iconSvg('nope')).toBe('');
});
