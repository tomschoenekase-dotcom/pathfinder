import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { readGuestPreviewSigningSecret } from '@pathfinder/config/guest-preview-secret'
import { NativeCoreVisibleState } from '@pathfinder/contracts/native-venue-deployment'

import type { TRPCContext } from '../context'
import { router } from '../core'
import {
  GUEST_PREVIEW_TOKEN_MAX_LENGTH,
  GuestPreviewTokenError,
  verifyGuestPreviewToken,
  type GuestPreviewClaims,
} from '../lib/guest-preview-token'
import { loadReviewableVenuePackageEvaluationPreview } from '../lib/reviewable-package-evaluation'
import { checkRateLimit } from '../lib/rate-limit'
import { publicProcedure } from '../trpc'

const PREVIEW_LIMIT_PER_MINUTE = 600

/** Every refusal is the same answer, so a caller learns nothing about which check failed. */
function previewNotFound(): never {
  throw new TRPCError({ code: 'NOT_FOUND', message: 'Preview not found' })
}

export type GuestPreviewPlace = {
  name: string
  type: string
  shortDescription: string | null
  longDescription: string | null
  areaName: string | null
  hours: string | null
}
export type GuestPreviewKnowledge = { title: string; category: string; content: string }
export type GuestPreviewModule = { kind: string; title: string; text: string }

export type GuestPreview = {
  version: {
    kind: 'release' | 'package'
    id: string
    status: string
    expiresAt: string
  }
  venue: {
    name: string
    description: string | null
    category: string | null
    guideName: string | null
    theme: string | null
    accentColor: string | null
    font: string | null
  }
  places: GuestPreviewPlace[]
  knowledgeEntries: GuestPreviewKnowledge[]
  modules: GuestPreviewModule[]
  /** The preview shows content only. It sends no messages and is never indexed or shared. */
  readOnly: true
}

type PreviewDb = TRPCContext['db']

async function packagePreview(
  db: PreviewDb,
  claims: GuestPreviewClaims,
): Promise<Omit<GuestPreview, 'version'> & { status: string }> {
  let loaded: Awaited<ReturnType<typeof loadReviewableVenuePackageEvaluationPreview>>
  try {
    loaded = await loadReviewableVenuePackageEvaluationPreview(
      db as never,
      claims.tenantId,
      { venueId: claims.venueId, packageId: claims.versionId },
      { publicAudienceOnly: true },
    )
  } catch {
    return previewNotFound()
  }
  const { venue, experience } = loaded.preview
  return {
    status: loaded.package.status,
    venue: {
      name: venue.name,
      description: venue.description,
      category: venue.category,
      guideName: venue.guide.name,
      theme: venue.branding.theme,
      accentColor: venue.branding.accentColor,
      font: venue.branding.font,
    },
    places: experience.places.map((place) => ({
      name: place.name,
      type: place.type,
      shortDescription: place.shortDescription,
      longDescription: place.longDescription,
      areaName: place.areaName,
      hours: place.hours,
    })),
    knowledgeEntries: experience.knowledgeEntries.map((entry) => ({ ...entry })),
    modules: [],
    readOnly: true,
  }
}

function moduleView(
  state: ReturnType<typeof NativeCoreVisibleState.parse>['generalizedModules'][number],
) {
  const payload = state.payload
  switch (payload.kind) {
    case 'SERVICE':
      return { kind: payload.kind, title: payload.name, text: payload.description ?? '' }
    case 'POLICY':
      return { kind: payload.kind, title: payload.title, text: payload.rule }
    case 'EVENT':
      return { kind: payload.kind, title: payload.name, text: payload.description ?? '' }
    case 'OPERATIONAL_FACT':
      return { kind: payload.kind, title: payload.label, text: payload.value }
    default:
      return null
  }
}

async function releasePreview(
  db: PreviewDb,
  claims: GuestPreviewClaims,
): Promise<Omit<GuestPreview, 'version'> & { status: string }> {
  const release = await db.nativeVenueDeploymentRelease.findFirst({
    where: { id: claims.versionId, tenantId: claims.tenantId, venueId: claims.venueId },
    select: { status: true, plan: true },
  })
  if (!release) return previewNotFound()
  const desired = NativeCoreVisibleState.safeParse(
    (release.plan as { desired?: unknown } | null)?.desired,
  )
  if (!desired.success) return previewNotFound()
  const state = desired.data
  return {
    status: release.status,
    venue: {
      name: state.venue.name,
      description: state.venue.description,
      category: state.venue.category,
      guideName: state.venue.aiGuideName,
      theme: state.venue.chatTheme,
      accentColor: state.venue.chatAccentColor,
      font: state.venue.chatFont,
    },
    // The native state already contains only active, enabled, PUBLIC content: its contract admits
    // no other visibility and only PUBLIC-audience generalized modules.
    places: state.places.map((place) => ({
      name: place.name,
      type: place.type,
      shortDescription: place.shortDescription,
      longDescription: place.longDescription,
      areaName: place.areaName,
      hours: place.hours,
    })),
    knowledgeEntries: state.knowledgeEntries.map((entry) => ({
      title: entry.title,
      category: entry.category,
      content: entry.content,
    })),
    modules: state.generalizedModules.flatMap((module) => {
      const view = moduleView(module)
      return view ? [view] : []
    }),
    readOnly: true,
  }
}

export const guestPreviewRouter = router({
  /**
   * Renders one exact, private version (a native release or a reviewable package draft) for a
   * holder of a valid signed link. The link, not the venue's availability, is the authority: a
   * draft or inactive venue is previewable only here and stays unreachable on the public route.
   * Verification happens before any database access, and every refusal looks the same.
   */
  getByToken: publicProcedure
    .input(
      z
        .object({
          slug: z.string().trim().min(1).max(200),
          token: z.string().min(1).max(GUEST_PREVIEW_TOKEN_MAX_LENGTH),
        })
        .strict(),
    )
    .query(async ({ ctx, input }): Promise<GuestPreview> => {
      const allowed = await checkRateLimit(
        'ratelimit:guest-preview:global',
        PREVIEW_LIMIT_PER_MINUTE,
        60,
      )
      if (!allowed) {
        throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Too many preview requests.' })
      }
      let claims: GuestPreviewClaims
      try {
        claims = verifyGuestPreviewToken({
          secret: readGuestPreviewSigningSecret(),
          token: input.token,
        })
      } catch (error) {
        if (error instanceof GuestPreviewTokenError) return previewNotFound()
        throw error
      }
      // The URL's slug must name the venue the token was minted for, in the token's own tenant.
      // The query binds tenant_id and venue_id from the verified claim, never from the client.
      const venue = await ctx.db.venue.findFirst({
        where: { id: claims.venueId, tenantId: claims.tenantId, slug: input.slug },
        select: { id: true },
      })
      if (!venue) return previewNotFound()
      const content =
        claims.kind === 'release'
          ? await releasePreview(ctx.db, claims)
          : await packagePreview(ctx.db, claims)
      const { status, ...rest } = content
      return {
        ...rest,
        version: {
          kind: claims.kind,
          id: claims.versionId,
          status,
          expiresAt: claims.expiresAt.toISOString(),
        },
      }
    }),
})
