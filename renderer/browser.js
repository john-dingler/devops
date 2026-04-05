'use strict';

/**
 * browser.js — Renderer-process logic for the Dingo Browser chrome UI.
 *
 * Tab model:
 *   state.tabs  Map<tabId, TabEntry>  — persists entries even after close.
 *   alive=true  → live BrowserView exists in main process
 *   alive=false → BrowserView destroyed; entry shown in "Recently Closed"
 *
 * Projects model:
 *   state.projects  Array<ProjectNode>
 *   ProjectNode = { id, name, color, expanded, children: ItemNode[] }
 *   ItemNode    = { id, type:'link'|'folder', name, url?, color?,
 *                   expanded?, children?:ItemNode[] }
 */

// ── Globals ─────────────────────────────────────────────────────────────────
const d  = window.dingo;          // IPC bridge (preload.js)
const $  = id => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2);

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  tabs:        new Map(),   // tabId → TabEntry
  activeTabId: null,
  bookmarks:   [],
  projects:    [],
  zoomFactor:  1,
  findOpen:    false,
};

// ── DOM refs ─────────────────────────────────────────────────────────────────
const openTabsList    = $('open-tabs-list');
const closedTabsList  = $('closed-tabs-list');
const closedSection   = $('closed-section');
const bookmarksList   = $('bookmarks-list');
const projectsTree    = $('projects-tree');
const addressBar      = $('address-bar');
const securityIcon    = $('security-icon');
const bookmarkStar    = $('btn-bookmark-star');
const zoomLabel       = $('zoom-label');
const findBar         = $('find-bar');
const findInput       = $('find-input');
const findStatus      = $('find-status');
const noTabPlaceholder = $('no-tab-placeholder');
const downloadTray    = $('download-tray');
const downloadList    = $('download-list');
const dialogOverlay   = $('dialog-overlay');
const dialogTitle     = $('dialog-title');
const dialogInput     = $('dialog-input');
const dialogOk        = $('dialog-ok');
const dialogCancel    = $('dialog-cancel');

// ── Element builder ──────────────────────────────────────────────────────────
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') node.className = v;
      else if (k === 'textContent') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, v);
    }
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

// ═══════════════════════════════════════════════════════════════════════════
// DIALOG (project create / rename)
// ═══════════════════════════════════════════════════════════════════════════
let _dialogResolve = null;
let _dialogColor   = '#7c5cbf';

function showDialog(title, defaultName = '', defaultColor = '#7c5cbf') {
  return new Promise(resolve => {
    _dialogResolve = resolve;
    _dialogColor   = defaultColor;

    dialogTitle.textContent = title;
    dialogInput.value       = defaultName;
    dialogOk.textContent    = defaultName ? 'Save' : 'Create';

    // Set selected color dot
    document.querySelectorAll('.color-dot').forEach(btn => {
      btn.classList.toggle('selected', btn.dataset.color === defaultColor);
    });

    dialogOverlay.classList.remove('hidden');
    setTimeout(() => { dialogInput.focus(); dialogInput.select(); }, 50);
  });
}

function closeDialog(confirmed) {
  dialogOverlay.classList.add('hidden');
  if (_dialogResolve) {
    _dialogResolve(confirmed ? { name: dialogInput.value.trim(), color: _dialogColor } : null);
    _dialogResolve = null;
  }
}

document.querySelectorAll('.color-dot').forEach(btn => {
  btn.addEventListener('click', () => {
    _dialogColor = btn.dataset.color;
    document.querySelectorAll('.color-dot').forEach(b => b.classList.toggle('selected', b === btn));
  });
});

dialogOk.addEventListener('click',     () => closeDialog(true));
dialogCancel.addEventListener('click', () => closeDialog(false));
dialogInput.addEventListener('keydown', e => {
  if (e.key === 'Enter')  closeDialog(true);
  if (e.key === 'Escape') closeDialog(false);
});
dialogOverlay.addEventListener('click', e => {
  if (e.target === dialogOverlay) closeDialog(false);
});

