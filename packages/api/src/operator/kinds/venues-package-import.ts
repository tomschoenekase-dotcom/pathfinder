import { createHash } from 'node:crypto'

import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'

import {
  applyVenuePackageLifecycle,
  approveVenuePackageLifecycle,
} from '../../lib/venue-package-core'
import { createVenuePackageDraftService } from '../../routers/venue-package'
import { VenuePackagePayload } from '../../schemas/venue-package'
import { assertVenueInGrant } from '../grants'
import type { OperatorApplyContext, OperatorKindContext, OperatorProposalKind } from '../proposals'

const input = OPERATOR_MCP_INPUTS['venues.propose_package_import']
type ImportArgs = Omit<ReturnType<typeof input.parse>, 'payload'> & {
  payload: VenuePackagePayload
}

/** Stable UUIDs per operation and step, so a retried apply replays instead of importing twice. */
function stepKey(operationId: string, step: 'draft' | 'approve' | 'apply') {
  const hex = createHash('sha256').update(`operator-package:${operationId}:${step}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function counts(payload: VenuePackagePayload) {
  if (payload.schemaVersion === 3) {
    return {
      places: {
        create: payload.places.create.length,
        update: payload.places.update.length,
        remove: payload.places.delete.length,
      },
      knowledgeEntries: {
        create: payload.knowledgeEntries.create.length,
        update: payload.knowledgeEntries.update.length,
        remove: payload.knowledgeEntries.delete.length,
      },
    }
  }
  return {
    places: { create: payload.places.length, update: 0, remove: 0 },
    knowledgeEntries: { create: payload.knowledgeEntries.length, update: 0, remove: 0 },
  }
}

function failure(message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { code: 'PACKAGE_REJECTED', summary: message, ...extra })
}

/**
 * Imports the dashboard's venue-package JSON end to end: saves the draft (with the duplicate scan),
 * approves it acknowledging its warnings, and applies it. Applied packages keep the dashboard's
 * history and revert. Validation errors stop the operation before anything guests can see changes.
 */
export const venuesPackageImportKind: OperatorProposalKind<ImportArgs> = {
  kind: 'venues.package-import',
  tool: 'venues.propose_package_import',
  capability: 'venues:propose',
  parse: (raw) => {
    const parsed = input.parse(raw)
    return { ...parsed, payload: VenuePackagePayload.parse(parsed.payload) }
  },
  target: (args) => ({ tenantId: args.tenantId, venueId: args.venueId }),
  authorize: (args, context: OperatorKindContext) =>
    assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database),
  targetVersion: async () => null,
  currentVersion: async () => null,
  describe: (args) => {
    const plan = counts(args.payload)
    return {
      title: `Import venue package (schema version ${args.payload.schemaVersion})`,
      lines: [
        `places: ${plan.places.create} new, ${plan.places.update} updated, ${plan.places.remove} removed`,
        `knowledge: ${plan.knowledgeEntries.create} new, ${plan.knowledgeEntries.update} updated, ${plan.knowledgeEntries.remove} removed`,
      ],
    }
  },
  snapshot: async (args) => ({ venueId: args.venueId, plan: counts(args.payload) }) as JsonValue,
  apply: async (args, context: OperatorApplyContext) => {
    const { tenantId, venueId } = args
    const database = context.database as never
    const actor = { type: 'HUMAN' as const, id: context.actor.id, role: 'PLATFORM_ADMIN' as const }
    const draft = await createVenuePackageDraftService({
      db: database,
      tenantId,
      actor,
      input: { venueId, draftKey: stepKey(context.operationId, 'draft'), payload: args.payload },
    })
    const pkg = draft.value
    if (pkg.status === 'APPLIED') {
      return {
        result: { venueId, packageId: pkg.id, status: pkg.status, replayed: true },
        after: { packageId: pkg.id } as JsonValue,
      }
    }
    const report = pkg.preview.report
    if (report.errors.length > 0) {
      throw failure(
        `The package has ${report.errors.length} validation error(s); nothing was applied: ${JSON.stringify(report.errors).slice(0, 400)}`,
        { provedNoEffect: true },
      )
    }
    let current = pkg as { id: string; status: string; updatedAt: Date }
    if (current.status === 'DRAFT') {
      current = await approveVenuePackageLifecycle({
        db: database,
        tenantId,
        venueId,
        actor,
        command: {
          id: pkg.id,
          expectedUpdatedAt: pkg.updatedAt,
          commandKey: stepKey(context.operationId, 'approve'),
          acknowledgedPayloadHash: pkg.preview.payloadHash,
          acknowledgedWarningDigest: pkg.preview.warningDigest,
        },
      })
    }
    const applied = await applyVenuePackageLifecycle({
      db: database,
      tenantId,
      venueId,
      actor,
      command: {
        id: current.id,
        expectedUpdatedAt: current.updatedAt,
        commandKey: stepKey(context.operationId, 'apply'),
      },
    })
    return {
      result: {
        venueId,
        packageId: applied.id,
        status: applied.status,
        plan: counts(args.payload),
        warnings: report.warnings.length,
        replayed: false,
      },
      after: { packageId: applied.id, status: applied.status } as JsonValue,
    }
  },
  /** The package row is the receipt: applied means the import landed. */
  reconcile: async (args, context) => {
    const pkg = await context.database.venuePackage.findFirst({
      where: {
        tenantId: args.tenantId,
        venueId: args.venueId,
        draftKey: stepKey(context.operationId, 'draft'),
      },
      select: { id: true, status: true },
    })
    if (!pkg) return { state: 'not_applied' }
    if (pkg.status === 'APPLIED' || pkg.status === 'REVERTED') {
      return {
        state: 'applied',
        outcome: {
          result: { venueId: args.venueId, packageId: pkg.id, status: pkg.status, replayed: true },
          after: { packageId: pkg.id, status: pkg.status } as JsonValue,
        },
      }
    }
    // A draft or approved package was not applied yet; the stable step keys make a retry replay.
    return { state: 'not_applied' }
  },
}
