import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { GuestPreviewView } from '../../../components/GuestPreviewView'
import { getGuestPreview } from '../../../lib/guest-preview'

// The link is a bearer credential with a short life: never prerender, cache or index it, and never
// forward it in a Referer header.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Private preview | Torchiko',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

type GuestPreviewPageProps = {
  params: Promise<{ venueSlug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/**
 * A private, version-bound preview of one exact release or package draft. It is a server component
 * and a separate route from the public guide: the public route keeps refusing draft and inactive
 * venues, and this one accepts only a valid signed, expiring link minted for that venue. Every
 * refusal (bad, expired, tampered, wrong venue) is the same not-found page.
 */
export default async function GuestPreviewPage({ params, searchParams }: GuestPreviewPageProps) {
  const { venueSlug } = await params
  const query = await searchParams
  const token = typeof query.token === 'string' ? query.token : null
  if (!token) notFound()
  const preview = await getGuestPreview(venueSlug, token)
  if (!preview) notFound()
  return <GuestPreviewView preview={preview} />
}
