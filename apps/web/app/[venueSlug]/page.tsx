import { redirect } from 'next/navigation'

type VenueLandingPageProps = {
  params: Promise<{
    venueSlug: string
  }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/**
 * The venue's public link opens the guide directly. Existence, availability and admission are
 * decided once by the chat route (not-found / temporarily-unavailable), so this page only
 * forwards the visitor and every entry parameter (prompt, source, entry, item, ask, place).
 * The former "Open your guide" arrival screen was removed.
 */
export default async function VenueLandingPage({ params, searchParams }: VenueLandingPageProps) {
  const { venueSlug } = await params
  const query = await searchParams
  const forwarded = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) forwarded.append(key, item)
    } else if (value !== undefined) {
      forwarded.set(key, value)
    }
  }
  const suffix = forwarded.size > 0 ? `?${forwarded.toString()}` : ''
  redirect(`/${encodeURIComponent(venueSlug)}/chat${suffix}`)
}
