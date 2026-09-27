'use client'

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

export function CopyAccessValueButton({ label, value }: { label: string; value: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle')
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setState('copied')
      window.setTimeout(() => setState('idle'), 1800)
    } catch {
      setState('error')
    }
  }
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => void copy()}
        className="inline-flex min-h-10 items-center gap-2 rounded-full border border-pf-light bg-white px-4 text-sm font-semibold text-pf-primary hover:bg-pf-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pf-primary"
      >
        {state === 'copied' ? (
          <Check className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Copy className="h-4 w-4" aria-hidden="true" />
        )}
        {state === 'copied' ? 'Copied' : `Copy ${label}`}
      </button>
      {state === 'error' ? (
        <span role="alert" className="text-xs text-rose-700">
          Could not copy. Select the value and copy it manually.
        </span>
      ) : null}
      {state === 'copied' ? (
        <span role="status" className="sr-only">
          {label} copied.
        </span>
      ) : null}
    </span>
  )
}
