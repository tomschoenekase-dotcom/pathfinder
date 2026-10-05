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
    // Recent events, newest first, so a screenshot taken right after a glitch shows its sequence.
    const log: string[] = []
    const started = performance.now()
    let lastEventAt = 0
    const read = (event?: Event) => {
      const vv = window.visualViewport
      const shell = document.querySelector('[data-chat-shell]')
      const composer = document.querySelector('[data-chat-shell] textarea')
      const shellRect = shell?.getBoundingClientRect()
      const composerRect = composer?.getBoundingClientRect()
      // Browsers disagree on the coordinate frame of a fixed element's client rect: Chrome uses
      // the layout viewport, iOS WebKit the visual viewport. Report which one this browser used
      // (a pinned shell measures 0 in the visual frame, offsetTop in the layout frame) and compute
      // the two decisive numbers in that frame. Residual: shell top vs visible top (0 = aligned).
      // Gap: empty space between composer and keyboard (small when correct).
      const offsetTop = vv?.offsetTop ?? 0
      const frame =
        vv && shellRect && offsetTop > 2
          ? Math.abs(shellRect.top) < 2
            ? 'visual'
            : Math.abs(shellRect.top - offsetTop) < 2
              ? 'layout'
              : 'unknown'
          : 'n/a'
      const visibleTop = frame === 'visual' ? 0 : offsetTop
      const residual = vv && shellRect ? Math.round(shellRect.top - visibleTop) : 'n/a'
      const gap =
        vv && composerRect ? Math.round(visibleTop + vv.height - composerRect.bottom) : 'n/a'
      if (event) {
        const field = document.activeElement?.tagName === 'TEXTAREA' ? 'F' : '-'
        const shellStyle = (shell as HTMLElement | null)?.style.height || 'auto'
        log.unshift(
          [
            `${Math.round(performance.now() - started)}`.padStart(6),
            `${event.target === vv ? 'vv.' : ''}${event.type}`.padEnd(10),
            field,
            `vv${vv ? Math.round(vv.height) : '?'}@${vv ? Math.round(vv.offsetTop) : '?'}`,
            `sh${shellStyle}`,
            `s${shellRect ? Math.round(shellRect.top) : '?'}-${shellRect ? Math.round(shellRect.bottom) : '?'}`,
            `c${composerRect ? Math.round(composerRect.bottom) : '?'}`,
          ].join(' '),
        )
        log.length = Math.min(log.length, 14)
      }
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
          `pinned ${shell?.getAttribute('data-viewport-pinned') ?? 'unset'}`,
          `offset-var ${(shell as HTMLElement | null)?.style.getPropertyValue('--chat-viewport-offset-y') || 'unset'}`,
          `rect-frame ${frame}`,
          `residual ${residual}`,
          `gap-above-keyboard ${gap}`,
          `motion ${shell?.getAttribute('data-keyboard-motion') ?? 'unset'}`,
          '-- ms event F(ocused) vv@top shellH shellTop-Bottom composerBottom --',
          ...log,
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
      [document, 'touchend'],
    ]
    if (vv) events.push([vv, 'resize'], [vv, 'scroll'])
    const noteEvent = () => {
      lastEventAt = performance.now()
    }
    for (const [target, name] of events) {
      target.addEventListener(name, read)
      target.addEventListener(name, noteEvent)
    }
    const observer = new MutationObserver(() => read(new Event('attr')))
    // Late samples show where the shell settles after an animation, without a tap to trigger them.
    const sampler = window.setInterval(() => {
      if (performance.now() - lastEventAt < 1200) read(new Event('tick'))
    }, 150)
    const shell = document.querySelector('[data-chat-shell]')
    if (shell)
      observer.observe(shell, {
        attributes: true,
        attributeFilter: ['data-keyboard-open', 'data-viewport-pinned', 'style'],
      })
    return () => {
      for (const [target, name] of events) {
        target.removeEventListener(name, read)
        target.removeEventListener(name, noteEvent)
      }
      window.clearInterval(sampler)
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
