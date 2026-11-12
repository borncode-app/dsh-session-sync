/**
 * Pure conversion helpers shared by the Host plugin and its smoke test.
 *
 * The importer turns another agent's transcript into the subset of DeepSeek
 * Harness session events that the Conversation view can replay: one Turn per
 * user prompt, one Step per assistant reply, and the title event. Tool traffic
 * is deliberately left out, so an imported session stays a readable
 * conversation instead of a multi-hundred-megabyte replay log.
 */

/** Source identifiers used in the state file and by the Client badge. */
export const SOURCES = Object.freeze({
  dsh: 'dsh',
  claude: 'claude-code',
  minimax: 'minimax-code',
})

/** Human-readable names per source. */
export const SOURCE_NAMES = Object.freeze({
  [SOURCES.dsh]: 'DSH',
  [SOURCES.claude]: 'Claude Code',
  [SOURCES.minimax]: 'MiniMax Code',
})

/** Version stamped into every imported Session header. */
export const SESSION_FORMAT_VERSION = 4

const UUID_SALT = 'dsh-session-sync.v1:'
const MAX_TITLE_CHARS = 100

/**
 * Format one UUID-shaped version-5 identifier from a SHA-1 digest of `name`.
 *
 * Deterministic ids make a re-run idempotent even when the plugin state file
 * is lost: the same external session always maps to the same DSH session id,
 * and the persistence stat check finds the imported log again.
 *
 * @param {string} name - stable external identity, for example
 *   `claude-code:90854396-...`.
 * @returns {string} `session-` plus a UUID version-5 string.
 */
export function dshSessionIdFor(name) {
  const digest = createUuidDigest(`${UUID_SALT}${name}`)
  return `session-${digest}`
}

/** @param {string} name */
function createUuidDigest(name) {
  // Kept dependency-free: a small SHA-1 implementation over the UTF-8 bytes.
  const bytes = new TextEncoder().encode(name)
  const hash = sha1(bytes)
  hash[6] = (hash[6] & 0x0f) | 0x50
  hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/**
 * Minimal SHA-1 (FIPS 180-1) used only for deterministic session ids.
 *
 * @param {Uint8Array} input - bytes to hash.
 * @returns {Uint8Array} the 20-byte digest.
 */
function sha1(input) {
  const bitLength = input.length * 8
  const paddedLength = (((input.length + 9) >> 6) + 1) << 6
  const buffer = new Uint8Array(paddedLength)
  buffer.set(input)
  buffer[input.length] = 0x80
  const view = new DataView(buffer.buffer)
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000))
  view.setUint32(paddedLength - 4, bitLength >>> 0)

  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const words = new Uint32Array(80)

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4)
    }
    for (let index = 16; index < 80; index += 1) {
      const value = words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16]
      words[index] = ((value << 1) | (value >>> 31)) >>> 0
    }
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    for (let index = 0; index < 80; index += 1) {
      let f
      let k
      if (index < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (index < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (index < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + words[index]) >>> 0
      e = d
      d = c
      c = ((b << 30) | (b >>> 2)) >>> 0
      b = a
      a = temp
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }

  const out = new Uint8Array(20)
  const outView = new DataView(out.buffer)
  outView.setUint32(0, h0)
  outView.setUint32(4, h1)
  outView.setUint32(8, h2)
  outView.setUint32(12, h3)
  outView.setUint32(16, h4)
  return out
}

/**
 * Remove the context blocks another agent injects into a user turn, so an
 * imported conversation shows what the user actually wrote.
 *
 * @param {unknown} value - raw text.
 * @returns {string} display text, trimmed.
 */
export function cleanText(value) {
  if (value === null || value === undefined) return ''
  let text = String(value)
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/giu, '')
  text = text.replace(/<system_reminder>[\s\S]*?<\/system_reminder>/giu, '')
  text = text.replace(/<command-name>[\s\S]*?<\/command-name>/giu, '')
  text = text.replace(/<command-message>[\s\S]*?<\/command-message>/giu, '')
  text = text.replace(/<command-args>[\s\S]*?<\/command-args>/giu, '')
  text = text.replace(/<local-command-[a-z-]+>[\s\S]*?<\/local-command-[a-z-]+>/giu, '')
  text = text.replace(/<attachment>[\s\S]*?<\/attachment>/giu, '')
  text = text.replace(/\r\n/gu, '\n')
  return text.trim()
}

/**
 * Clamp one message body to the configured budget while leaving a marker that
 * makes the omission visible.
 *
 * @param {string} text - cleaned body.
 * @param {number} maxChars - positive character budget.
 * @returns {string} body inside the budget.
 */
export function clampText(text, maxChars) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 20000
  if (text.length <= limit) return text
  const omitted = text.length - limit
  return `${text.slice(0, limit)}\n\n… [truncated ${omitted.toLocaleString('en-US')} characters]`
}

/**
 * Derive a short title from the first meaningful user line.
 *
 * @param {string} text - cleaned text.
 * @param {number} [maxChars] - character budget.
 * @returns {string} one-line title, possibly empty.
 */
