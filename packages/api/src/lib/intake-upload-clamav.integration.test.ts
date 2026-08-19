import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { configuredIntakeUploadMalwareScanner } from './intake-upload-byte-verifier'

const enabled = Boolean(process.env.INTAKE_CLAMAV_HOST)
const logoPath = fileURLToPath(
  new URL('../../../../apps/web/public/pathfinder-logo.png', import.meta.url),
)

describe.runIf(enabled)('configured ClamAV intake scanner', () => {
  it('streams a repository PNG and binds the clean verdict to its exact bytes', async () => {
    const scanner = configuredIntakeUploadMalwareScanner()
    expect(scanner).not.toBeNull()
    const expectedBytes = statSync(logoPath).size
    const expectedSha256 = createHash('sha256').update(readFileSync(logoPath)).digest('hex')

    const result = await scanner!.scan({
      bytes: createReadStream(logoPath),
      expectedBytes,
      expectedSha256,
    })

    expect(result).toMatchObject({
      verdict: 'CLEAN',
      computedByteSize: expectedBytes,
      computedSha256: expectedSha256,
    })
    expect(result.verdictHash).toMatch(/^[a-f0-9]{64}$/u)
  })
})
