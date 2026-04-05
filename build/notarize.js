'use strict';

/**
 * build/notarize.js
 *
 * Optional post-sign notarization hook for electron-builder.
 * Only runs when APPLE_ID and APPLE_APP_SPECIFIC_PASSWORD env vars are set.
 *
 * Setup:
 *   1. Install: npm install --save-dev @electron/notarize
 *   2. Set env vars (e.g. in your CI secrets or .env.local — never commit):
 *       APPLE_ID=you@example.com
 *       APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx  (app-specific password)
 *       APPLE_TEAM_ID=XXXXXXXXXX
 *   3. Add to package.json build config:
 *       "afterSign": "build/notarize.js"
 *
 * Without these env vars this hook is a no-op, so unsigned dev builds work fine.
 */

const { notarize } = (() => {
  try { return require('@electron/notarize'); }
  catch { return { notarize: null }; }
})();

module.exports = async function afterSign(context) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== 'darwin') return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD) {
    console.log('Notarization skipped (APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD not set).');
    return;
  }

  if (!notarize) {
    console.warn('Notarization skipped (@electron/notarize not installed). ' +
                 'Run: npm install --save-dev @electron/notarize');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;
  console.log(`Notarizing ${appPath}…`);

  await notarize({
    tool: 'notarytool',
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });

  console.log(`Notarization complete: ${appPath}`);
};
