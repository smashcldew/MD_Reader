{
const $ = id => document.getElementById(id);
const api = window.api;
const LOCK = "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><rect x=\"5\" y=\"11\" width=\"14\" height=\"10\" rx=\"2\"/><path d=\"M8 11V7a4 4 0 0 1 8 0v4\"/></svg>";
const UNLOCK = "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><rect x=\"5\" y=\"11\" width=\"14\" height=\"10\" rx=\"2\"/><path d=\"M8 11V7a4 4 0 0 1 7.5-2\"/></svg>";
const WELCOME = "# 歡迎使用 MD 閱讀器\n\n用左側的 **選擇檔案**（`Ctrl+O`）或 **匯入資料夾**（`Ctrl+Shift+O`）開始，也可以把檔案或資料夾直接拖進視窗。\n\n## 唯讀保護\n\n每份文件打開時都是 **鎖定** 的。按右上角的鎖頭或 `Ctrl+E` 解鎖後，左邊是原文、右邊即時預覽，`Ctrl+S` 直接存回原檔。\n\n## 快捷鍵\n\n| 動作 | 按鍵 |\n| --- | --- |\n| 開啟檔案 | Ctrl+O |\n| 匯入資料夾 | Ctrl+Shift+O |\n| 解鎖 / 鎖定 | Ctrl+E |\n| 儲存 | Ctrl+S |\n| 搜尋檔名 | Ctrl+P |\n| 顯示 / 隱藏側欄 | Ctrl+B |\n| 重新載入 | F5 |\n";

const docs = new Map();   // key -> {abs, text?, orig?}
let root = null;          // 已匯入資料夾的絕對路徑（正斜線）
let cur = null, editing = false;

marked.setOptions({ gfm: true });

// ---------- 小工具 ----------
function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 1800); }
function ask(msg, ok) { return new Promise(res => { $("modalText").textContent = msg; $("mYes").textContent = ok || "確定"; $("modal").classList.add("show"); const done = v => { $("modal").classList.remove("show"); $("mYes").onclick = $("mNo").onclick = null; res(v); }; $("mYes").onclick = () => done(true); $("mNo").onclick = () => done(false); $("mYes").focus(); }); }
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
const isMd = n => /\.(md|markdown|mdx|txt)$/i.test(n);
const isDirty = e => e.text != null && e.text !== e.orig;
const anyDirty = () => [...docs.values()].some(isDirty);
const dirOf = p => p.slice(0, p.lastIndexOf("/"));
const baseOf = p => p.slice(p.lastIndexOf("/") + 1);

