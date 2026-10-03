'use client'

import { useEffect, useState } from 'react'

/** The keyboard counts as open once the visual viewport is this much shorter than the baseline. */
export const KEYBOARD_MIN_SHRINK = 80
/** After focus leaves the field, leftover document scroll is cleared once this close to baseline. */
export const KEYBOARD_RESTORE_TOLERANCE = 20
/** The transcript counts as "following the latest message" within this distance of its end. */
export const FOLLOW_LATEST_SLACK = 80

/**
 * Where the chat shell should sit, in layout-viewport CSS pixels. `undefined` means the shell's
 * stylesheet default (`position: fixed; inset: 0`) already matches what the visitor can see.
 */
export type ChatViewportRect = {
  height: number
  offsetTop: number
  offsetLeft: number
  /** A software keyboard is (very probably) covering part of the screen. Styling only. */
  keyboardOpen: boolean
}

/**
 * One layout model for the visitor chat on phones: **the shell is the visual viewport.**
 *
 * The shell is `position: fixed`, which places it in layout-viewport coordinates, and
 * `visualViewport.offsetTop/offsetLeft` are, by specification, the visual viewport's offset from
 * that same layout-viewport origin (MDN VisualViewport; WICG `fixed-to-keyboard` example). So the
 * shell's rectangle is read straight from the visual viewport — `top = offsetTop`,
 * `left = offsetLeft`, `height = height` — on every visual-viewport resize/scroll. Nothing else
 * compensates for the keyboard: no document scroll arithmetic, no padding, no transform, no
 * measured "correction".
 *
 * Why there is deliberately no measurement step: an earlier version compared the shell's
 * `getBoundingClientRect().top` with `offsetTop` and "corrected" the difference. Chrome reports
 * client rects of fixed elements relative to the layout viewport, but iOS WebKit reports them
 * relative to the *visual* viewport. On an iPhone that check therefore saw a residual equal to the
 * whole pan and added it a second time, leaving a blank band above a shell pushed down onto the
 * keyboard (evidence IMG_0341). Desktop/Playwright Chromium could never reproduce it.
 *
 * The rectangle is followed whether or not a field is focused, so a pan iOS leaves behind after
 * the keyboard closes (reported on iOS 26: `offsetTop` not returning to 0) still yields a visible,
 * correctly placed shell; once the viewport is back near its baseline and nothing is being edited,
 * leftover document scroll is cleared so the pan can settle to zero. While a field is focused the
 * hook never scrolls the document, so it cannot fight the scroll Safari uses to reveal the caret.
 *
 * Keyboard detection (used only for compact styling and for dismiss-on-send) compares against a
 * stable baseline — the largest unzoomed visual viewport height seen while nothing is being edited,
 * reset on orientation change — because recent iOS Safari shrinks `innerHeight` with the keyboard.
 *
 * Pinch zoom is a reading action: while `scale !== 1` the shell keeps its stylesheet geometry.
 *
 * If the transcript was following the latest message when the viewport changed height, it is
 * re-pinned to its end after layout, so recent conversation stays visible above the composer when
 * the keyboard opens and when it closes; a reader who scrolled up is left where they are.
 *
 * Inside an iframe the visual viewport is the frame's own and does not see the host's keyboard;
 * the hook then simply leaves the stylesheet geometry in place (see docs/implementation).
 */
