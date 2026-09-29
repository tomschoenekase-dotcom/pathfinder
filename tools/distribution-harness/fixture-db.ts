import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { PrismaClient } from '@prisma/client'

type Scenario = 'launcher' | 'inline' | 'unadmitted' | 'revoke' | 'disabled' | 'paused'
type Fixture = {
  tenantId: string
  venueIds: Record<Scenario, string>
  originIds: Record<Scenario, string>
  slugs: Record<Scenario, string>
  admittedOrigins: Record<Scenario, string>
}

const dbUrl = process.env.DATABASE_URL
const manifestPath = process.env.TORCHIKO_DISTRIBUTION_FIXTURE_MANIFEST
const allowedScenarios: Scenario[] = [
  'launcher',
  'inline',
  'unadmitted',
  'revoke',
  'disabled',
  'paused',
]

function assertDisposableTarget() {
  if (!dbUrl || !manifestPath)
    throw new Error(
      'Set DATABASE_URL and TORCHIKO_DISTRIBUTION_FIXTURE_MANIFEST for the A5 fixture.',
    )
  const parsed = new URL(dbUrl)
  if (
    parsed.protocol !== 'postgresql:' ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '57905' ||
    parsed.pathname !== '/pathfinder_disposable_distribution_a5' ||
    parsed.search ||
    parsed.hash
  )
    throw new Error(
      'Refusing fixture write: A5 only accepts the task-owned loopback PostgreSQL database at port 57905 with its exact disposable name.',
    )
  const admittedOrigin = new URL(
    process.env.TORCHIKO_DISTRIBUTION_FIXTURE_ORIGIN ?? 'https://127.0.0.1:4174',
  )
  if (admittedOrigin.origin !== 'https://127.0.0.1:4174') {
    throw new Error(
      'A5 fixture origin must be the exact HTTPS second origin https://127.0.0.1:4174.',
    )
  }
  return { admittedOrigin: admittedOrigin.origin, manifestPath: resolve(manifestPath) }
}

function readControlToken(candidate: string | undefined, expected: string | undefined) {
  if (!candidate || !expected) return false
  const candidateBytes = Buffer.from(candidate)
  const expectedBytes = Buffer.from(expected)
  if (candidateBytes.length !== expectedBytes.length) return false
  return timingSafeEqual(candidateBytes, expectedBytes)
}

async function seed() {
  const { admittedOrigin, manifestPath: outputPath } = assertDisposableTarget()
  let manifestExists = false
  try {
    await access(outputPath)
    manifestExists = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    manifestExists = false
  }
  if (manifestExists)
    throw new Error(`Refusing to overwrite existing fixture manifest: ${outputPath}`)
  const prisma = new PrismaClient()
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
  const tenantId = `p7-a5-tenant-${suffix}`
  const planTier = `p7-a5-${suffix}`
  const slugs = Object.fromEntries(
    allowedScenarios.map((name) => [name, `${name}-p7-a5-${suffix}`]),
  ) as Record<Scenario, string>
  const venueIds = Object.fromEntries(
    allowedScenarios.map((name) => [name, `p7-a5-venue-${name}-${suffix}`]),
  ) as Record<Scenario, string>
  const originIds = Object.fromEntries(
    allowedScenarios.map((name) => [name, `p7-a5-origin-${name}-${suffix}`]),
  ) as Record<Scenario, string>
  const admittedOrigins = Object.fromEntries(
    allowedScenarios.map((name) => [
      name,
      name === 'unadmitted' ? 'https://localhost:4174' : admittedOrigin,
    ]),
  ) as Record<Scenario, string>

  try {
    await prisma.tenant.create({
      data: { id: tenantId, name: 'Synthetic Distribution P7 Tenant', slug: tenantId, planTier },
    })
    await prisma.productPlanCapability.createMany({
      data: ['widget', 'app-webview'].map((capability) => ({
        planTier,
        capability,
        enabled: true,
        createdBy: 'p7-a5-fixture',
        updatedBy: 'p7-a5-fixture',
      })),
    })

    for (const scenario of allowedScenarios) {
      const paused = scenario === 'paused'
      const disabled = scenario === 'disabled'
      await prisma.venue.create({
        data: {
          id: venueIds[scenario],
          tenantId,
          name: `Synthetic P7 ${scenario} venue`,
          slug: slugs[scenario],
          description: 'Fictional local-only venue used by the Distribution RC-1 proof harness.',
          aiGuideName: 'P7 Guide',
          chatTheme: 'dark',
          chatAccentColor: '#176F75',
          isActive: !paused,
        },
      })
      await prisma.venueDistribution.create({
        data: {
          tenantId,
          venueId: venueIds[scenario],
          websiteState: disabled ? 'DISABLED' : 'ENABLED',
          appState: 'ENABLED',
          updatedBy: 'p7-a5-fixture',
        },
      })
      await prisma.venueWebsiteOrigin.create({
        data: {
          id: originIds[scenario],
          tenantId,
          venueId: venueIds[scenario],
          origin: admittedOrigins[scenario],
          addedBy: 'p7-a5-fixture',
          addedReason: `Synthetic ${scenario} case for local browser proof.`,
        },
      })
    }

    const fixture: Fixture = { tenantId, venueIds, originIds, slugs, admittedOrigins }
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, { flag: 'wx' })
    console.log(
      `Seeded six synthetic A5 venue cases in the guarded disposable database. Fixture slugs: ${Object.values(slugs).join(', ')}`,
    )
    console.log(`Fixture manifest: ${outputPath}`)
  } finally {
    await prisma.$disconnect()
  }
}

