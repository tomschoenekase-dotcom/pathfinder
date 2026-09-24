import { z } from 'zod'

const bounded = z.string().trim().min(1).max(191)
/** Syntactic admission only: any later fetch still needs DNS/redirect SSRF checks. */
export const chicagoPublicUrl = z
  .string()
  .max(2000)
  .refine((value) => {
    if (!/^https?:\/\/[^/?#@]+(?:[/?#]|$)/i.test(value) || /[\s\\\u0000-\u001f\u007f]/u.test(value))
      return false
    try {
      const url = new URL(value)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false
      // WHATWG parsing canonicalizes integer, octal and hexadecimal IPv4 forms.
      // Reject every IP literal, including public IPs: venue evidence uses DNS names.
      const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
      if (hostname.includes(':') || hostname.includes('[') || /^\d+(?:\.\d+){3}$/.test(hostname))
        return false
      if (hostname.length > 253 || !hostname.includes('.')) return false
      const labels = hostname.split('.')
      if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)))
        return false
      const suffix = labels.at(-1)!
      if (
        !/[a-z]/i.test(suffix) ||
        [
          'localhost',
          'local',
          'internal',
          'intranet',
          'lan',
          'home',
          'invalid',
          'test',
          'onion',
        ].includes(suffix)
      )
        return false
      return true
    } catch {
      return false
    }
  }, 'A public HTTP(S) URL with a valid domain name and no credentials is required')

const chicagoResearchDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const timestamp = Date.parse(`${value}T00:00:00Z`)
    return (
      Number.isFinite(timestamp) &&
      new Date(timestamp).toISOString().slice(0, 10) === value &&
      value <= new Date().toISOString().slice(0, 10)
    )
  }, 'A real research date no later than today is required')
export const chicagoDirectoryInput = z
  .object({
    query: z.string().trim().max(200).optional(),
    geography: z.enum(['all', 'chicago-proper', 'metro']).default('all'),
    category: z.string().max(200).optional(),
    city: z.string().max(200).optional(),
    state: z.enum(['IL', 'IN', 'WI']).optional(),
    rankingState: z
      .enum([
        'evidence-backed',
        'provisional-heuristic',
        'needs-research',
        'excluded',
        'intentionally-unranked',
      ])
      .optional(),
    contactability: z.enum(['verified', 'source-only', 'missing', 'suppressed']).optional(),
    stale: z.boolean().optional(),
    lifecycle: z.enum(['active', 'archived', 'all']).default('active'),
    sorts: z
      .array(
        z
          .object({
            field: z.enum([
              'name',
              'city',
              'category',
              'productFit',
              'attainability',
              'contactability',
              'evidenceQuality',
              'completeness',
              'researchPriority',
            ]),
            direction: z.enum(['asc', 'desc']),
          })
          .strict(),
      )
      .min(1)
      .max(4)
      .default([
        { field: 'productFit', direction: 'desc' },
        { field: 'attainability', direction: 'desc' },
      ]),
    page: z.number().int().min(1).max(100000).default(1),
    pageSize: z.number().int().min(1).max(100).default(50),
  })
  .strict()
export const chicagoVenueInput = z.object({ venueId: bounded }).strict()
export const chicagoEvidence = z
  .object({
    url: chicagoPublicUrl,
    researchedAt: chicagoResearchDate,
    statement: z.string().trim().min(12).max(4000),
    firstParty: z.literal(true),
  })
  .strict()
const mutation = { idempotencyKey: bounded }
const scoredObservation = {
  value: z.number().finite().min(0).max(100),
  reason: z.string().trim().min(12).max(2000),
}
export const chicagoObservation = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('fit'),
        key: z.enum([
          'knowledgeRichness',
          'recurringVisitorQuestions',
          'interpretiveValue',
          'physicalPlaceRelevance',
          'contentDepthStability',
          'guideUseCases',
        ]),
        ...scoredObservation,
      })
      .strict(),
    z
      .object({
        kind: z.literal('attainability'),
        key: z.enum([
          'organizationScale',
          'decisionPathSimplicity',
          'localControl',
          'relationshipState',
          'pilotScope',
        ]),
        ...scoredObservation,
      })
      .strict(),
    z
      .object({
        kind: z.literal('contact'),
        channel: z.enum(['email', 'phone', 'form', 'website']),
        value: z.string().trim().min(1).max(2000),
        roleRelevant: z.boolean().nullable(),
      })
      .strict(),
    z.object({ kind: z.literal('source') }).strict(),
  ])
  .superRefine((observation, context) => {
    if (observation.kind !== 'contact') return
    const value = observation.value
    const valid =
      observation.channel === 'email'
        ? z.string().max(254).email().safeParse(value).success &&
          chicagoPublicUrl.safeParse(`https://${value.slice(value.lastIndexOf('@') + 1)}`).success
        : observation.channel === 'phone'
          ? /^\+?[\d(). -]+(?:\s*(?:ext\.?|x)\s*\d{1,6})?$/i.test(value) &&
            (() => {
              const digits = value.split(/\s*(?:ext\.?|x)/i)[0]!.replace(/\D/g, '')
              return digits.length >= 7 && digits.length <= 15
            })()
          : chicagoPublicUrl.safeParse(value).success
    if (!valid)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message:
          'Contact value must match its public routing channel: email address, phone number, or public HTTP(S) domain URL',
      })
  })
export const chicagoAppendEvidenceInput = z
  .object({
    ...mutation,
    venueId: bounded,
    expectedVersion: z.number().int().min(1),
    evidence: chicagoEvidence,
    observation: chicagoObservation,
  })
  .strict()
