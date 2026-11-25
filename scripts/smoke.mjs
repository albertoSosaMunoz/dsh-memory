/**
 * End-to-end smoke test for dsh-memory.
 *
 * Usage (from the plugin directory):
 *   node scripts/smoke.mjs                # provisions Atlas Local (Docker)
 *   MEMORY_BACKEND=local node scripts/smoke.mjs
 *   MEMORY_BACKEND=external node scripts/smoke.mjs   # assumes MongoDB on 30018
 *
 * It exercises provisioning, capture, dedupe, hybrid recall, notes, stats and
 * forget against a throwaway database (`dsh_memory_smoke`).
 */

import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../lib/store.mjs'

const backend = process.env.MEMORY_BACKEND ?? 'atlas'
const config = {
  backend,
  mongoUri: process.env.MEMORY_URI ?? 'mongodb://127.0.0.1:30018/?directConnection=true',
  database: 'dsh_memory_smoke',
  mongoPort: 30018,
  autoStartMongo: true,
  mongodPath: 'C:\\Program Files\\MongoDB\\Server\\7.0\\bin\\mongod.exe',
  mongoDbPath: `${process.env.USERPROFILE}\\.dsh\\mongo\\data`,
  mongoLogPath: `${process.env.USERPROFILE}\\.dsh\\mongo\\mongod.log`,
  mongoStartTimeoutMs: 25000,
  atlasImage: 'mongodb/mongodb-atlas-local:8.0',
  atlasContainer: 'dsh-memory-atlas',
  atlasVolume: 'dsh_memory_atlas',
  dockerDesktopPath: 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe',
  dockerStartTimeoutMs: 120000,
  atlasStartTimeoutMs: 90000,
  imagePullTimeoutMs: 900000,
  vectorSearch: true,
  vectorIndex: 'memory_vector',
  vectorIndexTimeoutMs: 90000,
  dim: 1024,
  scope: 'global',
  recallTopK: 6,
  recallMaxChars: 3500,
  recallMinScore: 0.16,
  recallCandidates: 80,
  recallTimeoutMs: 2500,
  captureMinChars: 12,
  captureMaxChars: 8000,
  // Never write the real status file: a smoke run must not look like an
  // activated host. This used to clobber `~/.dsh/memory/status.json`.
  role: 'test',
  statusPath: join(tmpdir(), 'dsh-memory-smoke-status.json'),
}

const store = new MemoryStore(config, console)
let failed = false

try {
  console.log(`\n== start (backend=${backend}) ==`)
  const started = Date.now()
  await store.start()
  console.log(`ready in ${Date.now() - started}ms · backend=${store.backend} · vectorIndexReady=${store.vectorIndexReady}`)

  await store.collection.deleteMany({})
  const samples = [
    { sessionId: 'smoke-1', seq: 1, role: 'user', text: 'El plugin de memoria guarda los recuerdos en MongoDB, en el puerto 30018, base dsh_memory.' },
    { sessionId: 'smoke-1', seq: 2, role: 'assistant', text: 'Decidimos no usar Ollama: el embedding se calcula dentro del plugin, sin depender de ningún proveedor.' },
    { sessionId: 'smoke-2', seq: 1, role: 'user', text: 'En el backoffice de demo-project usamos FilterPagTable y useTablePreferences para persistir columnas y orden.' },
    { sessionId: 'smoke-2', seq: 2, role: 'assistant', text: 'El despliegue de produccion se hace con Docker Compose y las credenciales viven en el gestor de secretos.' },
  ]
  for (const sample of samples) {
    await store.capture({ ...sample, workspace: 'C:/workspace/demo-project', project: 'demo-project' })
  }
  console.log(`captured ${await store.collection.countDocuments()} documents`)

  // Idempotent per (sessionId, seq).
  await store.capture({ ...samples[0], text: 'texto distinto que no debe reemplazar al original' })
  assert.equal(await store.collection.countDocuments(), samples.length, 'dedupe by session/seq failed')
  console.log('dedupe by session/seq: ok')

  const cases = [
    { query: '¿en qué puerto escucha mongodb?', expect: '30018' },
    { query: '¿usamos Ollama o un proveedor externo?', expect: 'Ollama' },
    { query: 'preferencias de columnas en las tablas del backoffice', expect: 'FilterPagTable' },
  ]
  for (const testCase of cases) {
    const hits = await store.search({ text: testCase.query, limit: 4 })
    console.log(`\nquery: ${testCase.query}`)
    for (const hit of hits) {
      console.log(`  ${hit.score.toFixed(3)} cos=${hit.cosine.toFixed(3)} lex=${hit.lexical.toFixed(2)} · ${hit.text.slice(0, 70)}`)
    }
    assert.ok(hits.length > 0, `no hits for: ${testCase.query}`)
    const found = hits.some((hit) => hit.text.includes(testCase.expect))
    assert.ok(found, `expected "${testCase.expect}" in results for: ${testCase.query}`)
  }

  // Explicit note, pinned, must surface.
  await store.saveNote({ text: 'El usuario prefiere respuestas en español y puertos 30000-30999 para servicios locales.', kind: 'fact', workspace: 'C:/workspace/demo-project', project: 'demo-project' })
  const noteHits = await store.search({ text: '¿qué idioma prefiere el usuario?', limit: 4 })
  assert.ok(noteHits.some((hit) => hit.text.includes('español')), 'pinned note not recalled')
  console.log('\npinned note recall: ok')

  const stats = await store.stats()
  console.log('stats:', JSON.stringify(stats))
  assert.ok(stats.documents >= samples.length + 1)

  const victim = noteHits.find((hit) => hit.text.includes('español'))
  assert.ok(await store.forget(victim.id), 'forget failed')
  assert.equal(await store.forget('not-an-id'), false)
  console.log('forget: ok')

  console.log('\nALL CHECKS PASSED')
} catch (error) {
  failed = true
  console.error('\nSMOKE TEST FAILED:', error?.stack ?? error)
} finally {
  try {
    await store.db?.dropDatabase()
  } catch { /* ignore */ }
  await store.close()
  process.exit(failed ? 1 : 0)
}
