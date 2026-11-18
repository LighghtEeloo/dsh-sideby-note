/** Note shape, ordering and relative time copy. */
import { MAX_TEXT } from '../constants'
import { uid } from './id'

/**
 * Stable id for a legacy record that never had one.
 *
 * A random id here would change on every read, so a write could merge the same
 * note twice under two ids. Hashing the authored fields keeps the id identical
 * across reads; genuinely identical duplicates are resolved by the caller's
 * `seen` check.
 */
function legacyId(text, createdAt, updatedAt) {
  let hash = 5381
  const source = `${text}\u0000${createdAt}\u0000${updatedAt}`
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) + hash + source.charCodeAt(index)) | 0
  }
  return `legacy-${(hash >>> 0).toString(36)}`
}

/**
 * Sanitize one session's notes. The store is user-editable, so treat
 * every field defensively and preserve the authored order.
 */
export function normalizeItems(items) {
  if (!Array.isArray(items)) return []
  const seen = new Set()
  const normalized = []
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const text = String(raw.text || '').trim().slice(0, MAX_TEXT)
    if (!text) continue
    let id = typeof raw.id === 'string' && raw.id ? raw.id : legacyId(text, raw.createdAt, raw.updatedAt)
    // A duplicated id must not become a random one, or every read would mint a
    // new identity and the next merge would keep both copies.
    if (seen.has(id)) id = legacyId(text, raw.createdAt, raw.updatedAt)
    if (seen.has(id)) id = uid()
    seen.add(id)
    const done = raw.done === true
    const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now()
    const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt
    normalized.push({
      id,
      text,
      done,
      createdAt,
      updatedAt,
      ...(done && Number.isFinite(raw.completedAt) ? { completedAt: raw.completedAt } : {}),
    })
  }
  return normalized
}

/** Relative age copy for a note's creation stamp. */
export function ageLabel(time, say, localeId) {
  const stamp = Number.isFinite(time) ? time : Date.now()
  const elapsed = Math.max(0, Date.now() - stamp)
  if (elapsed < 60 * 1000) return say('time.now')
  const minutes = Math.floor(elapsed / (60 * 1000))
  if (minutes < 60) return say('time.minutes', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return say('time.hours', { n: hours })
  const days = Math.floor(hours / 24)
  if (days < 7) return say('time.days', { n: days })
  try {
    return new Intl.DateTimeFormat(localeId, { month: 'short', day: 'numeric' }).format(stamp)
  } catch {
    return ''
  }
}

/**
 * Best-known completion stamp for a done note. Newer records carry
 * `completedAt`; older ones only have `updatedAt`, so fall back in order
 * until a finite time is found. Returns 0 when the item has no usable stamp.
 */
export function completedStamp(item) {
  if (!item) return 0
  const candidates = [item.completedAt, item.updatedAt, item.createdAt]
  for (const time of candidates) {
    if (Number.isFinite(time)) return time
  }
  return 0
}

/** Newest completion first; updatedAt then createdAt keep equal stamps stable. */
export function compareDoneItems(a, b) {
  const byCompletion = completedStamp(b) - completedStamp(a)
  if (byCompletion) return byCompletion
  const aUpdated = Number.isFinite(a && a.updatedAt) ? a.updatedAt : 0
  const bUpdated = Number.isFinite(b && b.updatedAt) ? b.updatedAt : 0
  if (aUpdated !== bUpdated) return bUpdated - aUpdated
  const aCreated = Number.isFinite(a && a.createdAt) ? a.createdAt : 0
  const bCreated = Number.isFinite(b && b.createdAt) ? b.createdAt : 0
  return bCreated - aCreated
}

/** Done notes show creation and completion age; open ones show creation age only. */
export function metaLabel(item, say, localeId) {
  const created = ageLabel(item && item.createdAt, say, localeId)
  if (!item || item.done !== true) return created
  const completed = completedStamp(item) || (item ? item.createdAt : 0)
  return say('time.createdDone', { created, completed: ageLabel(completed, say, localeId) })
}
