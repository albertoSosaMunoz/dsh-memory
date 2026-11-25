/**
 * Activation tests: does the plugin actually register what the model needs?
 *
 * `apply()` is driven with a minimal fake Cordis context, which is the exact
 * surface the real host provides: `tools.register`, `systemPrompt.section`,
 * `ctx.on(...)` and `ctx.inject(...)`. A green run here means the plugin cannot
 * silently mount "inactive": it either registers four tools and the prompt
 * section, or it throws.
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as plugin from '../index.mjs'
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

const cleanups = []

after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
})

function makeCtx({ exposePrompt = true, brokenPrompt = false } = {}) {
  const tools = []
  const sections = []
  const listeners = new Map()
  const prompt = brokenPrompt
    ? {
        section() {
          throw new Error('duplicate prompt section')
        },
      }
    : { section: (section) => sections.push(section) }

  const ctx = {
    logger: quiet,
    // Deliberately NOT `ctx.systemPrompt`: on a context that never injected the
    // service the property may be absent while `ctx.get()` still returns it.
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
    },
    get(name) {
      return exposePrompt && name === 'systemPrompt' ? prompt : undefined
    },
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

  const dispose = async () => {
    for (const handler of listeners.get('dispose') ?? []) await handler()
  }
  return { ctx, tools, sections, listeners, dispose }
}

const toolNamed = (harness, name) => {
  const tool = harness.tools.find((entry) => entry.name === name)
  assert.ok(tool, `tool ${name} was not registered`)
  return tool
}

/**
 * Boot one plugin instance on a disposable database, wait for its backend to
 * settle, and register cleanup. Waiting matters: `apply()` starts the store in
 * the background, so dropping the database too early would race the connection.
 */
async function boot(options = {}) {
  const database = uniqueDb('plugin')
  const config = makeConfig({ database, ...options })
  const harness = makeCtx({
    exposePrompt: options.exposePrompt ?? true,
    brokenPrompt: options.brokenPrompt ?? false,
  })
  plugin.apply(harness.ctx, config)

  cleanups.push(async () => {
    await harness.dispose()
    await dropDatabase(MONGO_URI, database)
  })

  const started = JSON.parse(await toolNamed(harness, 'memory_stats').execute({}, {}))
  assert.equal(started.ready, true, `store did not start: ${JSON.stringify(started)}`)

  return { ...harness, database, config }
}

const diagnosticsPath = (config) => config.statusPath.replace(/status\.json$/i, 'apply.json')

test('apply registers exactly the four memory tools', { skip }, async () => {
  const harness = await boot()
  const names = harness.tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, ['memory_forget', 'memory_save', 'memory_search', 'memory_stats'])
})

test('every tool exposes a model-facing schema', { skip }, async () => {
  const harness = await boot()
  for (const tool of harness.tools) {
    assert.ok(tool.description.length > 20, `${tool.name} description too short`)
    assert.equal(tool.parameters.type, 'object')
    assert.ok(tool.parameters.properties, `${tool.name} has no properties`)
    assert.ok(tool.output?.schema, `${tool.name} has no output schema`)
    assert.equal(typeof tool.execute, 'function')
  }
  const search = toolNamed(harness, 'memory_search')
  assert.ok(search.parameters.required.includes('query'))
})

test('apply registers the dsh-memory prompt section', { skip }, async () => {
  const harness = await boot()
  const section = harness.sections.find((entry) => entry.name === 'dsh-memory')
  assert.ok(section, 'prompt section was not registered')
  assert.equal(section.order, 9600)
  assert.ok(section.text.includes('memory_search'))
  assert.ok(section.text.includes('memory_save'))
})

test('apply registers the prompt section through ctx.inject too', { skip }, async () => {
  const harness = await boot({ exposePrompt: false })
  assert.ok(harness.sections.some((entry) => entry.name === 'dsh-memory'))
})

test('announce: false suppresses the prompt section', { skip }, async () => {
  const harness = await boot({ announce: false })
  assert.equal(harness.sections.length, 0)
})

test('apply subscribes to capture, recall and dispose events', { skip }, async () => {
  const harness = await boot()
  for (const event of ['session/event', 'agent/pre-step', 'dispose']) {
    assert.ok(harness.listeners.has(event), `missing listener for ${event}`)
  }
})

test('memory_stats reports the live backend', { skip }, async () => {
  const harness = await boot()
  const value = JSON.parse(await toolNamed(harness, 'memory_stats').execute({}, {}))
  assert.equal(value.ready, true)
  assert.equal(value.database, harness.database)
  assert.equal(value.dim, 1024)
  assert.equal(value.documents, 0)
})

test('save then search round-trips through the tools', { skip }, async () => {
  const harness = await boot()
  const exec = { agent: { session: { header: { cwd: 'C:/proj/alfa' } } } }

  const saved = await toolNamed(harness, 'memory_save').execute(
    { text: 'Decisión: el plugin de memoria usa el puerto 30018 y la base dsh_memory.', kind: 'fact' },
    exec,
  )
  assert.ok(saved.includes('Guardado'))

  const found = await toolNamed(harness, 'memory_search').execute(
    { query: '¿en qué puerto está la base de memoria?', limit: 5 },
    exec,
  )
  assert.ok(found.includes('30018'), `search did not recall the note:\n${found}`)
  assert.match(found, /^\[1\] /, 'results must be framed with a numbered header')
})

test('memory_forget answers for unknown ids instead of throwing', { skip }, async () => {
  const harness = await boot()
  const forget = toolNamed(harness, 'memory_forget')
  assert.ok((await forget.execute({ id: 'not-an-id' }, {})).includes('No se encontró'))
  assert.ok(
    (await forget.execute({ id: '507f1f77bcf86cd799439011' }, {})).includes('No se encontró'),
  )
})

test('memory_search never invents a memory on an empty store', { skip }, async () => {
  const harness = await boot()
  const value = await toolNamed(harness, 'memory_search').execute(
    { query: 'zzzqx inexistente zzzqx' },
    { agent: { session: { header: { cwd: 'C:/proj/alfa' } } } },
  )
  assert.ok(value.includes('Sin recuerdos'))
})

test('apply records every registration phase in apply.json', { skip }, async () => {
  const harness = await boot()
  const report = JSON.parse(readFileSync(diagnosticsPath(harness.config), 'utf8'))
  assert.equal(report.role, 'test')
  assert.equal(report.pid, process.pid)
  assert.deepEqual(report.failures, [], `unexpected failures: ${JSON.stringify(report.failures)}`)
  for (const expected of [
    'dispose',
    'capture',
    'recall',
    'tool:memory_search',
    'tool:memory_save',
    'tool:memory_forget',
    'tool:memory_stats',
    'announce',
  ]) {
    assert.ok(report.phases.includes(expected), `missing phase ${expected} in ${report.phases}`)
  }
})

test('a failing prompt section does not block tools or capture', { skip }, async () => {
  const harness = await boot({ brokenPrompt: true })

  // The prompt section threw, but the plugin still works.
  const names = harness.tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, ['memory_forget', 'memory_save', 'memory_search', 'memory_stats'])
  assert.ok(harness.listeners.has('session/event'), 'capture listener must survive')
  assert.ok(harness.listeners.has('agent/pre-step'), 'recall listener must survive')

  const report = JSON.parse(readFileSync(diagnosticsPath(harness.config), 'utf8'))
  assert.ok(report.failures.some((failure) => failure.phase === 'announce'))
  assert.ok(report.phases.includes('tool:memory_search'))
  assert.ok(report.phases.includes('capture'))
})
