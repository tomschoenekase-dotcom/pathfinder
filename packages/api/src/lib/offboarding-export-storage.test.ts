import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createOffboardingExportStorage } from './offboarding-export-storage'

const send = vi.fn()

beforeEach(() => {
  vi.stubEnv('STORAGE_BUCKET', 'private')
  vi.stubEnv('STORAGE_REGION', 'test')
  vi.stubEnv('STORAGE_ACCESS_KEY_ID', 'test')
  vi.stubEnv('STORAGE_SECRET_ACCESS_KEY', 'test')
  send.mockReset()
})

describe('offboarding export storage', () => {
  it('uses a create-only exact-byte put and requires immutable version evidence', async () => {
    send.mockResolvedValue({ VersionId: 'version-1' })
    await expect(
      createOffboardingExportStorage({ send } as never).putExact({
        key: 'offboarding/key.json',
        bytes: new Uint8Array([1, 2]),
        contentHash: 'a'.repeat(64),
      }),
    ).resolves.toEqual({ versionId: 'version-1' })
    const command = send.mock.calls[0]?.[0]
    expect(command).toBeInstanceOf(PutObjectCommand)
    expect(command.input).toMatchObject({ IfNoneMatch: '*', ContentLength: 2 })
  })

  it('reconciles an ambiguous existing object only when hash, length and version match', async () => {
    send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 412 } }).mockResolvedValueOnce({
      Metadata: { 'pathfinder-sha256': 'b'.repeat(64) },
      ContentLength: 1,
      VersionId: 'version-2',
    })
    await expect(
      createOffboardingExportStorage({ send } as never).putExact({
        key: 'offboarding/key.json',
        bytes: new Uint8Array([1]),
        contentHash: 'b'.repeat(64),
      }),
    ).resolves.toEqual({ versionId: 'version-2' })
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(HeadObjectCommand)
  })

  it('refuses overwrite reconciliation for mismatched or unversioned evidence', async () => {
    send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 412 } }).mockResolvedValueOnce({
      Metadata: { 'pathfinder-sha256': 'c'.repeat(64) },
      ContentLength: 2,
    })
    await expect(
      createOffboardingExportStorage({ send } as never).putExact({
        key: 'offboarding/key.json',
        bytes: new Uint8Array([1]),
        contentHash: 'b'.repeat(64),
      }),
    ).rejects.toThrow('does not match')
  })
})
