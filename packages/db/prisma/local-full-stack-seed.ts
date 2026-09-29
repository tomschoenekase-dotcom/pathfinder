import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { renderVenueQrSvg } from '@pathfinder/contracts/venue-qr-svg'

const db = new PrismaClient()

const LOCAL_DATABASE = 'pathfinder_disposable_p14_local'
const tenants = [
  { id: 'org_LocalTenantA', slug: 'packet14-tenant-a', name: 'Packet 14 Tenant A' },
  { id: 'org_LocalTenantB', slug: 'packet14-tenant-b', name: 'Packet 14 Tenant B' },
] as const

const users = [
  {
    id: 'user_LocalAdmin',
    email: 'local-admin@torchiko.invalid',
    fullName: 'Local Platform Admin',
  },
  { id: 'user_LocalOwnerA', email: 'local-owner-a@torchiko.invalid', fullName: 'Local Owner A' },
  { id: 'user_LocalOwnerB', email: 'local-owner-b@torchiko.invalid', fullName: 'Local Owner B' },
] as const

const venues = [
  {
    id: 'cpacket14aurora0000000000',
    tenantId: 'org_LocalTenantA',
    name: 'Aurora Science Museum',
    slug: 'aurora-science-museum',
    category: 'MUSEUM',
    description:
      'A fictional science museum with hands-on exhibits about light, weather, and space.',
    guideNotes: 'Synthetic Packet 14 venue. Welcome curious visitors and explain exhibits plainly.',
    aiGuideNotes:
      'Synthetic fixture only. Mention the Aurora Lab when visitors ask what to see first.',
    chatTheme: 'default',
    chatAccentColor: '#2563EB',
    chatFont: 'jakarta',
    chatAppearance: { background: '#F8FAFC', accent: '#2563EB', synthetic: true },
  },
  {
    id: 'cpacket14pocket0000000000',
    tenantId: 'org_LocalTenantA',
    name: 'Pocket Collection Museum',
    slug: 'pocket-collection-museum',
    category: 'MUSEUM',
    description: 'A fictional small museum of everyday objects and the stories behind them.',
    guideNotes: 'Synthetic Packet 14 venue. Point visitors toward the Tiny Tools cabinet.',
    aiGuideNotes: 'Synthetic fixture only. Explain how a small collection can tell a large story.',
    chatTheme: 'paper',
    chatAccentColor: '#A855F7',
    chatFont: 'jakarta',
    chatAppearance: { background: '#FAF5FF', accent: '#A855F7', synthetic: true },
  },
  {
    id: 'cpacket14riverbend0000000',
    tenantId: 'org_LocalTenantB',
    name: 'Riverbend Nature Centre',
    slug: 'riverbend-nature-centre',
    category: 'NATURE_CENTRE',
    description:
      'A fictional nature centre with a riverside trail, bird hides, and a small wetland.',
    guideNotes: 'Synthetic Packet 14 venue. Keep directions accessible and family friendly.',
    aiGuideNotes: 'Synthetic fixture only. Mention the boardwalk and heron lookout as highlights.',
    chatTheme: 'default',
    chatAccentColor: '#15803D',
    chatFont: 'jakarta',
    chatAppearance: { background: '#F0FDF4', accent: '#15803D', synthetic: true },
  },
] as const

const knowledge = [
  {
    id: 'cpacket14knowaurora000000',
    venueId: 'cpacket14aurora0000000000',
    tenantId: 'org_LocalTenantA',
    title: 'Aurora Science Museum overview',
    category: 'visitor_info',
    content:
      'This fictional museum explores light, weather, and space. The Aurora Lab has interactive prism experiments.',
  },
  {
    id: 'cpacket14knowpocket000000',
    venueId: 'cpacket14pocket0000000000',
    tenantId: 'org_LocalTenantA',
    title: 'Pocket Collection Museum overview',
    category: 'visitor_info',
    content:
      'This fictional small collection museum displays everyday objects. The Tiny Tools cabinet is a visitor favorite.',
  },
  {
    id: 'cpacket14knowriverbend000',
    venueId: 'cpacket14riverbend0000000',
    tenantId: 'org_LocalTenantB',
    title: 'Riverbend Nature Centre overview',
    category: 'visitor_info',
    content:
      'This fictional nature centre has a riverside trail, bird hides, a wetland, and an accessible boardwalk.',
  },
] as const

