import { notFound } from 'next/navigation'

import { ConnectedClientHandoffFixture } from '../../../components/ConnectedClientHandoffFixture'
import { TRPCProvider } from '../../../lib/trpc'

function one(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

export default async function ConnectedClientHandoffPage({
  searchParams,
}: {
  searchParams: Promise<{ venueId?: string | string[] }>
}) {
  if (
    process.env.NODE_ENV !== 'development' ||
    process.env.TORCHIKO_VISUAL_FIXTURES_ENABLED !== '1'
  )
    notFound()

  const venueId = one((await searchParams).venueId)
  if (!venueId || venueId.length > 191) notFound()

  return (
    <TRPCProvider scopeKey={`connected-client-handoff:${venueId}`}>
      <ConnectedClientHandoffFixture venueId={venueId} />
    </TRPCProvider>
  )
}
