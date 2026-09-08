import { z } from 'zod'

export const IntakeSourceKind = z.enum([
  'WEBSITE',
  'DOCUMENT',
  'PDF',
  'BROCHURE',
  'SPREADSHEET',
  'PHOTO',
  'VIDEO',
  'MAP',
  'STRUCTURED_DATA',
  'INTERVIEW',
  'NOTE',
  'ANSWER',
])
export type IntakeSourceKind = z.infer<typeof IntakeSourceKind>

export const IntakeRunStatus = z.enum([
  'QUEUED',
  'EXTRACTING',
  'RECONCILING',
  'MAPPING',
  'VALIDATING',
  'AWAITING_REVIEW',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
])
export type IntakeRunStatus = z.infer<typeof IntakeRunStatus>

export const IntakeSource = z
  .object({
    id: z.string().min(1),
    tenantId: z.string().min(1),
    venueId: z.string().min(1),
    kind: IntakeSourceKind,
    displayName: z.string().trim().min(1).max(255),
    uri: z.string().url().optional(),
    assetId: z.string().min(1).optional(),
    capturedAt: z.string().datetime({ offset: true }),
    capturedByActorId: z.string().min(1).optional(),
    consentToRecord: z.boolean().optional(),
  })
  .strict()
  .superRefine((source, context) => {
    if (!source.uri && !source.assetId && !['INTERVIEW', 'NOTE', 'ANSWER'].includes(source.kind)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assetId'],
        message: 'This source requires a URI or stored asset reference.',
      })
    }
    if (source.kind === 'INTERVIEW' && source.consentToRecord === true) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['consentToRecord'],
        message: 'Recording consent is owner-policy gated and cannot be enabled by this contract.',
      })
    }
  })
export type IntakeSource = z.infer<typeof IntakeSource>

export const WebsiteIntakeBounds = z
  .object({
    maxPages: z.number().int().min(1).max(100).default(25),
    maxDepth: z.number().int().min(0).max(5).default(2),
    maxBytesPerPage: z.number().int().min(1).max(10_000_000).default(2_000_000),
    allowedHosts: z.array(z.string().trim().min(1)).min(1).max(20),
    respectRobots: z.literal(true).default(true),
    publishMode: z.literal('DRAFT_ONLY').default('DRAFT_ONLY'),
  })
  .strict()
export type WebsiteIntakeBounds = z.infer<typeof WebsiteIntakeBounds>

export const WebsiteSourceDiscoveryDisposition = z.enum([
  'FETCHED_TEXT',
  'UNSUPPORTED_DOCUMENT',
  'UNSUPPORTED_VIDEO',
  'UNSUPPORTED_IMAGE',
  'UNSUPPORTED_OTHER',
  'ROBOTS_DENIED',
  'DEPTH_LIMIT',
  'PAGE_LIMIT',
])
export type WebsiteSourceDiscoveryDisposition = z.infer<typeof WebsiteSourceDiscoveryDisposition>

const sensitiveWebsiteQueryKey =
  /(?:token|key|secret|signature|credential|auth|password|^sig$|^x-amz-|^x-goog-)/iu

function isPrivateWebsiteDiscoveryHost(hostname: string) {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, '')
    .replace(/\.$/u, '')
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    normalized.endsWith('.home.arpa') ||
    normalized === 'instance-data' ||
    normalized === 'metadata.google.internal'
  )
    return true
  if (
    /^(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})$/u.test(
      normalized,
    )
  ) {
    const [first = -1, second = -1, third = -1, fourth = -1] = normalized.split('.').map(Number)
    if ([first, second, third, fourth].some((segment) => segment > 255)) return true
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    )
  }
  if (normalized.includes(':')) {
    const mappedIpv4 = normalized.match(/(?:^|:)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u)
    if (mappedIpv4) {
      const first = Number.parseInt(mappedIpv4[1]!, 16)
      const mappedFirst = first >> 8
      const mappedSecond = first & 0xff
      if (
        mappedFirst === 0 ||
        mappedFirst === 10 ||
        mappedFirst === 127 ||
        (mappedFirst === 100 && mappedSecond >= 64 && mappedSecond <= 127) ||
        (mappedFirst === 169 && mappedSecond === 254) ||
        (mappedFirst === 172 && mappedSecond >= 16 && mappedSecond <= 31) ||
        (mappedFirst === 192 && mappedSecond === 168)
      )
        return true
    }
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    )
  }
  return false
}