// Invented analytics rows keep the admin visitor-speed readout deterministic in
// the local full-stack lane without making any visitor or provider calls.
function localVisitorSpeedEvents() {
  const now = Date.now()
  // AnalyticsEvent is append-only. Date-scoped IDs keep repeated local seeds
  // idempotent while giving a long-lived disposable stack fresh weekly samples.
  const day = new Date(now).toISOString().slice(0, 10).replaceAll('-', '')
  return [
    { id: `event_p14_local_aurora_speed_${day}_1`, requestFirstTextMs: 420, minutesAgo: 2 },
    { id: `event_p14_local_aurora_speed_${day}_2`, requestFirstTextMs: 780, minutesAgo: 5 },
  ].map(({ id, requestFirstTextMs, minutesAgo }) => ({
    id,
    tenantId: 'org_LocalTenantA',
    venueId: 'cpacket14aurora0000000000',
    eventType: 'message.received',
    metadata: { requestFirstTextMs, synthetic: true, fixture: 'packet14-local-full-stack' },
    occurredAt: new Date(now - minutesAgo * 60 * 1000),
  }))
}

// Entirely invented local CRM review data. These records deliberately have no
// contacts, activities, campaigns, drafts, or email history.
const crmTerritory = {
  id: 'territory_p14_synthetic_central',
  name: 'Packet 14 Synthetic Central',
  code: 'P14-SYNTH-CENTRAL',
  description: 'Invented territory used only for local Packet 14 CRM review.',
  region: 'Synthetic Test Region',
  createdBy: 'user_LocalAdmin',
  updatedBy: 'user_LocalAdmin',
} as const

const crmOrganizations = [
  {
    id: 'org_p14_synthetic_lantern',
    canonicalName: 'Lantern Field Museum Cooperative',
    normalizedName: 'lantern field museum cooperative',
    aliases: ['Lantern Field Museum'],
    organizationType: 'museum',
    description: 'Invented museum organization for local Good fit review.',
    headquartersCity: 'Example Junction',
    headquartersRegion: 'Synthetic Test Region',
    headquartersCountry: 'US',
    territoryId: crmTerritory.id,
    source: 'packet-14-synthetic-fixture',
    researchProvenance: [],
    createdBy: 'user_LocalAdmin',
    updatedBy: 'user_LocalAdmin',
  },
  {
    id: 'org_p14_synthetic_comet',
    canonicalName: 'Comet Bowl Stadium Group',
    normalizedName: 'comet bowl stadium group',
    aliases: [],
    organizationType: 'stadium_sports_venue',
    description: 'Invented stadium organization excluded from Good fit.',
    headquartersCity: 'Example Junction',
    headquartersRegion: 'Synthetic Test Region',
    headquartersCountry: 'US',
    territoryId: crmTerritory.id,
    source: 'packet-14-synthetic-fixture',
    researchProvenance: [],
    createdBy: 'user_LocalAdmin',
    updatedBy: 'user_LocalAdmin',
  },
] as const

const crmVenues = [
  {
    id: 'venue_p14_synthetic_lantern',
    organizationId: crmOrganizations[0].id,
    territoryId: crmTerritory.id,
    name: 'Lantern Field Museum',
    normalizedName: 'lantern field museum',
    venueType: 'museum',
    city: 'Example Junction',
    region: 'Synthetic Test Region',
    country: 'US',
    estimatedSize: 'M',
    fitAttributes: {
      torchikoSizeV1: {
        class: 'M',
        basis: 'annual_attendance',
        value: 120000,
        unit: 'visitors/year',
        sourceUrl: 'https://fixture.invalid/packet-14/lantern-size-evidence',
        observedAt: '2026-09-28',
        confidence: 'measured',
      },
      torchikoTriageV1: {
        normalizedType: 'museum',
        buyerAttainability: 'BUYER_MEDIUM_ATTAINABLE',
      },
      torchikoFounderPriorityV1: { bucket: 'MID_TIER_PRIORITY' },
    },
    researchSources: [{ kind: 'synthetic', label: 'Invented Packet 14 CRM fixture' }],
    createdBy: 'user_LocalAdmin',
    updatedBy: 'user_LocalAdmin',
  },
  {
    id: 'venue_p14_synthetic_comet',
    organizationId: crmOrganizations[1].id,
    territoryId: crmTerritory.id,
    name: 'Comet Bowl Stadium',
    normalizedName: 'comet bowl stadium',
    venueType: 'stadium_sports_venue',
    city: 'Example Junction',
    region: 'Synthetic Test Region',
    country: 'US',
    estimatedSize: 'XL',
    fitAttributes: {
      torchikoSizeV1: {
        class: 'XL',
        basis: 'capacity',
        value: 12000,
        unit: 'people',
        sourceUrl: 'https://fixture.invalid/packet-14/comet-size-evidence',
        observedAt: '2026-09-28',
        confidence: 'measured',
      },
      torchikoTriageV1: {
        normalizedType: 'stadium_sports_venue',
        buyerAttainability: 'BUYER_ENTERPRISE',
      },
      torchikoFounderPriorityV1: { bucket: 'ENTERPRISE_DEFER' },
    },
    researchSources: [{ kind: 'synthetic', label: 'Invented Packet 14 CRM fixture' }],
    createdBy: 'user_LocalAdmin',
    updatedBy: 'user_LocalAdmin',
  },
] as const

