'use client'

import { useRouter } from 'next/navigation'

export function VenueRetryButton() {
  const router = useRouter()

  return (
    <button
      type="button"
      onClick={() => router.refresh()}
      className="inline-flex min-h-11 items-center justify-center rounded-full bg-pf-primary px-5 text-sm font-medium text-white transition hover:bg-pf-accent"
    >
      Try again
    </button>
  )
}
