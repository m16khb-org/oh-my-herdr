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

Install only `mods/files-search` and `layouts/main-search.json`. The other
folders under `mods/` and `layouts/` are copies of Herdr's built-in files.
Herdr installs and updates its own copies, so don't copy them over.

macOS / Linux:

```sh
git clone https://github.com/m16khb-org/oh-my-herdr.git
cd oh-my-herdr
mkdir -p ~/.config/herdr-app/mods ~/.config/herdr-app/layouts
cp -R mods/files-search ~/.config/herdr-app/mods/
cp layouts/main-search.json ~/.config/herdr-app/layouts/
```

Windows (PowerShell):

```powershell
git clone https://github.com/m16khb-org/oh-my-herdr.git
cd oh-my-herdr
$herdr = "$HOME\.config\herdr-app"
New-Item -ItemType Directory -Force "$herdr\mods", "$herdr\layouts" | Out-Null
Copy-Item -Recurse -Force mods\files-search "$herdr\mods\"
Copy-Item -Force layouts\main-search.json "$herdr\layouts\"
```

Check the mod and switch to the layout (any OS):

```sh
herdr-app check ~/.config/herdr-app/mods/files-search
herdr-app do layout.switch --name main-search
```

On Windows, use `$HOME\.config\herdr-app\mods\files-search` as the
`check` path. Open the panel with the **Files** button at the top right.

`main-search` is Herdr's `main` layout, with the Files panel running
`files-search` in place of the built-in `files` mod.

## Platform notes

- **macOS, Linux and remote machines**: rg runs in the background and results
  show up while it searches. A new query stops the previous search.
- **Windows (this computer)**: rg runs once per query and results appear when
  it finishes. Herdr gives one run 30 seconds and 8 MiB of output, so search a
  project folder, not your whole home folder.
- Both modes show at most 2,000 results. Content search reports at most 100
  matching lines per file.

## Update

Pull the repository and run the copy commands again. Herdr reloads the mod as
soon as the files change.

## Uninstall

```sh
herdr-app do layout.switch --name main
rm -rf ~/.config/herdr-app/mods/files-search ~/.config/herdr-app/layouts/main-search.json
```

Windows:

```powershell
herdr-app do layout.switch --name main
Remove-Item -Recurse -Force "$HOME\.config\herdr-app\mods\files-search", "$HOME\.config\herdr-app\layouts\main-search.json"
```

If a layout ever leaves the window unusable, `Ctrl+Alt+Shift+Escape` always
switches back to the default `main` layout.
