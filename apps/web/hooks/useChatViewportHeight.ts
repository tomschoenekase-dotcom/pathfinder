'use client'

import { useEffect, useState } from 'react'

/** Mobile keyboards can shrink the visual viewport without changing CSS dvh. */
export function useChatViewportHeight() {
  const [viewportRect, setViewportRect] = useState<
    { height: number; offsetTop: number; offsetLeft: number } | undefined
  >()

  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    let active = true
    const update = () => {
      if (!active) return
      const editing = document.activeElement instanceof HTMLTextAreaElement
      // Pinch zoom is a reading action; do not reflow the chat for it.
      const keyboardOpen =
        editing && viewport.scale === 1 && viewport.height < window.innerHeight - 80
      const nextViewportRect = keyboardOpen
        ? {
            height: Math.round(viewport.height),
            offsetTop: Math.round(viewport.offsetTop),
            offsetLeft: Math.round(viewport.offsetLeft),
          }
        : undefined
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
    }
    const afterFocus = () => queueMicrotask(update)
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update)
    document.addEventListener('focusin', afterFocus)
    document.addEventListener('focusout', afterFocus)
    update()
    return () => {
      active = false
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update)
      document.removeEventListener('focusin', afterFocus)
      document.removeEventListener('focusout', afterFocus)
    }
  }, [])

  return viewportRect
}
