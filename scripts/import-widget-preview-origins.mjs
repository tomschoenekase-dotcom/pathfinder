const MAX_POLICY_BYTES = 16_384
const MAX_VENUES = 100
const MAX_ORIGINS_PER_VENUE = 20
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

function readPolicy(raw) {
  if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_POLICY_BYTES) {
    throw new Error('WIDGET_PREVIEW_ORIGINS_JSON is missing or exceeds 16 KiB.')
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('WIDGET_PREVIEW_ORIGINS_JSON must contain valid JSON.')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('WIDGET_PREVIEW_ORIGINS_JSON must be an object keyed by venue slug.')
  }
  const entries = Object.entries(parsed)
  if (entries.length > MAX_VENUES) throw new Error(`At most ${MAX_VENUES} venues can be imported.`)
  return entries.map(([slug, values]) => {
    if (!SLUG_PATTERN.test(slug) || slug.length > 200 || !Array.isArray(values) || values.length > MAX_ORIGINS_PER_VENUE) {
      throw new Error(`Invalid venue/origin list for slug "${slug}".`)
    }
    const normalized = values.map((origin) => {
      if (typeof origin !== 'string' || origin.length > 255 || origin.trim() !== origin || /[^\x21-\x7e]/u.test(origin) || origin.includes('*') || !/^https:\/\//iu.test(origin)) {
        throw new Error(`Invalid exact HTTPS origin for slug "${slug}".`)
      }
      let url
      try { url = new URL(origin) } catch { throw new Error(`Invalid exact HTTPS origin for slug "${slug}".`) }
      const authorityAndPath = origin.slice(origin.indexOf('://') + 3)
      const authority = authorityAndPath.endsWith('/') ? authorityAndPath.slice(0, -1) : authorityAndPath
      if (url.protocol !== 'https:' || url.hostname.includes('*') || /[/?#]/u.test(authority) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new Error(`Invalid exact HTTPS origin for slug "${slug}".`)
      }
      return url.origin
    })
    return { slug, origins: [...new Set(normalized)].sort() }
  })
}

const policy = readPolicy(process.env.WIDGET_PREVIEW_ORIGINS_JSON)
const write = process.argv.includes('--write')
const unexpectedArguments = process.argv.slice(2).filter((argument) => argument !== '--write')
if (unexpectedArguments.length) throw new Error(`Unexpected arguments: ${unexpectedArguments.join(', ')}`)

if (!write) {
  const originCount = policy.reduce((count, item) => count + item.origins.length, 0)
  console.log(JSON.stringify({ mode: 'dry-run', venueCount: policy.length, originCount, policy }, null, 2))
  process.exit(0)
}

const databaseUrl = process.env.DATABASE_URL
let databaseHost
try { databaseHost = new URL(databaseUrl).hostname } catch { throw new Error('Set DATABASE_URL to a local disposable database before --write.') }
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(databaseHost) ||
  process.env.RAILWAY_ENVIRONMENT === 'production' ||
  process.env.MACHINE_WORKSPACE_DISTRIBUTION_IMPORT_LOCAL_DB !== 'true'
) {
  throw new Error('Refusing --write: require a loopback DATABASE_URL and MACHINE_WORKSPACE_DISTRIBUTION_IMPORT_LOCAL_DB=true. Hosted databases are not supported.')
}

const { db, normalizeVenueWebsiteOrigin, resolveVenueDistribution, writeAuditLogStrict } = await import('@pathfinder/db')
let imported = 0
let unchanged = 0
try {
  for (const item of policy) {
    for (const value of item.origins) {
      if (normalizeVenueWebsiteOrigin(value) !== value) throw new Error(`Origin normalization mismatch for ${item.slug}.`)
    }
    const resolved = await resolveVenueDistribution({ client: db, venueSlug: item.slug })
    if (!resolved) throw new Error(`Venue "${item.slug}" is missing or ambiguous.`)
    await db.$transaction(async (tx) => {
      let added = 0
      for (const origin of item.origins) {
        const existing = await tx.venueWebsiteOrigin.findFirst({
          where: { tenantId: resolved.tenantId, venueId: resolved.venueId, origin, state: 'ACTIVE' },
          select: { id: true },
        })
        if (existing) {
          unchanged += 1
          continue
        }
        const activeCount = await tx.venueWebsiteOrigin.count({
          where: { tenantId: resolved.tenantId, venueId: resolved.venueId, state: 'ACTIVE' },
        })
        if (activeCount >= MAX_ORIGINS_PER_VENUE) throw new Error(`Venue "${item.slug}" already has 20 active origins.`)
        const created = await tx.venueWebsiteOrigin.create({
          data: {
            tenantId: resolved.tenantId,
            venueId: resolved.venueId,
            origin,
            addedBy: 'system:widget-preview-origins-import',
            addedReason: 'imported from staging env policy',
          },
          select: { id: true },
        })
        await writeAuditLogStrict({
          tenantId: resolved.tenantId,
          actorId: 'system:widget-preview-origins-import',
          actorRole: 'SYSTEM',
          actorType: 'SYSTEM',
          action: 'admin.venue-distribution.origin.imported',
          targetType: 'VenueWebsiteOrigin',
          targetId: created.id,
          afterState: { origin, reason: 'imported from staging env policy' },
        }, tx)
        added += 1
        imported += 1
      }
      const current = await tx.venueDistribution.findFirst({
        where: { tenantId: resolved.tenantId, venueId: resolved.venueId },
        select: { revision: true },
      })
      if (!current) {
        await tx.venueDistribution.create({
          data: { tenantId: resolved.tenantId, venueId: resolved.venueId, updatedBy: 'system:widget-preview-origins-import' },
        })
      } else if (added > 0) {
        await tx.venueDistribution.updateMany({
          where: { tenantId: resolved.tenantId, venueId: resolved.venueId, revision: current.revision },
          data: { revision: { increment: 1 }, updatedBy: 'system:widget-preview-origins-import' },
        })
      }
    })
  }
  console.log(JSON.stringify({ mode: 'write', imported, unchanged, venueCount: policy.length }, null, 2))
} finally {
  await db.$disconnect()
}
