// notarize.js — runs automatically after electron-builder signs the app
// Submits the signed .app to Apple's notarization service via notarytool.
//
// Required env vars (set these before running npm run build:mac):
//   APPLE_ID                    — your Apple developer account email
//   APPLE_APP_SPECIFIC_PASSWORD — app-specific password from appleid.apple.com
//
// Team ID is hardcoded since it never changes.

const { notarize } = require('@electron/notarize')

exports.default = async function notarizing(context) {
  // Only run on macOS builds
  if (context.electronPlatformName !== 'darwin') return

  const appName = context.packager.appInfo.productFilename
  const appPath = `${context.appOutDir}/${appName}.app`

  if (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD) {
    console.warn('⚠️  Skipping notarization — APPLE_ID or APPLE_APP_SPECIFIC_PASSWORD not set.')
    return
  }

  console.log(`\n🔏 Notarizing ${appName}... (this takes 1–3 minutes)\n`)

  await notarize({
    tool:           'notarytool',
    appBundleId:    'com.lobi.app',
    appPath,
    appleId:        process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId:         'UWMZP3Q26H',
  })

  console.log(`✅ Notarization complete.\n`)
}
