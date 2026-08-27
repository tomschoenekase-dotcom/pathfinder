import { createHash, randomUUID } from 'node:crypto'

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { currentUser, validateExistingOrganizationOwner } from '@pathfinder/auth'
import {
  PersonalityProfileDraft,
  PublicVenueMediaItem,
  resolvePublicVenueBotPresentation,
} from '@pathfinder/contracts'
import { isFeatureEnabled, TOCHI_TENANT_FLAG_KEYS } from '@pathfinder/config'
import {
  createVenueAction,
  deleteVenueAction,
  setVenueAvailabilityAction,
  lockVenueContentMutation,
  setContentVersionContext,
  updateVenueAction,
  updateVenueAiConfigAction,
  getVenueBotConfigurationAction,
  updateVenueBotConfigurationAction,
  createPersonalityProfileAction,
  listPersonalityProfilesAction,
  updatePersonalityProfileAction,
  updateVenueChatDesignAction,
  VenueActionError,
  type VenueHumanActor,
} from '@pathfinder/db'
import { emitEvent } from '@pathfinder/analytics'
import {
  CreateVenueRequestInput,
  DeleteVenueInput,
  GetVenueBotConfigurationInput,
  normalizeInitialVenueContent,
  UpdateVenueAiConfigInput,
  UpdateVenueChatDesignInput,
  UpdateVenueBotConfigurationInput,
  UpdateVenueRequestInput,
} from '../schemas/venue'
import {
  canonicalVenueContentImportPayload,
  ImportVenueContentInput,
} from '../schemas/venue-content'

import { router } from '../core'
import { resolveSystemCharacterProjection } from '../lib/character-registry'
import { checkRateLimit } from '../lib/rate-limit'
import { requireRole } from '../middleware/require-role'
import { publicProcedure, tenantProcedure } from '../trpc'

const PUBLIC_VENUE_LOOKUP_GLOBAL_LIMIT_PER_MINUTE = 10_000

function exactDisposableLoopbackDatabase(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    const database = url.pathname.replace(/^\//u, '')
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !/^pathfinder_disposable_[a-z0-9_]+$/u.test(database)
    ) {
      return null
    }
    return `${url.hostname}:${url.port}/${database}`
  } catch {
    return null
  }
}

export function permitsLocalWorkspaceReconciliation(environment?: {
  DATABASE_URL?: string | undefined
  DIRECT_DATABASE_URL?: string | undefined
  PATHFINDER_LOCAL_STAGING_DATA_DIR?: string | undefined
}): boolean {
  const candidate = environment ?? (process.env as Record<string, string | undefined>)
  const primary = exactDisposableLoopbackDatabase(candidate.DATABASE_URL)
  const direct = exactDisposableLoopbackDatabase(candidate.DIRECT_DATABASE_URL)
  return Boolean(candidate.PATHFINDER_LOCAL_STAGING_DATA_DIR && primary && primary === direct)
}

function isMissingVenueTenant(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2003' &&
    'message' in error &&
    String(error.message).includes('venues_tenant_id_fkey')
  )
}

async function reconcileLocalWorkspace(ctx: {
  db: typeof import('@pathfinder/db').db
  session: { userId: string; activeTenantId: string }
}): Promise<void> {
  if (!permitsLocalWorkspaceReconciliation()) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'The selected client workspace is not available in this environment.',
    })
  }

  const user = await currentUser()
  const email =
    user?.emailAddresses.find((address) => address.id === user.primaryEmailAddressId)
      ?.emailAddress ?? user?.emailAddresses[0]?.emailAddress
  if (!user || user.id !== ctx.session.userId || !email) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication must be refreshed.' })
  }

  const organization = await validateExistingOrganizationOwner({
    organizationId: ctx.session.activeTenantId,
    userId: ctx.session.userId,
    emailAddress: email,
  })
  const slugBase = slugify(organization.organizationSlug) || 'workspace'
  const localSlug = `${slugBase}-${createHash('sha256')
    .update(organization.organizationId)
    .digest('hex')
    .slice(0, 10)}`

  await ctx.db.$transaction(async (tx) => {
    await tx.tenant.upsert({
      where: { id: organization.organizationId },
      create: {
        id: organization.organizationId,
        name: organization.organizationName,
        slug: localSlug,
      },
      update: { name: organization.organizationName },
    })
    await tx.user.upsert({
      where: { id: user.id },
      create: { id: user.id, email },
      update: { email },
    })
    await tx.tenantMembership.upsert({
      where: {
        tenantId: organization.organizationId,
        tenantId_userId: {
          tenantId: organization.organizationId,
          userId: user.id,
        },
      },
      create: {
        tenantId: organization.organizationId,
        userId: user.id,
        role: 'OWNER',
        status: 'ACTIVE',
        joinedAt: new Date(),
      },
      update: { role: 'OWNER', status: 'ACTIVE' },
    })
    await tx.auditLog.create({
      data: {
        tenantId: organization.organizationId,
        actorId: user.id,
        actorRole: 'OWNER',
        action: 'local-staging.workspace.reconciled',
        targetType: 'Tenant',
        targetId: organization.organizationId,
        afterState: { source: 'validated-clerk-owner', localOnly: true },
      },
    })
  })
}

