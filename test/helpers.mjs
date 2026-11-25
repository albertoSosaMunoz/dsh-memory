/**
 * Shared test helpers.
 *
 * Every test uses a throwaway database and a temporary `status.json`, so a test
 * run can never touch `dsh_memory` or the real `~/.dsh/memory/status.json`.
 * That was the bug that made the plugin look `ready` while the host had never
 * imported it: `scripts/wiring.mjs` wrote both.
 */

import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from '../index.mjs'

export const MONGO_URI =
  process.env.MEMORY_URI ?? 'mongodb://127.0.0.1:30018/?directConnection=true'

export function uniqueDb(prefix = 'test') {
  return `dsh_memory_${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`
}

export function tempStatusPath() {
  // Ends in `status.json` on purpose: the store derives `apply.json` beside it
  // by replacing that suffix, so tests must use the same shape as production.
  return join(
    tmpdir(),
    `dsh-memory-${process.pid}-${randomBytes(4).toString('hex')}`,
    'status.json',
  )
}

/**
 * Full, validated plugin config (schemastery defaults included) pointed at a
 * disposable database. `vectorSearch: false` keeps the suite fast: it skips
 * Atlas index provisioning, and ranking still exercises cosine + text + recency.
 * `scripts/smoke.mjs` is the one that tests the real Atlas vector index.
 */
export function makeConfig(overrides = {}) {
  return Config({
    backend: 'external',
    mongoUri: MONGO_URI,
    vectorSearch: false,
    statusPath: tempStatusPath(),
    role: 'test',
    ...overrides,
  })
}

async function loadDriver() {
  const module = await import(new URL('../lib/mongodb.bundle.cjs', import.meta.url).href)
  return module.default ?? module
}

/** Drop a disposable database, ignoring an already-gone target. */
export async function dropDatabase(uri, name) {
  const { MongoClient } = await loadDriver()
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 })
  try {
    await client.connect()
    await client.db(name).dropDatabase()
  } finally {
    await client.close().catch(() => {})
  }
}

/** True when MongoDB answers; integration tests skip instead of failing. */
export async function mongoAvailable(uri = MONGO_URI) {
  const { MongoClient } = await loadDriver()
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
  })
  try {
    await client.connect()
    await client.db('admin').command({ ping: 1 })
    return true
  } catch {
    return false
  } finally {
    await client.close().catch(() => {})
  }
}
