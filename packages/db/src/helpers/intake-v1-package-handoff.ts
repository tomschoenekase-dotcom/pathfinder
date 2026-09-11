import { z } from 'zod'

import { db } from '../client'

type Transaction = Parameters<Parameters<typeof db.$transaction>[0]>[0]

const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const inputSchema = z
  .object({
    tenantId: z.string().min(1).max(191),
    venueId: z.string().min(1).max(191),
    revisionId: z.string().min(1).max(191),
    packageDraftId: z.string().min(1).max(191),
    operationId: z.string().uuid(),
    manifestHash: hash,
    candidateHash: hash,
    payloadHash: hash,
    selectedMemberIds: z.array(z.string().min(1).max(191)).min(1).max(50),
    partialAcknowledged: z.boolean(),
    createdBy: z.string().min(1).max(191),
  })
  .strict()
const readSchema = z
  .object({
    tenantId: z.string().min(1).max(191),
    venueId: z.string().min(1).max(191),
    operationId: z.string().uuid(),
  })
  .strict()

export class IntakeV1PackageHandoffError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'IntakeV1PackageHandoffError'
  }
}

function isUniqueConstraint(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

/** Internal-only replay read; callers must not project the package payload to owner APIs. */
export async function readIntakeV1PackageHandoff(
  input: { tenantId: string; venueId: string; operationId: string },
  client: Pick<typeof db, 'intakeV1PackageHandoff'> = db,
) {
  const parsed = readSchema.safeParse(input)
  if (!parsed.success)
    throw new IntakeV1PackageHandoffError('INVALID_INPUT', 'Invalid V1 package handoff scope.')
  return client.intakeV1PackageHandoff.findFirst({
    where: parsed.data,
    include: {
      packageDraft: {
        select: {
          id: true,
          draftKey: true,
          status: true,
          payloadHash: true,
          payload: true,
          createdBy: true,
        },
      },
    },
  })
}

/** Composes only inside the caller's existing canonical draft transaction. */
export async function finalizeIntakeV1PackageHandoffInTransaction(
  tx: Transaction,
  raw: z.input<typeof inputSchema>,
) {
  const input = inputSchema.safeParse(raw)
  if (
    !input.success ||
    new Set(input.data.selectedMemberIds).size !== input.data.selectedMemberIds.length
  )
    throw new IntakeV1PackageHandoffError('INVALID_INPUT', 'Invalid V1 package handoff selection.')
  const value = input.data
  const existing = await readIntakeV1PackageHandoff(
    { tenantId: value.tenantId, venueId: value.venueId, operationId: value.operationId },
    tx,
  )
  if (existing) {
    if (
      existing.revisionId === value.revisionId &&
      existing.packageDraftId === value.packageDraftId &&
      existing.manifestHash === value.manifestHash &&
      existing.candidateHash === value.candidateHash &&
      existing.payloadHash === value.payloadHash &&
      existing.partialAcknowledged === value.partialAcknowledged &&
      existing.createdBy === value.createdBy &&
      JSON.stringify(existing.selectedMemberIds) === JSON.stringify(value.selectedMemberIds)
    )
      return { handoff: existing, replayed: true as const }
    throw new IntakeV1PackageHandoffError(
      'CONFLICT',
      'V1 package handoff operation is already bound.',
    )
  }
  let handoff: { id: string }
  try {
    handoff = await tx.intakeV1PackageHandoff.create({ data: value })
  } catch (error) {
    // The enclosing transaction is aborted after a unique race; do not attempt recovery reads here.
    if (isUniqueConstraint(error))
      throw new IntakeV1PackageHandoffError(
        'CONFLICT',
        'V1 revision or package is already bound by another operation.',
      )
    throw error
  }
  const retained = await tx.intakeV1PackageHandoff.findFirst({
    where: { id: handoff.id, tenantId: value.tenantId, venueId: value.venueId },
  })
  if (
    !retained ||
    retained.revisionId !== value.revisionId ||
    retained.packageDraftId !== value.packageDraftId ||
    retained.operationId !== value.operationId ||
    retained.manifestHash !== value.manifestHash ||
    retained.candidateHash !== value.candidateHash ||
    retained.payloadHash !== value.payloadHash ||
    retained.partialAcknowledged !== value.partialAcknowledged ||
    retained.createdBy !== value.createdBy ||
    JSON.stringify(retained.selectedMemberIds) !== JSON.stringify(value.selectedMemberIds)
  )
    throw new IntakeV1PackageHandoffError('CONFLICT', 'V1 package handoff was not retained.')
  return { handoff: retained, replayed: false as const }
}
