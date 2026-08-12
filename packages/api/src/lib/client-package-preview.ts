import { ClientVenuePackagePreview } from '@pathfinder/contracts'
import {
  TONE_PRESET_BEHAVIOR_VERSION,
  TONE_PRESET_TO_LEGACY_AI_TONE,
  resolveEffectiveTone,
} from '@pathfinder/contracts/tone-presets'

import type { VenuePackageStoredPreview } from '../schemas/venue-package'

type Stored = typeof VenuePackageStoredPreview._output
type Venue = {
  id: string
  name: string
  description: string | null
  category: string | null
  chatTheme: string | null
  chatAccentColor: string | null
  chatFont: string | null
  chatLogoUrl: string | null
  chatBannerUrl: string | null
  aiGuideName: string | null
  aiTone: string | null
  tonePreset?: string | null
  tonePresetVersion?: number | null
}
type Place = {
  id: string | null
  name: string
  type: string
  shortDescription: string | null
  longDescription: string | null
  areaName: string | null
  hours: string | null
  photoUrl: string | null
  lat: number | null
  lng: number | null
  tags: string[]
  isActive: boolean
}
type Knowledge = {
  id: string | null
  title: string
  category: string
  content: string
  isEnabled: boolean
}

export function canonicalVenuePackageWarningCodes(
  warnings: ReadonlyArray<{ code: string }>,
): string[] {
  return [...new Set(warnings.map(({ code }) => code))].sort()
}

export class ClientPackagePreviewProjectionError extends Error {
  constructor(readonly reason: 'CONTENT_LIMIT' | 'INVALID_PUBLIC_CONTENT' | 'SERIALIZED_LIMIT') {
    super('Approved preview cannot be represented safely')
    this.name = 'ClientPackagePreviewProjectionError'
  }
}

export const CLIENT_PACKAGE_PREVIEW_SERIALIZED_MAX_BYTES = 1_000_000

function safePlace(value: Record<string, unknown>, id: string | null): Place {
  return {
    id,
    name: String(value.name),
    type: String(value.type),
    shortDescription: typeof value.shortDescription === 'string' ? value.shortDescription : null,
    longDescription: typeof value.longDescription === 'string' ? value.longDescription : null,
    areaName: typeof value.areaName === 'string' ? value.areaName : null,
    hours: typeof value.hours === 'string' ? value.hours : null,
    photoUrl: typeof value.photoUrl === 'string' ? value.photoUrl : null,
    lat: typeof value.lat === 'number' ? value.lat : null,
    lng: typeof value.lng === 'number' ? value.lng : null,
    tags: Array.isArray(value.tags)
      ? value.tags.filter((v): v is string => typeof v === 'string')
      : [],
    isActive: value.isActive !== false,
  }
}
function safeKnowledge(value: Record<string, unknown>, id: string | null): Knowledge {
  return {
    id,
    title: String(value.title),
    category: String(value.category),
    content: String(value.content),
    isEnabled: value.isEnabled !== false,
  }
}