export const chicagoAddInput = z
  .object({
    ...mutation,
    name: z.string().trim().min(2).max(300),
    city: z.string().trim().min(2).max(200),
    state: z.enum(['IL', 'IN', 'WI']),
    territoryId: bounded,
    category: z.string().trim().max(200).optional(),
    website: chicagoPublicUrl,
    evidence: chicagoEvidence,
    territoryRationale: z.string().trim().min(12).max(2000),
  })
  .strict()
export const chicagoChangeInput = z
  .object({
    ...mutation,
    venueId: bounded,
    expectedVersion: z.number().int().min(1),
    field: z.enum([
      'name',
      'website',
      'venueType',
      'addressLine1',
      'city',
      'region',
      'estimatedSize',
      'description',
    ]),
    value: z.string().trim().min(1).max(5000),
    evidence: chicagoEvidence,
    mode: z.enum(['propose', 'apply']).default('propose'),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.field === 'website') {
      const website = chicagoPublicUrl.safeParse(input.value)
      if (!website.success)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value'],
          message:
            'Website changes require a public HTTP(S) URL with a valid domain name and no credentials',
        })
    }
  })
export const chicagoDuplicateInput = z
  .object({
    ...mutation,
    venueId: bounded,
    expectedVersion: z.number().int().min(1),
    otherVenueId: bounded,
    relation: z.enum(['possible-duplicate', 'same-operator']),
    reason: z.string().trim().min(12).max(2000),
    evidence: chicagoEvidence,
  })
  .strict()
export const chicagoReviewInput = z
  .object({
    ...mutation,
    reviewId: bounded,
    expectedVersion: z.number().int().min(1),
    decision: z.enum(['dismiss', 'retain-distinct', 'supersede']),
    rationale: z.string().trim().min(12).max(2000),
  })
  .strict()
export type ChicagoDirectoryInput = z.input<typeof chicagoDirectoryInput>

export type ChicagoDimension = {
  value: number | null
  coverage: number
  reasons: string[]
  sourceUrls: string[]
  components: {
    key: string
    value: number | null
    reason: string
    sourceUrls: string[]
    basis: 'verified' | 'heuristic' | 'unknown' | 'derived'
    researchedAt: string | null
  }[]
}
export type ChicagoRanking = {
  version: string
  venueId: string
  asOf: string
  state: string
  stateReason: string
  productFit: ChicagoDimension
  attainability: ChicagoDimension
  contactability: ChicagoDimension
  evidenceQuality: ChicagoDimension
  evidenceFreshness: ChicagoDimension
  completeness: ChicagoDimension
  researchPriority: ChicagoDimension
  researchGaps: { key: string; reason: string; priority: number }[]
  uncertainty: string[]
  override: {
    actor: string
    at: string
    rationale: string
    dimension: 'productFit' | 'attainability' | 'contactability'
    value: number
  } | null
  rankKey: (number | null)[]
}
export type ChicagoVenueRow = {
  venueId: string
  organizationId: string
  name: string
  organizationName: string
  city: string | null
  state: string | null
  category: string | null
  website: string | null
  chicagoProper: boolean
  revision: number
  relationshipState: string
  confidence: string
  stale: boolean
  contactability: 'verified' | 'source-only' | 'missing' | 'suppressed'
  ranking: ChicagoRanking
  reviewCount: number
}
export type ChicagoCoverage = {
  total: number
  proper: number
  metro: number
  ranked: number
  needsResearch: number
  stale: number
  conflicted: number
  quarantined: number
}
export type ChicagoDirectoryResult = {
  items: ChicagoVenueRow[]
  total: number
  page: number
  pageSize: number
  facets: { categories: string[]; cities: string[]; states: string[] }
  coverage: ChicagoCoverage
}
export type ChicagoReview = {
  id: string
  kind: string
  status: string
  reason: string
  original: unknown
  revision: number
}
export type ChicagoVenueDetail = ChicagoVenueRow & {
  organization: { id: string; name: string; identityNote: string }
  fields: Record<
    string,
    {
      value: unknown
      status: string
      sourceUrls: string[]
      researchedAt: string | null
      actor?: string
    }
  >
  sources: {
    id: string
    url: string | null
    label: string | null
    researchedAt: string | null
    type: string
  }[]
  contactClaims: unknown[]
  reviews: ChicagoReview[]
  imports: {
    id: string
    sourceWorkbookHash: string
    externalRecordId: string
    rawPayload: unknown
    normalizedPayload: unknown
    processingStatus: string
  }[]
  audit: {
    id: string
    operation: string
    actorId: string
    runId: string
    createdAt: string
    beforeState: unknown
    afterState: unknown
    result: unknown
  }[]
  researchGaps: { key: string; reason: string; priority: number }[]
}
export type ChicagoHealth = {
  rankingVersion: string
  coverage: ChicagoCoverage
  imports: {
    id: string
    sourceWorkbookHash: string | null
    status: string
    totalRows: number
    importedRows: number
    failedRows: number
    createdAt: string
    reconciliation: unknown
  }[]
  reviews: ChicagoReview[]
  jobs: {
    id: string
    organizationId: string
    status: string
    claimOwnerId: string | null
    claimExpiresAt: string | null
    stuck: boolean
  }[]
  matrix: {
    city: string
    state: string
    category: string
    total: number
    missingWebsite: number
    missingContacts: number
    needsResearch: number
  }[]
}
