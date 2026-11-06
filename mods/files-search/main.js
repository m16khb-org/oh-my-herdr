// A lazy file browser for the focused pane's folder, with bounded read-only previews
// and a search by file name or by content that streams ripgrep results while it runs.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Input, InputState, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window } from "herdr";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;
const MATCHES = 2000, POLL_MS = 120, CHUNK = 1 << 20, ROW = 24;
// rg runs in the background and writes its output to a temp file; the panel reads new lines while it runs.
// Its own process group (set -m) and nohup: an exec on another machine ends its session's processes when it returns.
const START = '{ set -m; } 2>/dev/null; command -v rg >/dev/null 2>&1 || { echo norg; exit 0; }; f=$(mktemp "${TMPDIR:-/tmp}/herdr-search.XXXXXX") || exit 1; nohup rg "$@" > "$f" 2>/dev/null < /dev/null & echo "$! $f"';
// "done" first when rg has exited, then at most CHUNK bytes from byte offset $3: tail -c seeks instead of rescanning the file.
const POLL = 'kill -0 "$2" 2>/dev/null || echo done; tail -c +"$3" "$1" | head -c "$4"';
const STOP = 'kill "$2" 2>/dev/null; rm -f "$1"';

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
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {}; this.hitRows = []; this.headers = new Map(); this.count = 0;
    this.mode = "content";
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
    const { cwd, on } = location(), next = key();
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
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
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

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .child(entry.dir ? svg(`mods/files-search/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/files-search/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
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
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? "")))
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
      .when(!this.file && !this.query.value(), el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
