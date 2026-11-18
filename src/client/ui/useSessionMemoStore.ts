/** Notes for the active scope plus a synchronous writer that never invents state. */
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

/** Write the record the current scope renders; `base` is what this tab saw. */
function writeScope(scope, record, base) {
  return scope.kind === 'workspace'
    ? writeWorkspaceRecord(scope.id, record, base)
    : writeSessionRecord(scope.id, record, base)
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
  // reporting success for something the browser never stored.
  const commit = React.useCallback(updater => {
    const current = recordRef.current || { items: [], updatedAt: 0 }
    const base = current.items || []
    const nextItems = normalizeItems(updater(base))
    // Spread the current record so workspace-only fields (seededSessionIds)
    // survive an ordinary note edit.
    const next = { ...current, items: nextItems, updatedAt: Date.now() }
    // The store merges with the latest record, so a note another tab added while
    // this one was typing is not overwritten; `base` lets it tell this tab's
    // deletions apart from the other tab's additions.
    const ok = writeScope(scopeRef.current, next, base)
    setSyncError(!ok)
    if (!ok) return false
    // Render what was actually stored: the merge may have pulled in notes this
    // tab had not seen yet.
    const stored = readScope(scopeRef.current)
    recordRef.current = stored
    setRecord(stored)
    return true
  }, [])

  return { record, syncError, commit }
}

/** Per-session memos; kept for the session-only call sites. */
export function useSessionMemoStore(sessionId) {
  return useMemoStore({ kind: 'session', id: sessionId })
}