// ═══════════════════════════════════════════════════════════════════════════
// WINDOW CONTROLS
// ═══════════════════════════════════════════════════════════════════════════
$('btn-minimize').addEventListener('click', () => d.invoke('win:minimize'));
$('btn-maximize').addEventListener('click', () => d.invoke('win:maximize'));
$('btn-close').addEventListener('click',    () => d.invoke('win:close'));

// ═══════════════════════════════════════════════════════════════════════════
// TAB MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════
function createTabEntry(tabId, url) {
  return { tabId, title: 'New Tab', url: url || '', favicon: null,
           loading: false, alive: true, canGoBack: false, canGoForward: false };
}

async function openNewTab(url) {
  await d.invoke('tab:create', { url: url || 'dingo://newtab', background: false });
}

async function activateTab(tabId) {
  const entry = state.tabs.get(tabId);
  if (!entry) return;

  if (!entry.alive) {
    // Re-open closed tab — create a fresh BrowserView, discard the stale entry
    await d.invoke('tab:create', { url: entry.url || 'dingo://newtab', background: false });
    state.tabs.delete(tabId);
    renderSidebar();
    return;
  }

  state.activeTabId = tabId;
  await d.invoke('tab:activate', { tabId });
  updateToolbar();
  renderSidebar();
}

async function closeTabById(tabId) {
  const entry = state.tabs.get(tabId);
  if (!entry) return;
  if (entry.alive) {
    await d.invoke('tab:close', { tabId });
    // 'tab-closed' event will set alive=false
  } else {
    state.tabs.delete(tabId);
    renderSidebar();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SIDEBAR RENDERING
// ═══════════════════════════════════════════════════════════════════════════
function renderSidebar() {
  renderOpenTabs();
  renderClosedTabs();
  renderBookmarks();
  renderProjects();
}

function buildTabItem(tab) {
  const isActive = tab.tabId === state.activeTabId && tab.alive;
  const item = el('li', {
    className: `tab-item${isActive ? ' active' : ''}${tab.alive ? '' : ' closed'}`,
  });

  let faviconEl;
  if (tab.loading && tab.alive) {
    faviconEl = el('div', { className: 'tab-spinner' });
  } else if (tab.favicon) {
    faviconEl = el('img', { className: 'tab-favicon', src: tab.favicon, alt: '' });
    faviconEl.onerror = () => faviconEl.replaceWith(el('span', { className: 'tab-favicon-placeholder', textContent: '🌐' }));
  } else {
    faviconEl = el('span', { className: 'tab-favicon-placeholder', textContent: tab.alive ? '🌐' : '○' });
  }

  const title   = el('span', { className: 'tab-title',  textContent: tab.title || 'New Tab' });
  const closeBtn = el('button', {
    className: 'tab-close',
    title: tab.alive ? 'Close tab' : 'Remove',
    onClick: e => { e.stopPropagation(); closeTabById(tab.tabId); },
  }, '✕');

  item.append(faviconEl, title, closeBtn);
  item.addEventListener('click', () => activateTab(tab.tabId));
  return item;
}

function renderOpenTabs() {
  openTabsList.innerHTML = '';
  const open = [...state.tabs.values()].filter(t => t.alive);
  noTabPlaceholder.style.display = open.length === 0 ? 'flex' : 'none';
  open.forEach(t => openTabsList.appendChild(buildTabItem(t)));
}

function renderClosedTabs() {
  closedTabsList.innerHTML = '';
  const closed = [...state.tabs.values()].filter(t => !t.alive);
  closedSection.style.display = closed.length > 0 ? '' : 'none';
  closed.forEach(t => closedTabsList.appendChild(buildTabItem(t)));
}

function renderBookmarks() {
  bookmarksList.innerHTML = '';
  for (const bm of state.bookmarks) {
    const item = el('li', { className: 'tab-item' });
    const fav  = bm.favicon
      ? el('img', { className: 'tab-favicon', src: bm.favicon, alt: '' })
      : el('span', { className: 'tab-favicon-placeholder', textContent: '★' });
    if (fav.onerror) fav.onerror = () => fav.remove();

    const title    = el('span', { className: 'tab-title', textContent: bm.title || bm.url });
    const closeBtn = el('button', {
      className: 'tab-close', title: 'Remove bookmark',
      onClick: async e => {
        e.stopPropagation();
        state.bookmarks = await d.invoke('bookmarks:remove', { url: bm.url });
        renderBookmarks();
        updateBookmarkStar(state.tabs.get(state.activeTabId)?.url || '');
      },
    }, '✕');

    item.append(fav, title, closeBtn);
    item.addEventListener('click', () => openNewTab(bm.url));
    bookmarksList.appendChild(item);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PROJECT DIRECTORY TREE
// ═══════════════════════════════════════════════════════════════════════════
function saveProjects() {
  d.invoke('projects:save', { projects: state.projects });
}

/** Recursively find a node by id anywhere in the tree. */
function findNode(nodes, id) {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children) {
      const found = findNode(n.children, id);
      if (found) return found;
    }
  }
  return null;
}

/** Remove a node by id from any children array. */
function removeNode(nodes, id) {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id === id) { nodes.splice(i, 1); return true; }
    if (nodes[i].children && removeNode(nodes[i].children, id)) return true;
  }
  return false;
}

