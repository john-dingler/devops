'use strict';

/**
 * preload-web.js — runs in every BrowserView (sandboxed web content).
 * Intentionally minimal: web pages must NOT have access to the helios API.
 */

// No contextBridge exposure needed here.
// Web pages run in a fully sandboxed Chromium renderer.
