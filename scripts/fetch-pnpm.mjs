/**
 * Download the pnpm package tree for the engine installer into `runtime/pnpm`,
 * verified against the npm registry. The build packages it via electron-builder
 * extraResources; the packaged app runs it with the bundled node
 * (`node <pnpm>/bin/pnpm.cjs`).
 *
 * Usage: node scripts/fetch-pnpm.mjs [--force]
 * @module fetch-pnpm
 */

import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync, rmSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME_DIR = join(ROOT, 'runtime')
const PNPM_DIR = join(RUNTIME_DIR, 'pnpm')
const PINNED_VERSION = '11.7.0'
const REGISTRIES = [
  'https://registry.npmmirror.com/pnpm',
  'https://registry.npmjs.org/pnpm',
]
const FETCH_TIMEOUT_MS = 30000

async function fetchJson(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

async function downloadTo(url, destination) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok || res.body === null) throw new Error(`GET ${url} -> ${res.status}`)
    const hash = createHash('sha512')
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
    return hash.digest('base64')
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const version = process.argv.includes('--version') ? undefined : PINNED_VERSION
  const force = process.argv.includes('--force')
  if (!force && existsSync(join(PNPM_DIR, 'bin', 'pnpm.cjs'))) {
    console.log('fetch-pnpm: pnpm already present (use --force to re-download)')
    return
  }

  let manifest
  let tarballUrl
  let sha512
  let lastError
  for (const endpoint of REGISTRIES) {
    try {
      manifest = await fetchJson(`${endpoint}/${version ?? 'latest'}`)
      tarballUrl = manifest.dist?.tarball
      sha512 = manifest.dist?.integrity
      if (tarballUrl === undefined) throw new Error(`no tarball in ${endpoint} metadata`)
      break
    } catch (error) {
      lastError = error
    }
  }
  if (manifest === undefined) {
    console.error(`fetch-pnpm: no registry reachable: ${String(lastError)}`)
    process.exit(1)
  }

  console.log(`fetch-pnpm: downloading ${tarballUrl}`)
  mkdirSync(RUNTIME_DIR, { recursive: true })
  const archive = join(RUNTIME_DIR, 'pnpm.tgz')
  rmSync(archive, { force: true })
  const actual = await downloadTo(tarballUrl, archive)
  if (sha512 !== undefined && !sha512.includes(actual)) {
    console.error('fetch-pnpm: checksum mismatch')
    process.exit(1)
  }

  const extractDir = join(RUNTIME_DIR, 'pnpm-extract')
  rmSync(extractDir, { recursive: true, force: true })
  mkdirSync(extractDir)
  extractTar(gunzipSync(readFileSync(archive)), extractDir)

  rmSync(PNPM_DIR, { recursive: true, force: true })
  renameSync(join(extractDir, 'package'), PNPM_DIR)
  rmSync(extractDir, { recursive: true, force: true })
  rmSync(archive, { force: true })
  writeFileSync(join(PNPM_DIR, '.version'), manifest.version ?? PINNED_VERSION)
  console.log(`fetch-pnpm: installed pnpm ${manifest.version ?? PINNED_VERSION}`)
}

/**
 * Extract a ustar tar stream (npm pack output) without shelling out to `tar`,
 * which on Git Bash misparses `C:\...` paths as a remote host. Only regular
 * files and directories are expected; other entry types are skipped.
 * @param {Buffer} data - the decompressed tar bytes.
 * @param {string} dest - extraction root directory.
 */
function extractTar(data, dest) {
  let offset = 0
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const size = Number.parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8)
    const type = String.fromCharCode(header[156])
    const path = prefix.length > 0 ? `${prefix}/${name}` : name
    offset += 512
    const dataStart = offset
    offset += size + ((512 - (size % 512)) % 512)
    if (type === '0' || type === '\0') {
      const outPath = join(dest, path)
      mkdirSync(dirname(outPath), { recursive: true })
      writeFileSync(outPath, data.subarray(dataStart, dataStart + size))
    } else if (type === '5') {
      mkdirSync(join(dest, path), { recursive: true })
    }
  }
}

try {
  await main()
} catch (error) {
  console.error(`fetch-pnpm: ${error.message ?? error}`)
  process.exit(1)
}
