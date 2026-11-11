// A lazy file browser for the focused pane's folder, with bounded previews (Markdown rendered, with its
// source a click away), editing (on another machine through sh), and a search by file name or by content that
// streams ripgrep results while it runs. Images open in a dialog: this same mod, opened as an overlay.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Input, InputState, Scrollbar, TextView, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, hc, readTextFile, writeTextFile, watchFolder, theme, settings, window, appHome, openOverlay, closeOverlay, props } from "herdr";
import * as fs from "fs/promises";
import { Buffer } from "buffer";
import { createHash } from "crypto";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
// The focused terminal, as hc addresses it (machine/t7 on another machine): files dropped for that machine travel beside it.
function focusedTerminal(on) {
  const f = focused(), pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const terminal = pane?.terminal ?? f?.terminal ?? null;
  return terminal && on && !terminal.includes("/") ? `${on}/${terminal}` : terminal;
}
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const MARKDOWN = new Set(["md", "markdown", "mdown", "mkd"]);
const PREVIEW_CHARS = 400000;
// Herdr's editor spends 0.5–2 s highlighting 20,000 characters of code and lags while you type in a big
// highlighted file; plain text costs milliseconds. Larger files open plain, and the Color button turns it on.
const PLAIN_CHARS = 20000;
const PER_FOLDER = 500, TOTAL = 5000;
const MATCHES = 2000, POLL_MS = 120, CHUNK = 1 << 20, ROW = 24;
// rg runs in the background and writes its output to a temp file; the panel reads new lines while it runs.
// Its own process group (set -m) and nohup: an exec on another machine ends its session's processes when it returns.
const START = '{ set -m; } 2>/dev/null; command -v rg >/dev/null 2>&1 || { echo norg; exit 0; }; f=$(mktemp "${TMPDIR:-/tmp}/herdr-search.XXXXXX") || exit 1; nohup rg "$@" > "$f" 2>/dev/null < /dev/null & echo "$! $f"';
// "done" first when rg has exited, then at most CHUNK bytes from byte offset $3: tail -c seeks instead of rescanning the file.
const POLL = 'kill -0 "$2" 2>/dev/null || echo done; tail -c +"$3" "$1" | head -c "$4"';
const STOP = 'kill "$2" 2>/dev/null; rm -f "$1"';

// image() draws only files under the app folder, so a picture is copied into this mod's cache first.
const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff", "svg"]);
const IMAGE_DIR = "mods/files-search/.cache", IMAGE_CACHE = 24, IMAGE_HEADER = 40, IMAGE_PAD = 16;
// A picture is read once for what the dialog needs (its first bytes, for the pixel size, and a name for its
// cached copy) and then copied into the cache. A file here is copied by this computer's shell. One on another
// machine comes as base64 in pieces of IMAGE_CHUNK bytes, one exec each (exec answers at most 8 MiB); a multiple
// of 3 bytes, so the pieces' base64 joins into one text, which is written here and decoded by this computer's shell.
// The link to another machine can be slow, so a picture there larger than PREVIEW_OVER travels as a preview at
// most 2048 px across, made there by sips (macOS) or ImageMagick, when one is smaller than the picture itself.
const IMAGE_BYTES = 64 << 20, IMAGE_CHUNK = 3 << 19, PREVIEW_OVER = 512 << 10, IMAGE_TIMEOUT = 300000;
// Photos become JPEG; PNG and WebP stay PNG, which keeps transparency. GIF keeps its animation, SVG is text.
const PREVIEW_AS = { jpg: "jpeg", jpeg: "jpeg", bmp: "jpeg", tif: "jpeg", tiff: "jpeg", png: "png", webp: "png" };
// The first 768 KiB are decoded for the pixel size: 1 MiB of base64, a multiple of 4 characters.
const IMAGE_HEAD_BASE64 = 1 << 20;
// Arguments: file, piece, largest size, piece size, preview format or "-", PREVIEW_OVER, "rm" to delete a preview
// after its last piece. Answers "ok <size> <size read> <width or -> <height or -> <file read>", then the piece.
// A preview that fits in one piece is deleted at once; a larger one is named again for the next pieces.
const IMAGE_SH = 'f=$1; [ -f "$f" ] || { echo missing; exit 0; }; n=$(wc -c < "$f" | tr -d " ") || exit 1; r=$f; m=$n; d="- -"; '
  + 'if [ "$5" != - ] && [ "$n" -gt "$6" ] && t=$(mktemp "${TMPDIR:-/tmp}/herdr-preview.XXXXXX" 2>/dev/null); then '
  + 'if command -v sips >/dev/null 2>&1; then d=$(sips -g pixelWidth -g pixelHeight "$f" 2>/dev/null | awk \'/pixelWidth/ { w = $2 } /pixelHeight/ { h = $2 } END { if (w && h) print w, h }\'); '
  // sips -Z enlarges a smaller picture too, so it is used only above 2048 px (or when the size is unknown).
  + 'z="-Z 2048"; case $d in [0-9]*" "[0-9]*) [ "${d% *}" -le 2048 ] && [ "${d#* }" -le 2048 ] && z=;; esac; sips $z -s format "$5" "$f" --out "$t" >/dev/null 2>&1; '
  + 'elif command -v magick >/dev/null 2>&1; then d=$(magick identify -format "%w %h" "$f[0]" 2>/dev/null); magick "$f[0]" -resize "2048x2048>" "$5:$t" 2>/dev/null; '
  + 'elif command -v convert >/dev/null 2>&1; then d=$(identify -format "%w %h" "$f[0]" 2>/dev/null); convert "$f[0]" -resize "2048x2048>" "$5:$t" 2>/dev/null; fi; '
  + 's=$(wc -c < "$t" 2>/dev/null | tr -d " "); if [ -n "$s" ] && [ "$s" -gt 0 ] && [ "$s" -lt "$n" ]; then r=$t; m=$s; case $d in [0-9]*" "[0-9]*) ;; *) d="- -";; esac; else rm -f "$t"; d="- -"; fi; fi; '
  + 'echo "ok $n $m $d $r"; '
  + 'if [ "$m" -le "$3" ]; then dd if="$r" bs="$4" skip="$2" count=1 2>/dev/null | if command -v base64 >/dev/null 2>&1; then base64; else openssl base64; fi; fi; '
  + 'if [ "$r" != "$f" ] && { [ "$m" -le "$4" ] || [ "$m" -gt "$3" ]; }; then rm -f "$r"; fi; '
  + 'if [ "$7" = rm ]; then case $f in */herdr-preview.*) rm -f "$f";; esac; fi';
