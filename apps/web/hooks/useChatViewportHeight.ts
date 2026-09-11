'use client'

import { useEffect, useState } from 'react'

/** Mobile keyboards can shrink the visual viewport without changing CSS dvh. */
export function useChatViewportHeight() {
  const [height, setHeight] = useState<number>()

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
      setHeight(keyboardOpen ? Math.round(viewport.height) : undefined)
    }
    const afterFocus = () => queueMicrotask(update)
    viewport.addEventListener('resize', update)
    window.addEventListener('resize', update)
    document.addEventListener('focusin', afterFocus)
    document.addEventListener('focusout', afterFocus)
    update()
    return () => {
      active = false
      viewport.removeEventListener('resize', update)
      window.removeEventListener('resize', update)
      document.removeEventListener('focusin', afterFocus)
      document.removeEventListener('focusout', afterFocus)
    }
  }, [])

  return height
}
