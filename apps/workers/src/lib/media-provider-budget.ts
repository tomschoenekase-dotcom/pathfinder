import { UnrecoverableError } from 'bullmq'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

export const MAX_MEDIA_PROVIDER_OPERATIONS = 10_000

type MediaProviderOperationIdentity = {
  tenantId: string
  projectId: string
  uploadAttemptId: string | null
}

export async function reserveMediaProviderOperation(
  identity: MediaProviderOperationIdentity,
): Promise<void> {
  const reserved = await withTenantIsolationBypass(() =>
    db.mediaIngestionProject.updateMany({
      where: {
        id: identity.projectId,
        tenantId: identity.tenantId,
        uploadAttemptId: identity.uploadAttemptId,
        status: { in: ['ANALYZING', 'SYNTHESIZING'] },
        providerOperationCount: { lt: MAX_MEDIA_PROVIDER_OPERATIONS },
      },
      data: { providerOperationCount: { increment: 1 } },
    }),
  )
  if (reserved.count !== 1) {
    throw new UnrecoverableError(
      `Media generation reached its ${MAX_MEDIA_PROVIDER_OPERATIONS}-operation safety limit.`,
    )
  }
}

export async function executeMediaProviderOperation<T>(
  reserve: () => Promise<void>,
  operation: () => Promise<T>,
  assertActive?: () => void,
): Promise<T> {
  await reserve()
  assertActive?.()
  return operation()
}
