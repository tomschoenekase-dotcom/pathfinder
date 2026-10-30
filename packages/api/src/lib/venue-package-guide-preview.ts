import { VenuePackagePayload } from '../schemas/venue-package'
import { buildGuestVenueGuidePrompt, type GuestVenueDirectory } from './guest-venue-directory'

const MAX_FULL_CHARS = 120_000

/** Offline projection only: never establishes live publication authority or visibility. */
export function previewVenuePackageGuide(input: unknown, asOf: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(asOf) ||
    !Number.isFinite(Date.parse(asOf)) ||
    new Date(asOf).toISOString().slice(0, 10) !== asOf
  ) {
    throw new Error('asOf must be a valid YYYY-MM-DD date')
  }
  const payload = VenuePackagePayload.parse(input)
  if (
    payload.schemaVersion === 3 &&
    (payload.places.update.length ||
      payload.places.delete.length ||
      payload.knowledgeEntries.update.length ||
      payload.knowledgeEntries.delete.length)
  ) {
    throw new Error('Guide preview needs live rows for update/delete packages')
  }
  const places =
    payload.schemaVersion === 3
      ? payload.places.create.map(({ itemKey, value, provenance }) => ({
          id: itemKey,
          value,
          provenance,
        }))
      : payload.places.map((value, index) => ({
          id: `preview-place-${index}`,
          value,
          provenance: null,
        }))
  const knowledge =
    payload.schemaVersion === 3
      ? payload.knowledgeEntries.create.map(({ itemKey, value, provenance }) => ({
          id: itemKey,
          value,
          provenance,
        }))
      : payload.knowledgeEntries.map((value, index) => ({
          id: `preview-knowledge-${index}`,
          value,
          provenance: null,
        }))
  const directory: GuestVenueDirectory = {
    incomplete: false,
    places: places
      .map(({ id, value, provenance }) => ({
        id,
        name: value.name,
        type: value.type,
        itemType: value.itemType ?? null,
        shortDescription: value.shortDescription ?? null,
        longDescription: value.longDescription ?? null,
        lat: value.lat ?? null,
        lng: value.lng ?? null,
        tags: value.tags,
        areaName: value.areaName ?? null,
        hours: value.hours ?? null,
        photoUrl: value.photoUrl ?? null,
        sourceType: provenance?.sourceType ?? 'MANUAL',
        sourceName: provenance?.sourceName ?? null,
        sourceUrl: provenance?.sourceUrl ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    knowledge: knowledge
      // Match the production loader's deterministic connected-source exclusion.
      .filter(
        ({ value, provenance }) =>
          value.isEnabled && provenance?.sourceType !== 'SOURCE_CONNECTION',
      )
      .map(({ id, value, provenance }) => ({
        id,
        title: value.title,
        category: value.category,
        content: value.content,
        sourceType: provenance?.sourceType ?? 'MANUAL',
        sourceName: provenance?.sourceName ?? null,
        sourceUrl: provenance?.sourceUrl ?? null,
      }))
      .sort(
        (a, b) =>
          a.category.localeCompare(b.category) ||
          a.title.localeCompare(b.title) ||
          a.id.localeCompare(b.id),
      ),
  }
  const full = buildGuestVenueGuidePrompt(directory, {
    currentDate: asOf,
    maxFullChars: Number.MAX_SAFE_INTEGER,
  })
  const measure = (strategy?: 'evidence') => {
    const rendered = buildGuestVenueGuidePrompt(directory, {
      currentDate: asOf,
      ...(strategy ? { strategy } : {}),
    })
    return {
      strategy: strategy ?? 'default',
      mode: rendered.mode,
      renderedChars: rendered.prompt.length,
      fullGuideRenderedChars: full.prompt.length,
      maxFullChars: MAX_FULL_CHARS,
      rendererTruncated: rendered.rendererTruncated,
    }
  }
  return {
    schemaVersion: 1,
    asOf,
    scope: 'CREATE_ONLY_PACKAGE_PREVIEW',
    assumptions: [
      'Only package-created rows are projected; existing live rows are not loaded.',
      'Rows are assumed PUBLIC, active and currently authorized for guest publication; no live authority, adoption, visibility or venue activation is verified.',
      'Disabled and SOURCE_CONNECTION knowledge are excluded as in the production loader; missing optional values use public renderer defaults. Source provenance is copied when supplied, otherwise MANUAL/null.',
      'No live updatedAt is invented; recordDates is off. Venue settings and hosted strategy are not measured.',
      'fullGuideRenderedChars is diagnostic: the unchanged renderer runs with an unlimited full-guide bound; mode uses its production 120000-character default.',
    ],
    counts: { places: directory.places.length, knowledge: directory.knowledge.length },
    default: measure(),
    evidence: measure('evidence'),
  }
}
