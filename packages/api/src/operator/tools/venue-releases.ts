import { readGuestPreviewSigningSecret } from '@pathfinder/config/guest-preview-secret'
import { NativeCoreVisibleState } from '@pathfinder/contracts/native-venue-deployment'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import {
  assessNativeGuestReadActivationAction,
  measureNativeContentConvergenceAction,
  resolveEffectivePublishedUniversalContent,
  resolveNativeGuestReadSnapshotAction,
} from '@pathfinder/db'

import {
  GUEST_PREVIEW_TOKEN_DEFAULT_TTL_SECONDS,
  GuestPreviewTokenError,
  mintGuestPreviewToken,
} from '../../lib/guest-preview-token'
import { parseExactOrigin } from '../config'
import { assertVenueInGrant, OperatorNotFoundError } from '../grants'
import { evaluatePreflight, preflightReady, type PreflightTarget } from '../release-preflight'
import type { OperatorCallContext, OperatorReadTool } from '../registry'
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  OperatorInvalidCursorError,
  pageResult,
} from './page'

const PAGE_SIZE = 25

type Database = OperatorCallContext['database']
type Scope = { tenantId: string; venueId: string }
type ReleaseKindValue = 'NATIVE_RELEASE' | 'PACKAGE_DRAFT'

const iso = (value: Date | null) => (value ? value.toISOString() : null)

type ReleaseRow = {
  kind: ReleaseKindValue
  id: string
  status: string
  createdAt: Date
  updatedAt: Date
  approvedAt: Date | null
  appliedAt: Date | null
  revertedAt: Date | null
  versionHash: string
}

function releaseView(
  row: ReleaseRow,
  headReleaseId: string | null,
  counts: { places: number; knowledgeEntries: number; modules: number } | null,
) {
  return {
    kind: row.kind,
    id: row.id,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    acceptedAt: iso(row.approvedAt),
    appliedAt: iso(row.appliedAt),
    revertedAt: iso(row.revertedAt),
    isNativeHead: row.kind === 'NATIVE_RELEASE' && row.id === headReleaseId,
    versionHash: row.versionHash,
    counts,
  }
}

async function nativeHeadReleaseId(database: Database, scope: Scope) {
  const head = await database.nativeVenueDeploymentHead.findFirst({
    where: scope,
    select: { releaseId: true },
  })
  return head?.releaseId ?? null
}

const NATIVE_SELECT = {
  id: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  approvedAt: true,
  appliedAt: true,
  revertedAt: true,
  manifestHash: true,
} as const
const PACKAGE_SELECT = {
  id: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  approvedAt: true,
  appliedAt: true,
  revertedAt: true,
  payloadHash: true,
} as const

/** Merged order is (createdAt desc, `${kind}:${id}` desc), so one cursor spans both tables. */
function afterCursor(kind: ReleaseKindValue, cursor: { at: Date; id: string } | null) {
  if (!cursor) return {}
  const separator = cursor.id.indexOf(':')
  const cursorKind = cursor.id.slice(0, separator)
  const cursorId = cursor.id.slice(separator + 1)
  const sameInstant =
    kind < cursorKind
      ? { createdAt: cursor.at }
      : kind === cursorKind
        ? { createdAt: cursor.at, id: { lt: cursorId } }
        : null
  return { OR: [{ createdAt: { lt: cursor.at } }, ...(sameInstant ? [sameInstant] : [])] }
}

