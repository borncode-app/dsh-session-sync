/**
 * Readers for the two external session stores.
 *
 * Each scanner returns import candidates plus a small set of non-fatal issues.
 * A candidate is deliberately plain JSON: the Host plugin turns it into
 * DSH Session events through `lib/convert.mjs`, and the smoke test can
 * exercise the scanner output without a Harness process.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * Scan Claude Code's JSONL transcript directory.
 *
 * @param {object} options
 * @param {string} options.root - `~/.claude/projects` equivalent.
 * @param {number} options.maxTextChars - per-message character budget.
 * @param {(key: string, fingerprint: string) => boolean} [options.isCurrent]
 *   returns true when this exact external revision is already imported.
 * @returns {Promise<{candidates: object[], issues: object[]}>}
 */
export async function scanClaudeCode(options) {
  const root = options.root
  const maxTextChars = options.maxTextChars
  const isCurrent = options.isCurrent ?? (() => false)
  const candidates = []
  const issues = []

  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch (error) {
    return { candidates, issues: [{ source: 'claude-code', reason: 'root-unavailable', detail: describe(error) }] }
  }

  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = path.join(root, project.name)
    let files
    try {
      files = await readdir(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue
      const filePath = path.join(projectDir, file.name)
      const sessionId = file.name.slice(0, -'.jsonl'.length)
      const externalKey = `claude-code:${sessionId}`
      let info
      try {
        info = await stat(filePath)
      } catch (error) {
        issues.push({ source: 'claude-code', externalKey, reason: 'stat-failed', detail: describe(error) })
        continue
      }
      const fingerprint = `${info.size}:${Math.floor(info.mtimeMs)}`
      if (isCurrent(externalKey, fingerprint)) {
        candidates.push({ source: 'claude-code', externalKey, fingerprint, unchanged: true })
        continue
      }

      let records
      try {
        records = parseJsonLines(await readFile(filePath, 'utf8'))
      } catch (error) {
        issues.push({ source: 'claude-code', externalKey, reason: 'read-failed', detail: describe(error) })
        continue
      }
      const analyzed = (await import('./convert.mjs')).analyzeClaudeRecords(records, { maxTextChars })
      if (analyzed.messages.length === 0) {
        issues.push({ source: 'claude-code', externalKey, reason: 'no-messages', file: filePath })
        continue
      }
      if (analyzed.cwd === undefined || analyzed.cwd.length === 0) {
        issues.push({ source: 'claude-code', externalKey, reason: 'no-working-directory', file: filePath })
        continue
      }
      candidates.push({
        source: 'claude-code',
        externalKey,
        externalId: sessionId,
        fingerprint,
        title: analyzed.title,
        cwd: analyzed.cwd,
        createdAt: analyzed.createdAt,
        messages: analyzed.messages,
        file: filePath,
      })
    }
  }

  return { candidates, issues }
}

/**
 * Scan MiniMax Code's sqlite display store.
 *
 * MiniMax Code keeps the durable session list and the display-oriented message
 * rows in `runtime-state.sqlite`; `messages.jsonl` under the dated session
 * directories is a second copy that does not carry the working directory.
 *
 * @param {object} options
 * @param {string} options.databasePath - `runtime-state.sqlite` path.
 * @param {number} options.maxTextChars - per-message character budget.
 * @param {(key: string, fingerprint: string) => boolean} [options.isCurrent]
 * @returns {Promise<{candidates: object[], issues: object[], unavailable?: boolean}>}
 */
