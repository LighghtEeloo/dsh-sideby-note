/** One note: checkbox, the row actions and the forward mark. */
import React from 'react'
import { appendToConversation } from '../domain/forward'
import { copyText } from '../domain/clipboard'
import { metaLabel } from '../domain/items'
import { IconCheck, IconCopy, IconForward, IconRewind, withTooltip } from './primitives'

const h = React.createElement

export function TodoRow(props) {
  const { item, done, say, onToast, onToggle, onRecall, forwardPrefix, forwardPrefixFallback, forwarded = false, onForwarded, onUnforwarded } = props
  const [pending, setPending] = React.useState('')
  const mountedRef = React.useRef(true)

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const copy = async () => {
    if (pending) return
    setPending('copy')
    let ok = false
    try {
      ok = await copyText(item.text)
    } finally {
      if (mountedRef.current) setPending('')
    }
    if (!mountedRef.current) return
    // Settled outcome goes to the frame-wide toast, which outlives the panel.
    if (onToast) onToast(ok ? 'copied' : 'copyFailed')
  }

  const forward = () => {
    // A forwarded note toggles its mark off instead of staging the text again.
    if (forwarded) {
      if (onUnforwarded) onUnforwarded(item)
      if (onToast) onToast('unforwarded')
      return
    }
    // A null prefix means "not customized": resolve the localized default at
    // click time, so a language switch between render and click still wins.
    const prefix = forwardPrefix === null || forwardPrefix === undefined
      ? (typeof forwardPrefixFallback === 'function' ? forwardPrefixFallback() : '')
      : forwardPrefix
    if (!appendToConversation(item.text, prefix)) {
      if (onToast) onToast('forwardFailed')
      return
    }
    // Remember the forward so the button keeps its check after a reopen.
    if (onForwarded) onForwarded(item)
    if (onToast) onToast('forwarded')
  }

  // The checkbox is only the note's state: open or done. Forwarding never moves it.
  const toggleCheck = () => onToggle(item)

  const checked = done === true

  return h(
    'li',
    { className: done ? 'dsh-an-row dsh-an-rowDone' : 'dsh-an-row' },
    h(
      'button',
      {
        type: 'button',
        className: 'dsh-an-check',
        role: 'checkbox',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': say(done ? 'item.markOpen' : 'item.markDone'),
        onClick: toggleCheck,
      },
      h(
        'span',
        { className: 'dsh-an-checkCircle' },
        checked ? h(IconCheck, { size: 9 }) : null,
      ),
    ),
    h(
      'div',
      { className: 'dsh-an-itemBody' },
      h('div', { className: 'dsh-an-text' }, item.text),
      h(
        'div',
        { className: 'dsh-an-rowFoot' },
        h('span', { className: 'dsh-an-meta', title: metaLabel(item, say, props.localeId) }, metaLabel(item, say, props.localeId)),
        h(
          'div',
          { className: 'dsh-an-actions' },
          withTooltip(say('item.copy'), h(
            'button',
            {
              type: 'button',
              className: 'dsh-an-iconBtn',
              'aria-label': say('item.copy'),
              'aria-busy': pending === 'copy' ? 'true' : 'false',
              'data-loading': pending === 'copy' ? 'true' : undefined,
              onClick: copy,
            },
            h(IconCopy, null),
          )),
          // A completed note has nothing left to hand to the composer,
          // so the forward action is absent rather than disabled.
          done ? null : withTooltip(say(forwarded ? 'item.forwarded' : 'item.forward'), h(
            'button',
            {
              type: 'button',
              className: 'dsh-an-iconBtn',
              'aria-label': say(forwarded ? 'item.forwarded' : 'item.forward'),
              'data-forwarded': forwarded ? 'true' : undefined,
              onClick: forward,
            },
            h(IconForward, null),
            forwarded
              ? h('span', { className: 'dsh-an-forwardMark', 'aria-hidden': true }, h(IconCheck, { size: 8 }))
              : null,
          )),
          // 退回 is the only way back into the composer: the note leaves the
          // list and its text becomes the one editable buffer at the top.
          withTooltip(say('item.recall'), h(
            'button',
            {
              type: 'button',
              className: 'dsh-an-iconBtn',
              'aria-label': say('item.recall'),
              onClick: () => onRecall(item),
            },
            h(IconRewind, null),
          )),
        ),
      ),
    ),
  )
}
