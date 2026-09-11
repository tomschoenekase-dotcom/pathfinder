export const metadata = { title: 'Dated source review - Torchiko' }

import { notFound } from 'next/navigation'

import { SemanticTemporalEvidenceFixtureClient } from './FixtureClient'

export default function SemanticTemporalEvidenceFixturePage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return <SemanticTemporalEvidenceFixtureClient />
}
