import { createHash } from 'node:crypto'
import { z } from 'zod'

const Claim = z.object({ fieldPath: z.string().min(1), value: z.string().min(1) }).strict()
const Case = z
  .object({
    caseId: z.string().regex(/^source-claim-[a-z0-9-]+$/u),
    evaluationAsOf: z.string().datetime({ offset: true }),
    input: z
      .object({
        format: z.enum(['SYNTHETIC_READABLE_TEXT', 'SYNTHETIC_EXTRACTED_FACT_RECORDS']),
        instruction: z.string().min(1).max(500),
        targetEntityId: z.string().min(1),
        requestedFields: z.array(z.string().min(1)).max(5),
        source: z.string().min(1).max(4_000),
      })
      .strict(),
    rubric: z
      .object({ claims: z.array(Claim).max(5), disposition: z.enum(['EXTRACT', 'ESCALATE']) })
      .strict(),
  })
  .strict()

const asOf = '2026-09-08T12:00:00.000Z'
const rows = [
  {
    caseId: 'source-claim-hours-current',
    evaluationAsOf: asOf,
    input: {
      format: 'SYNTHETIC_READABLE_TEXT',
      instruction: 'Extract current hours for the target entity as an atomic field/value claim.',
      targetEntityId: 'gallery-north',
      requestedFields: ['hours.current'],
      source:
        'Entity gallery-north. Current hours effective 2026-09-01: 10:00-16:00. Supersedes hours 08:00-20:00.',
    },
    rubric: {
      claims: [{ fieldPath: 'hours.current', value: '10:00-16:00' }],
      disposition: 'EXTRACT',
    },
  },
  {
    caseId: 'source-claim-expired-update',
    evaluationAsOf: asOf,
    input: {
      format: 'SYNTHETIC_EXTRACTED_FACT_RECORDS',
      instruction:
        'Reconcile the dated update at evaluationAsOf; escalate when no current claim remains.',
      targetEntityId: 'arrival-update',
      requestedFields: ['updates.arrival'],
      source: JSON.stringify([
        {
          entityId: 'arrival-update',
          fieldPath: 'updates.arrival',
          value: 'Use east door',
          effectiveDate: '2026-08-01',
        },
        {
          entityId: 'arrival-update',
          fieldPath: 'updates.arrival.expiresAt',
          value: '2026-08-31',
          effectiveDate: '2026-08-31',
        },
      ]),
    },
    rubric: { claims: [], disposition: 'ESCALATE' },
  },
  {
    caseId: 'source-claim-similar-entities',
    evaluationAsOf: asOf,
    input: {
      format: 'SYNTHETIC_READABLE_TEXT',
      instruction:
        'Extract capacity only for the target entity; do not merge similarly named entities.',
      targetEntityId: 'gallery-east',
      requestedFields: ['capacity'],
      source: 'Entity gallery-east capacity 45. Entity gallery-eastern-annex capacity 90.',
    },
    rubric: { claims: [{ fieldPath: 'capacity', value: '45' }], disposition: 'EXTRACT' },
  },
  {
    caseId: 'source-claim-missing-entity',
    evaluationAsOf: asOf,
    input: {
      format: 'SYNTHETIC_READABLE_TEXT',
      instruction: 'Find a stable record for the target entity, or escalate without inventing one.',
      targetEntityId: 'quiet-room-unknown',
      requestedFields: [],
      source: 'The venue has a quiet room, but this source provides no stable entity identifier.',
    },
    rubric: { claims: [], disposition: 'ESCALATE' },
  },
  {
    caseId: 'source-claim-conflicting-facts',
    evaluationAsOf: asOf,
    input: {
      format: 'SYNTHETIC_EXTRACTED_FACT_RECORDS',
      instruction:
        'Reconcile capacity for the target entity; escalate equally supported conflicts.',
      targetEntityId: 'gallery-conflict',
      requestedFields: ['capacity'],
      source: JSON.stringify([
        { entityId: 'gallery-conflict', fieldPath: 'capacity', value: '45', confidence: 0.8 },
        { entityId: 'gallery-conflict', fieldPath: 'capacity', value: '54', confidence: 0.8 },
      ]),
    },
    rubric: { claims: [], disposition: 'ESCALATE' },
  },
  {
    caseId: 'source-claim-malformed-output',
    evaluationAsOf: asOf,
    input: {
      format: 'SYNTHETIC_READABLE_TEXT',
      instruction: 'Extract capacity for the target entity using the required structured output.',
      targetEntityId: 'gallery-west',
      requestedFields: ['capacity'],
      source: 'Entity gallery-west capacity 30.',
    },
    rubric: { claims: [{ fieldPath: 'capacity', value: '30' }], disposition: 'EXTRACT' },
  },
] as const

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
export function hashPreparedSourceClaimCase(value: unknown) {
  return createHash('sha256')
    .update(`pathfinder-provider-source-claim-case-v1\n${canonical(Case.parse(value))}`)
    .digest('hex')
}
export const PROVIDER_SOURCE_CLAIM_CASES = rows.map((row) => {
  const parsed = Case.parse(row)
  return {
    ...parsed,
    caseHash: hashPreparedSourceClaimCase(parsed),
    sourceHash: createHash('sha256').update(parsed.input.source).digest('hex'),
  }
})
export const PROVIDER_SOURCE_CLAIM_CORPUS_HASH = createHash('sha256')
  .update(PROVIDER_SOURCE_CLAIM_CASES.map(({ caseHash }) => caseHash).join('\n'))
  .digest('hex')

const Output = z
  .object({
    entityId: z.string().min(1),
    claims: z.array(Claim).max(20),
    disposition: z.enum(['EXTRACT', 'ESCALATE']),
  })
  .strict()
const atomic = (claim: z.infer<typeof Claim>) =>
  `${claim.fieldPath.normalize('NFC').trim().toLocaleLowerCase()}\0${claim.value.normalize('NFC').trim().toLocaleLowerCase()}`
export function scorePreparedSourceClaimOutput(caseId: string, output: unknown) {
  const fixture = PROVIDER_SOURCE_CLAIM_CASES.find((row) => row.caseId === caseId)
  if (!fixture) throw new Error('Unknown source-claim case')
  const parsed = Output.safeParse(output)
  if (!parsed.success) return { validOutput: false, passed: false }
  const actual = new Set(parsed.data.claims.map(atomic))
  const expected = new Set(fixture.rubric.claims.map(atomic))
  const checks = {
    validOutput: true,
    entityIdentity: parsed.data.entityId === fixture.input.targetEntityId,
    exactClaims: actual.size === expected.size && [...actual].every((claim) => expected.has(claim)),
    escalation: parsed.data.disposition === fixture.rubric.disposition,
  }
  return { ...checks, passed: Object.values(checks).every(Boolean) }
}