const venuesListReleases: OperatorReadTool = {
  name: 'venues.list_releases',
  capability: 'venues:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['venues.list_releases'].parse(raw)
    await assertVenueInGrant(context.grant, input.tenantId, input.venueId, context.database)
    const scope = { tenantId: input.tenantId, venueId: input.venueId }
    const limit = Math.min(input.limit, PAGE_SIZE)
    const cursor = input.cursor ? decodeKeysetCursor(input.cursor) : null
    if (cursor) {
      const [kind, ...rest] = cursor.id.split(':')
      const id = rest.join(':')
      const found =
        kind === 'NATIVE_RELEASE'
          ? await context.database.nativeVenueDeploymentRelease.findFirst({
              where: { id, ...scope },
              select: { id: true },
            })
          : kind === 'PACKAGE_DRAFT'
            ? await context.database.venuePackage.findFirst({
                where: { id, ...scope },
                select: { id: true },
              })
            : null
      if (!found) throw new OperatorInvalidCursorError()
    }
    const [natives, packages, headId] = await Promise.all([
      context.database.nativeVenueDeploymentRelease.findMany({
        where: { ...scope, ...afterCursor('NATIVE_RELEASE', cursor) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: NATIVE_SELECT,
      }),
      context.database.venuePackage.findMany({
        where: { ...scope, ...afterCursor('PACKAGE_DRAFT', cursor) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: PACKAGE_SELECT,
      }),
      nativeHeadReleaseId(context.database, scope),
    ])
    const merged: ReleaseRow[] = [
      ...natives.map((row) => ({
        kind: 'NATIVE_RELEASE' as const,
        id: row.id,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        approvedAt: row.approvedAt,
        appliedAt: row.appliedAt,
        revertedAt: row.revertedAt,
        versionHash: row.manifestHash,
      })),
      ...packages.map((row) => ({
        kind: 'PACKAGE_DRAFT' as const,
        id: row.id,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        approvedAt: row.approvedAt,
        appliedAt: row.appliedAt,
        revertedAt: row.revertedAt,
        versionHash: row.payloadHash,
      })),
    ].sort(
      (left, right) =>
        right.createdAt.getTime() - left.createdAt.getTime() ||
        `${right.kind}:${right.id}`.localeCompare(`${left.kind}:${left.id}`),
    )
    const page = merged.slice(0, limit)
    const last = page.at(-1)
    return pageResult(
      // Content counts need the stored plan or payload, so they are read with venues.get_release.
      page.map((row) => releaseView(row, headId, null)),
      merged.length > limit && last
        ? encodeKeysetCursor(last.createdAt, `${last.kind}:${last.id}`)
        : null,
    )
  },
}

async function loadRelease(database: Database, scope: Scope, kind: ReleaseKindValue, id: string) {
  if (kind === 'NATIVE_RELEASE') {
    const row = await database.nativeVenueDeploymentRelease.findFirst({
      where: { id, ...scope },
      select: {
        ...NATIVE_SELECT,
        profile: true,
        planHash: true,
        desiredStateHash: true,
        baseStateHash: true,
        expectedEffectCount: true,
        plan: true,
      },
    })
    return row ? ({ kind, row } as const) : null
  }
  const row = await database.venuePackage.findFirst({
    where: { id, ...scope },
    select: {
      ...PACKAGE_SELECT,
      schemaVersion: true,
      baseDigest: true,
      validationReport: true,
      payload: true,
    },
  })
  return row ? ({ kind, row } as const) : null
}

function packageValidation(report: unknown) {
  const value = report as {
    errors?: unknown[]
    warnings?: unknown[]
    semanticDuplicateScan?: { status?: string }
  } | null
  return {
    errors: Array.isArray(value?.errors) ? value.errors.length : null,
    warnings: Array.isArray(value?.warnings) ? value.warnings.length : null,
    duplicateScanComplete:
      typeof value?.semanticDuplicateScan?.status === 'string'
        ? value.semanticDuplicateScan.status === 'COMPLETE'
        : null,
  }
}

function countsOf(loaded: NonNullable<Awaited<ReturnType<typeof loadRelease>>>) {
  if (loaded.kind === 'NATIVE_RELEASE') {
    const desired = NativeCoreVisibleState.safeParse(
      (loaded.row.plan as { desired?: unknown } | null)?.desired,
    )
    return desired.success
      ? {
          places: desired.data.places.length,
          knowledgeEntries: desired.data.knowledgeEntries.length,
          modules: desired.data.generalizedModules.length,
        }
      : null
  }
  const payload = loaded.row.payload as { places?: unknown[]; knowledgeEntries?: unknown[] } | null
  return {
    places: Array.isArray(payload?.places) ? payload.places.length : 0,
    knowledgeEntries: Array.isArray(payload?.knowledgeEntries)
      ? payload.knowledgeEntries.length
      : 0,
    modules: 0,
  }
}

const venuesGetRelease: OperatorReadTool = {
  name: 'venues.get_release',
  capability: 'venues:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['venues.get_release'].parse(raw)
    await assertVenueInGrant(context.grant, input.tenantId, input.venueId, context.database)
    const scope = { tenantId: input.tenantId, venueId: input.venueId }
    const loaded = await loadRelease(context.database, scope, input.releaseKind, input.releaseId)
    if (!loaded) throw new OperatorNotFoundError()
    const headId = await nativeHeadReleaseId(context.database, scope)
    if (loaded.kind === 'NATIVE_RELEASE') {
      const row = loaded.row
      const evidence = await context.database.nativeVenueDeploymentEvaluationEvidence.count({
        where: { ...scope, releaseId: row.id },
      })
      return {
        release: releaseView(
          { kind: 'NATIVE_RELEASE', ...row, versionHash: row.manifestHash },
          headId,
          countsOf(loaded),
        ),
        detail: {
          profile: row.profile,
          schemaVersion: null,
          planHash: row.planHash,
          desiredStateHash: row.desiredStateHash,
          baseStateHash: row.baseStateHash,
          expectedEffectCount: row.expectedEffectCount,
          validation: null,
          evaluationEvidenceCount: evidence,
        },
      }
    }
    const row = loaded.row
    const validation = packageValidation(row.validationReport)
    return {
      release: releaseView(
        { kind: 'PACKAGE_DRAFT', ...row, versionHash: row.payloadHash },
        headId,
        countsOf(loaded),
      ),
      detail: {
        profile: null,
        schemaVersion: row.schemaVersion,
        planHash: null,
        desiredStateHash: null,
        baseStateHash: row.baseDigest,
        expectedEffectCount: null,
        validation:
          validation.errors === null || validation.warnings === null
            ? null
            : { errors: validation.errors, warnings: validation.warnings },
        evaluationEvidenceCount: 0,
      },
    }
  },
}