function renderProjects() {
  projectsTree.innerHTML = '';
  state.projects.forEach(proj => {
    projectsTree.appendChild(buildProjectFolder(proj, state.projects, true));
  });
}

function buildProjectFolder(node, siblingArray, isRoot = false) {
  const wrapper = el('div', { className: `project-folder${node.expanded ? ' expanded' : ''}` });

  // ── header ──
  const header = el('div', { className: 'project-folder-header' });

  const chevron  = el('span', { className: 'project-folder-chevron', textContent: '▶' });
  const colorDot = el('span', { className: 'project-color-dot' });
  colorDot.style.background = node.color || '#888';
  const nameEl = el('span', { className: 'project-name', textContent: node.name });

  // Action buttons
  const actions = el('div', { className: 'project-actions' });

  // Add link (current tab)
  const btnAddLink = el('button', {
    className: 'project-action-btn',
    title: 'Add current tab as link',
    onClick: e => {
      e.stopPropagation();
      const tab = state.tabs.get(state.activeTabId);
      if (!tab || !tab.url) return;
      if (!node.children) node.children = [];
      node.children.push({ id: uid(), type: 'link', name: tab.title || tab.url, url: tab.url });
      node.expanded = true;
      wrapper.classList.add('expanded');
      saveProjects();
      renderProjects();
    },
  }, '＋');

  // Add subfolder
  const btnAddFolder = el('button', {
    className: 'project-action-btn',
    title: 'Add subfolder',
    onClick: async e => {
      e.stopPropagation();
      const result = await showDialog('New Folder', '', node.color || '#888');
      if (!result || !result.name) return;
      if (!node.children) node.children = [];
      node.children.push({ id: uid(), type: 'folder', name: result.name, color: result.color, expanded: false, children: [] });
      node.expanded = true;
      wrapper.classList.add('expanded');
      saveProjects();
      renderProjects();
    },
  }, '📁');

  // Rename
  const btnRename = el('button', {
    className: 'project-action-btn',
    title: 'Rename',
    onClick: async e => {
      e.stopPropagation();
      const result = await showDialog('Rename Project', node.name, node.color || '#888');
      if (!result || !result.name) return;
      node.name  = result.name;
      node.color = result.color;
      saveProjects();
      renderProjects();
    },
  }, '✏');

  // Delete
  const btnDelete = el('button', {
    className: 'project-action-btn danger',
    title: 'Delete',
    onClick: e => {
      e.stopPropagation();
      if (!confirm(`Delete project "${node.name}"?`)) return;
      removeNode(state.projects, node.id);
      saveProjects();
      renderProjects();
    },
  }, '✕');

  actions.append(btnAddLink, btnAddFolder, btnRename, btnDelete);
  header.append(chevron, colorDot, nameEl, actions);

  // Toggle expand on header click
  header.addEventListener('click', () => {
    node.expanded = !node.expanded;
    wrapper.classList.toggle('expanded', node.expanded);
    saveProjects();
  });

  wrapper.appendChild(header);

  // ── children ──
  if (node.children && node.children.length > 0) {
    const childrenEl = el('div', { className: 'project-children' });
    node.children.forEach(child => {
      if (child.type === 'folder') {
        childrenEl.appendChild(buildProjectFolder(child, node.children));
      } else {
        childrenEl.appendChild(buildProjectLink(child, node.children));
      }
    });
    wrapper.appendChild(childrenEl);
  }

  return wrapper;
}

