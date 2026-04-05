'use strict';

/**
 * preload.js — runs in the main chrome renderer (index.html).
 * Exposes a safe, minimal IPC surface via contextBridge.
 */

const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_RECEIVE = new Set([
  'tab-created', 'tab-activated', 'tab-closed',
  'tab-loading', 'tab-navigated', 'tab-title', 'tab-favicon',
  'download-started', 'download-progress', 'download-done',
  'close-active-tab', 'bookmark-current', 'toggle-find',
]);

const ALLOWED_INVOKE = new Set([
  'win:minimize', 'win:maximize', 'win:close',
  'tab:create', 'tab:activate', 'tab:close', 'tab:screenshot',
  'nav:go', 'nav:back', 'nav:forward', 'nav:reload', 'nav:stop',
  'find:start', 'find:stop',
  'zoom:set', 'zoom:get',
  'store:get', 'store:set',
  'history:get', 'history:clear',
  'history:add',
  'bookmarks:get', 'bookmarks:add', 'bookmarks:remove',
  'projects:get', 'projects:save',
  'downloads:get', 'downloads:cancel', 'downloads:open', 'downloads:show',
  'shell:openExternal',
  'theme:get', 'theme:set',
  'devtools:toggle',
]);

contextBridge.exposeInMainWorld('dingo', {
  invoke(channel, args = {}) {
    if (!ALLOWED_INVOKE.has(channel)) throw new Error(`dingo.invoke: "${channel}" not allowed`);
    return ipcRenderer.invoke(channel, args);
  },

  on(channel, listener) {
    if (!ALLOWED_RECEIVE.has(channel)) throw new Error(`dingo.on: "${channel}" not allowed`);
    const wrapper = (_event, data) => listener(data);
    ipcRenderer.on(channel, wrapper);
    return () => ipcRenderer.removeListener(channel, wrapper);
  },

  once(channel, listener) {
    if (!ALLOWED_RECEIVE.has(channel)) throw new Error(`dingo.once: "${channel}" not allowed`);
    ipcRenderer.once(channel, (_event, data) => listener(data));
  },
});
