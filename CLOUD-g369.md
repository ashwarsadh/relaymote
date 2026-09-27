# CLOUD-g369 — evidence for the v2 README sections, the LLM-setup doc and the difficulty map

Branch `cloud/g369`, cut from `main` at 42d94ff. Nothing was deployed. No live server, phone, Tally or portal
was touched.

**Rule files:** there is no `CLAUDE.md`, `STATE.md` or `DIRECTIVES.md` in this repo (checked the root and the
whole tree), so none could be read. The work follows the repo's own conventions: tests in `test/`, chained
from `npm test`, and the hidden-launch rule that every spawn sets `windowsHide`.

## What the audit found

The features were already on `main`; what the audit lacked was proof. The download table (`.exe`/`.dmg`
from GitHub Releases), the "Let your AI install it" section, the multi-account sync highlight, the Remote
Control comparison and the Developer Mode + Main Process Debugger steps are all in README.md. The in-app
Windows/macOS debugger steps are in Settings › Desktop connection, and the per-level model and effort
selects are in Settings › Models. Nothing checked any of it.

## What changed

- **`scripts/check-g369.js`** (new). `node scripts/check-g369.js --check` (or `npm run check:g369`) runs six
  checks and prints `file:line` evidence for each. It exits 1 if any check fails. `--json` gives the same
  result as JSON.
  - **A.** README ## Download lists the `.exe` and both `.dmg` files. `release.yml` builds both and publishes
    them with `action-gh-release`.
  - **B.** INSTALL-FOR-AI.md exists and has at least 8 numbered steps. README links it (full URL and a
    relative link), and so does llms.txt.
  - **C.** Multi-account switching/sync: the highlight, the ## Accounts section with preview and sync, and
    the CLI line.
  - **D.** The comparison table with Claude's built-in Remote Control (at least 5 rows) and its caveat.
  - **E.** Developer Mode + Main Process Debugger for Windows (☰, automatic re-enable) and macOS (menu bar,
    manual re-enable), in the README and in the app (Desktop connection tab, the `darwin` branch,
    `canAutoEnable`, the macro).
  - **F.** The difficulty map, checked by running it rather than grepping for it. The check takes the real
    `renderModels()` and its helpers out of `mobile/public/settings-ui.js` and renders them in a `vm`
    sandbox. It confirms all four levels (`easy, medium, hard, extraHard`, which must equal
    `router.LEVELS`) each get a model select and an effort select, and that a saved model shows as
    selected. It then saves a level the way the Settings screen does (`setPath` patch → `config.set`, in a
    throwaway `RELAYMOTE_HOME`) and confirms in a fresh process that `router.rung(2)` returns
    `hard: claude-sonnet-5/max`.
- **`test/g369-evidence.js`** (new, added to `npm test`). Checks that `--check` passes and cites evidence on
  this tree. Then, on a temp copy of the relevant files, it removes one piece of evidence at a time
  (7 cases) and checks that exactly the matching check fails. This proves each check can fire.
- **README.md**: a header link "Setup guide for AI agents" → INSTALL-FOR-AI.md, and a short paragraph under
  "Let your AI install it" with a relative link to the guide (listing its nine steps) and to llms.txt.
- **package.json**: `test` now ends with `node test/g369-evidence.js`. New `check:g369` script.

## Tests run

- `node scripts/check-g369.js --check` → `g369 --check: 6/6 passed`, exit 0.
- `node test/g369-evidence.js` → 12/12 passed.
- `npm test` (full suite, with `APPDATA`/`CLAUDE_CONFIG_DIR` pointed at empty temp folders as CI does) →
  exit 0, no `FAIL` lines. The first run failed `test/hidden-launch.js`: the checker's `execFileSync` had
  no `windowsHide`. After adding it, the full suite passes.

Output of `node scripts/check-g369.js --check` at commit time:

