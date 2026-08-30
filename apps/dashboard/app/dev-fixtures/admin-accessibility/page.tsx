import { notFound } from 'next/navigation'

import { AdminAccessibilityFixture } from './AdminAccessibilityFixture'

export default function AdminAccessibilityFixturePage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return <AdminAccessibilityFixture />
}
