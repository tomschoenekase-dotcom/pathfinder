export const metadata = { title: 'Semantic conflict resolution - Torchiko' }

import { notFound } from 'next/navigation'

import { SemanticConflictResolutionFixtureClient } from './FixtureClient'

export default async function SemanticConflictResolutionFixturePage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string }>
}) {
  if (
    process.env.NODE_ENV !== 'development' ||
    process.env.TORCHIKO_VISUAL_FIXTURES_ENABLED !== '1'
  )
    notFound()
  const query = await searchParams
  if (
    query.connected === '1' &&
    process.env.RUN_SEMANTIC_CONFLICT_RESOLUTION_BROWSER_INTEGRATION !== '1'
  )
    notFound()
  return <SemanticConflictResolutionFixtureClient connected={query.connected === '1'} />
}
