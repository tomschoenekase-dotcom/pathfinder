import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  identifyIntakeFile,
  intakeFileFingerprint,
  MAX_INTAKE_FILE_BYTES,
  validateIntakeFile,
} from './intake-file-identity'

describe('intake file identity', () => {
  it('returns the exact full-file SHA-256 in hex and base64', async () => {
    const bytes = new TextEncoder().encode('Torchiko quarantine evidence')
    const file = new File([bytes], 'evidence.pdf', { type: 'application/pdf' })
    const identity = await identifyIntakeFile(file)
    expect(identity).toEqual({
      sha256Hex: createHash('sha256').update(bytes).digest('hex'),
      sha256Base64: createHash('sha256').update(bytes).digest('base64'),
    })
    expect(intakeFileFingerprint(file, identity)).not.toContain('Torchiko quarantine evidence')
  })

  it('allows only PDF and safe raster formats within the exact size bound', () => {
    expect(validateIntakeFile(new File(['x'], 'image.svg', { type: 'image/svg+xml' }))).toMatch(
      /PDF, JPEG, PNG, WebP, HEIC, HEIF, or TIFF/,
    )
    expect(validateIntakeFile(new File(['x'], 'photo.heic', { type: 'image/heic' }))).toBeNull()
    expect(validateIntakeFile(new File(['x'], 'scan.tiff', { type: 'image/tiff' }))).toBeNull()
    expect(validateIntakeFile(new File([], 'empty.pdf', { type: 'application/pdf' }))).toMatch(
      /empty/,
    )
    const oversized = new File(['x'], 'large.pdf', { type: 'application/pdf' })
    Object.defineProperty(oversized, 'size', { value: MAX_INTAKE_FILE_BYTES + 1 })
    expect(validateIntakeFile(oversized)).toMatch(/25 MiB/)
  })
})