const READ_PATH_EXPLANATION = {
  LEGACY:
    'Guests are answered from the compatibility rows: active public places and enabled public knowledge entries. A release does not change this until native guest reads are activated.',
  DARK: 'Native guest reads are configured but not active. Guests are still answered from the compatibility rows; the native head is being observed.',
  NATIVE:
    'Guests are answered with values from the native head, for the places and entries the compatibility rows authorize.',
} as const

const venuesGetEffectiveGuestVersion: OperatorReadTool = {
  name: 'venues.get_effective_guest_version',
  capability: 'venues:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['venues.get_effective_guest_version'].parse(raw)
    await assertVenueInGrant(context.grant, input.tenantId, input.venueId, context.database)
    const scope = { tenantId: input.tenantId, venueId: input.venueId }
    const database = context.database
    const venue = await database.venue.findFirst({
      where: { id: input.venueId, tenantId: input.tenantId },
      select: { isActive: true },
    })
    if (!venue) throw new OperatorNotFoundError()
    const [
      snapshot,
      head,
      publicPlaces,
      publicKnowledge,
      secondLayerPlaces,
      secondLayerKnowledge,
      nonPublicModules,
      lastPackage,
    ] = await Promise.all([
      resolveNativeGuestReadSnapshotAction({ client: database as never, ...scope }),
      database.nativeVenueDeploymentHead.findFirst({
        where: scope,
        select: {
          releaseId: true,
          revision: true,
          updatedAt: true,
          release: { select: { status: true } },
        },
      }),
      database.place.count({ where: { ...scope, isActive: true, visibility: 'PUBLIC' } }),
      database.venueKnowledgeEntry.count({
        where: { ...scope, isEnabled: true, visibility: 'PUBLIC' },
      }),
      database.place.count({ where: { ...scope, isActive: true, NOT: { visibility: 'PUBLIC' } } }),
      database.venueKnowledgeEntry.count({
        where: { ...scope, isEnabled: true, NOT: { visibility: 'PUBLIC' } },
      }),
      database.contentModuleIdentity.count({
        where: { ...scope, revisions: { some: { audience: { not: 'PUBLIC' } } } },
      }),
      database.venuePackage.findFirst({
        where: { ...scope, status: 'APPLIED' },
        orderBy: { appliedAt: 'desc' },
        select: { id: true, appliedAt: true },
      }),
    ])
    let publishedModules = 0
    let modulesNote = ''
    try {
      publishedModules = (
        await resolveEffectivePublishedUniversalContent({ db: database as never, ...scope })
      ).length
    } catch {
      modulesNote = ' The published-module count could not be measured and is shown as 0.'
    }
    let stateInSync: boolean | null = null
    if (head) {
      try {
        const measured = await measureNativeContentConvergenceAction(database as never, scope)
        stateInSync = measured.phase === 'NATIVE_HEAD_IN_SYNC'
      } catch {
        stateInSync = null
      }
    }
    return {
      venueId: input.venueId,
      venueActive: venue.isActive,
      readPath: snapshot.path,
      readPathReason: snapshot.reason,
      nativeHead: head
        ? {
            releaseId: head.releaseId,
            revision: head.revision,
            updatedAt: head.updatedAt.toISOString(),
            releaseStatus: head.release.status,
            stateInSync,
          }
        : null,
      serving: {
        places: publicPlaces,
        knowledgeEntries: publicKnowledge,
        publishedModules,
      },
      withheldFromGuests: {
        secondLayerPlaces,
        secondLayerKnowledgeEntries: secondLayerKnowledge,
        nonPublicModules,
      },
      lastAppliedPackage: lastPackage?.appliedAt
        ? { packageId: lastPackage.id, appliedAt: lastPackage.appliedAt.toISOString() }
        : null,
      explanation:
        `${venue.isActive ? '' : 'The venue is not active, so the public route refuses guests. '}${READ_PATH_EXPLANATION[snapshot.path]}${modulesNote}`.slice(
          0,
          600,
        ),
    }
  },
}

