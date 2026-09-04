import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3'
import { connect } from 'node:net'

import {
  recordServiceDependencyObservation,
  recordWorkerHeartbeat,
  type ServiceDependencyStatus,
} from '@pathfinder/db'

export const SERVICE_DEPENDENCY_PROBE_TIMEOUT_MS = 1_500
const MALWARE_SCANNER_PROBE_MAX_RESPONSE_BYTES = 128

export function appendBoundedScannerProbeResponse(response: string, chunk: string): string {
  if (
    Buffer.byteLength(response, 'utf8') + Buffer.byteLength(chunk, 'utf8') >
    MALWARE_SCANNER_PROBE_MAX_RESPONSE_BYTES
  ) {
    throw new Error('malware scanner probe response exceeded its byte limit')
  }
  return response + chunk
}

export type ProbeEnvironment = {
  STORAGE_BUCKET?: string | undefined
  STORAGE_REGION?: string | undefined
  STORAGE_ENDPOINT?: string | undefined
  STORAGE_ACCESS_KEY_ID?: string | undefined
  STORAGE_SECRET_ACCESS_KEY?: string | undefined
  INTAKE_CLAMAV_HOST?: string | undefined
  INTAKE_CLAMAV_PORT?: number | undefined
  INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED: boolean
}

export function resolveServiceDependencyProbeEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): ProbeEnvironment {
  const rawScannerPort = environment.INTAKE_CLAMAV_PORT
  const scannerPort =
    rawScannerPort && /^\d+$/u.test(rawScannerPort)
      ? Number.parseInt(rawScannerPort, 10)
      : undefined

  return {
    STORAGE_BUCKET: environment.STORAGE_BUCKET,
    STORAGE_REGION: environment.STORAGE_REGION,
    STORAGE_ENDPOINT: environment.STORAGE_ENDPOINT,
    STORAGE_ACCESS_KEY_ID: environment.STORAGE_ACCESS_KEY_ID,
    STORAGE_SECRET_ACCESS_KEY: environment.STORAGE_SECRET_ACCESS_KEY,
    INTAKE_CLAMAV_HOST: environment.INTAKE_CLAMAV_HOST,
    INTAKE_CLAMAV_PORT:
      scannerPort !== undefined && scannerPort >= 1 && scannerPort <= 65_535
        ? scannerPort
        : undefined,
    INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED:
      environment.INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED === 'true',
  }
}

type Probe = (signal: AbortSignal) => Promise<void>

async function boundedStatus(configured: boolean, probe: Probe): Promise<ServiceDependencyStatus> {
  if (!configured) return 'unconfigured'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SERVICE_DEPENDENCY_PROBE_TIMEOUT_MS)
  timer.unref?.()
  try {
    await Promise.race([
      probe(controller.signal),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(new Error('service dependency probe timed out')),
          { once: true },
        )
      }),
    ])
    return 'up'
  } catch {
    return 'down'
  } finally {
    clearTimeout(timer)
  }
}

function complete(values: Array<string | number | undefined>) {
  return values.every((value) => value !== undefined && value !== '')
}

export async function probeWorkerServiceDependencies(
  environment: ProbeEnvironment,
  dependencies: { objectStorage?: Probe; malwareScanner?: Probe } = {},
) {
  const storageConfigured = complete([
    environment.STORAGE_BUCKET,
    environment.STORAGE_REGION,
    environment.STORAGE_ACCESS_KEY_ID,
    environment.STORAGE_SECRET_ACCESS_KEY,
  ])
  const scannerConfigured = complete([
    environment.INTAKE_CLAMAV_HOST,
    environment.INTAKE_CLAMAV_PORT,
  ])

  const [objectStorage, malwareScanner] = await Promise.all([
    boundedStatus(
      storageConfigured,
      dependencies.objectStorage ??
        (async (signal) => {
          const storage = new S3Client({
            region: environment.STORAGE_REGION!,
            credentials: {
              accessKeyId: environment.STORAGE_ACCESS_KEY_ID!,
              secretAccessKey: environment.STORAGE_SECRET_ACCESS_KEY!,
            },
            ...(environment.STORAGE_ENDPOINT
              ? { endpoint: environment.STORAGE_ENDPOINT, forcePathStyle: true }
              : {}),
          })
          try {
            await storage.send(new HeadBucketCommand({ Bucket: environment.STORAGE_BUCKET! }), {
              abortSignal: signal,
            })
          } finally {
            storage.destroy()
          }
        }),
    ),
    boundedStatus(
      scannerConfigured,
      dependencies.malwareScanner ??
        ((signal) =>
          new Promise<void>((resolve, reject) => {
            const socket = connect({
              host: environment.INTAKE_CLAMAV_HOST!,
              port: environment.INTAKE_CLAMAV_PORT!,
            })
            let response = ''
            let settled = false
            const finish = (error?: Error) => {
              if (settled) return
              settled = true
              signal.removeEventListener('abort', fail)
              socket.destroy()
              if (error) reject(error)
              else resolve()
            }
            const fail = () => finish(new Error('malware scanner probe failed'))
            signal.addEventListener('abort', fail, { once: true })
            socket.setEncoding('utf8')
            socket.once('connect', () => socket.write('zPING\0'))
            socket.on('data', (chunk: string) => {
              try {
                response = appendBoundedScannerProbeResponse(response, chunk)
              } catch {
                return finish(new Error('malware scanner probe returned an invalid response'))
              }
              if (response.includes('\0') || response.includes('\n')) {
                if (response.replaceAll('\0', '').trim() === 'PONG') finish()
                else finish(new Error('malware scanner probe returned an invalid response'))
              }
            })
            socket.once('error', fail)
            socket.once('close', () => {
              if (!settled) fail()
            })
          })),
    ),
  ])

  return {
    intakeVerificationRequired: environment.INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED,
    objectStorage,
    malwareScanner,
  }
}

export async function recordOperationalReadinessHeartbeat(
  input: {
    mode: 'provider-enabled' | 'provider-disabled'
    schedulersEnabled: boolean
    revision: string
    environment: ProbeEnvironment
    now?: Date
  },
  dependencies: {
    probe?: typeof probeWorkerServiceDependencies
    recordWorker?: typeof recordWorkerHeartbeat
    recordServices?: typeof recordServiceDependencyObservation
  } = {},
) {
  const services = await (dependencies.probe ?? probeWorkerServiceDependencies)(input.environment)
  await Promise.all([
    (dependencies.recordWorker ?? recordWorkerHeartbeat)({
      mode: input.mode,
      schedulersEnabled: input.schedulersEnabled,
      revision: input.revision,
      ...(input.now ? { now: input.now } : {}),
    }),
    (dependencies.recordServices ?? recordServiceDependencyObservation)({
      ...services,
      ...(input.now ? { now: input.now } : {}),
    }),
  ])
  return services
}