async function serveControl() {
  const { manifestPath: sourcePath } = assertDisposableTarget()
  const token = process.env.TORCHIKO_DISTRIBUTION_CONTROL_TOKEN
  const port = Number(process.env.TORCHIKO_DISTRIBUTION_CONTROL_PORT ?? 4176)
  if (!token || token.length < 32 || port !== 4176)
    throw new Error(
      'Fixture control requires a 32+ character local token and exact loopback port 4176.',
    )
  const fixture = JSON.parse(await readFile(sourcePath, 'utf8')) as Fixture
  const prisma = new PrismaClient()
  await prisma.venueWebsiteOrigin.update({
    where: { id: fixture.originIds.revoke },
    data: { state: 'ACTIVE', revokedBy: null, revokedReason: null, revokedAt: null },
  })
  const server = createServer(async (request, response) => {
    if (request.url === '/health' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
      return
    }
    if (
      request.url !== '/__state' ||
      request.method !== 'POST' ||
      !readControlToken(request.headers.authorization, `Bearer ${token}`)
    ) {
      response.writeHead(404).end()
      return
    }
    let body = ''
    for await (const chunk of request) body += chunk
    const scenario = (JSON.parse(body) as { scenario?: Scenario }).scenario
    if (!scenario || !allowedScenarios.includes(scenario)) {
      response.writeHead(400).end('unknown fixture scenario')
      return
    }
    if (scenario === 'revoke') {
      await prisma.venueWebsiteOrigin.update({
        where: { id: fixture.originIds.revoke },
        data: {
          state: 'REVOKED',
          revokedBy: 'p7-a5-fixture',
          revokedReason: 'Synthetic TTL-expiry case.',
          revokedAt: new Date(),
        },
      })
    }
    if (scenario === 'disabled') {
      await prisma.venueDistribution.update({
        where: { venueId: fixture.venueIds.disabled },
        data: { websiteState: 'DISABLED' },
      })
    }
    if (scenario === 'paused') {
      await prisma.venue.update({
        where: { id: fixture.venueIds.paused },
        data: { isActive: false },
      })
    }
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ scenario, ok: true }))
  })
  server.on('close', () => void prisma.$disconnect())
  server.listen(port, '127.0.0.1', () =>
    console.log(
      `Local A5 fixture control: http://127.0.0.1:${port}; reset revoke scenario to ACTIVE`,
    ),
  )
}

async function main() {
  const command = process.argv[2] ?? 'seed'
  if (command === 'seed') await seed()
  else if (command === 'serve') await serveControl()
  else throw new Error('Use only `seed` or `serve`.')
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'A5 fixture command failed.')
  process.exitCode = 1
})
