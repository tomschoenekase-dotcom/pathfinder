import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { open, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { z } from 'zod'

const outputSchema = z
  .object({
    schema: z.literal('torchiko.native-sales-components/1'),
    nativeSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
    SEND_AUTHORIZED: z.literal(false),
    senderAvailable: z.literal(false),
    gate: z
      .object({
        decision: z.enum(['ENOUGH_EVIDENCE', 'RESEARCH_REQUIRED', 'HUMAN_INPUT_REQUIRED']),
        can_prepare: z.boolean(),
      })
      .passthrough(),
  })
  .passthrough()

/** The installed Composer/WLT bridge is a local owner, never a deployed worker fallback. */
export function assertLocalCrmSalesComponentsEnvironment(
  env: Record<string, string | undefined> = process.env,
): string {
  if (
    env.NODE_ENV !== 'development' ||
    env.TORCHIKO_LOCAL_CRM_RESEARCH_ENABLED !== '1' ||
    env.TORCHIKO_LOCAL_CRM_SALES_ENABLED !== '1' ||
    env.APP_ENV === 'production' ||
    env.DEPLOYMENT_ENV === 'production'
  )
    throw new Error('Local CRM sales components are disabled')
  const target = new URL(env.DATABASE_URL ?? '')
  if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
    target.port !== '58617' ||
    target.pathname !== '/pathfinder_disposable_crm_research_20260919' ||
    target.search ||
    target.hash ||
    (env.DIRECT_DATABASE_URL && env.DIRECT_DATABASE_URL !== env.DATABASE_URL)
  )
    throw new Error('Local CRM sales components require the isolated research database')
  const script = env.TORCHIKO_CRM_SALES_BRIDGE
  if (
    !script ||
    !isAbsolute(script) ||
    basename(script) !== 'component_bridge.py' ||
    !env.TORCHIKO_CRM_VAULT ||
    !isAbsolute(env.TORCHIKO_CRM_VAULT)
  )
    throw new Error('Local CRM sales component owner paths are not configured')
  return script
}

/** Explicit private installed runtime for an authenticated platform-admin CRM.
 * The original component corpus stays on the owning machine; no fallback to
 * a public package, remote API, fixture database, or synthetic rehearsal. */
export function assertAuthenticatedCrmSalesComponentsEnvironment(
  env: Record<string, string | undefined> = process.env,
): string {
  if (
    env.TORCHIKO_AUTHENTICATED_CRM_SALES_ENABLED !== '1' ||
    env.TORCHIKO_LOCAL_CRM_REHEARSAL === '1' ||
    env.TORCHIKO_LOCAL_CRM_RESEARCH_ENABLED === '1' ||
    env.TORCHIKO_LOCAL_CRM_SALES_ENABLED === '1'
  )
    throw new Error('Authenticated private CRM sales components are not configured')
  const script = env.TORCHIKO_CRM_SALES_BRIDGE
  if (
    !script ||
    !isAbsolute(script) ||
    basename(script) !== 'component_bridge.py' ||
    !env.TORCHIKO_CRM_VAULT ||
    !isAbsolute(env.TORCHIKO_CRM_VAULT)
  )
    throw new Error('Private CRM sales component owner paths are not configured')
  return script
}

export const TORCHIKO_SAVED_WRITING_GUIDE = 'torchiko-v0.2' as const
export const TORCHIKO_SAVED_WRITING_GUIDE_SOURCE =
  'torchiko-writing-reference:v0.2-r001/TORCHIKO-WRITING-REFERENCE.md'
const guideRelative = join(
  '95 AI Staging',
  'Torchiko Sales Writing Reference 2026-09-21',
  'v0.2-r001',
  'TORCHIKO-WRITING-REFERENCE.md',
)

/** Path presence is useful readiness evidence, not successful Python execution. */
export async function inspectAuthenticatedCrmSalesComponents(
  env: Record<string, string | undefined> = process.env,
) {
  let script: string
  try {
    script = assertAuthenticatedCrmSalesComponentsEnvironment(env)
  } catch {
    return {
      state: 'unconfigured' as const,
      reason: 'PRIVATE_COMPONENT_CONFIGURATION_REQUIRED' as const,
      guide: { state: 'unconfigured' as const, sha256: null },
    }
  }
  try {
    const [bridge, vault] = await Promise.all([stat(script), stat(env.TORCHIKO_CRM_VAULT!)])
    if (!bridge.isFile() || !vault.isDirectory()) throw new Error('Invalid owner type')
  } catch {
    return {
      state: 'unavailable' as const,
      reason: 'PRIVATE_COMPONENT_OWNER_NOT_INSTALLED' as const,
      guide: { state: 'unavailable' as const, sha256: null },
    }
  }
  let guide: { state: 'available' | 'unavailable'; sha256: string | null } = {
    state: 'unavailable',
    sha256: null,
  }
  try {
    const selected = await readAuthenticatedTorchikoWritingGuide(env)
    guide = { state: 'available', sha256: selected.sha256 }
  } catch {
    /* Only a safe status leaves this boundary. */
  }
  return {
    state: 'paths-present-runtime-unverified' as const,
    reason: 'PRIVATE_COMPONENT_PATHS_PRESENT_RUNTIME_UNVERIFIED' as const,
    guide,
  }
}