const venuesGetReleasePreflight: OperatorReadTool = {
  name: 'venues.get_release_preflight',
  capability: 'venues:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['venues.get_release_preflight'].parse(raw)
    await assertVenueInGrant(context.grant, input.tenantId, input.venueId, context.database)
    const scope = { tenantId: input.tenantId, venueId: input.venueId }
    const database = context.database
    let target: PreflightTarget | null = null
    let targetView: { kind: ReleaseKindValue; id: string; status: string } | null = null
    if (input.releaseKind !== undefined && input.releaseId !== undefined) {
      const loaded = await loadRelease(database, scope, input.releaseKind, input.releaseId)
      if (!loaded) throw new OperatorNotFoundError()
      if (loaded.kind === 'NATIVE_RELEASE') {
        const headId = await nativeHeadReleaseId(database, scope)
        target = {
          kind: 'NATIVE_RELEASE',
          id: loaded.row.id,
          status: loaded.row.status,
          isNativeHead: headId === loaded.row.id,
        }
      } else {
        const validation = packageValidation(loaded.row.validationReport)
        target = {
          kind: 'PACKAGE_DRAFT',
          id: loaded.row.id,
          status: loaded.row.status,
          validationErrors: validation.errors,
          validationWarnings: validation.warnings,
          duplicateScanComplete: validation.duplicateScanComplete,
        }
      }
      targetView = { kind: target.kind, id: target.id, status: target.status }
    }
    const [venue, publicPlaces, publicKnowledge, distribution, assessment, convergence] =
      await Promise.all([
        database.venue.findFirst({
          where: { id: input.venueId, tenantId: input.tenantId },
          select: { isActive: true },
        }),
        database.place.count({ where: { ...scope, isActive: true, visibility: 'PUBLIC' } }),
        database.venueKnowledgeEntry.count({
          where: { ...scope, isEnabled: true, visibility: 'PUBLIC' },
        }),
        database.venueDistribution.findFirst({ where: scope, select: { websiteState: true } }),
        assessNativeGuestReadActivationAction({ client: database as never, ...scope }).catch(
          () => null,
        ),
        measureNativeContentConvergenceAction(database as never, scope).catch(() => null),
      ])
    if (!venue) throw new OperatorNotFoundError()
    const prerequisites = evaluatePreflight({
      venueActive: venue.isActive,
      publicPlaces,
      publicKnowledgeEntries: publicKnowledge,
      target,
      nativeReadBlockers: assessment ? assessment.blockers : ['READ_FAILED_CLOSED'],
      convergencePhase: convergence ? convergence.phase : null,
      previewSigningConfigured: readGuestPreviewSigningSecret() !== null,
      websiteDistribution: distribution?.websiteState ?? null,
    })
    return {
      venueId: input.venueId,
      target: targetView,
      ready: preflightReady(prerequisites),
      prerequisites,
    }
  },
}

