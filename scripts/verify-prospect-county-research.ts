/** Only the fresh database created and identified by the paired runner may host
 * these synthetic records and explicitly injected test-only human authorities. */
import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? ''),
    database = process.env.COUNTY_SYNTHETIC_DATABASE ?? '',
    runId = process.env.COUNTY_SYNTHETIC_RUN_ID ?? '',
    output = process.env.COUNTY_SYNTHETIC_OUTPUT ?? ''
  assert.equal(process.env.NODE_ENV, 'test')
  assert.match(runId, /^[a-f0-9-]{36}$/u)
  assert.equal(database, `pathfinder_disposable_county_${runId.replaceAll('-', '').slice(0, 12)}`)
  assert.equal(url.hostname, '127.0.0.1')
  assert.equal(url.port, process.env.COUNTY_SYNTHETIC_PORT)
  assert.ok(!['5432', '58617'].includes(url.port))
  assert.equal(url.pathname, `/${database}`)
  assert.equal(url.search, '')
  assert.ok(output.includes('integration-r003'))
  const {
    db,
    withTenantIsolationBypass,
    installProspectGeographyModel,
    PROSPECT_GEOGRAPHY_VERSION,
    PROSPECT_GEOGRAPHY_HASH,
    claimCountyResearch,
    renewCountyResearch,
    releaseCountyResearch,
    completeCountyResearch,
    readCountyResearch,
    submitCountyDiscovery,
    readCountyDiscoveries,
    decideCountyDiscovery,
    proposeProspectGeography,
    resolveProspectGeographyProposal,
    listProspectGeographyProposals,
    invalidateProspectGeography,
    readProspectPhysicalGeography,
  } = await import('../packages/db/src/index')
  const checks: string[] = []
  const ok = (label: string, value: unknown) => {
    assert.ok(value, label)
    checks.push(label)
  }
  const rejected = async (label: string, work: () => Promise<unknown>) => {
    await assert.rejects(work, undefined, label)
    checks.push(label)
  }
  const system = {
    id: 'SYN-county-worker-A',
    runId: `SYN-${runId}`,
    type: 'SYSTEM' as const,
    scope: { mode: 'ALL' as const },
    capabilities: ['prospects.read', 'prospects.maintain', 'prospects.research'],
    authorityContext: 'synthetic-only-new-database',
  }
  const workerB = { ...system, id: 'SYN-county-worker-B' }
  const human = { ...system, id: 'SYN-INJECTED-HUMAN-NOT-TOM', type: 'HUMAN' as const }
  const today = new Date().toISOString().slice(0, 10)
  const evidence = (countyGeoid = '17031', address = '123 Example Avenue, Chicago, IL 60601') => ({
    countyGeoid,
    state: 'IL' as const,
    countyVintage: '2025 Census Gazetteer' as const,
    physicalAddress: address,
    anchorKind: 'PHYSICAL_STREET_ADDRESS' as const,
    method: 'OFFICIAL_PHYSICAL_COUNTY' as const,
    addressSourceUrl: 'https://museum.example.org/visit',
    countySourceUrl: 'https://county.example.org/property',
    addressQuote: 'Synthetic physical visitor address; not real geography evidence.',
    countyQuote: 'Synthetic county evidence in an isolated test database only.',
    observedAt: today,
    sourceResultHash: 'a'.repeat(64),
    uncertain: false,
    conflicting: false,
  })
  const candidate = (
    name = 'SYN Example Museum',
    address = '123 Example Avenue',
    countyGeoid = '17031',
  ) => ({
    name,
    website: 'https://parent.example.org/museum',
    websiteQuote: 'Synthetic site-specific identity source, not a real finding.',
    category: 'Museum',
    categoryQuote: 'Synthetic visitor-site category source, not real research.',
    address: { line1: address, city: 'Chicago', postalCode: '60601' },
    physicalEvidence: evidence(countyGeoid, `${address}, Chicago, IL 60601`),
    publicContactRoutes: [
      {
        kind: 'EMAIL' as const,
        value: 'public@example.org',
        sourceUrl: 'https://parent.example.org/contact',
        quote: 'Synthetic public email evidence does not establish permission.',
      },
    ],
  })
  const base = { expectedRegistryHash: PROSPECT_GEOGRAPHY_HASH, countyGeoid: '17031' }
  const plan = [
    {
      id: 'museums',
      locality: 'Synthetic test locality',
      category: 'Museum',
      question: 'Which physical visitor sites have source-backed county identity?',
    },
    {
      id: 'parks',
      locality: 'Synthetic test locality',
      category: 'Park',
      question: 'Which park visitor locations have an authoritative physical anchor?',
    },
  ]
  let failure: string | null = null
  try {
    await withTenantIsolationBypass(async () => {
      const identity = await db.$queryRaw<
        Array<{ database: string }>
      >`SELECT current_database() AS database`
      assert.equal(identity[0]?.database, database)
      assert.equal(await db.prospectVenue.count(), 0)
      ok('fresh disposable server identity and empty native dataset verified', true)
      await installProspectGeographyModel(system)
      ok(
        'actual pinned native registry installed in disposable PostgreSQL',
        (await db.prospectCountyAssignment.count()) === 3109,
      )
      const claimInput = {
        ...base,
        idempotencyKey: 'claim-A',
        scopeKind: 'WHOLE_COUNTY' as const,
        leaseSeconds: 900,
        plannedCells: plan,
      }
      const contenders = await Promise.allSettled([
        claimCountyResearch(claimInput, system),
        claimCountyResearch({ ...claimInput, idempotencyKey: 'claim-B' }, workerB),
      ])
      ok(
        'concurrent same-county workers cannot both acquire ownership',
        contenders.filter((r) => r.status === 'fulfilled').length === 1,
      )
      const owner = contenders[0]!.status === 'fulfilled' ? system : workerB
      const original = contenders.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<
        Record<string, any>
      >
      const lease = original.value,
        binding = {
          ...base,
          claimToken: lease.claimToken as string,
          generation: lease.generation as number,
        }
      const retry = await claimCountyResearch(
        owner === system ? claimInput : { ...claimInput, idempotencyKey: 'claim-B' },
        owner,
      )
      ok(
        'identical county claim retry recovers its one durable receipt',
        retry.receiptId === lease.receiptId && retry.replayed === true,
      )
      await rejected('changed claim payload cannot reuse a receipt key', () =>
        claimCountyResearch({ ...claimInput, plannedCells: [plan[0]!] }, owner),
      )
      await rejected('expired or foreign authority context cannot renew a claim', () =>
        renewCountyResearch(
          { ...binding, idempotencyKey: 'wrong-context' },
          { ...owner, authorityContext: 'another-tenant-context' },
        ),
      )
      await rejected('foreign worker cannot renew the owner claim', () =>
        renewCountyResearch(
          { ...binding, idempotencyKey: 'wrong-worker' },
          { ...owner, id: 'SYN-foreign' },
        ),
      )
      const renew = await renewCountyResearch(
        { ...binding, idempotencyKey: 'renew-owner', leaseSeconds: 1200 },
        owner,
      )
      ok(
        'explicit owner renewal retains generation and extends deadline',
        renew.generation === binding.generation,
      )
      const cook = await db.prospectCountyAssignment.findUniqueOrThrow({
        where: {
          modelVersion_countyGeoid: {
            modelVersion: PROSPECT_GEOGRAPHY_VERSION,
            countyGeoid: '17031',
          },
        },
      })
      const dupage = await db.prospectCountyAssignment.findUniqueOrThrow({
        where: {
          modelVersion_countyGeoid: {
            modelVersion: PROSPECT_GEOGRAPHY_VERSION,
            countyGeoid: '17043',
          },
        },
      })
      await rejected('old Chicago labels do not grant county ownership', () =>
        claimCountyResearch(
          { ...claimInput, countyGeoid: '17043', idempotencyKey: 'legacy-grant' },
          { ...system, scope: { mode: 'TERRITORIES', territoryIds: ['SYN-legacy-Chicago'] } },
        ),
      )
      const otherView = await readCountyResearch(
        { countyGeoid: '17031' },
        { ...system, id: 'SYN-observer' },
      )
      ok('another worker cannot read a lease token', !('claimToken' in otherView.items[0]!))
      const noScope = await readCountyResearch(
        {},
        { ...system, scope: { mode: 'TERRITORIES', territoryIds: [dupage.territoryId] } },
      )
      ok('county reads respect the exact target territory grant', noScope.total === 0)
      const adjacent = (await claimCountyResearch(
        { ...claimInput, countyGeoid: '17043', idempotencyKey: 'adjacent-claim' },
        workerB,
      )) as Record<string, any>
      const observationA = {
        ...binding,
        idempotencyKey: 'finding-A',
        cellId: 'museums',
        candidate: candidate(),
      }
      const observationB = {
        ...base,
        countyGeoid: '17043',
        claimToken: adjacent.claimToken,
        generation: adjacent.generation,
        idempotencyKey: 'finding-B',
        cellId: 'museums',
        candidate: {
          ...candidate('SYN Example Art Museum', '123 Example Ave'),
          aliases: ['SYN Example Museum'],
        },
      }
      const [foundA, foundB] = await Promise.all([
        submitCountyDiscovery(observationA, owner),
        submitCountyDiscovery(observationB, workerB),
      ])
      ok(
        'concurrent same-site name and street variants converge to one native review',
        foundA.reviewId === foundB.reviewId &&
          (await db.prospectIntelligenceReview.count({
            where: { kind: 'COUNTY_SITE_DISCOVERY' },
          })) === 1,
      )
      ok(
        'cross-boundary finding is quarantined rather than assigned to the searching worker',
        foundB.crossBoundary === true && foundB.disposition === 'CROSS_BOUNDARY_HANDOFF',
      )
      ok(
        'research observations alone create no native venues or organizations',
        (await db.prospectVenue.count()) === 0 && (await db.prospectOrganization.count()) === 0,
      )
      const recovered = await submitCountyDiscovery(observationA, owner)
      ok(
        'discovery lost-response retry recovers identical receipt without another observation',
        recovered.receiptId === foundA.receiptId && recovered.replayed === true,
      )
      let review = (
        await readCountyDiscoveries({ reviewId: String(foundA.reviewId), status: 'ALL' }, human)
      ).items[0]!
      ok(
        'both distinct source observations remain available in the normal review owner',
        review.observationCount === 2 && review.observations.length === 2,
      )
      const decision = {
        idempotencyKey: 'admit-A',
        expectedRegistryHash: PROSPECT_GEOGRAPHY_HASH,
        reviewId: review.reviewId,
        expectedRevision: review.revision,
        decision: 'CREATE_DISTINCT' as const,
        reason:
          'Synthetic human fixture explicitly reviewed both location and identity sources; this is not Tom or production approval.',
        observationReceiptId: String(foundA.receiptId),
        acknowledgedIdentityMatchIds: [],
      }
      await rejected('an agent cannot self-approve a new native site', () =>
        decideCountyDiscovery(decision, { ...system, type: 'AGENT' }),
      )
      const admissions = await Promise.allSettled([
        decideCountyDiscovery(decision, human),
        decideCountyDiscovery({ ...decision, idempotencyKey: 'competing-admit' }, human),
      ])
      ok(
        'concurrent distinct admission decisions yield exactly one native venue',
        admissions.filter((r) => r.status === 'fulfilled').length === 1 &&
          (await db.prospectVenue.count()) === 1,
      )
      const accepted = (
        admissions.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<
          Record<string, any>
        >
      ).value
      const admitted = await db.prospectVenue.findUniqueOrThrow({
        where: { id: accepted.venueId },
        include: { geography: true },
      })
      ok(
        'admission atomically retains native physical address and pinned county evidence',
        admitted.addressLine1 === '123 Example Avenue' &&
          admitted.geography?.countyGeoid === '17031' &&
          admitted.territoryId === cook.territoryId,
      )
      ok(
        'public contact route does not create native permission or contacts',
        (await db.prospectContact.count()) === 0,
      )
      const branch = await submitCountyDiscovery(
        {
          ...binding,
          idempotencyKey: 'branch-finding',
          cellId: 'museums',
          candidate: {
            ...candidate('SYN Second Branch', '987 Other Street'),
            website: 'https://parent.example.org/branch-two',
          },
        },
        owner,
      )
      ok(
        'shared parent domain never collapses a genuine second physical branch',
        branch.reviewId !== foundA.reviewId,
      )
      const branchReview = (
        await readCountyDiscoveries({ reviewId: String(branch.reviewId) }, human)
      ).items[0]!
      ok(
        'domain equality alone is not a duplicate-identity match',
        branchReview.identityMatches.length === 0,
      )
      const admittedBranch = (await decideCountyDiscovery(
        {
          ...decision,
          idempotencyKey: 'branch-admit',
          reviewId: branchReview.reviewId,
          expectedRevision: branchReview.revision,
          observationReceiptId: String(branch.receiptId),
          organizationId: admitted.organizationId,
        },
        human,
      )) as Record<string, any>
      ok(
        'a real branch can join an existing organization without merging venues',
        admittedBranch.organizationId === admitted.organizationId &&
          admittedBranch.venueId !== admitted.id &&
          (await db.prospectOrganization.count()) === 1 &&
          (await db.prospectVenue.count()) === 2,
      )
      await rejected('searched-with-results must reference actual durable findings', () =>
        completeCountyResearch(
          {
            ...binding,
            idempotencyKey: 'false-results',
            summary: 'Synthetic unsubstantiated coverage report.',
            cells: [
              {
                id: 'museums',
                status: 'SEARCHED_WITH_RESULTS',
                sourceUrls: ['https://museum.example.org'],
                queries: [],
                findingReceiptIds: [],
                note: 'Synthetic report without durable finding receipts.',
              },
            ],
          },
          owner,
        ),
      )
      const coverage = await completeCountyResearch(
        {
          ...binding,
          idempotencyKey: 'complete-A',
          summary: 'Two synthetic findings only; no real county research has been conducted.',
          cells: [
            {
              id: 'museums',
              status: 'SEARCHED_WITH_RESULTS',
              sourceUrls: ['https://museum.example.org'],
              queries: [],
              findingReceiptIds: [String(foundA.receiptId), String(branch.receiptId)],
              note: 'Only these synthetic sourced findings were retained.',
            },
          ],
        },
        owner,
      )
      ok(
        'missing plan cells remain unattempted and the county is never called exhaustive',
        coverage.unattemptedCells === 1 && coverage.exhaustive === false,
      )
      await rejected('a completed worker cannot submit another discovery', () =>
        submitCountyDiscovery({ ...observationA, idempotencyKey: 'late-finding' }, owner),
      )
      const reacquired = (await claimCountyResearch(
        { ...claimInput, idempotencyKey: 'new-generation' },
        owner,
      )) as Record<string, any>
      ok(
        'a resumed attempt receives a new fencing generation',
        reacquired.generation === binding.generation + 1,
      )
      await rejected('old generation cannot mutate after reacquisition', () =>
        releaseCountyResearch(
          {
            ...binding,
            idempotencyKey: 'stale-release',
            reason: 'Synthetic stale worker must not release a successor.',
          },
          owner,
        ),
      )
      const freshBinding = {
        ...base,
        claimToken: reacquired.claimToken,
        generation: reacquired.generation,
      }
      await db.prospectCountyResearchLease.update({
        where: {
          modelVersion_countyGeoid: {
            modelVersion: PROSPECT_GEOGRAPHY_VERSION,
            countyGeoid: '17031',
          },
        },
        data: { leaseExpiresAt: new Date(Date.now() - 1000) },
      })
      await rejected('expired lease cannot be renewed', () =>
        renewCountyResearch({ ...freshBinding, idempotencyKey: 'expired-renew' }, owner),
      )
      await rejected('expired lease cannot submit new findings', () =>
        submitCountyDiscovery(
          { ...observationA, ...freshBinding, idempotencyKey: 'expired-finding' },
          owner,
        ),
      )
      const expiredReplay = await claimCountyResearch(
        { ...claimInput, idempotencyKey: 'new-generation' },
        owner,
      )
      ok(
        'historical claim retry explicitly reports expired authority unusable',
        expiredReplay.leaseUsableNow === false,
      )
      const resumed = (await claimCountyResearch(
        { ...claimInput, idempotencyKey: 'after-expiry' },
        owner,
      )) as Record<string, any>
      const zero = await completeCountyResearch(
        {
          ...base,
          claimToken: resumed.claimToken,
          generation: resumed.generation,
          idempotencyKey: 'zero-attempt',
          summary:
            'A synthetic zero-result search is a recorded attempt, never proof no sites exist.',
          cells: [
            {
              id: 'museums',
              status: 'SEARCHED_NO_RESULTS',
              sourceUrls: ['https://museum.example.org/search'],
              queries: ['synthetic museum inventory'],
              findingReceiptIds: [],
              note: 'One synthetic source was attempted and returned no finding.',
            },
          ],
        },
        owner,
      )
      ok(
        'zero-result work retains attempted sources and honest uncovered cells',
        zero.searchedCells === 1 && zero.unattemptedCells === 1 && zero.exhaustive === false,
      )
      await releaseCountyResearch(
        {
          expectedRegistryHash: PROSPECT_GEOGRAPHY_HASH,
          countyGeoid: '17043',
          claimToken: adjacent.claimToken,
          generation: adjacent.generation,
          idempotencyKey: 'release-adjacent',
          reason: 'Synthetic adjacent county remains incomplete and released.',
        },
        workerB,
      )

      // Real PostgreSQL proposal/decision/reopen transactions on a native held row.
      const legacy = await db.prospectTerritory.create({
        data: {
          name: 'SYN Legacy Chicago',
          code: `SYN-${runId}`,
          createdBy: system.id,
          updatedBy: system.id,
        },
      })
      const org = await db.prospectOrganization.create({
        data: {
          canonicalName: 'SYN Legacy Museum',
          normalizedName: 'syn legacy museum',
          territoryId: legacy.id,
          createdBy: system.id,
          updatedBy: system.id,
        },
      })
      const venue = await db.prospectVenue.create({
        data: {
          organizationId: org.id,
          name: 'SYN Legacy Museum',
          normalizedName: 'syn legacy museum',
          territoryId: legacy.id,
          city: 'Chicago',
          region: 'IL',
          createdBy: system.id,
          updatedBy: system.id,
        },
      })
      await db.prospectVenueGeography.create({
        data: {
          venueId: venue.id,
          modelVersion: PROSPECT_GEOGRAPHY_VERSION,
          legacyTerritoryId: legacy.id,
          status: 'GEO_HOLD',
          reason: 'Synthetic fixture hold',
          createdBy: system.id,
          updatedBy: system.id,
        },
      })
      const proposal = {
        idempotencyKey: 'geo-proposal',
        venueId: venue.id,
        expectedVenueUpdatedAt: venue.updatedAt.toISOString(),
        expectedRevision: 1,
        expectedRegistryHash: PROSPECT_GEOGRAPHY_HASH,
        evidence: { ...evidence(), venueId: venue.id },
      }
      const proposals = await Promise.all([
        proposeProspectGeography(proposal, system),
        proposeProspectGeography(proposal, system),
      ])
      ok(
        'real PostgreSQL concurrent identical geography proposals share a durable receipt',
        proposals[0]!.receiptId === proposals[1]!.receiptId,
      )
      const nativeReview = (await listProspectGeographyProposals({ venueId: venue.id }, system))
        .items[0]!
      const accept = {
        idempotencyKey: 'geo-accept',
        reviewId: nativeReview.reviewId,
        expectedReviewRevision: nativeReview.revision,
        expectedRegistryHash: PROSPECT_GEOGRAPHY_HASH,
        decision: 'ACCEPT',
        reason: 'Synthetic human fixture has reviewed the exact test evidence.',
      }
      const resolved = await resolveProspectGeographyProposal(accept, human)
      const replayed = await resolveProspectGeographyProposal(accept, human)
      ok(
        'lost human decision response recovers the identical committed receipt',
        replayed.receiptId === resolved.receiptId && replayed.replayed === true,
      )
      await rejected('stale decision with a new key cannot overwrite current review', () =>
        resolveProspectGeographyProposal({ ...accept, idempotencyKey: 'stale-accept' }, human),
      )
      await rejected('a human decision endpoint refuses an automated actor', () =>
        resolveProspectGeographyProposal(
          { ...accept, idempotencyKey: 'agent-accept' },
          { ...system, type: 'AGENT' },
        ),
      )
      const geography = await readProspectPhysicalGeography(venue.id)
      ok(
        'normal geography projection exposes reviewed physical evidence',
        geography.physicalEvidence?.addressQuote === proposal.evidence.addressQuote,
      )
      await invalidateProspectGeography(
        {
          idempotencyKey: 'geo-reopen',
          venueId: venue.id,
          expectedVenueUpdatedAt: geography.venue!.updatedAt.toISOString(),
          expectedRevision: geography.geography!.revision,
          expectedRegistryHash: PROSPECT_GEOGRAPHY_HASH,
          reason:
            'Synthetic human correction reopens the county while preserving all source evidence.',
        },
        human,
      )
      const reopened = await readProspectPhysicalGeography(venue.id)
      ok(
        'reopen preserves evidence and restores legacy ownership without deleting native identity',
        reopened.geography?.status === 'GEO_HOLD' &&
          reopened.physicalEvidence !== null &&
          reopened.venue?.id === venue.id,
      )
      const current = await db.prospectVenue.findUniqueOrThrow({ where: { id: venue.id } })
      const newProposal = (await proposeProspectGeography(
        {
          ...proposal,
          idempotencyKey: 'reject-proposal',
          expectedVenueUpdatedAt: current.updatedAt.toISOString(),
          expectedRevision: reopened.geography!.revision,
        },
        system,
      )) as Record<string, any>
      const rejectReview = (
        await listProspectGeographyProposals({ venueId: venue.id }, system)
      ).items.find((r) => r.reviewId === newProposal.reviewId)!
      await resolveProspectGeographyProposal(
        {
          ...accept,
          idempotencyKey: 'geo-reject',
          reviewId: rejectReview.reviewId,
          expectedReviewRevision: rejectReview.revision,
          decision: 'REJECT',
        },
        human,
      )
      ok(
        'reject commits its decision without assigning the held venue',
        (await readProspectPhysicalGeography(venue.id)).geography?.status === 'GEO_HOLD',
      )
      const token = randomUUID()
      const job = await db.prospectResearchJob.create({
        data: {
          organizationId: org.id,
          status: 'CLAIMED',
          claimToken: token,
          claimOwnerId: 'SYN-other-job-owner',
          claimAgentRunId: 'SYN-other-run',
          claimExpiresAt: new Date(Date.now() + 60000),
          queuedBy: system.id,
        },
      })
      await rejected('county proposal cannot steal an existing organization research job', () =>
        proposeProspectGeography(
          {
            ...proposal,
            idempotencyKey: 'job-steal',
            expectedVenueUpdatedAt: current.updatedAt.toISOString(),
            expectedRevision: reopened.geography!.revision,
          },
          system,
        ),
      )
      const expires = new Date(Date.now() + 60000)
      await db.prospectResearchJob.update({
        where: { id: job.id },
        data: { claimOwnerId: system.id, claimAgentRunId: system.runId, claimExpiresAt: expires },
      })
      await db.prospectResearchAttempt.create({
        data: {
          jobId: job.id,
          claimToken: token,
          agentRunId: system.runId,
          agentIdentityId: system.id,
          promptIdentity: 'synthetic-existing-job-test',
          leaseExpiresAt: expires,
          usage: { venueId: venue.id },
        },
      })
      const ownedProposal = await proposeProspectGeography(
        {
          ...proposal,
          idempotencyKey: 'owned-job-proposal',
          expectedVenueUpdatedAt: current.updatedAt.toISOString(),
          expectedRevision: reopened.geography!.revision,
          researchClaim: { jobId: job.id, claimToken: token },
        },
        system,
      )
      ok(
        'current existing-record job owner can submit evidence using its exact claim',
        Boolean(ownedProposal.receiptId),
      )
      await db.prospectResearchJob.update({
        where: { id: job.id },
        data: { claimExpiresAt: new Date(Date.now() - 1000) },
      })
      await rejected('expired existing-record claim cannot admit another proposal', () =>
        proposeProspectGeography(
          {
            ...proposal,
            idempotencyKey: 'expired-job-proposal',
            expectedVenueUpdatedAt: current.updatedAt.toISOString(),
            expectedRevision: reopened.geography!.revision,
            researchClaim: { jobId: job.id, claimToken: token },
          },
          system,
        ),
      )
      const deniedGeography = await readProspectPhysicalGeography(admitted.id, [dupage.territoryId])
      ok(
        'a venue grant outside the assigned territory returns no related physical evidence',
        deniedGeography.venue === null && deniedGeography.physicalEvidence === null,
      )
      ok(
        'all test native IDs and import-null lineages remain intact',
        (await db.prospectVenue.count()) === 3 &&
          (await db.prospectVenue.count({ where: { sourceImportRowId: { not: null } } })) === 0,
      )
    })
  } catch (error) {
    failure = error instanceof Error ? (error.stack ?? error.message) : String(error)
  } finally {
    await db.$disconnect()
    await writeFile(
      path.join(output, 'acceptance.json'),
      JSON.stringify(
        {
          passed: !failure,
          checks,
          checkCount: checks.length,
          failure,
          environment:
            'Fresh PostgreSQL with real transactions and r001 SQL guards + r003 forward migration',
          authority:
            'Synthetic SYSTEM workers and injected HUMAN test fixtures; not hosted authentication or Tom approval',
          productionTouched: false,
          retainedDatabaseTouched: false,
          finishedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    )
  }
  console.log(JSON.stringify({ passed: !failure, checkCount: checks.length, output, failure }))
  if (failure) throw new Error(failure)
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Synthetic database acceptance failed')
  process.exitCode = 1
})
