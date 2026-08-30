import { notFound } from 'next/navigation'

import { RouteFocusAccessibilityFixture } from './RouteFocusAccessibilityFixture'

export default function RouteFocusAccessibilityFixturePage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return <RouteFocusAccessibilityFixture />
}