function assertLocalDatabaseTarget() {
  const raw = process.env.DATABASE_URL
  if (process.env.NODE_ENV === 'production')
    throw new Error('Local full-stack seed refuses production mode')
  if (!raw) throw new Error('DATABASE_URL is required for the local full-stack seed')
  const url = new URL(raw)
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.port !== '56340' ||
    url.pathname !== `/${LOCAL_DATABASE}` ||
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.VERCEL
  ) {
    throw new Error('Local full-stack seed target must be the exact Packet 14 loopback database')
  }
}

async function writeAndVerifyVenueQrs() {
  const dataRoot = process.env.TORCHIKO_LOCAL_FULL_STACK_DATA_DIR
  const qrDirectory = process.env.TORCHIKO_LOCAL_FULL_STACK_QR_DIR
  if (!dataRoot || !path.isAbsolute(dataRoot) || !qrDirectory || !path.isAbsolute(qrDirectory)) {
    throw new Error('Lane-owned absolute data and QR output paths are required')
  }
  const expectedDirectory = path.join(path.resolve(dataRoot), 'venue-qrs')
  if (path.resolve(qrDirectory) !== expectedDirectory) {
    throw new Error('QR output directory must be the exact venue-qrs child of lane-owned data')
  }
  await mkdir(expectedDirectory, { recursive: true })
  const directoryStat = await lstat(expectedDirectory)
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    (await realpath(expectedDirectory)) !== expectedDirectory
  ) {
    throw new Error('QR output directory must be a canonical local directory')
  }

  for (const venue of venues) {
    const publicUrl = `http://127.0.0.1:56345/${venue.slug}/chat?source=qr`
    const svgPath = path.join(expectedDirectory, `${venue.slug}.svg`)
    const expectedSvg = renderVenueQrSvg(publicUrl)
    const existing = await lstat(svgPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
      throw new Error(`Synthetic venue QR output is not a regular file: ${venue.slug}`)
    }
    await writeFile(svgPath, expectedSvg, { encoding: 'utf8', flag: 'w' })
    const actualSvg = await readFile(svgPath, 'utf8')
    if (
      actualSvg !== expectedSvg ||
      !actualSvg.startsWith('<svg ') ||
      !actualSvg.includes('shape-rendering="crispEdges"')
    ) {
      throw new Error(`Synthetic venue QR readback failed: ${venue.slug}`)
    }
  }
  return venues.length
}

