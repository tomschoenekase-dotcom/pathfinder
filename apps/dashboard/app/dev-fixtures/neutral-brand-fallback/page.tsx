import { notFound } from 'next/navigation'

import ClientPortalLoading from '../../(app)/loading'
import { NeutralBrandErrorFixture } from './NeutralBrandErrorFixture'

export default async function NeutralBrandFallbackFixture({
  searchParams,
}: {
  searchParams: Promise<{ surface?: string | string[] }>
}) {
  if (
    process.env.NODE_ENV !== 'development' ||
    process.env.TORCHIKO_VISUAL_FIXTURES_ENABLED !== '1'
  )
    notFound()
  const raw = (await searchParams).surface
  const surface = Array.isArray(raw) ? raw[0] : raw
  if (surface === 'loading') return <ClientPortalLoading />
  if (surface === 'error') return <NeutralBrandErrorFixture />
  notFound()
}
