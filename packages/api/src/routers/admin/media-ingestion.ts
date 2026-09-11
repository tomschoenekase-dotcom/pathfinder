import { mergeRouters } from '../../core'

import { mediaIngestionBeginUploadRouter } from './media-ingestion-begin-upload'
import { mediaIngestionCompleteUploadRouter } from './media-ingestion-complete-upload'
import { mediaIngestionExpiryRouter } from './media-ingestion-expiry'
import { mediaIngestionLifecycleRouter } from './media-ingestion-lifecycle'
import { mediaIngestionHandoffRouter } from './media-ingestion-handoff'
import { mediaIngestionResolutionRouter } from './media-ingestion-resolution'
import { mediaIngestionRelationApplicationRouter } from './media-ingestion-relations'
import { mediaIngestionTemporalRouter } from './media-ingestion-temporal'
import { mediaIngestionProjectsRouter } from './media-ingestion-projects'
import { mediaIngestionReconcileUploadRouter } from './media-ingestion-reconcile-upload'

export const mediaIngestionRouter = mergeRouters(
  mediaIngestionProjectsRouter,
  mediaIngestionBeginUploadRouter,
  mediaIngestionCompleteUploadRouter,
  mediaIngestionExpiryRouter,
  mediaIngestionReconcileUploadRouter,
  mediaIngestionLifecycleRouter,
  mediaIngestionHandoffRouter,
  mediaIngestionResolutionRouter,
  mediaIngestionRelationApplicationRouter,
  mediaIngestionTemporalRouter,
)
