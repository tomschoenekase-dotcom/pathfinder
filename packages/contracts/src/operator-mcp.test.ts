import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  OPERATOR_ALWAYS_ASK_TOOLS,
  OPERATOR_CONTROL_TOOL_NAMES,
  OPERATOR_MCP_INPUTS,
  OPERATOR_MCP_OUTPUTS,
  OPERATOR_MCP_TOOLS,
  OPERATOR_PLAN_STEP_TOOLS,
  OPERATOR_READ_TOOL_NAMES,
  OPERATOR_WRITE_TOOL_NAMES,
  OperatorCapability,
  OperatorWriteResult,
  UntrustedText,
  getOperatorToolDefinition,
  type OperatorToolName,
} from './operator-mcp'

const EXPECTED_TOOLS = [
  'crm.search_organizations',
  'crm.get_organization',
  'crm.list_candidates',
  'crm.get_contact_history',
  'crm.check_can_contact',
  'venues.list',
  'venues.get_readiness',
  'appearance.get',
  'support.list',
  'operator.get_manual',
  'operator.get_proposal',
  'operator.list_proposals',
  'operator.get_autonomy',
  'operator.get_context',
  'operator.get_operation',
  'operator.list_plans',
  'customers.list',
  'crm.list_campaigns',
  'crm.list_campaign_members',
  'crm.resolve_account',
  'crm.get_account_context',
  'crm.list_contacts',
  'crm.list_notes',
  'operator.cancel_operation',
  'operator.recover_operation',
  'crm.propose_campaign_membership',
  'crm.propose_outreach_draft',
  'crm.propose_stage_change',
  'crm.log_outreach_sent',
  'venues.propose_create',
  'venues.propose_source',
  'venues.propose_knowledge',
  'venues.propose_publish',
  'appearance.propose_update',
  'customers.propose_invite',
  'support.propose_triage',
  'operator.propose_plan',
  'operator.propose_revert',
]

const FORBIDDEN = /send|charge|delete|autonomy|approved/iu
const OPERATION_ID = '3f2b8a52-6c1e-4f5e-9d8a-1b2c3d4e5f60'
const TS = '2026-09-30T12:00:00.000Z'

/** Every property key in an input/output JSON schema, recursively. Free-form maps add none. */
function schemaKeys(schema: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    schema.forEach((item) => schemaKeys(item, into))
  } else if (schema && typeof schema === 'object') {
    const record = schema as Record<string, unknown>
    const properties = record.properties
    if (properties && typeof properties === 'object') {
      for (const [key, value] of Object.entries(properties)) {
        into.add(key)
        schemaKeys(value, into)
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (key !== 'properties') schemaKeys(value, into)
    }
  }
  return into
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema
  while (current instanceof z.ZodEffects) current = current.innerType()
  return current
}

