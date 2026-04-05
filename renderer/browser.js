'use strict';

/**
 * browser.js — Renderer-process logic for the main chrome UI.
 *
 * Architecture:
 *   - All state lives in `state` object.
 *   - `tabs` is a Map<tabId, TabEntry> that persists across open/close.
 *   - Closing a tab destroys the BrowserView (main process) but keeps the
 *     TabEntry in `state.tabs` with `alive = false` so it appears in the
 *     "Recent Closed" sidebar section and can be re-opened.
 */

// ── Shorthand ──────────────────────────────────────────────────────────────
const h  = window.helios;  // IPC bridge exposed by preload.js
const $  = id => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return node;
};

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  /** @type {Map<number, TabEntry>} */
  tabs: new Map(),
  activeTabId: null,
  bookmarks: [],
  zoomFactor: 1,
  findOpen: false,
};

/**
 * @typedef {{ tabId: number, title: string, url: string, favicon: string|null,
 *             loading: boolean, alive: boolean,
 *             canGoBack: boolean, canGoForward: boolean }} TabEntry
 */

// ── DOM refs ───────────────────────────────────────────────────────────────
const openTabsList    = $('open-tabs-list');
const closedTabsList  = $('closed-tabs-list');
const closedSection   = $('closed-section');
const bookmarksList   = $('bookmarks-list');
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

// ──────────────────────────────────────────────────────────────────────────
// Window controls
// ──────────────────────────────────────────────────────────────────────────
$('btn-minimize').addEventListener('click', () => h.invoke('win:minimize'));
$('btn-maximize').addEventListener('click', () => h.invoke('win:maximize'));
$('btn-close').addEventListener('click',    () => h.invoke('win:close'));

// ──────────────────────────────────────────────────────────────────────────
// Tab management helpers
// ──────────────────────────────────────────────────────────────────────────
function createTabEntry(tabId, url) {
  return {
    tabId,
    title: 'New Tab',
    url: url || '',
    favicon: null,
    loading: false,
    alive: true,
    canGoBack: false,
    canGoForward: false,
  };
}

async function openNewTab(url) {
  await h.invoke('tab:create', { url: url || 'helios://newtab', background: false });
}

async function activateTab(tabId) {
  const entry = state.tabs.get(tabId);
  if (!entry) return;

  if (!entry.alive) {
    // Re-open a closed tab
    const newId = await h.invoke('tab:create', { url: entry.url || 'helios://newtab', background: false });
    // Once created, the old entry becomes redundant; remove it
    state.tabs.delete(tabId);
    renderSidebar();
    return;
  }

  state.activeTabId = tabId;
  await h.invoke('tab:activate', { tabId });
  updateToolbar();
  renderSidebar();
}

