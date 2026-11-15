/** Segmented switch between the workspace list and the session list. */
import React from 'react'
import { withTooltip } from './primitives'

const h = React.createElement

export function ScopeSwitch(props) {
  const { say, mode, canUseSession, onChange } = props
  const options = [
    { value: 'workspace', label: say('scope.workspace') },
    // The session list appears only after the new session actually starts;
    // until then the workspace list is the only list it can show.
    ...(canUseSession ? [{ value: 'session', label: say('scope.session') }] : []),
  ]
  return h(
    'div',
    { className: 'dsh-an-scope', role: 'group', 'aria-label': say('scope.label') },
    options.map(option => h(
      React.Fragment,
      { key: option.value },
      withTooltip(
        option.value === 'session'
          ? say('scope.sessionHint')
          : canUseSession ? say('scope.workspaceHint') : say('scope.newSessionHint'),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-an-scopeBtn',
            'data-scope-mode': option.value,
            'data-active': mode === option.value ? 'true' : undefined,
            'aria-pressed': mode === option.value,
            onClick: () => onChange(option.value),
          },
          option.label,
        ),
      ),
    )),
  )
}
