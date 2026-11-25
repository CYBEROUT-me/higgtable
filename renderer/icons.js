// renderer/icons.js
// The app's icon set: line icons on a 16×16 grid, 1.5 px stroke, round caps and
// joins, drawn in currentColor so they follow the button's text colour. Same
// style as the inline header icons in index.html. No DOM access here: app.js
// puts the markup into elements with a data-icon attribute (applyIcons).

const ICON_PATHS = {
  dashboard: '<path d="M2.5 13.5h11"/><path d="M4.5 11V7.5"/><path d="M8 11V4"/><path d="M11.5 11V9"/>',
  workload: '<circle cx="6" cy="5.5" r="2.2"/><path d="M2 13c0-2.2 1.8-3.8 4-3.8s4 1.6 4 3.8"/><path d="M10.5 3.5a2.2 2.2 0 0 1 0 4.2"/><path d="M11.8 9.5c1.3.5 2.2 1.8 2.2 3.5"/>',
  lineage: '<circle cx="4" cy="3.5" r="1.5"/><circle cx="4" cy="12.5" r="1.5"/><circle cx="12" cy="5.5" r="1.5"/><path d="M4 5v6"/><path d="M12 7v.5a3 3 0 0 1-3 3H5.5"/>',
  play: '<path d="M5 3.3v9.4l7.2-4.7z"/>',
  undo: '<path d="M5.5 3.5l-3 3 3 3"/><path d="M2.5 6.5h6.5a3.5 3.5 0 0 1 0 7H7"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>',
  brief: '<path d="M9.5 1.5h-5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-9z"/><path d="M9.5 1.5v3h3"/><path d="M5.8 8h4.4"/><path d="M5.8 10.5h4.4"/>',
  link: '<path d="M6.8 9.2a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-.8.8"/><path d="M9.2 6.8a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l.8-.8"/>',
  close: '<path d="M4 4l8 8"/><path d="M12 4l-8 8"/>',
  folder: '<path d="M1.75 4.25a1 1 0 0 1 1-1h3.2l1.5 1.5h5.8a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z"/>',
  external: '<path d="M9.5 2.5h4v4"/><path d="M13.5 2.5L8 8"/><path d="M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/>',
  expand: '<path d="M9.5 2.5h4v4"/><path d="M6.5 13.5h-4v-4"/><path d="M13.5 2.5L9 7"/><path d="M2.5 13.5L7 9"/>',
  settings: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v2M8 12.2v2M14.2 8h-2M3.8 8h-2M12.4 3.6l-1.4 1.4M4.9 11.1l-1.4 1.4M12.4 12.4l-1.4-1.4M4.9 4.9L3.5 3.5"/>',
  refresh: '<path d="M3 8a5 5 0 0 1 8.5-3.5"/><path d="M13 8a5 5 0 0 1-8.5 3.5"/><path d="M11.5 2.5v2.3h-2.3"/><path d="M4.5 13.5v-2.3h2.3"/>',
  back: '<path d="M13 8H3"/><path d="M7 4L3 8l4 4"/>',
  minus: '<path d="M3.5 8h9"/>',
  plus: '<path d="M8 3.5v9"/><path d="M3.5 8h9"/>',
  check: '<path d="M3 8.5l3.2 3L13 4.5"/>',
  clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.8V8l2.2 1.4"/>',
  warning: '<path d="M8 2.5l6 10.5H2z"/><path d="M8 6.5v3"/><path d="M8 11.4v.1"/>',
  up: '<path d="M4 10l4-4 4 4"/>',
  table: '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5"/><path d="M1.75 6.25h12.5"/><path d="M1.75 9.75h12.5"/><path d="M6 6.25v7"/>',
  board: '<rect x="1.75" y="2.75" width="3.5" height="10.5" rx="1"/><rect x="6.25" y="2.75" width="3.5" height="7" rx="1"/><rect x="10.75" y="2.75" width="3.5" height="8.5" rx="1"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.4 10.4l3.1 3.1"/>',
  video: '<rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5"/><path d="M6.6 6v4l3.4-2z"/>',
  image: '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5"/><circle cx="5.6" cy="6.2" r="1.1"/><path d="M14.25 10.5l-3.5-3.5-6.5 6.25"/>',
  down: '<path d="M4 6l4 4 4-4"/>',
};

// Full <svg> markup for one icon; an unknown name gives an empty string.
function iconSvg(name) {
  const paths = ICON_PATHS[name];
  if (!paths) return '';
  return `<svg class="icon-svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ICON_PATHS, iconSvg };
}
