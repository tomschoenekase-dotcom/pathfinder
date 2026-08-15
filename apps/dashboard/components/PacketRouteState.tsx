'use client'

import React from 'react'
import { useEffect, useRef } from 'react'

export function PacketRouteLoading({ label }: { label: string }) {
  return (
    <section className="space-y-5" aria-busy="true" aria-label={`Loading ${label}`} role="status">
      <div className="h-24 animate-pulse rounded-3xl bg-pf-surface motion-reduce:animate-none" />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="h-48 animate-pulse rounded-3xl bg-pf-surface motion-reduce:animate-none" />
        <div className="h-48 animate-pulse rounded-3xl bg-pf-surface motion-reduce:animate-none" />
      </div>
      <span className="sr-only">Loading {label}…</span>
    </section>
  )
}

export function PacketRouteError({
  title,
  detail,
  reset,
}: {
  title: string
  detail: string
  reset: () => void
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => headingRef.current?.focus(), [])
  return (
    <section className="rounded-3xl border border-rose-300 bg-rose-50 p-6 sm:p-8" role="alert">
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="text-xl font-semibold text-rose-950 outline-none"
      >
        {title}
      </h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-rose-900">{detail}</p>
      <button
        type="button"
        className="mt-5 inline-flex min-h-11 items-center rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2"
        onClick={reset}
      >
        Try loading again
      </button>
    </section>
  )
}
