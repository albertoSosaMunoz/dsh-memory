/**
 * Legacy wiring check, kept as a one-command sanity run.
 *
 * It boots the plugin against a THROWAWAY database and a TEMPORARY status file.
 * The previous version used the real `dsh_memory` database and overwrote
 * `~/.dsh/memory/status.json`, which made a failed host activation look "ready".
 * The full coverage now lives in `test/plugin.test.mjs` (`npm test`).
 */

import assert from 'node:assert/strict'
import * as plugin from '../index.mjs'
import { MONGO_URI, dropDatabase, makeConfig, mongoAvailable, uniqueDb } from '../test/helpers.mjs'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

if (!(await mongoAvailable())) {
  console.error(`wiring: MongoDB is not reachable at ${MONGO_URI}`)
  process.exit(1)
}

const database = uniqueDb('wiring')
const statusPath = makeConfig({ database }).statusPath
const tools = []
const sections = []
const listeners = new Map()
const prompt = { section: (section) => sections.push(section) }

const ctx = {
  logger: quiet,
  systemPrompt: prompt,
  on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, [])
    listeners.get(event).push(handler)
  },
  get: () => undefined, // force the ctx.inject path
  inject(_deps, callback) {
    callback({ systemPrompt: prompt })
  },
  tools: {
    register(tool) {
      tools.push(tool)
      return () => {}
    },
  },
}

let failed = false
try {
  plugin.apply(ctx, makeConfig({ database, statusPath }))

  const names = tools.map((tool) => tool.name).sort()
  console.log('registered tools:', names.join(', '))
  assert.deepEqual(names, ['memory_forget', 'memory_save', 'memory_search', 'memory_stats'])

  console.log('listeners:', [...listeners.keys()].join(', '))
  assert.ok(listeners.has('agent/pre-step'))
  assert.ok(listeners.has('session/event'))

  console.log('sections:', sections.map((section) => `${section.name}@${section.order}`).join(', '))
  assert.ok(sections.some((section) => section.name === 'dsh-memory' && section.order === 9600))

  for (const tool of tools) {
    assert.ok(tool.description.length > 20, `${tool.name}: description too short`)
    assert.equal(tool.parameters.type, 'object')
  }

  const stats = JSON.parse(await tools.find((tool) => tool.name === 'memory_stats').execute({}, {}))
  console.log('memory_stats ->', JSON.stringify(stats))
  assert.equal(stats.ready, true)
  assert.equal(stats.database, database)

  const found = await tools
    .find((tool) => tool.name === 'memory_search')
    .execute({ query: 'puerto mongodb' }, { agent: { session: { header: { cwd: 'C:/tmp' } } } })
  assert.equal(typeof found, 'string')

  console.log('\nWIRING CHECKS PASSED')
} catch (error) {
  failed = true
  console.error('\nWIRING FAILED:', error?.stack ?? error)
} finally {
  for (const handler of listeners.get('dispose') ?? []) await handler()
  await dropDatabase(MONGO_URI, database)
  process.exit(failed ? 1 : 0)
}
