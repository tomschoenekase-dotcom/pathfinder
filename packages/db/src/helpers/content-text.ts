export function buildPlaceText(place: {
  name: string
  type: string
  itemType?: string | null
  shortDescription: string | null
  longDescription: string | null
  tags: string[]
  areaName: string | null
  hours: string | null
}): string {
  return [
    place.name,
    place.itemType ?? place.type,
    place.areaName,
    place.shortDescription,
    place.longDescription,
    place.tags.length > 0 ? place.tags.join(' ') : null,
    place.hours ? `Hours: ${place.hours}` : null,
  ]
    .filter(Boolean)
    .join('. ')
}

export function buildKnowledgeEntryText(entry: {
  title: string
  category: string
  content: string
}): string {
  return [entry.title, entry.category, entry.content].filter(Boolean).join('. ')
}
