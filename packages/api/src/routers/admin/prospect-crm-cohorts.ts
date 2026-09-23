import { TRPCError } from '@trpc/server'
import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { outreachCohortService, OutreachCohortError, type OutreachCohortActor } from '../../prospect-outreach-cohort'
import { outreachCohortPreviewInput, outreachCohortReserveInput, outreachCohortReadInput,
  outreachCohortWindowInput, outreachCohortCheckpointInput, outreachCohortAcknowledgeInput, outreachCohortListInput,
  outreachCohortControlInput } from '../../prospect-outreach-cohort-contract'

const actor = (id: string): OutreachCohortActor => ({ id, type: 'HUMAN', runId: 'authenticated-admin',
  scope: { mode: 'ALL' }, capabilities: ['prospects.read', 'prospects.correspondence.read', 'prospects.maintain'] })
async function safely<T>(operation: () => Promise<T>) {
  try { return await operation() } catch (error) {
    if (error instanceof OutreachCohortError) throw new TRPCError({ code: error.code === 'HELD' ? 'PRECONDITION_FAILED' : error.code, message: error.message })
    throw error
  }
}
/** Admin identity comes exclusively from the existing authenticated procedure.
 * Read acknowledgement is not meaning approval, send approval, or release. */
export const adminProspectCrmCohortsRouter = router({
  listProspectOutreachCohorts: adminProcedure.input(outreachCohortListInput)
    .query(({ ctx, input }) => safely(() => outreachCohortService.list(input, actor(ctx.session.userId)))),
  previewProspectOutreachCohort: adminProcedure.input(outreachCohortPreviewInput)
    .query(({ ctx, input }) => safely(() => outreachCohortService.preview(input, actor(ctx.session.userId)))),
  reserveProspectOutreachCohort: adminProcedure.input(outreachCohortReserveInput)
    .mutation(({ ctx, input }) => safely(() => outreachCohortService.reserve(input, actor(ctx.session.userId)))),
  controlProspectOutreachCohort: adminProcedure.input(outreachCohortControlInput)
    .mutation(({ ctx, input }) => safely(() => outreachCohortService.control(input, actor(ctx.session.userId)))),
  readProspectOutreachCohort: adminProcedure.input(outreachCohortReadInput)
    .query(({ ctx, input }) => safely(() => outreachCohortService.read(input, actor(ctx.session.userId)))),
  claimProspectOutreachWindow: adminProcedure.input(outreachCohortWindowInput)
    .mutation(({ ctx, input }) => safely(() => outreachCohortService.claimWindow(input, actor(ctx.session.userId)))),
  checkpointProspectOutreachMember: adminProcedure.input(outreachCohortCheckpointInput)
    .mutation(({ ctx, input }) => safely(() => outreachCohortService.checkpoint(input, actor(ctx.session.userId)))),
  acknowledgeProspectOutreachReview: adminProcedure.input(outreachCohortAcknowledgeInput)
    .mutation(({ ctx, input }) => safely(() => outreachCohortService.acknowledge(input, actor(ctx.session.userId)))),
})
