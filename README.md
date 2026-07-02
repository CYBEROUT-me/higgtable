# HiggTable

Internal desktop app for the marketing team: browse Airtable creative tasks, rename media files to match a task's naming convention, and track completed work on a dashboard.

## Installing (macOS)

1. Download the latest `HiggTable-*.dmg` from [Releases](https://github.com/CYBEROUT-me/higgtable/releases).
2. Open the `.dmg` and drag **HiggTable** into **Applications**.
3. Before opening it for the first time, run this once in Terminal:
   ```bash
   xattr -cr /Applications/HiggTable.app
   ```
   This is required because the app isn't code-signed with a paid Apple Developer certificate — without it, macOS reports the app as "damaged" and refuses to open it.
4. Open HiggTable from Applications.

If you skip step 3, you can alternatively right-click the app → **Open** → **Open** in the dialog (works once).

## Installing (Windows)

1. Download the latest `HiggTable Setup *.exe` from [Releases](https://github.com/CYBEROUT-me/higgtable/releases).
2. Run the installer. Windows SmartScreen may warn about an unrecognized publisher — click **More info → Run anyway**.

## First launch

On first open, HiggTable asks for your Airtable Personal Access Token:

1. Go to [airtable.com](https://airtable.com) → Account → Developer hub → Personal access tokens.
2. Create a token with read/write access to the **UT Marketing Team** base.
3. Paste it into HiggTable's settings prompt.

Your token is stored locally on your machine only (never bundled in the app or shared).

## Using the app

- **Tabs** (VCP / PLM / CMC / LB) — browse each Creatives table. Filter by status or by designer ("You:").
- **Double-click a task row** — opens the full task details, with every Airtable field editable directly (saves back to Airtable immediately). Use the ⚙ icon there to hide fields you don't need to see.
- **Select a task, then drop media files** — HiggTable detects each file's aspect ratio and renames it to match the task's naming convention, placing renamed files in a subfolder named after the task.
- **Dashboard tab** — leaderboard of completed ("Done") tasks by designer, broken down by type, filterable by period (week/month/custom range).
- **Notifications** — when a new task is assigned to you, clicking the notification jumps straight to it.

## Updates

- **Windows**: checks for updates on launch and installs them silently, prompting you to restart.
- **macOS**: checks for updates on launch and shows a dialog linking to the new `.dmg` if one is available (can't auto-install since the app isn't signed).

## Development

```bash
npm install
npm start          # run locally
npm test            # run tests
```

### Releasing a new version

1. Bump `version` in `package.json`.
2. Build and publish to GitHub Releases:
   ```bash
   export GH_TOKEN=<a GitHub personal access token with repo access>
   npm run release          # both macOS and Windows
   ```
   Or `npm run release:mac` / `npm run release:win` individually.
3. This is what both the Windows silent updater and the macOS update check on launch actually look at — without publishing a release, coworkers never see the new version.
