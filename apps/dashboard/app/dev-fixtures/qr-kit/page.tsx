import { notFound } from 'next/navigation'

import { VenueQrKit } from '../../../components/VenueQrKit'
import { TRPCProvider } from '../../../lib/trpc'

export default async function QrKitFixture({
  searchParams,
}: {
  searchParams: Promise<{ audience?: string | string[] }>
}) {
  if (process.env.NODE_ENV !== 'development') notFound()
  const rawAudience = (await searchParams).audience
  const audience =
    (Array.isArray(rawAudience) ? rawAudience[0] : rawAudience) === 'client' ? 'client' : 'admin'

  return (
    <main className="min-h-screen bg-pf-surface px-4 py-8 text-pf-deep sm:px-8 sm:py-12">
      <div className="mx-auto max-w-6xl">
        <TRPCProvider scopeKey="qr-kit-fixture">
          <VenueQrKit
            audience={audience}
            venueName="Harbor House"
            guestChatUrl="https://guide.example.com/harbor-house/chat"
            generatedAt="2026-09-07T12:00:00.000Z"
          />
        </TRPCProvider>
      </div>
    </main>
  )
}
