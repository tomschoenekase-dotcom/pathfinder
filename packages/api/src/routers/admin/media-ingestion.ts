import { mergeRouters } from '../../core'

import { mediaIngestionBeginUploadRouter } from './media-ingestion-begin-upload'
import { mediaIngestionCompleteUploadRouter } from './media-ingestion-complete-upload'
import { mediaIngestionLifecycleRouter } from './media-ingestion-lifecycle'
import { mediaIngestionProjectsRouter } from './media-ingestion-projects'

export const mediaIngestionRouter = mergeRouters(
  mediaIngestionProjectsRouter,
  mediaIngestionBeginUploadRouter,
  mediaIngestionCompleteUploadRouter,
  mediaIngestionLifecycleRouter,
)