function venueActor(session: { userId: string | null; role: string | null }): VenueHumanActor {
  return {
    type: 'HUMAN',
    id: session.userId!,
    role: session.role === 'OWNER' ? 'OWNER' : 'MANAGER',
  }
}

function mapVenueActionError(error: unknown): void {
  if (!(error instanceof VenueActionError)) return
  throw new TRPCError({
    code:
      error.code === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : error.code === 'CONFLICT'
          ? 'CONFLICT'
          : 'BAD_REQUEST',
    message: error.message,
    cause: error,
  })
}

type VenueContentImportReceiptResult = {
  payloadHash: string
  placeCount: number
  knowledgeEntryCount: number
}

function publicVenueUnavailable(): TRPCError {
  return new TRPCError({
    code: 'SERVICE_UNAVAILABLE',
    message: 'This venue guide is temporarily unavailable.',
  })
}

async function requireCharacterConfigurationRollout(
  db: typeof import('@pathfinder/db').db,
  tenantId: string,
  characterKey?: string | null,
): Promise<void> {
  const globalKeys = ['venueCharacterMode', 'characterRegistry'] as const
  if (
    globalKeys.some((key) => !isFeatureEnabled(key)) ||
    (characterKey === 'tochi' && !isFeatureEnabled('tochiVenueCharacter'))
  ) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Character presentation is not available for this workspace.',
    })
  }
  const requiredTenantKeys = [
    TOCHI_TENANT_FLAG_KEYS.venueCharacterMode,
    TOCHI_TENANT_FLAG_KEYS.characterRegistry,
    ...(characterKey === 'tochi' ? [TOCHI_TENANT_FLAG_KEYS.tochiVenueCharacter] : []),
  ]
  const rows = await db.tenantFeatureFlag.findMany({
    where: { tenantId, flagKey: { in: requiredTenantKeys }, enabled: true },
    select: { flagKey: true },
  })
  const enabled = new Set(rows.map(({ flagKey }) => flagKey))
  if (requiredTenantKeys.some((key) => !enabled.has(key))) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Character presentation is not available for this workspace.',
    })
  }
}

function venueContentImportPayloadHash(input: ImportVenueContentInput): string {
  return createHash('sha256').update(canonicalVenueContentImportPayload(input)).digest('hex')
}

function replayVenueContentImport(
  receipt: VenueContentImportReceiptResult,
  payloadHash: string,
): { placeCount: number; knowledgeEntryCount: number; replayed: true } {
  if (receipt.payloadHash !== payloadHash) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'This import attempt key was already used for different content.',
    })
  }

  return {
    placeCount: receipt.placeCount,
    knowledgeEntryCount: receipt.knowledgeEntryCount,
    replayed: true,
  }
}

// ---------------------------------------------------------------------------
// Slug utility
// ---------------------------------------------------------------------------

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
}

// ---------------------------------------------------------------------------
// Input schemas — defined in ../schemas/venue (client-safe, re-exported here)
// ---------------------------------------------------------------------------

export { CreateVenueInput, UpdateVenueInput } from '../schemas/venue'

// ---------------------------------------------------------------------------
// Select shapes
// ---------------------------------------------------------------------------

