/**
 * Session sync — imports Claude Code and MiniMax Code conversations into the
 * DeepSeek Harness workspace that owns their project directory.
 *
 * Design choices:
 * - A workspace's identity is its folder path (`Workspace.path`): every
 *   external session lands in the workspace whose directory matches the
 *   session's own working directory, creating that workspace when needed.
 * - Imported sessions are ordinary persisted DSH sessions, so they appear in
 *   the sidebar and open in the Conversation view.
 * - The origin (DSH / Claude Code / MiniMax Code) is stored in this plugin's
 *   state and exposed to the Client half, which renders the row badge.
 * - Re-runs are idempotent: a deterministic DSH session id per external session
 *   plus a fingerprint in the state file prevent duplicate imports.
 */

import { readFile, writeFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

import { scanClaudeCode, scanMinimaxCode, describe, inferProjectDirectory, isMinimaxSandbox } from './lib/sources.mjs'
import {
  SOURCES,
  SOURCE_NAMES,
  buildSessionEvents,
  dshSessionIdFor,
  toEpochMs,
  workspaceTitle,
} from './lib/convert.mjs'

/** File that keeps the import map across Host restarts. */
const STATE_FILE = fileURLToPath(new URL('./state.json', import.meta.url))

/** Default configuration, used when the row omits a field. */
const DEFAULTS = Object.freeze({
  endpoint: '/plugins/session-sync',
  autoSync: true,
  intervalMinutes: 15,
  maxTextChars: 20000,
  claudeRoot: '',
  minimaxDatabase: '',
  maxIssues: 60,
})

/** Hard services: persistence, workspace accounting, and the HTTP carrier. */
export const inject = ['webServer', 'sessionPersistence', 'workspaceRegistry']

/**
 * Read one configuration field, tolerating plain values and live getters.
 *
 * @param {object | undefined} config - the row's resolved configuration.
 * @param {string} field - field name.
 * @param {unknown} fallback - value used when the field is absent.
 * @returns {unknown} resolved value.
 */
function setting(config, field, fallback) {
  const value = config?.[field]
  if (value === undefined) return fallback
  const resolved = typeof value?.get === 'function' ? value.get() : value
  return resolved === undefined ? fallback : resolved
}

/** Build the empty state document. */
function emptyState() {
  return {
    version: 1,
    updatedAt: 0,
    autoSync: true,
    lastSync: null,
    sessions: {},
    external: {},
  }
}

/**
 * Keep a persisted state document in a shape this version can read.
 *
 * @param {unknown} raw - parsed JSON.
 * @returns {object} normalized state.
 */
function normalizeState(raw) {
  const base = emptyState()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return base
  const candidate = raw
  if (candidate.sessions !== null && typeof candidate.sessions === 'object' && !Array.isArray(candidate.sessions)) {
    for (const [key, value] of Object.entries(candidate.sessions)) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      const record = value
      if (typeof record.source !== 'string') continue
      base.sessions[key] = {
        source: record.source,
        externalId: typeof record.externalId === 'string' ? record.externalId : '',
        title: typeof record.title === 'string' ? record.title : '',
        cwd: typeof record.cwd === 'string' ? record.cwd : '',
        fingerprint: typeof record.fingerprint === 'string' ? record.fingerprint : '',
        importedAt: Number.isFinite(record.importedAt) ? record.importedAt : 0,
        messageCount: Number.isFinite(record.messageCount) ? record.messageCount : 0,
      }
    }
  }
  if (candidate.external !== null && typeof candidate.external === 'object' && !Array.isArray(candidate.external)) {
    for (const [key, value] of Object.entries(candidate.external)) {
      if (typeof value === 'string') base.external[key] = value
    }
  }
  base.updatedAt = Number.isFinite(candidate.updatedAt) ? candidate.updatedAt : 0
  base.autoSync = candidate.autoSync !== false
  if (candidate.lastSync !== null && typeof candidate.lastSync === 'object' && !Array.isArray(candidate.lastSync)) {
    base.lastSync = candidate.lastSync
  }
  return base
}

/**
 * Create the sync row.
 *
 * @param {object} ctx - Cordis Host context.
 * @param {object | undefined} config - row configuration.
 * @returns {Promise<void>}
 */
