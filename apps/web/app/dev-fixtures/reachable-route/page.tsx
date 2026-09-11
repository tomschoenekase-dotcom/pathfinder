import { notFound } from 'next/navigation'
import { ReachableRouteFixture } from './ReachableRouteFixture'

export default function Page() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return <ReachableRouteFixture />
}