```text
PASS A  README: GitHub Releases with installers (.exe / .dmg)
       README.md:155  ## Download
       README.md:161  | Windows 10/11 | `Relaymote-Setup-<version>.exe`
       README.md:162  | macOS, Apple silicon | `Relaymote-<version>-arm64.dmg`
       README.md:163  | macOS, Intel | `Relaymote-<version>-x64.dmg`
       README.md:19  <a href="https://github.com/ashwarsadh/relaymote/releases/latest"><b>⬇ Download
       .github/workflows/release.yml:66  dist/Relaymote-Setup-$v-x64.exe
       .github/workflows/release.yml:130  bash installer/macos/build-dmg.sh
       .github/workflows/release.yml:196  softprops/action-gh-release@v2
       .github/workflows/release.yml:204  files: dist/*
PASS B  LLM-setup doc (INSTALL-FOR-AI.md), linked from README and llms.txt
       INSTALL-FOR-AI.md:1  # Installing Relaymote — instructions for an AI agent
       INSTALL-FOR-AI.md:87  ## 5. Connect Claude Desktop (the Main Process Debugger)
       INSTALL-FOR-AI.md:121  ## 7. Pair the phone
       README.md:168  ## Let your AI install it
       README.md:173  Follow https://github.com/ashwarsadh/relaymote/blob/main/INSTALL-FOR-AI.md
       README.md:179  ](INSTALL-FOR-AI.md)
       llms.txt:7  [INSTALL-FOR-AI.md](https://github.com/ashwarsadh/relaymote/blob/main/INSTALL-FOR-AI.md)
PASS C  README: multi-account switching and sync highlighted
       README.md:53  ### 2. One app across all your Claude accounts
       README.md:57  **Relaymote keeps them in sync**, so switching accounts shows the same app
       README.md:345  ## Accounts
       README.md:351  **Preview sync** shows exactly what would change
       README.md:352  **Sync now** writes it, after backing up
       README.md:369  relaymote accounts | accounts sync [--apply]
PASS D  README: comparison with Claude's built-in Remote Control
       README.md:42  | | Claude's built-in Remote Control | Relaymote |
       README.md:45  | Switching it on | per session, and again after Claude restarts | once, at install |
       README.md:49  | Several accounts | — | one identical app across them
       README.md:51  Remote Control is Anthropic's feature and may change
PASS E  Developer Mode + Main Process Debugger setup (Windows + macOS, README and in-app)
       README.md:201  ### 2. Connect Claude Desktop (Developer Mode + Main Process Debugger)
       README.md:207  On Windows the menus are behind the
       README.md:208  on macOS they are in the menu bar
       README.md:210  **Developer › Enable Main Process Debugger**
       README.md:213  **On Windows Relaymote turns it back on for
       README.md:216  On macOS, repeat step 2 after a restart
       mobile/public/settings-ui.js:78  ['desktop', 'Desktop connection']
       mobile/public/settings-ui.js:156  var mac = desk && desk.platform === 'darwin'
       mobile/index.js:1075  canAutoEnable: process.platform === 'win32'
       scripts/enable-debugger.ps1:4  Enable Main Process Debugger
PASS F  Settings › Models: difficulty map (model + effort per level) wired to the router
       mobile/public/settings-ui.js renderModels() rendered 4 levels (easy, medium, hard, extraHard), each with a model and an effort select; saved easy → claude-sonnet-5 shows as selected
       lib/config.js set() + lib/router.js ladder(): saved levels.hard = claude-sonnet-5/max → router uses "hard: claude-sonnet-5/max" (ladder: easy: claude-opus-5-5/low · medium: claude-opus-5-5/medium · hard: claude-sonnet-5/max · extraHard: claude-opus-5-5/max)
       mobile/public/settings-ui.js:78  ['models', 'Models']
       mobile/public/settings-ui.js:200  <h3>Workers by difficulty</h3>
       lib/config.js:106  levels: {
       mobile/index.js:1061  const next = config.set(body || {})
       README.md:95  Map difficulty to model and effort in **Settings › Models**

g369 --check: 6/6 passed
```

## Left for the owning lane

- Nothing was published. A real GitHub Release (a `v*` tag that runs `release.yml`) and a check that the
  `.exe`/`.dmg` assets are attached need someone with release rights. The checker proves the workflow and
  the README, not a published release.
- The macOS `.dmg` and the macOS in-app debugger steps are still marked experimental/untested in README.
  Only a Mac run can verify them.
- F renders the Models section in a sandbox, not in a browser. A screenshot of Settings › Models in the
  real app would be visual evidence, if the audit wants it.
- No PR was opened, and nothing was merged.