const DROP_PREVIEW_SH = 'case $1 in */herdr-preview.*) rm -f "$1";; esac';
// Windows machines without sh send the picture itself.
const IMAGE_PS = "param($p, $k, $m, $c) $i = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue; if (-not $i -or $i.PSIsContainer) { 'missing'; return }; 'ok ' + $i.Length + ' ' + $i.Length + ' - - ' + $p; if ($i.Length -gt [long]$m) { return }; "
  + "$at = [long]$k * [long]$c; $b = New-Object byte[] ([Math]::Max(0, [Math]::Min([long]$c, $i.Length - $at))); $s = [IO.File]::OpenRead($i.FullName); "
  + "try { [void]$s.Seek($at, 'Begin'); $r = 0; while ($r -lt $b.Length) { $x = $s.Read($b, $r, $b.Length - $r); if ($x -le 0) { break }; $r += $x }; [Convert]::ToBase64String($b, 0, $r) } finally { $s.Close() }";
const megabytes = n => `${(n / (1 << 20)).toFixed(1)} MB`;
const byteSize = n => n < 1024 ? `${n} B` : n < 1 << 20 ? `${Math.round(n / 1024)} KB` : megabytes(n);
const isImage = path => IMAGES.has(path.slice(path.lastIndexOf(".") + 1).toLowerCase()) && path.includes(".");

// PowerShell reads curly single quotes as quotes too, so they're doubled like '.
const quotePs = text => "'" + text.replace(/['‘’‚‛]/g, "$&$&") + "'";
// Each machine answers in sh, or in PowerShell when it is Windows (this one, or another without sh).
const shells = new Map();
async function shell(on, sh, ps, args, options = {}) {
  const kind = shells.get(on ?? "") ?? (!on && window()?.platform === "windows" ? "ps" : "sh");
  if (kind === "sh") {
    try { return await exec("sh", ["-c", sh, "files", ...args], { ...options, on }); }
    catch (e) {
      if (!on || !String(e).includes("cannot start sh: program not found")) throw e;
      shells.set(on, "ps");
    }
  }
  // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
  return exec("powershell", ["-NoProfile", "-Command", `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { ${ps} } ${args.map(quotePs).join(" ")}`], { ...options, on });
}


// Herdr 0.1.15 hands a Uint8Array (a Buffer too) from a script to its own functions as no bytes at all:
// createHash and fs.writeFile see nothing, and Buffer's toString gives "". An ArrayBuffer and a string arrive
// whole, so pictures are hashed as those and never written from a script's bytes.
const arrayBuffer = b => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const tooLarge = n => new Error(`Image too large to preview (${megabytes(n)}, limit ${megabytes(IMAGE_BYTES)})`);
const COPY_FILE_SH = 'cp -f -- "$1" "$2" && wc -c < "$2" | tr -d " "';
const COPY_FILE_PS = "param($a, $b) Copy-Item -LiteralPath $a -Destination $b -Force -ErrorAction Stop; (Get-Item -LiteralPath $b).Length";
const DECODE_SH = 'if base64 -d < "$1" > "$2" 2>/dev/null || base64 -D < "$1" > "$2" 2>/dev/null || openssl base64 -d -A -in "$1" -out "$2"; then wc -c < "$2" | tr -d " "; fi; rm -f "$1"';
const DECODE_PS = "param($i, $o) try { [IO.File]::WriteAllBytes($o, [Convert]::FromBase64String([IO.File]::ReadAllText($i))); (Get-Item -LiteralPath $o).Length } finally { Remove-Item -LiteralPath $i -ErrorAction SilentlyContinue }";

// Runs one of the scripts above on this computer; it answers with the size of the file it wrote.
async function writeChecked(sh, ps, args, file, size) {
  const r = await shell(null, sh, ps, args);
  if (r.code === 0 && Number(r.stdout.trim()) === size) return;
  await fs.unlink(file).catch(() => null);
  throw new Error(r.stderr.trim().split("\n")[0] || "Cannot copy this image into the preview cache");
}

// What openImage needs of a picture here or on another machine: { head, size, dims, preview, ext, key, write(file) }.
// head: its first bytes; size and dims: the picture's own; ext: what the cached copy is (a preview is JPEG or PNG).
// progress(done, total) follows the pieces of a picture that takes more than one.
async function imageSource(path, on, progress) {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (!on) {
    let bytes = null;
    try { bytes = await fs.readFile(path); } catch { /* outside the home folder: ask a shell */ }
    if (bytes?.length) {
      if (bytes.length > IMAGE_BYTES) throw tooLarge(bytes.length);
      const size = bytes.length;
      return { head: bytes, size, dims: null, preview: false, ext, key: createHash("sha1").update(arrayBuffer(bytes)).digest("hex"),
        write: file => writeChecked(COPY_FILE_SH, COPY_FILE_PS, [path, file], file, size) };
    }
  }
  const pieces = [];
  let read = path, total = 0, size = 0, dims = null;
  try {
    for (let k = 0; k === 0 || k * IMAGE_CHUNK < total; k++) {
      const last = (k + 1) * IMAGE_CHUNK >= total;
      const args = [read, String(k), String(IMAGE_BYTES), String(IMAGE_CHUNK), k === 0 ? PREVIEW_AS[ext] ?? "-" : "-", String(PREVIEW_OVER), k > 0 && last && read !== path ? "rm" : "-"];
      const r = await shell(on, IMAGE_SH, IMAGE_PS, args, { timeout: IMAGE_TIMEOUT });
      if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || "Cannot read this image");
      const out = r.stdout, nl = out.indexOf("\n"), status = (nl < 0 ? out : out.slice(0, nl)).trim();
      if (status === "missing") throw new Error(k === 0 ? "This file is no longer available" : "The preview was removed while it was being read; open it again");
      const m = status.match(/^ok (\d+) (\d+) (\S+) (\S+) (.*)$/);
      if (!m) throw new Error("Cannot read this image");
      if (k === 0) {
        size = Number(m[1]); total = Number(m[2]); read = m[5];
        if (/^\d+$/.test(m[3]) && /^\d+$/.test(m[4])) dims = [Number(m[3]), Number(m[4])];
        if (total > IMAGE_BYTES) throw tooLarge(total);
      } else if (Number(m[1]) !== total) throw new Error("The image changed while it was being read; open it again");
      pieces.push(nl < 0 ? "" : out.slice(nl + 1).replace(/\s+/g, ""));
      if (total > IMAGE_CHUNK) progress?.(Math.min((k + 1) * IMAGE_CHUNK, total), total);
    }
  } catch (e) {
    if (read !== path) await shell(on, DROP_PREVIEW_SH, "", [read]).catch(() => null);
    throw e;
  }
  const text = pieces.join(""), preview = read !== path;
  return { head: Buffer.from(text.slice(0, IMAGE_HEAD_BASE64), "base64"), size, dims, preview,
    ext: preview ? (PREVIEW_AS[ext] === "jpeg" ? "jpg" : "png") : ext, key: createHash("sha1").update(text).digest("hex"),
    write: async file => { await fs.writeFile(`${file}.b64`, text); await writeChecked(DECODE_SH, DECODE_PS, [`${file}.b64`, file], file, total); } };
}

// Named by content, so a changed picture is a new file and an unchanged one is written once per session
// (a copy pruned or left short by an earlier failed write is written again).
let cached = [];
const written = new Set();
async function cacheImage(source, ext) {
  const name = `${source.key.slice(0, 20)}.${ext.toLowerCase()}`;
  const dir = `${appHome()}/${IMAGE_DIR}`, file = `${dir}/${name}`;
  await fs.mkdir(dir, { recursive: true });
  if (!written.has(name) || !(await fs.exists(file))) { await source.write(file); written.add(name); }
  cached = [name, ...cached.filter(n => n !== name)].slice(0, IMAGE_CACHE);
  const files = await fs.readdir(dir).catch(() => []);
  // A .b64 file is another picture still being written.
  if (files.length > IMAGE_CACHE) for (const f of files) if (!cached.includes(f) && !f.endsWith(".b64")) await fs.unlink(`${dir}/${f}`).catch(() => null);
  return `${IMAGE_DIR}/${name}`;
}

// An SVG's own size, from width and height in px or else its viewBox; null when it states neither.
function svgSize(b) {
  // Read byte by byte: Buffer's toString gives "" on Herdr 0.1.15, and the attributes needed here are ASCII.
  const tag = String.fromCharCode.apply(null, b.subarray(0, 4096)).match(/<svg\b[^>]*>/i)?.[0];
  if (!tag) return null;
  const attr = name => tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];
  const px = v => /^\s*[\d.]+\s*(px)?\s*$/.test(v ?? "") ? parseFloat(v) : NaN;
  const w = px(attr("width")), h = px(attr("height"));
  if (w > 0 && h > 0) return [w, h];
  const box = attr("viewBox")?.trim().split(/[\s,]+/).map(Number);
  return box?.length === 4 && box[2] > 0 && box[3] > 0 ? [box[2], box[3]] : null;
}

