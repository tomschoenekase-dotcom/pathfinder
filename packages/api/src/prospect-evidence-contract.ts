import { z } from 'zod'
const id = z.string().min(1).max(191)
export const evidenceSelectionSchema = z
  .object({
    claimIds: z
      .array(id)
      .max(8)
      .refine((values) => new Set(values).size === values.length),
    routeClaimId: id.nullable(),
    purpose: z.string().trim().min(12).max(500),
    hypothesis: z.string().trim().min(12).max(1000),
  })
  .strict()
export const evidenceAdmissionInput = z
  .object({
    venueId: id,
    expectedSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
    expectedSelectionId: id.nullable(),
    captureId: id,
    selection: evidenceSelectionSchema,
  })
  .strict()
export type EvidenceSelection = z.infer<typeof evidenceSelectionSchema>
export interface EvidenceCaptureView {
  id: string
  identity: {
    venueId: string
    organizationId: string
    name: string
    city: string
    region: string
    sourceLocator: string
  }
  provenance: {
    producer: string
    method: string
    associationReason: string
    gatePlanId: string
    gateReceiptSha256: string
  }
  pages: {
    id: string
    url: string
    rawSha256: string
    observedAt: string
    retrievedAt: string
    nameQuote: string
    locationQuote: string | null
  }[]
  claims: {
    claimId: string
    kind: string
    factKey: string
    value: string
    quote: string
    start: number
    end: number
    pageId: string
    reason: string
    validUntil: string | null
    routeKind: string | null
  }[]
}
export interface EvidenceAdmissionView {
  captures: EvidenceCaptureView[]
  selectionId: string | null
  selection: { captureId: string; selection: EvidenceSelection } | null
  holds: string[]
}
