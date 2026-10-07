import { createHash } from 'node:crypto'

import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { VENUE_PACKAGE_TRANSACTION_OPTIONS } from '@pathfinder/db'

import {
  applyVenuePackageLifecycle,
  approveVenuePackageLifecycle,
} from '../../lib/venue-package-core'
import { createVenuePackageDraftService } from '../../routers/venue-package'
import { VenuePackagePayload } from '../../schemas/venue-package'
import { assertGrantCapability, assertVenueInGrant } from '../grants'
import type { OperatorApplyContext, OperatorKindContext, OperatorProposalKind } from '../proposals'
import { downloadAttachment } from '../tools/crm-csv-import'

const input = OPERATOR_MCP_INPUTS['venues.propose_package_import']
type ImportArgs = Omit<ReturnType<typeof input.parse>, 'payload' | 'file'> & {
  payload: VenuePackagePayload
}
type PackageFile = NonNullable<ReturnType<typeof input.parse>['file']>

/** 500 records of full text with provenance, with room for pretty-printing. */
const MAX_PACKAGE_FILE_BYTES = 8 * 1024 * 1024

const rejected = (message: string) =>
  Object.assign(new Error(message), { code: 'PACKAGE_REJECTED', summary: message })

export type PackageFileDownload = (file: PackageFile) => Promise<string>

const realDownload: PackageFileDownload = (file) =>
  downloadAttachment(file, {
    maxBytes: MAX_PACKAGE_FILE_BYTES,
    mimeTypes: ['application/json', 'text/json', 'text/plain', 'application/octet-stream'],
    accept: 'application/json,text/plain',
    typeLabel: 'a JSON file',
    textLabel: 'JSON',
    error: (code, message) =>
      code === 'INVALID'
        ? rejected(`${message}. Nothing was recorded or changed.`)
        : Object.assign(new Error(message), { code: 'FETCH_FAILED' }),
  })
let download: PackageFileDownload = realDownload

/** Test seam only. Production always downloads through the pinned public-address fetch. */
export function setPackageFileDownloadForTests(next: PackageFileDownload | null) {
  download = next ?? realDownload
}

/**
 * Turns an attached package file into the inline payload before anything is recorded, so the
 * proposal, its idempotency hash and the stored package hold exactly the file's JSON. A retry with
 * a fresh download link for the same file therefore replays the same operation. Scope is checked
 * before anything is fetched.
 */
export async function resolvePackageAttachment(
  raw: unknown,
  context: Pick<OperatorKindContext, 'grant' | 'database'>,
  capability: 'venues:propose' | 'venues:read' = 'venues:propose',
): Promise<unknown> {
  const { file, ...rest } = (
    capability === 'venues:read' ? OPERATOR_MCP_INPUTS['venues.check_package'] : input
  ).parse(raw)
  if (!file) return raw
  assertGrantCapability(context.grant, capability)
  await assertVenueInGrant(context.grant, rest.tenantId, rest.venueId, context.database)
  const text = await download(file)
  let json: unknown
  try {
    json = JSON.parse(text.replace(/^\uFEFF/u, ''))
  } catch {
    throw rejected('The attached file is not valid JSON. Nothing was recorded or changed.')
  }
  // Accept the package itself, or an export that wraps it as { payload: {...} }.
  const wrapped =
    json && typeof json === 'object' && !Array.isArray(json) && 'payload' in json
      ? (json as { payload: unknown }).payload
      : json
  if (!wrapped || typeof wrapped !== 'object' || Array.isArray(wrapped)) {
    throw rejected(
      'The attached file is not a venue package object. Nothing was recorded or changed.',
    )
  }
  return { ...rest, payload: wrapped }
}

/** Stable UUIDs per operation and step, so a retried apply replays instead of importing twice. */
function stepKey(operationId: string, step: 'draft' | 'approve' | 'apply') {
  const hex = createHash('sha256').update(`operator-package:${operationId}:${step}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export function counts(payload: VenuePackagePayload) {
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
 * Runs one import step and keeps its reason on the receipt. Without a summary the operator records
 * only the code (for example CONFLICT), and the caller cannot tell which step failed or what to do.
 */
async function step<T>(name: 'draft' | 'approve' | 'apply', run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error && typeof error === 'object' && !('summary' in error)) {
      const message = error instanceof Error ? error.message : String(error)
      const code = 'code' in error ? String((error as { code: unknown }).code) : 'ERROR'
      const retry =
        code === 'CONFLICT'
          ? ' Nothing was applied. Retry with a new operationId; the saved draft stays unapplied.'
          : code === 'P2028'
            ? ' The database transaction ran out of time and rolled back; nothing was applied. Retry with a new operationId.'
            : ''
      Object.assign(error, {
        summary: `The ${name} step failed (${code}): ${message}.${retry}`.slice(0, 500),
      })
    }
    throw error
  }
}

/**
 * Imports the dashboard's venue-package JSON end to end: saves the draft (with the duplicate scan),
 * approves it acknowledging its warnings, and applies it. Applied packages keep the dashboard's
 * history and revert. Validation errors stop the operation before anything guests can see changes.
 */
const GUIDE_QUALITY_FINDINGS_SHOWN = 40

/** Guide-quality findings tell the author exactly which records to rewrite before re-importing. */
export function guideQualityFindings(
  warnings: ReadonlyArray<{ code: string; path: string; message: string }>,
) {
  const findings = warnings.filter((warning) => warning.code.startsWith('GUIDE_QUALITY_'))
  return {
    total: findings.length,
    shown: findings
      .slice(0, GUIDE_QUALITY_FINDINGS_SHOWN)
      .map(({ code, path, message }) => ({ code, path, message })),
    ...(findings.length
      ? {
          next: 'Rewrite the named records to the operator manual standard ("Writing guide records") and import a schemaVersion 3 update until total is 0.',
        }
      : {}),
  }
}

export const venuesPackageImportKind: OperatorProposalKind<ImportArgs> = {
  kind: 'venues.package-import',
  tool: 'venues.propose_package_import',
  capability: 'venues:propose',
  parse: (raw) => {
    const { file, ...parsed } = input.parse(raw)
    // Attachments are resolved to their JSON before a proposal is made (resolvePackageAttachment).
    if (file || !parsed.payload) throw rejected('Provide the package as payload.')
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
    const database = context.database
    const actor = { type: 'HUMAN' as const, id: context.actor.id, role: 'PLATFORM_ADMIN' as const }
    const draft = await step('draft', () =>
      createVenuePackageDraftService({
        db: database as never,
        tenantId,
        actor,
        input: { venueId, draftKey: stepKey(context.operationId, 'draft'), payload: args.payload },
      }),
    )
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
      current = await step('approve', () =>
        approveVenuePackageLifecycle({
          db: database as never,
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
        }),
      )
    }
    // Content-version markers are transaction-local. Content effects, history, package receipt
    // and RELEASED milestone must commit together, just as they do through the dashboard router.
    const applied = await step('apply', () =>
      database.$transaction(
        async (tx) =>
          applyVenuePackageLifecycle({
            db: tx as never,
            tenantId,
            venueId,
            actor,
            command: {
              id: current.id,
              expectedUpdatedAt: current.updatedAt,
              commandKey: stepKey(context.operationId, 'apply'),
            },
          }),
        VENUE_PACKAGE_TRANSACTION_OPTIONS,
      ),
    )
    return {
      result: {
        venueId,
        packageId: applied.id,
        status: applied.status,
        plan: counts(args.payload),
        warnings: report.warnings.length,
        guideQuality: guideQualityFindings(report.warnings),
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
