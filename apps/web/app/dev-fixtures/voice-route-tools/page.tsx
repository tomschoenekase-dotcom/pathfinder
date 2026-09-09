import { notFound } from 'next/navigation'

import { VoiceRouteToolsFixture } from '../../../components/VoiceRouteToolsFixture'

export default function VoiceRouteToolsPage() {
  if (
    process.env.NODE_ENV !== 'development' ||
    process.env.RUN_VOICE_ROUTE_TOOLS_BROWSER_PROOF !== '1'
  )
    notFound()
  return <VoiceRouteToolsFixture />
}
