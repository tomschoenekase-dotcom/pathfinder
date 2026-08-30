import { describe, expect, it, vi } from 'vitest'

import { serializeSafeCliFailure, writeSafeCliFailure } from './safe-cli-failure'

describe('safe CLI failure output', () => {
  it('emits only bounded operational metadata', () => {
    expect(
      JSON.parse(
        serializeSafeCliFailure({
          action: 'embedding.freshness.failed',
          errorCode: 'embedding-freshness-failed',
          mutationAccepted: false,
          environment: 'staging',
        }),
      ),
    ).toEqual({
      ok: false,
      action: 'embedding.freshness.failed',
      errorCode: 'embedding-freshness-failed',
      mutationAccepted: false,
      environment: 'staging',
    })
  })

  it('fails closed when caller-supplied metadata is unsafe', () => {
    const secret = 'postgres://operator:secret@example.test/torchiko'
    const serialized = serializeSafeCliFailure({
      action: secret,
      errorCode: secret,
      environment: secret,
    })

    expect(serialized).not.toContain(secret)
    expect(JSON.parse(serialized)).toEqual({
      ok: false,
      action: 'cli.failed',
      errorCode: 'cli-operation-failed',
    })
  })

  it('writes the sanitized JSON line to the selected stream', () => {
    const write = vi.fn()
    writeSafeCliFailure(
      { action: 'terminal-redrive.failed', errorCode: 'terminal-redrive-failed' },
      { write },
    )
    expect(write).toHaveBeenCalledWith(
      '{"ok":false,"action":"terminal-redrive.failed","errorCode":"terminal-redrive-failed"}\n',
    )
  })
})
