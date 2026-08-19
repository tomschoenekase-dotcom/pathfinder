import {
  INTAKE_UPLOAD_MAX_BYTES,
  INTAKE_UPLOAD_NON_MEDIA_MAX_BYTES,
  IntakeUploadMimeType,
  type IntakeUploadMimeType as IntakeUploadMime,
} from '@pathfinder/contracts/intake-upload'
import { createSHA256 } from 'hash-wasm'

export const MAX_INTAKE_FILE_BYTES = INTAKE_UPLOAD_MAX_BYTES
export const MAX_INTAKE_FILE_SELECTION = 20
export const INTAKE_FILE_HASH_CHUNK_BYTES = 8 * 1024 * 1024

export const SAFE_INTAKE_FILE_TYPES = IntakeUploadMimeType.options

export type IntakeFileIdentity = {
  sha256Hex: string
  sha256Base64: string
}

function hexToBase64(hex: string): string {
  let binary = ''
  for (let offset = 0; offset < hex.length; offset += 2) {
    binary += String.fromCharCode(Number.parseInt(hex.slice(offset, offset + 2), 16))
  }
  return globalThis.btoa(binary)
}

export function validateIntakeFile(file: File): string | null {
  if (!SAFE_INTAKE_FILE_TYPES.includes(file.type as IntakeUploadMime)) {
    return 'Choose a supported document, image, video, or audio file.'
  }
  if (!Number.isSafeInteger(file.size) || file.size < 1) return 'The file is empty or invalid.'
  const media = file.type.startsWith('video/') || file.type.startsWith('audio/')
  if (!media && file.size > INTAKE_UPLOAD_NON_MEDIA_MAX_BYTES) {
    return 'Documents and images must be 100 MB or smaller.'
  }
  if (file.size > MAX_INTAKE_FILE_BYTES) return 'Each file must be 2 GB or smaller.'
  return null
}

export async function identifyIntakeFile(file: File): Promise<IntakeFileIdentity> {
  const error = validateIntakeFile(file)
  if (error) throw new Error(error)
  const hasher = await createSHA256()
  hasher.init()
  if (typeof file.stream === 'function') {
    const reader = file.stream().getReader()
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      hasher.update(chunk.value)
    }
  } else {
    for (let offset = 0; offset < file.size; offset += INTAKE_FILE_HASH_CHUNK_BYTES) {
      const chunk = file.slice(offset, Math.min(file.size, offset + INTAKE_FILE_HASH_CHUNK_BYTES))
      hasher.update(new Uint8Array(await chunk.arrayBuffer()))
    }
  }
  const sha256Hex = hasher.digest('hex')
  return { sha256Hex, sha256Base64: hexToBase64(sha256Hex) }
}

export function intakeFileFingerprint(file: File, identity: IntakeFileIdentity): string {
  return `${file.name}\u0000${file.type}\u0000${file.size}\u0000${identity.sha256Hex}`
}
