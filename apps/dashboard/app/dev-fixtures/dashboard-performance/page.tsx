import { notFound } from 'next/navigation'

import { DashboardPerformanceFixture } from './DashboardPerformanceFixture'

export default function DashboardPerformanceFixturePage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return <DashboardPerformanceFixture />
}