// Pixel size from the header, for the formats that keep it near the start; null for the rest (TIFF, ICO).
function imageSize(b) {
  const u16 = (i, le) => le ? b[i] | b[i + 1] << 8 : b[i] << 8 | b[i + 1];
  const u32 = (i, le) => (le ? b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24 : b[i] << 24 | b[i + 1] << 16 | b[i + 2] << 8 | b[i + 3]) >>> 0;
  const ascii = (i, n) => String.fromCharCode(...b.subarray(i, i + n));
  if (b.length >= 24 && ascii(1, 3) === "PNG") return [u32(16), u32(20)];
  if (b.length >= 10 && ascii(0, 3) === "GIF") return [u16(6, true), u16(8, true)];
  if (b.length >= 26 && ascii(0, 2) === "BM") return [u32(18, true), Math.abs(u32(22, true) | 0)];
  if (b.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const kind = ascii(12, 4);
    if (kind === "VP8X") return [1 + (b[24] | b[25] << 8 | b[26] << 16), 1 + (b[27] | b[28] << 8 | b[29] << 16)];
    if (kind === "VP8 ") return [u16(26, true) & 0x3fff, u16(28, true) & 0x3fff];
    if (kind === "VP8L") { const bits = u32(21, true); return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1]; }
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [u16(i + 7), u16(i + 5)];
      i += 2 + u16(i + 2);
    }
  }
  return null;
}

// Moving (rename, drag within the tree) and copying (files dropped from Finder or Explorer) never replace what is
// already there: they answer "exists" instead. A rename that only changes letter case names the same file on macOS
// and Windows, so it is allowed through, by way of a temporary name on Windows.
const MOVE_SH = 'if { [ -e "$2" ] || [ -L "$2" ]; } && ! [ "$1" -ef "$2" ]; then echo exists; exit 0; fi; mv -- "$1" "$2"';
const MOVE_PS = "param($a, $b) $i = Get-Item -LiteralPath $a -Force -ErrorAction Stop; if (Test-Path -LiteralPath $b) { if ((Get-Item -LiteralPath $b -Force).FullName -ne $i.FullName) { 'exists'; return }; $t = $b + '.renaming'; Move-Item -LiteralPath $a -Destination $t -ErrorAction Stop; Move-Item -LiteralPath $t -Destination $b -ErrorAction Stop; return }; Move-Item -LiteralPath $a -Destination $b -ErrorAction Stop";
const COPY_SH = 'if [ -e "$2" ] || [ -L "$2" ]; then echo exists; exit 0; fi; cp -R -- "$1" "$2"';
const COPY_PS = "param($a, $b) if (Test-Path -LiteralPath $b) { 'exists'; return }; Copy-Item -LiteralPath $a -Destination $b -Recurse -ErrorAction Stop";
const baseName = path => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
const parentOf = path => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
const joinPath = (folder, name) => folder ? `${folder}/${name}` : name;
const inside = (path, folder) => path === folder || path.startsWith(folder + "/");

// writeTextFile writes only on this computer. On another machine the text travels as sh arguments, in chunks
// under Linux's 128 KiB limit per argument, and the whole save stays well under macOS's 1 MiB for all of them.
// Like writeTextFile it never overwrites a change made elsewhere: the file must still hash to what was read.
// It is written beside the file and moved into place with the file's permissions; a symlink is written through.
const REMOTE_SAVE_BYTES = 256 << 10, ARG_CHUNK = 32768;
const SAVE_SH = 'f=$1; want=$2; n=$3; shift 3; [ -f "$f" ] || { echo missing; exit 0; }; '
  + 'cur=$({ sha256sum < "$f" || shasum -a 256 < "$f" || openssl dgst -sha256 -r < "$f"; } 2>/dev/null | cut -c1-64); '
  + '[ ${#cur} -eq 64 ] || { echo nohash; exit 0; }; [ "$cur" = "$want" ] || { echo changed; exit 0; }; '
  + 't=$(mktemp "$(dirname -- "$f")/.herdr-save.XXXXXX") || exit 1; '
  + 'if ! printf %s "$@" > "$t" || [ "$(wc -c < "$t" | tr -d " ")" != "$n" ]; then rm -f "$t"; echo short; exit 0; fi; '
  + 'if [ -L "$f" ]; then cat "$t" > "$f"; r=$?; rm -f "$t"; [ $r -eq 0 ] && echo ok; exit $r; fi; '
  + 'm=$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f" 2>/dev/null) && chmod "$m" "$t"; '
  + 'mv -f "$t" "$f" || { rm -f "$t"; exit 1; }; echo ok';
const SAVE_ERRORS = {
  missing: "This file is no longer available",
  changed: "The file changed since it was opened; Discard to load it again",
  nohash: "Cannot save here: this machine has no sha256sum, shasum or openssl",
  short: "The file could not be written in full; it was left unchanged",
};

