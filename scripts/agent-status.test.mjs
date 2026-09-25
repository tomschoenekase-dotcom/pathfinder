import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAgentStatus } from './agent-status.mjs'

test('agent entry status does not turn implementation into live provider or mailbox proof', async () => {
  const report = await buildAgentStatus()
  const byId = Object.fromEntries(report.capabilities.map((item) => [item.id, item]))
  assert.equal(byId['source-code'].status, 'AVAILABLE')
  for (const id of ['crm', 'company-mailbox', 'hosted-staging', 'hermes-bridge']) {
    assert.notEqual(byId[id].status, 'AVAILABLE')
  }
  assert.equal(byId['production-release'].status, 'WRITE_REQUIRES_APPROVAL')
  assert.equal(byId['customer-contact'].status, 'WRITE_REQUIRES_APPROVAL')
  assert.match(report.repository.commit, /^[a-f0-9]{40}$/u)
  assert.doesNotMatch(JSON.stringify(report), /DATABASE_URL|GMAIL|SECRET_KEY|ACCESS_TOKEN/u)
})
