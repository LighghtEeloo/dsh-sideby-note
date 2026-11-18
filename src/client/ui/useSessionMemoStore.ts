/** Notes for the active scope plus its writer, serialized per mounted panel. */
import React from 'react'
import { SESSION_STORAGE_KEY, WORKSPACE_STORAGE_KEY } from '../constants'
import { normalizeItems } from '../domain/items'
import { TODO_LISTENERS } from '../storage/events'
import { readSessionRecord, writeSessionRecord } from '../storage/session'
import { readWorkspaceRecord, writeWorkspaceRecord } from '../storage/workspace'

/** Read the record the current scope renders. */
function readScope(scope) {
  return scope.kind === 'workspace'
    ? readWorkspaceRecord(scope.id)
    : readSessionRecord(scope.id)
}

/** Write the record the current scope renders. */
function writeScope(scope, record) {
  return scope.kind === 'workspace'
    ? writeWorkspaceRecord(scope.id, record)
    : writeSessionRecord(scope.id, record)
}

/** Notes of one list (a workspace, or a single session) and their writer. */
export function useMemoStore(scope) {
  const kind = scope && scope.kind === 'workspace' ? 'workspace' : 'session'
  const id = scope && scope.id ? String(scope.id) : ''
  const scopeRef = React.useRef({ kind, id })
  scopeRef.current = { kind, id }

  const [record, setRecord] = React.useState(() => readScope(scopeRef.current))
  const [syncError, setSyncError] = React.useState(false)
  const recordRef = React.useRef(record)
  recordRef.current = record
  // A host write is durable-or-fail; two quick clicks must not compute from the
  // same stale list and clobber each other's result.
  const chainRef = React.useRef<Promise<unknown>>(Promise.resolve())

  React.useEffect(() => {
    setRecord(readScope(scopeRef.current))
    setSyncError(false)
  }, [kind, id])

  React.useEffect(() => {
    const onStorage = event => {
      if (event.key !== SESSION_STORAGE_KEY && event.key !== WORKSPACE_STORAGE_KEY) return
      setRecord(readScope(scopeRef.current))
    }
    const onLocal = () => setRecord(readScope(scopeRef.current))
    TODO_LISTENERS.add(onLocal)
    window.addEventListener('storage', onStorage)
    return () => {
      TODO_LISTENERS.delete(onLocal)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  // A failed write leaves the rendered record alone: the row the user just
  // deleted stays on screen next to the failure toast, instead of the panel
  // reporting success for something the store never accepted.
  const commit = React.useCallback(updater => {
    const run = chainRef.current.then(async () => {
      const current = recordRef.current || { items: [], updatedAt: 0 }
      const nextItems = normalizeItems(updater(current.items || []))
      // Spread the current record so workspace-only fields (seededSessionIds)
      // survive an ordinary note edit.
      const next = { ...current, items: nextItems, updatedAt: Date.now() }
      const ok = await writeScope(scopeRef.current, next)
      if (!ok) {
        setSyncError(true)
        return false
      }
      setSyncError(false)
      recordRef.current = next
      setRecord(next)
      return true
    })
    chainRef.current = run.then(() => undefined, () => undefined)
    return run
  }, [])

  return { record, syncError, commit }
}

/** Per-session memos; kept for the session-only call sites. */
export function useSessionMemoStore(sessionId) {
  return useMemoStore({ kind: 'session', id: sessionId })
}
