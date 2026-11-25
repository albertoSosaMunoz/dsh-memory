/**
 * MongoDB persistence + automatic provisioning for dsh-memory.
 *
 * Backends:
 *  - `auto`     : Atlas Local in Docker when Docker responds, else local mongod.
 *  - `atlas`    : force Atlas Local (fail if Docker/container cannot be prepared).
 *  - `local`    : force a private `mongod` process on this machine.
 *  - `external` : connect to an already-running MongoDB, provision nothing.
 *
 * Provisioning is idempotent: missing image -> `docker pull`, missing/stale
 * container -> `docker start` or `docker run`, then wait for MongoDB and create
 * the `$vectorSearch` index. Progress lands in `~/.dsh/memory/status.json`.
 *
 * Ranking is hybrid: candidate generation uses `$vectorSearch` (Atlas) and/or
 * a classic `$text` index plus recency, then every candidate is reranked in
 * Node with
 *
 *   score = 0.62 * cosine + 0.28 * normalised textScore + 0.10 * recency
 *         (+0.08 when pinned)
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

// The DSH host installs a ResolutionRouter that rewrites bare specifiers to
// its own module tree and (on Node 24) breaks `createRequire(...).resolve`
// plus any profile-local package resolution. The MongoDB driver is therefore
// vendored as a single CJS bundle: only Node builtins are required at runtime,
// and those bypass the router.
const mongodbEntry = new URL('./mongodb.bundle.cjs', import.meta.url)
const mongodbModule = await import(mongodbEntry.href)
const mongodb = mongodbModule.default ?? mongodbModule
const { MongoClient, ObjectId } = mongodb
import {
  bufferToVector,
  cosine,
  embed,
  normalizeText,
  tokenize,
} from './embed.mjs'

export const COLLECTION = 'memories'

export function textHash(text) {
  return createHash('sha1').update(normalizeText(text).replace(/\s+/g, ' ').trim()).digest('hex')
}

export function clip(text, maxChars) {
  const value = String(text ?? '')
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function runProcess(file, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    let child
    try {
      child = spawn(file, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...(options.env ?? {}) },
      })
    } catch (error) {
      resolve({ code: -1, stdout, stderr: error.message })
      return
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      finish({ code: -1, stdout, stderr: `${stderr}\n(timeout after ${timeoutMs}ms)`.trim(), timedOut: true })
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => finish({ code: -1, stdout, stderr: error.message }))
    child.on('close', (code) => finish({ code, stdout, stderr }))
  })
}

export class MemoryStore {
  /**
   * @param {object} config - resolved plugin configuration.
   * @param {object} logger - Cordis-style logger.
   */
  constructor(config, logger) {
    this.config = config
    this.logger = logger ?? console
    this.client = null
    this.collection = null
    this.ready = false
    this.vectorIndexReady = false
    this.phase = 'starting'
    this.note = ''
    this.backend = 'unknown'
    this.error = null
    this.lastStatusWrite = 0
  }

  /**
   * Refresh `status.json` after a capture, at most once per interval. Captures
   * are frequent and `writeStatus()` runs count queries, so an unthrottled
   * refresh would add a round-trip per message; without any refresh the file
   * keeps reporting `documents: 0` long after the store has memories.
   */
  scheduleStatusRefresh(intervalMs = 15000) {
    if (!this.ready) return
    const now = Date.now()
    if (now - this.lastStatusWrite < intervalMs) return
    void this.writeStatus()
  }

  get statusPath() {
    if (this.config.statusPath) return this.config.statusPath
    return join(homedir(), '.dsh', 'memory', 'status.json')
  }

  /** Activation report that sits beside `status.json`. */
  get diagnosticsPath() {
    const base = this.statusPath
    return /status\.json$/i.test(base)
      ? base.replace(/status\.json$/i, 'apply.json')
      : `${base}.apply.json`
  }

  /**
   * Persist which registration phases succeeded and which failed, so a plugin
   * that mounts without tools can explain itself instead of failing silently.
   * Best effort: diagnostics must never break activation.
   */
  writeDiagnostics(data) {
    try {
      const target = this.diagnosticsPath
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, JSON.stringify(data, null, 2), 'utf8')
    } catch {
      // Diagnostic only.
    }
  }

  setPhase(phase, note = '') {
    this.phase = phase
    this.note = note
    this.logger.info?.(`memory: ${phase}${note ? ` (${note})` : ''}`)
    void this.writeStatus()
  }

  async start() {
    try {
      mkdirSync(dirname(this.config.mongoDbPath), { recursive: true })
      await this.provision()
      this.setPhase('connecting', this.config.mongoUri)
      this.client = await this.connectWithRetry(this.config.atlasStartTimeoutMs)
      const database = this.client.db(this.config.database)
      this.db = database
      this.collection = database.collection(COLLECTION)
      await this.ensureIndexes()
      await this.ensureVectorIndex()
      this.ready = true
      this.setPhase('ready', `${this.backend} · ${this.config.mongoUri}`)
      await this.writeStatus()
      return this
    } catch (error) {
      this.error = error
      this.setPhase('failed', error.message)
      await this.writeStatus()
      throw error
    }
  }

  // --------------------------------------------------------------- provision
  async provision() {
    const mode = this.config.backend
    if (mode === 'external') {
      this.backend = 'external'
      return
    }
    const docker = mode === 'atlas' || mode === 'auto' ? await this.dockerAvailable() : false
    if (docker) {
      this.backend = 'atlas-local'
      try {
        await this.ensureAtlas()
        return
      } catch (error) {
        if (mode === 'atlas') throw error
        this.logger.warn?.(`memory: Atlas Local unavailable (${error.message}); falling back to local mongod`)
        this.setPhase('atlas-failed', error.message)
      }
    } else if (mode === 'auto') {
      this.logger.warn?.('memory: Docker not available; using local mongod')
    }
    this.backend = 'local'
    await this.ensureLocalMongod()
  }

  async dockerAvailable() {
    const result = await runProcess('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 12_000 })
    if (result.code === 0 && result.stdout.trim()) return true
    if (await this.startDockerDesktop()) {
      const retry = await runProcess('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 12_000 })
      return retry.code === 0 && Boolean(retry.stdout.trim())
    }
    return false
  }

  async startDockerDesktop() {
    const path = this.config.dockerDesktopPath
    if (!path) return false
    try {
      this.setPhase('starting-docker', path)
      const child = spawn(path, [], { detached: true, stdio: 'ignore', windowsHide: true })
      child.on('error', () => {})
      child.unref()
    } catch {
      return false
    }
    const deadline = Date.now() + this.config.dockerStartTimeoutMs
    while (Date.now() < deadline) {
      await sleep(3000)
      const result = await runProcess('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 10_000 })
      if (result.code === 0 && result.stdout.trim()) return true
    }
    return false
  }

  async ensureAtlas() {
    const { atlasContainer: name, atlasImage: image, atlasVolume: volume } = this.config
    const inspect = await runProcess('docker', ['inspect', '-f', '{{.State.Running}}', name], { timeoutMs: 15_000 })
    if (inspect.code === 0) {
      if (inspect.stdout.trim() === 'true') {
        this.setPhase('container-running', name)
        return
      }
      this.setPhase('starting-container', name)
      const started = await runProcess('docker', ['start', name], { timeoutMs: 60_000 })
      if (started.code !== 0) throw new Error(`docker start ${name} failed: ${started.stderr.trim()}`)
      await this.waitForMongo()
      return
    }

    const imageInspect = await runProcess('docker', ['image', 'inspect', image], { timeoutMs: 20_000 })
    if (imageInspect.code !== 0) {
      this.setPhase('pulling-image', image)
      this.logger.info?.(`memory: pulling ${image} (first run only; this can take several minutes)`)
      const pulled = await runProcess('docker', ['pull', image], { timeoutMs: this.config.imagePullTimeoutMs })
      if (pulled.code !== 0) throw new Error(`docker pull ${image} failed: ${pulled.stderr.trim().slice(-400)}`)
    }

    this.setPhase('creating-container', name)
    const created = await runProcess('docker', [
      'run', '-d',
      '--name', name,
      '-p', `${this.config.mongoPort}:27017`,
      '-v', `${volume}:/data/db`,
      image,
    ], { timeoutMs: 120_000 })
    if (created.code !== 0) {
      const message = created.stderr.trim()
      if (!/already in use/i.test(message)) throw new Error(`docker run ${name} failed: ${message.slice(-400)}`)
    }
    await this.waitForMongo()
  }

  async waitForMongo() {
    this.setPhase('waiting-mongo', this.config.mongoUri)
    const deadline = Date.now() + this.config.atlasStartTimeoutMs
    while (Date.now() < deadline) {
      const client = await this.tryConnect(this.config.mongoUri)
      if (client) {
        await client.close().catch(() => {})
        return
      }
      await sleep(1200)
    }
    throw new Error(`MongoDB did not accept connections at ${this.config.mongoUri}`)
  }

  async ensureLocalMongod() {
    const direct = await this.tryConnect(this.config.mongoUri)
    if (direct) {
      await direct.close().catch(() => {})
      this.setPhase('local-running', this.config.mongoUri)
      return
    }
    if (!this.config.autoStartMongo) {
      throw new Error(`MongoDB unreachable at ${this.config.mongoUri} and autoStartMongo is disabled`)
    }
    this.setPhase('starting-local-mongod', this.config.mongoDbPath)
    mkdirSync(this.config.mongoDbPath, { recursive: true })
    mkdirSync(dirname(this.config.mongoLogPath), { recursive: true })
    try {
      const child = spawn(this.config.mongodPath, [
        '--dbpath', this.config.mongoDbPath,
        '--port', String(this.config.mongoPort),
        '--bind_ip', '127.0.0.1',
        '--logpath', this.config.mongoLogPath,
      ], { detached: true, stdio: 'ignore', windowsHide: true })
      child.on('error', () => {})
      child.unref()
    } catch (error) {
      throw new Error(`failed to spawn mongod: ${error.message}`)
    }
    const deadline = Date.now() + this.config.mongoStartTimeoutMs
    while (Date.now() < deadline) {
      await sleep(600)
      const client = await this.tryConnect(this.config.mongoUri)
      if (client) {
        await client.close().catch(() => {})
        return
      }
    }
    throw new Error(`mongod did not accept connections at ${this.config.mongoUri}`)
  }

  async connectWithRetry(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    let lastError = null
    while (Date.now() < deadline) {
      const client = await this.tryConnect(this.config.mongoUri)
      if (client) return client
      lastError = new Error(`MongoDB unreachable at ${this.config.mongoUri}`)
      await sleep(800)
    }
    throw lastError ?? new Error('MongoDB unreachable')
  }

  async tryConnect(uri) {
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 1500,
      connectTimeoutMS: 1500,
      appName: 'dsh-memory',
    })
    try {
      await client.connect()
      await client.db('admin').command({ ping: 1 })
      return client
    } catch {
      await client.close().catch(() => {})
      return null
    }
  }

  // ----------------------------------------------------------------- indexes
  async ensureIndexes() {
    const collection = this.collection
    await collection.createIndex({ dedupeKey: 1 }, { unique: true, name: 'dedupe' }).catch(() => {})
    await collection.createIndex({ createdAt: -1 }, { name: 'recent' }).catch(() => {})
    await collection.createIndex({ workspace: 1, createdAt: -1 }, { name: 'workspace_recent' }).catch(() => {})
    await collection.createIndex({ pinned: -1, createdAt: -1 }, { name: 'pinned' }).catch(() => {})
    await collection.createIndex({ textHash: 1 }, { name: 'text_hash' }).catch(() => {})
    try {
      await collection.createIndex(
        { text: 'text' },
        { name: 'text_es', default_language: 'spanish', weights: { text: 1 } },
      )
    } catch (error) {
      this.logger.warn?.(`memory: text index unavailable (${error.message})`)
    }
  }

  async ensureVectorIndex() {
    if (!this.config.vectorSearch || !['atlas-local', 'external'].includes(this.backend)) {
      this.vectorIndexReady = false
      return
    }
    const name = this.config.vectorIndex
    this.setPhase('creating-vector-index', name)
    const deadline = Date.now() + this.config.vectorIndexTimeoutMs
    let created = false
    let lastError = null

    // `mongot` (the Atlas Search process) may still be starting when the
    // mongod health check passes, so index management is retried, not assumed.
    while (Date.now() < deadline) {
      try {
        const collectionInfo = await this.db.listCollections({ name: COLLECTION }).toArray()
        if (collectionInfo.length === 0) await this.db.createCollection(COLLECTION)
        const indexes = await this.collection.listSearchIndexes().toArray()
        if (!indexes.some((index) => index.name === name)) {
          await this.db.command({
            createSearchIndexes: COLLECTION,
            indexes: [{
              name,
              type: 'vectorSearch',
              definition: {
                fields: [
                  { type: 'vector', path: 'embedding', numDimensions: this.config.dim, similarity: 'cosine' },
                  { type: 'filter', path: 'workspace' },
                  { type: 'filter', path: 'kind' },
                ],
              },
            }],
          })
        }
        created = true
        break
      } catch (error) {
        lastError = error
        await sleep(2500)
      }
    }

    if (!created) {
      this.logger.warn?.(`memory: vector index unavailable (${lastError?.message}); using text+recency candidates`)
      this.vectorIndexReady = false
      return
    }

    while (Date.now() < deadline) {
      const list = await this.collection.listSearchIndexes().toArray().catch(() => [])
      const index = list.find((entry) => entry.name === name)
      if (index && (index.queryable === true || index.status === 'READY')) {
        this.vectorIndexReady = true
        return
      }
      if (index && index.status === 'FAILED') {
        this.logger.warn?.(`memory: vector index build failed (${index.message ?? 'unknown'})`)
        this.vectorIndexReady = false
        return
      }
      await sleep(1500)
    }
    this.logger.warn?.('memory: vector index not ready in time; falling back to text+recency candidates')
    this.vectorIndexReady = false
  }

  // ---------------------------------------------------------------- capture
  async capture(input) {
    if (!this.ready) return null
    const text = clip(input.text, this.config.captureMaxChars)
    if (!text || text.length < this.config.captureMinChars) return null
    const hash = textHash(text)
    const dedupeKey = input.sessionId != null && input.seq != null
      ? `${input.sessionId}:${input.seq}`
      : `note:${hash}`
    const vector = embed(text, { dim: this.config.dim })
    const document = {
      dedupeKey,
      kind: input.kind ?? 'turn',
      role: input.role ?? 'user',
      text,
      textHash: hash,
      embedding: Array.from(vector, (value) => Math.round(value * 1e6) / 1e6),
      dim: this.config.dim,
      workspace: input.workspace ?? null,
      project: input.project ?? null,
      sessionId: input.sessionId ?? null,
      seq: input.seq ?? null,
      turn: input.turn ?? null,
      step: input.step ?? null,
      pinned: Boolean(input.pinned),
      global: Boolean(input.global),
      createdAt: input.createdAt ? new Date(input.createdAt) : new Date(),
    }
    try {
      await this.collection.updateOne({ dedupeKey }, { $setOnInsert: document }, { upsert: true })
      this.scheduleStatusRefresh()
      return dedupeKey
    } catch (error) {
      if (error?.code === 11000) {
        this.scheduleStatusRefresh()
        return dedupeKey
      }
      this.error = error
      throw error
    }
  }

  async saveNote(input) {
    const key = await this.capture({
      ...input,
      kind: input.kind === 'fact' ? 'fact' : 'note',
      role: 'note',
      pinned: input.pinned ?? true,
    })
    // An explicit save is a user action: reflect it in status.json right away.
    await this.writeStatus()
    return key
  }

  // ----------------------------------------------------------------- search
  async candidatesByVector(vector, limit) {
    if (!this.vectorIndexReady) return []
    try {
      return await this.collection.aggregate([
        {
          $vectorSearch: {
            index: this.config.vectorIndex,
            path: 'embedding',
            queryVector: Array.from(vector),
            numCandidates: Math.max(limit * 8, 120),
            limit,
          },
        },
        { $addFields: { vectorSearchScore: { $meta: 'vectorSearchScore' } } },
      ]).toArray()
    } catch (error) {
      this.logger.warn?.(`memory: $vectorSearch failed (${error.message}); using text candidates`)
      return []
    }
  }

  async candidatesByText(queryText, limit) {
    const tokens = tokenize(queryText).slice(0, 24)
    if (tokens.length === 0) return []
    try {
      return await this.collection.aggregate([
        { $match: { $text: { $search: tokens.join(' ') } } },
        { $addFields: { textScore: { $meta: 'textScore' } } },
        { $sort: { textScore: -1 } },
        { $limit: limit },
      ]).toArray()
    } catch (error) {
      this.logger.warn?.(`memory: text search failed (${error.message})`)
      return []
    }
  }

  async search(query) {
    if (!this.ready) return []
    const limit = Math.max(1, query.limit ?? this.config.recallTopK)
    const candidates = Math.max(limit * 4, this.config.recallCandidates)
    const vector = query.vector ?? embed(query.text, { dim: this.config.dim })
    const scoped = this.config.scope === 'workspace' && Boolean(query.workspace)
    const scopeFilter = scoped
      ? { $or: [{ workspace: query.workspace }, { global: true }, { workspace: null }] }
      : {}
    // `$vectorSearch` and the `$text` aggregation never see `scopeFilter`, so
    // every candidate is re-checked below. Without this, `scope: 'workspace'`
    // only constrained the recency pool and recall leaked other projects.
    const inScope = (document) =>
      !scoped ||
      Boolean(document.global) ||
      document.workspace == null ||
      document.workspace === query.workspace

    const pool = new Map()
    const textScores = new Map()
    const vectorScores = new Map()
    let maxText = 0

    const [byVector, byText] = await Promise.all([
      this.candidatesByVector(vector, candidates),
      this.candidatesByText(query.text, candidates),
    ])
    for (const document of byVector) {
      const key = String(document._id)
      if (!pool.has(key)) pool.set(key, document)
      vectorScores.set(key, document.vectorSearchScore ?? 0)
    }
    for (const document of byText) {
      const key = String(document._id)
      pool.set(key, document)
      textScores.set(key, document.textScore ?? 0)
      maxText = Math.max(maxText, document.textScore ?? 0)
    }

    try {
      const recent = await this.collection
        .find(scopeFilter)
        .sort({ createdAt: -1 })
        .limit(Math.min(40, candidates))
        .toArray()
      for (const document of recent) {
        const key = String(document._id)
        if (!pool.has(key)) pool.set(key, document)
      }
    } catch (error) {
      this.error = error
      throw error
    }

    const now = Date.now()
    const seenHashes = new Set()
    const scored = []
    for (const document of pool.values()) {
      if (!inScope(document)) continue
      // A vector from another dimension or embedder is not comparable; cosine()
      // would silently truncate to the shorter vector instead of failing.
      if (document.dim != null && document.dim !== this.config.dim) continue
      const key = String(document._id)
      const hash = document.textHash ?? key
      if (seenHashes.has(hash)) continue
      seenHashes.add(hash)
      const stored = bufferToVector(document.embedding)
      const similarity = stored ? cosine(vector, stored) : 0
      const lexical = maxText > 0 ? (textScores.get(key) ?? 0) / maxText : 0
      const ageDays = Math.max(0, (now - new Date(document.createdAt).getTime()) / 86_400_000)
      const recency = Math.exp(-ageDays / 45)
      let score = 0.62 * similarity + 0.28 * lexical + 0.1 * recency
      if (document.pinned) score += 0.08
      scored.push({
        id: String(document._id),
        kind: document.kind,
        role: document.role,
        text: document.text,
        workspace: document.workspace,
        project: document.project,
        sessionId: document.sessionId,
        pinned: Boolean(document.pinned),
        createdAt: document.createdAt,
        cosine: similarity,
        lexical,
        vectorSearchScore: vectorScores.get(key) ?? null,
        score,
      })
    }

    return scored
      .filter((hit) => hit.score >= this.config.recallMinScore || (hit.pinned && hit.cosine >= 0.08))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  async forget(id) {
    if (!this.ready) return false
    let objectId
    try {
      objectId = new ObjectId(id)
    } catch {
      return false
    }
    const result = await this.collection.deleteOne({ _id: objectId })
    const removed = result.deletedCount === 1
    if (removed) await this.writeStatus()
    return removed
  }

  async stats() {
    if (!this.ready) {
      return {
        ready: false,
        phase: this.phase,
        note: this.note,
        backend: this.backend,
        error: this.error?.message ?? null,
      }
    }
    const [documents, last, pinned] = await Promise.all([
      this.collection.countDocuments(),
      this.collection.find({}).sort({ createdAt: -1 }).limit(1).toArray(),
      this.collection.countDocuments({ pinned: true }),
    ])
    return {
      ready: true,
      phase: this.phase,
      backend: this.backend,
      uri: this.config.mongoUri,
      database: this.config.database,
      documents,
      pinned,
      lastCaptureAt: last[0]?.createdAt ?? null,
      dim: this.config.dim,
      vectorIndexReady: this.vectorIndexReady,
      scope: this.config.scope,
    }
  }

  async writeStatus() {
    try {
      this.lastStatusWrite = Date.now()
      mkdirSync(dirname(this.statusPath), { recursive: true })
      writeFileSync(this.statusPath, JSON.stringify({
        ok: this.ready,
        pid: process.pid,
        role: this.config.role ?? 'host',
        profile: process.env.DSH_PROFILE ?? null,
        phase: this.phase,
        note: this.note,
        backend: this.backend,
        updatedAt: new Date().toISOString(),
        ...(this.ready ? {} : { error: this.error?.message ?? null }),
        ...(this.ready ? await this.stats() : {}),
      }, null, 2), 'utf8')
    } catch {
      // Diagnostic only.
    }
  }

  async close() {
    this.ready = false
    if (this.client) {
      const client = this.client
      this.client = null
      await client.close().catch(() => {})
    }
  }
}

/** Extract plain text from a DSH message content block list. */
export function messageText(message) {
  if (!message || typeof message !== 'object' || !Array.isArray(message.content)) return ''
  const parts = []
  for (const block of message.content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}
