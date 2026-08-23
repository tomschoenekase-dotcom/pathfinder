import { EvalCaseSchema, evaluateSourceCoverage } from '@pathfinder/contracts/evaluation'
import {
  createVenueContentSnapshot,
  db,
  hashEvalCase,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const MAX_CASES = 50

const sourceCoverageInputSchema = z
  .object({
    tenantId: z.string().min(1),
    venueId: z.string().min(1),
    caseIds: z.array(z.string().uuid()).min(1).max(MAX_CASES),
  })
  .superRefine((input, context) => {
    if (new Set(input.caseIds).size !== input.caseIds.length)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Case IDs must be unique' })
  })

export const adminEvaluationSourceCoverageRouter = router({
  previewCurrentEvaluationSourceCoverage: adminProcedure
    .input(sourceCoverageInputSchema)
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const [snapshot, rows] = await Promise.all([
          createVenueContentSnapshot({
            db,
            tenantId: input.tenantId,
            venueId: input.venueId,
          }),
          db.evalCase.findMany({
            where: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              id: { in: input.caseIds },
            },
            select: {
              id: true,
              caseKey: true,
              revision: true,
              caseHash: true,
              caseSnapshot: true,
            },
          }),
        ])
        if (rows.length !== input.caseIds.length)
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'One or more evaluation cases were not found in the requested venue',
          })
        const rowsById = new Map(rows.map((row) => [row.id, row]))
        const cases = input.caseIds.map((caseId) => {
          const row = rowsById.get(caseId)!
          const parsed = EvalCaseSchema.safeParse(row.caseSnapshot)
          if (
            !parsed.success ||
            parsed.data.caseId !== row.caseKey ||
            hashEvalCase(parsed.data) !== row.caseHash
          )
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'Stored evaluation case failed integrity verification',
            })
          return {
            caseId: row.id,
            caseKey: row.caseKey,
            revision: row.revision,
            coverage: evaluateSourceCoverage(parsed.data, snapshot.manifest),
          }
        })
        return {
          target: 'CURRENT_LIVE_CONTENT' as const,
          contentSnapshotHash: snapshot.hash,
          contentVersion: snapshot.contentVersion.toString(),
          cases,
        }
      }),
    ),
})
