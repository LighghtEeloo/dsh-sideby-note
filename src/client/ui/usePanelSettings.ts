/** Inline settings: the forward lead-in, persisted as it changes. */
import React from 'react'
import { clearForwardPrefix, readForwardPrefix, writeForwardPrefix } from '../storage/prefs'

export function usePanelSettings() {
  const [showSettings, setShowSettings] = React.useState(false)
  const [forwardPrefix, setForwardPrefix] = React.useState(readForwardPrefix)
  const prefixRef = React.useRef(null)

  // The prefix field starts one line tall and grows with wrapped content up to
  // a six-line cap, then scrolls. Re-measure whenever the value changes or the
  // card remounts.
  React.useLayoutEffect(() => {
    const node = prefixRef.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(138, node.scrollHeight + 2)}px`
  }, [forwardPrefix, showSettings])

  const changeForwardPrefix = value => {
    const next = String(value || '').slice(0, 80)
    setForwardPrefix(next)
    writeForwardPrefix(next)
  }

  // Removing the key (not writing "") restores the localized default; an empty
  // stored value stays a deliberate "no prefix".
  const resetForwardPrefix = () => {
    setForwardPrefix(null)
    clearForwardPrefix()
  }

  return {
    showSettings,
    setShowSettings,
    forwardPrefix,
    changeForwardPrefix,
    resetForwardPrefix,
    prefixRef,
  }
}
