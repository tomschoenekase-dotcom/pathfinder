import type { Queue } from 'bullmq'

export const MEDIA_INGESTION_GLOBAL_CONCURRENCY = 1

type MediaIngestionAdmissionQueue = Pick<Queue, 'getGlobalConcurrency' | 'setGlobalConcurrency'>

export async function configureMediaIngestionGlobalConcurrency(
  queue: MediaIngestionAdmissionQueue,
): Promise<void> {
  await queue.setGlobalConcurrency(MEDIA_INGESTION_GLOBAL_CONCURRENCY)
  const configuredConcurrency = await queue.getGlobalConcurrency()

  if (configuredConcurrency !== MEDIA_INGESTION_GLOBAL_CONCURRENCY) {
    throw new Error('Media ingestion global concurrency could not be verified')
  }
}
