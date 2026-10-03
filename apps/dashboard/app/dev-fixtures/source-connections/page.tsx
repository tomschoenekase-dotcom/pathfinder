import { notFound } from 'next/navigation'
import { SourceConnectionsFixture } from './SourceConnectionsFixture'

export default function SourceConnectionsFixturePage() {
  if (
    process.env.NODE_ENV !== 'development' ||
    process.env.TORCHIKO_VISUAL_FIXTURES_ENABLED !== '1'
  )
    notFound()
  return <SourceConnectionsFixture />
}