export async function scanMinimaxCode(options) {
  const maxTextChars = options.maxTextChars
  const isCurrent = options.isCurrent ?? (() => false)
  const candidates = []
  const issues = []

  let DatabaseSync
  try {
    ({ DatabaseSync } = await import('node:sqlite'))
  } catch (error) {
    return {
      candidates,
      issues: [{ source: 'minimax-code', reason: 'sqlite-unavailable', detail: describe(error) }],
      unavailable: true,
    }
  }

  let database
  try {
    database = new DatabaseSync(options.databasePath, { readOnly: true })
  } catch (error) {
    return {
      candidates,
      issues: [{ source: 'minimax-code', reason: 'database-unavailable', detail: describe(error) }],
      unavailable: true,
    }
  }

  try {
    const sessions = database
      .prepare(
        `select session_id, title, workspace_dir, created_at_ms, updated_at_ms, extra_data_json,
                coalesce(archived, 0) as archived, coalesce(visibility, 'visible') as visibility
           from local_runtime_sessions
          order by created_at_ms asc`,
      )
      .all()
    const counts = new Map(
      database
        .prepare('select session_id, count(*) as count from local_runtime_message_rows group by session_id')
        .all()
        .map((row) => [String(row.session_id), Number(row.count)]),
    )
    const readRows = database.prepare(
      `select role, msg_id, created_at_ms, data_json, source
         from local_runtime_message_rows
        where session_id = ?
        order by id asc`,
    )

    for (const session of sessions) {
      const externalKey = `minimax-code:${session.session_id}`
      const count = counts.get(String(session.session_id)) ?? 0
      const fingerprint = `${Number(session.updated_at_ms) || 0}:${count}`
      if (count === 0) {
        issues.push({ source: 'minimax-code', externalKey, reason: 'no-messages' })
        continue
      }
      if (isCurrent(externalKey, fingerprint)) {
        candidates.push({ source: 'minimax-code', externalKey, fingerprint, unchanged: true })
        continue
      }
      const rows = readRows.all(String(session.session_id))
      const analyzed = (await import('./convert.mjs')).analyzeMinimaxRows(rows, session, { maxTextChars })
      if (analyzed.messages.length === 0) {
        issues.push({ source: 'minimax-code', externalKey, reason: 'no-conversation-messages' })
        continue
      }
      if (typeof session.workspace_dir !== 'string' || session.workspace_dir.length === 0) {
        issues.push({ source: 'minimax-code', externalKey, reason: 'no-working-directory' })
        continue
      }
      candidates.push({
        source: 'minimax-code',
        externalKey,
        externalId: String(session.session_id),
        fingerprint,
        title: analyzed.title,
        cwd: session.workspace_dir,
        createdAt: analyzed.createdAt,
        messages: analyzed.messages,
      })
    }
  } catch (error) {
    issues.push({ source: 'minimax-code', reason: 'query-failed', detail: describe(error) })
  } finally {
    try {
      database.close()
    } catch {
      /* already closed */
    }
  }

  return { candidates, issues }
}

/**
 * Whether a working directory is MiniMax's own per-session sandbox rather than
 * a project folder the user selected.
 *
 * @param {string} directory
 * @returns {boolean}
 */
export function isMinimaxSandbox(directory) {
  return /[\\/]\.minimax[\\/]sessions[\\/][^\\/]+[\\/]workspace[\\/]?$/iu.test(String(directory))
}

/**
 * Infer the project folder a MiniMax session was actually pointed at.
 *
 * MiniMax records its sandbox as `workspace_dir`; the user's real folder only
 * appears in the prompt, usually inside `<filepath>…</filepath>` or as an
 * absolute Windows path. Candidates are cut at hard boundaries, then shortened
 * from the right until an existing directory is found, so a path that runs into
 * the sentence around it (`C:\FO3TH`, and deliver …) still resolves.
 *
 * @param {readonly {text?: string}[]} messages - normalized session messages.
 * @returns {string | undefined} an existing absolute directory, when one is
 *   clearly named in the prompt.
 */
