import { notFound } from 'next/navigation'

import { FixtureClient } from './FixtureClient'

export default function MediaIntakeHandoffFixturePage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return <FixtureClient />
}
