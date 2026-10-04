import { TRPCError } from '@trpc/server'

import { router } from '../core'
import { requireRole } from '../middleware/require-role'
import {
  ApproveSourceConnectionInput,
  CreateSourceConnectionInput,
  GetSourceConnectionInput,
  ListSourceConnectionsInput,
  UpdateSourceConnectionInput,
  VersionedSourceConnectionInput,
} from '../schemas/source-connections'
import { tenantProcedure } from '../trpc'
import {
  approveSourceConnectionPreview,
  createSourceConnectionDraft,
  getSourceConnection,
  listSourceConnections,
  requestSourceConnectionPreview,
  requestSourceConnectionRefresh,
  setSourceConnectionState,
  updateSourceConnectionDraft,
} from './source-connections-actions'

function actor(ctx: { session: { userId: string; role: string | null } }): {
  actorId: string
  actorRole: 'MANAGER' | 'OWNER'
} {
  if (ctx.session.role !== 'MANAGER' && ctx.session.role !== 'OWNER')
    throw new TRPCError({ code: 'FORBIDDEN' })
  return { actorId: ctx.session.userId, actorRole: ctx.session.role }
}

export const sourceConnectionsRouter = router({
  list: tenantProcedure.input(ListSourceConnectionsInput).query(({ ctx, input }) =>
    listSourceConnections({
      tenantId: ctx.session.activeTenantId,
      venueId: input.venueId,
      database: ctx.db,
    }),
  ),
  get: tenantProcedure
    .input(GetSourceConnectionInput)
    .query(({ ctx, input }) =>
      getSourceConnection({ tenantId: ctx.session.activeTenantId, ...input, database: ctx.db }),
    ),
  createDraft: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(CreateSourceConnectionInput)
    .mutation(({ ctx, input }) =>
      createSourceConnectionDraft({
        tenantId: ctx.session.activeTenantId,
        ...actor(ctx),
        venueId: input.venueId,
        name: input.name,
        config: input.config,
        ...(input.operationId ? { operationId: input.operationId } : {}),
        database: ctx.db,
      }),
    ),
  updateDraft: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(UpdateSourceConnectionInput)
    .mutation(({ ctx, input }) =>
      updateSourceConnectionDraft({
        tenantId: ctx.session.activeTenantId,
        ...actor(ctx),
        ...input,
        database: ctx.db,
      }),
    ),
  requestPreview: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(VersionedSourceConnectionInput)
    .mutation(({ ctx, input }) =>
      requestSourceConnectionPreview({
        tenantId: ctx.session.activeTenantId,
        ...actor(ctx),
        ...input,
        database: ctx.db,
      }),
    ),
  approvePreview: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(ApproveSourceConnectionInput)
    .mutation(({ ctx, input }) =>
      approveSourceConnectionPreview({
        tenantId: ctx.session.activeTenantId,
        ...actor(ctx),
        ...input,
        database: ctx.db,
      }),
    ),
  pause: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(VersionedSourceConnectionInput)
    .mutation(({ ctx, input }) =>
      setSourceConnectionState({
        tenantId: ctx.session.activeTenantId,
        ...actor(ctx),
        ...input,
        state: 'DISABLED',
        database: ctx.db,
      }),
    ),
  resume: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(VersionedSourceConnectionInput)
    .mutation(({ ctx, input }) =>
      setSourceConnectionState({
        tenantId: ctx.session.activeTenantId,
        ...actor(ctx),
        ...input,
        state: 'ACTIVE',
        database: ctx.db,
      }),
    ),
  requestRefresh: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(VersionedSourceConnectionInput)
    .mutation(({ ctx, input }) =>
      requestSourceConnectionRefresh({
        tenantId: ctx.session.activeTenantId,
        ...actor(ctx),
        ...input,
        database: ctx.db,
      }),
    ),
})
