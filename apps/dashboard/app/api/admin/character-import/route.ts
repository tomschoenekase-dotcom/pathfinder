import { auth } from '@clerk/nextjs/server'
import { CustomCharacterFactoryActionError } from '@pathfinder/db'
import { NextResponse, type NextRequest } from 'next/server'

import { CHARACTER_IMPORT_MAX_BYTES, importCharacterBundle } from '../../../../lib/character-import'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_MULTIPART_BYTES = CHARACTER_IMPORT_MAX_BYTES + 256 * 1024

async function readBoundedFormData(request: Request) {
  if (!request.body) throw new Error('INVALID_MULTIPART')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  const deadline = Date.now() + 15_000
  try {
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('BODY_TIMEOUT')
      let timer: ReturnType<typeof setTimeout> | undefined
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('BODY_TIMEOUT')), remaining)
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer)
      })
      if (next.done) break
      total += next.value.byteLength
      if (total > MAX_MULTIPART_BYTES) throw new Error('BODY_TOO_LARGE')
      chunks.push(next.value)
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const headers = new Headers()
  const contentType = request.headers.get('content-type')
  if (contentType) headers.set('content-type', contentType)
  return new Request(request.url, { method: 'POST', headers, body: bytes }).formData()
}

function sameOrigin(request: Request) {
  const site = request.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'same-site' && site !== 'none') return false
  const origin = request.headers.get('origin')
  if (!origin) return true
  try {
    const requestUrl = new URL(request.url)
    const host = request.headers.get('host')
    const expectedOrigin = host ? `${requestUrl.protocol}//${host}` : requestUrl.origin
    return new URL(origin).origin === expectedOrigin
  } catch {
    return false
  }
}

function text(form: FormData, key: string, max: number) {
  const value = form.get(key)
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
    ? value.trim()
    : null
}

export async function POST(request: NextRequest) {
  const { userId, sessionClaims } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 })
  const isPlatformAdmin =
    (sessionClaims?.publicMetadata as { platform_role?: string } | undefined)?.platform_role ===
    'PLATFORM_ADMIN'
  if (!isPlatformAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  if (!sameOrigin(request)) return NextResponse.json({ error: 'Origin rejected' }, { status: 403 })

  const declaredLength = request.headers.get('content-length')
  if (
    declaredLength &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_MULTIPART_BYTES)
  )
    return NextResponse.json({ error: 'Import request is too large' }, { status: 413 })

  let form: FormData
  try {
    form = await readBoundedFormData(request)
  } catch (error) {
    if (error instanceof Error && error.message === 'BODY_TOO_LARGE')
      return NextResponse.json({ error: 'Import request is too large' }, { status: 413 })
    if (error instanceof Error && error.message === 'BODY_TIMEOUT')
      return NextResponse.json({ error: 'Import request timed out' }, { status: 408 })
    return NextResponse.json({ error: 'Invalid multipart import request' }, { status: 400 })
  }
  const tenantId = text(form, 'tenantId', 191)
  const venueId = text(form, 'venueId', 191)
  const requestId = text(form, 'requestId', 191)
  const brief = text(form, 'brief', 4_000)
  const rationale = text(form, 'rationale', 2_000)
  const sourceProvenance = text(form, 'sourceProvenance', 30)
  const bundle = form.get('bundle')
  if (
    !tenantId ||
    !venueId ||
    !requestId ||
    !brief ||
    !rationale ||
    (sourceProvenance !== 'GENERATED' &&
      sourceProvenance !== 'IMPORTED' &&
      sourceProvenance !== 'IMPORTED_FIXTURE') ||
    !(bundle instanceof File) ||
    bundle.size < 1 ||
    bundle.size > CHARACTER_IMPORT_MAX_BYTES ||
    !bundle.name.toLowerCase().endsWith('.character.json')
  )
    return NextResponse.json(
      { error: 'Provide a valid character bundle and bounded metadata' },
      { status: 400 },
    )
  const provenance = sourceProvenance as 'GENERATED' | 'IMPORTED' | 'IMPORTED_FIXTURE'

  try {
    const bytes = new Uint8Array(await bundle.arrayBuffer())
    if (bytes.byteLength > CHARACTER_IMPORT_MAX_BYTES)
      return NextResponse.json({ error: 'Character bundle is too large' }, { status: 413 })
    const result = await importCharacterBundle({
      tenantId,
      venueId,
      requestId,
      brief,
      rationale,
      sourceProvenance: provenance,
      bytes,
      actorId: userId,
    })
    return NextResponse.json({ ok: true, ...result }, { status: 201 })
  } catch (error) {
    const code = error instanceof CustomCharacterFactoryActionError ? error.code : undefined
    const status =
      code === 'CONFLICT' ? 409 : code === 'NOT_FOUND' ? 404 : code === 'INVALID_INPUT' ? 400 : 503
    return NextResponse.json(
      {
        error:
          status === 409
            ? 'This import conflicts with an existing request.'
            : status === 404
              ? 'The selected venue was not found.'
              : status === 400
                ? 'The bundle or import metadata is invalid.'
                : 'Character import could not be completed',
      },
      { status },
    )
  }
}
