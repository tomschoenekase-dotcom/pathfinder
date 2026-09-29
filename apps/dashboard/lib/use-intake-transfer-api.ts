'use client'

import { useMemo } from 'react'

import type { IntakeUploadMimeType } from '@pathfinder/contracts/intake-upload'

import type { IntakeTransferApi } from './intake-file-transfer'
import { useTRPCClient } from './trpc'

/** The tenant-scoped upload endpoints behind every client file handoff. */
export function useIntakeTransferApi(): IntakeTransferApi {
  const client = useTRPCClient()
  return useMemo(
    () => ({
      reserve: (input) =>
        client.intakeUpload.reserve.mutate({
          ...input,
          mimeType: input.mimeType as IntakeUploadMimeType,
        }),
      verify: (input) => client.intakeUpload.verify.mutate(input),
      signMultipartPart: (input) => client.intakeUpload.signMultipartPart.mutate(input),
      completeMultipart: (input) => client.intakeUpload.completeMultipart.mutate(input),
    }),
    [client],
  )
}