export function clientPackagePreviewProjection(input: {
  venue: Venue
  places: Place[]
  knowledgeEntries: Knowledge[]
  pkg: { id: string; approvedAt: Date }
  stored: Stored
}) {
  const venue = { ...input.venue }
  const places = new Map(input.places.map((row) => [row.id!, row]))
  const knowledge = new Map(input.knowledgeEntries.map((row) => [row.id!, row]))
  if (input.stored.schemaVersion !== 1) {
    for (const change of input.stored.changes.venue.change) {
      const path = change.path
      const value = change.after
      if (path === 'venue.identity.name') venue.name = String(value)
      else if (path === 'venue.identity.description') venue.description = value as string | null
      else if (path === 'venue.identity.category') venue.category = value as string | null
      else if (path === 'venue.branding.chatTheme') venue.chatTheme = value as string | null
      else if (path === 'venue.branding.chatAccentColor')
        venue.chatAccentColor = value as string | null
      else if (path === 'venue.branding.chatFont') venue.chatFont = value as string | null
      else if (path === 'venue.branding.chatLogoUrl') venue.chatLogoUrl = value as string | null
      else if (path === 'venue.branding.chatBannerUrl') venue.chatBannerUrl = value as string | null
      else if (path === 'venue.aiBehavior.aiGuideName') venue.aiGuideName = value as string | null
      else if (path === 'venue.aiBehavior.aiTone') venue.aiTone = value as string | null
      else if (path === 'venue.aiBehavior.tonePreset') {
        venue.tonePreset = value as string | null
        venue.tonePresetVersion = value === null ? null : TONE_PRESET_BEHAVIOR_VERSION
        venue.aiTone =
          value !== null && value in TONE_PRESET_TO_LEGACY_AI_TONE
            ? TONE_PRESET_TO_LEGACY_AI_TONE[value as keyof typeof TONE_PRESET_TO_LEGACY_AI_TONE]
            : venue.aiTone
      } else if (path === 'venue.aiBehavior.tonePresetVersion')
        venue.tonePresetVersion = value as number | null
    }
  }
  if (input.stored.schemaVersion === 3) {
    input.stored.changes.places.add.forEach(({ value }) =>
      places.set(`new:${places.size}`, safePlace(value, null)),
    )
    input.stored.changes.places.change.forEach(({ id, after }) =>
      places.set(id, safePlace(after, id)),
    )
    input.stored.changes.places.remove.forEach(({ id }) => places.delete(id))
    input.stored.changes.knowledgeEntries.add.forEach(({ value }) =>
      knowledge.set(`new:${knowledge.size}`, safeKnowledge(value, null)),
    )
    input.stored.changes.knowledgeEntries.change.forEach(({ id, after }) =>
      knowledge.set(id, safeKnowledge(after, id)),
    )
    input.stored.changes.knowledgeEntries.remove.forEach(({ id }) => knowledge.delete(id))
  } else {
    input.stored.changes.places.add.forEach((value) =>
      places.set(`new:${places.size}`, safePlace(value, null)),
    )
    input.stored.changes.knowledgeEntries.add.forEach((value) =>
      knowledge.set(`new:${knowledge.size}`, safeKnowledge(value, null)),
    )
  }
  const effectivePlaces = [...places.values()]
    .filter((row) => row.isActive)
    .map((row) => ({
      name: row.name,
      type: row.type,
      shortDescription: row.shortDescription,
      longDescription: row.longDescription,
      areaName: row.areaName,
      hours: row.hours,
      photoUrl: row.photoUrl,
      lat: row.lat,
      lng: row.lng,
      tags: row.tags,
    }))
    .sort(
      (left, right) => left.name.localeCompare(right.name) || left.type.localeCompare(right.type),
    )
  const effectiveKnowledge = [...knowledge.values()]
    .filter((row) => row.isEnabled)
    .map((row) => ({ title: row.title, category: row.category, content: row.content }))
    .sort(
      (left, right) =>
        left.title.localeCompare(right.title) || left.category.localeCompare(right.category),
    )
  if (effectivePlaces.length > 500 || effectiveKnowledge.length > 500)
    throw new ClientPackagePreviewProjectionError('CONTENT_LIMIT')
  const effectiveTone = resolveEffectiveTone(venue)
  const candidate = {
    venue: {
      id: venue.id,
      name: venue.name,
      description: venue.description,
      category: venue.category,
      branding: {
        theme: venue.chatTheme,
        accentColor: venue.chatAccentColor,
        font: venue.chatFont,
        logoUrl: venue.chatLogoUrl,
        bannerUrl: venue.chatBannerUrl,
      },
      guide: {
        name: venue.aiGuideName,
        tone: {
          preset: effectiveTone.preset,
          behaviorVersion: effectiveTone.behaviorVersion,
        },
      },
    },
    package: {
      id: input.pkg.id,
      status: 'APPROVED',
      approvedAt: input.pkg.approvedAt.toISOString(),
    },
    experience: {
      places: effectivePlaces,
      knowledgeEntries: effectiveKnowledge,
      summary: {
        placeCount: effectivePlaces.length,
        knowledgeEntryCount: effectiveKnowledge.length,
      },
    },
    staleness: 'CURRENT',
    autoApply: false,
    published: false,
    guestAccessible: false,
  }
  const parsed = ClientVenuePackagePreview.safeParse(candidate)
  if (!parsed.success) throw new ClientPackagePreviewProjectionError('INVALID_PUBLIC_CONTENT')
  if (
    Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') >
    CLIENT_PACKAGE_PREVIEW_SERIALIZED_MAX_BYTES
  )
    throw new ClientPackagePreviewProjectionError('SERIALIZED_LIMIT')
  return parsed.data
}
