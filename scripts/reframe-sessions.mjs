#!/usr/bin/env node
/**
 * Rebuild the Zstandard frame layout of sessions imported by version 1.0.0.
 *
 * DSH stores a session log as a sequence of independently decodable Zstandard
 * frames: the first frame must contain exactly the header line, and later
 * frames carry JSONL event batches. The title repair tool recompressed the
 * whole log into one frame, which the reader rejects. This script splits the
 * decoded log back into the required two-frame layout.
 *
 * Usage:
 *   node scripts/reframe-sessions.mjs
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const here = path.dirname(fileURLToPath(import.meta.url))
const stateFile = path.join(here, '..', 'state.json')
const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions')
const state = JSON.parse(await readFile(stateFile, 'utf8'))

/** Find the persisted log for one session id. */
function findLog(sessionId) {
  if (!existsSync(sessionsRoot)) return null
  for (const directory of readdirSyncSafe(sessionsRoot)) {
    const candidate = path.join(sessionsRoot, directory, sessionId, 'session.v4.jsonl.zstd')
    if (existsSync(candidate)) return candidate
  }
  return null
}

function readdirSyncSafe(directory) {
  try {
    return readdirSync(directory)
  } catch {
    return []
  }
}

let scanned = 0
let rewritten = 0
let skipped = 0
let missing = 0

for (const id of Object.keys(state.sessions ?? {})) {
  const file = findLog(id)
  if (file === null) {
    missing += 1
    continue
  }
  scanned += 1
  let lines
  try {
    lines = zstdDecompressSync(await readFile(file)).toString('utf8').split('\n').filter(Boolean)
  } catch (error) {
    console.warn(`skip ${id}: cannot decompress (${error instanceof Error ? error.message : String(error)})`)
    skipped += 1
    continue
  }
  if (lines.length === 0 || !lines[0].startsWith('{"type":"session"')) {
    console.warn(`skip ${id}: first line is not a session header`)
    skipped += 1
    continue
  }
  const headerFrame = zstdCompressSync(Buffer.from(`${lines[0]}\n`, 'utf8'))
  const eventFrame = zstdCompressSync(Buffer.from(`${lines.slice(1).join('\n')}\n`, 'utf8'))
  const temporary = `${file}.reframing`
  await writeFile(temporary, Buffer.concat([headerFrame, eventFrame]))
  await rename(temporary, file)
  rewritten += 1
}

console.log(`scanned ${scanned}, reframed ${rewritten}, skipped ${skipped}, missing ${missing}`)
