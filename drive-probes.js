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
    // Captured 2026-08-20. The type phrase differs by ownership, which is why
    // folder detection lives in isFolderFromLabels (renderer/drive-path.js,
    // unit-tested) and reads only the LAST word of the phrase:
    //   owned:  '2026 Folder More info (Option + \u2192)'
    //   shared: '2026 Shared folder More info (Option + \u2192)'
    // A child element also carries data-tooltip ('2026 Shared folder'), used
    // as a fallback when aria-label is absent.
    typePhraseSamples: ['Folder', 'Shared folder'],
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

// VIRTUALISED LISTINGS. Drive keeps only rows near the viewport in the DOM; the
// rest appear on scroll. Reading the rendered rows therefore yields a PARTIAL
// listing, and because those rendered rows are stable, a settle check confirms
// it as complete. Observed 2026-08-20: task folders in a real client month were
// reported missing while a two-item scratch folder always worked. Every listing
// read now scrolls to the end first (exhaustListing in drive-browser.js). Any
// future code that reads rows directly instead of going through readListingHere
// will reintroduce this.

// MEASURED DEAD ENDS — do not rebuild these. Both were probed against the live
// Drive on 2026-08-20 (probeMultiFolderUpload in drive-browser.js).
//
// Delivering several task folders in ONE action is not possible:
//   * Chooser, array of paths: the folder chooser reports mode "selectSingle",
//     and that is a hard limit. DOM.setFileInputFiles returned success for an
//     array of 2 directory paths, then Chromium used only the FIRST — Drive
//     reported "1 of 1" and exactly one folder landed. Success from
//     setFileInputFiles says nothing about how many paths were honoured.
//   * CDP drag and drop: Input.dispatchDragEvent accepted dragEnter, dragOver
//     and drop with DragData.files = [dirPath, dirPath] and no error, but Drive
//     ingested NOTHING — no progress dialog, no folders. Dropping directories
//     this way does not produce the directory entries Drive's drop handler
//     reads, so a hand-made drag works where a synthesized one cannot.
// One Folder upload action per task folder is therefore the floor. Speed has to
// come from cutting per-task overhead, not from batching.

module.exports = { PROBES, PREFLIGHT_PROBES };
