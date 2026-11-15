/**
 * Which list the panel is looking at.
 *
 * The dock captures the session currently on screen, and the workspace that
 * owns it. A session in a workspace can share that workspace's list; the
 * panel header switches between the workspace list and the session list, and a
 * session without a workspace always keeps the session list. A new session is
 * still blank: it has an id but no conversation yet, so only the workspace
 * list is exposed until its first turn makes the session list meaningful.
 * The binding is module state rather than React state because the header entry
 * is plain DOM and needs the same answer without a component tree.
 */

export type ScopeMode = 'workspace' | 'session'

export interface MemoScope {
  kind: 'workspace' | 'session'
  id: string
  title: string
  sessionIds: string[]
}

interface WorkspaceBinding {
  sessionId: string
  workspaceId: string
  title: string
  sessionIds: string[]
  /** False while the captured session is still the blank new-session draft. */
  ready: boolean
}

const EMPTY: WorkspaceBinding = { sessionId: '', workspaceId: '', title: '', sessionIds: [], ready: true }
let binding: WorkspaceBinding = EMPTY
let version = 0
const listeners = new Set<() => void>()

const text = value => (value ? String(value) : '')
const notify = () => {
  version += 1
  for (const listener of listeners) listener()
}

/** Subscribe to binding changes; used by the open panel to gain session scope. */
export function subscribeScope(listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Monotonic version of the binding, read by useSyncExternalStore. */
export function scopeVersion() {
  return version
}

/**
 * Resolve the workspace of the captured session; null clears the binding.
 * `ready` is false only when the session is still the blank new-session page.
 */
export function bindWorkspace(sessionId, workspace, ready = true) {
  const next: WorkspaceBinding = workspace
    ? {
        sessionId: text(sessionId),
        workspaceId: text(workspace.workspaceId),
        title: text(workspace.title),
        sessionIds: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.map(text).filter(Boolean) : [],
        ready: ready !== false,
      }
    : { ...EMPTY, sessionId: text(sessionId), ready: ready !== false }
  if (
    next.sessionId === binding.sessionId &&
    next.workspaceId === binding.workspaceId &&
    next.title === binding.title &&
    next.sessionIds.join('\u0000') === binding.sessionIds.join('\u0000') &&
    next.ready === binding.ready
  ) return false
  binding = next
  notify()
  return true
}

/** The workspace list available to this session, or null outside a workspace. */
export function workspaceScopeForSession(sessionId): MemoScope | null {
  const id = text(sessionId)
  if (id && binding.sessionId === id && binding.workspaceId) {
    return { kind: 'workspace', id: binding.workspaceId, title: binding.title, sessionIds: binding.sessionIds }
  }
  return null
}

/** Whether the captured session has moved past the blank new-session page. */
export function sessionReadyFor(sessionId) {
  const id = text(sessionId)
  if (!id || binding.sessionId !== id) return true
  return binding.ready
}

/** Whether the panel may offer the session list at all. */
export function canUseSessionScope(sessionId) {
  return Boolean(text(sessionId)) && sessionReadyFor(sessionId)
}

/** The list this session reads and writes under the chosen scope mode. */
export function scopeForSession(sessionId, mode: ScopeMode = 'workspace'): MemoScope {
  const workspace = workspaceScopeForSession(sessionId)
  // The session list is meaningful only after the session has a conversation;
  // a blank new session stays on the workspace list even if `session` was the
  // last chosen mode in another conversation.
  if (workspace && (mode !== 'session' || !sessionReadyFor(sessionId))) return workspace
  const id = text(sessionId)
  return { kind: 'session', id, title: '', sessionIds: id ? [id] : [] }
}

/** Stable key for the forward marks of one list. */
export function scopeKey(scope) {
  if (!scope || !scope.id) return ''
  return scope.kind === 'workspace' ? `ws:${scope.id}` : String(scope.id)
}

/**
 * Stable key for the drafts of a conversation.
 *
 * Drafts belong to the workspace, not to the tab the panel is showing: every
 * member conversation shares one buffer, so neither switching conversations
 * nor switching the workspace/session scope strands half-typed text. The save
 * itself still uses the scope selected at that moment. A session outside a
 * workspace keeps its own buffer.
 */
export function draftKeyForSession(sessionId) {
  const workspace = workspaceScopeForSession(sessionId)
  return workspace ? scopeKey(workspace) : text(sessionId)
}