export async function apply(ctx, config) {
  const logger = ctx.logger
  const endpoint = String(setting(config, 'endpoint', DEFAULTS.endpoint))
  const autoSyncDefault = Boolean(setting(config, 'autoSync', DEFAULTS.autoSync))
  const intervalMinutes = Math.max(1, Math.floor(Number(setting(config, 'intervalMinutes', DEFAULTS.intervalMinutes)) || DEFAULTS.intervalMinutes))
  const maxTextChars = Math.max(1000, Math.floor(Number(setting(config, 'maxTextChars', DEFAULTS.maxTextChars)) || DEFAULTS.maxTextChars))
  const maxIssues = Math.max(0, Math.floor(Number(setting(config, 'maxIssues', DEFAULTS.maxIssues)) || DEFAULTS.maxIssues))
  const claudeRoot = String(setting(config, 'claudeRoot', DEFAULTS.claudeRoot) || path.join(os.homedir(), '.claude', 'projects'))
  const minimaxDatabase = String(
    setting(config, 'minimaxDatabase', DEFAULTS.minimaxDatabase) || path.join(os.homedir(), '.minimax', 'v2', 'sqlite', 'runtime-state.sqlite'),
  )

  /** @type {object} */
  let state = emptyState()
  try {
    state = normalizeState(JSON.parse(await readFile(STATE_FILE, 'utf8')))
  } catch {
    state = emptyState()
  }
  state.autoSync = autoSyncDefault

  /** One sync at a time; concurrent callers await the same run. */
  let activeSync = null

  /** Persist the state atomically. */
  const persist = async () => {
    state.updatedAt = Date.now()
    const body = `${JSON.stringify(state, null, 2)}\n`
    const temporary = `${STATE_FILE}.tmp`
    try {
      await writeFile(temporary, body, 'utf8')
      await rename(temporary, STATE_FILE)
    } catch (error) {
      logger.warn(`session-sync: could not save the import map: ${describe(error)}`)
    }
  }

  /**
   * Whether this exact external revision is already imported.
   *
   * @param {string} key - external session key.
   * @param {string} fingerprint - external revision fingerprint.
   * @returns {boolean}
   */
  const isCurrent = (key, fingerprint) => {
    const id = state.external[key]
    return id !== undefined && state.sessions[id]?.fingerprint === fingerprint
  }

  /**
   * Locate or create the DSH workspace that owns a directory.
   *
   * @param {string} directory - absolute project directory.
   * @returns {Promise<object | null>} the Workspace entity, or null when the
   *   directory no longer exists.
   */
  const ensureWorkspace = async (directory) => {
    let resolved
    try {
      resolved = path.resolve(directory)
    } catch {
      return null
    }
    if (!existsSync(resolved)) return null
    let workspace = null
    try {
      workspace = await ctx.workspaceRegistry.resolveByPath(resolved)
    } catch {
      workspace = null
    }
    // `resolveByPath` answers `undefined` when the directory has no workspace;
    // only `create` returns the entity we need below.
    if (workspace === null || workspace === undefined || typeof workspace.path !== 'string') {
      workspace = await ctx.workspaceRegistry.create(resolved, workspaceTitle(resolved))
    }
    if (workspace === null || workspace === undefined || typeof workspace.path !== 'string') {
      throw new Error(`workspace registry did not return a workspace for ${resolved}`)
    }
    return workspace
  }

  /**
   * Import one scanned candidate.
   *
   * @param {object} candidate - scanner output.
   * @param {object} result - mutable run result.
   * @returns {Promise<void>}
   */
  const importCandidate = async (candidate, result) => {
    const externalId = candidate.externalId ?? candidate.externalKey
    const id = state.external[candidate.externalKey] ?? dshSessionIdFor(candidate.externalKey)
    const workspace = await ensureWorkspace(candidate.cwd)
    if (workspace === null) {
      result.skipped += 1
      result.issues.push({
        source: candidate.source,
        externalId,
        reason: 'working-directory-missing',
        cwd: candidate.cwd,
      })
      return
    }

    const existing = await ctx.sessionPersistence.stat(id).catch(() => undefined)
    if (existing !== undefined) {
      state.external[candidate.externalKey] = id
      state.sessions[id] = {
        source: candidate.source,
        externalId,
        title: candidate.title,
        cwd: candidate.cwd,
        fingerprint: candidate.fingerprint,
        importedAt: state.sessions[id]?.importedAt ?? Date.now(),
        messageCount: candidate.messages.length,
      }
      try {
        await workspace.attachSession(id)
      } catch (error) {
        result.issues.push({ source: candidate.source, externalId, reason: 'attach-failed', detail: describe(error) })
      }
      result.reused += 1
      return
    }

    const built = buildSessionEvents({
      messages: candidate.messages,
      title: candidate.title,
      source: candidate.source,
      maxTextChars,
    })
    if (built.messages === 0 || built.events.length === 0) {
      result.skipped += 1
      result.issues.push({ source: candidate.source, externalId, reason: 'no-importable-messages' })
      return
    }

    const header = {
      version: 4,
      id,
      createdAt: toEpochMs(candidate.createdAt, Date.now()),
      isSeeded: false,
      cwd: workspace.path,
    }
    const handle = await ctx.sessionPersistence.create(header)
    try {
      await handle.append(built.events)
      await handle.flush()
    } finally {
      await handle.close()
    }
    await workspace.attachSession(id)

    // The sidebar reads historical titles from the projection cache, not from
    // the raw log. A cold read computes the title projection from the complete
    // event list and writes the checkpoint back, so the imported session shows
    // its title immediately instead of "Untitled".
    const projectionCache = ctx.get('sessionProjectionCache')
    if (projectionCache !== undefined) {
      try {
        await projectionCache.coldSnapshot(header, 0, built.events)
      } catch (error) {
        logger.warn(`session-sync: could not warm the projection cache for ${id}: ${describe(error)}`)
      }
    }

    state.external[candidate.externalKey] = id
    state.sessions[id] = {
      source: candidate.source,
      externalId,
      title: candidate.title,
      cwd: candidate.cwd,
      fingerprint: candidate.fingerprint,
      importedAt: Date.now(),
      messageCount: built.messages,
    }
    result.imported += 1
    result.bySource[candidate.source] = (result.bySource[candidate.source] ?? 0) + 1
    logger.info(
      `session-sync: imported ${SOURCE_NAMES[candidate.source] ?? candidate.source} session ${externalId} ` +
        `(${built.messages} messages, ${built.turns} turns) into ${workspace.title}`,
    )
  }

  /**
   * Scan both stores and import every new session.
   *
   * @param {string} reason - `boot`, `manual`, or `interval`.
   * @returns {Promise<object>} run result.
   */
  const runSync = async (reason) => {
    if (activeSync !== null) return activeSync
    activeSync = (async () => {
      const started = Date.now()
      /** @type {object} */
      const result = {
        at: started,
        reason,
        imported: 0,
        reused: 0,
        unchanged: 0,
        skipped: 0,
        issues: [],
        bySource: {},
      }
      let claude = { candidates: [], issues: [] }
      let minimax = { candidates: [], issues: [] }
      try {
        claude = await scanClaudeCode({ root: claudeRoot, maxTextChars, isCurrent })
      } catch (error) {
        result.issues.push({ source: 'claude-code', reason: 'scan-failed', detail: describe(error) })
      }
      try {
        minimax = await scanMinimaxCode({ databasePath: minimaxDatabase, maxTextChars, isCurrent })
      } catch (error) {
        result.issues.push({ source: 'minimax-code', reason: 'scan-failed', detail: describe(error) })
      }
      result.issues.push(...claude.issues, ...minimax.issues)

      const pending = [...claude.candidates, ...minimax.candidates].filter((candidate) => candidate.unchanged !== true)
      result.unchanged =
        claude.candidates.filter((candidate) => candidate.unchanged === true).length +
        minimax.candidates.filter((candidate) => candidate.unchanged === true).length
      pending.sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0))

      for (const candidate of pending) {
        try {
          await importCandidate(candidate, result)
        } catch (error) {
          result.issues.push({
            source: candidate.source,
            externalId: candidate.externalId ?? candidate.externalKey,
            reason: 'import-failed',
            detail: describe(error),
          })
        }
        // Yield so the Host event loop keeps serving the GUI during a first run.
        await new Promise((resolve) => setTimeout(resolve, 0))
      }

      if (result.issues.length > maxIssues) result.issues = result.issues.slice(0, maxIssues)
      state.lastSync = {
        at: started,
        durationMs: Date.now() - started,
        reason,
        imported: result.imported,
        reused: result.reused,
        unchanged: result.unchanged,
        skipped: result.skipped,
        bySource: result.bySource,
        issues: result.issues,
      }
      await persist()
      logger.info(
        `session-sync: ${reason} run finished in ${state.lastSync.durationMs} ms ` +
          `(imported ${result.imported}, reused ${result.reused}, unchanged ${result.unchanged}, skipped ${result.skipped})`,
      )
      return result
    })().finally(() => {
      activeSync = null
    })
    return activeSync
  }

  /** Compose the answer the Client half reads. */
  const snapshot = async () => {
    let dsh = 0
    try {
      const stored = await ctx.sessionPersistence.list()
      for (const entry of stored) {
        if (state.sessions[entry.header.id] === undefined) dsh += 1
      }
    } catch (error) {
      logger.warn(`session-sync: could not count DSH sessions: ${describe(error)}`)
    }
    let claudeCount = 0
    let minimaxCount = 0
    const sources = {}
    for (const [id, record] of Object.entries(state.sessions)) {
      sources[id] = record.source
      if (record.source === SOURCES.claude) claudeCount += 1
      else if (record.source === SOURCES.minimax) minimaxCount += 1
    }
    return {
      ok: true,
      generatedAt: Date.now(),
      counts: { dsh, claudeCode: claudeCount, minimaxCode: minimaxCount },
      sources,
      lastSync: state.lastSync,
      autoSync: state.autoSync,
      busy: activeSync !== null,
      paths: { claude: claudeRoot, minimax: minimaxDatabase },
      intervalMinutes,
    }
  }

  /**
   * Read a JSON request body.
   *
   * @param {import('node:http').IncomingMessage} request
   * @returns {Promise<object | null>}
   */
  const readJsonBody = async (request) => {
    let body = ''
    for await (const chunk of request) {
      body += chunk
      if (body.length > 1_000_000) return null
    }
    try {
      const parsed = JSON.parse(body)
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  /**
   * The Client logo reads this map from a hidden element in the page. It is
   * injected as base64 JSON so no script or HTML escaping is involved.
   */
  const sourcesMap = () => {
    const map = {}
    for (const [id, record] of Object.entries(state.sessions)) map[id] = record.source
    return map
  }

  ctx.effect(
    () =>
      ctx.webServer.tapIndex((html) => {
        const payload = Buffer.from(JSON.stringify(sourcesMap()), 'utf8').toString('base64')
        const marker = `<div id="dsh-session-sync-sources" hidden data-sources="${payload}"></div>`
        return html.includes('</body>') ? html.replace('</body>', `${marker}</body>`) : `${html}${marker}`
      }),
    'session-sync: source map',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: endpoint,
        handler: (request, response) => {
          const reply = (status, body) => {
            response.writeHead(status, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            })
            response.end(JSON.stringify(body))
          }
          if (request.method === 'GET' || request.method === 'HEAD') {
            void snapshot()
              .then((body) => reply(200, body))
              .catch((error) => {
                logger.warn(`session-sync: status route failed: ${describe(error)}`)
                reply(500, { ok: false, error: 'failed' })
              })
            return
          }
          if (request.method !== 'POST') {
            reply(405, { ok: false, error: 'method-not-allowed' })
            return
          }
          void (async () => {
            const body = await readJsonBody(request)
            if (body === null) {
              reply(400, { ok: false, error: 'invalid-body' })
              return
            }
            if (body.action === 'sync') {
              await runSync('manual')
              reply(200, await snapshot())
              return
            }
            if (body.action === 'set-auto') {
              state.autoSync = body.autoSync !== false
              await persist()
              reply(200, await snapshot())
              return
            }
            if (body.action === 'verify') {
              // Read one or two imported sessions through the persistence
              // read path, which replays and validates the complete log just
              // as opening the session does. This is a diagnostic, not a
              // mutation.
              const ids =
                typeof body.sessionId === 'string' && body.sessionId.length > 0
                  ? [body.sessionId]
                  : Object.keys(state.sessions).slice(0, 2)
              const results = []
              for (const id of ids) {
                try {
                  const handle = await ctx.sessionPersistence.open(id, 'read')
                  let events = []
                  try {
                    events = (await handle.read()).events
                  } finally {
                    await handle.close()
                  }
                  const titleEvent = [...events].reverse().find((event) => event.type === 'session/title')
                  results.push({
                    sessionId: id,
                    ok: true,
                    events: events.length,
                    title: titleEvent?.data?.title ?? null,
                    header: handle.header,
                  })
                } catch (error) {
                  results.push({ sessionId: id, ok: false, error: describe(error) })
                }
              }
              reply(200, { ok: true, results })
              return
            }
            if (body.action === 'warm') {
              // Backfill the projection cache for already imported sessions so
              // the historical sidebar shows their stored title, not
              // "Untitled".
              const projectionCache = ctx.get('sessionProjectionCache')
              if (projectionCache === undefined) {
                reply(501, { ok: false, error: 'no-projection-cache' })
                return
              }
              let warmed = 0
              let failed = 0
              const failures = []
              for (const id of Object.keys(state.sessions)) {
                try {
                  const handle = await ctx.sessionPersistence.open(id, 'read')
                  let events = []
                  let header
                  try {
                    header = handle.header
                    events = (await handle.read()).events
                  } finally {
                    await handle.close()
                  }
                  await projectionCache.coldSnapshot(header, 0, events)
                  warmed += 1
                } catch (error) {
                  failed += 1
                  if (failures.length < 20) failures.push({ sessionId: id, error: describe(error) })
                }
              }
              reply(200, { ok: true, warmed, failed, failures })
              return
            }
            if (body.action === 'regroup') {
              // MiniMax records its own per-session sandbox as the working
              // directory. When the prompt names a real folder, re-import the
              // conversation there and archive the sandbox copy.
              const dryRun = body.dryRun === true
              const scan = await scanMinimaxCode({
                databasePath: minimaxDatabase,
                maxTextChars,
                isCurrent: () => false,
              })
              const candidates = new Map(
                scan.candidates
                  .filter((candidate) => candidate.unchanged !== true && Array.isArray(candidate.messages))
                  .map((candidate) => [candidate.externalKey, candidate]),
              )
              const plan = []
              for (const [oldId, record] of Object.entries(state.sessions)) {
                if (record.source !== SOURCES.minimax) continue
                if (!isMinimaxSandbox(record.cwd)) continue
                const candidate = candidates.get(`minimax-code:${record.externalId}`)
                if (candidate === undefined) continue
                const target = inferProjectDirectory(candidate.messages)
                if (target === undefined) continue
                if (path.resolve(target).toLowerCase() === path.resolve(record.cwd).toLowerCase()) continue
                plan.push({
                  oldId,
                  externalId: record.externalId,
                  externalKey: candidate.externalKey,
                  title: candidate.title,
                  from: record.cwd,
                  to: target,
                  messages: candidate.messages.length,
                  candidate,
                })
              }
              if (dryRun) {
                reply(200, {
                  ok: true,
                  dryRun: true,
                  plan: plan.map(({ candidate, ...rest }) => rest),
                })
                return
              }

              const results = []
              for (const item of plan) {
                try {
                  const newId = dshSessionIdFor(`regroup2:${item.externalKey}`)
                  let workspace = await ensureWorkspace(item.to)
                  if (workspace === null) throw new Error(`target directory is missing: ${item.to}`)
                  const existing = await ctx.sessionPersistence.stat(newId).catch(() => undefined)
                  if (existing === undefined) {
                    const built = buildSessionEvents({
                      messages: item.candidate.messages,
                      title: item.title,
                      source: item.candidate.source,
                      maxTextChars,
                    })
                    if (built.messages === 0) throw new Error('no importable messages')
                    const header = {
                      version: 4,
                      id: newId,
                      createdAt: toEpochMs(item.candidate.createdAt, Date.now()),
                      isSeeded: false,
                      cwd: workspace.path,
                    }
                    const handle = await ctx.sessionPersistence.create(header)
                    try {
                      await handle.append(built.events)
                      await handle.flush()
                    } finally {
                      await handle.close()
                    }
                    const projectionCache = ctx.get('sessionProjectionCache')
                    if (projectionCache !== undefined) {
                      try {
                        await projectionCache.coldSnapshot(header, 0, built.events)
                      } catch (error) {
                        logger.warn(`session-sync: regroup cache warm failed for ${newId}: ${describe(error)}`)
                      }
                    }
                  }
                  await workspace.attachSession(newId)
                  await ctx.workspaceRegistry.archiveSession(item.oldId)

                  state.sessions[newId] = {
                    source: SOURCES.minimax,
                    externalId: item.externalId,
                    title: item.title,
                    cwd: item.to,
                    fingerprint: item.candidate.fingerprint,
                    importedAt: Date.now(),
                    messageCount: item.candidate.messages.length,
                  }
                  delete state.sessions[item.oldId]
                  state.external[item.externalKey] = newId

                  // Remove the sandbox workspace once no visible session is
                  // accounted to it any more.
                  let oldWorkspace = null
                  try {
                    oldWorkspace = await ctx.workspaceRegistry.resolveByPath(item.from)
                  } catch {
                    oldWorkspace = null
                  }
                  if (oldWorkspace !== null && oldWorkspace !== undefined) {
                    const archived = new Set(ctx.workspaceRegistry.archivedSessionIds.map(String))
                    const remaining = oldWorkspace.sessionIds.filter(
                      (sessionId) => String(sessionId) !== String(item.oldId) && !archived.has(String(sessionId)),
                    )
                    if (remaining.length === 0) await ctx.workspaceRegistry.delete(oldWorkspace.id)
                  }
                  results.push({
                    externalId: item.externalId,
                    title: item.title,
                    from: item.from,
                    to: item.to,
                    oldId: item.oldId,
                    newId,
                    ok: true,
                  })
                } catch (error) {
                  results.push({
                    externalId: item.externalId,
                    from: item.from,
                    to: item.to,
                    ok: false,
                    error: describe(error),
                  })
                }
              }
              await persist()
              reply(200, {
                ok: true,
                migrated: results.filter((result) => result.ok).length,
                failed: results.filter((result) => !result.ok).length,
                results,
              })
              return
            }
            if (body.action === 'rename-sandboxes') {
              // A MiniMax sandbox workspace is named after its session id.
              // Give it the conversation's own title so the sidebar reads
              // like the rest of the list.
              const renamed = []
              for (const workspace of ctx.workspaceRegistry.list()) {
                const path = workspace.path
                const match = /\.minimax[\\/]sessions[\\/]([^\\/]+)[\\/]workspace[\\/]?$/iu.exec(path)
                if (match === null) continue
                const sessionId = match[1]
                let label = ''
                for (const record of Object.values(state.sessions)) {
                  if (record.externalId !== sessionId) continue
                  if (record.title.length > 0) label = record.title
                  break
                }
                if (label.length === 0) {
                  const scan = await scanMinimaxCode({
                    databasePath: minimaxDatabase,
                    maxTextChars,
                    isCurrent: () => true,
                  })
                  const candidate = scan.candidates.find((row) => row.externalId === sessionId)
                  label = candidate?.title ?? ''
                }
                if (label.length === 0) continue
                const title = `Mavis · ${label}`.slice(0, 80)
                if (workspace.title === title) continue
                await workspace.setTitle(title)
                renamed.push({ path, from: workspace.title, to: title })
              }
              reply(200, { ok: true, renamed })
              return
            }
            reply(400, { ok: false, error: 'unknown-action' })
          })().catch((error) => {
            logger.warn(`session-sync: control route failed: ${describe(error)}`)
            try {
              reply(500, { ok: false, error: 'failed' })
            } catch {
              /* the reply already began */
            }
          })
        },
      }),
    'session-sync: control route',
  )

  // First run after the rest of the Host has settled: the workspace registry
  // finishes its own bootstrap before it can account new sessions.
  const bootTimer = setTimeout(() => {
    if (!state.autoSync) return
    void runSync('boot').catch((error) => logger.warn(`session-sync: boot run failed: ${describe(error)}`))
  }, 3500)
  ctx.effect(() => () => clearTimeout(bootTimer), 'session-sync: boot timer')

  const tickTimer = setInterval(() => {
    if (!state.autoSync) return
    if (activeSync !== null) return
    const last = Number(state.lastSync?.at ?? 0)
    if (Date.now() - last < intervalMinutes * 60_000) return
    void runSync('interval').catch((error) => logger.warn(`session-sync: interval run failed: ${describe(error)}`))
  }, 60_000)
  ctx.effect(() => () => clearInterval(tickTimer), 'session-sync: interval timer')

  logger.info(
    `session-sync: ready (${Object.keys(state.sessions).length} imported sessions; ` +
      `autoSync=${state.autoSync ? 'on' : 'off'}, every ${intervalMinutes} min)`,
  )
}