const WebsiteSourceDiscoveryUrl = z
  .string()
  .min(1)
  .max(2_048)
  .superRefine((value, context) => {
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Discovery URL must be valid.' })
      return
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.hash ||
      [...parsed.searchParams.keys()].some((key) => sensitiveWebsiteQueryKey.test(key)) ||
      isPrivateWebsiteDiscoveryHost(parsed.hostname) ||
      parsed.toString() !== value
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Discovery URL must be a canonical safe HTTP(S) reference.',
      })
    }
  })

/** Static source material for review; never an approved claim or publication grant. */
export const WebsitePageTextEvidence = z
  .object({
    sourceUrl: WebsiteSourceDiscoveryUrl,
    exactByteHash: z.string().regex(/^[a-f0-9]{64}$/u),
    capturedAt: z.string().datetime({ offset: true }),
    extractionProfile: z.enum(['static-html-v1', 'plain-text-v1']),
    text: z.string().max(40_000),
    normalizedTextHash: z.string().regex(/^[a-f0-9]{64}$/u),
    retainedTextHash: z.string().regex(/^[a-f0-9]{64}$/u),
    fullCodePointCount: z.number().int().min(0).max(10_000_000),
    retainedCodePointCount: z.number().int().min(0).max(20_000),
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((page, context) => {
    if (
      [...page.text].length !== page.retainedCodePointCount ||
      page.retainedCodePointCount > page.fullCodePointCount ||
      page.truncated !== page.retainedCodePointCount < page.fullCodePointCount ||
      (!page.truncated && page.normalizedTextHash !== page.retainedTextHash)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Page text retention metadata is inconsistent.',
      })
    }
  })
export type WebsitePageTextEvidence = z.infer<typeof WebsitePageTextEvidence>

export const WebsitePageTextEvidenceCollection = z
  .array(WebsitePageTextEvidence)
  .max(100)
  .superRefine((pages, context) => {
    if (
      pages.reduce((sum, page) => sum + page.retainedCodePointCount, 0) > 100_000 ||
      new Set(pages.map((page) => page.sourceUrl)).size !== pages.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Page text must use unique sources and a bounded run total.',
      })
    }
  })

const WebsiteSourceDiscoveryMimeType = z
  .string()
  .min(3)
  .max(255)
  .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:; [a-z0-9!#$&^_.+-]+=[a-z0-9!#$&^_.+:-]+)*$/u)

export const WebsiteSourceDiscoveryItem = z
  .object({
    url: WebsiteSourceDiscoveryUrl,
    parentUrl: WebsiteSourceDiscoveryUrl.nullable(),
    depth: z.number().int().min(0).max(10),
    observedAt: z.string().datetime({ offset: true }),
    disposition: WebsiteSourceDiscoveryDisposition,
    contentType: WebsiteSourceDiscoveryMimeType.optional(),
    byteSize: z.number().int().min(0).max(1_000_000_000).optional(),
    exactByteHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    duplicateOf: WebsiteSourceDiscoveryUrl.optional(),
  })
  .strict()
  .superRefine((item, context) => {
    const hasByteSize = item.byteSize !== undefined
    const hasByteHash = item.exactByteHash !== undefined
    if (hasByteSize !== hasByteHash) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['byteSize'],
        message: 'Received-byte size and exact hash must be retained together.',
      })
    }
    if (hasByteSize && ['ROBOTS_DENIED', 'DEPTH_LIMIT', 'PAGE_LIMIT'].includes(item.disposition)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['disposition'],
        message: 'Unfetched discovery entries cannot claim received-byte metadata.',
      })
    }
    if (item.duplicateOf) {
      if (!hasByteSize || item.duplicateOf === item.url) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['duplicateOf'],
          message: 'A duplicate source requires a distinct exact-byte identity.',
        })
      }
    }
    if (item.disposition === 'FETCHED_TEXT' && !hasByteSize) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['byteSize'],
        message: 'Fetched text requires the exact received-byte size and hash.',
      })
    }
  })