async function writeRemoteText(path, text, expected, on) {
  const chunks = [];
  for (let i = 0; i < text.length;) {
    let end = Math.min(i + ARG_CHUNK, text.length);
    // Never between the two halves of a surrogate pair: each argument is sent as UTF-8.
    if (end < text.length && (text.charCodeAt(end - 1) & 0xfc00) === 0xd800) end--;
    chunks.push(text.slice(i, end));
    i = end;
  }
  // A string, not a Buffer: Herdr 0.1.15 hashes a Buffer as no bytes (see arrayBuffer). Strings hash as UTF-8.
  const want = createHash("sha256").update(expected).digest("hex");
  let r;
  try { r = await exec("sh", ["-c", SAVE_SH, "files", path, want, String(utf8Length(text)), ...chunks], { on }); }
  catch (e) { throw String(e).includes("program not found") ? new Error("Saving needs sh on that machine") : e; }
  const out = r.stdout.trim();
  if (out === "ok" && r.code === 0) return;
  throw new Error(SAVE_ERRORS[out] ?? (r.stderr.trim().split("\n")[0] || "The file could not be saved"));
}

async function fileOp(on, sh, ps, from, to) {
  const r = await shell(on, sh, ps, [from, to]);
  if (r.stdout.trim() === "exists") throw new Error(`${baseName(to)} already exists there`);
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || "The file operation failed");
}

