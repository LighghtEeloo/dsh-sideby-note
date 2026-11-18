/**
 * Workspace-scoped notes.
 *
 * One list is shared by every session of a workspace. The first time a
 * workspace is seen, notes already written per session are folded in once;
 * `seededSessionIds` records that so a later delete is not undone. After the
 * switch to host storage the fold runs on the host (`list.ensure`), where it is
 * atomic; before the switch it stays in the browser exactly as it was.
 */
import { WORKSPACE_STORAGE_KEY } from '../constants'
import { normalizeItems } from '../domain/items'
import { storage } from './codec'
import { notifyTodoChange } from './events'
import { commitList, ensureWorkspace } from './ops'
import { hostAuthoritative, hostRecord, hostTable, storageMode } from './state'
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
  return { version: 1, workspaces: {} as Record<string, any> }
}

/** Read the browser workspace store; corrupt or unavailable reads as empty. */
function readLocalStore() {
  const ls = storage()
  if (!ls) return emptyWorkspaceStore()
  try {
    const raw = ls.getItem(WORKSPACE_STORAGE_KEY)
    if (!raw) return emptyWorkspaceStore()
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyWorkspaceStore()
    return { version: 1, workspaces: bucket(parsed.workspaces) }
  } catch {
    return emptyWorkspaceStore()
  }
}

/** Read the workspace-note store from the authoritative medium. */
export function readWorkspaceStore() {
  if (hostAuthoritative()) return { version: 1, workspaces: { ...hostTable('workspaces') } }
  return readLocalStore()
}

/** Persist the whole browser workspace store. */
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
  if (hostAuthoritative()) {
    const record = hostRecord('workspaces', key)
    return {
      items: normalizeItems(record && record.items),
      updatedAt: record && Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
      seededSessionIds: seededOf(record),
    }
  }
  const record = readLocalStore().workspaces[key]
  return {
    items: normalizeItems(record && record.items),
    updatedAt: record && Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
    seededSessionIds: seededOf(record),
  }
}

/** Persist one workspace's memo record. */
export async function writeWorkspaceRecord(workspaceId, record) {
  const key = text(workspaceId)
  if (!key) return false
  if (storageMode() === 'error') return false
  if (storageMode() === 'host') {
    return commitList('workspace', key, normalizeItems(record && record.items))
  }
  const store = readLocalStore()
  const previous = store.workspaces[key]
  const seededSource = Array.isArray(record.seededSessionIds) ? record : previous
  store.workspaces[key] = {
    workspaceId: key,
    updatedAt: record.updatedAt || Date.now(),
    items: normalizeItems(record.items),
    seededSessionIds: seededOf(seededSource),
  }
  return writeWorkspaceStore(store)
}

/**
 * Fold the member sessions' existing notes into the workspace list once.
 * @returns resolution with whether the store changed / was accepted
 */
export async function ensureWorkspaceRecord(workspaceId, sessionIds) {
  const key = text(workspaceId)
  if (!key) return false
  if (storageMode() === 'error') return false
  if (storageMode() === 'host') return ensureWorkspace(key, Array.isArray(sessionIds) ? sessionIds : [])

  const workspaceStore = readLocalStore()
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
