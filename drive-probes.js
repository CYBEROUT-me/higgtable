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
    // Drive labels items "<name> <TypeWord> [More info (Option + ...)]".
    // Folder detection strips the name and checks the type word — verified
    // 2026-08-19 against "08_August Folder More info (Option + ...)" and
    // "Test folder Folder" (folders) vs "a.jpg Image ..." (files).
    // An endsWith(' Folder') test breaks when "More info" is appended, and a
    // contains(' Folder') test wrongly matches a file named "My Folder.png".
    folderTypeWord: 'Folder',
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
  menuItemFolderUpload: {
    describe: 'The "Folder upload" entry in the New menu',
    derivedFrom: '2026-08-19 uploadProbe.menuItems',
    text: 'Folder upload', // full label is "Folder upload\n^C then I"
  },
  uploadProgressDialog: {
    describe: 'Upload progress dialog; its "X of Y" counter is the completion signal',
    derivedFrom: '2026-08-20 folderUploadProbe.dialogAfter — "Uploading 1 item 26 min left... Cancel" / "2 of 99"',
    selector: '[role=dialog]',
    counterPattern: '(\\d+)\\s+of\\s+(\\d+)',
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
