# oh-my-herdr: notes for coding agents

This repository is **not** a Herdr app folder. It ships one mod
(`mods/files-search`) and one layout (`layouts/main-search.json`) that add
file name and content search to the Herdr app's Files panel. Everything else
under `mods/` and `layouts/` is a reference copy of Herdr 0.1.13's built-in
files.

## When asked to install

Follow [INSTALL.md](INSTALL.md). In short:

1. Find the Herdr app folder: `$HERDR_APP_HOME` if set, else
   `~/.config/herdr-app` (Windows: `$HOME\.config\herdr-app`).
2. Make sure `rg` runs (`rg --version`). If it doesn't, install ripgrep with
   the command for the OS in INSTALL.md.
3. Copy `mods/files-search` to `<app folder>/mods/files-search` and
   `layouts/main-search.json` to `<app folder>/layouts/main-search.json`.
4. Run `herdr-app check <app folder>/mods/files-search`. It must print
   `check passed`.
5. If Herdr is running, run `herdr-app do layout.switch --name main-search`,
   then `herdr-app status`. Expect `"layout": "main-search"` and an empty
   `errors` list.

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
