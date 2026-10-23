import { notFound } from 'next/navigation'
import { FixtureClient } from './FixtureClient'

export const metadata = { title: 'Synthetic fact applicability review' }

export default function Page() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return <FixtureClient />
}
