/**
 * Plugin identity, storage keys, limits and platform helpers.
 *
 * Everything whose value is part of the on-disk contract lives here; the
 * storage modules and the panel import it instead of repeating literals.
 */
/** Locale namespace of this plugin's copy (also binds the renderer's `t` prop). */
export const NS = 'dsh-sideby-note'
/** Sidebar launcher id and the main panel key it addresses. */
export const PANEL_ID = 'dsh-sideby-note'
/** Session-scoped memo store used by the popover and the session-header entry. */
export const SESSION_STORAGE_KEY = 'dsh.aside-note'
/** Notes shared by every session of one workspace; kept beside the session key. */
export const WORKSPACE_STORAGE_KEY = 'dsh.aside-note.workspaces'
/** Unsaved add/edit drafts, restored when the panel is reopened. */
export const DRAFT_STORAGE_KEY = 'dsh.aside-note.drafts'
/** Shown in the in-panel settings; keep in sync with package.json. */
export const PLUGIN_VERSION = '0.1.0'
export const PLUGIN_AUTHOR = '阿三石'
export const PLUGIN_REPO_URL = 'https://github.com/LighghtEeloo/dsh-sideby-note'
export const PLUGIN_REPO_LABEL = 'github.com/LighghtEeloo/dsh-sideby-note'
/** Last chosen list scope: the workspace list or the session list. */
export const SCOPE_MODE_KEY = 'dsh.aside-note.scope-mode'
export const SCOPE_MODE_DEFAULT = 'workspace'
/** Remembered expand/collapse state of the open/archived sections. */
export const SECTION_STATE_KEY = 'dsh.aside-note.sections'
export const SECTION_STATE_DEFAULT = { open: true, done: false }
/** How long the inline clear-completed confirmation waits before it dismisses itself. */
export const CLEAR_CONFIRM_MS = 5000
/** Persisted width of the experimental right-side panel. */
export const PANEL_WIDTH_KEY = 'dsh.aside-note.panel-width'
export const PANEL_DEFAULT_WIDTH = 360
export const PANEL_MIN_WIDTH = 280
export const PANEL_MAX_WIDTH = 720
/** Persisted height of the experimental right-side panel; 0 means content-sized. */
export const PANEL_HEIGHT_KEY = 'dsh.aside-note.panel-height'
export const PANEL_MIN_HEIGHT = 240
/** A note is meant to stay brief; this is the hard cap. */
export const MAX_TEXT = 280
/** Defensive cap so a corrupted store cannot freeze the panel. */
export const MAX_ITEMS = 300
