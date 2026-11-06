#!/bin/sh
# Installs oh-my-herdr's files-search mod and main-search layout into the Herdr app folder.
#   curl -fsSL https://raw.githubusercontent.com/m16khb-org/oh-my-herdr/main/install.sh | sh
#   sh install.sh               (from a clone)
#   sh install.sh --uninstall
set -eu

REPO=m16khb-org/oh-my-herdr
APP=${HERDR_APP_HOME:-$HOME/.config/herdr-app}

say() { printf '%s\n' "$*"; }
die() { printf 'oh-my-herdr: %s\n' "$*" >&2; exit 1; }

herdr_app() {
  if command -v herdr-app >/dev/null 2>&1; then herdr-app "$@"
  elif [ -x "$HOME/.local/bin/herdr-app" ]; then "$HOME/.local/bin/herdr-app" "$@"
  else return 127
  fi
}

# Herdr answers `status` only while its window is open.
running() { herdr_app status >/dev/null 2>&1; }

if [ "${1:-}" = "--uninstall" ]; then
  if running && herdr_app status 2>/dev/null | grep -q '"layout": "main-search"'; then
    herdr_app do layout.switch --name main >/dev/null
    say "Switched Herdr back to the main layout."
  fi
  rm -rf "$APP/mods/files-search" "$APP/layouts/main-search.json"
  say "Removed files-search and main-search from $APP."
  exit 0
fi
[ $# -eq 0 ] || die "unknown option: $1 (only --uninstall)"

# Files come from the clone this script sits in, or from GitHub when piped into sh.
SRC=
if [ -f "$0" ]; then
  DIR=$(cd "$(dirname "$0")" && pwd)
  [ -d "$DIR/mods/files-search" ] && SRC=$DIR
fi
if [ -z "$SRC" ]; then
  TMP=$(mktemp -d "${TMPDIR:-/tmp}/oh-my-herdr.XXXXXX")
  trap 'rm -rf "$TMP"' EXIT
  URL="https://codeload.github.com/$REPO/tar.gz/refs/heads/main"
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$URL" | tar -xz -C "$TMP"
  elif command -v wget >/dev/null 2>&1; then wget -qO- "$URL" | tar -xz -C "$TMP"
  else die "needs curl or wget to download $REPO"
  fi
  SRC=$TMP/oh-my-herdr-main
  [ -d "$SRC/mods/files-search" ] || die "the download has no mods/files-search"
fi

mkdir -p "$APP/mods/files-search" "$APP/layouts"
cp -R "$SRC/mods/files-search/." "$APP/mods/files-search/"
cp "$SRC/layouts/main-search.json" "$APP/layouts/main-search.json"
say "Installed files-search and main-search into $APP."

if herdr_app check "$APP/mods/files-search"; then :
else
  [ $? -eq 127 ] && say "herdr-app not found: skipped the mod check." || die "herdr-app check failed"
fi

if running; then
  herdr_app do layout.switch --name main-search >/dev/null
  say "Switched Herdr to the main-search layout. Open the Files panel to search."
else
  say "Herdr isn't running. Start it, then run: herdr-app do layout.switch --name main-search"
fi

if ! command -v rg >/dev/null 2>&1; then
  say ""
  say "ripgrep (rg) is missing. Search needs it on every machine you search:"
  case "$(uname -s)" in
    Darwin) say "  brew install ripgrep" ;;
    *) say "  sudo apt install ripgrep   (Fedora: sudo dnf install ripgrep, Arch: sudo pacman -S ripgrep)" ;;
  esac
fi
