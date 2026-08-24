/**
 * Download the Node.js portable runtime (latest v24.x) for the current
 * platform into `runtime/`, verified against SHASUMS256.txt. The build
 * packages it via electron-builder extraResources; dev mode falls back to it
 * when present, else to the system `node`.
 *
 * Usage: node scripts/fetch-node.mjs [--force]
 * @module fetch-node
 */

import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync, rmSync, readFileSync, renameSync, existsSync, openSync } from 'node:fs'
import { join, dirname, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import yauzl from 'yauzl'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME_DIR = join(ROOT, 'runtime')
const NODE_MAJOR = 24
const FETCH_TIMEOUT_MS = 30000
// Official dist first; npmmirror's binary mirror serves the same files and is
// reachable where nodejs.org is slow or blocked.
const DIST_BASES = [
  'https://nodejs.org/dist',
  'https://registry.npmmirror.com/-/binary/node',
]

const PLATFORM_ARCHIVE = {
  win32: { match: /^node-v[0-9.]+-win-x64\.zip$/ },
  linux: { match: /^node-v[0-9.]+-linux-x64\.tar\.gz$/ },
  // Node publishes darwin-arm64 and darwin-x64 (no universal tarball); pick
  // the build machine's arch and accept the packaged app is per-arch on macOS.
  darwin: { match: new RegExp(`^node-v[0-9.]+-darwin-${process.arch}\\.tar\\.gz$`) },
}[process.platform]

if (PLATFORM_ARCHIVE === undefined) {
  console.error(`fetch-node: unsupported platform ${process.platform}`)
  process.exit(1)
}

const marker = join(RUNTIME_DIR, '.node-version')
const force = process.argv.includes('--force')

function runtimeNodeDir() {
  return join(RUNTIME_DIR, 'node')
}

function runtimeNodeEntry() {
  return process.platform === 'win32'
    ? join(runtimeNodeDir(), 'node.exe')
    : join(runtimeNodeDir(), 'bin', 'node')
}

async function downloadTo(url, destination) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok || res.body === null) throw new Error(`GET ${url} -> ${res.status}`)
    const hash = createHash('sha256')
    const out = createWriteStream(destination)
    for await (const chunk of res.body) {
      hash.update(chunk)
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve))
    }
    out.end()
    await new Promise((resolve, reject) => {
      out.on('finish', resolve)
      out.on('error', reject)
    })
    return hash.digest('hex')
  } finally {
    clearTimeout(timer)
  }
}

async function fetchText(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  let sumsText
  let base
  for (const candidate of DIST_BASES) {
    try {
      sumsText = await fetchText(`${candidate}/latest-v${NODE_MAJOR}.x/SHASUMS256.txt`)
      base = candidate
      break
    } catch {
      // try the next mirror
    }
  }
  if (sumsText === undefined) {
    console.error('fetch-node: all mirrors unreachable')
    process.exit(1)
  }
  const line = sumsText.split('\n').map((l) => l.trim())
    .find((l) => {
      const name = l.split(/\s+/)[1]
      return name !== undefined && PLATFORM_ARCHIVE.match.test(name)
    })
  if (line === undefined) {
    console.error('fetch-node: no matching archive in SHASUMS256.txt')
    process.exit(1)
  }
  const [sum, filename] = line.split(/\s+/).slice(0, 2)
  const url = `${base}/latest-v${NODE_MAJOR}.x/${filename}`

  if (!force && existsSync(marker) && readFileSync(marker, 'utf8').trim() === filename
    && existsSync(runtimeNodeEntry())) {
    console.log(`fetch-node: ${filename} already present (use --force to re-download)`)
    return
  }

  console.log(`fetch-node: downloading ${url}`)
  mkdirSync(RUNTIME_DIR, { recursive: true })
  const archive = join(RUNTIME_DIR, filename)
  rmSync(archive, { force: true })
  const actual = await downloadTo(url, archive)
  if (actual !== sum) {
    console.error(`fetch-node: checksum mismatch for ${filename}`)
    process.exit(1)
  }

  const extractDir = join(RUNTIME_DIR, filename.replace(/\.(zip|tar\.gz)$/, ''))
  rmSync(extractDir, { recursive: true, force: true })
  if (process.platform === 'win32') {
    // Use a pure-JS zip reader so extraction does not depend on Windows
    // `tar` resolving symlinks or long paths inside the Node zip (which
    // can surface as `Cannot connect to E: resolve failed` on some hosts).
    await extractZip(archive, RUNTIME_DIR)
  } else {
    execFileSync('tar', ['-xf', archive, '-C', RUNTIME_DIR], { stdio: 'inherit' })
  }

  rmSync(runtimeNodeDir(), { recursive: true, force: true })
  renameSync(extractDir, runtimeNodeDir())
  rmSync(archive, { force: true })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(marker, filename)
  console.log(`fetch-node: installed ${filename}`)
}

/**
 * Stream-extract a zip archive into `dest`. Skips directory entries and
 * rejects paths that escape `dest` (zip-slip guard).
 * @param {string} zipPath
 * @param {string} dest
 * @returns {Promise<void>}
 */
function extractZip(zipPath, dest) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError) {
        reject(openError)
        return
      }
      zipFile.on('error', reject)
      zipFile.on('end', () => resolve())
      zipFile.readEntry()
      zipFile.on('entry', (entry) => {
        const name = entry.fileName.replace(/\\/g, '/')
        if (name.endsWith('/')) {
          zipFile.readEntry()
          return
        }
        const target = join(dest, name)
        const resolved = posix.normalize('/' + name)
        if (resolved.startsWith('/..') || resolved.includes('/../')) {
          reject(new Error(`unsafe entry path: ${name}`))
          return
        }
        mkdirSync(dirname(target), { recursive: true })
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError) {
            reject(streamError)
            return
          }
          stream.on('error', reject)
          const out = createWriteStream(target)
          stream.pipe(out)
          out.on('error', reject)
          out.on('finish', () => zipFile.readEntry())
        })
      })
    })
  })
}

try {
  await main()
} catch (error) {
  console.error(`fetch-node: ${error.message ?? error}`)
  process.exit(1)
}