// A file name the machine accepts: not empty, no folder separator, and on Windows none of its reserved characters.
function badName(name, windows) {
  if (!name.trim()) return "Enter a name";
  if (name === "." || name === "..") return "That name is reserved";
  if (name.includes("/") || (windows && /[\\:*?"<>|]/.test(name))) return windows ? 'A name can\'t contain \\ / : * ? " < > |' : "A name can't contain /";
  return null;
}

const COMMON = ["--hidden", "--glob", "!.git", "--path-separator", "/"];
const rgArgs = (mode, query) => mode === "name"
  ? ["--files", ...COMMON, "."]
  : ["--json", ...COMMON, "--fixed-strings", "--smart-case", "--max-count", "100", "--", query, "."];

// File names match like the content search: case-insensitive unless the query has capitals.
// A query with a slash matches the whole relative path, otherwise just the name.
function nameMatcher(query) {
  const q = query.replace(/\\/g, "/"), exact = q !== q.toLowerCase(), whole = q.includes("/");
  const needle = exact ? q : q.toLowerCase();
  return path => {
    const s = whole ? path : path.slice(path.lastIndexOf("/") + 1);
    return (exact ? s : s.toLowerCase()).includes(needle);
  };
}

function utf8Length(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00) { n += 4; i++; } else n += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
  }
  return n;
}

// rg reports UTF-8 byte offsets; JavaScript strings index UTF-16 units.
function utf16(text, bytes) {
  let i = 0, n = 0;
  while (i < text.length && n < bytes) {
    const c = text.codePointAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    i += c > 0xffff ? 2 : 1;
  }
  return i;
}

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    // The image dialog is another copy of this mod, given the cached picture to draw.
    this.viewer = props()?.image ?? null;
    if (this.viewer) return;
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {}; this.hitRows = []; this.headers = new Map(); this.count = 0;
    this.mode = "content";
    // The tree takes the keyboard when a row is clicked, so Enter renames the selected row (F2 too, when
    // Herdr's own F2, Rename tab, is unbound).
    this.focus = cx.focus_handle(); this.selected = null; this.renaming = null; this.menu = null; this.drag = null;
    this.query = InputState.new({ placeholder: "Search files" });
    this.query.on("change", (_e, cx) => { this.debounce?.cancel(); this.debounce = cx.timer.after(200, cx => this.search(cx)); });
    this.query.on("focus", (_e, cx) => { this.queryFocused = true; cx.notify(); });
    this.query.on("blur", (_e, cx) => { this.queryFocused = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    // Unsaved edits keep the panel on their file until they're saved or discarded.
    if (this.dirty) return;
    const { cwd, on } = location(), next = key();
    this.terminal = focusedTerminal(on);
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
      if (this.query.value()) cx.timer.after(0, cx => this.search(cx));
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally {
        if (this.context === context) this.loading = false;
        if (this.stale) { this.stale = false; this.refresh(cx); }
        cx.notify();
      }
    });
  }

  // After a file operation: read the tree again now, or as soon as the read in progress ends.
  reload(cx) {
    if (this.loading) this.stale = true; else this.refresh(cx);
  }

  isWindows() {
    return this.on ? shells.get(this.on) === "ps" : window()?.platform === "windows";
  }

  // Paths under a moved or renamed entry follow it: open folders, the open file and the selection.
  moved(from, to) {
    const follow = path => inside(path, from) ? to + path.slice(from.length) : path;
    this.folders = new Set([...this.folders].map(follow));
    this.entries = new Map([...this.entries].map(([path, entries]) => [path && follow(path), entries]));
    if (this.file) this.file = follow(this.file);
    if (this.selected) this.selected = follow(this.selected);
  }

  async moveEntry(from, to, cx) {
    const root = this.root;
    await fileOp(this.on, MOVE_SH, MOVE_PS, `${root}/${from}`, `${root}/${to}`);
    if (this.root !== root) return;
    this.moved(from, to);
    this.reload(cx);
  }

  startRename(path, cx) {
    if (this.renaming) return;
    const name = baseName(path), dot = name.lastIndexOf(".");
    const state = InputState.new({ value: name });
    const rename = this.renaming = { path, state, error: null };
    let done = false;
    const finish = (commit, cx) => {
      if (done || this.renaming !== rename) return;
      const next = state.value().trim();
      if (!commit || next === name) { done = true; this.renaming = null; state.release(); this.focus.focus(); cx.notify(); return; }
      const bad = badName(next, this.isWindows());
      if (bad) { rename.error = bad; this.note = { text: bad, error: true }; cx.notify(); return; }
      done = true;
      cx.spawn(async cx => {
        try { await this.moveEntry(path, joinPath(parentOf(path), next), cx); this.note = null; }
        catch (e) { this.note = { text: String(e?.message ?? e), error: true }; }
        finally { if (this.renaming === rename) this.renaming = null; state.release(); this.focus.focus(); cx.notify(); }
      });
    };
    rename.finish = finish;
    state.on("submit", (_e, cx) => finish(true, cx));
    state.on("change", (_e, cx) => { if (rename.error) { rename.error = null; this.note = null; cx.notify(); } });
    // Clicking elsewhere keeps the new name, as Finder and Explorer do.
    state.on("blur", (_e, cx) => finish(true, cx));
    state.focus();
    // The name is selected without its extension, so typing replaces just the name.
    state.set_selected_range({ start: 0, end: dot > 0 ? dot : name.length });
    this.menu = null;
    cx.notify();
  }

  // Files dropped from Finder or Explorer are copied into the folder under the pointer. On another machine they
  // travel beside its focused terminal first (hc put), then move into place; folders can't travel that way.
  dropFiles(paths, folder, cx) {
    const root = this.root, on = this.on, terminal = this.terminal;
    if (!root || !paths?.length) return;
    this.note = { text: `Copying ${paths.length === 1 ? baseName(paths[0]) : `${paths.length} items`}…` };
    cx.notify();
    cx.spawn(async cx => {
      const failed = [];
      for (const path of paths) {
        const target = `${root}/${joinPath(folder, baseName(path))}`;
        try {
          if (!on) { await fileOp(null, COPY_SH, COPY_PS, path, target); continue; }
          if (!terminal) throw new Error("open a terminal on that machine first");
          const put = await hc(["put", terminal, path, "--json"]);
          if (put.code !== 0) throw new Error(put.stderr.trim().split("\n")[0] || "cannot send it there (folders can't be sent)");
          let landed = put.stdout.trim();
          try { const j = JSON.parse(landed); landed = typeof j === "string" ? j : j.path ?? j.file ?? landed; } catch { /* plain text */ }
          await fileOp(on, MOVE_SH, MOVE_PS, landed, target);
        } catch (e) {
          const why = String(e?.message ?? e), name = baseName(path);
          failed.push(why.startsWith(name) ? why : `${name}: ${why}`);
        }
      }
      if (this.root === root) {
        this.note = failed.length ? { text: failed.join(" · "), error: true } : null;
        if (folder && !this.folders.has(folder)) this.toggle(folder, cx);
        this.reload(cx);
      }
      cx.notify();
    });
  }

  // A drag inside the tree moves the entry into the folder it is released over; a file row means its folder,
  // and the empty space below the rows means the top folder.
  dragTarget(path, dir) {
    return dir ? path : parentOf(path);
  }

  canDrop(target) {
    const from = this.drag?.path;
    return from != null && !inside(target, from) && parentOf(from) !== target;
  }

  // A press becomes a drag once the pointer has moved a few pixels with the button held.
  dragMove(e, target, cx) {
    const drag = this.drag;
    if (!drag) return;
    if (!drag.active && Math.hypot(e.position.x - drag.x, e.position.y - drag.y) > 5) { drag.active = true; this.menu = null; cx.notify(); }
    if (drag.active && this.dropTarget !== target) { this.dropTarget = target; cx.notify(); }
  }

  drop(target, cx) {
    const drag = this.drag, ok = drag?.active && this.canDrop(target);
    this.drag = null; this.dropTarget = null;
    if (!ok) { cx.notify(); return; }
    cx.spawn(async cx => {
      try {
        await this.moveEntry(drag.path, joinPath(target, baseName(drag.path)), cx);
        this.note = null;
        if (target && !this.folders.has(target)) this.toggle(target, cx);
      } catch (e) { this.note = { text: String(e?.message ?? e), error: true }; }
      finally { cx.notify(); }
    });
  }

  cancelDrag(cx) {
    if (!this.drag) return;
    const active = this.drag.active;
    this.drag = null; this.dropTarget = null;
    if (active) cx.notify();
  }

  // The row names the entry; the panel, which hears the same press next, places the menu where it was.
  openMenu(path, dir, cx) {
    this.selected = path; this.focus.focus();
    this.menu = { path, dir, x: 0, y: 0, placed: false };
    cx.notify();
  }

  placeMenu(e, cx) {
    const m = this.menu, at = e.local_position, box = e.bounds;
    if (!m || m.placed || !at) return;
    // Kept inside the panel: the menu is about 100 px tall and 210 wide.
    m.x = box ? Math.min(at.x, box.width - 216) : at.x;
    m.y = box ? Math.min(at.y, box.height - 106) : at.y;
    m.placed = true;
    cx.notify();
  }

  menuView(t) {
    const m = this.menu, full = `${this.root}/${m.path}`;
    if (!m.placed) return div();
    const item = (id, label, hint, act) => h_flex().id(`files-menu-${id}`).h(28).px(10).gap(12).items_center().rounded(6).cursor_pointer()
      .hover(s => s.bg(t.hover)).on_click((_e, cx) => { this.menu = null; act(cx); cx.notify(); })
      .child(div().flex_1().child(label)).when(Boolean(hint), el => el.child(div().text_size(11).text_color(t.dim).child(hint)));
    return v_flex().id("files-menu").absolute().left(Math.max(4, m.x)).top(m.y).w(210).p(4).rounded(8)
      .bg(t.background).border_1().border_color(t.border).shadow_lg().text_size(12)
      .on_mouse_down_out((_e, cx) => { this.menu = null; cx.notify(); })
      .child(item("rename", "Rename", "Enter", cx => this.startRename(m.path, cx)))
      .child(item("copy", "Copy path", "", cx => cx.write_to_clipboard(full)))
      .child(item("copy-rel", "Copy relative path", "", cx => cx.write_to_clipboard(m.path)));
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  // Copies the picture into the cache and opens it in a dialog; the panel stays where it was.
  openImage(path, cx) {
    const context = this.context, root = this.root, on = this.on, name = path.slice(path.lastIndexOf("/") + 1);
    const opening = this.opening = { path };
    this.note = { text: `Opening ${name}…` };
    cx.notify();
    cx.spawn(async cx => {
      try {
        const source = await imageSource(`${root}/${path}`, on, (done, total) => {
          if (this.opening === opening) { this.note = { text: `Opening ${name}… ${megabytes(done)} of ${megabytes(total)}` }; cx.notify(); }
        });
        const src = await cacheImage(source, source.ext);
        if (this.opening !== opening || !this.current(context)) return;
        const vector = /\.svg$/i.test(path), size = vector ? svgSize(source.head) : imageSize(source.head), own = source.dims ?? size;
        const facts = [own && `${own[0]} × ${own[1]}`, byteSize(source.size), source.preview && "preview"].filter(Boolean).join(" · ");
        // A vector has no pixels of its own: a small one (an icon) is drawn at least 480 px across.
        const shown = size && (vector ? size.map(n => n * Math.max(1, 480 / Math.max(...size))) : size);
        const dialog = this.imageDialogSize(shown);
        openOverlay({ mod: "files-search", kind: "dialog", width: dialog.width, height: dialog.height, props: { image: { src, path, size: shown, facts, width: dialog.inner } } });
        this.note = null;
      } catch (e) {
        if (this.opening === opening && this.current(context)) this.note = { text: String(e?.message ?? e), error: true };
      } finally { if (this.opening === opening) this.opening = null; cx.notify(); }
    });
  }

  // The dialog wraps the picture: header, padding and border around it, at least wide enough for the
  // header and at most 90% by 88% of the Herdr window. A larger picture keeps its size and scrolls inside.
  // An overlay's px are drawn at the person's zoom while viewport_size measures the screen, so px sized from
  // the viewport ran past the window's edge at zoom 1.2. The size is given as a share of the window instead
  // (a number up to 1), which no zoom or display scale can push past it. inner: its width in the dialog's px.
  imageDialogSize(size) {
    const view = this.viewport;
    if (!size || !view?.width || !view?.height) return { width: 0.6, height: 0.6, inner: 0 };
    const zoom = Number(settings()?.zoom) || 1;
    const share = (px, low, of, most) => Math.min(Math.max(px, low) * zoom / of, most);
    const width = share(size[0] + IMAGE_PAD * 2 + 2, 360, view.width, 0.9);
    const height = share(size[1] + IMAGE_PAD * 2 + IMAGE_HEADER + 2, 160, view.height, 0.88);
    return { width, height, inner: width * view.width / zoom };
  }

  imageView() {
    const t = theme(), v = this.viewer;
    // Shown at its own size and scrolled when larger than the dialog. Without a known size (TIFF, ICO,
    // an SVG with relative dimensions) it fits the dialog instead.
    const body = v.size
      // One scroller per axis: GPUI's two-axis overflow_scrollbar didn't scroll inside a dialog.
      ? v_flex().id("files-image-scroll").flex_1().min_h(0).overflow_y_scrollbar()
        .child(div().id("files-image-scroll-x").flex_none().w_full().overflow_x_scrollbar()
          // Centered only while it fits: a centered picture wider than the dialog would hang off the left edge.
          .child(h_flex().min_w_full().p(IMAGE_PAD).when(v.size[0] + IMAGE_PAD * 2 + 2 <= v.width, el => el.justify_center())
            .child(image(v.src).flex_none().w(v.size[0]).h(v.size[1]))))
      : div().flex_1().min_h(0).relative()
        .child(div().absolute().inset_0().p(IMAGE_PAD).flex().items_center().justify_center().child(image(v.src).size_full()));
    return v_flex().id("files-image").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(IMAGE_HEADER).flex_none().pl(14).pr(8).gap(10).items_center().border_b(1).border_color(t.border)
        .child(div().flex_none().font_semibold().child(v.path.slice(v.path.lastIndexOf("/") + 1)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(v.path.slice(0, Math.max(v.path.lastIndexOf("/"), 0))))
        .child(div().flex_none().text_size(12).text_color(t.dim).child(v.facts))
        .child(div().id("files-image-close").flex_none().w(26).h(26).flex().items_center().justify_center().rounded(6).cursor_pointer()
          .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => closeOverlay(props().overlay)).child("✕")))
      .child(body);
  }

  show(path, cx) {
    if (path && cx && isImage(path)) return this.openImage(path, cx);
    this.code?.release(); this.code = null; this.markdown = null; this.file = path; this.fileError = null; this.plain = false; this.note = null;
    this.original = null; this.dirty = false; this.saving = false; this.saveError = null; this.renderMd?.cancel();
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const value = text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) + "\n… (file truncated)" : text;
        if (MARKDOWN.has(this.ext().toLowerCase())) this.markdown = value;
        // A truncated preview must never be saved. Another machine saves through sh arguments (writeRemoteText):
        // not on Windows machines without sh, and only up to REMOTE_SAVE_BYTES.
        if (value === text && (!on || (shells.get(on) !== "ps" && utf8Length(text) <= REMOTE_SAVE_BYTES))) this.original = text;
        this.plain = value.length > PLAIN_CHARS;
        this.code = this.editor(value, this.original === null);
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  ext() {
    return this.file?.includes(".") ? this.file.split(".").pop() : "txt";
  }

  editor(value, readonly) {
    const t = theme(), ext = this.ext();
    const state = EditorState.new({ language: this.plain ? "text" : LANG[ext] ?? ext, readonly, value,
      font_family: settings().font_family, font_size: 12,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
    if (!readonly) state.on("change", (_e, cx) => {
      if (this.code !== state) return;
      const dirty = state.value() !== this.original;
      if (dirty !== this.dirty) { this.dirty = dirty; cx.notify(); }
      // The rendered Markdown follows the text, a beat behind typing so long files stay responsive.
      if (this.markdown != null) {
        this.renderMd?.cancel();
        this.renderMd = cx.timer.after(150, cx => { if (this.code === state) { this.markdown = state.value(); cx.notify(); } });
      }
    });
    return state;
  }

  // A new editor with the same text, since the language is fixed at creation; the cursor goes back to the top.
  toggleColor(cx) {
    const old = this.code;
    this.plain = !this.plain;
    this.code = this.editor(old.value(), this.original === null);
    old.release();
    cx.notify();
  }

  // Writes only if the file still holds what was read: a change made elsewhere is never overwritten.
  save(cx) {
    if (!this.dirty || this.saving) return;
    const path = this.file, state = this.code, text = state.value(), on = this.on;
    if (on && utf8Length(text) > REMOTE_SAVE_BYTES) {
      this.saveError = `Too large to save on another machine (limit ${byteSize(REMOTE_SAVE_BYTES)})`;
      return cx.notify();
    }
    this.saving = true; this.saveError = null;
    cx.spawn(async cx => {
      try {
        const target = `${this.root}/${path}`;
        await (on ? writeRemoteText(target, text, this.original, on) : writeTextFile(target, text, this.original));
        if (this.code !== state) return;
        this.original = text;
        this.dirty = state.value() !== text;
      } catch (e) {
        if (this.code === state) this.saveError = String(e?.message ?? e).replace(/^`[^`]*`: /, "");
      } finally { if (this.code === state) this.saving = false; cx.notify(); }
    });
  }

  // Markdown shows its editor and the rendered text together by default; View and Code show one.
  fileBody(t) {
    if (!this.code) return div().p(12).text_color(t.dim).child(this.fileError || "Loading file…");
    const editor = () => v_flex().flex_1().min_h(0)
      .on_key_down((e, cx) => { if (e.keystroke === "cmd-s") { cx.stop_propagation(); this.save(cx); } })
      .child(Editor.new(this.code).flex_1().min_h(0));
    const preview = () => div().flex_1().min_h(0).px(16).py(10).text_color(t.foreground)
      .child(TextView.markdown(`files-md-${this.file}`, this.markdown).selectable(true).scrollable(true).size_full());
    if (this.markdown == null || this.mdView === "code") return editor();
    if (this.mdView === "view") return preview();
    return v_flex().flex_1().min_h(0).child(editor()).child(preview().border_t(1).border_color(t.border));
  }

  toggleButton(id, label, on, t, onClick) {
    return div().id(id).flex_none().px(7).h(24).flex().items_center().rounded(6).cursor_pointer().text_size(12)
      .border(1).border_color(on ? t.accent : t.input).text_color(on ? t.foreground : t.muted)
      .when(on, el => el.bg(t.selected)).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => onClick(cx)).child(label);
  }

  viewButton(view, label, t) {
    return this.toggleButton(`files-view-${view}`, label, (this.mdView ?? "split") === view, t, cx => { this.mdView = view; cx.notify(); });
  }

  headerButton(id, label, t, onClick, color) {
    return div().id(id).flex_none().px(8).h(24).flex().items_center().rounded(6).cursor_pointer()
      .text_size(12).text_color(color ?? t.muted).border(1).border_color(t.input).hover(s => s.bg(t.hover).text_color(color ?? t.foreground))
      .on_click((_e, cx) => onClick(cx)).child(label);
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      const renaming = this.renaming?.path === path ? this.renaming : null, target = this.dragTarget(path, entry.dir);
      const dragging = this.drag?.active, dropping = dragging && entry.dir && this.dropTarget === path && this.canDrop(path);
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .when(this.selected === path || dropping, el => el.bg(t.selected)).when(dropping, el => el.border_1().border_color(t.accent))
        .when(dragging && this.drag.path === path, el => el.opacity(0.5))
        // The menu doesn't hide the rows under it from the pointer: a press while it is open belongs to the menu.
        .on_mouse_down("left", (e, _cx) => {
          this.pressedOverMenu = Boolean(this.menu); this.dragged = false;
          if (!renaming && !this.menu) this.drag = { path, x: e.position.x, y: e.position.y, active: false };
        })
        // Stopped here so the tree under the rows doesn't take the target back to the top folder.
        .on_mouse_move((e, cx) => { if (this.drag) { cx.stop_propagation(); this.dragMove(e, target, cx); } })
        .on_mouse_up("left", (_e, cx) => { if (this.drag?.active) { cx.stop_propagation(); this.dragged = true; this.drop(target, cx); } })
        .on_drop((e, cx) => { cx.stop_propagation(); this.dropFiles(e.paths, target, cx); })
        .on_mouse_down("right", (_e, cx) => { if (!renaming) this.openMenu(path, entry.dir, cx); })
        .on_click((_e, cx) => {
          if (renaming || this.pressedOverMenu || this.dragged) { this.pressedOverMenu = false; this.dragged = false; return; }
          this.selected = path; this.focus.focus();
          entry.dir ? this.toggle(path, cx) : this.show(path, cx);
        })
        .child(entry.dir ? svg(`mods/files-search/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/files-search/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(renaming
          ? v_flex().flex_1().min_w(0)
            .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); renaming.finish(false, cx); } })
            .child(Input.new(renaming.state).h(22).px(6).items_center().rounded(5).border(1).border_color(renaming.error ? t.ansi1 : t.accent).bg(t.background).text_color(t.foreground))
          : div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  setMode(mode, cx) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.search(cx);
  }

  search(cx) {
    this.stop();
    const query = this.query.value(), mode = this.mode;
    this.hitRows = []; this.headers = new Map(); this.count = 0; this.capped = false; this.searchError = null; this.searchMode = mode;
    if (!query || !this.root) { cx.notify(); return; }
    const windows = !this.on && window()?.platform === "windows";
    const run = { cwd: this.root, on: this.on, offset: 1, windows, match: mode === "name" ? nameMatcher(query) : null };
    const args = rgArgs(mode, query);
    this.run = run; this.searching = true;
    cx.spawn(async cx => {
      try {
        if (windows) return await this.searchOnce(run, args);
        const r = await exec("sh", ["-c", START, "search", ...args], { cwd: run.cwd, on: run.on });
        const out = r.stdout.trim();
        if (out === "norg") throw new Error("ripgrep (rg) is not installed on this machine");
        if (r.code !== 0 || !out) throw new Error(r.stderr.trim() || "Cannot start the search");
        const space = out.indexOf(" ");
        run.pid = out.slice(0, space); run.file = out.slice(space + 1);
        if (this.run !== run) return this.kill(run);
        run.timer = cx.timer.every(POLL_MS, cx => this.poll(run, cx));
      } catch (e) {
        if (this.run === run) { this.searchError = String(e?.message ?? e); this.searching = false; this.run = null; }
      } finally { cx.notify(); }
    });
  }

  // Windows has no sh, and a background rg started from PowerShell inherits exec's output
  // pipes, so exec would wait for it anyway: rg runs once, within exec's 30 s and 8 MiB.
  async searchOnce(run, args) {
    let r;
    try { r = await exec("rg", args, { cwd: run.cwd }); }
    catch (e) { throw String(e).includes("not found") ? new Error("ripgrep (rg) is not installed on this machine") : e; }
    if (this.run !== run) return;
    const lines = r.stdout.split("\n");
    lines.pop(); // "" after the last newline, or a line cut at the output limit
    for (const line of lines) this.add(line.replace(/\r$/, ""), run);
    if (r.code === 2 && !this.count) throw new Error(r.stderr.trim().split("\n")[0] || "Cannot search this folder");
    if (this.count >= MATCHES || r.stdout.length >= 8000000) this.capped = true;
    this.run = null; this.searching = false;
  }

  poll(run, cx) {
    if (run.busy || this.run !== run) return;
    run.busy = true;
    cx.spawn(async cx => {
      try {
        const r = await exec("sh", ["-c", POLL, "search", run.file, run.pid, String(run.offset), String(CHUNK)], { on: run.on });
        if (this.run !== run) return;
        const done = r.stdout.startsWith("done\n"), body = done ? r.stdout.slice(5) : r.stdout;
        const lines = body.split("\n");
        const rest = lines.pop(); // "" after the last newline, or a line rg is still writing or the chunk cut
        for (const line of lines) { run.offset += utf8Length(line) + 1; this.add(line, run); }
        const finished = done && !rest;
        if (this.count >= MATCHES && !finished) this.capped = true;
        if (finished || this.capped) this.stop();
        if (lines.length || finished || this.capped) cx.notify();
      } catch (e) {
        if (this.run === run) { this.searchError = String(e?.message ?? e); this.stop(); cx.notify(); }
      } finally { run.busy = false; }
    });
  }

  // rg's JSON keeps Windows separators even with --path-separator.
  relative(path, run) {
    return (run.windows ? path.replace(/\\/g, "/") : path).replace(/^\.\//, "");
  }

  add(line, run) {
    if (this.count >= MATCHES) return;
    if (run.match) {
      const path = this.relative(line, run);
      if (!path || !run.match(path)) return;
      const slash = path.lastIndexOf("/");
      this.hitRows.push({ path, name: path.slice(slash + 1), dir: path.slice(0, Math.max(slash, 0)) });
      this.count++;
      return;
    }
    let event;
    try { event = JSON.parse(line); } catch { return; }
    const data = event.type === "match" ? event.data : null;
    if (data?.path.text == null || data.lines.text == null) return;
    const path = this.relative(data.path.text, run), text = data.lines.text.replace(/\r?\n$/, ""), hit = data.submatches[0];
    const start = hit ? utf16(text, hit.start) : 0, end = hit ? utf16(text, hit.end) : 0;
    let lead = text.slice(0, start).trimStart();
    if (lead.length > 16) lead = "…" + lead.slice(-12);
    let header = this.headers.get(path);
    if (!header) {
      const slash = path.lastIndexOf("/");
      header = { path, name: path.slice(slash + 1), dir: path.slice(0, Math.max(slash, 0)), n: 0 };
      this.headers.set(path, header); this.hitRows.push(header);
    }
    header.n++;
    this.hitRows.push({ path, line: data.line_number, lead, hit: text.slice(start, end), rest: text.slice(end, end + 300) });
    this.count++;
  }

  stop() {
    const run = this.run;
    this.run = null; this.searching = false;
    if (!run) return;
    run.timer?.cancel();
    if (run.file) this.kill(run);
  }

  kill(run) {
    return exec("sh", ["-c", STOP, "search", run.file, run.pid], { on: run.on }).catch(() => null);
  }

  async close() {
    const run = this.run;
    this.run = null;
    if (run?.file) await this.kill(run);
  }

  hitRow(row, t, mono) {
    if (row.line === undefined) return h_flex().h(ROW).px(8).gap(7).items_center()
      .when(row.n === undefined, el => el.rounded(6).cursor_pointer().hover(s => s.bg(t.hover)))
      .child(svg("mods/files-search/file.svg").size(14).flex_none().text_color(t.muted))
      .child(div().flex_none().when(row.n !== undefined, el => el.font_semibold()).child(row.name))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(row.dir))
      .when(row.n !== undefined, el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(String(row.n))));
    return h_flex().h(ROW).pl(12).pr(8).gap(8).items_center().rounded(6).cursor_pointer().hover(s => s.bg(t.hover))
      .child(div().flex_none().w(34).text_right().text_size(11).text_color(t.dim).child(String(row.line)))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().text_size(12).when(Boolean(mono), el => el.font_family(mono))
        .when(Boolean(row.lead), el => el.child(div().flex_none().child(row.lead)))
        .child(div().flex_none().rounded(3).bg(t.selection).child(row.hit))
        .child(div().flex_1().min_w(0).truncate().child(row.rest)));
  }

  modeButton(mode, label, t) {
    const on = this.mode === mode;
    return div().id(`files-mode-${mode}`).h(30).flex_none().px(9).flex().items_center().rounded(6).cursor_pointer().text_size(12)
      .border(1).border_color(on ? t.accent : t.input).text_color(on ? t.foreground : t.muted)
      .when(on, el => el.bg(t.selected)).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => this.setMode(mode, cx)).child(label);
  }

  searchStatus() {
    if (this.searchError) return this.searchError;
    if (this.searchMode === "name") {
      const found = `${this.count.toLocaleString()} files`;
      if (this.searching) return this.count ? `Searching… ${found}` : "Searching…";
      if (this.capped) return `Showing the first ${MATCHES.toLocaleString()} files`;
      return this.count ? found : "No files";
    }
    const files = this.headers.size, found = `${this.count.toLocaleString()} results in ${files.toLocaleString()} files`;
    if (this.searching) return this.count ? `Searching… ${found}` : "Searching…";
    if (this.capped) return `Showing the first ${MATCHES.toLocaleString()} results in ${files.toLocaleString()} files`;
    return this.count ? found : "No results";
  }

  render(cx) {
    if (this.viewer) return this.imageView();
    if (key() !== this.context?.key) this.refresh(cx);
    // Measured while drawing, the only time a view may ask; the image dialog is sized from it.
    try { this.viewport = globalThis.window?.viewport_size?.() ?? this.viewport; } catch { /* not this host */ }
    const t = theme();
    return v_flex().id("files").relative().size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .on_mouse_down("right", (e, cx) => this.placeMenu(e, cx))
      // A drag ends when the button comes up outside the rows, or when the pointer leaves the panel.
      .on_mouse_up("left", (_e, cx) => this.cancelDrag(cx))
      .on_hover((hovered, cx) => { if (!hovered) this.cancelDrag(cx); })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        // Unsaved edits hold the panel on their file: Save or Discard leaves it.
        .when(Boolean(this.file) && !this.dirty, el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? ""))
        .when(Boolean(this.code) && this.original === null, el => el.child(div().flex_none().text_size(11).text_color(t.dim).child("Read-only")))
        .when(Boolean(this.code), el => el.child(this.toggleButton("files-color", "Color", !this.plain, t, cx => this.toggleColor(cx))))
        .when(this.markdown != null, el => el.child(h_flex().flex_none().gap(4)
          .child(this.viewButton("split", "Split", t)).child(this.viewButton("view", "View", t)).child(this.viewButton("code", "Code", t))))
        // Discard reads the file again, so a file changed elsewhere shows its new text.
        .when(this.dirty, el => el.child(this.headerButton("files-discard", "Discard", t, cx => this.show(this.file, cx), t.ansi1))
          .child(this.headerButton("files-save", this.saving ? "Saving…" : "Save", t, cx => this.save(cx), t.accent))))
      .when(Boolean(this.note), el => el.child(div().flex_none().px(14).py(6).text_size(11).text_color(this.note.error ? t.ansi1 : t.dim).border_b(1).border_color(t.border).child(this.note.text)))
      .when(Boolean(this.saveError), el => el.child(div().flex_none().px(14).py(6).text_size(11).text_color(t.ansi1).border_b(1).border_color(t.border).child(this.saveError)))
      .when(!this.file, el => el.child(h_flex().flex_none().px(8).pt(8).pb(4).gap(6).items_center()
        .child(Input.new(this.query).flex_1().min_w(0).h(30).px(10).items_center().rounded(6).border(1).border_color(this.queryFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground))
        .child(this.modeButton("name", "Name", t))
        .child(this.modeButton("content", "Content", t))))
      .when(!this.file && Boolean(this.query.value()), el => {
        const mono = settings().font_family;
        return el.child(div().flex_none().px(14).pb(4).text_size(11).text_color(this.searchError ? t.ansi1 : t.dim).child(this.searchStatus()))
          .child(div().flex_1().min_h(0).relative().px(6)
            .child(v_virtual_list("files-search", this.hitRows.length, ROW, i => `${i}\0${this.hitRows[i].path}`,
              range => this.hitRows.slice(range.start, range.end).map(row => this.hitRow(row, t, mono)))
              .size_full().on_item_click((key, cx) => this.show(key.slice(key.indexOf("\0") + 1), cx)))
            .child(Scrollbar.vertical("files-search").viewport_from_layout().absolute().inset_0()));
      })
      .when(!this.file && !this.query.value(), el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6)
        .track_focus(this.focus)
        .on_key_down((e, cx) => { if ((e.key === "f2" || e.key === "enter") && this.selected && !this.renaming) { cx.stop_propagation(); this.startRename(this.selected, cx); } else if (e.key === "escape" && this.menu) { this.menu = null; cx.notify(); } })
        .on_mouse_move((e, cx) => this.dragMove(e, "", cx))
        .on_mouse_up("left", (_e, cx) => { if (this.drag?.active) { cx.stop_propagation(); this.dragged = true; this.drop("", cx); } })
        .on_drop((e, cx) => this.dropFiles(e.paths, "", cx))
        .when(Boolean(this.drag?.active) && this.dropTarget === "" && this.canDrop(""), el => el.border_1().border_color(t.accent))
        .children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.fileBody(t)))
      .when(Boolean(this.menu), el => el.child(this.menuView(t)));
  }
}
