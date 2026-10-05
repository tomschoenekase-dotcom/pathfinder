import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workflow = readFileSync(new URL('../.github/workflows/staging-admission.yml', import.meta.url), 'utf8').replace(/\r\n/gu, '\n')

test('project-scoped admission avoids account workspace enumeration', () => {
  assert.doesNotMatch(workflow, /pnpm dlx @railway\/cli@[^\s]+ link\b/u)
  assert.match(workflow, /RAILWAY_TOKEN: \$\{\{ secrets\.RAILWAY_STAGING_READ_TOKEN \}\}/u)
  assert.doesNotMatch(workflow, /RAILWAY_API_TOKEN/u)
})

test('topology readback remains pinned to the exact staging project and environment', () => {
  assert.match(workflow, /status \\\n\s+--project 8621111a-4ac8-4d88-9566-4627c8a02059 \\\n\s+--environment a7a394fc-aa4e-4a45-bd3c-904419a67818 \\\n\s+--json > "\$topology" &&/u)
})

test('trusted code and exact candidate three-service admission remain mandatory', () => {
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/u)
  assert.match(workflow, /RELEASE_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/u)
  assert.match(workflow, /pnpm staging:admit \\\n\s+--topology-file "\$topology"/u)
  assert.match(workflow, /--expected-revision "\$RELEASE_SHA"/u)
  for (const resource of ['7bd81064-588f-48a5-b138-1fc86691a09b', 'd53ab235-d403-4d7d-b525-3ace0ef07b92', '0a9b3c58-0c9e-47de-96ae-38df297996e8']) assert.ok(workflow.includes(resource))
  assert.doesNotMatch(workflow, /continue-on-error|railway\/cli@[^\s]+ (?:up|redeploy|deploy)\b/u)
})
