'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'

type CopyState = 'idle' | 'copying' | 'copied' | 'error'

export function CopyUrlButton({ url }: { url: string }) {
  const [state, setState] = useState<CopyState>('idle')
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyAttempt = useRef(0)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true

    return () => {
      mounted.current = false
      copyAttempt.current += 1
      if (resetTimer.current) {
        clearTimeout(resetTimer.current)
        resetTimer.current = null
      }
    }
  }, [])

  useEffect(() => {
    copyAttempt.current += 1
    if (resetTimer.current) {
      clearTimeout(resetTimer.current)
      resetTimer.current = null
    }
    setState('idle')
  }, [url])

  async function handleCopy() {
    if (state === 'copying') {
      return
    }

    if (resetTimer.current) {
      clearTimeout(resetTimer.current)
      resetTimer.current = null
    }

    const attempt = ++copyAttempt.current
    setState('copying')

    try {
      const clipboard = navigator.clipboard
      if (!clipboard || typeof clipboard.writeText !== 'function') {
        throw new Error('Clipboard API unavailable')
      }

      await clipboard.writeText(url)
      if (!mounted.current || copyAttempt.current !== attempt) {
        return
      }

      setState('copied')
      resetTimer.current = setTimeout(() => {
        if (mounted.current && copyAttempt.current === attempt) {
          setState('idle')
        }
        resetTimer.current = null
      }, 2000)
    } catch {
      if (mounted.current && copyAttempt.current === attempt) {
        setState('error')
      }
    }
  }

  const statusMessage =
    state === 'copied'
      ? 'Guest chat URL copied.'
      : state === 'error'
        ? 'Could not copy the guest chat URL. Try again or select the URL manually.'
        : null

  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        aria-label="Copy guest chat URL"
        aria-busy={state === 'copying'}
        disabled={state === 'copying'}
        onClick={() => {
          void handleCopy()
        }}
        className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-pf-light bg-pf-white px-4 py-2 text-sm font-medium text-pf-primary transition hover:border-pf-accent hover:bg-pf-accent/5 disabled:cursor-wait disabled:opacity-60"
      >
        {state === 'copied' ? (
          <Check className="h-4 w-4 text-emerald-600" aria-hidden="true" />
        ) : (
          <Copy className="h-4 w-4" aria-hidden="true" />
        )}
        {state === 'copying' ? 'Copying...' : state === 'copied' ? 'Copied' : 'Copy'}
      </button>
      {statusMessage ? (
        <p
          role={state === 'error' ? 'alert' : 'status'}
          className={`max-w-xs text-xs leading-5 ${
            state === 'error' ? 'text-rose-700' : 'text-emerald-700'
          }`}
        >
          {statusMessage}
        </p>
      ) : null}
    </div>
  )
}