function buildProjectLink(node, siblingArray) {
  const item = el('div', { className: 'tab-item' });

  const fav = el('span', { className: 'tab-favicon-placeholder', textContent: '🔗' });
  const title = el('span', { className: 'tab-title', textContent: node.name || node.url });

  const delBtn = el('button', {
    className: 'tab-close',
    title: 'Remove',
    onClick: e => {
      e.stopPropagation();
      removeNode(state.projects, node.id);
      saveProjects();
      renderProjects();
    },
  }, '✕');

  item.append(fav, title, delBtn);
  item.addEventListener('click', () => openNewTab(node.url));
  return item;
}

// Add-project button
$('btn-add-project').addEventListener('click', async () => {
  const result = await showDialog('New Project', '');
  if (!result || !result.name) return;
  state.projects.push({ id: uid(), name: result.name, color: result.color, expanded: true, children: [] });
  saveProjects();
  renderProjects();
});

// ═══════════════════════════════════════════════════════════════════════════
// TOOLBAR HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function friendlyUrl(url) {
  if (!url) return '';
  if (url.includes('/renderer/newtab.html'))    return 'dingo://newtab';
  if (url.includes('/renderer/settings.html'))  return 'dingo://settings';
  if (url.includes('/renderer/bookmarks.html')) return 'dingo://bookmarks';
  if (url.includes('/renderer/history.html'))   return 'dingo://history';
  if (url.includes('/renderer/downloads.html')) return 'dingo://downloads';
  return url;
}

function updateToolbar() {
  const tab = state.tabs.get(state.activeTabId);
  if (!tab) {
    addressBar.value = '';
    $('btn-back').disabled    = true;
    $('btn-forward').disabled = true;
    updateSecurityIcon('');
    updateBookmarkStar('');
    return;
  }
  addressBar.value = friendlyUrl(tab.url);
  $('btn-back').disabled    = !tab.canGoBack;
  $('btn-forward').disabled = !tab.canGoForward;
  updateSecurityIcon(tab.url);
  updateBookmarkStar(tab.url);
}

function updateZoomLabel(factor) {
  state.zoomFactor = factor;
  zoomLabel.textContent = `${Math.round(factor * 100)}%`;
}

function updateSecurityIcon(url) {
  if (!url || url.startsWith('file://') || url.startsWith('data:')) {
    securityIcon.textContent = '📄'; securityIcon.title = 'Internal page';
  } else if (url.startsWith('https://')) {
    securityIcon.textContent = '🔒'; securityIcon.title = 'Secure (HTTPS)';
  } else {
    securityIcon.textContent = '⚠️'; securityIcon.title = 'Not secure';
  }
}

