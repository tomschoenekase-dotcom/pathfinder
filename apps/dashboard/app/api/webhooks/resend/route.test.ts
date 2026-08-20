import { describe, expect, it } from 'vitest'

import { POST } from './route'

describe('retired prospect Resend webhook', () => {
  it('cannot ingest or mutate prospect correspondence', async () => {
    const response = await POST()
    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toMatchObject({
      error: 'gone',
      detail: 'Resend is not a prospect correspondence provider',
    })
  })
})