function guestOrigin(): string | null {
  const configured = process.env.NEXT_PUBLIC_WEB_URL
  return configured ? parseExactOrigin(configured) : null
}

const venuesGetPreviewLink: OperatorReadTool = {
  name: 'venues.get_preview_link',
  capability: 'venues:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['venues.get_preview_link'].parse(raw)
    await assertVenueInGrant(context.grant, input.tenantId, input.venueId, context.database)
    const scope = { tenantId: input.tenantId, venueId: input.venueId }
    const database = context.database
    const loaded = await loadRelease(database, scope, input.releaseKind, input.releaseId)
    if (!loaded) throw new OperatorNotFoundError()
    const version = { kind: input.releaseKind, id: loaded.row.id, status: loaded.row.status }
    const unavailable = (code: string, reason: string) => ({
      venueId: input.venueId,
      version,
      url: null,
      expiresAt: null,
      ttlSeconds: null,
      unavailable: { code, reason },
      note: 'No link was minted. Nothing about the version changed.',
    })
    if (
      loaded.kind === 'PACKAGE_DRAFT' &&
      loaded.row.status !== 'DRAFT' &&
      loaded.row.status !== 'APPROVED'
    ) {
      return unavailable(
        'PACKAGE_NOT_REVIEWABLE',
        'Only a DRAFT or APPROVED package can be previewed; an applied or reverted one is history.',
      )
    }
    if (loaded.kind === 'NATIVE_RELEASE' && !countsOf(loaded)) {
      return unavailable(
        'RELEASE_STATE_UNREADABLE',
        'The release plan could not be read as guest-visible state.',
      )
    }
    const origin = guestOrigin()
    if (!origin) {
      return unavailable(
        'GUEST_ORIGIN_NOT_CONFIGURED',
        'The public guest app origin is not configured.',
      )
    }
    const venue = await database.venue.findFirst({
      where: { id: input.venueId, tenantId: input.tenantId },
      select: { slug: true },
    })
    if (!venue) throw new OperatorNotFoundError()
    try {
      const { token, expiresAt } = mintGuestPreviewToken({
        secret: readGuestPreviewSigningSecret(),
        tenantId: input.tenantId,
        venueId: input.venueId,
        kind: input.releaseKind === 'NATIVE_RELEASE' ? 'release' : 'package',
        versionId: loaded.row.id,
        now: context.now,
      })
      return {
        venueId: input.venueId,
        version,
        url: `${origin}/${encodeURIComponent(venue.slug)}/preview?token=${token}`,
        expiresAt: expiresAt.toISOString(),
        ttlSeconds: GUEST_PREVIEW_TOKEN_DEFAULT_TTL_SECONDS,
        unavailable: null,
        note: 'Private and read-only: it shows only this exact version, only guest-visible content, expires soon and cannot send messages. Do not post or forward it.',
      }
    } catch (error) {
      if (error instanceof GuestPreviewTokenError && error.code === 'MISSING_SECRET') {
        return unavailable(
          'PREVIEW_SIGNING_NOT_CONFIGURED',
          'The server preview signing secret is not configured, so previews fail closed.',
        )
      }
      throw error
    }
  },
}

export const venueReleaseReadTools: readonly OperatorReadTool[] = [
  venuesListReleases,
  venuesGetRelease,
  venuesGetEffectiveGuestVersion,
  venuesGetReleasePreflight,
  venuesGetPreviewLink,
]
