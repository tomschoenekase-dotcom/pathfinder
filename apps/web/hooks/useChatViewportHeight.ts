'use client'

import { useEffect, useState } from 'react'

/** The keyboard counts as open once the visual viewport is this much shorter than the baseline. */
export const KEYBOARD_MIN_SHRINK = 80
/** After focus leaves the field, the pan is undone only once the viewport is this close to baseline. */
export const KEYBOARD_RESTORE_TOLERANCE = 20
/** A measured gap smaller than this (in CSS px) counts as aligned. */
export const ALIGN_TOLERANCE = 1
/** Corrections applied per viewport event before the shell is left where it is. */
export const MAX_ALIGN_PASSES = 3
/** The transcript counts as "following the latest message" within this distance of its end. */
export const FOLLOW_LATEST_SLACK = 80
/** Frames to wait for React to commit an applied offset before measuring. */
export const MAX_COMMIT_WAITS = 4

type ViewportRect = { height: number; offsetTop: number; offsetLeft: number }

/**
 * Mobile keyboards can shrink the visual viewport without changing CSS dvh. The shell is
 * `position: fixed`, which is placed in LAYOUT-viewport coordinates, and `visualViewport.offsetTop`
 * is ALSO measured from the layout viewport's top edge. So the shell is pinned to the visual
 * viewport's rectangle directly: `top = offsetTop`, `height = viewport.height`. Nothing about the
 * document's own scroll position belongs in that arithmetic (an earlier version subtracted
 * `scrollY`, which shifted the shell up by exactly the scroll iOS applies to reveal the field and
 * left the composer far above the keyboard).
 *
 * That geometry is then checked against what the browser actually rendered: the shell's measured
 * top is compared with the visual viewport's top and any residual is corrected, a bounded number of
 * times per event. The check makes the layout independent of which browser reports which coordinate
 * frame, and it is idempotent: a settled shell measures zero residual and nothing moves.
 *
 * Keyboard detection compares against a stable baseline (the largest visual viewport height seen
 * while no text field is focused, reset on orientation change), not `window.innerHeight`, because
 * recent iOS Safari can shrink `innerHeight` together with the visual viewport.
 *
 * While a textarea is focused this hook never scrolls the document, so it cannot undo the scroll
 * Safari uses to reveal the field. Any leftover scroll is cleared only after focus leaves and the
 * viewport is back near its baseline. If the transcript was following the latest message when the
 * viewport changed height, it is re-pinned to its end afterwards, so recent conversation stays
 * visible above the composer both when the keyboard opens and when it closes.
 */
