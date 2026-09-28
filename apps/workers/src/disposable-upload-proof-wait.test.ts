import { describe, expect, it } from 'vitest'

import {
  waitForDisposableUploadProof,
  withDisposableUploadProofDeadline,
} from './disposable-upload-proof-wait'

describe('disposable upload proof waits', () => {
  it('bounds a probe that never settles', async () => {
    await expect(
      waitForDisposableUploadProof(() => new Promise(() => undefined), 'worker completion', 5),
    ).rejects.toMatchObject({ code: 'DISPOSABLE_UPLOAD_WORKER_WAIT_TIMEOUT' })
  })

  it('bounds diagnostic collection after a worker timeout', async () => {
    await expect(
      withDisposableUploadProofDeadline(
        () => new Promise(() => undefined),
        5,
        'worker diagnostics',
      ),
    ).rejects.toMatchObject({ code: 'DISPOSABLE_UPLOAD_WORKER_WAIT_TIMEOUT' })
  })
})
