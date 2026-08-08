import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const adminDirectory = path.join(repositoryRoot, 'packages/api/src/routers/admin')

const expectedAdminProcedures = [
  'addChatlogNote',
  'createClient',
  'createClientAndVenue',
  'generateAnswerAnalysis',
  'generateWeeklyReportDraft',
  'getAnswerAnalysis',
  'getClient',
  'getClientAiCosts',
  'getClientAnalytics',
  'getClientVenue',
  'getSessionChatlog',
  'getVenueReportConfiguration',
  'getWeeklyReport',
  'listAnswerAnalyses',
  'listClients',
  'listVenueSessions',
  'listWeeklyReports',
  'overview',
  'ping',
  'publishWeeklyReport',
  'setSessionNotable',
  'setTenantPaymentDue',
  'triggerDigest',
  'updateClientPlanTier',
  'updateClientStatus',
  'updateVenueReportConfiguration',
  'updateWeeklyReportDraft',
]

const expectedMediaProcedures = [
  'abortUpload',
  'beginUpload',
  'completeUpload',
  'create',
  'expireAbandonedUploads',
  'get',
  'list',
  'reconcileUpload',
  'retryEnqueue',
  'saveReview',
  'signPart',
]

function procedureNames(source) {
  return [...source.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]+): adminProcedure/gmu)].map(
    (match) => match[1],
  )
}

test('platform-admin routers stay domain-split without changing their public procedure inventory', async () => {
  const entries = await readdir(adminDirectory, { withFileTypes: true })
  const productionRouterFiles = entries
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'),
    )
    .map((entry) => entry.name)

  const adminProcedures = []
  const mediaProcedures = []

  for (const fileName of productionRouterFiles) {
    const source = await readFile(path.join(adminDirectory, fileName), 'utf8')
    const lineCount = source.split(/\r?\n/u).length - 1
    assert.ok(lineCount <= 400, `${fileName} has ${lineCount} lines; split it by domain`)

    const target = fileName.startsWith('media-ingestion-') ? mediaProcedures : adminProcedures
    target.push(...procedureNames(source))
  }

  assert.deepEqual(adminProcedures.sort(), expectedAdminProcedures)
  assert.deepEqual(mediaProcedures.sort(), expectedMediaProcedures)

  for (const composer of ['_admin.ts', 'media-ingestion.ts']) {
    const source = await readFile(path.join(adminDirectory, composer), 'utf8')
    assert.match(source, /mergeRouters\(/u, `${composer} must compose its domain routers`)
    assert.equal(procedureNames(source).length, 0, `${composer} must not regain inline procedures`)
  }
})
