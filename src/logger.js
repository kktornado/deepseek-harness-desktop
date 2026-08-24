/**
 * File-backed logger with daily files and a size-capped rotating window.
 *
 * Writes every line to `userData/logs/dsh-desktop-YYYY-MM-DD.log`. When a
 * file exceeds `maxBytes`, it rolls like logrotate: the newest backup becomes
 * `.1`, the rest shift up (`.1` → `.2`, …), and the oldest (`maxFiles`)
 * backup is dropped — so the window keeps `maxFiles` generations of at most
 * `maxBytes` each. Rendering stays synchronous so the main process can log at
 * any point without losing tail lines on a crash.
 * @module logger
 */

const fs = require('node:fs')
const path = require('node:path')

/** Default per-file cap before rotation. */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
/** Default number of rotated generations to keep (plus the live file). */
const DEFAULT_MAX_FILES = 5

function pad2(value) {
  return String(value).padStart(2, '0')
}

function timestamp() {
  const now = new Date()
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} `
    + `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`
}

function dateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/**
 * Create a logger writing into `dir` (created on first write).
 * @param {string} dir - absolute logs directory.
 * @param {object} [options] - `maxBytes` per-file cap, `maxFiles` generations.
 * @returns {{ log: (message: string) => void, path: () => string }}
 */
function createLogger(dir, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  let currentKey = ''
  let handle = undefined
  let size = 0

  /** `dsh-desktop-<key>.log` and its `.1`..`.N` rotation backups. */
  function fileOf(key) {
    return path.join(dir, `dsh-desktop-${key}.log`)
  }
  function backupOf(key, index) {
    return path.join(dir, `dsh-desktop-${key}.log.${index}`)
  }

  function open() {
    const key = dateKey(new Date())
    if (key === currentKey && handle !== undefined) return
    if (handle !== undefined) {
      fs.closeSync(handle)
      handle = undefined
    }
    fs.mkdirSync(dir, { recursive: true })
    const file = fileOf(key)
    handle = fs.openSync(file, 'a')
    size = fs.statSync(file).size
    currentKey = key
  }

  function rotate() {
    fs.closeSync(handle)
    handle = undefined
    const key = currentKey
    // Drop the oldest backup, then shift the rest up (.1 → .2, …).
    const oldest = backupOf(key, maxFiles)
    if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true })
    for (let index = maxFiles - 1; index >= 1; index -= 1) {
      const source = backupOf(key, index)
      if (fs.existsSync(source)) fs.renameSync(source, backupOf(key, index + 1))
    }
    if (fs.existsSync(fileOf(key))) fs.renameSync(fileOf(key), backupOf(key, 1))
    size = 0
    currentKey = ''
  }

  return {
    /** Append one line with a local timestamp. */
    log(message) {
      try {
        open()
        const line = `${timestamp()}  ${String(message)}\n`
        const bytes = Buffer.byteLength(line)
        if (size + bytes > maxBytes) {
          rotate()
          open()
        }
        fs.writeSync(handle, line)
        size += bytes
      } catch {
        // Logging must never take the app down; swallow and continue.
      }
    },
    /** Absolute path of today's log file. */
    path() {
      return fileOf(dateKey(new Date()))
    },
  }
}

module.exports = { createLogger }