function updateBookmarkStar(url) {
  const bookmarked = url && state.bookmarks.some(b => b.url === url);
  bookmarkStar.classList.toggle('bookmarked', Boolean(bookmarked));
  bookmarkStar.textContent = bookmarked ? '★' : '☆';
  bookmarkStar.title = bookmarked ? 'Remove bookmark' : 'Bookmark this page';
}

// ═══════════════════════════════════════════════════════════════════════════
// NAVIGATION CONTROLS
// ═══════════════════════════════════════════════════════════════════════════
$('btn-new-tab').addEventListener('click', () => openNewTab('dingo://newtab'));

$('btn-back').addEventListener('click', () => {
  if (state.activeTabId !== null) d.invoke('nav:back', { tabId: state.activeTabId });
});
$('btn-forward').addEventListener('click', () => {
  if (state.activeTabId !== null) d.invoke('nav:forward', { tabId: state.activeTabId });
});
$('btn-reload').addEventListener('click', () => {
  if (state.activeTabId === null) return;
  const tab = state.tabs.get(state.activeTabId);
  if (tab?.loading) d.invoke('nav:stop',   { tabId: state.activeTabId });
  else              d.invoke('nav:reload', { tabId: state.activeTabId, ignoreCache: false });
});

addressBar.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const input = addressBar.value.trim();
    if (!input) return;
    if (state.activeTabId !== null) d.invoke('nav:go', { tabId: state.activeTabId, url: input });
    else openNewTab(input);
    addressBar.blur();
  }
  if (e.key === 'Escape') addressBar.blur();
});
addressBar.addEventListener('focus', () => addressBar.select());

// Bookmark star
bookmarkStar.addEventListener('click', async () => {
  const tab = state.tabs.get(state.activeTabId);
  if (!tab) return;
  const { url } = tab;
  const bookmarked = state.bookmarks.some(b => b.url === url);
  if (bookmarked) state.bookmarks = await d.invoke('bookmarks:remove', { url });
  else            state.bookmarks = await d.invoke('bookmarks:add', { url, title: tab.title, favicon: tab.favicon });
  updateBookmarkStar(url);
  renderBookmarks();
});

// Zoom
$('btn-zoom-in').addEventListener('click', async () => {
  if (state.activeTabId === null) return;
  const f = Math.min(3, state.zoomFactor + 0.1);
  await d.invoke('zoom:set', { tabId: state.activeTabId, factor: f });
  updateZoomLabel(f);
});
$('btn-zoom-out').addEventListener('click', async () => {
  if (state.activeTabId === null) return;
  const f = Math.max(0.25, state.zoomFactor - 0.1);
  await d.invoke('zoom:set', { tabId: state.activeTabId, factor: f });
  updateZoomLabel(f);
});
zoomLabel.addEventListener('dblclick', async () => {
  if (state.activeTabId === null) return;
  await d.invoke('zoom:set', { tabId: state.activeTabId, factor: 1 });
  updateZoomLabel(1);
});

// DevTools
$('btn-devtools').addEventListener('click', () => {
  if (state.activeTabId !== null) d.invoke('devtools:toggle', { tabId: state.activeTabId });
});

// ═══════════════════════════════════════════════════════════════════════════
// SIDEBAR FOOTER BUTTONS
// ═══════════════════════════════════════════════════════════════════════════
$('btn-history').addEventListener('click',          () => openNewTab('dingo://history'));
$('btn-downloads').addEventListener('click',        () => openNewTab('dingo://downloads'));
$('btn-settings').addEventListener('click',         () => openNewTab('dingo://settings'));
$('btn-manage-bookmarks').addEventListener('click', () => openNewTab('dingo://bookmarks'));
$('btn-clear-closed').addEventListener('click', () => {
  for (const [id, tab] of state.tabs) { if (!tab.alive) state.tabs.delete(id); }
  renderSidebar();
});

