'use client'

import * as Sentry from '@sentry/nextjs'
import { useEffect, useRef } from 'react'

type GlobalErrorProps = {
  error: Error & { digest?: string }
  reset: () => void
}

export function GlobalErrorContent({ error, reset }: GlobalErrorProps) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  const reportedErrorRef = useRef<Error | null>(null)

  useEffect(() => {
    headingRef.current?.focus()

    if (reportedErrorRef.current === error) return
    reportedErrorRef.current = error

    try {
      Sentry.captureException(error)
    } catch {
      // Monitoring is optional and must never replace the guest fallback.
    }
  }, [error])

  return (
    <main
      aria-labelledby="global-error-heading"
      className="flex min-h-screen items-center justify-center bg-pf-surface px-6 py-10"
      style={{
        alignItems: 'center',
        backgroundColor: '#f2f5f9',
        boxSizing: 'border-box',
        display: 'flex',
        justifyContent: 'center',
        minHeight: '100vh',
        padding: '40px 24px',
      }}
    >
      <div
        className="w-full max-w-md rounded-3xl border border-pf-light bg-pf-white p-8 text-center shadow-sm"
        style={{
          backgroundColor: '#ffffff',
          border: '1px solid #c9d4e3',
          borderRadius: '24px',
          boxShadow: '0 1px 2px rgb(15 42 74 / 8%)',
          boxSizing: 'border-box',
          maxWidth: '448px',
          padding: '32px',
          textAlign: 'center',
          width: '100%',
        }}
      >
        <h1
          ref={headingRef}
          id="global-error-heading"
          tabIndex={-1}
          className="text-2xl font-semibold tracking-tight text-pf-deep outline-none"
          style={{ color: '#0f2a4a', fontSize: '24px', margin: 0 }}
        >
          Something went wrong
        </h1>
        <p
          className="mt-3 text-sm leading-6 text-pf-deep/60"
          style={{
            color: 'rgb(15 42 74 / 70%)',
            fontSize: '14px',
            lineHeight: 1.5,
            margin: '12px 0 0',
          }}
        >
          PathFinder could not finish loading this guide. Please try again.
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-6 inline-flex min-h-11 items-center justify-center rounded-full bg-pf-primary px-6 text-sm font-medium text-white transition hover:bg-pf-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pf-primary"
          style={{
            backgroundColor: '#1f4e8c',
            border: 0,
            borderRadius: '9999px',
            color: '#ffffff',
            cursor: 'pointer',
            font: 'inherit',
            marginTop: '24px',
            minHeight: '44px',
            padding: '0 24px',
          }}
        >
          Try again
        </button>
      </div>
    </main>
  )
}

export default function GlobalError(props: GlobalErrorProps) {
  return (
    <html lang="en">
      <body
        className="font-jakarta antialiased"
        style={{
          backgroundColor: '#f2f5f9',
          color: '#0f2a4a',
          fontFamily: 'Arial, sans-serif',
          margin: 0,
          minHeight: '100vh',
        }}
      >
        <GlobalErrorContent {...props} />
      </body>
    </html>
  )
}
