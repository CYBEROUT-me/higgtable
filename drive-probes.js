// drive-probes.js  (main process)
// THE ONLY FILE CONTAINING DOM ASSUMPTIONS ABOUT GOOGLE DRIVE'S WEB UI.
// When Google changes the UI, this is the file to repair. To re-derive any of
// it, run from the app's DevTools:
//
//   await window.app.driveDiagnose('<folderId>', { probeUpload: true })
//   await window.app.driveDiagnose('<folderId>', { probeNewFolder: true })
//
// Every value below came from diagnostic runs on 2026-08-19 against a live
// Drive account — none of it is guessed.

const PROBES = {
  // Present on a loaded folder page; used by preflight.
  mainRegion: {
    describe: 'Main content region of a folder view',
    derivedFrom: '2026-08-19 report.mainRegions',
    selector: '[role=main]',
  },

  // Each child item (file OR folder) is a gridcell carrying the Drive item id.
  // Evidence: <div role="gridcell" aria-label="Test folder Folder"
  //            data-id="1ChDtpUZ0TI3ReTZXeuwr8YIkheKCNM2R">
  //            innerText="Test folder\nMore actions"
  itemRow: {
    describe: 'A file/folder row in the listing, carrying its Drive id',
    derivedFrom: '2026-08-19 report.dataIdSamples',
    selector: '[role=gridcell][data-id]',
    idAttribute: 'data-id',
    // Name is the first line of innerText — more robust than aria-label, which
    // appends a type word and, for files, "More info (Option + ...)".
    nameFromInnerTextFirstLine: true,
    // Folders end with " Folder"; ENDS-with matters, since a file named
    // "My Folder.png" yields "My Folder.png Image" which merely contains it.
    folderAriaLabelSuffix: ' Folder',
  },

  // Two buttons read "New"; one is 0x0. Must filter to visible.
  newButton: {
    describe: 'The "New" button that opens the create menu',
    derivedFrom: '2026-08-19 uploadProbe.newCandidates (one visible 101x56, one 0x0)',
    text: 'New',
  },

  // Menu entries, opened by the New button.
  menuItemNewFolder: {
    describe: 'The "New folder" entry in the New menu',
    derivedFrom: '2026-08-19 uploadProbe.menuItems',
    text: 'New folder', // full label is "New folder\n^C then F"
  },
  menuItemFileUpload: {
    describe: 'The "File upload" entry in the New menu',
    derivedFrom: '2026-08-19 uploadProbe.menuItems',
    text: 'File upload', // full label is "File upload\n^C then U"
  },

  // New folder dialog. id is generated per render and the class is obfuscated,
  // so aria-label is the only stable handle.
  folderNameInput: {
    describe: 'Text field in the New folder dialog (pre-filled "Untitled folder")',
    derivedFrom: '2026-08-19 newFolderProbe.inputs',
    selector: 'input[aria-label="New folder"]',
  },
  createButton: {
    describe: 'Confirm button in the New folder dialog',
    derivedFrom: '2026-08-19 newFolderProbe.dialogButtons ["", "Cancel", "Create"]',
    text: 'Create',
  },
};

// Probes that must exist on a plain loaded folder page. The menu and dialog
// probes are deliberately excluded: they only exist after an interaction, so
// they are validated at their point of use instead.
const PREFLIGHT_PROBES = ['mainRegion'];

module.exports = { PROBES, PREFLIGHT_PROBES };