const venueListSelect = {
  id: true,
  tenantId: true,
  name: true,
  slug: true,
  description: true,
  guideNotes: true,
  category: true,
  guideMode: true,
  defaultCenterLat: true,
  defaultCenterLng: true,
  aiGuideName: true,
  chatTheme: true,
  chatAccentColor: true,
  chatFont: true,
  chatLogoUrl: true,
  chatBannerUrl: true,
  isActive: true,
  secondLayerEnabled: true,
  secondLayerLabel: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { places: true } },
  // geoBoundary intentionally excluded from list views
} as const

function buildVenueDetailSelect(tenantId: string) {
  return {
    ...venueListSelect,
    _count: {
      select: {
        places: true,
        knowledgeEntries: { where: { tenantId, isEnabled: true } },
      },
    },
  } as const
}

const venueAiConfigSelect = {
  aiGuideNotes: true,
  aiFeaturedPlaceId: true,
  aiTone: true,
  tonePreset: true,
  tonePresetVersion: true,
  aiGuideName: true,
  updatedAt: true,
} as const

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const venueRouter = router({
  getBySlug: publicProcedure
    .input(
      z
        .object({
          slug: z.string().min(1).max(200),
          secondLayerKey: z.string().uuid().optional(),
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      const globallyAllowed = await checkRateLimit(
        'ratelimit:venue-lookup:ingress:global',
        PUBLIC_VENUE_LOOKUP_GLOBAL_LIMIT_PER_MINUTE,
        60,
      )
      if (!globallyAllowed) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many venue lookups. Please try again later.',
        })
      }

      // $queryRaw used here because this is a public cross-tenant lookup — the caller
      // only knows the slug, not the tenantId. No tenant_id bind needed in the
      // WHERE because we are resolving the venue for display, not filtering by tenant.
      const [venue] = await ctx.db.$queryRaw<
        {
          id: string
          tenantId: string
          name: string
          description: string | null
          category: string | null
          guideMode: string
          defaultCenterLat: number | null
          defaultCenterLng: number | null
          aiGuideName: string | null
          chatTheme: string | null
          chatAccentColor: string | null
          chatFont: string | null
          chatLogoUrl: string | null
          chatBannerUrl: string | null
          isActive: boolean
          secondLayerEnabled: boolean
          secondLayerLabel: string
          secondLayerAccessKey: string | null
          venueBotConfigurationId: string | null
          venueBotPresentationMode: 'CLASSIC' | 'CHARACTER' | null
          venueBotTonePreset: string | null
          venueBotCharacterKey: string | null
          venueBotPublicDisplayName: string | null
          venueBotGreeting: string | null
        }[]
      >`
        SELECT v.id, v.tenant_id AS "tenantId", v.name, v.description, v.category,
               guide_mode            AS "guideMode",
               default_center_lat    AS "defaultCenterLat",
               default_center_lng    AS "defaultCenterLng",
               ai_guide_name         AS "aiGuideName",
               chat_theme            AS "chatTheme",
               chat_accent_color     AS "chatAccentColor",
               chat_font             AS "chatFont",
               chat_logo_url         AS "chatLogoUrl",
               chat_banner_url       AS "chatBannerUrl",
               is_active             AS "isActive"
               ,second_layer_enabled AS "secondLayerEnabled"
               ,second_layer_label AS "secondLayerLabel"
               ,second_layer_access_key AS "secondLayerAccessKey"
               ,vbc.id AS "venueBotConfigurationId"
               ,vbc.presentation_mode AS "venueBotPresentationMode"
               ,vbc.tone_preset AS "venueBotTonePreset"
               ,vbc.character_key AS "venueBotCharacterKey"
               ,vbc.public_display_name AS "venueBotPublicDisplayName"
               ,vbc.greeting AS "venueBotGreeting"
        FROM venues v
        LEFT JOIN venue_bot_configurations vbc
          ON vbc.venue_id = v.id AND vbc.tenant_id = v.tenant_id
        WHERE v.slug = ${input.slug} LIMIT 1
      `

      if (!venue) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      }
      const { isActive, ...publicVenue } = venue
      if (!isActive) throw publicVenueUnavailable()

      const isSecondLayer = input.secondLayerKey !== undefined
      if (
        isSecondLayer &&
        (!venue.secondLayerEnabled ||
          venue.secondLayerAccessKey !== input.secondLayerKey ||
          ctx.session.userId === null ||
          ctx.session.activeTenantId !== venue.tenantId ||
          ctx.session.role === null)
      ) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue experience not found' })
      }

      const {
        secondLayerAccessKey: _secret,
        secondLayerEnabled: _enabled,
        secondLayerLabel: _label,
        tenantId: _tenantId,
        venueBotConfigurationId: _venueBotConfigurationId,
        venueBotPresentationMode: _venueBotPresentationMode,
        venueBotTonePreset: _venueBotTonePreset,
        venueBotCharacterKey: _venueBotCharacterKey,
        venueBotPublicDisplayName: _venueBotPublicDisplayName,
        venueBotGreeting: _venueBotGreeting,
        ...safeVenue
      } = publicVenue
      void _secret
      void _enabled
      void _label
      void _tenantId
      void _venueBotConfigurationId
      void _venueBotPresentationMode
      void _venueBotTonePreset
      void _venueBotCharacterKey
      void _venueBotPublicDisplayName
      void _venueBotGreeting

      let venueBotPresentation = null
      if (isFeatureEnabled('venueCharacterMode') && isFeatureEnabled('characterRegistry')) {
        const configuredCharacterKey = venue.venueBotCharacterKey
        const enabledFlags = await ctx.db.tenantFeatureFlag.findMany({
          where: {
            tenantId: venue.tenantId,
            flagKey: {
              in: [
                TOCHI_TENANT_FLAG_KEYS.venueCharacterMode,
                TOCHI_TENANT_FLAG_KEYS.characterRegistry,
                ...(configuredCharacterKey === 'tochi'
                  ? [TOCHI_TENANT_FLAG_KEYS.tochiVenueCharacter]
                  : []),
              ],
            },
            enabled: true,
          },
          select: { flagKey: true },
        })
        const enabledKeys = new Set(enabledFlags.map(({ flagKey }) => flagKey))
        if (
          enabledKeys.has(TOCHI_TENANT_FLAG_KEYS.venueCharacterMode) &&
          enabledKeys.has(TOCHI_TENANT_FLAG_KEYS.characterRegistry) &&
          (configuredCharacterKey !== 'tochi' ||
            (isFeatureEnabled('tochiVenueCharacter') &&
              enabledKeys.has(TOCHI_TENANT_FLAG_KEYS.tochiVenueCharacter)))
        ) {
          venueBotPresentation = resolvePublicVenueBotPresentation({
            configuration: venue.venueBotConfigurationId
              ? {
                  presentationMode: venue.venueBotPresentationMode ?? 'CLASSIC',
                  tonePreset:
                    venue.venueBotTonePreset === 'concise' ||
                    venue.venueBotTonePreset === 'enthusiastic' ||
                    venue.venueBotTonePreset === 'informative'
                      ? venue.venueBotTonePreset
                      : 'friendly',
                  characterKey: venue.venueBotCharacterKey,
                  publicDisplayName: venue.venueBotPublicDisplayName,
                  greeting: venue.venueBotGreeting,
                }
              : null,
            rolloutEnabled: true,
            approvedCharacter: resolveSystemCharacterProjection(configuredCharacterKey),
          })
        }
      }

      const projectedVenue = venueBotPresentation
        ? { ...safeVenue, venueBotPresentation }
        : safeVenue
      return isSecondLayer
        ? {
            ...projectedVenue,
            experienceScope: 'SECOND_LAYER' as const,
            experienceLabel: venue.secondLayerLabel,
          }
        : projectedVenue
    }),

  mediaBySlug: publicProcedure
    .input(z.object({ slug: z.string().trim().min(1).max(200) }).strict())
    .query(async ({ ctx, input }) => {
      const globallyAllowed = await checkRateLimit(
        'ratelimit:venue-media-list:ingress:global',
        PUBLIC_VENUE_LOOKUP_GLOBAL_LIMIT_PER_MINUTE,
        60,
      )
      if (!globallyAllowed) {
        throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Too many venue lookups.' })
      }
      const [venue] = await ctx.db.$queryRaw<{ id: string; tenantId: string }[]>`
        SELECT id, tenant_id AS "tenantId"
        FROM venues
        WHERE slug = ${input.slug} AND is_active = true
        LIMIT 1
      `
      if (!venue)
        return {
          items: [],
          sourceDelivery: 'CONTROLLED_SAME_ORIGIN' as const,
          rawStorageLocatorsExposed: false as const,
        }
      const rows = await ctx.db.venueMediaDerivative.findMany({
        where: {
          tenantId: venue.tenantId,
          venueId: venue.id,
          status: 'READY',
          variant: 'CARD',
        },
        orderBy: [{ asset: { importance: 'asc' } }, { createdAt: 'asc' }, { id: 'asc' }],
        take: 50,
        select: {
          id: true,
          approvedReviewSequence: true,
          mimeType: true,
          width: true,
          height: true,
          byteSize: true,
          variant: true,
          asset: {
            select: {
              id: true,
              kind: true,
              altText: true,
              caption: true,
              importance: true,
              reviews: {
                orderBy: { sequence: 'desc' },
                take: 1,
                select: { sequence: true, action: true, rightsBasis: true },
              },
            },
          },
        },
      })
      return {
        items: rows
          .filter((row) => {
            const latest = row.asset.reviews[0]
            return (
              latest?.sequence === row.approvedReviewSequence &&
              latest.action === 'APPROVE_CONTENT_USE' &&
              latest.rightsBasis !== null
            )
          })
          .slice(0, 20)
          .map((row) =>
            PublicVenueMediaItem.parse({
              assetId: row.asset.id,
              derivativeId: row.id,
              variant: row.variant,
              kind: row.asset.kind,
              altText: row.asset.altText,
              caption: row.asset.caption,
              importance: row.asset.importance,
              width: row.width,
              height: row.height,
              byteSize: row.byteSize,
              mimeType: row.mimeType,
              deliveryPath: `/api/venue-media/${row.id}?venue=${encodeURIComponent(input.slug)}`,
            }),
          ),
        sourceDelivery: 'CONTROLLED_SAME_ORIGIN' as const,
        rawStorageLocatorsExposed: false as const,
      }
    }),

  list: tenantProcedure.query(async ({ ctx }) => {
    return ctx.db.venue.findMany({
      where: { tenantId: ctx.session.activeTenantId },
      select: venueListSelect,
      orderBy: { createdAt: 'asc' },
    })
  }),

  getById: tenantProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const venue = await ctx.db.venue.findFirst({
        where: { id: input.id, tenantId: ctx.session.activeTenantId },
        select: buildVenueDetailSelect(ctx.session.activeTenantId),
      })

      if (!venue) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      }

      return venue
    }),

  getSecondLayer: tenantProcedure
    .input(z.object({ venueId: z.string().cuid() }).strict())
    .query(async ({ ctx, input }) => {
      const venue = await ctx.db.venue.findFirst({
        where: { id: input.venueId, tenantId: ctx.session.activeTenantId },
        select: {
          id: true,
          slug: true,
          secondLayerEnabled: true,
          secondLayerLabel: true,
          secondLayerAccessKey: true,
          updatedAt: true,
        },
      })
      if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      return venue
    }),

  updateSecondLayer: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(
      z
        .object({
          venueId: z.string().cuid(),
          label: z.string().trim().min(1).max(40),
          rotateLink: z.boolean().default(false),
          expectedUpdatedAt: z.coerce.date(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      const venue = await ctx.db.venue.findFirst({
        where: { id: input.venueId, tenantId },
        select: {
          id: true,
          secondLayerEnabled: true,
          secondLayerLabel: true,
          secondLayerAccessKey: true,
          updatedAt: true,
        },
      })
      if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      if (!venue.secondLayerEnabled) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'The premium second layer is not enabled for this venue.',
        })
      }
      const accessKey = input.rotateLink ? randomUUID() : venue.secondLayerAccessKey
      if (!accessKey)
        throw new TRPCError({ code: 'CONFLICT', message: 'Second layer link missing' })
      const nextUpdatedAt = new Date(Math.max(Date.now(), venue.updatedAt.getTime() + 1))
      await ctx.db.$transaction(async (tx) => {
        const changed = await tx.venue.updateMany({
          where: { id: input.venueId, tenantId, updatedAt: input.expectedUpdatedAt },
          data: {
            secondLayerLabel: input.label,
            secondLayerAccessKey: accessKey,
            updatedAt: nextUpdatedAt,
          },
        })
        if (changed.count !== 1) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Employee assistant settings changed; refresh and try again.',
          })
        }
        await tx.auditLog.create({
          data: {
            tenantId,
            actorId: ctx.session.userId!,
            actorRole: ctx.session.role ?? 'MANAGER',
            action: input.rotateLink
              ? 'venue.second-layer.link-rotated'
              : 'venue.second-layer.updated',
            targetType: 'Venue',
            targetId: input.venueId,
            beforeState: { label: venue.secondLayerLabel },
            afterState: { label: input.label, linkRotated: input.rotateLink },
          },
        })
      })
      return {
        enabled: true as const,
        label: input.label,
        accessKey,
        updatedAt: nextUpdatedAt,
      }
    }),

  getAiConfig: tenantProcedure
    .input(
      z
        .object({
          venueId: z.string().cuid(),
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      const venue = await ctx.db.venue.findFirst({
        where: { id: input.venueId, tenantId: ctx.session.activeTenantId },
        select: venueAiConfigSelect,
      })

      if (!venue) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      }

      return venue
    }),

  create: tenantProcedure
    .use(requireRole('OWNER'))
    .input(CreateVenueRequestInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      const baseSlug = input.slug ? slugify(input.slug) : slugify(input.name)
      const initialContent = normalizeInitialVenueContent(input)
      const guideMode = input.guideMode ?? 'location_aware'

      try {
        const create = () =>
          createVenueAction(
            {
              tenantId,
              actor: venueActor(ctx.session),
              name: input.name,
              baseSlug,
              callerSuppliedSlug: input.slug !== undefined,
              ...(input.description !== undefined ? { description: input.description } : {}),
              ...(input.guideNotes !== undefined ? { guideNotes: input.guideNotes } : {}),
              ...(input.category !== undefined ? { category: input.category } : {}),
              guideMode,
              ...(input.defaultCenterLat !== undefined
                ? { defaultCenterLat: input.defaultCenterLat }
                : {}),
              ...(input.defaultCenterLng !== undefined
                ? { defaultCenterLng: input.defaultCenterLng }
                : {}),
              ...(initialContent !== undefined ? { initialContent } : {}),
            },
            ctx.db,
          )
        let created
        try {
          created = await create()
        } catch (error) {
          if (!isMissingVenueTenant(error)) throw error
          await reconcileLocalWorkspace({
            db: ctx.db,
            session: { userId: ctx.session.userId, activeTenantId: tenantId },
          })
          created = await create()
        }

        const { places = [], knowledgeEntries = [], ...venue } = created.record
        void places
        void knowledgeEntries
        return venue
      } catch (err: unknown) {
        mapVenueActionError(err)
        const msg = err instanceof Error ? err.message : ''
        if (msg.includes('venues_tenant_id_slug_key')) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'A venue with this slug already exists',
          })
        }
        throw err
      }
    }),

  update: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(UpdateVenueRequestInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      const { id, expectedUpdatedAt, ...raw } = input
      // Strip undefined — exactOptionalPropertyTypes requires no undefined values in Prisma data
      const fields = Object.fromEntries(
        Object.entries(raw).filter(([, value]) => value !== undefined),
      )
      try {
        return await updateVenueAction(
          { tenantId, venueId: id, expectedUpdatedAt, actor: venueActor(ctx.session), fields },
          ctx.db,
        )
      } catch (error) {
        mapVenueActionError(error)
        throw error
      }
    }),

  setAvailability: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(
      z
        .object({
          venueId: z.string().cuid(),
          enabled: z.boolean(),
          expectedUpdatedAt: z.coerce.date(),
          reason: z.string().trim().min(1).max(500),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await setVenueAvailabilityAction(
          {
            tenantId: ctx.session.activeTenantId,
            venueId: input.venueId,
            expectedUpdatedAt: input.expectedUpdatedAt,
            enabled: input.enabled,
            reason: input.reason,
            actor: venueActor(ctx.session),
          },
          ctx.db,
        )
      } catch (error) {
        mapVenueActionError(error)
        throw error
      }
    }),

  importContent: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(ImportVenueContentInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      const venue = await ctx.db.venue.findFirst({
        where: { id: input.venueId, tenantId },
        select: { id: true, guideMode: true },
      })

      if (!venue) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      }

      const receiptWhere = {
        tenantId,
        venueId: input.venueId,
        idempotencyKey: input.idempotencyKey,
      }
      const receiptSelect = {
        payloadHash: true,
        placeCount: true,
        knowledgeEntryCount: true,
      } as const
      const payloadHash = venueContentImportPayloadHash(input)
      const existingReceipt = await ctx.db.venueContentImportReceipt.findFirst({
        where: receiptWhere,
        select: receiptSelect,
      })
      if (existingReceipt) return replayVenueContentImport(existingReceipt, payloadHash)

      if (
        venue.guideMode === 'location_aware' &&
        input.places.some((place) => place.lat === undefined || place.lng === undefined)
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Latitude and longitude are required for every guide item at this venue',
        })
      }

      return ctx.db.$transaction(async (tx) => {
        await setContentVersionContext(tx, { actorId: ctx.session.userId })
        await lockVenueContentMutation(tx, { tenantId, venueId: input.venueId })
        const claimed = await tx.venueContentImportReceipt.createMany({
          data: [
            {
              tenantId,
              venueId: input.venueId,
              idempotencyKey: input.idempotencyKey,
              payloadHash,
              placeCount: input.places.length,
              knowledgeEntryCount: input.knowledgeEntries.length,
            },
          ],
          skipDuplicates: true,
        })

        if (claimed.count === 0) {
          const concurrentReceipt = await tx.venueContentImportReceipt.findFirst({
            where: receiptWhere,
            select: receiptSelect,
          })
          if (!concurrentReceipt) {
            throw new Error('Venue content import receipt claim was lost')
          }
          return replayVenueContentImport(concurrentReceipt, payloadHash)
        }

        if (input.places.length > 0) {
          await tx.place.createMany({
            data: input.places.map((place) => ({
              tenantId,
              venueId: input.venueId,
              name: place.name,
              type: place.type,
              ...(place.itemType !== undefined ? { itemType: place.itemType } : {}),
              ...(place.lat !== undefined ? { lat: place.lat } : {}),
              ...(place.lng !== undefined ? { lng: place.lng } : {}),
              tags: place.tags,
              importanceScore: place.importanceScore,
              ...(place.shortDescription !== undefined
                ? { shortDescription: place.shortDescription }
                : {}),
              ...(place.longDescription !== undefined
                ? { longDescription: place.longDescription }
                : {}),
              ...(place.areaName !== undefined ? { areaName: place.areaName } : {}),
              ...(place.hours !== undefined ? { hours: place.hours } : {}),
              ...(place.photoUrl !== undefined ? { photoUrl: place.photoUrl } : {}),
            })),
          })
        }
        if (input.knowledgeEntries.length > 0) {
          await tx.venueKnowledgeEntry.createMany({
            data: input.knowledgeEntries.map((entry) => ({
              tenantId,
              venueId: input.venueId,
              title: entry.title,
              category: entry.category,
              content: entry.content,
              isEnabled: entry.isEnabled,
            })),
          })
        }

        return {
          placeCount: input.places.length,
          knowledgeEntryCount: input.knowledgeEntries.length,
          replayed: false as const,
        }
      })
    }),

  updateAiConfig: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(UpdateVenueAiConfigInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      const { venueId, expectedUpdatedAt, ...fields } = input
      let updated
      try {
        updated = await updateVenueAiConfigAction(
          { tenantId, venueId, expectedUpdatedAt, actor: venueActor(ctx.session), fields },
          ctx.db,
        )
      } catch (error) {
        mapVenueActionError(error)
        throw error
      }

      try {
        await emitEvent({
          tenantId,
          venueId: input.venueId,
          eventType: 'venue.updated',
        })
      } catch {
        // Venue analytics are best-effort and must not break the mutation.
      }

      return updated
    }),

  getBotConfiguration: tenantProcedure
    .input(GetVenueBotConfigurationInput)
    .query(async ({ ctx, input }) => {
      try {
        return await getVenueBotConfigurationAction(
          { tenantId: ctx.session.activeTenantId, venueId: input.venueId },
          ctx.db,
        )
      } catch (error) {
        mapVenueActionError(error)
        throw error
      }
    }),

  updateBotConfiguration: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(UpdateVenueBotConfigurationInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      const { venueId, expectedRevision, ...fields } = input
      if (
        input.presentationMode === 'CHARACTER' ||
        typeof input.characterKey === 'string' ||
        typeof input.customCharacterId === 'string'
      ) {
        await requireCharacterConfigurationRollout(ctx.db, tenantId, input.characterKey)
      }
      let updated
      try {
        updated = await updateVenueBotConfigurationAction(
          {
            tenantId,
            venueId,
            expectedRevision,
            actor: venueActor(ctx.session),
            fields,
          },
          ctx.db,
        )
      } catch (error) {
        mapVenueActionError(error)
        throw error
      }

      try {
        if (input.presentationMode !== undefined) {
          await emitEvent({
            tenantId,
            venueId,
            eventType: 'venue_bot_presentation_changed',
            metadata: { presentationMode: updated.presentationMode },
          })
          if (updated.presentationMode === 'CLASSIC') {
            await emitEvent({ tenantId, venueId, eventType: 'character_mode_disabled' })
          }
        }
        if (input.characterKey !== undefined || input.customCharacterId !== undefined) {
          await emitEvent({
            tenantId,
            venueId,
            eventType: 'character_selected',
            metadata: {
              characterKey: updated.characterKey,
              customCharacterSelected: updated.customCharacterId !== null,
            },
          })
        }
      } catch {
        // Product analytics remain best-effort and never invalidate persistence.
      }
      return updated
    }),

  listPersonalityProfiles: tenantProcedure
    .input(z.object({ venueId: z.string().cuid() }).strict())
    .query(({ ctx, input }) =>
      listPersonalityProfilesAction(
        { tenantId: ctx.session.activeTenantId, venueId: input.venueId },
        ctx.db,
      ),
    ),

  createPersonalityProfile: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(z.object({ venueId: z.string().cuid(), profile: PersonalityProfileDraft }).strict())
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      try {
        const profile = await createPersonalityProfileAction(
          {
            tenantId,
            venueId: input.venueId,
            profile: input.profile,
            actor: venueActor(ctx.session),
          },
          ctx.db,
        )
        await emitEvent({
          tenantId,
          venueId: input.venueId,
          eventType: 'custom_personality_saved',
          metadata: { profileId: profile.id, operation: 'created' },
        }).catch(() => undefined)
        return profile
      } catch (error) {
        mapVenueActionError(error)
        throw error
      }
    }),

  updatePersonalityProfile: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(
      z
        .object({
          venueId: z.string().cuid(),
          profileId: z.string().min(1).max(191),
          expectedRevision: z.number().int().positive(),
          profile: PersonalityProfileDraft,
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      try {
        const profile = await updatePersonalityProfileAction(
          {
            tenantId,
            venueId: input.venueId,
            profileId: input.profileId,
            expectedRevision: input.expectedRevision,
            profile: input.profile,
            actor: venueActor(ctx.session),
          },
          ctx.db,
        )
        await emitEvent({
          tenantId,
          venueId: input.venueId,
          eventType: 'custom_personality_saved',
          metadata: { profileId: profile.id, operation: 'updated' },
        }).catch(() => undefined)
        return profile
      } catch (error) {
        mapVenueActionError(error)
        throw error
      }
    }),

  updateChatDesign: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(UpdateVenueChatDesignInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      const { venueId, expectedUpdatedAt, ...fields } = input
      let updated
      try {
        updated = await updateVenueChatDesignAction(
          { tenantId, venueId, expectedUpdatedAt, actor: venueActor(ctx.session), fields },
          ctx.db,
        )
      } catch (error) {
        mapVenueActionError(error)
        throw error
      }

      try {
        await emitEvent({
          tenantId,
          venueId: input.venueId,
          eventType: 'venue.updated',
        })
      } catch {
        // Venue analytics are best-effort and must not break the mutation.
      }

      return updated
    }),

  delete: tenantProcedure
    .use(requireRole('OWNER'))
    .input(DeleteVenueInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      try {
        return await deleteVenueAction(
          {
            tenantId,
            venueId: input.id,
            expectedUpdatedAt: input.expectedUpdatedAt,
            actor: venueActor(ctx.session),
          },
          ctx.db,
        )
      } catch (error: unknown) {
        mapVenueActionError(error)
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'P2003'
        ) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Retained package or other dependent history prevents deleting this venue',
            cause: error,
          })
        }
        throw error
      }
    }),
})