export function deriveTitle(text, maxChars = MAX_TITLE_CHARS) {
  const singleLine = String(text ?? '').replace(/\s+/gu, ' ').trim()
  if (singleLine.length === 0) return ''
  if (singleLine.length <= maxChars) return singleLine
  return `${singleLine.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`
}

/**
 * Accept a timestamp in the shapes external stores use and return epoch
 * milliseconds.
 *
 * @param {unknown} value - ISO string or epoch milliseconds.
 * @param {number} fallback - value used when nothing parses.
 * @returns {number} epoch milliseconds.
 */
export function toEpochMs(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  if (typeof value === 'string' && value.trim().length > 0) {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric)
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

/** Random identifier for messages that carry no usable external id. */
function randomId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `imported-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Turn a plain `{role, text, time, model, provider}` list into the event log of
 * a new DSH Session.
 *
 * @param {object} input
 * @param {readonly {role: string, text: string, time: number, model?: string, provider?: string, id?: string}[]} input.messages
 * @param {string} input.title - session title to record.
 * @param {number} [input.maxTextChars] - per-message character budget.
 * @returns {{events: object[], turns: number, messages: number}} the events.
 */
export function buildSessionEvents(input) {
  const maxChars = input.maxTextChars ?? 20000
  const kept = []
  for (const message of input.messages ?? []) {
    if (message?.role !== 'user' && message?.role !== 'assistant') continue
    const text = clampText(cleanText(message.text), maxChars)
    if (text.length === 0) continue
    kept.push({ ...message, text })
  }

  /** @type {object[]} */
  const events = []
  let seq = 0
  let lastTime = 0
  /**
   * @param {string} type
   * @param {number} time
   * @param {unknown} data
   * @param {object} [extra]
   */
  const push = (type, time, data, extra) => {
    const event = { type, seq: seq++, time, data, ...(extra ?? {}) }
    events.push(event)
    lastTime = Math.max(lastTime, time)
    return event
  }

  let turn = 0
  let step = 0
  let turnOpen = false
  let stepOpen = false
  let firstUserSeq
  let lastAssistantTime = 0

  const openTurn = (time) => {
    turn += 1
    step = 0
    turnOpen = true
    push('turn/start', time, { turn })
  }
  const openStep = (time) => {
    step += 1
    stepOpen = true
    push('step/start', time, { turn, step })
  }
  const closeStep = (time) => {
    if (!stepOpen) return
    push('step/end', time, { turn, step })
    stepOpen = false
  }
  const closeTurn = (time) => {
    closeStep(time)
    if (!turnOpen) return
    push('turn/end', time, { turn, reason: { kind: 'completed' } })
    turnOpen = false
  }

  for (const message of kept) {
    const time = Math.max(toEpochMs(message.time, lastTime || Date.now()), lastTime, 1)
    if (message.role === 'user') {
      closeTurn(time)
      openTurn(time)
      openStep(time)
      const event = push('user/message', time, {
        content: [{ type: 'text', text: message.text }],
        source: { kind: 'user' },
        role: 'user',
        id: message.id || randomId(),
      }, { surfaceOp: 'append' })
      if (firstUserSeq === undefined) firstUserSeq = event.seq
    } else {
      if (!turnOpen) openTurn(time)
      if (!stepOpen) openStep(time)
      push('assistant/message', time, {
        turn,
        step,
        stream: [],
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: message.text }],
          source: {
            kind: 'model',
            provider: message.provider || 'imported',
            model: message.model || 'imported',
          },
          id: message.id || randomId(),
        },
      }, { surfaceOp: 'append' })
      lastAssistantTime = time
      closeStep(time)
    }
  }

  const finishedAt = Math.max(lastTime, lastAssistantTime, 1)
  closeTurn(finishedAt)
  const title = deriveTitle(input.title) || deriveTitle(kept.find((message) => message.role === 'user')?.text) || 'Imported session'
  push('session/title', finishedAt, {
    title,
    messageSeqs: firstUserSeq === undefined ? [] : [firstUserSeq],
    // A `fallback` title cites the messages it summarizes; only an explicit
    // user rename may carry a `user` source, and that source must have an
    // empty `messageSeqs` list.
    source: { kind: 'fallback' },
  })

  return {
    events,
    turns: turn,
    messages: kept.length,
  }
}

/**
 * Normalize parsed Claude Code transcript records into the importer's message
 * list.
 *
 * @param {readonly object[]} records - JSONL records in file order.
 * @param {object} [options]
 * @param {number} [options.maxTextChars] - per-message budget.
 * @returns {{messages: object[], title: string, cwd: string|undefined, createdAt: number}}
 */
export function analyzeClaudeRecords(records, options = {}) {
  const maxTextChars = options.maxTextChars ?? 20000
  const messages = []
  let title = ''
  let cwd
  let createdAt
  let lastTime = 0

  for (const record of records) {
    if (record === null || typeof record !== 'object') continue
    if (record.type === 'custom-title' && typeof record.customTitle === 'string') {
      title = record.customTitle.trim()
      continue
    }
    if (record.type === 'agent-name' && typeof record.agentName === 'string' && title.length === 0) {
      title = record.agentName.trim()
      continue
    }
    if (record.type === 'relocated' && typeof record.relocatedCwd === 'string') {
      cwd = record.relocatedCwd
      continue
    }
    if (record.isSidechain === true) continue
    if (record.type !== 'user' && record.type !== 'assistant') continue
    if (record.isMeta === true) continue
    if (typeof record.cwd === 'string' && cwd === undefined) cwd = record.cwd

    const message = record.message
    if (message === null || typeof message !== 'object') continue
    const role = message.role === 'assistant' ? 'assistant' : message.role === 'user' ? 'user' : undefined
    if (role === undefined) continue
    const content = Array.isArray(message.content) ? message.content : typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : []
    const parts = []
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      if (block.type !== 'text') continue
      const text = cleanText(block.text)
      if (text.length === 0) continue
      parts.push(text)
    }
    if (parts.length === 0) continue
    const time = toEpochMs(record.timestamp, lastTime + 1)
    lastTime = time
    if (createdAt === undefined) createdAt = time
    messages.push({
      role,
      text: clampText(parts.join('\n\n'), maxTextChars),
      time,
      id: typeof record.uuid === 'string' ? record.uuid : undefined,
      provider: role === 'assistant' ? 'claude-code' : undefined,
      model: role === 'assistant' ? String(message.model ?? 'claude') : undefined,
    })
  }

  if (createdAt === undefined) createdAt = Date.now()
  const firstUser = messages.find((message) => message.role === 'user')
  return {
    messages,
    title: title || deriveTitle(firstUser?.text ?? ''),
    cwd,
    createdAt,
  }
}

/**
 * Normalize MiniMax Code message rows (from its sqlite display store) into the
 * importer's message list.
 *
 * @param {readonly {role: string, created_at_ms: number|string, data_json: string, source?: string}[]} rows
 * @param {object} session - MiniMax session row.
 * @param {object} [options]
 * @param {number} [options.maxTextChars] - per-message budget.
 * @returns {{messages: object[], title: string, cwd: string|undefined, createdAt: number}}
 */
export function analyzeMinimaxRows(rows, session, options = {}) {
  const maxTextChars = options.maxTextChars ?? 20000
  const messages = []
  let createdAt
  let lastTime = 0
  let provider = 'minimax-code'
  let model = 'MiniMax'
  try {
    const extra = session.extra_data_json ? JSON.parse(session.extra_data_json) : undefined
    const effective = typeof extra?.effectiveModel === 'string' ? extra.effectiveModel : ''
    if (effective.includes('/')) {
      const [head, ...tail] = effective.split('/')
      provider = head
      model = tail.join('/')
    } else if (effective.length > 0) {
      model = effective
    }
  } catch {
    /* leave the defaults */
  }

  for (const row of rows) {
    if (row?.role !== 'user' && row?.role !== 'assistant') continue
    if (row.source === 'greeting') continue
    let payload
    try {
      payload = row.data_json ? JSON.parse(row.data_json) : undefined
    } catch {
      payload = undefined
    }
    const text = cleanText(payload?.msg_content ?? payload?.content ?? '')
    if (text.length === 0) continue
    const time = toEpochMs(payload?.timestamp ?? row.created_at_ms, lastTime + 1)
    lastTime = time
    if (createdAt === undefined) createdAt = time
    messages.push({
      role: row.role,
      text: clampText(text, maxTextChars),
      time,
      id: typeof payload?.msg_id === 'string' ? payload.msg_id : typeof row.msg_id === 'string' ? row.msg_id : undefined,
      provider: row.role === 'assistant' ? provider : undefined,
      model: row.role === 'assistant' ? model : undefined,
    })
  }

  const firstUser = messages.find((message) => message.role === 'user')
  return {
    messages,
    title: deriveTitle(session.title ?? '') || deriveTitle(firstUser?.text ?? ''),
    cwd: typeof session.workspace_dir === 'string' ? session.workspace_dir : undefined,
    createdAt: toEpochMs(createdAt ?? session.created_at_ms, Date.now()),
  }
}

/**
 * One-line title for a workspace created from a session's directory.
 *
 * @param {string} directory - absolute directory path.
 * @param {string} [delimiter] - path delimiter (defaults to the platform's).
 * @returns {string} display title.
 */
export function workspaceTitle(directory, delimiter = undefined) {
  const separator = delimiter ?? (/\\/u.test(directory) ? '\\' : '/')
  const parts = String(directory).split(/[\\/]+/u).filter(Boolean)
  const leaf = parts.at(-1) ?? 'workspace'
  if (leaf === 'workspace' && parts.length >= 2) {
    return `${parts.at(-2)} ${leaf}`.slice(0, 80)
  }
  return leaf.slice(0, 80)
}
