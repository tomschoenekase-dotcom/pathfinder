import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

// @ts-expect-error Independently tested local ESM boundary.
import { assertLocalProspectImportEnvironment } from './prospect-import-environment.mjs'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
async function main() {
  const args = process.argv.slice(2)
  const option = (name: string) => {
    const index = args.indexOf(name)
    if (index < 0 || !args[index + 1]) throw new Error(`Required: ${name}`)
    return path.resolve(args[index + 1]!)
  }
  assertLocalProspectImportEnvironment(process.env)
  const dbReceipt = JSON.parse(await readFile(option('--readback'), 'utf8'))
  if (!dbReceipt.passed || dbReceipt.counts.organizations !== 16725)
    throw new Error('Complete native readback is required first')
  const { createLocalProspectResearchReader } =
    await import('../packages/api/src/prospect-research-reader')
  const { adminProspectCrmDirectoryRouter } =
    await import('../packages/api/src/routers/admin/prospect-crm-directory')
  const { adminProspectCrmCoreRouter } =
    await import('../packages/api/src/routers/admin/prospect-crm-core')
  const { db } = await import('../packages/db/src/client')
  let checks = 0
  const failures: string[] = []
  const check = (condition: boolean, label: string) => {
    checks += 1
    if (!condition && failures.length < 30) failures.push(label)
  }
  const reject = async (operation: () => Promise<unknown>, label: string) => {
    try {
      await operation()
      check(false, label)
    } catch {
      check(true, label)
    }
  }
  try {
    const reader = createLocalProspectResearchReader()
    const authorities = [
      { userId: null, isPlatformAdmin: false },
      { userId: 'tenant-only-test', isPlatformAdmin: false },
    ]
    for (const authority of authorities) {
      const context = {
        db,
        headers: new Headers(),
        session: { ...authority, activeTenantId: null, role: null },
      }
      await reject(
        () => adminProspectCrmDirectoryRouter.createCaller(context).listProspects({}),
        `directory rejects ${authority.userId ?? 'anonymous'}`,
      )
      await reject(
        () =>
          adminProspectCrmCoreRouter
            .createCaller(context)
            .getProspect({ organizationId: dbReceipt.examples[0].organizationId }),
        `detail rejects ${authority.userId ?? 'anonymous'}`,
      )
    }
    await reject(
      () => reader.list({ tenantId: 'client-supplied-authority' } as never),
      'strict directory input rejects tenant authority',
    )
    await reject(
      () =>
        reader.detail({
          organizationId: dbReceipt.examples[0].organizationId,
          tenantId: 'other',
        } as never),
      'strict detail input rejects tenant authority',
    )
    await reject(() => reader.list({ cursor: 'not-a-valid-cursor' }), 'invalid cursor is rejected')
    await reject(
      () => reader.detail({ organizationId: 'porg_000000000000000000000000' }),
      'unknown prospect is not found',
    )
    const territories = await reader.territories()
    check(territories.length === 85, 'all territory names available to the real directory')
    const territoryResults = []
    for (const territory of territories) {
      const page = await reader.list({ territoryId: territory.id, limit: 3 })
      check(
        page.totalCount === dbReceipt.territoryCounts[territory.name],
        `territory count ${territory.name}`,
      )
      check(
        page.items.every((row) => row.territory?.id === territory.id),
        `territory membership ${territory.name}`,
      )
      territoryResults.push({ name: territory.name, id: territory.id, count: page.totalCount })
    }
    const scenarios = [
      {
        name: 'recorded contacts (including title/phone)',
        input: { contactState: 'RECORDED' as const },
        expected: 6183,
      },
      { name: 'missing contacts', input: { contactState: 'MISSING' as const }, expected: 10542 },
      {
        name: 'unknown contact review',
        input: { contactState: 'REVIEW_NEEDED' as const },
        expected: 6183,
      },
      {
        name: 'no inferred contact permission',
        input: { emailReadiness: 'READY' as const },
        expected: 0,
      },
      {
        name: 'no suppression invented',
        input: { contactState: 'SUPPRESSED' as const },
        expected: 0,
      },
      { name: 'direct websites', input: { websiteState: 'RECORDED' as const }, expected: 14804 },
      { name: 'missing websites', input: { websiteState: 'MISSING' as const }, expected: 1921 },
      { name: 'import provenance', input: { provenance: 'IMPORTED' as const }, expected: 16725 },
      {
        name: 'recorded source URLs',
        input: { provenance: 'SOURCE_URL_RECORDED' as const },
        expected: 15197,
      },
      {
        name: 'no invented website research',
        input: { provenance: 'WEB_EVIDENCE' as const },
        expected: 0,
      },
      {
        name: 'no lost source evidence',
        input: { provenance: 'NO_EVIDENCE' as const },
        expected: 0,
      },
      { name: 'empty search', input: { search: 'NO-MATCH-CRM-ACCEPTANCE-8d02d26d' }, expected: 0 },
    ]
    const filterResults = []
    for (const scenario of scenarios) {
      const page = await reader.list({ ...scenario.input, limit: 3 })
      check(
        page.totalCount === scenario.expected,
        `filter ${scenario.name}: ${page.totalCount} vs ${scenario.expected}`,
      )
      filterResults.push({ ...scenario, actual: page.totalCount })
    }
    const core = await reader.list({ completeness: 'CORE_PRESENT', limit: 1 })
    const missing = await reader.list({ completeness: 'NEEDS_RESEARCH', limit: 1 })
    check(
      core.totalCount + missing.totalCount === 16725,
      'coverage filters partition the directory without silent loss',
    )
    const combined = await reader.list({
      contactState: 'MISSING',
      completeness: 'CORE_PRESENT',
      limit: 1,
    })
    check(
      combined.totalCount === 0,
      'contradictory filters combine rather than overwriting each other',
    )
    const pagination = []
    let previousIds: Set<string> | undefined
    for (const sort of ['UPDATED', 'NAME_ASC', 'NAME_DESC'] as const) {
      const seen = new Set<string>()
      const cursors = new Set<string>()
      const ids: string[] = []
      let cursor: string | undefined
      let pages = 0
      do {
        const result = await reader.list({ sort, limit: 100, ...(cursor ? { cursor } : {}) })
        pages += 1
        check(result.totalCount === 16725, `${sort} total retained on page ${pages}`)
        check(
          result.items.length > 0 && result.items.length <= 100,
          `${sort} bounded nonempty page ${pages}`,
        )
        for (const row of result.items) {
          check(!seen.has(row.id), `${sort} unique cursor row ${row.id}`)
          seen.add(row.id)
          ids.push(row.id)
        }
        cursor = result.nextCursor ?? undefined
        if (cursor) {
          if (cursors.has(cursor)) throw new Error('Cursor loop detected')
          cursors.add(cursor)
        }
        if (pages > 170) throw new Error('Pagination exceeded the canonical row bound')
      } while (cursor)
      check(seen.size === 16725, `${sort} complete cursor traversal`)
      if (previousIds)
        check(
          [...previousIds].every((id) => seen.has(id)),
          `${sort} same stable IDs across sort modes`,
        )
      previousIds = seen
      pagination.push({
        sort,
        pages,
        rows: seen.size,
        orderedIdSha256: createHash('sha256').update(ids.join('\n')).digest('hex'),
      })
      process.stdout.write(`${JSON.stringify({ pagination: pagination.at(-1) })}\n`)
    }
    const examples = [
      ...dbReceipt.ownerOnly,
      ...dbReceipt.contactWithoutUrl,
      ...dbReceipt.examples.slice(0, 5),
    ]
    const details = []
    for (const example of examples) {
      const found = await reader.list({
        search: example.name,
        territoryId: territories.find((row) => row.name === example.territory)?.id,
        limit: 100,
      })
      check(
        found.items.some((row) => row.id === example.organizationId),
        `name search ${example.name}`,
      )
      const detail = await reader.detail({ organizationId: example.organizationId })
      check(detail.importHistory.length >= 2, `native import history ${example.name}`)
      check(detail.sources.length >= 1, `source evidence ${example.name}`)
      check(
        detail.contacts.every(
          (contact) =>
            contact.permissionState === 'UNKNOWN' && contact.emailReadiness === 'UNKNOWN',
        ),
        `detail contact unknowns ${example.name}`,
      )
      check(
        detail.importHistory.every(
          (row) => object(object(row.rawPayload)._source).sheetName === example.territory,
        ),
        `native sheet lineage ${example.name}`,
      )
      check(
        detail.importHistory.every((row) => row.import.packageHash === dbReceipt.packageHash),
        `exact package lineage ${example.name}`,
      )
      details.push({
        name: example.name,
        organizationId: detail.id,
        territory: detail.territory?.name,
        contacts: detail.contacts.length,
        sourceEvidence: detail.sources.length,
        importHistory: detail.importHistory.length,
      })
    }
    const receipt = {
      schema: 'torchiko.local-crm-api-acceptance/v1',
      observedAt: new Date().toISOString(),
      passed: failures.length === 0,
      checks,
      failures,
      sourceHash: dbReceipt.sourceSha256,
      packageHash: dbReceipt.packageHash,
      territories: territoryResults,
      filters: filterResults,
      coverage: { core: core.totalCount, needsResearch: missing.totalCount },
      pagination,
      details,
      boundary:
        'Actual adminProcedure routers; anonymous/tenant-only callers denied. Development adapter exposes reads only against exact retained loopback DB.',
    }
    await writeFile(option('--receipt'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' })
    process.stdout.write(
      `${JSON.stringify({ passed: receipt.passed, checks, failures, pagination }, null, 2)}\n`,
    )
    if (failures.length) process.exitCode = 1
  } finally {
    await db.$disconnect()
  }
}
void main().catch((error) => {
  process.stderr.write(
    `${(error instanceof Error ? error.message : 'API acceptance failed').replace(/postgres(?:ql)?:\/\/[^\s]+/gu, '[redacted database URL]')}\n`,
  )
  process.exitCode = 1
})
