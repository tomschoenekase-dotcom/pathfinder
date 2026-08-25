import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ignoredDirectories = new Set(['.git', '.next', '.turbo', 'dist', 'node_modules'])
const sourceExtensions = new Set(['.ts', '.tsx'])
const bypassName = 'withTenantIsolationBypass'
const definitionPath = 'packages/db/src/middleware/tenant-isolation.ts'
const reexportPath = 'packages/db/src/index.ts'

// Exact counts make additions and removals review events without relying on line numbers.
const approvedCallCounts = new Map([
  ['apps/workers/src/scheduled-tenant-fanout.ts', 1],
  // Platform recovery scans only bounded authoritative upload identities; each
  // job then re-enters one exact tenant+venue+upload scope before mutation.
  ['apps/workers/src/processors/intake-upload-verification.ts', 1],
  ['apps/workers/src/processors/analytics-enrichment.ts', 1],
  ['apps/workers/src/processors/answer-analysis.ts', 2],
  ['apps/workers/src/processors/daily-rollup.ts', 3],
  ['apps/workers/src/processors/embed-knowledge-entry.ts', 1],
  // Company Knowledge embedding claims are platform-dispatched, then re-enter
  // the exact tenant+venue scope before selecting or persisting content.
  ['apps/workers/src/processors/embed-company-knowledge.ts', 1],
  ['apps/workers/src/processors/embed-place.ts', 1],
  ['apps/workers/src/processors/media-ingestion.ts', 9],
  ['apps/workers/src/lib/media-provider-budget.ts', 1],
  ['apps/workers/src/processors/weekly-digest.ts', 3],
  ['apps/workers/src/processors/weekly-report.ts', 2],
  ['apps/workers/src/processors/evaluation-dispatch.ts', 2],
  // Platform prospect worker rechecks one immutable approved send item; it does not enter tenant scope.
  ['apps/workers/src/processors/send-prospect-outreach.ts', 1],
  ['apps/workers/src/processors/gmail-sync.ts', 4],
  // Platform maintenance scans a bounded set of STALE summaries, then each
  // canonical refresh re-enters one exact tenant+organization scope.
  ['apps/workers/src/processors/account-summary-refresh.ts', 1],
  // Worker reconciles approved-package onboarding milestones for the exact job tenant+venue.
  ['apps/workers/src/processors/evaluation-run.ts', 9],
  // Platform worker scans a bounded cross-tenant outbox and each delivery action retains tenant scope.
  ['apps/workers/src/processors/operational-event-delivery.ts', 4],
  ['packages/api/src/routers/admin/answer-analysis.ts', 3],
  // Platform-admin-only attribution recording and listing retain exact tenant, venue, and turn scope.
  ['packages/api/src/routers/admin/guest-answer-attributions.ts', 2],
  ['packages/api/src/routers/admin/attention-console.ts', 1],
  // Platform-admin unit economics aggregates cross-tenant AI usage and append-only
  // operating-cost evidence; the write binds the authenticated human actor and
  // cannot alter invoices, customer pricing, anomaly policy, or service state.
  ['packages/api/src/routers/admin/unit-economics.ts', 2],
  // Platform-admin-only exact incident correlation reads one event, its latest scoped guest turn,
  // and explicitly referenced sanitized usage rows; successful access is strictly audited.
  ['packages/api/src/routers/admin/guest-chat-incident-evidence.ts', 3],
  ['packages/api/src/routers/admin/attention-event-actions.ts', 2],
  // Platform-admin-only bounded readiness projection over platform-wide operational evidence.
  ['packages/api/src/routers/admin/operations-readiness.ts', 1],
  // Separately authenticated platform worker reads the same bounded readiness projection.
  ['packages/api/src/platform-worker-policy/operations-readiness-http.ts', 1],
  ['packages/api/src/routers/admin/agent-operations.ts', 6],
  // Platform-admin run trace merges bounded summaries for one exact tenant+venue+run.
  ['packages/api/src/routers/admin/agent-run-trace.ts', 1],
  ['packages/api/src/routers/admin/agent-identity-reads.ts', 2],
  // Platform-admin reads policy-backed draft authority only within one exact tenant+venue scope.
  ['packages/api/src/routers/admin/agent-approval-policy-reads.ts', 1],
  ['packages/api/src/routers/admin/agent-bridge-operations.ts', 2],
  ['packages/api/src/routers/admin/agent-run-cancellation.ts', 1],
  // Identity configuration includes human-only policy issuance/revocation for one exact venue.
  ['packages/api/src/routers/admin/agent-identity-configuration.ts', 9],
  // Human-only issuance of one-use support-opening and exact-triage authority is exact-tenant and
  // exact-venue scoped; approval and grant issuance remain atomic and do not execute the action.
  ['packages/api/src/routers/admin/support-open-policy.ts', 4],
  ['packages/api/src/routers/admin/support-completion-approval.ts', 1],
  // Founder decision records and derives one exact DRAFT-only package grant atomically;
  // the route cannot itself create, approve, apply, publish, or deliver a package.
  ['packages/api/src/routers/admin/support-package-draft-approval.ts', 2],
  // Founder decision records and derives one exact current-content package application grant;
  // the route never executes the mutation, completes support, contacts customers, or reverts.
  ['packages/api/src/routers/admin/support-package-application-approval.ts', 1],
  // Founder decision records and derives one exact APPLIED-package reversion grant;
  // the route never executes the reversion, changes support state, or contacts customers.
  ['packages/api/src/routers/admin/support-package-reversion-approval.ts', 1],
  ['packages/api/src/routers/admin/support-package-handoff-supersession-approval.ts', 1],
  ['packages/api/src/routers/admin/agent-approval-decisions.ts', 1],
  // Platform-admin operator inbox reads and answers exact tenant+venue agent questions.
  ['packages/api/src/routers/admin/agent-question-client-routing.ts', 2],
  ['packages/api/src/routers/admin/agent-questions.ts', 4],
  // The reviewed improvement loop uses an additional exact-scope bypass to append
  // validation evidence; it cannot promote behavior or change worker authority.
  ['packages/api/src/routers/admin/agent-outcomes.ts', 5],
  // Platform-admin task composer queues one exact tenant+venue run without provider execution.
  ['packages/api/src/routers/admin/agent-task-requests.ts', 1],
  ['packages/api/src/routers/admin/chatlogs.ts', 4],
  ['packages/api/src/routers/admin/client-analytics.ts', 2],
  // Platform-admin client lifecycle includes an exact-tenant payment-due mutation.
  ['packages/api/src/routers/admin/client-management.ts', 8],
  // A retry-fenced platform-admin client creation binds exact prospect/customer continuity.
  ['packages/api/src/routers/admin/client-prospect-conversion.ts', 1],
  ['packages/api/src/routers/admin/client-search.ts', 1],
  ['packages/api/src/routers/admin/client-directory-search.ts', 1],
  // Platform-admin reads include one exact tenant+venue onboarding/character detail projection.
  ['packages/api/src/routers/admin/client-reads.ts', 3],
  // Platform-admin billing portfolio intentionally aggregates customer billing and CRM links.
  ['packages/api/src/routers/admin/billing-portfolio.ts', 1],
  // Platform-admin Company Brain browse/create operations are bounded, audited,
  // and use canonical knowledge actions rather than direct agent-side writes.
  ['packages/api/src/routers/admin/company-brain.ts', 6],
  // Founder-only billing rollout reads and changes only allowlisted flags for one exact tenant;
  // the mutation records the platform-admin actor and before/after state in the same transaction.
  ['packages/api/src/routers/admin/billing-rollout.ts', 2],
  ['packages/api/src/routers/admin/cost-budget.ts', 3],
  ['packages/api/src/routers/admin/digest.ts', 1],
  // Exact platform-admin tenant+venue scope: persist artifact, project FULL, and review manifest.
  ['packages/api/src/routers/admin/deployment-manifest-review.ts', 3],
  // Platform-admin-only exact tenant+venue native projection, convergence read, and lifecycle adapters.
  ['packages/api/src/routers/admin/native-venue-deployments.ts', 9],
  // Native advisory evidence plus read-only shadow run discovery/comparison re-enter one exact
  // tenant+venue+release scope; none of these bypasses changes release or guest read-path state.
  ['packages/api/src/routers/admin/native-deployment-evaluations.ts', 4],
  // Native advisory requests freeze one exact tenant+venue release and case set transactionally.
  ['packages/api/src/routers/admin/native-deployment-evaluation-request.ts', 1],
  // Evaluation run creation freezes one exact tenant+venue target and case set transactionally.
  ['packages/api/src/routers/admin/evaluation-operation-actions.ts', 1],
  // Onboarding suite preparation revalidates one exact DRAFT/APPROVED package and writes only
  // immutable tenant+venue evaluation cases; it does not approve, apply, publish, or dispatch.
  ['packages/api/src/routers/admin/evaluation-onboarding-actions.ts', 1],
  // Platform-admin-only source reads and preparation revalidate one exact public insight,
  // tenant, venue, and turn before persisting sanitized immutable evaluation evidence.
  ['packages/api/src/routers/admin/evaluation-conversation-cases.ts', 2],
  // Evaluation comparison uses one additional exact tenant-scoped read.
  ['packages/api/src/routers/admin/evaluation-operations.ts', 3],
  // Platform-admin source-coverage preflight freezes exact scoped public venue content
  // and verifies exact scoped immutable cases; it returns marker evidence only.
  ['packages/api/src/routers/admin/evaluation-source-coverage.ts', 1],
  // Platform-admin onboarding evidence is bounded to the requested tenant+venue and time range.
  ['packages/api/src/routers/admin/evaluation-onboarding-reads.ts', 2],
  // Platform-admin review appends one exact tenant+venue evaluation conclusion.
  ['packages/api/src/routers/admin/evaluation-review-actions.ts', 1],
  ['packages/api/src/routers/admin/freshness-audit.ts', 1],
  // Guest design exposes two platform-admin-only, exact tenant+venue scoped operations.
  ['packages/api/src/routers/admin/guest-design.ts', 2],
  ['packages/api/src/routers/admin/legacy-content.ts', 7],
  // Platform-admin location authoring reads and mutates only one exact tenant+venue workspace;
  // draft edits and availability transitions are CAS-bound, strictly audited, and content-locked.
  ['packages/api/src/routers/admin/location-authoring.ts', 3],
  ['packages/api/src/routers/admin/location-availability.ts', 1],
  ['packages/api/src/routers/admin/location-connection-authoring.ts', 3],
  ['packages/api/src/routers/admin/location-floor-authoring.ts', 3],
  ['packages/api/src/routers/admin/location-proposal-application.ts', 1],
  // Platform-admin proposal review is always constrained to the requested tenant and venue.
  ['packages/api/src/routers/admin/knowledge-proposals.ts', 3],
  // Platform-admin entitlement reads and append-only overrides retain explicit tenant scope.
  ['packages/api/src/routers/admin/product-entitlements.ts', 3],
  // Human platform-admin-only prospect CRM reads/writes. Platform-owned prospect
  // records stay outside tenant scope; conversion validates one exact customer tenant+venue.
  ['packages/api/src/routers/admin/prospect-crm-core.ts', 5],
  ['packages/api/src/routers/admin/prospect-crm-directory.ts', 1],
  ['packages/api/src/routers/admin/prospect-crm-import.ts', 12],
  ['packages/api/src/routers/admin/prospect-crm-import-repair.ts', 2],
  ['packages/api/src/routers/admin/prospect-crm-mutations.ts', 7],
  ['packages/api/src/routers/admin/prospect-crm-saved-views.ts', 3],
  ['packages/api/src/routers/admin/prospect-crm-territories.ts', 1],
  ['packages/api/src/routers/admin/prospect-crm-duplicates.ts', 3],
  // Human platform-admin outreach operations use platform-owned CRM records and only read a
  // converted venue through its exact, already-validated conversion tenant+venue identity.
  ['packages/api/src/routers/admin/prospect-crm-outreach.ts', 15],
  // Extracted platform-admin intelligence read resolves exact converted tenant+venue links.
  ['packages/api/src/routers/admin/prospect-crm-intelligence.ts', 1],
  ['apps/dashboard/app/api/admin/prospect-imports/[importId]/report/route.ts', 2],
  ['apps/dashboard/app/api/integrations/gmail/pubsub/route.ts', 1],
  ['packages/api/src/correspondence/gmail-oauth.ts', 4],
  ['packages/api/src/correspondence/prisma-inbound-store.ts', 11],
  // Capability-checked platform CRM agent tools have no tenant authority or send capability.
  ['packages/api/src/prospect-agent/registry.ts', 1],
  ['packages/api/src/routers/admin/venue-package-operations.ts', 2],
  ['packages/api/src/routers/admin/weekly-report-lifecycle.ts', 1],
  // Exact tenant+venue+report read for a capability-checked machine credential. Raw report
  // content, provider errors, source artifacts, and actor identity remain excluded upstream.
  ['packages/api/src/lib/weekly-report-lifecycle.ts', 1],
  ['packages/db/src/helpers/evaluation-run-lifecycle.ts', 7],
  ['packages/api/src/routers/admin/media-ingestion-begin-upload.ts', 6],
  ['packages/api/src/routers/admin/media-ingestion-abort.ts', 1],
  ['packages/api/src/routers/admin/media-ingestion-complete-upload.ts', 4],
  ['packages/api/src/routers/admin/media-ingestion-expiry.ts', 1],
  ['packages/api/src/routers/admin/media-ingestion-finalization.ts', 2],
  ['packages/api/src/routers/admin/media-ingestion-lifecycle.ts', 5],
  ['packages/api/src/routers/admin/media-ingestion-projects.ts', 8],
  ['packages/api/src/routers/admin/media-ingestion-reconcile-upload.ts', 4],
  ['packages/api/src/routers/admin/overview.ts', 1],
  ['packages/api/src/routers/admin/report-configuration.ts', 2],
  // Platform-admin-only bounded lineage read rechecks exact tenant, venue, and Support request.
  ['packages/api/src/routers/admin/support-agent-run-lineage.ts', 1],
  ['packages/api/src/routers/admin/weekly-reports.ts', 4],
  ['packages/api/src/lib/weekly-report-generation.ts', 1],
  ['packages/api/src/routers/admin/venue-availability.ts', 2],
  ['packages/api/src/routers/admin/second-layer.ts', 2],
  // Founder-only rollout reads and changes exact-tenant, allowlisted Tochi flags.
  ['packages/api/src/routers/admin/tochi-rollout.ts', 2],
  // Job evidence helpers use bounded platform reads for queue/id CLI recovery and the audited
  // admin staging preview; writers and lifecycle updates retain their existing bypasses.
  ['packages/db/src/helpers/job-records.ts', 5],
  // Weekly-report and answer-analysis lease renewal each use one exact tenant-scoped CAS.
  ['packages/db/src/helpers/generation-execution-claims.ts', 8],
  ['packages/db/src/helpers/generation-recovery.ts', 1],
  // Platform maintenance performs one bounded, read-only Gmail retention inventory across
  // prospect organizations. It selects body-presence booleans for aggregate policy evidence and
  // never returns body content or mutates retention state.
  ['packages/db/src/helpers/email-body-retention.ts', 1],
  // Signature-verified Stripe ingress resolves an unknown provider object to one
  // namespaced account; platform-admin manual billing then revalidates exact tenant+venue scope.
  ['packages/billing/src/service.ts', 4],
  // Scheduled billing fanout selects a bounded set of namespaced Stripe accounts;
  // each reconciliation call immediately re-enters one exact tenant scope.
  ['apps/workers/src/processors/billing-reconciliation.ts', 2],
  // Signature-verified Resend events reconcile platform-owned CRM correspondence only.
])

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collectFiles(absolute)))
    else if (sourceExtensions.has(path.extname(entry.name))) files.push(absolute)
  }
  return files
}

