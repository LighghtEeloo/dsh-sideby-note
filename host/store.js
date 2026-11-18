/**
 * The host-side note store.
 *
 * The browser cannot touch `$DSH_HOME/storages`, so this module is the only
 * writer: it opens the `aside_note` domain lazily through `ctx.storageDomain`,
 * serves a whole-domain snapshot, and applies small mutations atomically
 * (`KvTable.update` + one local promise chain) so two tabs editing different
 * notes cannot clobber each other's whole record.
 */
import { DOMAIN_NAME, TABLES } from './constants.js'
import {
  normalizeForwardedRecord,
  normalizeItems,
  normalizeSessionRecord,
  normalizeWorkspaceRecord,
} from './normalize.js'

/** Stable failure vocabulary shared with the browser route. */
export class StoreError extends Error {
  /**
   * @param {string} code stable machine code
   * @param {string} message diagnostic prose
   * @param {number} [status] HTTP status the route maps to
   */
  constructor(code, message, status = 502) {
    super(message)
    this.name = 'StoreError'
    this.code = code
    this.status = status
    this.retryable = status === 503 || status === 502
  }
}

const OPEN_ATTEMPTS = 3
const OPEN_RETRY_MS = 80

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const text = value => (value ? String(value) : '')

function bad(message) {
  return new StoreError('STORE_BAD_REQUEST', message, 400)
}

function tableObject(table) {
  const out = {}
  for (const [key, value] of table.entries()) out[key] = value
  return out
}

function isEmptySnapshot(data) {
  return Object.keys(data.sessions).length === 0
    && Object.keys(data.workspaces).length === 0
    && Object.keys(data.forwarded).length === 0
    && data.prefs?.migration === undefined
}

/**
 * Create the store bound to one plugin context.
 * @param {{ get?: (name: string) => unknown }} ctx host context
 */
export function createStore(ctx) {
  return new Store(ctx)
}

class Store {
  /** @param {{ get?: (name: string) => unknown }} ctx */
  constructor(ctx) {
    this.ctx = ctx
    this.domain = undefined
    this.opening = undefined
    this.rev = 0
    this.closed = false
    /** Serializes read-modify-write mutations before they reach the domain chain. */
    this.chain = Promise.resolve()
  }

  /** Open (or reuse) the domain; rejects with a StoreError. */
  async ready() {
    return this.#domain()
  }

  /** Whole-domain snapshot for the browser's initial hydration. */
  async snapshot() {
    const domain = await this.#domain()
    const data = {
      sessions: tableObject(domain.table(TABLES.sessions)),
      workspaces: tableObject(domain.table(TABLES.workspaces)),
      forwarded: tableObject(domain.table(TABLES.forwarded)),
      prefs: domain.global.get() || {},
    }
    return {
      rev: this.rev,
      empty: isEmptySnapshot(data),
      data: structuredClone(data),
    }
  }

