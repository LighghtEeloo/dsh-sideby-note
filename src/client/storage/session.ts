/**
 * Session-scoped notes in one localStorage record.
 *
 * The shape stays at v1: workspace notes now live under
 * `WORKSPACE_STORAGE_KEY`, so the session key existing users already have is
 * never rewritten into a new schema.
 */
import { SESSION_STORAGE_KEY } from '../constants'
import { normalizeItems } from '../domain/items'
import { setAsideUnreadable, storage } from './codec'
import { notifyTodoChange } from './events'
import { mergeItems } from './merge'

/** Empty note store. */
export function emptySessionStore() {
  return { version: 1, sessions: {} }
}

const bucket = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})

/**
 * Read the whole note store; corrupt or unavailable reads as empty.
 * An unreadable payload is parked under `<key>.corrupt` first, so the next
 * write cannot destroy the only copy of a user's notes.
 */
export function readSessionStore() {
  const ls = storage()
  if (!ls) return emptySessionStore()
  let raw
  try {
    raw = ls.getItem(SESSION_STORAGE_KEY)
  } catch {
    return emptySessionStore()
  }
  if (!raw) return emptySessionStore()
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    setAsideUnreadable(SESSION_STORAGE_KEY, raw)
    return emptySessionStore()
  }
  const sessions = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.sessions : undefined
  const broken = !parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || (sessions !== undefined && (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)))
  if (broken) {
    setAsideUnreadable(SESSION_STORAGE_KEY, raw)
    return emptySessionStore()
  }
  return { version: 1, sessions: bucket(sessions) }
}

/** Persist the whole session store; the single writer for this key. */
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
  const record = readSessionStore().sessions[key]
  return {
    items: normalizeItems(record && record.items),
    updatedAt: record && Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
  }
}

/**
 * Persist one session's memo record.
 *
 * The record is merged with the latest stored one instead of replacing it, so
 * a write from this tab cannot drop a note another tab added meanwhile. `base`
 * is the list this tab rendered; ids missing from `record.items` are this tab's
 * deletions and are not resurrected by the merge.
 */
export function writeSessionRecord(sessionId, record, base = null) {
  const key = sessionId ? String(sessionId) : ''
  if (!key) return false
  const store = readSessionStore()
  const previous = store.sessions[key]
  store.sessions[key] = {
    sessionId: key,
    updatedAt: Math.max(record.updatedAt || 0, previous && Number.isFinite(previous.updatedAt) ? previous.updatedAt : 0) || Date.now(),
    items: mergeItems(normalizeItems(previous && previous.items), normalizeItems(record.items), base),
  }
  return writeSessionStore(store)
}
