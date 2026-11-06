# Installing oh-my-herdr

oh-my-herdr adds search to the Herdr app's **Files** panel. A search box sits
at the top of the panel, with two modes:

- **Name**: file names containing the query. A query with `/` matches the
  whole relative path (`mods/files` finds `mods/files-search/main.js`).
- **Content**: lines containing the query, grouped by file, with line numbers
  and the match highlighted.

Both modes are case-insensitive unless the query has a capital letter. They
search hidden files, respect `.gitignore`, and skip `.git`. Click a result to
preview the file. Clear the box to get the folder tree back.

The panel searches the focused pane's folder, on the machine that pane runs
on (this computer or a machine added in Herdr).

## Requirements

- Herdr app 0.1.13 or newer.
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) on every machine you
  search, including remote machines.

| OS | Install ripgrep |
|---|---|
| macOS | `brew install ripgrep` |
| Windows | `winget install BurntSushi.ripgrep.MSVC` |
| Debian / Ubuntu | `sudo apt install ripgrep` |
| Fedora | `sudo dnf install ripgrep` |
| Arch | `sudo pacman -S ripgrep` |

If the panel still says `ripgrep (rg) is not installed on this machine`
after you install it, restart Herdr so it picks up the new `PATH`.

## Install

Run one command. It installs `mods/files-search` and
`layouts/main-search.json` into Herdr's app folder, then runs
`herdr-app check` on the mod. If Herdr is running, it also switches to the
`main-search` layout. It never touches Herdr's built-in mods.

macOS / Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/m16khb-org/oh-my-herdr/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/m16khb-org/oh-my-herdr/main/install.ps1 | iex
```

From a clone, run the script in the repository instead:

```sh
sh install.sh                                          # macOS / Linux
powershell -ExecutionPolicy Bypass -File install.ps1   # Windows
```

The scripts install into `$HERDR_APP_HOME` if you set it, else
`~/.config/herdr-app`. If Herdr isn't running, start it and run
`herdr-app do layout.switch --name main-search`. Open the panel with the
**Files** button at the top right.

`main-search` is Herdr's `main` layout, with the Files panel running
`files-search` in place of the built-in `files` mod. Don't copy the other
folders under `mods/` and `layouts/` into Herdr: they are copies of Herdr's
built-in files, which Herdr installs and updates itself.

## Platform notes

- **macOS, Linux and remote machines**: rg runs in the background and results
  show up while it searches. A new query stops the previous search.
- **Windows (this computer)**: rg runs once per query and results appear when
  it finishes. Herdr gives one run 30 seconds and 8 MiB of output, so search a
  project folder, not your whole home folder.
- Both modes show at most 2,000 results. Content search reports at most 100
  matching lines per file.

## Update

Run the install command again. Herdr reloads the mod as soon as the files
change.

## Uninstall

The uninstall switches Herdr back to `main` if it shows `main-search`, then
removes both files.

```sh
curl -fsSL https://raw.githubusercontent.com/m16khb-org/oh-my-herdr/main/install.sh | sh -s -- --uninstall
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/m16khb-org/oh-my-herdr/main/install.ps1))) -Uninstall
```

From a clone: `sh install.sh --uninstall`, or
`powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall`.

If a layout ever leaves the window unusable, `Ctrl+Alt+Shift+Escape` always
switches back to the default `main` layout.