function relativePath(absolute) {
  return path.relative(repositoryRoot, absolute).split(path.sep).join('/')
}

function isTestPath(fileName) {
  return /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(fileName)
}

function resolvesToDefinition(specifier, fileName) {
  if (!specifier.startsWith('.')) return false
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fileName), specifier))
  return resolved === definitionPath || `${resolved}.ts` === definitionPath
}

function isApprovedImportSource(specifier, fileName) {
  return specifier === '@pathfinder/db' || resolvesToDefinition(specifier, fileName)
}

function analyzeSource(source, fileName) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const violations = []
  let directImportCount = 0
  let callCount = 0
  let definitionCount = 0
  let reexportCount = 0

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const importSource = node.moduleSpecifier.text
      const namedBindings = node.importClause?.namedBindings
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text
          if (importedName !== bypassName) continue
          if (!isApprovedImportSource(importSource, fileName)) {
            violations.push(`${fileName}: ${bypassName} imported from unapproved '${importSource}'`)
          }
          if (element.name.text !== bypassName) {
            violations.push(`${fileName}: ${bypassName} import may not be aliased`)
          } else if (isApprovedImportSource(importSource, fileName)) {
            directImportCount += 1
          }
        }
      }
      if (
        namedBindings &&
        ts.isNamespaceImport(namedBindings) &&
        isApprovedImportSource(importSource, fileName)
      ) {
        violations.push(`${fileName}: namespace imports from '${importSource}' are not allowed`)
      }
    }

    if (ts.isFunctionDeclaration(node) && node.name?.text === bypassName) {
      definitionCount += 1
      const isExported = node.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      )
      if (fileName !== definitionPath || !isExported) {
        violations.push(`${fileName}: ${bypassName} may be declared only as the exported boundary`)
      }
    }

    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        const importedName = element.propertyName?.text ?? element.name.text
        if (importedName !== bypassName) continue
        reexportCount += 1
        const specifier = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : ''
        if (
          fileName !== reexportPath ||
          element.name.text !== bypassName ||
          !resolvesToDefinition(specifier, fileName)
        ) {
          violations.push(
            `${fileName}: ${bypassName} must use the exact unaliased database re-export`,
          )
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      const dynamicSpecifier = node.arguments[0]
      if (
        (isDynamicImport || isRequire) &&
        dynamicSpecifier &&
        (ts.isStringLiteral(dynamicSpecifier) ||
          ts.isNoSubstitutionTemplateLiteral(dynamicSpecifier)) &&
        isApprovedImportSource(dynamicSpecifier.text, fileName)
      ) {
        violations.push(`${fileName}: dynamic access to the tenant bypass module is not auditable`)
      }

      if (ts.isIdentifier(node.expression) && node.expression.text === bypassName) {
        callCount += 1
        if (
          node.arguments.length !== 1 ||
          (!ts.isArrowFunction(node.arguments[0]) && !ts.isFunctionExpression(node.arguments[0]))
        ) {
          violations.push(
            `${fileName}: ${bypassName} requires exactly one inline function argument`,
          )
        }
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === bypassName
      ) {
        violations.push(`${fileName}: member calls to ${bypassName} are not auditable`)
      }
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === bypassName &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      violations.push(`${fileName}: member references to ${bypassName} are not auditable`)
    }
    if (
      ts.isElementAccessExpression(node) &&
      (ts.isStringLiteral(node.argumentExpression) ||
        ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)) &&
      node.argumentExpression.text === bypassName
    ) {
      violations.push(`${fileName}: element access to ${bypassName} is not auditable`)
    }

    if (
      ts.isIdentifier(node) &&
      node.text === bypassName &&
      !ts.isImportSpecifier(node.parent) &&
      !ts.isExportSpecifier(node.parent) &&
      !(ts.isFunctionDeclaration(node.parent) && node.parent.name === node) &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    ) {
      violations.push(`${fileName}: indirect reference to ${bypassName} is not auditable`)
    }

    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  if (callCount > 0 && directImportCount !== 1) {
    violations.push(
      `${fileName}: ${callCount} bypass call(s) require exactly one approved direct import`,
    )
  }
  if (directImportCount > 0 && callCount === 0) {
    violations.push(`${fileName}: stale ${bypassName} import`)
  }

  return { callCount, definitionCount, reexportCount, violations }
}

