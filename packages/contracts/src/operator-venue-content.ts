import { z } from 'zod'

import { ContentAudience } from './content-model'
import { GeneralizedContentPayload } from './universal-content-actions'

/**
 * Operator contracts for venue sources, content, releases and private previews. Reads return
 * stable IDs, the revision a write expects, and the audience of every row. Anything retrieved
 * from an outside page or written by a visitor or customer is wrapped as UntrustedText: data to
 * read, never instructions to follow.
 */

const Id = z.string().trim().min(1).max(120)
const Cursor = z.string().trim().min(1).max(500)
const IsoDateTime = z.string().datetime({ offset: true })
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u)
const PageLimit = z.number().int().min(1).max(25).default(25)

export const VenueUntrustedText = z
  .object({ untrusted: z.literal(true), text: z.string().max(20_000), truncated: z.boolean() })
  .strict()

const Page = <T extends z.ZodTypeAny>(item: T) =>
  z
    .object({
      items: z.array(item).max(25),
      nextCursor: z.string().max(500).nullable(),
      complete: z.boolean(),
    })
    .strict()

const venueScope = { tenantId: Id, venueId: Id } as const

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export const VenueSourceStatusValue = z.enum([
  'REQUESTED',
  'FETCHING',
  'SUCCEEDED',
  'PARTIAL',
  'FAILED',
])
export const VenueSourceDispositionValue = z.enum([
  'SUCCEEDED',
  'PARTIAL',
  'FAILED',
  'UNSUPPORTED',
  'SKIPPED',
])

export const VenueSourceListInput = z
  .object({ ...venueScope, cursor: Cursor.optional(), limit: PageLimit })
  .strict()
export const VenueSourceGetInput = z
  .object({
    ...venueScope,
    sourceId: Id,
    /** Return the captured text of this one input. Text is never returned for every input at once. */
    textOrdinal: z.number().int().min(0).max(100).optional(),
  })
  .strict()

