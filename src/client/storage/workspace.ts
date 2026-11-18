/**
 * Workspace-scoped notes.
 *
 * Stored under `WORKSPACE_STORAGE_KEY`, beside the session key, so adding
 * workspace lists never changes the shape of existing per-session data. One
 * list is shared by every session of a workspace. The first time a workspace
 * is seen, notes already written per session are folded in once;
 * `seededSessionIds` records that so a later delete is not undone by the merge
 * running again.
 */
import { WORKSPACE_STORAGE_KEY } from '../constants'
import { normalizeItems } from '../domain/items'
import { setAsideUnreadable, storage } from './codec'
import { notifyTodoChange } from './events'
import { mergeItems } from './merge'
import { readSessionStore } from './session'

const text = value => (value ? String(value) : '')
const bucket = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})

function seededOf(record) {
  const raw = record && record.seededSessionIds
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const next = []
  for (const value of raw) {
    const id = text(value)
    if (!id || seen.has(id)) continue
    seen.add(id)
    next.push(id)
  }
  return next
}

/** Empty workspace-note store. */
export function emptyWorkspaceStore() {
  return { version: 1, workspaces: {} }
}

/**
 * Read the workspace-note store; corrupt or unavailable reads as empty.
 * An unreadable payload is parked under `<key>.corrupt` before any write.
 */
export function readWorkspaceStore() {
  const ls = storage()
  if (!ls) return emptyWorkspaceStore()
  let raw
  try {
    raw = ls.getItem(WORKSPACE_STORAGE_KEY)
  } catch {
    return emptyWorkspaceStore()
  }
  if (!raw) return emptyWorkspaceStore()
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    setAsideUnreadable(WORKSPACE_STORAGE_KEY, raw)
    return emptyWorkspaceStore()
  }
  const workspaces = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.workspaces : undefined
  const broken = !parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || (workspaces !== undefined && (!workspaces || typeof workspaces !== 'object' || Array.isArray(workspaces)))
  if (broken) {
    setAsideUnreadable(WORKSPACE_STORAGE_KEY, raw)
    return emptyWorkspaceStore()
  }
  return { version: 1, workspaces: bucket(workspaces) }
}

/** Persist the whole workspace-note store. */
export function writeWorkspaceStore(store) {
  const ls = storage()
  if (!ls) return false
  try {
    ls.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({
      version: 1,
      workspaces: bucket(store && store.workspaces),
    }))
    notifyTodoChange()
    return true
  } catch {
    return false
  }
}

/** One workspace's memo record. */
export function readWorkspaceRecord(workspaceId) {
  const key = text(workspaceId)
  if (!key) return { items: [], updatedAt: 0, seededSessionIds: [] }
  const record = readWorkspaceStore().workspaces[key]
  return {
    items: normalizeItems(record && record.items),
    updatedAt: record && Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
    seededSessionIds: seededOf(record),
  }
}

/**
 * Persist one workspace's memo record, merged with the latest stored one.
 * `base` is the list this tab rendered; ids dropped from `record.items` are this
 * tab's deletions and are not resurrected.
 */
export function writeWorkspaceRecord(workspaceId, record, base = null) {
  const key = text(workspaceId)
  if (!key) return false
  const store = readWorkspaceStore()
  const previous = store.workspaces[key]
  const seededSource = Array.isArray(record.seededSessionIds) ? record : previous
  store.workspaces[key] = {
    workspaceId: key,
    updatedAt: Math.max(record.updatedAt || 0, previous && Number.isFinite(previous.updatedAt) ? previous.updatedAt : 0) || Date.now(),
    items: mergeItems(normalizeItems(previous && previous.items), normalizeItems(record.items), base),
    seededSessionIds: seededOf(seededSource),
  }
  return writeWorkspaceStore(store)
}

/**
 * Fold the member sessions' existing notes into the workspace list once.
 * Returns whether the store changed; repeated calls are cheap and idempotent.
 */
export function ensureWorkspaceRecord(workspaceId, sessionIds) {
  const key = text(workspaceId)
  if (!key) return false
  const workspaceStore = readWorkspaceStore()
  const previous = workspaceStore.workspaces[key]
  const seeded = new Set(seededOf(previous))
  const items = normalizeItems(previous && previous.items)
  const seen = new Set(items.map(item => item.id))
  let changed = !previous

  if (!changed && Array.isArray(sessionIds)) {
    for (const value of sessionIds) {
      const sessionId = text(value)
      if (!sessionId) continue
      if (!seeded.has(sessionId)) {
        changed = true
        break
      }
    }
  }

  if (!changed) return false

  const sessionStore = readSessionStore()
  for (const value of Array.isArray(sessionIds) ? sessionIds : []) {
    const sessionId = text(value)
    if (!sessionId || seeded.has(sessionId)) continue
    seeded.add(sessionId)
    changed = true
    const sessionRecord = sessionStore.sessions[sessionId]
    for (const item of normalizeItems(sessionRecord && sessionRecord.items)) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      items.push(item)
    }
  }

  return writeWorkspaceRecord(key, {
    items,
    updatedAt: previous && Number.isFinite(previous.updatedAt) ? previous.updatedAt : Date.now(),
    seededSessionIds: [...seeded],
  })
}
