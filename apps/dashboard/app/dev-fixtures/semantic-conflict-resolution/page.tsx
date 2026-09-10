export const metadata = { title: 'Semantic conflict resolution - Torchiko' }

import { notFound } from 'next/navigation'

import { SemanticConflictResolutionFixtureClient } from './FixtureClient'

export default function SemanticConflictResolutionFixturePage() {
  if (
    process.env.NODE_ENV !== 'development' ||
    process.env.TORCHIKO_VISUAL_FIXTURES_ENABLED !== '1'
  )
    notFound()
  return <SemanticConflictResolutionFixtureClient />
}
