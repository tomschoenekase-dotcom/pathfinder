import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import {
  db,
  withTenantIsolationBypass,
  readProspectGeographySummary,
  readResearchTerritories,
  readProspectGeographyHolds,
  readProspectPhysicalGeography,
  assignProspectGeography,
  invalidateProspectGeography,
  ProspectGeographyError,
  proposeProspectGeography,
  listProspectGeographyProposals,
  resolveProspectGeographyProposal,
  claimCountyResearch,
  renewCountyResearch,
  releaseCountyResearch,
  completeCountyResearch,
  readCountyResearch,
  submitCountyDiscovery,
  readCountyDiscoveries,
  decideCountyDiscovery,
} from '@pathfinder/db'
import {
  ClaimCountyResearchInput,
  RenewCountyResearchInput,
  ReleaseCountyResearchInput,
  CompleteCountyResearchInput,
  ReadCountyResearchInput,
  SubmitCountyDiscoveryInput,
  ReadCountyDiscoveryInput,
  DecideCountyDiscoveryInput,
} from '@pathfinder/db/prospect-county-research'
import {
  AssignProspectGeographyInput,
  InvalidateProspectGeographyInput,
  ResearchTerritorySearchInput,
  GeographyRecordSearchInput,
  ProposeProspectGeographyInput,
  GeographyProposalListInput,
  ResolveProspectGeographyProposalInput,
} from '@pathfinder/db/prospect-territories'
import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const actor = (id: string) => ({
  id,
  runId: 'admin-territory-workspace',
  type: 'HUMAN' as const,
  scope: { mode: 'ALL' as const },
  capabilities: ['prospects.read', 'prospects.maintain', 'prospects.research'],
  authorityContext: 'authenticated-platform-admin',
})
async function execute<T>(work: () => Promise<T>) {
  try {
    return await withTenantIsolationBypass(() => work())
  } catch (error) {
    if (error instanceof ProspectGeographyError)
      throw new TRPCError({ code: error.code, message: error.message })
    throw error
  }
}

export const adminProspectCrmTerritoriesRouter = router({
  readCountyResearch: adminProcedure
    .input(ReadCountyResearchInput)
    .query(({ input, ctx }) => execute(() => readCountyResearch(input, actor(ctx.session.userId)))),
  claimCountyResearch: adminProcedure
    .input(ClaimCountyResearchInput)
    .mutation(({ input, ctx }) =>
      execute(() => claimCountyResearch(input, actor(ctx.session.userId))),
    ),
  renewCountyResearch: adminProcedure
    .input(RenewCountyResearchInput)
    .mutation(({ input, ctx }) =>
      execute(() => renewCountyResearch(input, actor(ctx.session.userId))),
    ),
  releaseCountyResearch: adminProcedure
    .input(ReleaseCountyResearchInput)
    .mutation(({ input, ctx }) =>
      execute(() => releaseCountyResearch(input, actor(ctx.session.userId))),
    ),
  completeCountyResearch: adminProcedure
    .input(CompleteCountyResearchInput)
    .mutation(({ input, ctx }) =>
      execute(() => completeCountyResearch(input, actor(ctx.session.userId))),
    ),
  submitCountyDiscovery: adminProcedure
    .input(SubmitCountyDiscoveryInput)
    .mutation(({ input, ctx }) =>
      execute(() => submitCountyDiscovery(input, actor(ctx.session.userId))),
    ),
  readCountyDiscoveries: adminProcedure
    .input(ReadCountyDiscoveryInput)
    .query(({ input, ctx }) =>
      execute(() => readCountyDiscoveries(input, actor(ctx.session.userId))),
    ),
  decideCountyDiscovery: adminProcedure
    .input(DecideCountyDiscoveryInput)
    .mutation(({ input, ctx }) =>
      execute(() => decideCountyDiscovery(input, actor(ctx.session.userId))),
    ),
  getProspectTerritoryModel: adminProcedure
    .input(z.object({}).strict())
    .query(() => execute(() => readProspectGeographySummary())),
  listResearchTerritories: adminProcedure
    .input(ResearchTerritorySearchInput)
    .query(({ input }) => execute(() => readResearchTerritories(input))),
  listProspectGeographyHolds: adminProcedure
    .input(GeographyRecordSearchInput)
    .query(({ input }) => execute(() => readProspectGeographyHolds(input))),
  getProspectPhysicalGeography: adminProcedure
    .input(z.object({ venueId: z.string().min(1).max(191) }).strict())
    .query(({ input }) => execute(() => readProspectPhysicalGeography(input.venueId))),
  proposeProspectPhysicalGeography: adminProcedure
    .input(ProposeProspectGeographyInput)
    .mutation(({ input, ctx }) =>
      execute(() => proposeProspectGeography(input, actor(ctx.session.userId))),
    ),
  listProspectGeographyProposals: adminProcedure
    .input(GeographyProposalListInput)
    .query(({ input, ctx }) =>
      execute(() => listProspectGeographyProposals(input, actor(ctx.session.userId))),
    ),
  resolveProspectGeographyProposal: adminProcedure
    .input(ResolveProspectGeographyProposalInput)
    .mutation(({ input, ctx }) =>
      execute(() => resolveProspectGeographyProposal(input, actor(ctx.session.userId))),
    ),
  assignProspectPhysicalGeography: adminProcedure
    .input(AssignProspectGeographyInput)
    .mutation(({ input, ctx }) =>
      execute(() =>
        assignProspectGeography(input, {
          id: ctx.session.userId,
          runId: 'admin-territory-workspace',
          type: 'HUMAN',
          scope: { mode: 'ALL' },
          capabilities: ['prospects.maintain'],
        }),
      ),
    ),
  invalidateProspectPhysicalGeography: adminProcedure
    .input(InvalidateProspectGeographyInput)
    .mutation(({ input, ctx }) =>
      execute(() =>
        invalidateProspectGeography(input, {
          id: ctx.session.userId,
          runId: 'admin-territory-workspace',
          type: 'HUMAN',
          scope: { mode: 'ALL' },
          capabilities: ['prospects.maintain'],
        }),
      ),
    ),
  listProspectTerritories: adminProcedure.query(() =>
    withTenantIsolationBypass(() =>
      db.prospectTerritory.findMany({
        where: { archivedAt: null },
        orderBy: { name: 'asc' },
        select: { id: true, code: true, name: true, region: true },
      }),
    ),
  ),
})
