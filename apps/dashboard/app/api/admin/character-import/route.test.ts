import { NextRequest } from 'next/server'
import { CustomCharacterFactoryActionError } from '@pathfinder/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  importCharacterBundle: vi.fn(),
}))

vi.mock('@clerk/nextjs/server', () => ({ auth: mocks.auth }))
vi.mock('@pathfinder/db', () => ({
  CustomCharacterFactoryActionError: class CustomCharacterFactoryActionError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
}))
vi.mock('../../../../lib/character-import', () => ({
  CHARACTER_IMPORT_MAX_BYTES: 12_000_000,
  importCharacterBundle: mocks.importCharacterBundle,
}))

import { POST } from './route'

const url = 'https://dashboard.example/api/admin/character-import'

function authenticate(role: unknown = 'PLATFORM_ADMIN') {
  mocks.auth.mockResolvedValue({
    userId: 'admin-1',
    sessionClaims: { publicMetadata: { platform_role: role } },
  })
}

function formRequest(
  fields: Record<string, string>,
  file?: File,
  headers: Record<string, string> = {},
) {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  if (file) form.set('bundle', file)
  return new NextRequest(url, { method: 'POST', body: form, headers })
}

const validFields = {
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  requestId: 'request-1',
  brief: 'Inspect the prepared appearance.',
  rationale: 'Prepared from the approved source record.',
  sourceProvenance: 'GENERATED',
}

function validFile() {
  return new File(['{}'], 'candidate.character.json', { type: 'application/json' })
}

describe('admin character import route boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authenticate()
    mocks.importCharacterBundle.mockResolvedValue({
      characterId: 'character-1',
      displayName: 'Mochi',
      briefId: 'brief-1',
      jobId: 'job-1',
      replayed: false,
    })
  })

  it('rejects unauthenticated and non-platform-admin callers before parsing the body', async () => {
    mocks.auth.mockResolvedValueOnce({ userId: null, sessionClaims: null })
    expect((await POST(formRequest(validFields, validFile()))).status).toBe(401)

    authenticate('OWNER')
    expect((await POST(formRequest(validFields, validFile()))).status).toBe(403)
    expect(mocks.importCharacterBundle).not.toHaveBeenCalled()
  })

  it('rejects cross-origin requests before service work', async () => {
    const response = await POST(
      formRequest(validFields, validFile(), {
        origin: 'https://attacker.example',
        'sec-fetch-site': 'cross-site',
      }),
    )
    expect(response.status).toBe(403)
    expect(mocks.importCharacterBundle).not.toHaveBeenCalled()
  })

  it('accepts the public host when the internal Next request URL uses a proxy host', async () => {
    const form = new FormData()
    for (const [key, value] of Object.entries(validFields)) form.set(key, value)
    form.set('bundle', validFile())
    const request = new NextRequest('https://0.0.0.0:3000/api/admin/character-import', {
      method: 'POST',
      body: form,
      headers: { origin: 'https://dashboard.example', host: 'dashboard.example' },
    })
    expect((await POST(request)).status).toBe(201)
    expect(mocks.importCharacterBundle).toHaveBeenCalledOnce()
  })

  it('rejects chunked bodies once the bounded reader crosses the limit', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8_000_000))
        controller.enqueue(new Uint8Array(4_300_000))
        controller.close()
      },
    })
    const request = new NextRequest(url, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=unused' },
      body: stream,
      duplex: 'half',
    })
    const response = await POST(request)
    expect(response.status).toBe(413)
    expect(mocks.importCharacterBundle).not.toHaveBeenCalled()
  })

  it('returns a timeout for a stalled request body and cancels the reader', async () => {
    vi.useFakeTimers()
    try {
      let cancelled = false
      const stream = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true
          return new Promise<void>(() => undefined)
        },
      })
      const request = new NextRequest(url, {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=unused' },
        body: stream,
        duplex: 'half',
      })
      const pending = POST(request)
      await vi.advanceTimersByTimeAsync(15_001)
      const response = await pending
      expect(response.status).toBe(408)
      expect(cancelled).toBe(true)
      expect(mocks.importCharacterBundle).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['missing metadata', { ...validFields, brief: '' }, validFile()],
    [
      'wrong extension',
      validFields,
      new File(['{}'], 'candidate.json', { type: 'application/json' }),
    ],
    [
      'empty file',
      validFields,
      new File([], 'candidate.character.json', { type: 'application/json' }),
    ],
  ])('rejects %s without mutating the import service', async (_label, fields, file) => {
    const response = await POST(formRequest(fields, file))
    expect(response.status).toBe(400)
    expect(mocks.importCharacterBundle).not.toHaveBeenCalled()
  })

  it('passes the bounded valid request to the service and returns its result', async () => {
    const file = new File(['bundle-bytes'], 'candidate.character.json', {
      type: 'application/json',
    })
    const response = await POST(formRequest(validFields, file))
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ ok: true, characterId: 'character-1' })
    expect(mocks.importCharacterBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        requestId: 'request-1',
        sourceProvenance: 'GENERATED',
        actorId: 'admin-1',
        bytes: expect.any(Uint8Array),
      }),
    )
  })

  it.each<['CONFLICT' | 'NOT_FOUND' | 'INVALID_INPUT', number]>([
    ['CONFLICT', 409],
    ['NOT_FOUND', 404],
    ['INVALID_INPUT', 400],
  ])('maps service %s errors without exposing details', async (code, status) => {
    mocks.importCharacterBundle.mockRejectedValue(
      new CustomCharacterFactoryActionError(code, 'private database detail'),
    )
    const response = await POST(formRequest(validFields, validFile()))
    expect(response.status).toBe(status)
    expect(await response.text()).not.toContain('private database detail')
  })
})