describe('operator MCP catalog', () => {
  it('exposes exactly the expected tool names, once each', () => {
    const names = OPERATOR_MCP_TOOLS.map((tool) => tool.name)
    expect([...names].sort()).toEqual([...EXPECTED_TOOLS].sort())
    expect(new Set(names).size).toBe(names.length)
    expect(
      [
        ...OPERATOR_READ_TOOL_NAMES,
        ...OPERATOR_WRITE_TOOL_NAMES,
        ...OPERATOR_CONTROL_TOOL_NAMES,
      ].sort(),
    ).toEqual([...EXPECTED_TOOLS].sort())
    expect(Object.keys(OPERATOR_MCP_INPUTS).sort()).toEqual([...EXPECTED_TOOLS].sort())
    expect(Object.keys(OPERATOR_MCP_OUTPUTS).sort()).toEqual([...EXPECTED_TOOLS].sort())
  })

  it('has no forbidden write tool name and no forbidden schema property key', () => {
    for (const name of OPERATOR_WRITE_TOOL_NAMES) expect(name).not.toMatch(FORBIDDEN)
    // The only tool name allowed to mention autonomy is the read-only view.
    const autonomyNames = OPERATOR_MCP_TOOLS.filter((tool) => /autonomy/iu.test(tool.name))
    expect(autonomyNames.map((tool) => [tool.name, tool.effect])).toEqual([
      ['operator.get_autonomy', 'read'],
    ])
    for (const tool of OPERATOR_MCP_TOOLS) {
      for (const key of schemaKeys(tool.inputSchema))
        expect(key, `${tool.name} input`).not.toMatch(FORBIDDEN)
      for (const key of schemaKeys(tool.outputSchema))
        expect(key, `${tool.name} output`).not.toMatch(FORBIDDEN)
    }
  })

  it('classifies effects, annotations, capabilities and scopes', () => {
    for (const tool of OPERATOR_MCP_TOOLS) {
      const isRead = (OPERATOR_READ_TOOL_NAMES as readonly string[]).includes(tool.name)
      const isControl = (OPERATOR_CONTROL_TOOL_NAMES as readonly string[]).includes(tool.name)
      expect(tool.effect).toBe(isRead ? 'read' : isControl ? 'control' : 'proposal')
      expect(tool.annotations.readOnlyHint).toBe(isRead)
      expect(tool.annotations.destructiveHint).toBe(false)
      expect(tool.annotations.openWorldHint).toBe(false)
      expect(OperatorCapability.safeParse(tool.capability).success).toBe(true)
      expect(['platform', 'tenant', 'venue']).toContain(tool.scope)
      expect(Boolean(tool.proposalKind)).toBe(!isRead && !isControl)
      if (isRead) expect(tool.capability).toMatch(/:read$/u)
    }
    const kinds = OPERATOR_MCP_TOOLS.flatMap((tool) =>
      tool.proposalKind ? [tool.proposalKind] : [],
    )
    expect(new Set(kinds).size).toBe(kinds.length)
  })

  it('agrees on required keys between every JSON input schema and its zod schema', () => {
    for (const tool of OPERATOR_MCP_TOOLS) {
      const json = tool.inputSchema as { required: string[]; properties: Record<string, unknown> }
      const zodSchema = OPERATOR_MCP_INPUTS[tool.name]
      const shape = (unwrap(zodSchema) as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>
      expect(Object.keys(json.properties).sort(), `${tool.name} keys`).toEqual(
        Object.keys(shape).sort(),
      )

      // Independent behavioural check: parsing {} must complain about exactly the required keys.
      const result = zodSchema.safeParse({})
      const missing = result.success
        ? []
        : result.error.issues
            .filter((issue) => issue.code === 'invalid_type' && issue.path.length === 1)
            .map((issue) => String(issue.path[0]))
      expect([...missing].sort(), `${tool.name} required`).toEqual([...json.required].sort())
    }
  })

  it('agrees on required keys for every output schema too', () => {
    for (const tool of OPERATOR_MCP_TOOLS) {
      const json = tool.outputSchema as { required: string[] }
      const result = OPERATOR_MCP_OUTPUTS[tool.name].safeParse({})
      const missing = result.success
        ? []
        : result.error.issues.filter((i) => i.path.length === 1).map((i) => String(i.path[0]))
      expect([...missing].sort(), `${tool.name} output required`).toEqual([...json.required].sort())
    }
  })

  it('requires an operationId uuid on every write and on no read', () => {
    for (const tool of OPERATOR_MCP_TOOLS) {
      const json = tool.inputSchema as { required: string[] }
      // Only proposals carry an operationId. Controls name the earlier operation by
      // originalOperationId and are naturally idempotent.
      expect(json.required.includes('operationId')).toBe(tool.effect === 'proposal')
    }
    expect(
      OPERATOR_MCP_INPUTS['crm.propose_campaign_membership'].safeParse({
        organizationId: 'o1',
        campaignId: 'c1',
        operationId: 'not-a-uuid',
      }).success,
    ).toBe(false)
  })

  it('returns the write result shape from every write tool', () => {
    for (const name of OPERATOR_WRITE_TOOL_NAMES) {
      expect(OPERATOR_MCP_OUTPUTS[name]).toBe(OperatorWriteResult)
    }
    const hash = 'a'.repeat(64)
    expect(
      OperatorWriteResult.safeParse({ proposalId: 'p1', status: 'PENDING', argsHash: hash })
        .success,
    ).toBe(true)
    expect(
      OperatorWriteResult.safeParse({ proposalId: 'p1', status: 'SENT', argsHash: hash }).success,
    ).toBe(false)
    expect(
      OperatorWriteResult.safeParse({ proposalId: 'p1', status: 'PENDING', argsHash: 'short' })
        .success,
    ).toBe(false)
  })

  it('marks retrieved text as untrusted', () => {
    expect(UntrustedText.safeParse({ untrusted: true, text: 'x', truncated: false }).success).toBe(
      true,
    )
    expect(UntrustedText.safeParse({ untrusted: false, text: 'x', truncated: false }).success).toBe(
      false,
    )
    expect(UntrustedText.safeParse({ text: 'x', truncated: false }).success).toBe(false)
  })

  it('lists the always-ask tools as write tools', () => {
    for (const name of OPERATOR_ALWAYS_ASK_TOOLS) {
      expect((OPERATOR_WRITE_TOOL_NAMES as readonly string[]).includes(name)).toBe(true)
    }
    expect([...OPERATOR_ALWAYS_ASK_TOOLS]).toEqual([
      'customers.propose_invite',
      'operator.propose_revert',
    ])
  })

  it('looks tools up by name', () => {
    expect(getOperatorToolDefinition('appearance.get')?.scope).toBe('venue')
    expect(getOperatorToolDefinition('crm.send_email')).toBeUndefined()
  })
})

describe('operator MCP inputs', () => {
  it('rejects unknown keys on every tool', () => {
    for (const name of Object.keys(OPERATOR_MCP_INPUTS) as OperatorToolName[]) {
      const result = OPERATOR_MCP_INPUTS[name].safeParse({ unexpectedKey: 1 })
      expect(result.success).toBe(false)
    }
    expect(OPERATOR_MCP_INPUTS['operator.get_manual'].safeParse({ extra: true }).success).toBe(
      false,
    )
    expect(OPERATOR_MCP_INPUTS['operator.get_manual'].safeParse({}).success).toBe(true)
  })

  it('bounds page limits at 25 and defaults to 25', () => {
    const schema = OPERATOR_MCP_INPUTS['crm.search_organizations']
    expect(schema.parse({ query: 'museum' }).limit).toBe(25)
    expect(schema.safeParse({ query: 'museum', limit: 26 }).success).toBe(false)
    expect(schema.safeParse({ query: 'museum', limit: 0 }).success).toBe(false)
    expect(OPERATOR_MCP_INPUTS['crm.list_candidates'].safeParse({ limit: 26 }).success).toBe(false)
    expect(
      OPERATOR_MCP_INPUTS['crm.list_candidates'].safeParse({ uncontacted: true }).success,
    ).toBe(true)
  })

  it('bounds draft, venue and source fields', () => {
    const draft = { campaignMemberId: 'm1', operationId: OPERATION_ID }
    const schema = OPERATOR_MCP_INPUTS['crm.propose_outreach_draft']
    expect(
      schema.safeParse({ ...draft, subject: 's'.repeat(200), textBody: 'b'.repeat(8000) }).success,
    ).toBe(true)
    expect(schema.safeParse({ ...draft, subject: 's'.repeat(201), textBody: 'b' }).success).toBe(
      false,
    )
    expect(schema.safeParse({ ...draft, subject: 's', textBody: 'b'.repeat(8001) }).success).toBe(
      false,
    )

    const create = OPERATOR_MCP_INPUTS['venues.propose_create']
    expect(
      create.safeParse({ tenantId: 't', name: 'n'.repeat(121), operationId: OPERATION_ID }).success,
    ).toBe(false)
    expect(
      create.safeParse({ tenantId: 't', name: 'Example Venue', operationId: OPERATION_ID }).success,
    ).toBe(true)

    const source = OPERATOR_MCP_INPUTS['venues.propose_source']
    const base = { tenantId: 't', venueId: 'v', operationId: OPERATION_ID }
    expect(source.safeParse({ ...base, url: 'https://example.com/a' }).success).toBe(true)
    expect(source.safeParse({ ...base, url: 'http://example.com/a' }).success).toBe(false)
    expect(source.safeParse({ ...base, url: 'javascript:alert(1)' }).success).toBe(false)

    const knowledge = OPERATOR_MCP_INPUTS['venues.propose_knowledge']
    const entry = { title: 'Hours', body: 'Open daily' }
    expect(knowledge.safeParse({ ...base, entries: Array(50).fill(entry) }).success).toBe(true)
    expect(knowledge.safeParse({ ...base, entries: Array(51).fill(entry) }).success).toBe(false)
  })

  it('reuses the appearance update rules', () => {
    const schema = OPERATOR_MCP_INPUTS['appearance.propose_update']
    const base = { tenantId: 't', venueId: 'v', operationId: OPERATION_ID, expectedUpdatedAt: TS }
    expect(schema.safeParse(base).success).toBe(false)
    expect(schema.safeParse({ ...base, chatTheme: 'forest' }).success).toBe(true)
    expect(schema.safeParse({ ...base, chatTheme: 'neon' }).success).toBe(false)
    expect(schema.safeParse({ ...base, chatAccentColor: '#12ab34' }).success).toBe(true)
    expect(schema.safeParse({ ...base, chatAccentColor: 'red' }).success).toBe(false)
    expect(schema.safeParse({ ...base, clientId: 'c', chatTheme: 'forest' }).success).toBe(false)
  })

  it('accepts a valid plan and enforces step rules', () => {
    const schema = OPERATOR_MCP_INPUTS['operator.propose_plan']
    const plan = (steps: unknown[]) => ({
      title: 'Set up a client',
      operationId: OPERATION_ID,
      steps,
    })
    const create = { tool: 'venues.propose_create', arguments: { tenantId: 't', name: 'Example' } }
    const source = {
      tool: 'venues.propose_source',
      arguments: { venueId: '{{steps.0.result.venueId}}', url: 'https://example.com' },
      dependsOn: [0],
    }
    expect(schema.safeParse(plan([create, source])).success).toBe(true)
    expect(schema.safeParse(plan([])).success).toBe(false)
    expect(schema.safeParse(plan(Array(13).fill(create))).success).toBe(false)
    expect(schema.safeParse(plan(Array(12).fill(create))).success).toBe(true)
    // dependsOn must point at an earlier step
    expect(schema.safeParse(plan([{ ...create, dependsOn: [0] }])).success).toBe(false)
    expect(schema.safeParse(plan([create, { ...source, dependsOn: [1] }])).success).toBe(false)
    expect(schema.safeParse(plan([create, { ...source, dependsOn: [0, 0] }])).success).toBe(false)
    expect(schema.safeParse(plan([create, { ...source, dependsOn: [2] }])).success).toBe(false)
    // no nested plans, reverts, or unknown tools
    for (const tool of [
      'operator.propose_plan',
      'operator.propose_revert',
      'crm.send_email',
      'venues.list',
    ]) {
      expect(schema.safeParse(plan([{ tool, arguments: {} }])).success, tool).toBe(false)
    }
    expect(OPERATOR_PLAN_STEP_TOOLS).toHaveLength(OPERATOR_WRITE_TOOL_NAMES.length - 2)
  })

  it('validates log_outreach_sent and stage change inputs', () => {
    const log = OPERATOR_MCP_INPUTS['crm.log_outreach_sent']
    const base = {
      organizationId: 'o',
      contactId: 'c',
      gmailMessageId: 'g1',
      operationId: OPERATION_ID,
    }
    expect(log.safeParse({ ...base, sentAt: TS }).success).toBe(true)
    expect(log.safeParse({ ...base, sentAt: 'yesterday' }).success).toBe(false)
    const stage = OPERATOR_MCP_INPUTS['crm.propose_stage_change']
    expect(
      stage.safeParse({
        organizationId: 'o',
        expectedVersion: 1,
        stage: 'WON',
        operationId: OPERATION_ID,
      }).success,
    ).toBe(true)
    expect(
      stage.safeParse({
        organizationId: 'o',
        expectedVersion: 0,
        stage: 'WON',
        operationId: OPERATION_ID,
      }).success,
    ).toBe(false)
    expect(
      stage.safeParse({
        organizationId: 'o',
        expectedVersion: 1,
        stage: 'SENT',
        operationId: OPERATION_ID,
      }).success,
    ).toBe(false)
  })

  it('normalizes emails for the contact check', () => {
    const schema = OPERATOR_MCP_INPUTS['crm.check_can_contact']
    expect(schema.parse({ email: ' Person@Example.com ' })).toEqual({ email: 'person@example.com' })
    expect(schema.safeParse({ email: 'nope' }).success).toBe(false)
  })
})

describe('operator MCP truthful outcome semantics', () => {
  it('describes availability-only publish and non-atomic plans honestly', () => {
    const publish = getOperatorToolDefinition('venues.propose_publish')!
    expect(publish.description).toMatch(/availability only/i)
    expect(publish.description).not.toMatch(/Propose publishing a venue/)
    const plan = getOperatorToolDefinition('operator.propose_plan')!
    expect(plan.description).toMatch(/earlier applied steps stay applied/i)
  })

  it('lets support.list report an unrecorded priority as null, not a default', () => {
    const page = OPERATOR_MCP_OUTPUTS['support.list']
    const item = {
      requestId: 'req_1',
      venueId: 'venue_1',
      status: 'OPEN',
      priority: null,
      updatedAt: '2026-09-30T12:00:00.000Z',
      subject: { untrusted: true, text: 'x', truncated: false },
    }
    expect(page.safeParse({ items: [item], nextCursor: null, complete: true }).success).toBe(true)
  })
})
