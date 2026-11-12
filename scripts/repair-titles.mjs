#!/usr/bin/env node
/**
 * Repair the title event of sessions imported by version 1.0.0.
 *
 * DSH requires `session/title` with `source.kind = "user"` to carry an empty
 * `messageSeqs` list, while a `fallback` title cites the messages it
 * summarizes. Version 1.0.0 wrote a user source together with the first user
 * message seq, so every imported log failed replay validation. This script
 * rewrites only that field in the already persisted logs.
 *
 * Usage:
 *   node scripts/repair-titles.mjs            # rewrite
 *   node scripts/repair-titles.mjs --dry-run  # report only
 */

import { readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const here = path.dirname(fileURLToPath(import.meta.url))
const stateFile = path.join(here, '..', 'state.json')
const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions')
const dryRun = process.argv.includes('--dry-run')

const state = JSON.parse(await readFile(stateFile, 'utf8'))
const ids = new Set(Object.keys(state.sessions ?? {}))

/** Find the persisted log for one session id. */
function findLog(sessionId) {
  if (!existsSync(sessionsRoot)) return null
  for (const directory of readdirSyncSafe(sessionsRoot)) {
    const candidate = path.join(sessionsRoot, directory, sessionId, 'session.v4.jsonl.zstd')
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** `readdirSync` without a throw for a transient directory. */
function readdirSyncSafe(directory) {
  try {
    return readdirSync(directory)
  } catch {
    return []
  }
}

let scanned = 0
let repaired = 0
let missing = 0
let skipped = 0

for (const id of ids) {
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
  let changed = false
  const next = lines.map((line) => {
    let value
    try {
      value = JSON.parse(line)
    } catch {
      return line
    }
    if (
      value.type === 'session/title' &&
      value.data?.source?.kind === 'user' &&
      Array.isArray(value.data.messageSeqs) &&
      value.data.messageSeqs.length > 0
    ) {
      value.data.source = { kind: 'fallback' }
      changed = true
      return JSON.stringify(value)
    }
    return line
  })
  if (!changed) {
    skipped += 1
    continue
  }
  repaired += 1
  if (dryRun) {
    console.log(`would repair ${id}`)
    continue
  }
  const body = `${next.join('\n')}\n`
  const temporary = `${file}.repairing`
  await writeFile(temporary, zstdCompressSync(Buffer.from(body, 'utf8')))
  await rename(temporary, file)
  console.log(`repaired ${id}`)
}

console.log(
  `${dryRun ? 'dry run: ' : ''}scanned ${scanned}, repaired ${repaired}, already-fine ${skipped}, missing ${missing}`,
)