export type WebsiteSourceDiscoveryItem = z.infer<typeof WebsiteSourceDiscoveryItem>

export const WebsiteSourceDiscovery = z
  .object({
    policyVersion: z.literal(1),
    observedAt: z.string().datetime({ offset: true }),
    items: z.array(WebsiteSourceDiscoveryItem).max(1_000),
    omittedCount: z.number().int().min(0).max(1_000_000),
  })
  .strict()
  .superRefine((discovery, context) => {
    const priorItems = new Map<string, (typeof discovery.items)[number]>()
    for (const [index, item] of discovery.items.entries()) {
      if (priorItems.has(item.url)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'url'],
          message: 'Discovery item URLs must be unique.',
        })
      }
      if (item.duplicateOf) {
        const original = priorItems.get(item.duplicateOf)
        if (
          !original ||
          original.byteSize === undefined ||
          original.exactByteHash === undefined ||
          original.byteSize !== item.byteSize ||
          original.exactByteHash !== item.exactByteHash
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['items', index, 'duplicateOf'],
            message:
              'A duplicate must reference an earlier fetched item with exact matching bytes.',
          })
        }
      }
      priorItems.set(item.url, item)
    }
  })
export type WebsiteSourceDiscovery = z.infer<typeof WebsiteSourceDiscovery>

export const IntakeEvidence = z
  .object({
    id: z.string().min(1),
    sourceId: z.string().min(1),
    locator: z.string().trim().min(1).max(2_000),
    capturedAt: z.string().datetime({ offset: true }),
    normalizedHash: z.string().regex(/^[a-f0-9]{64}$/i),
    confidence: z.number().min(0).max(1),
  })
  .strict()
export type IntakeEvidence = z.infer<typeof IntakeEvidence>

export const IntakeDiscrepancy = z
  .object({
    id: z.string().min(1),
    fieldPath: z.string().trim().min(1).max(500),
    evidenceIds: z.array(z.string().min(1)).min(2).max(20),
    reason: z.enum(['CONTRADICTION', 'DATE_SENSITIVE', 'LOW_CONFIDENCE', 'MISSING_CONTEXT']),
    resolution: z.string().trim().min(1).max(5_000).optional(),
  })
  .strict()
export type IntakeDiscrepancy = z.infer<typeof IntakeDiscrepancy>

export const IntakeProposal = z
  .object({
    runId: z.string().min(1),
    status: IntakeRunStatus,
    sourceIds: z.array(z.string().min(1)).min(1).max(500),
    evidenceIds: z.array(z.string().min(1)).max(5_000).default([]),
    discrepancyIds: z.array(z.string().min(1)).max(1_000).default([]),
    packageDraftId: z.string().min(1).optional(),
    validationResultId: z.string().min(1).optional(),
    evaluationRunId: z.string().min(1).optional(),
    autoPublish: z.literal(false).default(false),
  })
  .strict()
export type IntakeProposal = z.infer<typeof IntakeProposal>

export const INTAKE_ORCHESTRATION_STAGES = [
  'DEDUPE',
  'EXTRACT',
  'RESEARCH',
  'CLASSIFY',
  'RECONCILE',
  'ASSESS_UNCERTAINTY',
  'MAP_TO_CONTENT',
  'CREATE_PROPOSAL',
  'VALIDATE',
  'REVIEW',
  'EVALUATE',
  'PREVIEW',
  'APPROVE',
  'APPLY',
] as const
export type IntakeOrchestrationStage = (typeof INTAKE_ORCHESTRATION_STAGES)[number]
