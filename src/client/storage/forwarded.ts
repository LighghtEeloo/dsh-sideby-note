/** Per-list forwarded marks behind the forward button. */
import { FORWARDED_STORAGE_KEY } from '../constants'
import { storage } from './codec'
import { setForward } from './ops'
import { hostAuthoritative, hostRecord, storageMode } from './state'

/** Empty forwarded-flag store; shape is { version, sessions: { [listKey]: { [itemId]: true } } }. */
export function emptyForwardedStore() {
  return { version: 1, sessions: {} as Record<string, any> }
}

/** Read the browser forwarded store; corrupt or unavailable reads as empty. */
export function readForwardedStore() {
  const ls = storage()
  if (!ls) return emptyForwardedStore()
  try {
    const raw = ls.getItem(FORWARDED_STORAGE_KEY)
    if (!raw) return emptyForwardedStore()
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyForwardedStore()
    const sessions = parsed.sessions
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return emptyForwardedStore()
    return { version: 1, sessions }
  } catch {
    return emptyForwardedStore()
  }
}

export function writeForwardedStore(store) {
  const ls = storage()
  if (!ls) return false
  try {
    ls.setItem(FORWARDED_STORAGE_KEY, JSON.stringify(store))
    return true
  } catch {
    return false
  }
}

/** Keep only `true` flags on non-empty ids; anything else in the stored record is dropped. */
export function normalizeForwardedRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return {}
  const next = {}
  for (const [itemId, flag] of Object.entries(record)) {
    if (itemId && flag === true) next[itemId] = true
  }
  return next
}

/** Forwarded item ids of one list, as an id -> true map. */
export function readForwardedIds(sessionId) {
  const key = sessionId ? String(sessionId) : ''
  if (!key) return {}
  if (hostAuthoritative()) return normalizeForwardedRecord(hostRecord('forwarded', key))
  return normalizeForwardedRecord(readForwardedStore().sessions[key])
}

/** Remember that one note was forwarded; best effort, never blocks the send. */
export function markForwarded(sessionId, itemId) {
  const key = sessionId ? String(sessionId) : ''
  const id = itemId ? String(itemId) : ''
  if (!key || !id) return false
  if (storageMode() === 'error') return false
  if (storageMode() === 'host') return setForward(key, id, true)
  const store = readForwardedStore()
  store.sessions[key] = { ...normalizeForwardedRecord(store.sessions[key]), [id]: true }
  return writeForwardedStore(store)
}

/** Drop forwarded flags that can no longer be rendered (deleted or cleared notes). */
export function forgetForwarded(sessionId, itemIds) {
  const key = sessionId ? String(sessionId) : ''
  if (!key) return false
  const ids = Array.isArray(itemIds) ? itemIds : [itemIds]
  if (storageMode() === 'error') return false
  if (storageMode() === 'host') {
    let changed = false
    for (const rawId of ids) {
      const id = rawId ? String(rawId) : ''
      if (!id) continue
      if (!hostRecord('forwarded', key)?.[id]) continue
      setForward(key, id, false)
      changed = true
    }
    return changed
  }
  const store = readForwardedStore()
  const record = normalizeForwardedRecord(store.sessions[key])
  let changed = false
  for (const rawId of ids) {
    const id = rawId ? String(rawId) : ''
    if (!id || !record[id]) continue
    delete record[id]
    changed = true
  }
  if (!changed) return false
  if (Object.keys(record).length) store.sessions[key] = record
  else delete store.sessions[key]
  return writeForwardedStore(store)
}
