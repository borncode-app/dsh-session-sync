import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSessionEvents,
  cleanText,
  dshSessionIdFor,
  analyzeClaudeRecords,
  analyzeMinimaxRows,
  workspaceTitle,
} from '../lib/convert.mjs'
import { parseJsonLines } from '../lib/sources.mjs'

test('deterministic session ids keep the UUID shape', () => {
  const first = dshSessionIdFor('claude-code:90854396-7663-493c-9d1c-ab9208442011')
  const second = dshSessionIdFor('claude-code:90854396-7663-493c-9d1c-ab9208442011')
  assert.equal(first, second)
  assert.match(first, /^session-[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
  assert.notEqual(first, dshSessionIdFor('claude-code:other'))
})

test('injected context is removed from a user turn', () => {
  const cleaned = cleanText(
    '<system-reminder>ignore me</system-reminder>\nFix the failing test\n<command-name>/run</command-name>',
  )
  assert.equal(cleaned, 'Fix the failing test')
})

test('Claude records become a text conversation with the right title and cwd', () => {
  const records = [
    { type: 'custom-title', customTitle: 'webOS handoff' },
    {
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-10-31T10:00:00.000Z',
      cwd: 'C:\\work\\scratch',
      message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>ctx</system-reminder>\nShip it' }] },
    },
    {
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-10-31T10:01:00.000Z',
      message: {
        role: 'assistant',
        model: 'claude-opus',
        content: [
          { type: 'thinking', thinking: 'hidden' },
          { type: 'text', text: 'Working on it.' },
        ],
      },
    },
    { type: 'user', isSidechain: true, timestamp: '2026-10-31T10:02:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'sidechain' }] } },
    { type: 'relocated', relocatedCwd: 'C:\\work\\project' },
  ]
  const analyzed = analyzeClaudeRecords(records)
  assert.equal(analyzed.title, 'webOS handoff')
  assert.equal(analyzed.cwd, 'C:\\work\\project')
  assert.deepEqual(
    analyzed.messages.map((message) => [message.role, message.text]),
    [
      ['user', 'Ship it'],
      ['assistant', 'Working on it.'],
    ],
  )
  assert.equal(analyzed.createdAt, Date.parse('2026-10-31T10:00:00.000Z'))
})

test('MiniMax display rows drop greetings and tool results', () => {
  const session = {
    title: 'Fix KONOHA',
    workspace_dir: 'C:\\Users\\me\\Documents\\apk',
    created_at_ms: 1000,
    extra_data_json: JSON.stringify({ effectiveModel: 'minimax/MiniMax-M3' }),
  }
  const rows = [
    { role: 'assistant', source: 'greeting', created_at_ms: 1000, data_json: JSON.stringify({ msg_content: 'hello' }) },
    { role: 'user', source: 'api', created_at_ms: 2000, data_json: JSON.stringify({ msg_content: 'Do it', msg_id: 'u1', timestamp: 2000 }) },
    { role: 'toolResult', source: 'api', created_at_ms: 2500, data_json: JSON.stringify({ msg_content: 'tool output' }) },
    {
      role: 'assistant',
      source: 'turn-continuation',
      created_at_ms: 3000,
      data_json: JSON.stringify({ msg_content: 'Done', msg_id: 'a1', timestamp: 3000 }),
    },
  ]
  const analyzed = analyzeMinimaxRows(rows, session)
  assert.equal(analyzed.title, 'Fix KONOHA')
  assert.equal(analyzed.cwd, 'C:\\Users\\me\\Documents\\apk')
  assert.deepEqual(
    analyzed.messages.map((message) => [message.role, message.text]),
    [
      ['user', 'Do it'],
      ['assistant', 'Done'],
    ],
  )
  assert.equal(analyzed.messages[1].provider, 'minimax')
  assert.equal(analyzed.messages[1].model, 'MiniMax-M3')
})

test('events are a contiguous, surface-safe turn log with a title', () => {
  const built = buildSessionEvents({
    title: 'Two turns',
    messages: [
      { role: 'user', text: 'first', time: 10 },
      { role: 'assistant', text: 'one', time: 20, provider: 'claude-code', model: 'claude' },
      { role: 'user', text: 'second', time: 30 },
      { role: 'assistant', text: 'two', time: 40, provider: 'claude-code', model: 'claude' },
    ],
  })
  assert.equal(built.turns, 2)
  assert.equal(built.messages, 4)
  assert.deepEqual(
    built.events.map((event) => event.seq),
    built.events.map((_, index) => index),
  )
  assert.equal(built.events.at(-1).type, 'session/title')
  assert.equal(built.events.at(-1).data.title, 'Two turns')
  assert.deepEqual(built.events.at(-1).data.source, { kind: 'fallback' })
  assert.equal(built.events.at(-1).data.messageSeqs.length, 1)
  for (const event of built.events) {
    if (event.type === 'user/message') {
      assert.equal(event.surfaceOp, 'append')
      assert.equal(typeof event.data.id, 'string')
      assert.ok(event.data.id.length > 0)
    }
    if (event.type === 'assistant/message') {
      assert.equal(event.surfaceOp, 'append')
      assert.equal(typeof event.data.message.id, 'string')
      assert.ok(event.data.message.id.length > 0)
    }
  }
  const assistant = built.events.find((event) => event.type === 'assistant/message')
  assert.equal(assistant.data.message.source.kind, 'model')
  assert.equal(assistant.data.message.source.provider, 'claude-code')
  assert.equal(Array.isArray(assistant.data.stream), true)
})

test('long bodies are truncated with a visible marker', () => {
  const built = buildSessionEvents({
    title: 'long',
    maxTextChars: 10,
    messages: [{ role: 'user', text: 'abcdefghijklmnop', time: 1 }],
  })
  const user = built.events.find((event) => event.type === 'user/message')
  assert.match(user.data.content[0].text, /abcdefghij/)
  assert.match(user.data.content[0].text, /truncated 6 characters/u)
})

test('empty conversations never produce an importable log', () => {
  const built = buildSessionEvents({
    title: '',
    messages: [
      { role: 'user', text: '<system-reminder>only context</system-reminder>', time: 1 },
    ],
  })
  assert.equal(built.messages, 0)
  // Only the title event remains, so the Host skips the session.
  assert.equal(built.events.length, 1)
  assert.equal(built.events[0].type, 'session/title')
})

test('titles stay plain; the source is a row logo', () => {
  const built = buildSessionEvents({
    title: 'Right-click interaction design',
    source: 'claude-code',
    messages: [{ role: 'user', text: 'hello', time: 1 }],
  })
  assert.equal(built.events.at(-1).data.title, 'Right-click interaction design')
  const minimax = buildSessionEvents({
    title: 'Fix KONOHA',
    source: 'minimax-code',
    messages: [{ role: 'user', text: 'hello', time: 1 }],
  })
  assert.equal(minimax.events.at(-1).data.title, 'Fix KONOHA')
})

test('workspace titles keep the last meaningful folder segment', () => {
  assert.equal(workspaceTitle('C:\\Users\\me\\Documents\\portfolio'), 'portfolio')
  assert.equal(workspaceTitle('C:\\Users\\me\\.minimax\\sessions\\mvs_123\\workspace'), 'mvs_123 workspace')
})

test('JSONL parsing ignores torn lines', () => {
  assert.deepEqual(parseJsonLines('{"a":1}\nnot json\n\n{"b":2}'), [{ a: 1 }, { b: 2 }])
})
