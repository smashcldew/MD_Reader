const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("api", {
  pickFiles: () => ipcRenderer.invoke("pick-files"),
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  readFile: p => ipcRenderer.invoke("read-file", p),
  writeFile: (p, text) => ipcRenderer.invoke("write-file", p, text),
  openPaths: paths => ipcRenderer.invoke("open-paths", paths),
  showInFolder: p => ipcRenderer.invoke("show-in-folder", p),
  pathOf: file => webUtils.getPathForFile(file),
  setDirty: v => ipcRenderer.send("set-dirty", v),
  setTitle: t => ipcRenderer.send("set-title", t),
  onOpen: cb => ipcRenderer.on("open", (_e, d) => cb(d)),
  onMenu: cb => ipcRenderer.on("menu", (_e, d) => cb(d))
});
