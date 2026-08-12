import {
  INTAKE_UPLOAD_MAX_BYTES,
  IntakeUploadMimeType,
  type IntakeUploadMimeType as IntakeUploadMime,
} from '@pathfinder/contracts/intake-upload'

export const MAX_INTAKE_FILE_BYTES = INTAKE_UPLOAD_MAX_BYTES
export const MAX_INTAKE_FILE_SELECTION = 20

export const SAFE_INTAKE_FILE_TYPES = IntakeUploadMimeType.options

export type IntakeFileIdentity = {
  sha256Hex: string
  sha256Base64: string
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return globalThis.btoa(binary)
}

export function validateIntakeFile(file: File): string | null {
  if (!SAFE_INTAKE_FILE_TYPES.includes(file.type as IntakeUploadMime)) {
    return 'Choose a PDF, JPEG, PNG, WebP, HEIC, HEIF, or TIFF file.'
  }
  if (!Number.isSafeInteger(file.size) || file.size < 1) return 'The file is empty or invalid.'
  if (file.size > MAX_INTAKE_FILE_BYTES) return 'Each file must be 25 MiB or smaller.'
  return null
}

export async function identifyIntakeFile(file: File): Promise<IntakeFileIdentity> {
  const error = validateIntakeFile(file)
  if (error) throw new Error(error)
  if (!globalThis.crypto?.subtle) {
    throw new Error('This browser cannot verify the file. Update the browser and try again.')
  }
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', await file.arrayBuffer()),
  )
  return { sha256Hex: bytesToHex(digest), sha256Base64: bytesToBase64(digest) }
}

export function intakeFileFingerprint(file: File, identity: IntakeFileIdentity): string {
  return `${file.name}\u0000${file.type}\u0000${file.size}\u0000${identity.sha256Hex}`
}