// ═══════════════════════════════════════════════════════════════════════════
// FIND IN PAGE
// ═══════════════════════════════════════════════════════════════════════════
function openFind() {
  state.findOpen = true;
  findBar.classList.remove('hidden');
  findInput.focus();
  findInput.select();
}
function closeFind() {
  state.findOpen = false;
  findBar.classList.add('hidden');
  findStatus.textContent = '';
  if (state.activeTabId !== null) d.invoke('find:stop', { tabId: state.activeTabId });
}
function doFind(forward = true) {
  const text = findInput.value.trim();
  if (!text || state.activeTabId === null) return;
  d.invoke('find:start', { tabId: state.activeTabId, text, options: { forward, findNext: true } });
}

findInput.addEventListener('input',   () => doFind(true));
findInput.addEventListener('keydown', e => {
  if (e.key === 'Enter')  doFind(!e.shiftKey);
  if (e.key === 'Escape') closeFind();
});
$('find-next').addEventListener('click',  () => doFind(true));
$('find-prev').addEventListener('click',  () => doFind(false));
$('find-close').addEventListener('click', closeFind);

// ═══════════════════════════════════════════════════════════════════════════
// DOWNLOAD TRAY
// ═══════════════════════════════════════════════════════════════════════════
$('btn-close-tray').addEventListener('click', () => downloadTray.classList.add('hidden'));

const downloadItems = new Map();

function showDownloadTray() { downloadTray.classList.remove('hidden'); }

