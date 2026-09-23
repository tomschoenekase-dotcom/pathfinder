/** Provider-dark acceptance of the actual route/credential/session/lease/writer.
 * Initial SQL rows are a clearly labeled synthetic fixture, not source admission.
 * No real CRM data, credential copies, bypass endpoint, provider or mailbox.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

async function main() {
  const root = path.resolve(__dirname, '..')
  const qa = process.env.TORCHIKO_AUTH_HTTP_QA_DIR!
  const target = new URL(process.env.DATABASE_URL!)
  assert.match(target.pathname, /^\/pathfinder_disposable_agent_bridge_[a-f0-9]{12}$/u)
  assert.equal(target.hostname, '127.0.0.1'); assert.equal(target.port, process.env.TORCHIKO_AUTH_HTTP_PG_PORT)
  assert.ok(Number(target.port) > 1024 && Number(target.port) <= 65535)
  assert.ok(process.env.DIRECT_DATABASE_URL === process.env.DATABASE_URL, 'Runtime database references must select the same admitted disposable target')
  assert.equal(process.env.TORCHIKO_AUTH_HTTP_ACCEPTANCE, '1')
  assert.equal(process.env.TORCHIKO_AUTHENTICATED_CRM_SALES_ENABLED, '1')
  assert.equal(process.env.AGENT_BRIDGE_HTTP_ENABLED, 'true')
  for (const key of ['TORCHIKO_LOCAL_CRM_REHEARSAL', 'TORCHIKO_LOCAL_CRM_SALES_ENABLED', 'TORCHIKO_LOCAL_CRM_RESEARCH_ENABLED'])
    assert.notEqual(process.env[key], '1')
  assert.ok(qa.startsWith(path.resolve(root, '../qa') + path.sep))
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'RESEND_API_KEY', 'GOOGLE_OAUTH_CLIENT_SECRET']) assert.ok(!process.env[key])
  const receipt: any = { schema: 'torchiko.authenticated-outreach-http-acceptance/1',
    startedAt: new Date().toISOString(), database: target.pathname.slice(1),
    source: { originalCRMModified: false, existingDatabaseModified: false },
    fixture: 'Hand-authored canonical-catalog contract fixture; no real venue, no HTTPS capture or market research.',
    authenticatedHttp: false, installedCodex: 'NOT_RUN', hosted: 'NOT_RUN',
    componentMode: process.env.TORCHIKO_AUTH_HTTP_COMPONENT_MODE,
    installedWltAndReference: process.env.TORCHIKO_AUTH_HTTP_COMPONENT_MODE === 'PRIVATE_INSTALLED_OWNERS' ? 'NOT_YET_PROVEN' : 'NOT_RUN_SYNTHETIC_CONTRACT_ONLY',
    emailSend: false, humanSendApproval: false, mailbox: 'NOT_CONFIGURED',
    networkAttempts: [] as string[], checks: [] as any[], http: [] as any[] }
  const check = (label: string, condition: unknown) => {
    receipt.checks.push({ label, passed: Boolean(condition) }); assert.ok(condition, label); console.log('PASS ' + label)
  }
  let db: any, server: ReturnType<typeof createServer> | undefined, connection: any, adapter: any
  let secret = '', leaseEnvelope: any, dropImportResponse = false, dropHeartbeatResponse = false
  const safeError = (error: any) => String(error?.stack ?? error).replaceAll(secret || 'NO_SECRET', '[REDACTED]')
    .replace(/postgres(?:ql)?:\/\/[^\s"'`]+/giu, '[REDACTED_DATABASE_URL]')
  try {
    const client = await import('../packages/db/src/client'); db = client.db
    if (process.env.TORCHIKO_AUTH_HTTP_CLIENT_MODE === 'FULL_EXACT_SOURCE_SCHEMA') {
      receipt.clientAdmission = 'Full exact-source generated Prisma schema; no excluded model substitution'
    } else {
      assert.equal(process.env.TORCHIKO_AUTH_HTTP_CLIENT_MODE, 'COMPATIBLE_503_BLOCK_LOCAL_ADMISSION')
      const excluded = new Set(['IntakeSourceAgentDispatch', 'ProspectCountyAssignment', 'ProspectCountyResearchLease'])
      db.$use(async (params: any, next: any) => {
        if (excluded.has(params.model)) throw new Error('OUTSIDE_BOUNDED_NATIVE_CLIENT_ADMISSION')
        return next(params)
      })
      receipt.clientAdmission = 'NATIVE-CLIENT-ADMISSION.json: 503 matched schema blocks; three excluded models denied'
    }
    const { withTenantIsolationBypass } = await import('../packages/db/src/middleware/tenant-isolation')
    const { salesHash, encodeSalesComponent } = await import('../packages/db/src/helpers/prospect-sales-snapshot')
    const { issueExternalCredentialAction, revokeExternalCredentialAction,
      activateAgentBridgeCredentialAction } = await import('../packages/db/src/helpers/external-credential-actions')
    const { POST } = await import('../apps/dashboard/app/api/agent-bridge/[tenantId]/[venueId]/route')
    const { createOutreachMcp } = await import('./lib/torchiko-outreach-mcp.mjs')
    const { createOutreachConnection } = await import('./lib/torchiko-outreach-connection.mjs')
    const { requestAgentRunCancellationAction } = await import('../packages/db/src/helpers/agent-run-cancellation-actions')
    const { createOutreachRetryArtifacts } = await import('./lib/torchiko-outreach-retry.mjs')
    const { compileNativeOutreachResult } = await import('./lib/torchiko-outreach-result.mjs')
    const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex')
    const ids = { tenantId: 'SYN-HTTP-TENANT', venueId: 'SYN-HTTP-PLATFORM-VENUE', identityId: 'SYN-HTTP-IDENTITY',
      territoryId: 'SYN-HTTP-TERRITORY', organizationId: 'SYN-HTTP-ORG', prospectId: 'SYN-HTTP-PROSPECT',
      importId: 'SYN-HTTP-IMPORT', recordId: 'SYN-HTTP-RECORD' }
    receipt.ids = ids
    const actor = { type: 'HUMAN' as const, role: 'PLATFORM_ADMIN' as const, id: 'synthetic:lane03:fixture-credential-operator' }
    const caps = ['prospects.read', 'prospects.native-writer', 'prospects.correspondence.read']
    const name = 'SYNTHETIC Map Fixture Museum', city = 'Fixture City', region = 'SYN'
    const description = 'This synthetic museum fixture contains historic maps.'
    const address = 'qa@example.invalid', url = 'https://fixture.example.invalid/'
    const words = [name, `${city}, ${region}`, description, address]
    const visible = words.join(' '), raw = Buffer.from(words.map(v => `<p>${v}</p>`).join(''))
    const observedAt = new Date(Date.now() - 60000).toISOString()
    const cells = { venue_name: name, venue_city: city, venue_region: region }
    const workbookHash = sha('SYNTHETIC generated fixture; no real workbook'), recordHash = salesHash(cells)
    const claim = (claimId: string, kind: string, factKey: string, value: string, quote = value, routeKind: string | null = null) => ({
      claimId, kind, factKey, value, pageId: 'SYN-HTTP-PAGE', quote,
      start: Array.from(visible.slice(0, visible.indexOf(quote))).length,
      end: Array.from(visible.slice(0, visible.indexOf(quote)) + quote).length,
      reason: 'Hand-authored synthetic contract claim, not real venue evidence or a research result.',
      validFrom: null, validUntil: null, publishedAt: null, routeKind,
    })
    const capture = { schema: 'torchiko.native-source-capture/1', identity: {
      venueId: ids.prospectId, organizationId: ids.organizationId, name, city, region,
      importRecordId: ids.recordId, importRecordHash: recordHash, workbookHash, rawRowHash: salesHash(cells), sourceLocator: 'SYNTHETIC!row:1',
    }, pages: [{ id: 'SYN-HTTP-PAGE', url, observedAt, retrievedAt: observedAt, status: 200,
      contentType: 'text/html', rawGzipBase64: gzipSync(raw).toString('base64'), rawSha256: sha(raw),
      nameQuote: name, locationQuote: `${city}, ${region}` }],
    claims: [claim('N-IDENTITY', 'identity', 'venue.identity', name),
      claim('N-SITE', 'official_site', 'venue.official_site', url, name),
      claim('N-DESCRIPTION', 'venue_description', 'venue.understanding', description),
      claim('N-EMAIL', 'public_route', 'route.public', address, address, 'email')],
    identityPageId: 'SYN-HTTP-PAGE', provenance: {
      producer: 'Hand-authored provider-dark synthetic contract fixture; NO HTTPS request was made',
      method: 'FOREGROUND_HTTPS_GET', gatePlanId: 'plan-SYN-HTTP', gateReceiptSha256: sha('synthetic gate placeholder'),
      associationReason: 'Synthetic enum and HTML test values exercise the canonical catalog contract; they are not genuine public captures or original CRM data.',
    }, SEND_AUTHORIZED: false }
    const captureId = 'native-capture_' + salesHash(capture).slice(0, 40)
    const selection = { captureId, previousSelectionId: null, SEND_AUTHORIZED: false, selection: {
      claimIds: ['N-IDENTITY', 'N-DESCRIPTION'], routeClaimId: 'N-EMAIL',
      purpose: 'Discuss a conditional visitor guide idea for this synthetic fixture without any actual outreach.',
      hypothesis: 'Explore a small question-based AI visitor guide using material the venue chooses; no deployment, price, visit, outcome or agreement is claimed.',
    } }
    const selectionId = 'native-selection_' + salesHash(selection).slice(0, 40)
    let issued: any, activated: any, run: any, unrelated: any
    const lifecycleRuns: Record<string, any> = {}
    await withTenantIsolationBypass(async () => {
      assert.equal(await db.prospectOrganization.count(), 0, 'Fresh database only; never reuse an existing CRM')
      await db.tenant.create({ data: { id: ids.tenantId, name: 'Synthetic HTTP tenant', slug: 'syn-http-tenant' } })
      await db.venue.create({ data: { id: ids.venueId, tenantId: ids.tenantId, name: 'Synthetic platform venue', slug: 'syn-http-platform' } })
      await db.prospectTerritory.create({ data: { id: ids.territoryId, name: 'Synthetic HTTP territory', code: 'SYN-HTTP', createdBy: actor.id, updatedBy: actor.id } })
      await db.prospectOrganization.create({ data: { id: ids.organizationId, canonicalName: name, normalizedName: name.toLowerCase(),
        territoryId: ids.territoryId, source: 'Synthetic isolated HTTP fixture', createdBy: actor.id, updatedBy: actor.id } })
      await db.prospectVenue.create({ data: { id: ids.prospectId, organizationId: ids.organizationId, name, normalizedName: name.toLowerCase(),
        city, region, website: url, createdBy: actor.id, updatedBy: actor.id } })
      await db.prospectImport.create({ data: { id: ids.importId, fileName: 'SYNTHETIC-NOT-A-WORKBOOK.json', fileType: 'json', fileSize: 0,
        fileHash: workbookHash, mappingHash: sha('synthetic mapping'), importIdentityHash: sha('synthetic import identity'), mapping: {}, createdBy: actor.id } })
      await db.prospectImportSourceRecord.create({ data: { id: ids.recordId, importId: ids.importId, sourceSystem: 'SYNTHETIC_HTTP_ACCEPTANCE',
        sourceWorkbookHash: workbookHash, recordKind: 'PROSPECT', externalRecordId: 'SYNTHETIC-row-1', recordHash,
        rawPayload: { ...cells, _source: { sheetName: 'SYNTHETIC', originalRowNumber: 1, rawRowSha256: salesHash(cells) } },
        normalizedPayload: cells, sourceStatus: 'SYNTHETIC', canonicalOrganizationId: ids.organizationId, canonicalVenueId: ids.prospectId } })
      for (const [id, sourceType, content] of [[captureId, 'CRM_NATIVE_SOURCE_CAPTURE_V1', { capture }],
        [selectionId, 'CRM_NATIVE_SOURCE_SELECTION_V1', selection]] as const) {
        await db.prospectSourceEvidence.create({ data: { id, sourceType, organizationId: ids.organizationId, venueId: ids.prospectId,
          capturedValue: encodeSalesComponent(content), sourceLabel: 'SYNTHETIC contract fixture; NOT real source admission', createdBy: actor.id } })
      }
      await db.agentIdentity.create({ data: { id: ids.identityId, tenantId: ids.tenantId, venueId: ids.venueId, identityKey: 'synthetic.outreach.http',
        name: 'Synthetic no-send outreach', agentType: 'OPERATIONS', accessScope: 'VENUE', accessCapabilities: caps,
        autonomyLevel: 'READ_ONLY', defaultProvider: 'codex-bridge', defaultModel: 'gpt-6-astra', enabled: true, createdBy: actor.id } })
      const runData = { tenantId: ids.tenantId, venueId: ids.venueId, agentIdentityId: ids.identityId,
        runType: 'OPERATIONS', requestedOperation: 'synthetic_authenticated_outreach_review', requestPrompt: 'Prepare a single no-send synthetic review draft.',
        scopeSnapshot: { accessCapabilities: caps, prospectScope: { mode: 'TERRITORIES', territoryIds: [ids.territoryId] },
          promptIdentity: 'synthetic-authenticated-outreach-http/1', requiredWorkerRoles: ['OUTREACH'] },
        status: 'QUEUED', modelProvider: 'codex-bridge', modelName: 'gpt-6-astra', initiatedByType: 'HUMAN', initiatedById: actor.id }
      unrelated = await db.agentRun.create({ data: { ...runData, operationId: randomUUID() } })
      run = await db.agentRun.create({ data: { ...runData, operationId: randomUUID() } })
      for (const name of ['heartbeat-loss', 'cancellation', 'expiry'])
        lifecycleRuns[name] = await db.agentRun.create({ data: { ...runData, operationId: randomUUID() } })
      issued = await issueExternalCredentialAction({ operationId: randomUUID(), tenantId: ids.tenantId, clientId: ids.tenantId,
        venueId: ids.venueId, actor, kind: 'MCP', label: 'Synthetic HTTP acceptance only', capabilities: ['agent-runs:execute'],
        expiresAt: new Date(Date.now() + 30 * 60000) })
      secret = issued.plaintextSecret
    })
    receipt.runId = run.id
    const originalFetch = globalThis.fetch
    let origin = ''
    globalThis.fetch = (async (input: any, options: any) => {
      const destination = new URL(typeof input === 'string' ? input : input.url ?? input.href)
      if (destination.origin !== origin) { receipt.networkAttempts.push('Non-fixture fetch blocked'); throw new Error('PROVIDER_DARK_NETWORK_DENIED') }
      return originalFetch(input, options)
    }) as typeof fetch
    const requireLocal = createRequire(path.join(root, 'package.json'))
    for (const protocol of ['node:https']) {
      const owner = requireLocal(protocol)
      owner.request = owner.get = () => { receipt.networkAttempts.push('HTTPS request blocked'); throw new Error('PROVIDER_DARK_NETWORK_DENIED') }
    }
    server = createServer(async (req, res) => {
      try {
        const chunks = []; let bytes = 0
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 131072) throw new Error('BOUNDED_FIXTURE_BODY'); chunks.push(chunk) }
        const body = Buffer.concat(chunks).toString('utf8'), envelope = JSON.parse(body)
        if (envelope.method === 'callProspectTool') leaseEnvelope = structuredClone(envelope.params)
        const segments = req.url?.split('/') ?? []
        const request = new Request(origin + req.url, { method: req.method, headers: req.headers as any, body })
        const started = performance.now()
        const response = await POST(request, { params: Promise.resolve({ tenantId: segments[3]!, venueId: segments[4]! }) })
        receipt.http.push({ method: envelope.method, tool: envelope.params?.toolName ?? null, status: response.status,
          elapsedMs: Math.round((performance.now() - started) * 100) / 100 })
        if (dropImportResponse && envelope.params?.toolName === 'torchiko.prospects.import_native_writer_result' && response.status === 200) {
          dropImportResponse = false; await response.arrayBuffer(); req.socket.destroy(); return
        }
        if (dropHeartbeatResponse && envelope.method === 'heartbeatTask' && response.status === 200) {
          dropHeartbeatResponse = false; await response.arrayBuffer(); req.socket.destroy(); return
        }
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()))
      } catch { res.writeHead(500); res.end('Fixture transport error') }
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as any).port}`
    const endpoint = `${origin}/api/agent-bridge/${ids.tenantId}/${ids.venueId}`
    const direct = (method: string, params: any, bearer = secret, url = endpoint) => fetch(url, { method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) })
    check('Native disabled credential is rejected over actual HTTP', (await direct('heartbeatSession', {})).status === 401)
    await withTenantIsolationBypass(async () => { activated = await activateAgentBridgeCredentialAction({ operationId: randomUUID(),
      tenantId: ids.tenantId, clientId: ids.tenantId, venueId: ids.venueId, credentialId: issued.credential.id,
      expectedUpdatedAt: issued.credential.updatedAt, actor }) })
    check('Missing bearer authority is rejected over actual HTTP', (await direct('heartbeatSession', {}, '')).status === 401)
    const env = { TORCHIKO_AGENT_BRIDGE_URL: endpoint, TORCHIKO_AGENT_BRIDGE_SECRET: secret,
      TORCHIKO_AGENT_BRIDGE_VENUE_ID: ids.venueId, TORCHIKO_OUTREACH_RUN_ID: run.id }
    const retry = createOutreachRetryArtifacts(root)
    adapter = await createOutreachMcp({ root, env, retainResult: (value: any) => retry.retain(value),
      recoverResult: (input: any) => input.sha256 ? retry.read(input.taskId, input.sha256) : retry.locate(input.taskId) })
    let rpcId = 0
    const call = async (name: string, args: any) => {
      const response = await adapter.handle({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })
      if (response.error || response.result?.isError) throw new Error(JSON.stringify(response.error ?? response.result))
      return JSON.parse(response.result.content[0].text)
    }
    const scope = { organizationId: ids.organizationId, venueId: ids.prospectId }
    const initial = await call('torchiko.prospects.read_native_writer_task', scope)
    check('Actual native HTTP authenticates, registers, leases and reads scoped writer state', initial.venueId === ids.prospectId)
    receipt.authenticatedHttp = true
    await withTenantIsolationBypass(async () => {
      check('Older unrelated queued run was not claimed', (await db.agentRun.findUniqueOrThrow({ where: { id: unrelated.id } })).status === 'QUEUED')
      const held = await db.agentRun.findUniqueOrThrow({ where: { id: run.id } })
      check('Selected native run owns a real execution lease and worker', held.status === 'RUNNING' && held.executionBridgeSessionId && held.executionWorkerId)
    })
    const privateOwners = receipt.componentMode === 'PRIVATE_INSTALLED_OWNERS'
    check(privateOwners ? 'Actual installed writing guide is available without local rehearsal flags' :
      'Synthetic guide contract is available; this is NOT the private supplied reference', initial.writingGuide?.state === 'available')
    await call('torchiko.prospects.prepare_native_writer', { ...scope, expectedSnapshotHash: initial.snapshotHash,
      savedWritingGuide: 'torchiko-v0.2', expectedWritingGuideSha256: initial.writingGuide.sha256 })
    const prepared = await call('torchiko.prospects.read_native_writer_task', scope)
    check(privateOwners ? 'Native preparation consumes installed WLT and supplied reference' :
      'Native task persists synthetic component input through actual HTTP and database owners',
    prepared.task?.schema === 'torchiko.native-writer-task/1' && prepared.hold === null)
    if (privateOwners) receipt.installedWltAndReference = 'PASSED_PRIVATE_COMPONENT_PREPARATION_NOT_CODEX'
    await writeFile(path.join(qa, 'native-writer-task.json'), JSON.stringify(prepared, null, 2) + '\n', { flag: 'wx' })
    const part = (text: string, category: string, claimIds: string[]) => ({ text, category, claimIds,
      reason: category === 'NONFACTUAL' ? 'This is an ordinary greeting or closing with no factual claim.' :
        category === 'SOURCE FACT' ? 'This quotes only the explicitly synthetic native fixture claim, not a real venue fact.' :
          'This is a conditional proposal or question, not an agreement, result, visit or deployment claim.', answers: [] })
    const candidate = { schema: 'torchiko.codex-outreach-text/1', subjectParts: [part('Could an AI visitor guide be useful?', 'SALES HYPOTHESIS', ['H-SCOPE'])],
      bodyParts: [part('Hello there,\n\n', 'NONFACTUAL', []), part(description + '\n\n', 'SOURCE FACT', ['N-DESCRIPTION']),
        part('Would it be useful to explore a small AI visitor guide for questions about a few maps? It could use material you choose and stay focused on that part of a visit.\n\n', 'SALES HYPOTHESIS', ['H-SCOPE']),
        part('Would a short conversation about that idea make sense?\n\n', 'SALES HYPOTHESIS', ['H-ASK']), part('Thanks,\nTom', 'NONFACTUAL', [])] }
    const result = compileNativeOutreachResult(prepared.task, candidate, 'GPT-6 Astra Pro — hand-authored provider-dark acceptance fixture, NOT installed Codex')
    const importArgs = { ...scope, expectedSnapshotHash: result.binding.nativeSnapshotHash, result }
    // Use the actual writer task binding; no fixture-generated hash stands in for it.
    importArgs.expectedSnapshotHash = prepared.snapshotHash
    await assert.rejects(() => call('torchiko.prospects.import_native_writer_result', { ...importArgs,
      result: { ...result, binding: { ...result.binding, recipient: 'forged@example.invalid' } } }))
    check('Changed immutable binding is rejected, not repaired', true)
    const retained = await retry.retain(result)
    dropImportResponse = true
    await assert.rejects(() => call('torchiko.prospects.import_native_writer_result', importArgs), /OUTCOME_UNKNOWN/)
    check('Dropped post-commit HTTP response retains the exact candidate for recovery', (await retry.locate(result.taskId)).artifacts?.length > 0)
    const recovered = await retry.read(result.taskId, retained.sha256)
    assert.deepEqual(recovered, result, 'The original retained result must not change during recovery')
    const imported = await call('torchiko.prospects.import_native_writer_result', { ...importArgs, result: recovered })
    check('Exact retry returns one immutable receipt rather than another draft', imported.replayed === true && imported.receiptId && imported.draftId)
    const review = await call('torchiko.prospects.read_outreach_review', scope)
    check('Native review reopens exact subject/body, first version and unapproved state',
      review.draft?.id === imported.draftId && review.draft?.body === result.body &&
      review.draft?.subject === result.subject && review.draft?.version === 1 &&
      review.draft?.state === 'DRAFT_REVIEW' && review.SEND_AUTHORIZED === false)
    const replayAgain = await call('torchiko.prospects.import_native_writer_result', { ...importArgs, result: recovered })
    check('A second exact replay still returns the identical receipt and draft',
      replayAgain.replayed === true && replayAgain.receiptId === imported.receiptId && replayAgain.draftId === imported.draftId)
    const selectedLease = structuredClone(leaseEnvelope)
    check('A valid lease cannot select a different queued run',
      (await direct('callProspectTool', { ...selectedLease, runId: unrelated.id, correlationId: randomUUID() })).status === 409)
    const wrongLease = { ...selectedLease, leaseToken: randomUUID(), correlationId: randomUUID(),
      toolName: 'torchiko.prospects.read_native_writer_task', arguments: scope }
    check('Forged execution lease cannot read native writer state', (await direct('callProspectTool', wrongLease)).status === 409)
    check('Valid credential cannot cross the route tenant', (await direct('heartbeatSession', {}, secret,
      `${origin}/api/agent-bridge/SYN-OTHER-TENANT/${ids.venueId}`)).status === 401)
    await adapter.close(); adapter = null
    for (const name of ['heartbeat-loss', 'cancellation', 'expiry']) {
      const selected = lifecycleRuns[name]
      connection = createOutreachConnection({ env: { ...env, TORCHIKO_OUTREACH_RUN_ID: selected.id },
        schedule: () => undefined, cancel: () => {} })
      await connection.callTool('torchiko.prospects.read_native_writer_task', scope)
      check(`Native selected lease is established for ${name}`, connection.status().authenticatedNativeCallProven)
      if (name === 'heartbeat-loss') {
        dropHeartbeatResponse = true
        await assert.rejects(connection.pulse(), /OUTCOME_UNKNOWN_RECONCILE_EXACT_REQUEST/u)
      } else if (name === 'cancellation') {
        await withTenantIsolationBypass(() => requestAgentRunCancellationAction({ tenantId: ids.tenantId,
          venueId: ids.venueId, agentRunId: selected.id, actor,
          reason: 'Provider-dark fixture cancellation, not a live operational run.' }))
        await assert.rejects(connection.pulse(), /CANCEL_REQUESTED/u)
      } else {
        // Deterministic time fault in this one disposable fixture. The actual
        // server must reject the expired lease; no mocked server/auth result.
        await withTenantIsolationBypass(() => db.agentRun.update({ where: { id: selected.id },
          data: { executionLeaseExpiresAt: new Date(Date.now() - 1000) } }))
        await assert.rejects(connection.pulse(), /SCOPE_LEASE_OR_REQUEST_HELD/u)
      }
      const callsBefore = receipt.http.length
      await assert.rejects(connection.callTool('torchiko.prospects.read_native_writer_task', scope))
      check(`${name} holds without reconnecting, selecting another run or writing`,
        receipt.http.length === callsBefore && connection.status().state !== 'CONNECTED')
      await connection.close(); connection = null
    }
    await withTenantIsolationBypass(async () => {
      const settled = await db.agentRun.findUniqueOrThrow({ where: { id: run.id } })
      check('Confirmed receipt settles the native run without send approval', settled.status === 'COMPLETED')
      check('Only one native draft exists after uncertain response and retry', await db.prospectOutreachDraft.count() === 1)
      check('No mailbox, send item, outbox, message or approval was created',
        await db.correspondenceProviderAccount.count() === 0 && await db.prospectSendItem.count() === 0 &&
        await db.prospectSendOutbox.count() === 0 && await db.prospectEmailMessage.count() === 0 && await db.approvalRequest.count() === 0)
      await revokeExternalCredentialAction({ operationId: randomUUID(), tenantId: ids.tenantId, clientId: ids.tenantId,
        venueId: ids.venueId, credentialId: issued.credential.id, expectedUpdatedAt: activated.credential.updatedAt,
        reasonCode: 'SYNTHETIC_ACCEPTANCE_COMPLETE', actor })
    })
    check('Native revocation rejects subsequent HTTP activity', (await direct('heartbeatSession', {})).status === 401)
    check('No external provider or research request occurred', receipt.networkAttempts.length === 0)
    receipt.review = review; receipt.immutableReceipt = imported
    receipt.exactRetry = { taskId: result.taskId, sha256: retained.sha256, exactResultRecovered: true,
      originalReceiptReplayedTwice: true, expectedRevisionCount: 1 }
    receipt.passed = true
  } catch (error) { receipt.passed = false; receipt.failure = safeError(error); process.exitCode = 1 }
  finally {
    if (adapter) { try { await adapter.close() } catch {} }
    if (connection) { try { await connection.close() } catch {} }
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }
    if (db) await db.$disconnect()
    receipt.finishedAt = new Date().toISOString()
    await writeFile(path.join(qa, 'HTTP-ACCEPTANCE.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
    console.log(JSON.stringify({ passed: receipt.passed, passedChecks: receipt.checks.filter((c: any) => c.passed).length,
      failure: receipt.failure ?? null, output: path.join(qa, 'HTTP-ACCEPTANCE.json') }))
  }
}
main().catch(error => { console.error('AUTHENTICATED_HTTP_ACCEPTANCE_SETUP_HELD: ' + error.message); process.exitCode = 1 })
