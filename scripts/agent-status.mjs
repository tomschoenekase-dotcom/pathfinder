#!/usr/bin/env node
// Source and local-tool discovery only. No provider, database, browser, or hosted calls.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function git(repo, args) {
  try {
    const { stdout } = await run('git', ['-C', repo, ...args], { windowsHide: true, timeout: 5000 })
    return stdout.trim()
  } catch {
    return null
  }
}

export async function buildAgentStatus(repo = root) {
  const commit = await git(repo, ['rev-parse', 'HEAD'])
  const branch = await git(repo, ['branch', '--show-current'])
  const trackedStatus = await git(repo, ['status', '--porcelain', '--untracked-files=no'])
  const dependencies = existsSync(path.join(repo, 'node_modules'))
  const has = (relative) => existsSync(path.join(repo, relative))
  const capability = (id, status, evidence, nextCheck) => ({ id, status, evidence, nextCheck })
  return {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    scope: 'this-checkout-and-local-files-only',
    repository: { path: repo, commit, branch, trackedDirty: trackedStatus === null ? null : trackedStatus.length > 0 },
    capabilities: [
      capability('source-code', commit && has('package.json') ? 'AVAILABLE' : 'UNAVAILABLE', 'local Git and package.json', 'Confirm this is the task owner checkout and read its handoff.'),
      capability('local-tests', dependencies ? 'AVAILABLE' : 'DEGRADED', dependencies ? 'node_modules present; test success not yet checked' : 'dependencies not installed in this checkout', 'Run the focused test; install only from pnpm-lock.yaml when needed.'),
      capability('crm', has('packages/api/src/routers/admin/prospect-crm-outreach.ts') ? 'UNVERIFIED' : 'UNAVAILABLE', 'source presence only; no authenticated CRM request', 'Check the current CRM owner and authenticated scoped interface.'),
      capability('prospect-research', has('packages/db/src/helpers/prospect-research-job-actions.ts') ? 'UNVERIFIED' : 'UNAVAILABLE', 'research owner source presence only; no job or evidence read', 'Use the CRM research owner for one selected prospect; verify source, freshness, and saved provenance.'),
      capability('company-mailbox', 'UNVERIFIED', 'no account or sync probe performed', 'Use the company correspondence owner to verify auth, sync, and exact thread linkage.'),
      capability('web-research', 'UNVERIFIED', 'this local command cannot inspect the agent host web tool or its policy', 'Check the current host tool inventory and the selected prospect research owner before browsing.'),
      capability('browser', 'UNVERIFIED', 'this local command cannot inspect the agent host browser session', 'Check the current host browser tool and authenticated session without reading credentials.'),
      capability('hosted-staging', 'UNVERIFIED', 'no hosted health or revision probe performed', 'Read exact staging web, dashboard, worker and resource identities through the release owner.'),
      capability('staging-release', 'UNVERIFIED', 'a merge to the staging branch can deploy web, dashboard, and workers; no release admission checked', 'Require exact CI, current staging base, release owner admission, and resource conflict check before merging.'),
      capability('analytics', has('packages/api/src/routers/analytics.ts') ? 'UNVERIFIED' : 'UNAVAILABLE', 'analytics owner source presence only; no hosted data read', 'Check the scoped analytics owner and current deployment before claiming live data.'),
      capability('shared-context', 'UNVERIFIED', 'AwesomeVault is external to this checkout and was not read', 'Resolve the current vault project note and one bounded source-backed task packet.'),
      capability('task-handoff', 'UNVERIFIED', 'no AI-OS run or exact handoff was read', 'Inspect the current task owner, AI-OS run, and latest exact handoff before acting.'),
      capability('hermes-bridge', has('docs/agent-bridge-runner.md') ? 'UNVERIFIED' : 'UNAVAILABLE', 'adapter documentation is not runtime presence', 'Check a live bridge session, credential scope, and result readback.'),
      capability('production-release', 'WRITE_REQUIRES_APPROVAL', 'production is live; this command cannot approve or deploy', 'Use the exact release-specific owner gate after staging proof.'),
      capability('customer-contact', 'WRITE_REQUIRES_APPROVAL', 'draft/review is separate from delivery', 'Use the current CRM approval and delivery owner; do not send as a smoke test.'),
    ],
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await buildAgentStatus(), null, 2))
}
