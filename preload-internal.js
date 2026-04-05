'use strict';

/**
 * preload-internal.js
 *
 * Preload for Dingo's own internal pages (newtab, settings, bookmarks,
 * history, downloads). These are local file:// pages that need access to
 * persisted data (history, bookmarks, settings, downloads, projects) but
 * should NOT have access to tab navigation controls or window chrome APIs.
 *
 * External web pages use preload-web.js (which exposes nothing).
 */

const { contextBridge, ipcRenderer } = require('electron');

// Channels internal pages are permitted to call
const ALLOWED_INVOKE = new Set([
  'store:get',
  'store:set',
  'history:get',
  'history:add',
  'history:clear',
  'bookmarks:get',
  'bookmarks:add',
  'bookmarks:remove',
  'downloads:get',
  'downloads:open',
  'downloads:show',
  'projects:get',
  'projects:save',
  'tab:create',
  'shell:openExternal',
]);

contextBridge.exposeInMainWorld('dingo', {
  invoke(channel, args = {}) {
    if (!ALLOWED_INVOKE.has(channel)) {
      throw new Error(`dingo.invoke (internal): "${channel}" not allowed`);
    }
    return ipcRenderer.invoke(channel, args);
  },
});
