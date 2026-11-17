/** The add box: draft persistence, auto-grow and the composer key gestures. */
import React from 'react'
import { MAX_TEXT } from '../constants'
import { clearAddDraft, readScopeDrafts, saveAddDraft } from '../storage/drafts'
import { uid } from '../domain/id'

export function useComposerDraft({ draftKey, commit, report }) {
  const key = draftKey ? String(draftKey) : ''
  const [draft, setDraft] = React.useState(() => readScopeDrafts(key).add)
  const addRef = React.useRef(null)
  const composingRef = React.useRef(false)

  const resizeAdd = node => {
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${node.scrollHeight + 2}px`
  }

  React.useEffect(() => {
    resizeAdd(addRef.current)
  }, [draft])

  // Opening the panel focuses the composer on pointer devices only: on touch
  // the same focus raises the software keyboard before the user asked for it.
  const hasFinePointer = () => (
    typeof window.matchMedia !== 'function' || window.matchMedia('(hover: hover) and (pointer: fine)').matches
  )

  React.useLayoutEffect(() => {
    const node = addRef.current
    if (!node) return
    if (!hasFinePointer()) return
    node.focus()
    const end = node.value.length
    try {
      node.setSelectionRange(end, end)
    } catch {
      /* selection APIs are best effort */
    }
  }, [])

  const add = () => {
    const text = draft.trim().slice(0, MAX_TEXT)
    if (!text) return
    const now = Date.now()
    const ok = commit(currentItems => [{ id: uid(), text, done: false, createdAt: now, updatedAt: now }, ...currentItems])
    // The draft is only cleared once the note is actually stored.
    if (!ok) {
      report('saveFailed')
      return
    }
    setDraft('')
    clearAddDraft(key)
  }

  /**
   * Replace the composer with a recalled note and put the caret at its end.
   *
   * This is the only text editor for a note: the row leaves the list and its
   * text lands here, where the user can change it and submit it again.
   */
  const recall = text => {
    const value = String(text || '').slice(0, MAX_TEXT)
    setDraft(value)
    saveAddDraft(key, value)
    window.requestAnimationFrame(() => {
      const node = addRef.current
      if (!node) return
      // Touch keeps its soft keyboard closed until the field itself is tapped.
      if (hasFinePointer()) {
        node.focus()
        const end = node.value.length
        try {
          node.setSelectionRange(end, end)
        } catch {
          /* selection APIs are best effort */
        }
      }
      resizeAdd(node)
    })
  }

  const onDraftChange = event => {
    const value = event.target.value
    setDraft(value)
    saveAddDraft(key, value)
    resizeAdd(event.target)
  }

  /**
   * Match the main composer: Enter adds the note, Shift+Enter keeps the
   * textarea's native line break, and Enter that belongs to an IME candidate
   * pick is left to the browser. A held Enter must not add note after note.
   */
  const onDraftKeyDown = event => {
    const composing = event.isComposing || (event.nativeEvent && event.nativeEvent.isComposing)
    if (event.key === 'Escape') {
      event.currentTarget.blur()
      return
    }
    if (event.key !== 'Enter') return
    if (composing) return
    if (event.shiftKey) return
    if (event.altKey || (typeof event.getModifierState === 'function' && event.getModifierState('AltGraph'))) {
      event.preventDefault()
      return
    }
    event.preventDefault()
    if (event.repeat) return
    add()
  }

  return { draft, addRef, composingRef, add, recall, onDraftChange, onDraftKeyDown }
}