async function closeTabById(tabId) {
  const entry = state.tabs.get(tabId);
  if (!entry) return;

  if (entry.alive) {
    await h.invoke('tab:close', { tabId });
    // alive will be set to false by the 'tab-closed' event handler
  } else {
    // Remove from closed list entirely
    state.tabs.delete(tabId);
    renderSidebar();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Sidebar rendering
// ──────────────────────────────────────────────────────────────────────────
function renderSidebar() {
  renderOpenTabs();
  renderClosedTabs();
  renderBookmarks();
}

function renderOpenTabs() {
  openTabsList.innerHTML = '';
  const openTabs = [...state.tabs.values()].filter(t => t.alive);

  if (openTabs.length === 0) {
    noTabPlaceholder.style.display = 'flex';
    return;
  }
  noTabPlaceholder.style.display = 'none';

  for (const tab of openTabs) {
    openTabsList.appendChild(buildTabItem(tab));
  }
}

function renderClosedTabs() {
  closedTabsList.innerHTML = '';
  const closedTabs = [...state.tabs.values()].filter(t => !t.alive);

  closedSection.style.display = closedTabs.length > 0 ? '' : 'none';

  for (const tab of closedTabs) {
    closedTabsList.appendChild(buildTabItem(tab));
  }
}

function renderBookmarks() {
  bookmarksList.innerHTML = '';
  for (const bm of state.bookmarks) {
    const item = el('li', { className: 'tab-item' });

    const favicon = bm.favicon
      ? el('img', { className: 'tab-favicon', src: bm.favicon, alt: '' })
      : el('span', { className: 'tab-favicon-placeholder' }, '★');
    favicon.onerror = () => { favicon.style.display = 'none'; };

    const title = el('span', { className: 'tab-title' }, bm.title || bm.url);

    const closeBtn = el('button', {
      className: 'tab-close',
      title: 'Remove bookmark',
      onClick: async e => {
        e.stopPropagation();
        state.bookmarks = await h.invoke('bookmarks:remove', { url: bm.url });
        renderBookmarks();
      },
    }, '✕');

    item.append(favicon, title, closeBtn);
    item.addEventListener('click', () => openNewTab(bm.url));
    bookmarksList.appendChild(item);
  }
}

/** Build a single tab <li> element. */
function buildTabItem(tab) {
  const isActive = tab.tabId === state.activeTabId && tab.alive;
  const item = el('li', { className: `tab-item${isActive ? ' active' : ''}${tab.alive ? '' : ' closed'}` });

  // Favicon / spinner
  let faviconEl;
  if (tab.loading && tab.alive) {
    faviconEl = el('div', { className: 'tab-spinner' });
  } else if (tab.favicon) {
    faviconEl = el('img', { className: 'tab-favicon', src: tab.favicon, alt: '' });
    faviconEl.onerror = () => { faviconEl.replaceWith(el('span', { className: 'tab-favicon-placeholder' }, '🌐')); };
  } else {
    faviconEl = el('span', { className: 'tab-favicon-placeholder' }, tab.alive ? '🌐' : '○');
  }

  const title = el('span', { className: 'tab-title' }, tab.title || 'New Tab');

  const closeBtn = el('button', {
    className: 'tab-close',
    title: tab.alive ? 'Close tab' : 'Remove from list',
    onClick: e => { e.stopPropagation(); closeTabById(tab.tabId); },
  }, '✕');

  item.append(faviconEl, title, closeBtn);

  item.addEventListener('click', () => activateTab(tab.tabId));

  return item;
}

// ──────────────────────────────────────────────────────────────────────────
// Toolbar helpers
// ──────────────────────────────────────────────────────────────────────────
function updateToolbar() {
  const tab = state.tabs.get(state.activeTabId);
  if (!tab) {
    addressBar.value = '';
    $('btn-back').disabled = true;
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
    securityIcon.textContent = '📄';
    securityIcon.title = 'Internal page';
  } else if (url.startsWith('https://')) {
    securityIcon.textContent = '🔒';
    securityIcon.title = 'Secure (HTTPS)';
  } else {
    securityIcon.textContent = '⚠️';
    securityIcon.title = 'Not secure (HTTP)';
  }
}

function updateBookmarkStar(url) {
  const isBookmarked = url && state.bookmarks.some(b => b.url === url);
  bookmarkStar.classList.toggle('bookmarked', Boolean(isBookmarked));
  bookmarkStar.textContent = isBookmarked ? '★' : '☆';
  bookmarkStar.title = isBookmarked ? 'Remove bookmark' : 'Bookmark this page';
}

function friendlyUrl(url) {
  if (!url) return '';
  // Show helios:// scheme for internal pages
  if (url.includes('renderer/newtab.html'))    return 'helios://newtab';
  if (url.includes('renderer/settings.html'))  return 'helios://settings';
  if (url.includes('renderer/bookmarks.html')) return 'helios://bookmarks';
  if (url.includes('renderer/history.html'))   return 'helios://history';
  if (url.includes('renderer/downloads.html')) return 'helios://downloads';
  return url;
}

// ──────────────────────────────────────────────────────────────────────────
// Navigation controls
// ──────────────────────────────────────────────────────────────────────────
$('btn-new-tab').addEventListener('click', () => openNewTab('helios://newtab'));

$('btn-back').addEventListener('click', () => {
  if (state.activeTabId !== null) h.invoke('nav:back', { tabId: state.activeTabId });
});

$('btn-forward').addEventListener('click', () => {
  if (state.activeTabId !== null) h.invoke('nav:forward', { tabId: state.activeTabId });
});

$('btn-reload').addEventListener('click', () => {
  if (state.activeTabId === null) return;
  const tab = state.tabs.get(state.activeTabId);
  if (tab?.loading) {
    h.invoke('nav:stop', { tabId: state.activeTabId });
  } else {
    h.invoke('nav:reload', { tabId: state.activeTabId, ignoreCache: false });
  }
});

// Address bar: navigate on Enter
addressBar.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const input = addressBar.value.trim();
    if (!input) return;
    if (state.activeTabId !== null) {
      h.invoke('nav:go', { tabId: state.activeTabId, url: input });
    } else {
      openNewTab(input);
    }
    addressBar.blur();
  }
  if (e.key === 'Escape') addressBar.blur();
});

// Select-all on focus
addressBar.addEventListener('focus', () => addressBar.select());

