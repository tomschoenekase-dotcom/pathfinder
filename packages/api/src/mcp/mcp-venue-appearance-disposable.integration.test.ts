import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'

import {
  activateClientMcpCredentialAction,
  db,
  issueExternalCredentialAction,
  revokeExternalCredentialAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { handleMcpHttpRequest } from './http'

type RpcBody = {
  error?: unknown
  result?: {
    protocolVersion?: string
    tools?: Array<{ name: string }>
    structuredContent?: { data: Record<string, unknown> }
  }
}

const enabled =
  process.env.RUN_MCP_VENUE_APPEARANCE_DB_INTEGRATION === '1' &&
  /^postgres(?:ql)?:\/\/[^/]+\/pathfinder_disposable_agent_bridge_[a-f0-9]{12}(?:\?|$)/u.test(
    process.env.DATABASE_URL ?? '',
  )

describe.skipIf(!enabled)('disposable client-scoped MCP venue appearance lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('proves issue, guarded activation, HTTP tools, idempotent appearance update, tenant denial, and revocation on PostgreSQL', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
      const tenantId = `mcp-appearance-${suffix}`
      const actor = {
        type: 'HUMAN' as const,
        id: 'disposable-platform-admin',
        role: 'PLATFORM_ADMIN' as const,
      }
      await db.tenant.create({
        data: { id: tenantId, name: 'Disposable MCP appearance tenant', slug: tenantId },
      })

      const issued = await issueExternalCredentialAction({
        operationId: randomUUID(),
        tenantId,
        clientId: tenantId,
        venueId: null,
        actor,
        kind: 'MCP',
        label: 'Disposable client-scoped appearance credential',
        capabilities: ['appearance:read', 'appearance:write', 'venues:create', 'venues:read'],
        expiresAt: new Date(Date.now() + 60 * 60_000),
      })
      expect(issued.credential.enabled).toBe(false)
      expect(issued.plaintextSecret).toMatch(/^pf_mcp_[A-Za-z0-9_-]{43}$/u)
      const plaintext = issued.plaintextSecret!

      async function rpc(scopeTenantId: string, id: string, method: string, params?: unknown) {
        const request = new Request(`http://localhost/api/mcp/${scopeTenantId}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${plaintext}`,
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method,
            ...(params === undefined ? {} : { params }),
          }),
        })
        return handleMcpHttpRequest(request, { tenantId: scopeTenantId })
      }

      const disabledResponse = await rpc(tenantId, 'disabled', 'tools/list')
      expect(disabledResponse.status).toBe(401)

      const activated = await activateClientMcpCredentialAction({
        operationId: randomUUID(),
        tenantId,
        clientId: tenantId,
        venueId: null,
        actor,
        credentialId: issued.credential.id,
        expectedUpdatedAt: issued.credential.updatedAt,
        capabilities: issued.credential.capabilities,
      })
      expect(activated.credential.enabled).toBe(true)

      const initialize = await rpc(tenantId, 'init', 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'disposable-proof', version: '1' },
      })
      expect(initialize.status).toBe(200)
      const initializeBody = (await initialize.json()) as RpcBody
      expect(initializeBody.result?.protocolVersion).toBe('2025-06-18')
      const listed = await rpc(tenantId, 'tools', 'tools/list')
      const listedBody = (await listed.json()) as RpcBody
      const listedNames = listedBody.result?.tools?.map((tool) => tool.name) ?? []
      expect(listedNames).toEqual(
        expect.arrayContaining([
          'torchiko.venues.list',
          'torchiko.venues.create',
          'torchiko.appearance.get',
          'torchiko.appearance.update',
        ]),
      )

      const createInput = {
        clientId: tenantId,
        operationId: randomUUID(),
        name: 'Disposable Visitor Venue',
        slug: `disposable-${suffix}`,
        guideMode: 'non_location',
      }
      const created = await rpc(tenantId, 'create', 'tools/call', {
        name: 'torchiko.venues.create',
        arguments: createInput,
      })
      const createdBody = (await created.json()) as RpcBody
      expect(createdBody.error).toBeUndefined()
      const venueId = createdBody.result?.structuredContent?.data.id as string
      const venues = await rpc(tenantId, 'venues', 'tools/call', {
        name: 'torchiko.venues.list',
        arguments: { clientId: tenantId, limit: 100 },
      })
      const venuesBody = (await venues.json()) as RpcBody
      const venueRows = venuesBody.result?.structuredContent?.data.venues as Array<{ id: string }>
      expect(venueRows.map((venue) => venue.id)).toContain(venueId)

      const appearance = await rpc(tenantId, 'appearance', 'tools/call', {
        name: 'torchiko.appearance.get',
        arguments: { clientId: tenantId, venueId },
      })
      const appearanceBody = (await appearance.json()) as RpcBody
      const appearanceData = appearanceBody.result?.structuredContent?.data
      expect(appearanceData?.chatTheme).toBeTruthy()
      const operationId = randomUUID()
      const updateInput = {
        clientId: tenantId,
        venueId,
        operationId,
        expectedUpdatedAt: appearanceData?.updatedAt as string,
        title: 'Visitor Welcome',
      }
      const update = await rpc(tenantId, 'update', 'tools/call', {
        name: 'torchiko.appearance.update',
        arguments: updateInput,
      })
      const updateBody = (await update.json()) as RpcBody
      const updateData = updateBody.result?.structuredContent?.data
      const updatedAppearance = updateData?.chatAppearance as { title?: string } | undefined
      expect(updatedAppearance?.title).toBe('Visitor Welcome')
      expect(updateData?.replayed).toBe(false)
      const replay = await rpc(tenantId, 'replay', 'tools/call', {
        name: 'torchiko.appearance.update',
        arguments: updateInput,
      })
      const replayBody = (await replay.json()) as RpcBody
      expect(replayBody.result?.structuredContent?.data.replayed).toBe(true)

      const crossTenant = await rpc(`other-${suffix}`, 'cross', 'tools/list')
      expect(crossTenant.status).toBe(401)
      const revoked = await revokeExternalCredentialAction({
        operationId: randomUUID(),
        tenantId,
        clientId: tenantId,
        venueId: null,
        actor,
        credentialId: activated.credential.id,
        expectedUpdatedAt: activated.credential.updatedAt,
        reasonCode: 'DISPOSABLE_TEST_COMPLETE',
      })
      expect(revoked.credential.enabled).toBe(false)
      const afterRevoke = await rpc(tenantId, 'revoked', 'tools/list')
      expect(afterRevoke.status).toBe(401)
    })
  })
})
