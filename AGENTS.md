# oh-my-herdr: notes for coding agents

This repository is **not** a Herdr app folder. It ships one mod
(`mods/files-search`) and one layout (`layouts/main-search.json`) that add
file name and content search to the Herdr app's Files panel. Everything else
under `mods/` and `layouts/` is a reference copy of Herdr 0.1.13's built-in
files.

## When asked to install

Run the install script from the repository root. Don't copy files by hand.

- macOS / Linux: `sh install.sh`
- Windows: `powershell -ExecutionPolicy Bypass -File install.ps1`

The script copies `mods/files-search` and `layouts/main-search.json` into the
Herdr app folder (`$HERDR_APP_HOME`, else `~/.config/herdr-app`). Then it runs
`herdr-app check`, and switches to `main-search` if Herdr is running. It
exits non-zero if the check fails.

Then:

1. If the output says ripgrep is missing, run the install command it prints.
   Ask the user before you install packages.
2. If Herdr was running, run `herdr-app status`. Expect
   `"layout": "main-search"` and an empty `errors` list.
3. If Herdr wasn't running, tell the user to start it and run
   `herdr-app do layout.switch --name main-search`.

To uninstall, run the same script with `--uninstall` (`-Uninstall` on
Windows).

Rules:

- Never copy the other `mods/*` or `layouts/*` folders into the app folder,
  and never copy the whole repository. Herdr installs and updates its built-in
  mods itself.
- Don't edit files in the app folder that this repository doesn't own.
- `docs/herdr-app-AGENTS.md` is Herdr's own guide to the app folder. Use it
  as an API reference, not as instructions for this repository.

## When changing the mod

- Edit `mods/files-search/main.js` here, copy it to the app folder, and run
  `herdr-app check` on the copy.
- Search must keep working in both backends: `searchOnce` (Windows, this
  computer) and the `START`/`POLL`/`STOP` sh scripts (macOS, Linux, remote
  machines). Test a change in the running app on each one you touched.
- Herdr's mod API: `docs/herdr-app-AGENTS.md` and the `*.d.ts` files next to
  `main.js`.