function auditInventory(files, expectedCounts) {
  const violations = []
  const observedCounts = new Map()
  let definitionCount = 0
  let reexportCount = 0

  for (const { fileName, source } of files) {
    if (isTestPath(fileName)) continue
    const result = analyzeSource(source, fileName)
    violations.push(...result.violations)
    definitionCount += result.definitionCount
    reexportCount += result.reexportCount
    if (result.callCount > 0) observedCounts.set(fileName, result.callCount)
  }

  if (definitionCount !== 1) {
    violations.push(
      `expected exactly one exported ${bypassName} definition, observed ${definitionCount}`,
    )
  }
  if (reexportCount !== 1) {
    violations.push(
      `expected exactly one exact ${bypassName} database re-export, observed ${reexportCount}`,
    )
  }
  for (const [fileName, count] of observedCounts) {
    if (!expectedCounts.has(fileName)) {
      violations.push(`${fileName}: ${count} bypass call(s) in an unapproved production file`)
    }
  }
  for (const [fileName, expected] of expectedCounts) {
    const observed = observedCounts.get(fileName) ?? 0
    if (observed !== expected) {
      violations.push(`${fileName}: expected ${expected} bypass call(s), observed ${observed}`)
    }
  }

  return { observedCounts, violations }
}

function expectFixtureFailure(name, files, expectedCounts, messageFragment) {
  const result = auditInventory(files, expectedCounts)
  if (!result.violations.some((violation) => violation.includes(messageFragment))) {
    throw new Error(`Tenant bypass verifier failed its ${name} self-test`)
  }
}

