import { mergeRouters } from '../../core'
import { adminKnowledgeProposalConflictRouter } from './knowledge-proposal-conflicts'
import { adminKnowledgeProposalDraftRouter } from './knowledge-proposal-drafts'
import { adminKnowledgeProposalPreviewRouter } from './knowledge-proposal-preview'
import { adminKnowledgeProposalReviewRouter } from './knowledge-proposal-review'
import { adminSupportCorrectionProposalsRouter } from './support-knowledge-proposals'

export const adminKnowledgeProposalsRouter = mergeRouters(
  adminKnowledgeProposalConflictRouter,
  adminKnowledgeProposalDraftRouter,
  adminKnowledgeProposalPreviewRouter,
  adminKnowledgeProposalReviewRouter,
  adminSupportCorrectionProposalsRouter,
)