export function useChatViewportHeight() {
  const [viewportRect, setViewportRect] = useState<ViewportRect | undefined>()

  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    let active = true
    let baselineHeight = 0
    let lastWidth = viewport.width ?? window.innerWidth
    let frame: number | undefined
    let alignPasses = 0
    let commitWaits = 0
    let lastMeasuredTop: number | null = null
    let lastDelta = 0
    let pinTranscript = false
    // What is currently applied, so decisions never depend on side effects inside a state updater.
    let applied: ViewportRect | undefined
    const apply = (next: ViewportRect | undefined) => {
      applied = next
      setViewportRect(next)
    }

    const conversation = () =>
      document.querySelector<HTMLElement>('[data-chat-shell] [data-chat-conversation]')
    const followingLatest = () => {
      const node = conversation()
      if (!node) return false
      return node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_LATEST_SLACK
    }

    /**
     * Runs after the layout commits: re-pin the transcript, then verify the geometry. It only
     * measures once the offset it last applied is the one the shell actually carries (React may not
     * have committed it yet), and it only keeps correcting while each correction demonstrably moves
     * the shell by the amount asked. A measurement that does not respond to the correction is not
     * about this element's position at all, so the plain visual-viewport geometry is restored
     * instead of chasing it.
     */
    const settle = () => {
      frame = undefined
      if (!active) return
      if (pinTranscript) {
        const node = conversation()
        if (node) node.scrollTop = node.scrollHeight
        pinTranscript = false
      }
      const shell = document.querySelector<HTMLElement>('[data-chat-shell][data-keyboard-open]')
      if (!shell || !applied) return
      const committed = Number.parseFloat(shell.style.getPropertyValue('--chat-keyboard-offset-y'))
      if (Number.isFinite(committed) && committed !== applied.offsetTop) {
        // The offset we applied is not rendered yet: wait a frame rather than measure stale layout.
        if (commitWaits < MAX_COMMIT_WAITS && typeof requestAnimationFrame === 'function') {
          commitWaits += 1
          frame = requestAnimationFrame(settle)
        }
        return
      }
      commitWaits = 0
      const rect = shell.getBoundingClientRect()
      if (
        lastMeasuredTop !== null &&
        lastDelta !== 0 &&
        Math.abs(rect.top - lastMeasuredTop - lastDelta) > ALIGN_TOLERANCE + 1
      ) {
        // The correction did not move the shell: stop, and return to the geometric default.
        lastMeasuredTop = null
        lastDelta = 0
        alignPasses = MAX_ALIGN_PASSES
        const geometric = {
          ...applied,
          offsetTop: Math.max(0, Math.round(viewport.offsetTop)),
          offsetLeft: Math.round(viewport.offsetLeft),
        }
        if (
          geometric.offsetTop !== applied.offsetTop ||
          geometric.offsetLeft !== applied.offsetLeft
        ) {
          apply(geometric)
        }
        return
      }
      const residualTop = Math.round(viewport.offsetTop - rect.top)
      const residualLeft = Math.round(viewport.offsetLeft - rect.left)
      if (Math.abs(residualTop) < ALIGN_TOLERANCE && Math.abs(residualLeft) < ALIGN_TOLERANCE) {
        alignPasses = 0
        lastMeasuredTop = null
        lastDelta = 0
        return
      }
      // A residual larger than the viewport is a measurement from another frame, not a nudge.
      if (
        alignPasses >= MAX_ALIGN_PASSES ||
        Math.abs(residualTop) > viewport.height ||
        Math.abs(residualLeft) > viewport.width
      ) {
        return
      }
      alignPasses += 1
      lastMeasuredTop = rect.top
      lastDelta = residualTop
      apply({
        ...applied,
        offsetTop: Math.max(0, applied.offsetTop + residualTop),
        offsetLeft: applied.offsetLeft + residualLeft,
      })
      if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(settle)
    }

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
      const nextViewportRect: ViewportRect | undefined = keyboardOpen
        ? {
            height: Math.round(viewport.height),
            // Layout-viewport coordinates on both sides: no document-scroll term.
            offsetTop: Math.max(0, Math.round(viewport.offsetTop)),
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
      const unchanged =
        nextViewportRect === undefined
          ? applied === undefined
          : applied?.height === nextViewportRect.height &&
            applied.offsetTop === nextViewportRect.offsetTop &&
            applied.offsetLeft === nextViewportRect.offsetLeft
      if (!unchanged) {
        // A real viewport change: remember whether the reader was following the latest message.
        if (!fromRetry && applied?.height !== nextViewportRect?.height) {
          pinTranscript = pinTranscript || followingLatest()
        }
        alignPasses = 0
        commitWaits = 0
        lastMeasuredTop = null
        lastDelta = 0
        apply(nextViewportRect)
      }
      if ((keyboardOpen || pinTranscript) && typeof requestAnimationFrame === 'function') {
        if (frame !== undefined) cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => {
          frame = undefined
          const field = document.activeElement
          if (
            keyboardOpen &&
            !fromRetry &&
            active &&
            field instanceof HTMLTextAreaElement &&
            field.getBoundingClientRect().bottom > viewport.offsetTop + viewport.height
          ) {
            // Keep the caret visible: the field still ends below the visible area, measure again.
            update(true)
          }
          settle()
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