export function inferProjectDirectory(messages) {
  const tags = []
  const plain = []
  for (const message of messages ?? []) {
    const text = String(message?.text ?? '')
    for (const match of text.matchAll(/<filepath>([\s\S]*?)<\/filepath>/giu)) tags.push(match[1])
    for (const match of text.matchAll(/([A-Za-z]:[\\/])/gu)) plain.push(...chunksFrom(text, match.index ?? 0))
  }
  for (const candidate of [...tags, ...plain]) {
    const directory = usableDirectory(candidate, tags.includes(candidate))
    if (directory !== undefined) return directory
  }
  return undefined
}

/**
 * Cut every absolute Windows path in one text into candidate chunks.
 *
 * @param {string} text
 * @param {number} index - offset of the drive letter to start from.
 * @returns {string[]} candidate chunks.
 */
function chunksFrom(text, index) {
  const rest = text.slice(index)
  // A backslash is part of the path, so only quotes, fences, pipes, angle
  // brackets, and line breaks end a candidate.
  const boundary = rest.search(/["'`<>|[\n\r\t]/u)
  const chunk = boundary === -1 ? rest : rest.slice(0, boundary)
  return [chunk]
}

/**
 * Validate one inferred path and return its directory form.
 *
 * @param {string} candidate
 * @param {boolean} [explicit] - the path came from an explicit filepath tag.
 * @returns {string | undefined}
 */
function usableDirectory(candidate, explicit = false) {
  const text = String(candidate).trim().replace(/^[`'"]+|[`'"]+$/gu, '').trim()
  if (text.length < 4 || text.includes('://') || !/^[A-Za-z]:[\\/]/u.test(text)) return undefined
  if (text.includes('\u0000')) return undefined

  // Shorten from the right until an existing directory is found.
  let current = text
  for (let guard = 0; guard < 200; guard += 1) {
    const resolved = existingDirectory(current, explicit)
    if (resolved !== undefined) return resolved
    const cut = current.lastIndexOf(' ')
    if (cut <= 3) break
    current = current.slice(0, cut).trim()
  }
  return undefined
}

/**
 * Resolve one path to an existing directory, refusing places that are not
 * project folders.
 *
 * @param {string} candidate
 * @param {boolean} [explicit] - the path came from an explicit filepath tag.
 * @returns {string | undefined}
 */
function existingDirectory(candidate, explicit = false) {
  let text = candidate.replace(/[.,;:)\]}]+$/u, '').trim()
  if (text.length < 4) return undefined
  text = path.win32.normalize(text.replace(/\//gu, '\\'))
  const lower = text.toLowerCase()
  const home = os.homedir().toLowerCase()
  if (lower === home) return undefined
  if (lower === 'c:\\' || lower === 'c:\\program files' || lower === 'c:\\program files (x86)') return undefined
  if (lower.includes('\\.minimax\\sessions\\')) return undefined
  if (lower.includes('\\appdata\\local\\temp\\') || lower.includes('\\appdata\\local\\temp')) return undefined
  if (lower.includes('\\windows\\') || lower.includes('\\node_modules\\') || lower.includes('\\$recycle.bin\\')) return undefined
  if (lower.includes('\\.git\\') || lower.endsWith('\\.git')) return undefined
  // A hidden folder directly under the home directory is a configuration
  // folder, not a project; only an explicit filepath tag may name one.
  if (!explicit && lower.startsWith(`${home}\\`)) {
    const first = lower.slice(home.length + 1).split('\\')[0]
    if (first.startsWith('.')) return undefined
  }
  try {
    if (!existsSync(text)) return undefined
    const info = statSync(text)
    if (info.isDirectory()) return text
    if (info.isFile()) {
      const directory = path.dirname(text)
      return existsSync(directory) && statSync(directory).isDirectory() ? directory : undefined
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Parse JSON Lines into records, ignoring malformed lines.
 *
 * @param {string} text - file contents.
 * @returns {object[]} parsed records.
 */
export function parseJsonLines(text) {
  const records = []
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      /* a torn or non-JSON line is not a transcript record */
    }
  }
  return records
}

/**
 * Describe an error without leaking a stack.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