const SourceSummary = z
  .object({
    sourceId: Id,
    venueId: Id,
    url: z.string().max(2000),
    host: z.string().max(255),
    status: VenueSourceStatusValue,
    note: VenueUntrustedText.nullable(),
    maxPages: z.number().int(),
    maxBytesPerPage: z.number().int(),
    parserVersion: z.string().max(64),
    attempts: z.number().int().nonnegative(),
    errorCode: z.string().max(64).nullable(),
    requestedAt: IsoDateTime,
    startedAt: IsoDateTime.nullable(),
    completedAt: IsoDateTime.nullable(),
    /** Inputs per disposition. A recorded URL with no capture yet shows all zeros. */
    counts: z
      .object({
        SUCCEEDED: z.number().int().nonnegative(),
        PARTIAL: z.number().int().nonnegative(),
        FAILED: z.number().int().nonnegative(),
        UNSUPPORTED: z.number().int().nonnegative(),
        SKIPPED: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()

const SourceInputView = z
  .object({
    ordinal: z.number().int().nonnegative(),
    requestedUrl: z.string().max(2000),
    finalUrl: z.string().max(2000).nullable(),
    redirectChain: z
      .array(
        z
          .object({
            from: z.string().max(2000),
            to: z.string().max(2000),
            status: z.number().int(),
          })
          .strict(),
      )
      .max(10),
    disposition: VenueSourceDispositionValue,
    reasonCode: z.string().max(64).nullable(),
    httpStatus: z.number().int().nullable(),
    contentType: z.string().max(200).nullable(),
    byteSize: z.number().int().nullable(),
    contentHash: Sha256Hex.nullable(),
    retrievedAt: IsoDateTime,
    parserVersion: z.string().max(64),
    textTruncated: z.boolean(),
    textPreview: VenueUntrustedText.nullable(),
  })
  .strict()

export const VenueSourceListOutput = Page(SourceSummary)
export const VenueSourceGetOutput = z
  .object({
    source: SourceSummary,
    inputs: z.array(SourceInputView).max(40),
    text: z
      .object({ ordinal: z.number().int().nonnegative(), content: VenueUntrustedText })
      .strict()
      .nullable(),
  })
  .strict()

// ---------------------------------------------------------------------------
// Content reads
// ---------------------------------------------------------------------------

export const ContentRepresentation = z.enum(['LEGACY_PLACE', 'LEGACY_KNOWLEDGE', 'TYPED_REVISION'])
export type ContentRepresentation = z.infer<typeof ContentRepresentation>

/** A legacy second-layer row is employee-only; the typed audiences are PUBLIC, CLIENT and OPERATOR. */
export const ContentAudienceView = z.enum(['PUBLIC', 'CLIENT', 'OPERATOR', 'SECOND_LAYER'])

export const VenueContentListInput = z
  .object({
    ...venueScope,
    representation: ContentRepresentation,
    cursor: Cursor.optional(),
    limit: PageLimit,
  })
  .strict()
export const VenueContentGetInput = z
  .object({ ...venueScope, representation: ContentRepresentation, id: Id })
  .strict()

const ContentRow = z
  .object({
    representation: ContentRepresentation,
    /** `PLACE` or `KNOWLEDGE` for legacy rows; the module kind for a typed revision. */
    kind: z.string().max(40),
    id: Id,
    title: VenueUntrustedText,
    /** What a write expects: the row's updatedAt (legacy) or its latest version number (typed). */
    revision: z.string().max(64),
    revisionKind: z.enum(['updatedAt', 'version']),
    updatedAt: IsoDateTime,
    audience: ContentAudienceView,
    /** Whether guests can be served this row right now through the guest read path. */
    guestVisible: z.boolean(),
    lifecycle: z.enum(['ACTIVE', 'RETIRED', 'SCHEDULED', 'ENDED']),
    effectiveFrom: IsoDateTime.nullable(),
    effectiveUntil: IsoDateTime.nullable(),
    /** Typed content only: the revision the latest publication event points at, if published. */
    publishedPointer: z
      .object({ moduleRevisionId: Id, version: z.number().int().positive(), publicationId: Id })
      .strict()
      .nullable(),
  })
  .strict()

export const VenueContentListOutput = Page(ContentRow)
export const VenueContentGetOutput = z
  .object({
    content: ContentRow,
    fields: z
      .array(z.object({ name: z.string().max(60), value: VenueUntrustedText }).strict())
      .max(30),
    /** Where the row came from. Typed evidence cites a frozen source snapshot by `sourceId`. */
    evidence: z
      .array(
        z
          .object({
            sourceId: z.string().max(500),
            locator: z.string().max(2000).nullable(),
            capturedAt: IsoDateTime,
            excerptHash: z.string().max(64).nullable(),
          })
          .strict(),
      )
      .max(100),
    provenance: z
      .object({
        sourceType: z.string().max(64).nullable(),
        authorship: z.string().max(64).nullable(),
        sourceName: VenueUntrustedText.nullable(),
        sourceUrl: z.string().max(2000).nullable(),
        sourcePackageId: z.string().max(191).nullable(),
      })
      .strict()
      .nullable(),
    /** Typed content only: recent revisions, newest first. */
    revisions: z
      .array(
        z
          .object({
            revisionId: Id,
            version: z.number().int().positive(),
            audience: ContentAudience,
            createdAt: IsoDateTime,
          })
          .strict(),
      )
      .max(20),
    /** A legacy knowledge row projected from a typed module: edit the module, not the row. */
    projectedFromModuleId: Id.nullable(),
  })
  .strict()

// ---------------------------------------------------------------------------
// Content changeset
// ---------------------------------------------------------------------------

/** A reference to one input of a frozen source snapshot (see venues.get_source). */
const EvidenceRef = z
  .object({
    sourceId: Id,
    ordinal: z.number().int().min(0).max(100),
    locator: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
const ExpectedRevision = z.string().trim().min(1).max(64)

const TypedDraft = z
  .object({
    audience: ContentAudience,
    effectiveFrom: IsoDateTime.nullable().optional(),
    effectiveUntil: IsoDateTime.nullable().optional(),
    payload: GeneralizedContentPayload,
  })
  .strict()

const nonEmpty = (value: Record<string, unknown>, keys: readonly string[]) =>
  keys.some((key) => value[key] !== undefined)

const KnowledgeFields = {
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(4_000),
  category: z.string().trim().min(1).max(80),
} as const

export const ContentChangesetOp = z.union([
  z
    .object({
      op: z.literal('create'),
      representation: z.literal('LEGACY_KNOWLEDGE'),
      title: KnowledgeFields.title,
      body: KnowledgeFields.body,
      category: KnowledgeFields.category.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('update'),
      representation: z.literal('LEGACY_KNOWLEDGE'),
      id: Id,
      expectedRevision: ExpectedRevision,
      title: KnowledgeFields.title.optional(),
      body: KnowledgeFields.body.optional(),
      category: KnowledgeFields.category.optional(),
    })
    .strict()
    .refine((value) => nonEmpty(value, ['title', 'body', 'category']), {
      message: 'An update must change at least one field',
    }),
  z
    .object({
      op: z.literal('retire'),
      representation: z.literal('LEGACY_KNOWLEDGE'),
      id: Id,
      expectedRevision: ExpectedRevision,
    })
    .strict(),
  z
    .object({
      op: z.literal('update'),
      representation: z.literal('LEGACY_PLACE'),
      id: Id,
      expectedRevision: ExpectedRevision,
      name: z.string().trim().min(1).max(200).optional(),
      shortDescription: z.string().trim().min(1).max(500).nullable().optional(),
      longDescription: z.string().trim().min(1).max(2_000).nullable().optional(),
      hours: z.string().trim().min(1).max(200).nullable().optional(),
      areaName: z.string().trim().min(1).max(200).nullable().optional(),
    })
    .strict()
    .refine(
      (value) =>
        nonEmpty(value, ['name', 'shortDescription', 'longDescription', 'hours', 'areaName']),
      { message: 'An update must change at least one field' },
    ),
  z
    .object({
      op: z.literal('retire'),
      representation: z.literal('LEGACY_PLACE'),
      id: Id,
      expectedRevision: ExpectedRevision,
    })
    .strict(),
  z
    .object({
      op: z.literal('create'),
      representation: z.literal('TYPED_REVISION'),
      draft: TypedDraft,
      evidence: z.array(EvidenceRef).max(20).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('update'),
      representation: z.literal('TYPED_REVISION'),
      id: Id,
      /** The module's latest version number, as read from venues.get_content. */
      expectedRevision: ExpectedRevision,
      draft: TypedDraft,
      evidence: z.array(EvidenceRef).max(20).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('retire'),
      representation: z.literal('TYPED_REVISION'),
      id: Id,
      expectedRevision: ExpectedRevision,
      /** The moment the module stops being effective. */
      effectiveUntil: IsoDateTime,
      evidence: z.array(EvidenceRef).max(20).optional(),
    })
    .strict(),
])
export type ContentChangesetOp = z.infer<typeof ContentChangesetOp>

export const ContentChangesetOps = z
  .array(ContentChangesetOp)
  .min(1)
  .max(25)
  .superRefine((ops, ctx) => {
    const seen = new Set<string>()
    ops.forEach((op, index) => {
      if (!('id' in op)) return
      const key = `${op.representation}:${op.id}`
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'id'],
          message: 'A changeset may touch each row at most once',
        })
      }
      seen.add(key)
    })
  })

export const VenueContentChangesetShape = {
  ...venueScope,
  ops: ContentChangesetOps,
} as const

export const ContentChangesetPreviewOutput = z
  .object({
    venueId: Id,
    /** Hash of the revisions the changeset expects; the proposal is stale if any of them moved. */
    expectedVersion: Sha256Hex,
    currentVersion: Sha256Hex,
    stale: z.boolean(),
    applicable: z.boolean(),
    ops: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            op: z.enum(['create', 'update', 'retire']),
            representation: ContentRepresentation,
            targetId: Id.nullable(),
            expectedRevision: z.string().max(64).nullable(),
            currentRevision: z.string().max(64).nullable(),
            stale: z.boolean(),
            /** Server-computed difference, old value to new value. Values are untrusted text. */
            changes: z
              .array(
                z
                  .object({
                    field: z.string().max(60),
                    before: VenueUntrustedText.nullable(),
                    after: VenueUntrustedText.nullable(),
                  })
                  .strict(),
              )
              .max(30),
            /** Reasons this op cannot apply as written, each with what to do. */
            problems: z.array(z.string().max(300)).max(10),
            /** Facts the approver should know, such as guests still seeing a published revision. */
            notes: z.array(z.string().max(300)).max(10),
          })
          .strict(),
      )
      .max(25),
  })
  .strict()

