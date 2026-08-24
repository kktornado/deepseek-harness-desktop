/**
 * electron-builder afterPack hook: stamp the productName exe with build/icon.ico.
 *
 * signAndEditExecutable is disabled because fetching winCodeSign fails on
 * non-elevated Windows (its archive contains mac symlinks 7za cannot create),
 * so electron-builder never edits the exe resource. rcedit edits it directly.
 * @param {{ appOutDir: string, electronPlatformName: string, packager: { appInfo: { productFilename: string } } }} context
 */
'use strict'
const path = require('node:path')

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const exe = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.exe')
  const ico = path.join(__dirname, '..', 'build', 'icon.ico')
  const { rcedit } = await import('rcedit')
  await rcedit(exe, { icon: ico })
  console.log(`after-pack: stamped icon on ${exe}`)
}