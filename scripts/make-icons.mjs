/**
 * Generate build/icon.ico (multi-size) + build/icon.png from a source PNG.
 * Used to refresh the app icon from an artwork PNG (e.g. dist/ico.png).
 * @param {string} source - path to the source PNG.
 */
import sharp from 'sharp'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const source = process.argv[2]
if (!source) {
  console.error('usage: node scripts/make-icons.mjs <source.png>')
  process.exit(1)
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const build = path.join(root, 'build')

const sizes = [256, 128, 64, 48, 32, 16]
const pngs = []
for (const size of sizes) {
  pngs.push(await sharp(source).resize(size, size, { fit: 'fill' }).png().toBuffer())
}

const { default: pngToIco } = await import('png-to-ico')
const ico = await pngToIco(pngs)
fs.writeFileSync(path.join(build, 'icon.ico'), ico)
// mac packaging (icns source) requires icon.png to be at least 512x512.
const icon512 = await sharp(source).resize(512, 512, { fit: 'fill' }).png().toBuffer()
fs.writeFileSync(path.join(build, 'icon.png'), icon512)
console.log(`wrote build/icon.ico (${ico.length} bytes, ${sizes.length} sizes) and build/icon.png (512x512, ${icon512.length} bytes)`)