function updateDownloadItem(id, data) {
  let item = downloadItems.get(id);
  if (!item) {
    item = el('li', { className: 'dl-item' });
    const bar     = el('div', { className: 'dl-progress-bar' }, el('div', { className: 'dl-progress-fill' }));
    item._fill    = bar.firstChild;
    item._state   = el('span', { className: 'dl-state', textContent: 'downloading' });
    item._nameEl  = el('span', { className: 'dl-filename', textContent: data.filename || '…' });
    item.append(item._nameEl, bar, item._state);
    downloadList.prepend(item);
    downloadItems.set(id, item);
  }
  if (data.totalBytes > 0) {
    const pct = Math.round((data.receivedBytes / data.totalBytes) * 100);
    item._fill.style.width = `${pct}%`;
    item._state.textContent = `${pct}%`;
  }
  if (data.state === 'completed') {
    item._fill.style.width = '100%';
    item._state.textContent = 'done';
    item._state.className   = 'dl-state done';
    item._nameEl.style.cursor = 'pointer';
    item._nameEl.onclick = () => d.invoke('downloads:open', { savePath: data.savePath });
  } else if (data.state === 'cancelled' || data.state === 'interrupted') {
    item._state.textContent = data.state;
    item._state.className   = 'dl-state failed';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN-PROCESS EVENTS
// ═══════════════════════════════════════════════════════════════════════════
d.on('tab-created', ({ tabId, url, active }) => {
  state.tabs.set(tabId, createTabEntry(tabId, url));
  if (active) state.activeTabId = tabId;
  renderSidebar();
  if (active) updateToolbar();
});

d.on('tab-activated', ({ tabId, url, canGoBack, canGoForward }) => {
  state.activeTabId = tabId;
  const tab = state.tabs.get(tabId);
  if (tab) Object.assign(tab, { url, canGoBack, canGoForward });
  renderSidebar();
  updateToolbar();
});

d.on('tab-closed', ({ tabId }) => {
  const tab = state.tabs.get(tabId);
  if (tab) { tab.alive = false; tab.loading = false; }

  if (state.activeTabId === tabId) {
    const open = [...state.tabs.values()].filter(t => t.alive);
    if (open.length > 0) activateTab(open[open.length - 1].tabId);
    else { state.activeTabId = null; updateToolbar(); }
  }
  renderSidebar();
});

d.on('tab-loading', ({ tabId, loading }) => {
  const tab = state.tabs.get(tabId);
  if (!tab) return;
  tab.loading = loading;
  if (tabId === state.activeTabId) {
    $('btn-reload').textContent = loading ? '✕' : '↻';
    $('btn-reload').title       = loading ? 'Stop' : 'Reload (Ctrl+R)';
  }
  renderSidebar();
});

d.on('tab-navigated', ({ tabId, url, canGoBack, canGoForward }) => {
  const tab = state.tabs.get(tabId);
  if (!tab) return;
  Object.assign(tab, { url, canGoBack, canGoForward });
  if (tabId === state.activeTabId) {
    addressBar.value = friendlyUrl(url);
    $('btn-back').disabled    = !canGoBack;
    $('btn-forward').disabled = !canGoForward;
    updateSecurityIcon(url);
    updateBookmarkStar(url);
  }
  d.invoke('history:add', { url, title: tab.title });
});

d.on('tab-title', ({ tabId, title }) => {
  const tab = state.tabs.get(tabId);
  if (!tab) return;
  tab.title = title || 'New Tab';
  renderSidebar();
  if (tabId === state.activeTabId) d.invoke('history:add', { url: tab.url, title: tab.title });
});

d.on('tab-favicon', ({ tabId, favicon }) => {
  const tab = state.tabs.get(tabId);
  if (!tab) return;
  tab.favicon = favicon;
  renderSidebar();
});

d.on('close-active-tab', () => {
  if (state.activeTabId !== null) closeTabById(state.activeTabId);
});

d.on('bookmark-current', async () => {
  const tab = state.tabs.get(state.activeTabId);
  if (!tab) return;
  state.bookmarks = await d.invoke('bookmarks:add', { url: tab.url, title: tab.title, favicon: tab.favicon });
  updateBookmarkStar(tab.url);
  renderBookmarks();
});

d.on('toggle-find', () => { if (state.findOpen) closeFind(); else openFind(); });

d.on('download-started', data => { showDownloadTray(); updateDownloadItem(data.id, data); });
d.on('download-progress', data => updateDownloadItem(data.id, data));
d.on('download-done',     data => updateDownloadItem(data.id, data));

// ═══════════════════════════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════════════════════════════════════
document.addEventListener('keydown', e => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key === 't') { e.preventDefault(); openNewTab('dingo://newtab'); }
  if (ctrl && e.key === 'w') { e.preventDefault(); if (state.activeTabId !== null) closeTabById(state.activeTabId); }
  if (ctrl && e.key === 'l') { e.preventDefault(); addressBar.focus(); addressBar.select(); }
  if (ctrl && e.key === 'r') { e.preventDefault(); if (state.activeTabId !== null) d.invoke('nav:reload', { tabId: state.activeTabId, ignoreCache: e.shiftKey }); }
  if (ctrl && e.key === 'f') { e.preventDefault(); if (state.findOpen) closeFind(); else openFind(); }
  if (ctrl && e.key === 'd') { e.preventDefault(); bookmarkStar.click(); }
  if (e.key === 'F12') d.invoke('devtools:toggle', { tabId: state.activeTabId });
  if (e.key === 'Escape' && state.findOpen) closeFind();
  if (ctrl && e.key === '=') { e.preventDefault(); $('btn-zoom-in').click(); }
  if (ctrl && e.key === '-') { e.preventDefault(); $('btn-zoom-out').click(); }
  if (ctrl && e.key === '0') { e.preventDefault(); zoomLabel.dispatchEvent(new Event('dblclick')); }
  if (e.altKey && e.key === 'ArrowLeft')  { e.preventDefault(); $('btn-back').click(); }
  if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); $('btn-forward').click(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════
async function init() {
  [state.bookmarks, state.projects] = await Promise.all([
    d.invoke('bookmarks:get', {}),
    d.invoke('projects:get', {}),
  ]);
  renderSidebar();
  updateToolbar();
  updateZoomLabel(1);
}

init();
