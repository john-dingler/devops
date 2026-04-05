'use strict';

const {
  app,
  BrowserWindow,
  BrowserView,
  ipcMain,
  session,
  Menu,
  MenuItem,
  shell,
  dialog,
  nativeTheme,
  clipboard,
} = require('electron');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Persistence helpers (plain JSON file, no extra runtime deps)
// ---------------------------------------------------------------------------
const USER_DATA  = app.getPath('userData');
const STORE_PATH = path.join(USER_DATA, 'dingo-store.json');

function readStore() {
  try { return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')); }
  catch { return {}; }
}
function writeStore(data) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), 'utf8');
}
function getStoreValue(key, defaultValue) {
  const s = readStore();
  return key in s ? s[key] : defaultValue;
}
function setStoreValue(key, value) {
  const s = readStore();
  s[key] = value;
  writeStore(s);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const isDev = process.argv.includes('--dev');
const DEFAULT_HOMEPAGE      = 'dingo://newtab';
const DEFAULT_SEARCH_ENGINE = 'https://www.google.com/search?q=';

// Chrome layout
const SIDEBAR_WIDTH  = 240;   // px — left panel
const TOOLBAR_HEIGHT = 48;    // px — top address-bar

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------
let mainWindow = null;
const views   = new Map();  // tabId → BrowserView
let tabCounter = 0;

// ---------------------------------------------------------------------------
// View bounds
// ---------------------------------------------------------------------------
function getViewBounds() {
  if (!mainWindow) return { x: SIDEBAR_WIDTH, y: TOOLBAR_HEIGHT, width: 800, height: 600 };
  const [w, h] = mainWindow.getContentSize();
  return {
    x:      SIDEBAR_WIDTH,
    y:      TOOLBAR_HEIGHT,
    width:  Math.max(0, w - SIDEBAR_WIDTH),
    height: Math.max(0, h - TOOLBAR_HEIGHT),
  };
}

function repositionActiveView() {
  const active = mainWindow?.getBrowserView();
  if (active) active.setBounds(getViewBounds());
}

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------
function saveSession() {
  const session = [];
  for (const [, view] of views) {
    if (!view.webContents.isDestroyed()) {
      const url = view.webContents.getURL();
      if (url && !url.startsWith('data:') && url !== 'about:blank') {
        session.push({ url, title: view.webContents.getTitle() });
      }
    }
  }
  setStoreValue('session', session);
}

function restoreSession() {
  const saved = getStoreValue('session', []);
  if (saved.length === 0) {
    createTab(getStoreValue('homepage', DEFAULT_HOMEPAGE));
    return;
  }
  saved.forEach((tab, i) => createTab(tab.url, i !== 0));
  // clear so a crash doesn't loop-restore a broken page
  setStoreValue('session', []);
}

// ---------------------------------------------------------------------------
// Session hardening
// ---------------------------------------------------------------------------
function setupSession() {
  const ses = session.defaultSession;
  ses.webRequest.onBeforeRequest(
    { urls: ['*://*.doubleclick.net/*', '*://*.googlesyndication.com/*', '*://*.adnxs.com/*'] },
    (_, cb) => cb({ cancel: true })
  );
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 820,
    minHeight: 600,
    frame: false,
    backgroundColor: '#0f0f1a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // Save session before close
  mainWindow.on('close', () => {
    saveSession();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('resize', repositionActiveView);
  mainWindow.webContents.on('will-navigate', e => e.preventDefault());
}

// ---------------------------------------------------------------------------
// URL resolution
// ---------------------------------------------------------------------------
function resolveUrl(input) {
  if (!input) return resolveUrl(getStoreValue('homepage', DEFAULT_HOMEPAGE));
  const t = input.trim();

  if (t === 'dingo://newtab')     return `file://${path.join(__dirname, 'renderer', 'newtab.html')}`;
  if (t === 'dingo://settings')   return `file://${path.join(__dirname, 'renderer', 'settings.html')}`;
  if (t === 'dingo://bookmarks')  return `file://${path.join(__dirname, 'renderer', 'bookmarks.html')}`;
  if (t === 'dingo://history')    return `file://${path.join(__dirname, 'renderer', 'history.html')}`;
  if (t === 'dingo://downloads')  return `file://${path.join(__dirname, 'renderer', 'downloads.html')}`;

  try {
    const parsed = new URL(t);
    if (['http:', 'https:', 'file:', 'data:', 'blob:', 'view-source:'].includes(parsed.protocol)) return t;
  } catch { /* fall through */ }

  if (/^[a-zA-Z0-9]([a-zA-Z0-9-]*\.)+[a-zA-Z]{2,}(\/.*)?$/.test(t)) return `https://${t}`;

  const engine = getStoreValue('searchEngine', DEFAULT_SEARCH_ENGINE);
  return `${engine}${encodeURIComponent(t)}`;
}

// ---------------------------------------------------------------------------
// Error page
// ---------------------------------------------------------------------------
function buildErrorPage(url, description, code) {
  const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Page not available</title>
<style>body{font-family:sans-serif;background:#0f0f1a;color:#e0e0e0;display:flex;align-items:center;
justify-content:center;height:100vh;margin:0}.card{background:#13132a;border-radius:12px;padding:40px;
max-width:480px;text-align:center}h1{color:#d64040;margin-bottom:8px}p{color:#888;margin:6px 0}
.code{font-size:11px;color:#444;margin-top:12px}</style></head>
<body><div class="card"><h1>&#128054; Page Not Available</h1>
<p>${esc(url)}</p><p>${esc(description)}</p><div class="code">ERR ${code}</div></div></body></html>`;
}

// ---------------------------------------------------------------------------
// Tab management
// ---------------------------------------------------------------------------
function createTab(url, background = false) {
  if (!mainWindow) return null;
  const tabId = ++tabCounter;
  const view  = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-web.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  views.set(tabId, view);
  view.setBackgroundColor('#ffffff');

  view.webContents.setWindowOpenHandler(({ url: u }) => {
    createTab(u);
    return { action: 'deny' };
  });

  view.webContents.on('did-start-loading', () => send('tab-loading',   { tabId, loading: true }));
  view.webContents.on('did-stop-loading',  () => send('tab-loading',   { tabId, loading: false }));

  view.webContents.on('did-navigate', (_, navUrl) => {
    send('tab-navigated', {
      tabId, url: navUrl,
      canGoBack:    view.webContents.canGoBack(),
      canGoForward: view.webContents.canGoForward(),
    });
    addHistory(navUrl, view.webContents.getTitle());
  });
  view.webContents.on('did-navigate-in-page', (_, navUrl) => {
    send('tab-navigated', {
      tabId, url: navUrl,
      canGoBack:    view.webContents.canGoBack(),
      canGoForward: view.webContents.canGoForward(),
    });
  });

  view.webContents.on('page-title-updated',   (_, title)    => send('tab-title',   { tabId, title }));
  view.webContents.on('page-favicon-updated', (_, favicons) => {
    if (favicons?.length) send('tab-favicon', { tabId, favicon: favicons[0] });
  });

  view.webContents.on('did-fail-load', (_, code, desc, validatedUrl) => {
    if (code !== -3) {
      view.webContents.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(buildErrorPage(validatedUrl, desc, code))}`
      );
    }
  });

  view.webContents.on('certificate-error', (e, _url, _err, _cert, cb) => {
    e.preventDefault();
    cb(false);
  });

  view.webContents.on('context-menu', (_, params) => {
    buildContextMenu(params, view).popup({ window: mainWindow });
  });

  view.webContents.session.on('will-download', (_, item) => handleDownload(item));

  if (!background) activateTab(tabId);

  view.webContents.loadURL(resolveUrl(url));
  send('tab-created', { tabId, url: resolveUrl(url), active: !background });
  return tabId;
}

function activateTab(tabId) {
  if (!mainWindow) return;
  const view = views.get(tabId);
  if (!view) return;
  mainWindow.setBrowserView(view);
  view.setBounds(getViewBounds());
  view.webContents.focus();
  send('tab-activated', {
    tabId,
    url:          view.webContents.getURL(),
    canGoBack:    view.webContents.canGoBack(),
    canGoForward: view.webContents.canGoForward(),
  });
}

function closeTab(tabId) {
  const view = views.get(tabId);
  if (!view) return;
  if (mainWindow?.getBrowserView() === view) mainWindow.setBrowserView(null);
  view.webContents.destroy();
  views.delete(tabId);
  send('tab-closed', { tabId });
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
function addHistory(url, title) {
  if (!url || url.startsWith('file://') || url.startsWith('data:') || url === 'about:blank') return;
  const history = getStoreValue('history', []);
  history.unshift({ url, title, timestamp: Date.now() });
  setStoreValue('history', history.slice(0, 1000));
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------
function buildContextMenu(params, view) {
  const menu = new Menu();
  if (params.selectionText) {
    menu.append(new MenuItem({ label: 'Copy', role: 'copy' }));
    menu.append(new MenuItem({ label: `Search "${params.selectionText.slice(0, 25)}…"`, click: () => createTab(params.selectionText) }));
    menu.append(new MenuItem({ type: 'separator' }));
  }
  if (params.linkURL) {
    menu.append(new MenuItem({ label: 'Open in New Tab',   click: () => createTab(params.linkURL) }));
    menu.append(new MenuItem({ label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) }));
    menu.append(new MenuItem({ type: 'separator' }));
  }
  if (params.mediaType === 'image') {
    menu.append(new MenuItem({ label: 'Copy Image',             click: () => view.webContents.copyImageAt(params.x, params.y) }));
    menu.append(new MenuItem({ label: 'Open Image in New Tab',  click: () => createTab(params.srcURL) }));
    menu.append(new MenuItem({ type: 'separator' }));
  }
  menu.append(new MenuItem({ label: 'Back',    enabled: view.webContents.canGoBack(),    click: () => view.webContents.goBack() }));
  menu.append(new MenuItem({ label: 'Forward', enabled: view.webContents.canGoForward(), click: () => view.webContents.goForward() }));
  menu.append(new MenuItem({ label: 'Reload',  click: () => view.webContents.reload() }));
  menu.append(new MenuItem({ type: 'separator' }));
  menu.append(new MenuItem({ label: 'Save Page As…', click: () => view.webContents.downloadURL(view.webContents.getURL()) }));
  menu.append(new MenuItem({ label: 'Print…',        click: () => view.webContents.print() }));
  menu.append(new MenuItem({ type: 'separator' }));
  menu.append(new MenuItem({ label: 'View Source', click: () => createTab(`view-source:${view.webContents.getURL()}`) }));
  menu.append(new MenuItem({ label: 'Inspect',     click: () => view.webContents.inspectElement(params.x, params.y) }));
  return menu;
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------
const activeDownloads = new Map();

function handleDownload(item) {
  const id = Date.now();
  item.setSavePath(path.join(app.getPath('downloads'), item.getFilename()));
  activeDownloads.set(id, item);
  send('download-started', { id, filename: item.getFilename(), totalBytes: item.getTotalBytes(), savePath: item.getSavePath() });
  item.on('updated', (_, state) => send('download-progress', { id, state, receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes() }));
  item.once('done', (_, state) => {
    activeDownloads.delete(id);
    send('download-done', { id, state, savePath: item.getSavePath() });
    const dl = getStoreValue('downloads', []);
    dl.unshift({ id, filename: item.getFilename(), savePath: item.getSavePath(), url: item.getURL(), state, timestamp: Date.now() });
    setStoreValue('downloads', dl.slice(0, 200));
  });
}

// ---------------------------------------------------------------------------
// Application menu
// ---------------------------------------------------------------------------
function buildAppMenu() {
  const template = [
    { label: 'File', submenu: [
      { label: 'New Tab',    accelerator: 'CmdOrCtrl+T', click: () => createTab(DEFAULT_HOMEPAGE) },
      { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: createWindow },
      { type: 'separator' },
      { label: 'Close Tab',  accelerator: 'CmdOrCtrl+W', click: () => send('close-active-tab', {}) },
      { label: 'Print…',     accelerator: 'CmdOrCtrl+P', click: () => mainWindow?.getBrowserView()?.webContents.print() },
    ]},
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      { type: 'separator' },
      { label: 'Find in Page…', accelerator: 'CmdOrCtrl+F', click: () => send('toggle-find', {}) },
    ]},
    { label: 'View', submenu: [
      { label: 'Reload',        accelerator: 'CmdOrCtrl+R',       click: () => mainWindow?.getBrowserView()?.webContents.reload() },
      { label: 'Force Reload',  accelerator: 'CmdOrCtrl+Shift+R', click: () => mainWindow?.getBrowserView()?.webContents.reloadIgnoringCache() },
      { type: 'separator' },
      { label: 'Zoom In',    accelerator: 'CmdOrCtrl+=', click: () => { const v = mainWindow?.getBrowserView(); if (v) v.webContents.setZoomFactor(Math.min(3, v.webContents.getZoomFactor() + 0.1)); } },
      { label: 'Zoom Out',   accelerator: 'CmdOrCtrl+-', click: () => { const v = mainWindow?.getBrowserView(); if (v) v.webContents.setZoomFactor(Math.max(0.25, v.webContents.getZoomFactor() - 0.1)); } },
      { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: () => { const v = mainWindow?.getBrowserView(); if (v) v.webContents.setZoomFactor(1); } },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { type: 'separator' },
      { label: 'Developer Tools', accelerator: 'F12', click: () => mainWindow?.getBrowserView()?.webContents.toggleDevTools() },
    ]},
    { label: 'History', submenu: [
      { label: 'Show History',         accelerator: 'CmdOrCtrl+H', click: () => createTab('dingo://history') },
      { label: 'Clear Browsing Data…', click: clearBrowsingData },
    ]},
    { label: 'Bookmarks', submenu: [
      { label: 'Bookmark This Page', accelerator: 'CmdOrCtrl+D', click: () => send('bookmark-current', {}) },
      { label: 'Show Bookmarks',     accelerator: 'CmdOrCtrl+B', click: () => createTab('dingo://bookmarks') },
    ]},
    { label: 'Help', submenu: [
      { label: 'About Dingo', click: showAbout },
    ]},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function clearBrowsingData() {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question', buttons: ['Cancel', 'Clear'], defaultId: 1,
    title: 'Clear Browsing Data', message: 'Clear all browsing data?',
    detail: 'This will clear history, cookies, and cached files.',
  });
  if (response === 1) {
    await session.defaultSession.clearHistory();
    await session.defaultSession.clearCache();
    await session.defaultSession.clearStorageData();
    setStoreValue('history', []);
  }
}

function showAbout() {
  dialog.showMessageBox(mainWindow, {
    type: 'info', title: 'About Dingo',
    message: '🐕 Dingo Browser',
    detail: 'Version 1.0.0\nBuilt on Electron + Chromium\n\nFast, private, yours. Rock on! 🎸',
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

function registerIpcHandlers() {
  // Window controls
  ipcMain.handle('win:minimize', () => mainWindow?.minimize());
  ipcMain.handle('win:maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
  ipcMain.handle('win:close',    () => mainWindow?.close());

  // Tabs
  ipcMain.handle('tab:create',     (_, { url, background }) => createTab(url, background));
  ipcMain.handle('tab:activate',   (_, { tabId }) => activateTab(tabId));
  ipcMain.handle('tab:close',      (_, { tabId }) => closeTab(tabId));
  ipcMain.handle('tab:screenshot', async (_, { tabId }) => {
    const v = views.get(tabId);
    if (!v) return null;
    return (await v.webContents.capturePage()).toDataURL();
  });

  // Navigation
  ipcMain.handle('nav:go',      (_, { tabId, url }) => { const v = views.get(tabId); if (v) v.webContents.loadURL(resolveUrl(url)); });
  ipcMain.handle('nav:back',    (_, { tabId }) => { const v = views.get(tabId); if (v?.webContents.canGoBack())    v.webContents.goBack(); });
  ipcMain.handle('nav:forward', (_, { tabId }) => { const v = views.get(tabId); if (v?.webContents.canGoForward()) v.webContents.goForward(); });
  ipcMain.handle('nav:reload',  (_, { tabId, ignoreCache }) => { const v = views.get(tabId); if (v) ignoreCache ? v.webContents.reloadIgnoringCache() : v.webContents.reload(); });
  ipcMain.handle('nav:stop',    (_, { tabId }) => { const v = views.get(tabId); if (v) v.webContents.stop(); });

  // Find
  ipcMain.handle('find:start', (_, { tabId, text, options }) => { const v = views.get(tabId); if (v) v.webContents.findInPage(text, options); });
  ipcMain.handle('find:stop',  (_, { tabId }) => { const v = views.get(tabId); if (v) v.webContents.stopFindInPage('clearSelection'); });

  // Zoom
  ipcMain.handle('zoom:set', (_, { tabId, factor }) => { const v = views.get(tabId); if (v) v.webContents.setZoomFactor(factor); });
  ipcMain.handle('zoom:get', (_, { tabId }) => { const v = views.get(tabId); return v ? v.webContents.getZoomFactor() : 1; });

  // Store (generic)
  ipcMain.handle('store:get', (_, { key, defaultValue }) => getStoreValue(key, defaultValue));
  ipcMain.handle('store:set', (_, { key, value }) => setStoreValue(key, value));

  // History
  ipcMain.handle('history:get',   () => getStoreValue('history', []));
  ipcMain.handle('history:clear', () => setStoreValue('history', []));

  // Bookmarks
  ipcMain.handle('bookmarks:get',    () => getStoreValue('bookmarks', []));
  ipcMain.handle('bookmarks:add',    (_, { url, title, favicon }) => {
    const bm = getStoreValue('bookmarks', []);
    if (!bm.find(b => b.url === url)) { bm.push({ url, title, favicon, timestamp: Date.now() }); setStoreValue('bookmarks', bm); }
    return getStoreValue('bookmarks', []);
  });
  ipcMain.handle('bookmarks:remove', (_, { url }) => {
    setStoreValue('bookmarks', getStoreValue('bookmarks', []).filter(b => b.url !== url));
    return getStoreValue('bookmarks', []);
  });

  // Projects (nested folder/tab tree)
  ipcMain.handle('projects:get',  () => getStoreValue('projects', []));
  ipcMain.handle('projects:save', (_, { projects }) => setStoreValue('projects', projects));

  // Downloads
  ipcMain.handle('downloads:get',    () => getStoreValue('downloads', []));
  ipcMain.handle('downloads:cancel', (_, { id }) => activeDownloads.get(id)?.cancel());
  ipcMain.handle('downloads:open',   (_, { savePath }) => shell.openPath(savePath));
  ipcMain.handle('downloads:show',   (_, { savePath }) => shell.showItemInFolder(savePath));

  // Shell
  ipcMain.handle('shell:openExternal', (_, { url }) => shell.openExternal(url));

  // Theme
  ipcMain.handle('theme:get', () => nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  ipcMain.handle('theme:set', (_, { theme }) => { nativeTheme.themeSource = theme; });

  // DevTools
  ipcMain.handle('devtools:toggle', (_, { tabId }) => { const v = views.get(tabId); if (v) v.webContents.toggleDevTools(); });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  setupSession();
  buildAppMenu();
  registerIpcHandlers();
  createWindow();

  mainWindow.webContents.once('did-finish-load', restoreSession);
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
