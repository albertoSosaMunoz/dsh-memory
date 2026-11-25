/**
 * Integration tests for MemoryStore against a disposable database.
 *
 * Skips (does not fail) when MongoDB is not reachable, so `npm test` stays
 * meaningful on a machine without the container running.
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MemoryStore } from '../lib/store.mjs'
import {
  MONGO_URI,
  dropDatabase,
  makeConfig,
  mongoAvailable,
  uniqueDb,
} from './helpers.mjs'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const available = await mongoAvailable()
const skip = available ? false : `MongoDB is not reachable at ${MONGO_URI}`

const WORKSPACE_A = 'C:/proj/alfa'
const WORKSPACE_B = 'C:/proj/beta'
const DOC_A = 'En el proyecto alfa el tomate se cultiva en invernadero y se riega por goteo.'
const DOC_B = 'En el proyecto beta el tomate se importa congelado y se guarda en camara.'
const DOC_OTHER_DIM = 'tomate tomate tomate tomate medido en sesenta y cuatro dimensiones.'

let shared = null

async function setup() {
  if (shared) return shared
  const database = uniqueDb('store')
  const store = new MemoryStore(makeConfig({ database }), quiet)
  await store.start()
  const scoped = new MemoryStore(makeConfig({ database, scope: 'workspace' }), quiet)
  await scoped.start()
  const otherDim = new MemoryStore(makeConfig({ database, dim: 64 }), quiet)
  await otherDim.start()

  await store.capture({
    sessionId: 's-a', seq: 1, role: 'user', text: DOC_A,
    workspace: WORKSPACE_A, project: 'alfa',
  })
  await store.capture({
    sessionId: 's-b', seq: 1, role: 'user', text: DOC_B,
    workspace: WORKSPACE_B, project: 'beta',
  })
  await store.saveNote({
    text: 'Preferencia global: el usuario responde en español y usa el puerto 30018.',
    kind: 'fact', workspace: WORKSPACE_A, project: 'alfa', global: true,
  })
  await otherDim.capture({
    sessionId: 's-dim', seq: 1, role: 'user', text: DOC_OTHER_DIM,
    workspace: WORKSPACE_A, project: 'alfa',
  })

  shared = { database, store, scoped, otherDim }
  return shared
}

after(async () => {
  if (!shared) return
  await Promise.all([shared.store, shared.scoped, shared.otherDim].map((s) => s.close()))
  await dropDatabase(MONGO_URI, shared.database)
})

test('start reaches ready and creates indexes', { skip }, async () => {
  const { store } = await setup()
  assert.equal(store.ready, true)
  assert.equal(store.backend, 'external')
  const names = (await store.collection.indexes()).map((index) => index.name)
  for (const expected of ['dedupe', 'recent', 'text_es']) {
    assert.ok(names.includes(expected), `missing index ${expected}`)
  }
})

test('capture is idempotent per (sessionId, seq)', { skip }, async () => {
  const { store } = await setup()
  const before = await store.collection.countDocuments({ dedupeKey: 's-a:1' })
  await store.capture({
    sessionId: 's-a', seq: 1, role: 'user',
    text: 'texto distinto que no debe reemplazar al original',
    workspace: WORKSPACE_A, project: 'alfa',
  })
  assert.equal(await store.collection.countDocuments({ dedupeKey: 's-a:1' }), before)
  const stored = await store.collection.findOne({ dedupeKey: 's-a:1' })
  assert.equal(stored.text, DOC_A)
})

test('capture drops text below captureMinChars', { skip }, async () => {
  const { store } = await setup()
  const result = await store.capture({
    sessionId: 's-short', seq: 1, role: 'user', text: 'corto',
    workspace: WORKSPACE_A, project: 'alfa',
  })
  assert.equal(result, null)
  assert.equal(await store.collection.countDocuments({ dedupeKey: 's-short:1' }), 0)
})

test('capture stores an explicit createdAt', { skip }, async () => {
  const { store } = await setup()
  const when = '2026-01-02T03:04:05.000Z'
  await store.capture({
    sessionId: 's-time', seq: 1, role: 'user',
    text: 'documento con fecha histórica explícita',
    workspace: WORKSPACE_A, project: 'alfa', createdAt: when,
  })
  const stored = await store.collection.findOne({ dedupeKey: 's-time:1' })
  assert.equal(new Date(stored.createdAt).toISOString(), when)
})

test('global scope recalls both workspaces', { skip }, async () => {
  const { store } = await setup()
  const hits = await store.search({ text: 'tomate', workspace: WORKSPACE_A, limit: 10 })
  const texts = hits.map((hit) => hit.text)
  assert.ok(texts.includes(DOC_A), 'missing alfa document')
  assert.ok(texts.includes(DOC_B), 'missing beta document under global scope')
})

test('workspace scope does not leak other projects', { skip }, async () => {
  const { scoped } = await setup()
  const hits = await scoped.search({ text: 'tomate', workspace: WORKSPACE_A, limit: 10 })
  const texts = hits.map((hit) => hit.text)
  assert.ok(texts.includes(DOC_A), 'missing same-workspace document')
  assert.ok(!texts.includes(DOC_B), 'leaked a document from another workspace')
  assert.ok(!texts.includes(DOC_OTHER_DIM), 'leaked a foreign-dimension document')
})

test('workspace scope keeps global notes visible', { skip }, async () => {
  const { scoped } = await setup()
  const hits = await scoped.search({ text: 'puerto 30018', workspace: WORKSPACE_B, limit: 10 })
  assert.ok(
    hits.some((hit) => hit.text.includes('español')),
    'a global note must stay visible from any workspace',
  )
})

test('vectors from another dimension are never scored', { skip }, async () => {
  const { store } = await setup()
  const hits = await store.search({ text: 'tomate dimensiones', limit: 20 })
  assert.ok(!hits.some((hit) => hit.text === DOC_OTHER_DIM))
  assert.ok(hits.every((hit) => hit.cosine === 0 || Number.isFinite(hit.cosine)))
})

test('pinned notes surface for related queries', { skip }, async () => {
  const { store } = await setup()
  const hits = await store.search({ text: '¿qué idioma y puerto prefiere el usuario?', limit: 5 })
  const pinned = hits.find((hit) => hit.text.includes('español'))
  assert.ok(pinned, 'pinned note was not recalled')
  assert.equal(pinned.pinned, true)
  assert.equal(pinned.role, 'note')
})

test('forget removes one document and is idempotent', { skip }, async () => {
  const { store } = await setup()
  const created = await store.capture({
    sessionId: 's-forget', seq: 1, role: 'user',
    text: 'documento destinado a ser borrado en el test',
    workspace: WORKSPACE_A, project: 'alfa',
  })
  assert.equal(created, 's-forget:1')
  const stored = await store.collection.findOne({ dedupeKey: 's-forget:1' })
  assert.equal(await store.forget(String(stored._id)), true)
  assert.equal(await store.forget(String(stored._id)), false)
  assert.equal(await store.forget('not-an-id'), false)
})

test('stats reports a consistent snapshot', { skip }, async () => {
  const { store } = await setup()
  const stats = await store.stats()
  assert.equal(stats.ready, true)
  assert.equal(stats.database, store.config.database)
  assert.equal(stats.dim, 1024)
  assert.ok(stats.documents >= 4)
  assert.ok(stats.pinned >= 1)
  assert.ok(stats.lastCaptureAt)
})

test('status.json is written to the configured path and tagged', { skip }, async () => {
  const { store, database } = await setup()
  await store.writeStatus()
  const status = JSON.parse(readFileSync(store.statusPath, 'utf8'))
  assert.equal(status.ok, true)
  assert.equal(status.role, 'test')
  assert.equal(status.database, database)
  assert.equal(status.pid, process.pid)
  assert.equal(status.phase, 'ready')
  assert.notEqual(store.statusPath, `${process.env.USERPROFILE}\\.dsh\\memory\\status.json`)
})

test('an explicit save refreshes status.json immediately', { skip }, async () => {
  const { store } = await setup()
  await store.writeStatus()
  const before = JSON.parse(readFileSync(store.statusPath, 'utf8')).documents
  await store.saveNote({ text: 'Nota nueva que debe verse en status.json al momento.', kind: 'note' })
  const after = JSON.parse(readFileSync(store.statusPath, 'utf8'))
  assert.equal(after.documents, before + 1)
  assert.ok(after.lastCaptureAt, 'lastCaptureAt must not stay null after a save')
})

test('diagnosticsPath sits beside status.json', () => {
  const store = new MemoryStore(makeConfig(), quiet)
  assert.match(store.diagnosticsPath, /apply\.json$/)
  assert.equal(store.diagnosticsPath, store.statusPath.replace(/status\.json$/i, 'apply.json'))
})
