import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TENANTED_TABLES } from '../tenanted-tables'

const sql = readFileSync(
  resolve(
    __dirname,
    '../../prisma/migrations/20260907022300_add_agent_workflow_activations/migration.sql',
  ),
  'utf8',
)

describe('workflow activation migration contract', () => {
  it('registers all scoped models and immutable evidence tables', () => {
    expect(TENANTED_TABLES).toEqual(
      expect.arrayContaining([
        'AgentWorkflowActivationHead',
        'AgentWorkflowActivationEvent',
        'AgentWorkflowRunBinding',
      ]),
    )
    expect(sql).toContain('agent_workflow_activation_events_immutable')
    expect(sql).toContain('agent_workflow_run_bindings_immutable')
  })
  it('enforces scoped run/event/version foreign keys and selection shape', () => {
    expect(sql).toContain('agent_workflow_run_bindings_outcome_check')
    expect(sql).toContain('FOREIGN KEY ("agent_run_id", "tenant_id", "venue_id")')
    expect(sql).toContain(
      'FOREIGN KEY ("activation_event_id", "tenant_id", "venue_id", "registry_key")',
    )
  })
})