// Bookmark star toggle
bookmarkStar.addEventListener('click', async () => {
  const tab = state.tabs.get(state.activeTabId);
  if (!tab) return;
  const url = tab.url;
  const isBookmarked = state.bookmarks.some(b => b.url === url);
  if (isBookmarked) {
    state.bookmarks = await h.invoke('bookmarks:remove', { url });
  } else {
    state.bookmarks = await h.invoke('bookmarks:add', { url, title: tab.title, favicon: tab.favicon });
  }
  updateBookmarkStar(url);
  renderBookmarks();
});

// DevTools
$('btn-devtools').addEventListener('click', () => {
  if (state.activeTabId !== null) h.invoke('devtools:toggle', { tabId: state.activeTabId });
});

// Zoom
$('btn-zoom-in').addEventListener('click', async () => {
  if (state.activeTabId === null) return;
  const f = Math.min(3, state.zoomFactor + 0.1);
  await h.invoke('zoom:set', { tabId: state.activeTabId, factor: f });
  updateZoomLabel(f);
});
$('btn-zoom-out').addEventListener('click', async () => {
  if (state.activeTabId === null) return;
  const f = Math.max(0.25, state.zoomFactor - 0.1);
  await h.invoke('zoom:set', { tabId: state.activeTabId, factor: f });
  updateZoomLabel(f);
});
zoomLabel.addEventListener('dblclick', async () => {
  if (state.activeTabId === null) return;
  await h.invoke('zoom:set', { tabId: state.activeTabId, factor: 1 });
  updateZoomLabel(1);
});

// ──────────────────────────────────────────────────────────────────────────
// Sidebar footer buttons
// ──────────────────────────────────────────────────────────────────────────
$('btn-history').addEventListener('click',   () => openNewTab('helios://history'));
$('btn-downloads').addEventListener('click', () => openNewTab('helios://downloads'));
$('btn-settings').addEventListener('click',  () => openNewTab('helios://settings'));
$('btn-manage-bookmarks').addEventListener('click', () => openNewTab('helios://bookmarks'));
$('btn-clear-closed').addEventListener('click', () => {
  for (const [id, tab] of state.tabs) {
    if (!tab.alive) state.tabs.delete(id);
  }
  renderSidebar();
});

// ──────────────────────────────────────────────────────────────────────────
// Find in page
// ──────────────────────────────────────────────────────────────────────────
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
  if (state.activeTabId !== null) h.invoke('find:stop', { tabId: state.activeTabId });
}

function doFind(forward = true) {
  const text = findInput.value.trim();
  if (!text || state.activeTabId === null) return;
  h.invoke('find:start', { tabId: state.activeTabId, text, options: { forward, findNext: true } });
}

findInput.addEventListener('input', () => doFind(true));
findInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') doFind(!e.shiftKey);
  if (e.key === 'Escape') closeFind();
});
$('find-next').addEventListener('click',  () => doFind(true));
$('find-prev').addEventListener('click',  () => doFind(false));
$('find-close').addEventListener('click', closeFind);

// ──────────────────────────────────────────────────────────────────────────
// Download tray
// ──────────────────────────────────────────────────────────────────────────
$('btn-close-tray').addEventListener('click', () => downloadTray.classList.add('hidden'));

const downloadItems = new Map();

function showDownloadTray() {
  downloadTray.classList.remove('hidden');
}

