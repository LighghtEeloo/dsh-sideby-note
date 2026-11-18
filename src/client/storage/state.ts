/**
 * Browser-side storage state shared by the facade modules.
 *
 * Two sources coexist by design: `localStorage` (the device-local state and
 * the pre-switch fallback) and the in-memory host snapshot. Reads stay
 * synchronous, so the UI keeps its current shape; this module is the single
 * place that answers "which one is authoritative right now".
 */
import { notifyTodoChange } from './events'

export type StorageMode = 'probing' | 'host' | 'local' | 'error'

export interface HostFailure {
  code: string
  message: string
  status?: number
}

/** Durable snapshot served by the host route. */
export interface HostData {
  sessions: Record<string, any>
  workspaces: Record<string, any>
  forwarded: Record<string, any>
  prefs: Record<string, any>
}

let mode: StorageMode = 'probing'
let data: HostData | null = null
let revision = 0
let failure: HostFailure | null = null
const pending = new Map<string, number>()

let channel: BroadcastChannel | null = null
let listening = false

/** Current mode; `probing` means boot has not decided yet. */
export function storageMode(): StorageMode {
  return mode
}

/** True while the host is (or must be) the only source: `host` and the error state after it. */
export function hostAuthoritative(): boolean {
  return mode === 'host' || mode === 'error'
}

export function setStorageMode(next: StorageMode) {
  mode = next
}

/** The last host failure, for the settings surface. */
export function storageFailure(): HostFailure | null {
  return failure
}

export function setStorageFailure(next: HostFailure | null) {
  failure = next
}

/** Replace the cache with a fresh host snapshot. */
export function hydrateHost(next: HostData, rev: number) {
  data = next
  if (Number.isFinite(rev) && rev > revision) revision = rev
}

/** Host snapshot, or null before hydration. */
export function hostData(): HostData | null {
  return data
}

/** One host table, or an empty map. */
export function hostTable(name: 'sessions' | 'workspaces' | 'forwarded'): Record<string, any> {
  return data?.[name] ?? {}
}

/** One host record, or undefined. */
export function hostRecord(name: 'sessions' | 'workspaces' | 'forwarded', key: string) {
  if (!key) return undefined
  return hostTable(name)[key]
}

/** Host preferences (user intent that travels with the notes). */
export function hostPrefs(): Record<string, any> {
  return data?.prefs ?? {}
}

export function hostRevision(): number {
  return revision
}

export function bumpHostRevision(rev: unknown) {
  if (typeof rev === 'number' && Number.isFinite(rev) && rev > revision) revision = rev
}

/** Merge one record into the cache and wake same-tab readers. */
export function applyHostRecord(name: 'sessions' | 'workspaces' | 'forwarded', key: string, value: any) {
  if (!data || !key) return
  if (value === undefined) delete data[name][key]
  else data[name][key] = value
  notifyTodoChange()
}

/** Replace cached preferences and wake readers. */
export function applyHostPrefs(prefs: Record<string, any>) {
  if (!data) return
  data.prefs = prefs && typeof prefs === 'object' ? prefs : {}
  notifyTodoChange()
}

/** Mark one key busy so a remote broadcast cannot stomp an in-flight write. */
export function beginPending(key: string) {
  pending.set(key, (pending.get(key) ?? 0) + 1)
}

export function endPending(key: string) {
  const count = (pending.get(key) ?? 0) - 1
  if (count > 0) pending.set(key, count)
  else pending.delete(key)
}

export function isPending(key: string) {
  return (pending.get(key) ?? 0) > 0
}

function ensureChannel(): BroadcastChannel | null {
  if (channel) return channel
  if (typeof BroadcastChannel !== 'function') return null
  try {
    channel = new BroadcastChannel('dsh-aside-note')
  } catch {
    channel = null
  }
  return channel
}

/** Tell other tabs of this browser about one already-durable change. */
export function broadcastRecord(
  name: 'sessions' | 'workspaces' | 'forwarded',
  key: string,
  value: any,
  rev: unknown,
) {
  ensureChannel()?.postMessage({ kind: 'record', name, key, value, rev })
}

export function broadcastPrefs(prefs: Record<string, any>, rev: unknown) {
  ensureChannel()?.postMessage({ kind: 'prefs', prefs, rev })
}

/**
 * Listen for same-browser tab updates once. BroadcastChannel is optional (jsdom
 * and older runtimes), so a missing implementation only loses that nicety.
 */
export function startCrossTabSync() {
  if (listening) return
  const bus = ensureChannel()
  if (!bus) return
  listening = true
  bus.onmessage = event => {
    const message = event?.data
    if (!message || typeof message !== 'object' || mode !== 'host') return
    bumpHostRevision(message.rev)
    if (message.kind === 'prefs') {
      if (!isPending('prefs')) applyHostPrefs(message.prefs)
      return
    }
    if (message.kind === 'record' && typeof message.name === 'string' && typeof message.key === 'string') {
      const table = message.name as 'sessions' | 'workspaces' | 'forwarded'
      if (!['sessions', 'workspaces', 'forwarded'].includes(table)) return
      if (isPending(`${table}:${message.key}`)) return
      applyHostRecord(table, message.key, message.value)
    }
  }
}