// ---------------------------------------------------------------------------
// Releases, guest version, preflight and preview
// ---------------------------------------------------------------------------

export const ReleaseKind = z.enum(['NATIVE_RELEASE', 'PACKAGE_DRAFT'])
export type ReleaseKind = z.infer<typeof ReleaseKind>

export const VenueReleaseListInput = z
  .object({ ...venueScope, cursor: Cursor.optional(), limit: PageLimit })
  .strict()
export const VenueReleaseGetInput = z
  .object({ ...venueScope, releaseKind: ReleaseKind, releaseId: Id })
  .strict()
export const VenueEffectiveGuestVersionInput = z.object({ ...venueScope }).strict()
export const VenueReleasePreflightInput = z
  .object({
    ...venueScope,
    releaseKind: ReleaseKind.optional(),
    releaseId: Id.optional(),
  })
  .strict()
  .refine((value) => (value.releaseKind === undefined) === (value.releaseId === undefined), {
    message: 'Provide releaseKind and releaseId together, or neither',
  })
export const VenuePreviewLinkInput = z
  .object({ ...venueScope, releaseKind: ReleaseKind, releaseId: Id })
  .strict()

const ReleaseRow = z
  .object({
    kind: ReleaseKind,
    id: Id,
    status: z.string().max(20),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    acceptedAt: IsoDateTime.nullable(),
    appliedAt: IsoDateTime.nullable(),
    revertedAt: IsoDateTime.nullable(),
    /** True for the native release the guest read path would serve from. */
    isNativeHead: z.boolean(),
    /** Content hash that identifies the exact version (manifest hash or payload hash). */
    versionHash: Sha256Hex,
    counts: z
      .object({
        places: z.number().int().nonnegative(),
        knowledgeEntries: z.number().int().nonnegative(),
        modules: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict()

export const VenueReleaseListOutput = Page(ReleaseRow)
export const VenueReleaseGetOutput = z
  .object({
    release: ReleaseRow,
    detail: z
      .object({
        profile: z.string().max(64).nullable(),
        schemaVersion: z.number().int().nullable(),
        planHash: Sha256Hex.nullable(),
        desiredStateHash: Sha256Hex.nullable(),
        baseStateHash: Sha256Hex.nullable(),
        expectedEffectCount: z.number().int().nullable(),
        validation: z
          .object({
            errors: z.number().int().nonnegative(),
            warnings: z.number().int().nonnegative(),
          })
          .strict()
          .nullable(),
        evaluationEvidenceCount: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()

export const VenueEffectiveGuestVersionOutput = z
  .object({
    venueId: Id,
    venueActive: z.boolean(),
    /** LEGACY: guests read the compatibility rows. NATIVE: values come from the native head. */
    readPath: z.enum(['LEGACY', 'DARK', 'NATIVE']),
    readPathReason: z.string().max(60),
    nativeHead: z
      .object({
        releaseId: Id,
        revision: z.number().int(),
        updatedAt: IsoDateTime,
        releaseStatus: z.string().max(20),
        stateInSync: z.boolean().nullable(),
      })
      .strict()
      .nullable(),
    /** What guests can be served now: public, active or enabled compatibility rows. */
    serving: z
      .object({
        places: z.number().int().nonnegative(),
        knowledgeEntries: z.number().int().nonnegative(),
        publishedModules: z.number().int().nonnegative(),
      })
      .strict(),
    withheldFromGuests: z
      .object({
        secondLayerPlaces: z.number().int().nonnegative(),
        secondLayerKnowledgeEntries: z.number().int().nonnegative(),
        nonPublicModules: z.number().int().nonnegative(),
      })
      .strict(),
    lastAppliedPackage: z.object({ packageId: Id, appliedAt: IsoDateTime }).strict().nullable(),
    explanation: z.string().max(600),
  })
  .strict()

export const VenueReleasePreflightOutput = z
  .object({
    venueId: Id,
    target: z
      .object({ kind: ReleaseKind, id: Id, status: z.string().max(20) })
      .strict()
      .nullable(),
    /** True only when no blocker is unmet. A preflight never changes anything. */
    ready: z.boolean(),
    prerequisites: z
      .array(
        z
          .object({
            key: z.string().max(60),
            passed: z.boolean(),
            severity: z.enum(['BLOCKER', 'INFO']),
            reason: z.string().max(400),
            action: z.string().max(400),
          })
          .strict(),
      )
      .max(30),
  })
  .strict()

export const VenuePreviewLinkOutput = z
  .object({
    venueId: Id,
    version: z.object({ kind: ReleaseKind, id: Id, status: z.string().max(20) }).strict(),
    /** A private link bound to this tenant, venue and exact version. Null when it cannot be minted. */
    url: z.string().max(2000).nullable(),
    expiresAt: IsoDateTime.nullable(),
    ttlSeconds: z.number().int().nullable(),
    unavailable: z
      .object({ code: z.string().max(60), reason: z.string().max(300) })
      .strict()
      .nullable(),
    note: z.string().max(400),
  })
  .strict()