async function main() {
  assertLocalDatabaseTarget()
  console.log(`Seeding invented Packet 14 fixtures into ${LOCAL_DATABASE}.`)

  for (const tenant of tenants) {
    await db.tenant.upsert({ where: { id: tenant.id }, update: tenant, create: tenant })
  }
  for (const user of users) {
    await db.user.upsert({ where: { id: user.id }, update: user, create: user })
  }

  for (const [tenantId, userId] of [
    ['org_LocalTenantA', 'user_LocalOwnerA'],
    ['org_LocalTenantB', 'user_LocalOwnerB'],
  ] as const) {
    await db.tenantMembership.upsert({
      where: { tenantId_userId: { tenantId, userId } },
      update: { role: 'OWNER', status: 'ACTIVE', joinedAt: new Date() },
      create: { tenantId, userId, role: 'OWNER', status: 'ACTIVE', joinedAt: new Date() },
    })
  }

  await db.prospectTerritory.upsert({
    where: { id: crmTerritory.id },
    update: crmTerritory,
    create: crmTerritory,
  })
  for (const organization of crmOrganizations) {
    await db.prospectOrganization.upsert({
      where: { id: organization.id },
      update: organization,
      create: organization,
    })
  }
  for (const venue of crmVenues) {
    await db.prospectVenue.upsert({ where: { id: venue.id }, update: venue, create: venue })
  }
  const crmVenueReadback = await db.prospectVenue.findMany({
    where: { id: { in: crmVenues.map(({ id }) => id) } },
    select: { id: true, estimatedSize: true, fitAttributes: true, territoryId: true },
  })
  if (
    crmVenueReadback.length !== crmVenues.length ||
    crmVenueReadback.find(({ id }) => id === crmVenues[0].id)?.estimatedSize !== 'M' ||
    crmVenueReadback.find(({ id }) => id === crmVenues[1].id)?.estimatedSize !== 'XL' ||
    crmVenueReadback.some(({ territoryId }) => territoryId !== crmTerritory.id)
  ) {
    throw new Error('Packet 14 synthetic CRM fixture readback did not match its manifest')
  }
  console.log(
    'Seeded synthetic CRM Good fit candidate and excluded XL stadium; no outreach activity was created.',
  )

  for (const venueSeed of venues) {
    const { id, tenantId } = venueSeed
    const venue = await db.venue.upsert({
      where: { tenantId_slug: { tenantId, slug: venueSeed.slug } },
      update: venueSeed,
      create: venueSeed,
    })
    if (venue.id !== id) throw new Error(`Fixture venue identity drift: ${venueSeed.slug}`)
    const ownerId = tenantId === 'org_LocalTenantA' ? 'user_LocalOwnerA' : 'user_LocalOwnerB'
    await db.venueBotConfiguration.upsert({
      where: { tenantId_venueId: { tenantId, venueId: venue.id } },
      update: {
        presentationMode: 'CLASSIC',
        personalityMode: 'PRESET',
        tonePreset: 'friendly',
        publicDisplayName: `Guide to ${venue.name}`,
        greeting: `Welcome to ${venue.name}. What would you like to explore?`,
        updatedBy: ownerId,
      },
      create: {
        tenantId,
        venueId: venue.id,
        presentationMode: 'CLASSIC',
        personalityMode: 'PRESET',
        tonePreset: 'friendly',
        publicDisplayName: `Guide to ${venue.name}`,
        greeting: `Welcome to ${venue.name}. What would you like to explore?`,
        createdBy: ownerId,
        updatedBy: ownerId,
      },
    })
    for (const entry of knowledge.filter((item) => item.venueId === venue.id)) {
      await db.venueKnowledgeEntry.upsert({
        where: { id: entry.id },
        update: entry,
        create: entry,
      })
    }
    console.log(
      `Seeded synthetic venue ${venue.slug}; guide=${venue.slug}; qr=http://127.0.0.1:56345/${venue.slug}/chat?source=qr`,
    )
  }

  const visitorSpeedEvents = localVisitorSpeedEvents()
  await db.analyticsEvent.createMany({ data: visitorSpeedEvents, skipDuplicates: true })
  const visitorSpeedReadback = await db.analyticsEvent.findMany({
    where: { id: { in: visitorSpeedEvents.map(({ id }) => id) } },
    select: {
      id: true,
      tenantId: true,
      venueId: true,
      eventType: true,
      metadata: true,
      occurredAt: true,
    },
  })
  const speedManifest = new Map(visitorSpeedEvents.map((event) => [event.id, event]))
  if (
    visitorSpeedReadback.length !== visitorSpeedEvents.length ||
    visitorSpeedReadback.some(
      (event) =>
        !speedManifest.has(event.id) ||
        event.tenantId !== 'org_LocalTenantA' ||
        event.venueId !== 'cpacket14aurora0000000000' ||
        event.eventType !== 'message.received' ||
        typeof event.metadata !== 'object' ||
        event.metadata === null ||
        !('requestFirstTextMs' in event.metadata) ||
        event.metadata.requestFirstTextMs !==
          speedManifest.get(event.id)?.metadata.requestFirstTextMs ||
        event.occurredAt.getTime() < Date.now() - 7 * 24 * 60 * 60 * 1000,
    )
  ) {
    throw new Error('Packet 14 synthetic visitor speed fixture readback did not match its manifest')
  }
  console.log('Seeded two synthetic visitor speed samples for Aurora Science Museum.')

  const verifiedQrCount = await writeAndVerifyVenueQrs()

  const memberships = await db.tenantMembership.count({
    where: { userId: { in: ['user_LocalOwnerA', 'user_LocalOwnerB'] }, status: 'ACTIVE' },
  })
  const venueCount = await db.venue.count({
    where: { tenantId: { in: tenants.map(({ id }) => id) } },
  })
  const knowledgeCount = await db.venueKnowledgeEntry.count({
    where: { tenantId: { in: tenants.map(({ id }) => id) } },
  })
  if (memberships !== 2 || venueCount !== 3 || knowledgeCount !== 3)
    throw new Error('Packet 14 seed readback did not match its synthetic fixture manifest')
  console.log(
    `Seed readback passed: ${memberships} owner memberships, ${venueCount} venues, ${knowledgeCount} knowledge entries, ${verifiedQrCount} QR SVG files.`,
  )
}

main()
  .catch((error) => {
    console.error('Local full-stack seed failed.', error)
    process.exitCode = 1
  })
  .finally(async () => db.$disconnect())
