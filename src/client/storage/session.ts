/**
 * Session-scoped notes.
 *
 * Two media, one shape: while this browser is still on `localStorage` the
 * record lives under `SESSION_STORAGE_KEY`; after the one-way switch the same
 * record lives in the host snapshot's `sessions` table and writes go through
 * the host route. The workspace key is separate, so existing per-session data
 * is never rewritten into a new schema.
 */
import { SESSION_STORAGE_KEY } from '../constants'
import { normalizeItems } from '../domain/items'
import { storage } from './codec'
import { notifyTodoChange } from './events'
import { commitList } from './ops'
import { hostAuthoritative, hostRecord, hostTable, storageMode } from './state'

/** Empty note store. */
export function emptySessionStore() {
  return { version: 1, sessions: {} as Record<string, any> }
}

const bucket = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})

/** Read the browser store; corrupt or unavailable reads as empty. */
function readLocalStore() {
  const ls = storage()
  if (!ls) return emptySessionStore()
  try {
    const raw = ls.getItem(SESSION_STORAGE_KEY)
    if (!raw) return emptySessionStore()
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptySessionStore()
    return { version: 1, sessions: bucket(parsed.sessions) }
  } catch {
    return emptySessionStore()
  }
}

/** Read the whole note store from whichever medium is authoritative now. */
export function readSessionStore() {
  if (hostAuthoritative()) return { version: 1, sessions: { ...hostTable('sessions') } }
  return readLocalStore()
}

/** Persist the whole browser store; the single writer for the legacy key. */
export function writeSessionStore(store) {
  const ls = storage()
  if (!ls) return false
  try {
    ls.setItem(SESSION_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessions: bucket(store && store.sessions),
    }))
    notifyTodoChange()
    return true
  } catch {
    return false
  }
}

/** Read one session's memo record. */
export function readSessionRecord(sessionId) {
  const key = sessionId ? String(sessionId) : ''
  if (!key) return { items: [], updatedAt: 0 }
  if (hostAuthoritative()) {
    const record = hostRecord('sessions', key)
    return {
      items: normalizeItems(record && record.items),
      updatedAt: record && Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
    }
  }
  const record = readLocalStore().sessions[key]
  return {
    items: normalizeItems(record && record.items),
    updatedAt: record && Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
  }
}

/**
 * Persist one session's memo record.
 * @returns resolution with whether the write was accepted/durable
 */
export async function writeSessionRecord(sessionId, record) {
  const key = sessionId ? String(sessionId) : ''
  if (!key) return false
  if (storageMode() === 'error') return false
  if (storageMode() === 'host') {
    return commitList('session', key, normalizeItems(record && record.items))
  }
  const store = readLocalStore()
  store.sessions[key] = {
    sessionId: key,
    updatedAt: record.updatedAt || Date.now(),
    items: normalizeItems(record.items),
  }
  return writeSessionStore(store)
}