function runSelfTests() {
  const approvedFile = 'apps/workers/src/approved.ts'
  const directImport = `import { ${bypassName} } from '@pathfinder/db'\n`
  const validCall = `${bypassName}(async () => undefined)\n`
  const expected = new Map([[approvedFile, 1]])
  const boundaries = [
    {
      fileName: definitionPath,
      source: `export async function ${bypassName}(fn) { return fn() }`,
    },
    {
      fileName: reexportPath,
      source: `export { ${bypassName} } from './middleware/tenant-isolation'`,
    },
  ]
  const fixture = (source) => [...boundaries, { fileName: approvedFile, source }]
  const clean = auditInventory(fixture(directImport + validCall), expected)
  if (clean.violations.length > 0 || clean.observedCounts.get(approvedFile) !== 1) {
    throw new Error('Tenant bypass verifier failed its clean fixture self-test')
  }

  expectFixtureFailure(
    'unapproved file',
    [
      ...fixture(directImport + validCall),
      { fileName: 'apps/web/src/escape.ts', source: directImport + validCall },
    ],
    expected,
    'unapproved production file',
  )
  expectFixtureFailure(
    'aliased import',
    fixture(
      `import { ${bypassName} as bypass } from '@pathfinder/db'\nbypass(async () => undefined)`,
    ),
    expected,
    'may not be aliased',
  )
  expectFixtureFailure(
    'foreign import',
    fixture(directImport.replace('@pathfinder/db', 'lib/db-shim') + validCall),
    expected,
    'imported from unapproved',
  )
  expectFixtureFailure(
    'spoofed relative origin',
    fixture(`import { ${bypassName} } from './fake/middleware/tenant-isolation'\n` + validCall),
    expected,
    'imported from unapproved',
  )
  expectFixtureFailure(
    'call shape',
    fixture(directImport + `${bypassName}(makeCallback())`),
    expected,
    'exactly one inline function argument',
  )
  expectFixtureFailure(
    'member call',
    fixture(`import * as db from '@pathfinder/db'\ndb.${bypassName}(async () => undefined)`),
    expected,
    'member calls',
  )
  expectFixtureFailure(
    'indirect reference',
    fixture(directImport + `const bypass = ${bypassName}\nbypass(async () => undefined)`),
    expected,
    'indirect reference',
  )
  expectFixtureFailure(
    'dynamic member extraction',
    fixture(
      directImport +
        validCall +
        `const hidden = (await import('@pathfinder/db')).${bypassName}\nhidden(async () => undefined)`,
    ),
    expected,
    'member references',
  )
  expectFixtureFailure(
    'dynamic destructuring',
    fixture(
      directImport +
        validCall +
        `const { '${bypassName}': hidden } = await import('@pathfinder/db')\n` +
        `hidden(async () => undefined)`,
    ),
    expected,
    'dynamic access to the tenant bypass module',
  )
  expectFixtureFailure(
    'element access',
    fixture(
      directImport +
        validCall +
        `(await import('@pathfinder/db'))['${bypassName}'](async () => undefined)`,
    ),
    expected,
    'element access',
  )
  expectFixtureFailure(
    'count drift',
    fixture(directImport + validCall + validCall),
    expected,
    'expected 1 bypass call(s), observed 2',
  )
  expectFixtureFailure(
    'stale allowlist',
    boundaries,
    expected,
    'expected 1 bypass call(s), observed 0',
  )
  expectFixtureFailure(
    'aliased re-export',
    [
      boundaries[0],
      {
        fileName: reexportPath,
        source: `export { ${bypassName} as hiddenBypass } from './middleware/tenant-isolation'`,
      },
      { fileName: approvedFile, source: directImport + validCall },
    ],
    expected,
    'exact unaliased database re-export',
  )
  expectFixtureFailure(
    'duplicate definition',
    [
      ...fixture(directImport + validCall),
      {
        fileName: 'packages/db/src/hidden.ts',
        source: `export async function ${bypassName}(fn) { return fn() }`,
      },
    ],
    expected,
    'may be declared only as the exported boundary',
  )
}

runSelfTests()

const sourceFiles = (
  await Promise.all(
    ['apps', 'packages'].map((directory) => collectFiles(path.join(repositoryRoot, directory))),
  )
).flat()
const files = await Promise.all(
  sourceFiles.map(async (absolute) => ({
    fileName: relativePath(absolute),
    source: await readFile(absolute, 'utf8'),
  })),
)
const result = auditInventory(files, approvedCallCounts)

if (result.violations.length > 0) {
  console.error('Tenant isolation bypass boundary violations:')
  for (const violation of [...new Set(result.violations)].sort()) console.error(`- ${violation}`)
  process.exit(1)
}

const total = [...result.observedCounts.values()].reduce((sum, count) => sum + count, 0)
console.log(
  `Verified ${total} tenant-isolation bypass calls across ${result.observedCounts.size} approved production files.`,
)
