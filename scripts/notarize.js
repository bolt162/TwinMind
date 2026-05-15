/**
 * scripts/notarize.js — electron-builder `afterSign` hook for macOS.
 *
 * Submits the freshly-signed .app to Apple's notarization service so the
 * resulting DMG opens cleanly on any Mac without Gatekeeper warnings AND
 * — the reason we care most — so the code signature stays stable across
 * builds. A stable signature is what keeps Keychain ACLs valid across
 * releases, which is what makes `safeStorage` never prompt the user again
 * after the first install.
 *
 * Requires three env vars set before `npm run build:mac`:
 *
 *   APPLE_ID=<your apple id email>
 *   APPLE_APP_SPECIFIC_PASSWORD=<xxxx-xxxx-xxxx-xxxx>
 *   APPLE_TEAM_ID=<10-char team id, e.g. QKPF5K259N>
 *
 * If any of these are missing, we skip notarization silently and warn —
 * this lets `npm run build:mac` still work for quick local-only testing
 * without your client-distributable cert + credentials.
 *
 * Reference: https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution
 */

const path = require('node:path');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.warn(
      '[notarize] Skipping — set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and ' +
        'APPLE_TEAM_ID to notarize this build. The resulting DMG will install ' +
        'on your dev Mac but will trip Gatekeeper on a clean client machine.',
    );
    return;
  }

  // Lazy-require so a missing dep doesn't break non-mac builds.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { notarize } = require('@electron/notarize');

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  console.log(`[notarize] Submitting ${appName}.app to Apple notarization service…`);
  console.log('[notarize] This typically takes 1–5 minutes; do not interrupt.');

  await notarize({
    tool: 'notarytool',
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });

  console.log(`[notarize] ${appName}.app accepted by Apple — stapling ticket.`);
};
