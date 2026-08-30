import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { readAttentionConsole } from './attention-console'
import {
  acknowledgeAttentionEvent,
  attentionEventActionInput,
  resolveAttentionEvent,
} from './attention-event-actions'
import { deriveFounderOperatingView } from './attention-operating-view'
import { attentionConsoleInput } from './attention-pagination'
import {
  markFounderBriefingReviewed,
  markFounderBriefingReviewedInput,
} from './attention-review-actions'
import { createFounderAskHandler, founderAskInput } from './founder-operating-conversation-handler'

export const adminAttentionConsoleRouter = router({
  attentionConsole: adminProcedure
    .input(attentionConsoleInput)
    .query(({ ctx, input }) => readAttentionConsole(ctx.session.userId, input)),
  founderOperatingView: adminProcedure
    .input(attentionConsoleInput)
    .query(async ({ ctx, input }) =>
      deriveFounderOperatingView(await readAttentionConsole(ctx.session.userId, input)),
    ),
  askFounderOperatingSystem: adminProcedure
    .input(founderAskInput)
    .mutation((options) => createFounderAskHandler(readAttentionConsole)(options)),
  markFounderBriefingReviewed: adminProcedure
    .input(markFounderBriefingReviewedInput)
    .mutation(({ ctx, input }) => markFounderBriefingReviewed(ctx.session.userId, input)),
  acknowledgeOperationalEvent: adminProcedure
    .input(attentionEventActionInput)
    .mutation(({ ctx, input }) => acknowledgeAttentionEvent(ctx.session.userId, input)),
  resolveOperationalEvent: adminProcedure
    .input(attentionEventActionInput)
    .mutation(({ ctx, input }) => resolveAttentionEvent(ctx.session.userId, input)),
})
