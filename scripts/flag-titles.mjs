#!/usr/bin/env node
/**
 * Put the origin flag in the title of every already-imported session.
 *
 * A title prefix survives everywhere a session is listed, searched, exported,
 * or copied, and it costs the renderer nothing. It replaces the per-row badge
 * from the first build, which made the sidebar unstable.
 *
 * Usage:
 *   node scripts/flag-titles.mjs            # rewrite
 *   node scripts/flag-titles.mjs --dry-run  # report only
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
const dryRun = process.argv.includes('--dry-run')
const state = JSON.parse(await readFile(stateFile, 'utf8'))
const LABELS = { 'claude-code': 'Claude Code', 'minimax-code': 'MiniMax Code', dsh: 'DSH' }
const PREFIX = /^\[(Claude Code|MiniMax Code|DSH)\] /u

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
let updated = 0
let skipped = 0
let missing = 0

for (const [id, record] of Object.entries(state.sessions ?? {})) {
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
    if (value.type !== 'session/title') return line
    const base = String(value.data?.title ?? '').replace(PREFIX, '').trim()
    const label = LABELS[record.source] ?? 'Imported'
    const title = base.length > 0 ? `[${label}] ${base}` : `[${label}] Imported session`
    if (value.data?.title === title && value.data?.source?.kind === 'fallback') return line
    value.data = { ...value.data, title, source: { kind: 'fallback' } }
    changed = true
    return JSON.stringify(value)
  })
  if (!changed) {
    skipped += 1
    continue
  }
  updated += 1
  if (dryRun) {
    console.log(`would flag ${id}`)
    continue
  }
  if (lines.length === 0 || !lines[0].startsWith('{"type":"session"')) {
    console.warn(`skip ${id}: first line is not a session header`)
    skipped += 1
    continue
  }
  const headerFrame = zstdCompressSync(Buffer.from(`${lines[0]}\n`, 'utf8'))
  const eventFrame = zstdCompressSync(Buffer.from(`${next.slice(1).join('\n')}\n`, 'utf8'))
  const temporary = `${file}.flagging`
  await writeFile(temporary, Buffer.concat([headerFrame, eventFrame]))
  await rename(temporary, file)
}

console.log(`${dryRun ? 'dry run: ' : ''}scanned ${scanned}, flagged ${updated}, already-fine ${skipped}, missing ${missing}`)