  /**
   * Apply one browser mutation. Operations are serialized locally so a
   * read-modify-write never races a sibling request.
   * @param {any} op
   */
  async apply(op) {
    if (this.closed) throw new StoreError('STORE_UNAVAILABLE', 'the note store is closed', 503)
    const run = this.chain.then(() => this.#apply(op))
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  /** Release the domain; safe to call repeatedly. */
  async close() {
    this.closed = true
    const domain = this.domain
    this.domain = undefined
    this.opening = undefined
    if (domain) {
      try {
        await domain.close()
      } catch {
        // A domain already gone is not a failure to report.
      }
    }
  }

  async #domain() {
    if (this.domain) return this.domain
    if (!this.opening) {
      this.opening = this.#open().then(async domain => {
        // Disposal can land while the domain is still opening; release it
        // instead of leaking an open unit after the plugin is gone.
        if (this.closed) {
          await domain.close().catch(() => undefined)
          throw new StoreError('STORE_UNAVAILABLE', 'the note store is closed', 503)
        }
        this.domain = domain
        return domain
      }).catch(error => {
        this.opening = undefined
        throw error
      })
    }
    return this.opening
  }

  async #open() {
    const facility = typeof this.ctx?.get === 'function' ? this.ctx.get('storageDomain') : undefined
    if (!facility || typeof facility.open !== 'function') {
      throw new StoreError('STORE_UNAVAILABLE', 'storage is not mounted in this profile', 503)
    }
    // Loaded lazily so a missing schema library degrades to STORE_UNAVAILABLE
    // without taking the update routes down with it.
    let createSpec
    try {
      ({ createSpec } = await import('./store-spec.js'))
    } catch (error) {
      throw new StoreError('STORE_UNAVAILABLE', `note schema is unavailable (${error?.message ?? error})`, 503)
    }
    let lastError
    for (let attempt = 0; attempt < OPEN_ATTEMPTS; attempt += 1) {
      try {
        return await facility.open(createSpec())
      } catch (error) {
        lastError = error
        // A hot re-apply can race the previous store's asynchronous close.
        if (error?.code !== 'already-open') break
        await delay(OPEN_RETRY_MS)
      }
    }
    const reason = lastError?.code ?? (lastError instanceof Error ? lastError.message : 'open failed')
    throw new StoreError('STORE_OPEN_FAILED', `${DOMAIN_NAME}.json cannot be opened (${reason})`, 503)
  }

  async #apply(op) {
    if (!op || typeof op !== 'object' || Array.isArray(op)) throw bad('operation body must be an object')
    const domain = await this.#domain()
    switch (op.op) {
      case 'list.patch':
        return this.#patchList(domain, op)
      case 'list.ensure':
        return this.#ensureWorkspace(domain, op)
      case 'forward.set':
        return this.#setForward(domain, op)
      case 'prefs.set':
        return this.#setPrefs(domain, op)
      case 'migrate':
        return this.#migrate(domain, op)
      default:
        throw bad(`unknown operation '${String(op.op)}'`)
    }
  }

  async #patchList(domain, op) {
    const key = text(op.listKey)
    if (!key) throw bad('listKey is required')
    const kind = op.kind === 'workspace' ? 'workspace' : op.kind === 'session' ? 'session' : ''
    if (!kind) throw bad("kind must be 'workspace' or 'session'")
    const table = domain.table(kind === 'workspace' ? TABLES.workspaces : TABLES.sessions)

    const deletes = new Set((Array.isArray(op.deletes) ? op.deletes : []).map(text).filter(Boolean))
    const upserts = Array.isArray(op.upserts) ? normalizeItems(op.upserts) : []
    const order = (Array.isArray(op.order) ? op.order : []).map(text).filter(Boolean)
    const current = table.get(key)
    const byId = new Map(normalizeItems(current?.items).map(item => [item.id, item]))
    for (const id of deletes) byId.delete(id)
    for (const item of upserts) byId.set(item.id, item)

    const ordered = []
    const seen = new Set()
    for (const id of order) {
      const item = byId.get(id)
      if (!item || seen.has(id)) continue
      seen.add(id)
      ordered.push(item)
    }
    // Items another tab added while this patch was in flight are kept; the
    // sender's order only decides position, never deletion by omission.
    for (const item of byId.values()) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      ordered.push(item)
    }

    const next = kind === 'workspace'
      ? normalizeWorkspaceRecord({ ...current, items: ordered, updatedAt: Date.now() }, key)
      : normalizeSessionRecord({ ...current, items: ordered, updatedAt: Date.now() }, key)
    await writeRecord(table, key, current, next)
    this.rev += 1
    return { rev: this.rev, record: next }
  }

  async #ensureWorkspace(domain, op) {
    const workspaceId = text(op.workspaceId)
    if (!workspaceId) throw bad('workspaceId is required')
    const sessions = domain.table(TABLES.sessions)
    const workspaces = domain.table(TABLES.workspaces)
    const current = workspaces.get(workspaceId)
    const seeded = new Set(Array.isArray(current?.seededSessionIds) ? current.seededSessionIds : [])
    const items = normalizeItems(current?.items)
    const visible = new Set(items.map(item => item.id))
    const memberIds = []
    const seenMembers = new Set()
    for (const value of Array.isArray(op.sessionIds) ? op.sessionIds : []) {
      const sessionId = text(value)
      if (!sessionId || seenMembers.has(sessionId)) continue
      seenMembers.add(sessionId)
      memberIds.push(sessionId)
    }

    let changed = current === undefined
    for (const sessionId of memberIds) {
      if (seeded.has(sessionId)) continue
      changed = true
      seeded.add(sessionId)
      for (const item of normalizeItems(sessions.get(sessionId)?.items)) {
        if (visible.has(item.id)) continue
        visible.add(item.id)
        items.push(item)
      }
    }
    if (!changed) {
      return { rev: this.rev, record: normalizeWorkspaceRecord(current, workspaceId) }
    }

    const next = normalizeWorkspaceRecord({
      items,
      updatedAt: Number.isFinite(current?.updatedAt) ? current.updatedAt : Date.now(),
      seededSessionIds: [...seeded],
      workspaceId,
    }, workspaceId)
    await writeRecord(workspaces, workspaceId, current, next)
    this.rev += 1
    return { rev: this.rev, record: next }
  }

  async #setForward(domain, op) {
    const key = text(op.listKey)
    const itemId = text(op.itemId)
    if (!key || !itemId) throw bad('listKey and itemId are required')
    const table = domain.table(TABLES.forwarded)
    const current = normalizeForwardedRecord(table.get(key))
    const on = op.on === true
    if (on === Boolean(current[itemId])) return { rev: this.rev, record: current }
    if (on) current[itemId] = true
    else delete current[itemId]
    if (Object.keys(current).length === 0) {
      await table.delete(key)
    } else {
      await writeRecord(table, key, table.get(key), current)
    }
    this.rev += 1
    return { rev: this.rev, record: current }
  }

  async #setPrefs(domain, op) {
    const patch = op.patch
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw bad('patch must be an object')
    const current = domain.global.get() || {}
    const next = { ...current, version: 1 }
    if ('scopeMode' in patch) {
      if (patch.scopeMode === 'session') next.scopeMode = 'session'
      else if (patch.scopeMode === 'workspace') next.scopeMode = 'workspace'
      else throw bad("scopeMode must be 'workspace' or 'session'")
    }
    if ('sendShortcut' in patch) {
      if (patch.sendShortcut === 'enter' || patch.sendShortcut === 'ctrl-enter') next.sendShortcut = patch.sendShortcut
      else throw bad("sendShortcut must be 'enter' or 'ctrl-enter'")
    }
    if ('forwardPrefix' in patch) {
      if (patch.forwardPrefix === null) delete next.forwardPrefix
      else if (typeof patch.forwardPrefix === 'string') next.forwardPrefix = patch.forwardPrefix.slice(0, 80)
      else throw bad('forwardPrefix must be a string or null')
    }
    await domain.global.set(next)
    this.rev += 1
    return { rev: this.rev, prefs: next }
  }

  async #migrate(domain, op) {
    const snapshot = op.snapshot
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw bad('snapshot must be an object')
    const current = domain.global.get() || {}
    if (current.migration?.complete === true) {
      return { rev: this.rev, migrated: 0, alreadyComplete: true }
    }
    const source = text(op.source) || 'localStorage'
    await domain.global.set({
      ...current,
      version: 1,
      migration: { complete: false, at: Date.now(), source },
    })

    const sessions = domain.table(TABLES.sessions)
    const workspaces = domain.table(TABLES.workspaces)
    const forwarded = domain.table(TABLES.forwarded)
    let migrated = 0

    for (const [sessionId, raw] of Object.entries(snapshot.sessions || {})) {
      const key = text(sessionId)
      if (!key) continue
      const next = normalizeSessionRecord(raw, key)
      if (await putIfChanged(sessions, key, next)) migrated += 1
    }
    for (const [workspaceId, raw] of Object.entries(snapshot.workspaces || {})) {
      const key = text(workspaceId)
      if (!key) continue
      const next = normalizeWorkspaceRecord(raw, key)
      if (await putIfChanged(workspaces, key, next)) migrated += 1
    }
    for (const [listKey, raw] of Object.entries(snapshot.forwarded || {})) {
      const key = text(listKey)
      if (!key) continue
      const next = normalizeForwardedRecord(raw)
      if (Object.keys(next).length === 0) continue
      if (await putIfChanged(forwarded, key, next)) migrated += 1
    }

    const merged = { ...current, version: 1 }
    const prefs = snapshot.prefs && typeof snapshot.prefs === 'object' ? snapshot.prefs : {}
    if (prefs.scopeMode === 'workspace' || prefs.scopeMode === 'session') merged.scopeMode = prefs.scopeMode
    if (prefs.sendShortcut === 'enter' || prefs.sendShortcut === 'ctrl-enter') merged.sendShortcut = prefs.sendShortcut
    if (typeof prefs.forwardPrefix === 'string') merged.forwardPrefix = prefs.forwardPrefix.slice(0, 80)
    await domain.global.set({
      ...merged,
      migration: { complete: true, at: Date.now(), source },
    })
    this.rev += 1
    return { rev: this.rev, migrated }
  }
}

/** Put a record only when it is absent or differs; keeps migration retries cheap. */
async function putIfChanged(table, key, value) {
  const current = table.get(key)
  if (current !== undefined && JSON.stringify(current) === JSON.stringify(value)) return false
  if (current === undefined) await table.put(key, value)
  else await table.update(key, () => value)
  return true
}

async function writeRecord(table, key, current, next) {
  if (current === undefined) await table.put(key, next)
  else await table.update(key, () => next)
}
