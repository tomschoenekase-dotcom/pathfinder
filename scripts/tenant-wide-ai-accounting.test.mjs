import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const weeklyDigest = await readFile(
  new URL('../apps/workers/src/processors/weekly-digest.ts', import.meta.url),
  'utf8',
)
const workerAccounting = await readFile(
  new URL('../apps/workers/src/lib/ai-usage.ts', import.meta.url),
  'utf8',
)
const costBudgetApi = await readFile(
  new URL('../packages/api/src/routers/admin/cost-budget.ts', import.meta.url),
  'utf8',
)
const migration = await readFile(
  new URL(
    '../packages/db/prisma/migrations/20260901020000_support_tenant_wide_ai_accounting/migration.sql',
    import.meta.url,
  ),
  'utf8',
)

test('weekly digest uses durable tenant-wide usage and budget accounting', () => {
  assert.doesNotMatch(weeklyDigest, /NOOP_AI_BUDGET_GATE/u)
  assert.doesNotMatch(weeklyDigest, /ai-usage-unattributed/u)
  assert.match(weeklyDigest, /createTenantWideWorkerAiUsageSink\(\{/u)
  assert.match(weeklyDigest, /createTenantWideWorkerAiBudgetGate\(\{/u)
  assert.match(workerAccounting, /createTenantWideWorkerAiUsageSink/u)
  assert.match(workerAccounting, /createTenantWideWorkerAiBudgetGate/u)
  assert.match(workerAccounting, /venueId: null/u)
  assert.match(costBudgetApi, /excludedProviderPaths: \[\] as const/u)
})

test('tenant-wide accounting remains explicitly nullable and replay-safe', () => {
  assert.equal(migration.match(/ALTER COLUMN "venue_id" DROP NOT NULL/gu)?.length, 3)
  assert.match(migration, /ai_usage_events_tenant_wide_scope_check/u)
  assert.match(migration, /ai_usage_events_tenant_provider_request_key/u)
  assert.match(migration, /ai_usage_daily_rollups_tenant_wide_key/u)
})
