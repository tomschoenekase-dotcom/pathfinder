import type { GuestQuerySource } from './guest-query-source'
import type {
  GuestQueryFact,
  GuestStructuredRecord,
  GuestStructuredSnapshot,
} from './guest-structured-query'

/** Only explicit fields are promoted. Prose/tags are not an authority for boolean negatives. */
export function projectGuestQuerySource(source: GuestQuerySource): GuestStructuredSnapshot {
  if (
    (source.readPath !== 'LEGACY' && source.readPath !== 'DARK') ||
    source.coverage !== 'COMPLETE' ||
    source.directory.incomplete ||
    source.directory.searchVersion !== source.version
  )
    throw new Error('Unverified guest query source projection')
  const scope = { tenantId: source.tenantId, venueId: source.venueId }
  const known = (key: string, fieldPath: string, value: string): GuestQueryFact<string> => ({
    state: 'KNOWN',
    value,
    sources: [{ sourceKey: key, fieldPath }],
  })
  const records: GuestStructuredRecord[] = [
    ...source.directory.places.map((place): GuestStructuredRecord => {
      const key = `place:${place.id}`
      return {
        ...scope,
        key,
        name: place.name,
        entityDomain: 'PLACE',
        // type and itemType are distinct fields; never concatenate them into an invented enum.
        kind: place.type.trim() ? known(key, 'type', place.type) : { state: 'UNKNOWN' },
        area: place.areaName?.trim()
          ? known(key, 'areaName', place.areaName)
          : { state: 'UNKNOWN' },
        products: { state: 'UNKNOWN' },
      }
    }),
    ...source.directory.knowledge.map((entry): GuestStructuredRecord => {
      const key = `knowledge:${entry.id}`
      return {
        ...scope,
        key,
        name: entry.title,
        entityDomain: 'KNOWLEDGE',
        // A knowledge record is not a physical place even if its title resembles a place name.
        kind: known(key, 'id', 'KNOWLEDGE'),
        area: { state: 'UNKNOWN' },
        products: { state: 'UNKNOWN' },
      }
    }),
  ]
  return {
    ...scope,
    version: source.version,
    asOf: source.asOf,
    coverage: source.coverage,
    records,
  }
}
