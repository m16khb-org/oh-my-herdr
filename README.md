# oh-my-herdr

File name and content search, Markdown previews and file editing for the
[Herdr](https://herdr.dev) desktop app's Files panel, on Windows, macOS, Linux
and remote machines.

## Contents

- `mods/files-search/`: the Files panel with a search box (**Name** /
  **Content**), backed by ripgrep, an editor for this computer's files, and
  a live Markdown preview beside the text.
- `layouts/main-search.json`: Herdr's `main` layout using `files-search` for
  the Files panel.
- Other `mods/` and `layouts/`: Herdr 0.1.13's built-in mods and layouts, for
  reference. Don't install these.
- `AGENTS.md`: install and change notes for coding agents.
- `docs/herdr-app-AGENTS.md`: the Herdr app's interface reference (mod API).

## Install

macOS / Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/m16khb-org/oh-my-herdr/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/m16khb-org/oh-my-herdr/main/install.ps1 | iex
```

Requirements, uninstall and platform notes: [INSTALL.md](INSTALL.md).

## License

GPL-3.0-only. See [LICENSE](LICENSE). Herdr-derived files are Apache-2.0
upstream and bundled fonts keep their CC BY-SA licenses; see [NOTICE](NOTICE).
