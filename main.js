const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const fss = require("fs");

const MD_EXT = /\.(md|markdown|mdx|txt)$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", ".svn", ".hg", "dist", "build", ".next", ".venv", "__pycache__"]);
const STATE_FILE = path.join(app.getPath("userData"), "state.json");

let win = null;
let dirty = false;
let pendingOpen = null;

// ---------- 狀態（記住上次開啟的資料夾）----------
function readState() {
  try { return JSON.parse(fss.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function writeState(patch) {
  const s = { ...readState(), ...patch };
  try { fss.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fss.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}

// ---------- 掃描資料夾 ----------
async function scanDir(root) {
  const out = [];
  async function walk(dir, depth) {
    if (depth > 12 || out.length > 5000) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) await walk(full, depth + 1);
      } else if (e.isFile() && MD_EXT.test(e.name)) {
        out.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  }
  await walk(root, 0);
  return out;
}

async function folderPayload(root) {
  return { kind: "folder", root: root.split(path.sep).join("/"), name: path.basename(root), files: await scanDir(root) };
}
function filesPayload(list) {
  return { kind: "files", files: list.filter(f => MD_EXT.test(f)).map(f => f.split(path.sep).join("/")) };
}

// ---------- 視窗 ----------
function createWindow() {
  const s = readState();
  win = new BrowserWindow({
    width: s.width || 1280,
    height: s.height || 820,
    minWidth: 520,
    minHeight: 400,
    title: "MD 閱讀器",
    backgroundColor: "#1f3329",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  // 外部連結用系統瀏覽器開啟，頁面本身不跳轉
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  win.on("close", e => {
    const [width, height] = win.getSize();
    writeState({ width, height });
    if (!dirty) return;
    const r = dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: ["放棄修改並關閉", "取消"],
      defaultId: 1,
      cancelId: 1,
      title: "尚未儲存",
      message: "有文件修改後還沒儲存，確定要關閉嗎？"
    });
    if (r === 1) e.preventDefault();
  });

  win.webContents.on("did-finish-load", async () => {
    if (pendingOpen) { send("open", pendingOpen); pendingOpen = null; return; }
    const argFile = fileFromArgv(process.argv);
    if (argFile) { send("open", filesPayload([argFile])); return; }
    const last = readState().lastFolder;
    if (last && fss.existsSync(last)) send("open", await folderPayload(last));
  });
}

function send(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }

function fileFromArgv(argv) {
  return argv.slice(app.isPackaged ? 1 : 2).find(a => MD_EXT.test(a) && fss.existsSync(a)) || null;
}

// ---------- 開啟對話框 ----------
async function pickFiles() {
  const r = await dialog.showOpenDialog(win, {
    title: "選擇 Markdown 檔案",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdx", "txt"] }, { name: "所有檔案", extensions: ["*"] }]
  });
  if (!r.canceled && r.filePaths.length) send("open", filesPayload(r.filePaths));
}
async function pickFolder() {
  const r = await dialog.showOpenDialog(win, { title: "匯入資料夾", properties: ["openDirectory"] });
  if (r.canceled || !r.filePaths.length) return;
  writeState({ lastFolder: r.filePaths[0] });
  send("open", await folderPayload(r.filePaths[0]));
}

// ---------- IPC ----------
ipcMain.handle("pick-files", pickFiles);
ipcMain.handle("pick-folder", pickFolder);
ipcMain.handle("read-file", async (_e, p) => fs.readFile(p, "utf8"));
ipcMain.handle("write-file", async (_e, p, text) => {
  if (!MD_EXT.test(p)) throw new Error("只允許寫入 Markdown 檔案");
  await fs.writeFile(p, text, "utf8");
  return true;
});
ipcMain.handle("open-paths", async (_e, paths) => {
  const dir = paths.find(p => { try { return fss.statSync(p).isDirectory(); } catch { return false; } });
  if (dir) { writeState({ lastFolder: dir }); return folderPayload(dir); }
  return filesPayload(paths);
});
ipcMain.handle("show-in-folder", (_e, p) => shell.showItemInFolder(p));
ipcMain.on("set-dirty", (_e, v) => { dirty = !!v; if (win) win.setDocumentEdited(dirty); });
ipcMain.on("set-title", (_e, t) => { if (win) win.setTitle(t); });

// ---------- 選單 ----------
function buildMenu() {
  const tpl = [
    { label: "檔案", submenu: [
      { label: "開啟檔案…", accelerator: "CmdOrCtrl+O", click: pickFiles },
      { label: "匯入資料夾…", accelerator: "CmdOrCtrl+Shift+O", click: pickFolder },
      { type: "separator" },
      { label: "儲存", accelerator: "CmdOrCtrl+S", click: () => send("menu", "save") },
      { label: "重新從磁碟載入", accelerator: "F5", click: () => send("menu", "reload") },
      { label: "在檔案總管中顯示", click: () => send("menu", "reveal") },
      { type: "separator" },
      { label: "結束", role: "quit" }
    ] },
    { label: "編輯", submenu: [
      { label: "解鎖 / 鎖定編輯", accelerator: "CmdOrCtrl+E", click: () => send("menu", "toggle-edit") },
      { type: "separator" },
      { label: "復原", role: "undo" }, { label: "重做", role: "redo" },
      { type: "separator" },
      { label: "剪下", role: "cut" }, { label: "複製", role: "copy" }, { label: "貼上", role: "paste" }, { label: "全選", role: "selectAll" },
      { type: "separator" },
      { label: "搜尋檔名", accelerator: "CmdOrCtrl+P", click: () => send("menu", "search") }
    ] },
    { label: "檢視", submenu: [
      { label: "顯示 / 隱藏側欄", accelerator: "CmdOrCtrl+B", click: () => send("menu", "sidebar") },
      { type: "separator" },
      { label: "放大", role: "zoomIn" }, { label: "縮小", role: "zoomOut" }, { label: "實際大小", role: "resetZoom" },
      { type: "separator" },
      { label: "全螢幕", role: "togglefullscreen" },
      { label: "開發者工具", role: "toggleDevTools" }
    ] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

// ---------- 單一實例：雙擊另一個 .md 時在原視窗開啟 ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const f = argv.slice(1).find(a => MD_EXT.test(a) && fss.existsSync(a));
    if (f) send("open", filesPayload([f]));
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.on("open-file", (e, f) => { e.preventDefault(); if (win) send("open", filesPayload([f])); else pendingOpen = filesPayload([f]); });
  app.whenReady().then(() => { buildMenu(); createWindow(); });
  app.on("window-all-closed", () => app.quit());
}