function norm(p) {
  const drive = /^[A-Za-z]:/.test(p) ? p.slice(0, 2) : "";
  const unc = p.startsWith("//");
  const out = [];
  for (const s of p.slice(drive.length).split("/")) { if (!s || s === ".") continue; if (s === "..") out.pop(); else out.push(s); }
  return (unc ? "//" : drive ? drive + "/" : "/") + out.join("/");
}
function resolveAbs(baseFile, rel) {
  rel = decodeURIComponent(rel.split("#")[0].split("?")[0]).replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(rel)) return norm(rel);
  if (rel.startsWith("/") && root) return norm(root + rel);
  return norm(dirOf(baseFile) + "/" + rel);
}
const fileUrl = abs => "file:///" + encodeURI(abs.replace(/^\/+/, "")).replace(/#/g, "%23").replace(/\?/g, "%3F");
const keyOfAbs = abs => { const a = abs.toLowerCase(); for (const [k, v] of docs) if (v.abs.toLowerCase() === a) return k; return null; };

function syncDirty() { api.setDirty(anyDirty()); }

// ---------- 載入 ----------
async function handleOpen(payload) {
  if (!payload) return;
  if (payload.kind === "folder") {
    if (anyDirty() && !(await ask("目前有未儲存的修改，匯入新資料夾會放棄它們，要繼續嗎？", "放棄並繼續"))) return;
    if (editing) setEdit(false);
    docs.clear(); root = payload.root; cur = null;
    for (const rel of payload.files) docs.set(rel, { abs: root + "/" + rel });
    renderTree();
    if (!payload.files.length) { toast("這個資料夾裡沒有 Markdown 檔案"); showWelcome(); return; }
    toast("已匯入「" + payload.name + "」，共 " + payload.files.length + " 個文件");
    open(payload.files.find(p => /(^|\/)readme\.md$/i.test(p)) || payload.files[0]);
  } else {
    if (!payload.files.length) { toast("沒有可開啟的 Markdown 檔案"); return; }
    let last = null;
    for (const abs of payload.files) last = addFile(abs);
    renderTree();
    open(last);
  }
}
function addFile(abs) {
  const exist = keyOfAbs(abs); if (exist) return exist;
  let key;
  if (root && abs.toLowerCase().startsWith(root.toLowerCase() + "/")) key = abs.slice(root.length + 1);
  else { key = (root ? "其他檔案/" : "") + baseOf(abs); let i = 2; while (docs.has(key)) key = key.replace(/( \(\d+\))?(\.\w+)$/, " (" + i++ + ")$2"); }
  docs.set(key, { abs });
  return key;
}

// ---------- 檔案樹 ----------
function buildTree() {
  const tree = { dirs: {}, files: [] };
  const q = $("search").value.trim().toLowerCase();
  for (const k of [...docs.keys()].sort((a, b) => a.localeCompare(b, "zh-Hant", { numeric: true }))) {
    if (q && !k.toLowerCase().includes(q)) continue;
    let node = tree;
    k.split("/").slice(0, -1).forEach(d => node = node.dirs[d] ||= { dirs: {}, files: [] });
    node.files.push(k);
  }
  return tree;
}
function treeHtml(node, depth, prefix) {
  const q = $("search").value;
  const dirs = Object.keys(node.dirs).map(d => {
    const path = prefix + d + "/";
    const open = q || depth < 1 || (cur && cur.startsWith(path));
    return "<details" + (open ? " open" : "") + "><summary>" + esc(d) + "</summary><div class=\"kids\">" + treeHtml(node.dirs[d], depth + 1, path) + "</div></details>";
  }).join("");
  const fs = node.files.map(k => "<button class=\"f" + (k === cur ? " on" : "") + (isDirty(docs.get(k)) ? " dirty" : "") + "\" data-k=\"" + esc(k) + "\" title=\"" + esc(docs.get(k).abs) + "\"><span class=\"dot\"></span><span>" + esc(baseOf("/" + k)) + "</span></button>").join("");
  return dirs + fs;
}
function renderTree() {
  $("tree").innerHTML = treeHtml(buildTree(), 0, "") || "<div class=\"none\">" + (docs.size ? "沒有符合的檔案" : "尚未開啟任何檔案") + "</div>";
  $("count").textContent = (root ? baseOf(root) + "・" : "") + docs.size + " 個文件";
  const on = $("tree").querySelector(".f.on"); if (on) on.scrollIntoView({ block: "nearest" });
}

// ---------- 開啟與渲染 ----------
async function open(key, hash) {
  const e = docs.get(key); if (!e) return;
  if (editing) setEdit(false);
  if (e.text == null) {
    try { e.text = e.orig = await api.readFile(e.abs); }
    catch { toast("讀取失敗：" + baseOf(e.abs)); return; }
  }
  cur = key;
  const parts = key.split("/");
  $("crumb").innerHTML = parts.slice(0, -1).map(esc).join(" / ") + (parts.length > 1 ? " / " : "") + "<b>" + esc(parts.at(-1)) + "</b>";
  $("saved").textContent = "";
  render(e.text, e.abs);
  renderTree();
  updateButtons();
  $("app").querySelector("aside").classList.remove("open");
  if (hash) { const t = $("doc").querySelector("#" + CSS.escape(hash)); if (t) t.scrollIntoView(); } else $("scroller").scrollTop = 0;
  api.setTitle(parts.at(-1) + " – MD 閱讀器");
}
function showWelcome() { cur = null; $("crumb").innerHTML = "<b>歡迎</b>"; render(WELCOME, ""); updateButtons(); api.setTitle("MD 閱讀器"); }

function slug(t, used) { let s = t.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-") || "h"; const o = s; let i = 1; while (used.has(s)) s = o + "-" + i++; used.add(s); return s; }

function render(text, abs) {
  const doc = $("doc");
  doc.innerHTML = DOMPurify.sanitize(marked.parse(text));
  const used = new Set(), toc = [];
  doc.querySelectorAll("h1,h2,h3").forEach(h => {
    h.id = slug(h.textContent, used);
    if (h.tagName !== "H1") toc.push("<a href=\"#" + h.id + "\" data-h=\"" + h.id + "\" class=\"l" + h.tagName[1] + "\">" + esc(h.textContent) + "</a>");
  });
  $("toc").innerHTML = toc.length ? "<h4>本頁目錄</h4>" + toc.join("") : "";
  doc.querySelectorAll("img").forEach(img => {
    const src = img.getAttribute("src") || "";
    if (!src || /^(https?:|data:)/i.test(src) || !abs) return;
    img.src = fileUrl(resolveAbs(abs, src));
  });
  doc.querySelectorAll("a[href]").forEach(a => {
    const h = a.getAttribute("href");
    if (h.startsWith("#")) { a.dataset.h = h.slice(1); return; }
    if (/^(https?|mailto):/i.test(h)) { a.dataset.ext = h; return; }
    if (abs && !/^[a-z]+:/i.test(h)) { a.dataset.md = resolveAbs(abs, h); a.dataset.hash = h.includes("#") ? h.split("#")[1] : ""; }
  });
  doc.querySelectorAll("input[type=checkbox]").forEach(c => c.disabled = true);
}

// ---------- 編輯 ----------
function updateButtons() {
  const e = cur && docs.get(cur);
  $("lockBtn").hidden = !e;
  $("lockBtn").classList.toggle("open", editing);
  $("lockBtn").innerHTML = (editing ? UNLOCK : LOCK) + "<span class=\"t\">" + (editing ? "編輯中・按此鎖定" : "唯讀・按此解鎖") + "</span>";
  $("saveBtn").hidden = !editing;
  $("saveBtn").disabled = !(e && isDirty(e));
  $("revertBtn").hidden = !editing || !e || !isDirty(e);
}
function setEdit(on) {
  editing = on;
  $("body").classList.toggle("editing", on);
  $("banner").classList.toggle("show", on);
  if (on) { $("ta").value = docs.get(cur).text; $("ta").focus(); }
  updateButtons();
}
async function toggleEdit() {
  if (!cur) return;
  if (!editing) { if (await ask("解鎖「" + baseOf("/" + cur) + "」以進行編輯？", "解鎖")) setEdit(true); }
  else setEdit(false);
}
async function save() {
  const e = cur && docs.get(cur); if (!e || !isDirty(e)) return;
  try {
    await api.writeFile(e.abs, e.text);
    e.orig = e.text;
    const t = new Date();
    $("saved").textContent = "已儲存 " + String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0");
    renderTree(); updateButtons(); syncDirty();
  } catch (err) { toast("儲存失敗：" + (err.message || err)); }
}
async function reload() {
  const e = cur && docs.get(cur); if (!e) return;
  if (isDirty(e) && !(await ask("重新載入會放棄目前的修改，要繼續嗎？", "放棄並重新載入"))) return;
  e.text = e.orig = undefined;
  const k = cur; cur = null; await open(k); syncDirty(); toast("已從磁碟重新載入");
}

let tm;
$("ta").addEventListener("input", () => {
  const e = docs.get(cur); e.text = $("ta").value;
  updateButtons(); syncDirty();
  clearTimeout(tm); tm = setTimeout(() => { render(e.text, e.abs); renderTree(); }, 120);
});
$("ta").addEventListener("keydown", ev => {
  if (ev.key === "Tab") { ev.preventDefault(); const t = ev.target; t.setRangeText("  ", t.selectionStart, t.selectionEnd, "end"); t.dispatchEvent(new Event("input")); }
});

// ---------- 事件 ----------
$("lockBtn").onclick = toggleEdit;
$("saveBtn").onclick = save;
$("revertBtn").onclick = async () => {
  if (!(await ask("放棄所有修改，還原成上次儲存的內容？", "還原"))) return;
  const e = docs.get(cur); e.text = e.orig; $("ta").value = e.text; render(e.text, e.abs); renderTree(); updateButtons(); syncDirty();
};
$("pickFiles").onclick = () => api.pickFiles();
$("pickDir").onclick = () => api.pickFolder();
$("menuBtn").onclick = () => $("side").classList.toggle("open");
$("search").oninput = renderTree;
$("tree").addEventListener("click", e => { const b = e.target.closest("button.f"); if (b) open(b.dataset.k); });

document.addEventListener("click", e => {
  const a = e.target.closest("a[data-h], a[data-md], a[data-ext]"); if (!a) return;
  e.preventDefault();
  if (a.dataset.ext) { window.open(a.dataset.ext); return; }
  if (a.dataset.md) {
    if (!isMd(a.dataset.md)) { toast("只能在閱讀器內開啟 Markdown 檔案"); return; }
    const k = keyOfAbs(a.dataset.md) || addFile(a.dataset.md);
    renderTree(); open(k, a.dataset.hash); return;
  }
  const t = $("doc").querySelector("#" + CSS.escape(a.dataset.h));
  if (t) t.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
});

api.onOpen(handleOpen);
api.onMenu(cmd => {
  if (cmd === "save") { if (editing) save(); }
  else if (cmd === "toggle-edit") toggleEdit();
  else if (cmd === "reload") reload();
  else if (cmd === "reveal") { if (cur) api.showInFolder(docs.get(cur).abs.replace(/\//g, "\\")); }
  else if (cmd === "search") { $("app").classList.remove("noside"); $("search").focus(); $("search").select(); }
  else if (cmd === "sidebar") $("app").classList.toggle("noside");
});
document.addEventListener("keydown", e => { if (e.key === "Escape") $("side").classList.remove("open"); });

// 拖放
let dc = 0;
const main = $("main");
main.addEventListener("dragenter", e => { e.preventDefault(); dc++; $("drop").classList.add("show"); });
main.addEventListener("dragleave", () => { if (--dc <= 0) { dc = 0; $("drop").classList.remove("show"); } });
main.addEventListener("dragover", e => e.preventDefault());
main.addEventListener("drop", async e => {
  e.preventDefault(); dc = 0; $("drop").classList.remove("show");
  const paths = [...e.dataTransfer.files].map(f => api.pathOf(f)).filter(Boolean);
  if (paths.length) handleOpen(await api.openPaths(paths));
});

showWelcome();
renderTree();
}
