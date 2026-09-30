'use client'

import { useEffect, useState } from 'react'

/**
 * Opt-in readout for diagnosing iOS keyboard layout: visit any chat page with `?debugViewport=1`.
 * Nothing is sent anywhere and nothing is logged; it only reads live browser geometry.
 */
export function ViewportDebugOverlay() {
  const [enabled, setEnabled] = useState(false)
  const [text, setText] = useState('')
  const [top, setTop] = useState(4)

  useEffect(() => {
    setEnabled(new URLSearchParams(window.location.search).get('debugViewport') === '1')
  }, [])

  useEffect(() => {
    if (!enabled) return
    const rect = (el: Element | null) => {
      if (!el) return 'none'
      const r = el.getBoundingClientRect()
      return `y${Math.round(r.top)}-${Math.round(r.bottom)} h${Math.round(r.height)}`
    }
    const read = () => {
      const vv = window.visualViewport
      const shell = document.querySelector('[data-chat-shell]')
      // Follow the visible area so the readout is never behind the keyboard or off-screen.
      setTop(Math.round((vv?.offsetTop ?? 0) + 4))
      setText(
        [
          `innerHeight ${window.innerHeight}`,
          `vv.height ${vv ? Math.round(vv.height) : 'n/a'}`,
          `vv.offsetTop ${vv ? Math.round(vv.offsetTop) : 'n/a'}`,
          `vv.scale ${vv ? vv.scale : 'n/a'}`,
          `scrollY ${Math.round(window.scrollY)}`,
          `shell ${rect(shell)}`,
          `composer ${rect(document.querySelector('[data-chat-shell] textarea'))}`,
          `keyboard-open ${shell?.getAttribute('data-keyboard-open') ?? 'unset'}`,
        ].join('\n'),
      )
    }
    read()
    const vv = window.visualViewport
    const events: Array<[EventTarget, string]> = [
      [window, 'resize'],
      [window, 'scroll'],
      [document, 'focusin'],
      [document, 'focusout'],
    ]
    if (vv) events.push([vv, 'resize'], [vv, 'scroll'])
    for (const [target, name] of events) target.addEventListener(name, read)
    const observer = new MutationObserver(read)
    const shell = document.querySelector('[data-chat-shell]')
    if (shell)
      observer.observe(shell, { attributes: true, attributeFilter: ['data-keyboard-open'] })
    return () => {
      for (const [target, name] of events) target.removeEventListener(name, read)
      observer.disconnect()
    }
  }, [enabled])

  if (!enabled) return null
  return (
    <pre
      data-viewport-debug
      style={{
        position: 'fixed',
        left: 4,
        top,
        zIndex: 2147483647,
        margin: 0,
        padding: '4px 6px',
        font: '10px/1.3 ui-monospace, monospace',
        color: '#0f0',
        background: 'rgba(0,0,0,0.8)',
        pointerEvents: 'none',
        whiteSpace: 'pre',
      }}
    >
      {text}
    </pre>
  )
}