export function useChatViewportHeight() {
  const [viewportRect, setViewportRect] = useState<ChatViewportRect | undefined>()

  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    let active = true
    let baselineHeight = 0
    let lastWidth = viewport.width ?? window.innerWidth
    let frame: number | undefined
    let pinTranscript = false
    let applied: ChatViewportRect | undefined

    const conversation = () =>
      document.querySelector<HTMLElement>('[data-chat-shell] [data-chat-conversation]')
    const followingLatest = () => {
      const node = conversation()
      if (!node) return false
      return node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_LATEST_SLACK
    }

    const update = () => {
      if (!active) return
      const editing = isEditableField(document.activeElement)
      const width = viewport.width ?? window.innerWidth
      const unzoomed = Math.abs(viewport.scale - 1) < 0.01
      if (width !== lastWidth && unzoomed) {
        // Orientation (or window) change: the old baseline no longer describes this layout.
        lastWidth = width
        baselineHeight = 0
      }
      if (!editing && unzoomed && viewport.height > baselineHeight) {
        baselineHeight = viewport.height
      }
      const baseline = baselineHeight || window.innerHeight
      const keyboardOpen = editing && unzoomed && viewport.height < baseline - KEYBOARD_MIN_SHRINK

      const offsetTop = Math.max(0, Math.round(viewport.offsetTop))
      const offsetLeft = Math.round(viewport.offsetLeft)
      const height = Math.round(viewport.height)
      const matchesStylesheet =
        offsetTop === 0 && offsetLeft === 0 && height >= Math.round(window.innerHeight)
      const next: ChatViewportRect | undefined =
        !unzoomed || (matchesStylesheet && !keyboardOpen)
          ? undefined
          : { height, offsetTop, offsetLeft, keyboardOpen }

      if (
        !editing &&
        unzoomed &&
        Math.abs(viewport.height - baseline) <= KEYBOARD_RESTORE_TOLERANCE &&
        (window.scrollY !== 0 || window.scrollX !== 0)
      ) {
        // Keyboard gone: release any scroll Safari applied to reveal the field.
        window.scrollTo(0, 0)
      }

      if (sameRect(applied, next)) return
      if ((applied?.height ?? null) !== (next?.height ?? null)) {
        // A real height change: remember whether the reader was following the latest message.
        pinTranscript = pinTranscript || followingLatest()
      }
      applied = next
      setViewportRect(next)
      if (pinTranscript && typeof requestAnimationFrame === 'function') {
        if (frame !== undefined) cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => {
          frame = undefined
          if (!active || !pinTranscript) return
          pinTranscript = false
          const node = conversation()
          if (node) node.scrollTop = node.scrollHeight
        })
      }
    }

    const onChange = () => update()
    // Focus changes are reported before the browser updates the viewport; read after them.
    const afterFocus = () => queueMicrotask(onChange)
    viewport.addEventListener('resize', onChange)
    viewport.addEventListener('scroll', onChange)
    window.addEventListener('resize', onChange)
    window.addEventListener('orientationchange', onChange)
    window.addEventListener('pageshow', onChange)
    document.addEventListener('visibilitychange', onChange)
    document.addEventListener('focusin', afterFocus)
    document.addEventListener('focusout', afterFocus)
    update()
    return () => {
      active = false
      if (frame !== undefined) cancelAnimationFrame(frame)
      viewport.removeEventListener('resize', onChange)
      viewport.removeEventListener('scroll', onChange)
      window.removeEventListener('resize', onChange)
      window.removeEventListener('orientationchange', onChange)
      window.removeEventListener('pageshow', onChange)
      document.removeEventListener('visibilitychange', onChange)
      document.removeEventListener('focusin', afterFocus)
      document.removeEventListener('focusout', afterFocus)
    }
  }, [])

  return viewportRect
}

function sameRect(a: ChatViewportRect | undefined, b: ChatViewportRect | undefined) {
  if (a === undefined || b === undefined) return a === b
  return (
    a.height === b.height &&
    a.offsetTop === b.offsetTop &&
    a.offsetLeft === b.offsetLeft &&
    a.keyboardOpen === b.keyboardOpen
  )
}

function isEditableField(element: Element | null) {
  if (element instanceof HTMLTextAreaElement) return true
  if (element instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color'].includes(
      element.type,
    )
  }
  return element instanceof HTMLElement && element.isContentEditable === true
}

/**
 * Whether submitting should dismiss the software keyboard. True when the chat shell has detected
 * an open keyboard, or — where the shell cannot measure it (an embedding iframe) — when the only
 * input is a coarse touch pointer with no hover, i.e. a phone. A desktop, or an iPad with a
 * trackpad/hardware keyboard, keeps focus in the composer.
 */
export function shouldDismissKeyboardOnSubmit(field: HTMLElement | null) {
  if (!field) return false
  if (field.closest('[data-chat-shell][data-keyboard-open]')) return true
  if (typeof window.matchMedia !== 'function') return false
  return (
    window.matchMedia('(hover: none) and (pointer: coarse)').matches &&
    !window.matchMedia('(any-pointer: fine)').matches
  )
}
