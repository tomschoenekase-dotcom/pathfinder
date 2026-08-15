import { notFound } from 'next/navigation'

import { SecondLayerContentManager } from '../../../../../components/SecondLayerContentManager'
import { createDashboardCaller } from '../../../../../lib/server-caller'

export default async function SecondLayerPage({
  params,
}: {
  params: Promise<{ venueId: string }>
}) {
  const { venueId } = await params
  const caller = await createDashboardCaller(`/venues/${venueId}/second-layer`)
  const [layer, places, knowledgeEntries] = await Promise.all([
    caller.venue.getSecondLayer({ venueId }),
    caller.place.list({ venueId }),
    caller.knowledge.list({ venueId }),
  ])
  if (!layer.secondLayerEnabled) notFound()
  return (
    <SecondLayerContentManager
      venueId={venueId}
      label={layer.secondLayerLabel}
      initialPlaces={places.map((place) => ({
        id: place.id,
        name: place.name,
        type: place.itemType ?? place.type,
        visibility: place.visibility,
        updatedAt: place.updatedAt.toISOString(),
      }))}
      initialKnowledge={knowledgeEntries.map((entry) => ({
        id: entry.id,
        title: entry.title,
        category: entry.category,
        visibility: entry.visibility,
        updatedAt: entry.updatedAt.toISOString(),
      }))}
    />
  )
}
