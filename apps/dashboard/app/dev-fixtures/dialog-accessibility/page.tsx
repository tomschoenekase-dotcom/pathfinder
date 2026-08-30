import { notFound } from 'next/navigation'

import { DialogAccessibilityFixture } from './DialogAccessibilityFixture'

export default function DialogAccessibilityFixturePage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return <DialogAccessibilityFixture />
}
