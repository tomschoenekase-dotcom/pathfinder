export const metadata = { title: 'Support completion review - Torchiko' }

import { notFound } from 'next/navigation'

import { SupportCompletionOutcomeFixtureClient } from './FixtureClient'

export default function SupportCompletionOutcomeFixturePage() {
  if (
    process.env.NODE_ENV !== 'development' ||
    process.env.TORCHIKO_VISUAL_FIXTURES_ENABLED !== '1'
  )
    notFound()
  return <SupportCompletionOutcomeFixtureClient />
}
