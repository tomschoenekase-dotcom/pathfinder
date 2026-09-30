'use client'

import { useEffect, useState } from 'react'

/** The keyboard counts as open once the visual viewport is this much shorter than the baseline. */
export const KEYBOARD_MIN_SHRINK = 80
/** After focus leaves the field, the pan is undone only once the viewport is this close to baseline. */
export const KEYBOARD_RESTORE_TOLERANCE = 20

/**
 * Mobile keyboards can shrink the visual viewport without changing CSS dvh. The shell is
 * `position: fixed` (layout-viewport coordinates), so it is placed from the visual viewport's real
 * edges: `top = offsetTop - scrollY` (clamped to 0) and `height = viewport.height`.
 *
 * Keyboard detection compares against a stable baseline (the largest visual viewport height seen
 * while no text field is focused, reset on orientation change), not `window.innerHeight`, because
 * recent iOS Safari can shrink `innerHeight` together with the visual viewport.
 *
 * While a textarea is focused this hook never scrolls the document, so it cannot undo the scroll
 * Safari uses to reveal the field. Any leftover scroll is cleared only after focus leaves and the
 * viewport is back near its baseline.
 */
export function useChatViewportHeight() {
  const [viewportRect, setViewportRect] = useState<
    { height: number; offsetTop: number; offsetLeft: number } | undefined
  >()

  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    let active = true
    let baselineHeight = 0
    let lastWidth = viewport.width ?? window.innerWidth
    let frame: number | undefined

    const update = (fromRetry = false) => {
      if (!active) return
      const focused = document.activeElement
      const editing = focused instanceof HTMLTextAreaElement
      const width = viewport.width ?? window.innerWidth
      if (width !== lastWidth && viewport.scale === 1) {
        // Orientation (or window) change: the old baseline no longer describes this layout.
        lastWidth = width
        baselineHeight = 0
      }
      if (!editing && viewport.scale === 1 && viewport.height > baselineHeight) {
        baselineHeight = viewport.height
      }
      const baseline = baselineHeight || window.innerHeight
      // Pinch zoom is a reading action; do not reflow the chat for it.
      const keyboardOpen =
        editing && viewport.scale === 1 && viewport.height < baseline - KEYBOARD_MIN_SHRINK
      const nextViewportRect = keyboardOpen
        ? {
            height: Math.round(viewport.height),
            offsetTop: Math.max(0, Math.round(viewport.offsetTop - (window.scrollY || 0))),
            offsetLeft: Math.round(viewport.offsetLeft),
          }
        : undefined
      if (
        !editing &&
        Math.abs(viewport.height - baseline) <= KEYBOARD_RESTORE_TOLERANCE &&
        (window.scrollY !== 0 || window.scrollX !== 0)
      ) {
        window.scrollTo(0, 0)
      }
      setViewportRect((current) => {
        if (!nextViewportRect) return current ? undefined : current
        if (
          current?.height === nextViewportRect.height &&
          current.offsetTop === nextViewportRect.offsetTop &&
          current.offsetLeft === nextViewportRect.offsetLeft
        )
          return current
        return nextViewportRect
      })
      if (keyboardOpen && !fromRetry && typeof requestAnimationFrame === 'function') {
        // Keep the caret visible: if the field still ends below the visible area, measure once more.
        if (frame !== undefined) cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => {
          frame = undefined
          const field = document.activeElement
          if (!active || !(field instanceof HTMLTextAreaElement)) return
          if (field.getBoundingClientRect().bottom > viewport.offsetTop + viewport.height)
            update(true)
        })
      }
    }
    const onChange = () => update()
    const afterFocus = () => queueMicrotask(onChange)
    viewport.addEventListener('resize', onChange)
    viewport.addEventListener('scroll', onChange)
    window.addEventListener('resize', onChange)
    window.addEventListener('scroll', onChange)
    document.addEventListener('focusin', afterFocus)
    document.addEventListener('focusout', afterFocus)
    update()
    return () => {
      active = false
      if (frame !== undefined) cancelAnimationFrame(frame)
      viewport.removeEventListener('resize', onChange)
      viewport.removeEventListener('scroll', onChange)
      window.removeEventListener('resize', onChange)
      window.removeEventListener('scroll', onChange)
      document.removeEventListener('focusin', afterFocus)
      document.removeEventListener('focusout', afterFocus)
    }
  }, [])

  return viewportRect
}
