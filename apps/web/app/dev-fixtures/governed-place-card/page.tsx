import { notFound } from 'next/navigation'
import { GovernedPlaceCardFixture } from './GovernedPlaceCardFixture'

export default function Page() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return <GovernedPlaceCardFixture />
}
