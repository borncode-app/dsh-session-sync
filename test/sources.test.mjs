import { inferProjectDirectory, isMinimaxSandbox } from '../lib/sources.mjs'
import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import os from 'node:os'
import test from 'node:test'
import assert from 'node:assert/strict'

test('the minimax sandbox pattern matches only session workspaces', () => {
  assert.equal(
    isMinimaxSandbox('C:\\Users\\me\\.minimax\\sessions\\mvs_123\\workspace'),
    true,
  )
  assert.equal(
    isMinimaxSandbox('C:\\Users\\me\\.minimax\\sessions\\mvs_123\\workspace\\sub'),
    false,
  )
  assert.equal(isMinimaxSandbox('C:\\Users\\me\\Documents\\portfolio'), false)
})

test('a filepath tag names the project folder', () => {
  const directory = inferProjectDirectory([
    { text: 'ทำต่อ <filepath>C:/FO3TH</filepath> ด้วย' },
  ])
  assert.equal(directory, 'C:\\FO3TH')
})

test('a path that runs into the sentence still resolves', () => {
  const directory = inferProjectDirectory([
    { text: 'Reverse the .big container format inside `C:\\FO3TH`, and deliver (a) a precise format specification' },
  ])
  assert.equal(directory, 'C:\\FO3TH')
})

test('the home directory, temp folder, and session sandboxes are refused', () => {
  assert.equal(inferProjectDirectory([{ text: `ดูที่ ${os.homedir()}` }]), undefined)
  assert.equal(
    inferProjectDirectory([{ text: 'อ่าน C:\\Users\\me\\AppData\\Local\\Temp\\handoff.md' }]),
    undefined,
  )
  assert.equal(
    inferProjectDirectory([
      { text: 'C:\\Users\\me\\.minimax\\sessions\\mvs_1\\workspace\\cleanyourtv-WebOS\\docs\\a.md' },
    ]),
    undefined,
  )
})

test('a missing folder resolves to nothing', () => {
  const missing = path.join(os.homedir(), 'no-such-folder-xyz', 'file.txt')
  assert.equal(inferProjectDirectory([{ text: missing }]), undefined)
})

test('an existing file resolves to its folder', () => {
  const packageDir = path.dirname(new URL('../package.json', import.meta.url).pathname.replace(/^\//u, ''))
  const file = path.join(packageDir, 'package.json')
  const directory = inferProjectDirectory([{ text: `ดูไฟล์ ${file}` }])
  assert.equal(directory, path.win32.normalize(packageDir))
})

test('a message without any path resolves to nothing', () => {
  assert.equal(inferProjectDirectory([{ text: 'ปลอดภัยไหม ฝังอะไรไหม?' }]), undefined)
})