/** Explicit named selection by an authenticated admin action. The saved guide
 * is never an implicit default, a public read endpoint or venue evidence. */
export async function readAuthenticatedTorchikoWritingGuide(
  env: Record<string, string | undefined> = process.env,
) {
  assertAuthenticatedCrmSalesComponentsEnvironment(env)
  return readExactOwnerWritingGuide(env)
}

/** The opted-in local path gets identical freshness checks, not authenticated
 * authority. Its original exact host/database/path guards remain mandatory. */
export async function readLocalTorchikoWritingGuide(
  env: Record<string, string | undefined> = process.env,
) {
  assertLocalCrmSalesComponentsEnvironment(env)
  return readExactOwnerWritingGuide(env)
}

async function readExactOwnerWritingGuide(env: Record<string, string | undefined>) {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const root = await realpath(env.TORCHIKO_CRM_VAULT!)
    const selected = await realpath(join(root, guideRelative))
    if (relative(root, selected) !== guideRelative) throw new Error('Guide outside owner root')
    handle = await open(selected, 'r')
    const file = await handle.stat()
    if (!file.isFile() || file.size > 32_000) throw new Error('Guide outside bounded file contract')
    const bytes = Buffer.alloc(32_001)
    let used = 0
    while (used < bytes.length) {
      const part = await handle.read(bytes, used, bytes.length - used, null)
      if (!part.bytesRead) break
      used += part.bytesRead
    }
    if (used > 32_000) throw new Error('Guide changed beyond bounded contract')
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, used),
    )
    if (!text.trim() || text.length > 20_000 || text.includes('\0'))
      throw new Error('Guide outside bounded text contract')
    return {
      label: 'Torchiko sales writing reference v0.2',
      sourceRef: TORCHIKO_SAVED_WRITING_GUIDE_SOURCE,
      text,
      sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    }
  } catch {
    throw new Error('SELECTED_WRITING_GUIDE_UNAVAILABLE: exact private guide could not be read')
  } finally {
    await handle?.close()
  }
}

type Request<T extends { snapshotHash: string }> = {
  action: 'evaluate' | 'prepare' | 'check' | 'meaning' | 'capture' | 'admission'
  native: T
  answerText?: string
  draft?: { subject: string; body: string }
  review?: unknown
  capture?: Record<string, unknown>
  admission?: Record<string, unknown>
}

/** Shared local runtime for the API and registered worker. It has no provider,
 * credential, network, or authority inputs; the database owner validates the result. */
export async function invokeLocalCrmSalesComponents<T extends { snapshotHash: string }>(
  payload: Request<T>,
  runtime: 'local' | 'authenticated-admin' = 'local',
): Promise<Record<string, unknown>> {
  const script =
    runtime === 'local'
      ? assertLocalCrmSalesComponentsEnvironment()
      : assertAuthenticatedCrmSalesComponentsEnvironment()
  const input = JSON.stringify(payload)
  if (Buffer.byteLength(input) > 750_000)
    throw new Error('Native snapshot exceeds the bounded component contract')
  return new Promise((resolve, reject) => {
    const child = spawn('python', ['-B', script], {
      shell: false,
      cwd: dirname(script),
      windowsHide: true,
      env: {
        NODE_ENV: runtime === 'local' ? 'development' : process.env.NODE_ENV,
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        PYTHONIOENCODING: 'utf-8',
        PYTHONDONTWRITEBYTECODE: '1',
        TORCHIKO_CRM_VAULT: process.env.TORCHIKO_CRM_VAULT,
        TORCHIKO_LOCAL_CRM_REHEARSAL:
          runtime === 'local' ? process.env.TORCHIKO_LOCAL_CRM_REHEARSAL : undefined,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = '',
      stderr = '',
      settled = false
    const fail = (message: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      reject(new Error(message))
    }
    const timer = setTimeout(
      () => fail('Local component preparation exceeded its bounded runtime'),
      15_000,
    )
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (part: string) => {
      stdout += part
      if (Buffer.byteLength(stdout) > 1_500_000) fail('Component result exceeds local output bound')
    })
    child.stderr.on('data', (part: string) => {
      stderr = (stderr + part).slice(-8_000)
    })
    child.on('error', () => fail('The installed local Python component bridge is unavailable'))
    child.stdin.on('error', () => fail('The component bridge input could not be written'))
    child.on('close', (code) => {
      if (settled) return
      clearTimeout(timer)
      try {
        const value: unknown = JSON.parse(stdout)
        if (code !== 0) {
          const error =
            value && typeof value === 'object' ? (value as Record<string, unknown>).error : null
          fail(typeof error === 'string' ? error : 'Local component failed without a usable result')
          return
        }
        const parsed = outputSchema.parse(value)
        if (parsed.nativeSnapshotHash !== payload.native.snapshotHash)
          throw new Error('Native snapshot binding mismatch')
        settled = true
        resolve(parsed)
      } catch {
        fail(
          stderr
            ? 'Local component returned an invalid result; inspect the local adapter test'
            : 'Invalid component result',
        )
      }
    })
    child.stdin.end(input)
  })
}
