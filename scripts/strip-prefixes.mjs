#!/usr/bin/env node
/**
 * Remove the `[Claude Code] ` / `[MiniMax Code] ` title prefixes written by the
 * previous build. The origin now lives in the row logo instead.
 *
 * Usage:
 *   node scripts/strip-prefixes.mjs
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
const PREFIX = /^\[(Claude Code|MiniMax Code|DSH)\] /u
const state = JSON.parse(await readFile(stateFile, 'utf8'))

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
let stripped = 0
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
  let changed = false
  const next = lines.map((line) => {
    let value
    try {
      value = JSON.parse(line)
    } catch {
      return line
    }
    if (value.type !== 'session/title') return line
    const current = String(value.data?.title ?? '')
    if (!PREFIX.test(current)) return line
    value.data = { ...value.data, title: current.replace(PREFIX, '').trim() }
    changed = true
    return JSON.stringify(value)
  })
  if (!changed) {
    skipped += 1
    continue
  }
  stripped += 1
  if (lines.length === 0 || !lines[0].startsWith('{"type":"session"')) {
    console.warn(`skip ${id}: first line is not a session header`)
    skipped += 1
    continue
  }
  const headerFrame = zstdCompressSync(Buffer.from(`${lines[0]}\n`, 'utf8'))
  const eventFrame = zstdCompressSync(Buffer.from(`${next.slice(1).join('\n')}\n`, 'utf8'))
  const temporary = `${file}.stripping`
  await writeFile(temporary, Buffer.concat([headerFrame, eventFrame]))
  await rename(temporary, file)
}

console.log(`scanned ${scanned}, stripped ${stripped}, already-plain ${skipped}, missing ${missing}`)
