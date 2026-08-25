import {
  canonicalDeploymentManifest,
  deploymentManifestHash,
  VenueDeploymentFullManifest,
  type VenueDeploymentFullManifest as VenueDeploymentFullManifestValue,
} from '@pathfinder/contracts/venue-deployment-manifest'
import {
  VenueArchetypeId,
  type VenueArchetypeId as VenueArchetypeIdValue,
} from '@pathfinder/contracts/venue-configuration'
import { resolveEffectiveTone } from '@pathfinder/contracts/tone-presets'
import { db } from '@pathfinder/db'

type FullManifestProjectionClient = Pick<typeof db, 'venue'>

export type FullManifestProjectionOmission = {
  code: string
  section:
    | 'IDENTITY'
    | 'BRANDING'
    | 'AI_CONFIGURATION'
    | 'CAPABILITIES'
    | 'CONTENT'
    | 'ASSETS'
    | 'EVALUATION'
  message: string
}

export class FullManifestProjectionError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'INVALID_INPUT' | 'INVALID_STATE',
    message: string,
  ) {
    super(message)
    this.name = 'FullManifestProjectionError'
  }
}

const venueSelect = {
  id: true,
  name: true,
  slug: true,
  description: true,
  category: true,
  tonePreset: true,
  tonePresetVersion: true,
  aiTone: true,
  aiGuideName: true,
  chatTheme: true,
  chatAccentColor: true,
  chatFont: true,
  chatLogoUrl: true,
  chatBannerUrl: true,
  isActive: true,
  updatedAt: true,
  venueBotConfiguration: {
    select: {
      presentationMode: true,
      personalityMode: true,
      tonePreset: true,
      tonePresetVersion: true,
      responseDepth: true,
      personalityProfileId: true,
      characterKey: true,
      customCharacterId: true,
      publicDisplayName: true,
      greeting: true,
      voiceProfileId: true,
    },
  },
} as const

const themeIds = new Set(['default', 'forest', 'sunset', 'midnight', 'rose', 'dark'])
const fontIds = new Set(['jakarta', 'inter', 'poppins', 'spaceGrotesk', 'dmSans', 'playfair'])
const accentPattern = /^#[0-9A-Fa-f]{6}$/u
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function omission(
  code: string,
  section: FullManifestProjectionOmission['section'],
  message: string,
): FullManifestProjectionOmission {
  return { code, section, message }
}

function archetypeFor(category: string | null): VenueArchetypeIdValue {
  const parsed = VenueArchetypeId.safeParse(category?.trim().toLowerCase())
  return parsed.success ? parsed.data : 'generic-physical'
}

