import { createHash } from 'node:crypto'

import {
  canonicalSupportPortableExportJson,
  SUPPORT_PORTABLE_EXPORT_MAX_BYTES,
  SupportPortableExportEnvelope,
  SupportPortableExportInput,
} from '@pathfinder/contracts'

import { createAdminCaller } from '../../../../../../lib/admin-caller'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const REQUEST_MAX_BYTES = 16 * 1024
const headers = {
  'Cache-Control': 'private, no-store',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Content-Type': 'text/plain; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
}

type BoundedRead = { ok: true; value: unknown } | { ok: false }
type ExportBytes = { ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false; status: 413 | 500 }

function failure(message: string, status: number) {
  return new Response(message, { status, headers })
}

function hasSameOrigin(request: Request) {
  const origin = request.headers.get('origin')
  if (!origin) return false
  try {
    return new URL(request.url).origin === new URL(origin).origin
  } catch {
    return false
  }
}

function isJsonRequest(request: Request) {
  return request.headers.get('content-type')?.toLowerCase().split(';', 1)[0] === 'application/json'
}

async function readBoundedJson(request: Request): Promise<BoundedRead> {
  const contentLength = request.headers.get('content-length')
  if (contentLength && (!/^\d+$/u.test(contentLength) || Number(contentLength) > REQUEST_MAX_BYTES)) {
    return { ok: false }
  }
  if (!request.body) return { ok: false }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    let result = await reader.read()
    while (!result.done) {
      const value = result.value
      total += value.byteLength
      if (total > REQUEST_MAX_BYTES) {
        await reader.cancel()
        return { ok: false }
      }
      chunks.push(value)
      result = await reader.read()
    }
  } catch {
    return { ok: false }
  } finally {
    reader.releaseLock()
  }
  if (total === 0) return { ok: false }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown }
  } catch {
    return { ok: false }
  }
}

function checksum(payload: unknown) {
  return createHash('sha256').update(canonicalSupportPortableExportJson(payload), 'utf8').digest('hex')
}

function exportBytes(value: unknown): ExportBytes {
  const parsed = SupportPortableExportEnvelope.safeParse(value)
  if (!parsed.success) return { ok: false, status: 500 }
  const { contentSha256, ...payload } = parsed.data
  if (checksum(payload) !== contentSha256) return { ok: false, status: 500 }
  const encoded = new TextEncoder().encode(canonicalSupportPortableExportJson(parsed.data))
  if (encoded.byteLength === 0) return { ok: false, status: 500 }
  if (encoded.byteLength > SUPPORT_PORTABLE_EXPORT_MAX_BYTES) return { ok: false, status: 413 }
  const bytes = new Uint8Array(encoded.byteLength)
  bytes.set(encoded)
  return { ok: true, bytes }
}

function errorStatus(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null
  if (code === 'UNAUTHORIZED') return 401
  if (code === 'FORBIDDEN') return 403
  if (code === 'NOT_FOUND') return 404
  if (code === 'PAYLOAD_TOO_LARGE') return 413
  if (code === 'PRECONDITION_FAILED' || code === 'CONFLICT') return 409
  return 500
}

function errorMessage(status: number) {
  if (status === 404) return 'The selected support export scope is unavailable.'
  if (status === 409) return 'The selected support export cannot be prepared for the requested scope.'
  if (status === 413) return 'The selected support export exceeds the safe download limit.'
  return 'The support export is unavailable.'
}

type SupportPortableExportRouteContext = { params: Promise<{ tenantId: string }> }

export async function POST(request: Request, context: SupportPortableExportRouteContext) {
  const { tenantId } = await context.params
  if (!hasSameOrigin(request)) return failure('Cross-site export requests are not accepted.', 403)
  if (!isJsonRequest(request)) return failure('A JSON export request is required.', 415)

  const body = await readBoundedJson(request)
  const input = body.ok ? SupportPortableExportInput.safeParse(body.value) : null
  if (!input?.success || input.data.tenantId !== tenantId) {
    return failure('Invalid support export request.', 400)
  }

  try {
    const caller = await createAdminCaller()
    const envelope = await caller.admin.prepareSupportPortableExport(input.data)
    const prepared = exportBytes(envelope)
    if (!prepared.ok) {
      return failure('The support export could not be prepared safely.', prepared.status)
    }

    return new Response(prepared.bytes, {
      status: 200,
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Disposition': 'attachment; filename="support-portable-export.json"',
        'Content-Length': String(prepared.bytes.byteLength),
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (error) {
    const status = errorStatus(error)
    return failure(errorMessage(status), status)
  }
}
