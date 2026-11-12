#!/usr/bin/env node
/**
 * Append a fresh plain-title event to imported sessions.
 *
 * The projection cache seeds from its existing row and only applies events
 * after that row's seq, so editing an old title event in place leaves the
 * cached title stale. Appending one new `session/title` event advances the
 * fold; a following `warm` run writes the plain title to the cache.
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
let appended = 0
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
  } catch {
    skipped += 1
    continue
  }
  const header = lines[0]
  const events = []
  for (const line of lines.slice(1)) {
    try {
      events.push(JSON.parse(line))
    } catch {
      /* skip a torn line */
    }
  }
  const previous = events.filter((event) => event.type === 'session/title').at(-1)
  if (previous === undefined) {
    skipped += 1
    continue
  }
  const plain = String(previous.data?.title ?? '').replace(PREFIX, '').trim()
  if (plain.length === 0) {
    skipped += 1
    continue
  }
  const seq = events.length
  events.push({
    type: 'session/title',
    seq,
    time: Date.now(),
    data: {
      title: plain,
      messageSeqs: Array.isArray(previous.data?.messageSeqs) ? previous.data.messageSeqs : [],
      source: { kind: 'fallback' },
    },
  })
  const headerFrame = zstdCompressSync(Buffer.from(`${header}\n`, 'utf8'))
  const eventFrame = zstdCompressSync(Buffer.from(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8'))
  const temporary = `${file}.retitle`
  await writeFile(temporary, Buffer.concat([headerFrame, eventFrame]))
  await rename(temporary, file)
  appended += 1
}

console.log(`scanned ${scanned}, appended ${appended}, skipped ${skipped}, missing ${missing}`)