export async function projectFullVenueDeploymentManifest(
  input: {
    tenantId: string
    venueId: string
    manifestId: string
    idempotencyKey: string
  },
  client: FullManifestProjectionClient = db,
) {
  if (
    !input.tenantId.trim() ||
    !input.venueId.trim() ||
    !uuidPattern.test(input.manifestId) ||
    !uuidPattern.test(input.idempotencyKey)
  ) {
    throw new FullManifestProjectionError(
      'INVALID_INPUT',
      'Exact scope and caller-supplied UUID envelope are required.',
    )
  }
  const venue = await client.venue.findFirst({
    where: { id: input.venueId, tenantId: input.tenantId },
    select: venueSelect,
  })
  if (!venue) throw new FullManifestProjectionError('NOT_FOUND', 'Venue not found')

  const omissions: FullManifestProjectionOmission[] = [
    omission(
      'CAPABILITY_PUBLICATION_UNAVAILABLE',
      'CAPABILITIES',
      'No canonical published capability projection exists; enabled capabilities and preset are omitted.',
    ),
    omission(
      'GENERALIZED_CONTENT_PUBLICATION_UNAVAILABLE',
      'CONTENT',
      'Generalized content modules are omitted because current publication truth is unavailable.',
    ),
    omission(
      'IMMUTABLE_ASSET_PUBLICATION_UNAVAILABLE',
      'ASSETS',
      'Assets are omitted because stored presentation URLs are not immutable deployment assets.',
    ),
    omission(
      'MODEL_REFERENCE_PUBLICATION_UNAVAILABLE',
      'AI_CONFIGURATION',
      'Model references are omitted because no canonical venue publication source exists.',
    ),
    omission(
      'READINESS_REFERENCE_UNAVAILABLE',
      'EVALUATION',
      'No persisted deployment readiness assessment is available; this projection is not ready to apply.',
    ),
    omission(
      'VENUE_CONFIGURATION_NOT_PUBLICATION_SNAPSHOT',
      'IDENTITY',
      'The venue row is current configuration, not an immutable publication snapshot.',
    ),
  ]

  if (!venue.isActive) {
    omissions.push(
      omission(
        'VENUE_INACTIVE',
        'IDENTITY',
        'The venue is inactive and cannot be considered deployment ready.',
      ),
    )
  }

  const archetype = archetypeFor(venue.category)
  if (venue.category?.trim().toLowerCase() !== archetype) {
    omissions.push(
      omission(
        'ARCHETYPE_DERIVED_FALLBACK',
        'IDENTITY',
        'The stored category is not a deployment archetype; generic-physical is used conservatively.',
      ),
    )
  }

  const themeId = themeIds.has(venue.chatTheme ?? '') ? venue.chatTheme! : 'default'
  if (themeId !== venue.chatTheme) {
    omissions.push(
      omission(
        'THEME_DERIVED_FALLBACK',
        'BRANDING',
        'The stored theme is absent or unsupported; default is used conservatively.',
      ),
    )
  }
  const fontId = fontIds.has(venue.chatFont ?? '') ? venue.chatFont! : 'jakarta'
  if (fontId !== venue.chatFont) {
    omissions.push(
      omission(
        'FONT_DERIVED_FALLBACK',
        'BRANDING',
        'The stored font is absent or unsupported; jakarta is used conservatively.',
      ),
    )
  }
  if (venue.chatLogoUrl || venue.chatBannerUrl) {
    omissions.push(
      omission(
        'URL_BRANDING_ASSETS_OMITTED',
        'ASSETS',
        'Stored logo or banner URLs are intentionally excluded from the immutable asset manifest.',
      ),
    )
  }
  if (venue.chatAccentColor && !accentPattern.test(venue.chatAccentColor)) {
    omissions.push(
      omission(
        'ACCENT_COLOR_OMITTED',
        'BRANDING',
        'The stored accent color is unsupported and was omitted.',
      ),
    )
  }

  const tone = resolveEffectiveTone(venue)
  if (tone.source !== 'versioned-preset') {
    omissions.push(
      omission(
        'TONE_DERIVED_FALLBACK',
        'AI_CONFIGURATION',
        'The versioned tone preset is unavailable; the safe compatibility resolver supplied the tone.',
      ),
    )
  }

  const description = venue.description?.trim()
  const guideName = venue.aiGuideName?.trim()
  if (guideName && guideName.length > 80) {
    omissions.push(
      omission(
        'GUIDE_NAME_OMITTED',
        'AI_CONFIGURATION',
        'The stored guide name exceeds the manifest boundary and was omitted.',
      ),
    )
  }
  if (!venue.venueBotConfiguration) {
    omissions.push(
      omission(
        'VENUE_BOT_CONFIGURATION_UNAVAILABLE',
        'AI_CONFIGURATION',
        'Venue Bot presentation is omitted because no canonical configuration row exists.',
      ),
    )
  }
  const candidate = {
    schemaVersion: 2 as const,
    packageType: 'FULL' as const,
    manifestId: input.manifestId,
    venueRef: venue.id,
    idempotencyKey: input.idempotencyKey,
    provenance: {
      sourceIds: [`venue:${venue.id}`],
      evidenceIds: [],
      createdAt: venue.updatedAt.toISOString(),
      createdBy: { kind: 'OPERATOR' as const },
      generatorRef: 'pathfinder_full_projection_v2',
    },
    identity: {
      venueStableId: venue.id,
      name: venue.name,
      slug: venue.slug,
      ...(description ? { description } : {}),
      archetype,
    },
    branding: {
      themeId,
      ...(venue.chatAccentColor && accentPattern.test(venue.chatAccentColor)
        ? { accentColor: venue.chatAccentColor }
        : {}),
      fontId,
    },
    aiConfiguration: {
      ...(guideName && guideName.length <= 80 ? { guideName } : {}),
      tone: { preset: tone.preset, behaviorVersion: tone.behaviorVersion },
      ...(venue.venueBotConfiguration ? { venueBot: venue.venueBotConfiguration } : {}),
      modelReferences: [],
    },
    capabilities: {
      enabled: [],
      effectiveConfigurationProvenance: [],
    },
    contentModules: [],
    assets: [],
    evaluation: {
      evaluationRunId: 'not_available',
      readinessAssessmentId: 'projection_not_ready',
      readiness: 'NOT_READY' as const,
    },
  }

  const parsed = VenueDeploymentFullManifest.safeParse(candidate)
  if (!parsed.success) {
    throw new FullManifestProjectionError(
      'INVALID_STATE',
      'Venue state cannot be represented safely as a FULL deployment manifest.',
    )
  }
  const manifest: VenueDeploymentFullManifestValue = parsed.data
  const canonicalJson = canonicalDeploymentManifest(manifest)
  return {
    scope: { tenantId: input.tenantId, venueId: venue.id, venueName: venue.name },
    manifest,
    canonicalJson,
    manifestHash: deploymentManifestHash(manifest),
    readiness: {
      status: 'NOT_READY' as const,
      readyForApply: false as const,
      omissions: omissions.sort((left, right) => left.code.localeCompare(right.code)),
    },
    download: {
      filename: `venue-deployment-manifest-${venue.slug}.v2.full.json`,
      mediaType: 'application/json' as const,
      byteLength: new TextEncoder().encode(canonicalJson).byteLength,
    },
  }
}
