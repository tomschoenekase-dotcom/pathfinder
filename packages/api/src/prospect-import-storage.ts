import { randomUUID } from 'node:crypto'

import { currentDeploymentStorageKey } from './lib/deployment-storage-key'
import {
  inspectIntakeUpload,
  readIntakeUploadVersion,
  signIntakeUploadPut,
  type IntakeUploadStorageTransport,
} from './lib/intake-upload-storage'

/** Opaque private key; the user filename never becomes an object-store path. */
export function createProspectImportObjectKey() {
  return currentDeploymentStorageKey(`prospect-import-quarantine/${randomUUID()}`)
}

export function signProspectImportUpload(input: {
  key: string
  generation: string
  contentType: string
  bytes: number
  checksumSha256: string
}) {
  return signIntakeUploadPut(input)
}

export function inspectProspectImportUpload(input: {
  key: string
  generation: string
  contentType: string
  bytes: number
  checksumSha256: string
  storage?: IntakeUploadStorageTransport
  signal?: AbortSignal
}) {
  return inspectIntakeUpload(input)
}

export function readProspectImportUpload(input: {
  key: string
  versionId: string
  storage?: IntakeUploadStorageTransport
  signal?: AbortSignal
}) {
  return readIntakeUploadVersion(input)
}

export type { IntakeUploadStorageTransport as ProspectImportStorageTransport }
