/** Row actions: toggle a note and take it back into the composer. */
export function useNoteActions({ commit, report, forgetForwardedItems }) {
  const toggle = item => {
    const ok = commit(currentItems => currentItems.map(candidate => {
      if (candidate.id !== item.id) return candidate
      const now = Date.now()
      return {
        ...candidate,
        done: !candidate.done,
        updatedAt: now,
        ...(candidate.done ? { completedAt: undefined } : { completedAt: now }),
      }
    }))
    if (!ok) report('saveFailed')
  }

  /**
   * Remove a note so its text can be recalled into the composer.
   *
   * A failed write keeps the row, its text and its forward flag exactly as
   * they were; the caller writes the recalled text only after this succeeds.
   */
  const takeBack = item => {
    const ok = commit(currentItems => currentItems.filter(candidate => candidate.id !== item.id))
    if (!ok) {
      report('saveFailed')
      return false
    }
    forgetForwardedItems(item.id)
    return true
  }

  return { toggle, takeBack }
}