function updateDownloadItem(id, data) {
  let item = downloadItems.get(id);
  if (!item) {
    item = el('li', { className: 'dl-item' });
    const bar = el('div', { className: 'dl-progress-bar' }, el('div', { className: 'dl-progress-fill' }));
    item._fill  = bar.firstChild;
    item._state = el('span', { className: 'dl-state' }, 'downloading');
    item._name  = el('span', { className: 'dl-filename' }, data.filename || '…');
    item.append(item._name, bar, item._state);
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
    item._state.className = 'dl-state done';
    // Make filename clickable to open
    item._name.style.cursor = 'pointer';
    item._name.onclick = () => h.invoke('downloads:open', { savePath: data.savePath });
  } else if (data.state === 'cancelled' || data.state === 'interrupted') {
    item._state.textContent = data.state;
    item._state.className = 'dl-state failed';
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Main-process event listeners
// ──────────────────────────────────────────────────────────────────────────

h.on('tab-created', ({ tabId, url, active }) => {
  state.tabs.set(tabId, createTabEntry(tabId, url));
  if (active) state.activeTabId = tabId;
  renderSidebar();
  if (active) updateToolbar();
});

h.on('tab-activated', ({ tabId, url, canGoBack, canGoForward }) => {
  state.activeTabId = tabId;
  const tab = state.tabs.get(tabId);
  if (tab) {
    tab.url = url;
    tab.canGoBack = canGoBack;
    tab.canGoForward = canGoForward;
  }
  renderSidebar();
  updateToolbar();
});

h.on('tab-closed', ({ tabId }) => {
  const tab = state.tabs.get(tabId);
  if (tab) {
    tab.alive = false;
    tab.loading = false;
  }
  // If the closed tab was active, switch to another open tab
  if (state.activeTabId === tabId) {
    const openTabs = [...state.tabs.values()].filter(t => t.alive);
    if (openTabs.length > 0) {
      activateTab(openTabs[openTabs.length - 1].tabId);
    } else {
      state.activeTabId = null;
      updateToolbar();
    }
  }
  renderSidebar();
});

h.on('tab-loading', ({ tabId, loading }) => {
  const tab = state.tabs.get(tabId);
  if (!tab) return;
  tab.loading = loading;
  // Update reload/stop button for active tab
  if (tabId === state.activeTabId) {
    $('btn-reload').textContent = loading ? '✕' : '↻';
    $('btn-reload').title = loading ? 'Stop loading' : 'Reload (Ctrl+R)';
  }
  renderSidebar();
});

h.on('tab-navigated', ({ tabId, url, canGoBack, canGoForward }) => {
  const tab = state.tabs.get(tabId);
  if (!tab) return;
  tab.url = url;
  tab.canGoBack = canGoBack;
  tab.canGoForward = canGoForward;
  if (tabId === state.activeTabId) {
    addressBar.value = friendlyUrl(url);
    $('btn-back').disabled    = !canGoBack;
    $('btn-forward').disabled = !canGoForward;
    updateSecurityIcon(url);
    updateBookmarkStar(url);
  }
  // Record history
  h.invoke('history:add', { url, title: tab.title });
});

h.on('tab-title', ({ tabId, title }) => {
  const tab = state.tabs.get(tabId);
  if (!tab) return;
  tab.title = title || 'New Tab';
  renderSidebar();
  if (tabId === state.activeTabId) {
    h.invoke('history:add', { url: tab.url, title: tab.title });
  }
});

h.on('tab-favicon', ({ tabId, favicon }) => {
  const tab = state.tabs.get(tabId);
  if (!tab) return;
  tab.favicon = favicon;
  renderSidebar();
});

h.on('close-active-tab', () => {
  if (state.activeTabId !== null) closeTabById(state.activeTabId);
});

h.on('bookmark-current', async () => {
  const tab = state.tabs.get(state.activeTabId);
  if (!tab) return;
  state.bookmarks = await h.invoke('bookmarks:add', { url: tab.url, title: tab.title, favicon: tab.favicon });
  updateBookmarkStar(tab.url);
  renderBookmarks();
});

h.on('toggle-find', () => {
  if (state.findOpen) closeFind();
  else openFind();
});

h.on('download-started', data => {
  showDownloadTray();
  updateDownloadItem(data.id, data);
});
h.on('download-progress', data => updateDownloadItem(data.id, data));
h.on('download-done',     data => updateDownloadItem(data.id, data));

// ──────────────────────────────────────────────────────────────────────────
// Keyboard shortcuts
// ──────────────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && e.key === 't') { e.preventDefault(); openNewTab('helios://newtab'); }
  if (ctrl && e.key === 'w') { e.preventDefault(); if (state.activeTabId !== null) closeTabById(state.activeTabId); }
  if (ctrl && e.key === 'l') { e.preventDefault(); addressBar.focus(); addressBar.select(); }
  if (ctrl && e.key === 'r') { e.preventDefault(); if (state.activeTabId !== null) h.invoke('nav:reload', { tabId: state.activeTabId, ignoreCache: e.shiftKey }); }
  if (ctrl && e.key === 'f') { e.preventDefault(); if (state.findOpen) closeFind(); else openFind(); }
  if (ctrl && e.key === 'd') { e.preventDefault(); bookmarkStar.click(); }
  if (e.key === 'F12') h.invoke('devtools:toggle', { tabId: state.activeTabId });
  if (e.key === 'Escape' && state.findOpen) closeFind();

  if (ctrl && e.key === '=') { e.preventDefault(); $('btn-zoom-in').click(); }
  if (ctrl && e.key === '-') { e.preventDefault(); $('btn-zoom-out').click(); }
  if (ctrl && e.key === '0') { e.preventDefault(); zoomLabel.dispatchEvent(new Event('dblclick')); }

  // Alt+Left / Alt+Right
  if (e.altKey && e.key === 'ArrowLeft')  { e.preventDefault(); $('btn-back').click(); }
  if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); $('btn-forward').click(); }
});

// ──────────────────────────────────────────────────────────────────────────
// Initialisation
// ──────────────────────────────────────────────────────────────────────────
async function init() {
  state.bookmarks = await h.invoke('bookmarks:get', {});
  renderSidebar();
  updateToolbar();
  updateZoomLabel(1);
}

init();
