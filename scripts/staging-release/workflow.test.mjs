import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workflow = await readFile(new URL('../../.github/workflows/staging-release.yml', import.meta.url), 'utf8')
const restore = await readFile(new URL('../../.github/workflows/staging-restore.yml', import.meta.url), 'utf8')

test('branch push can only enter the synthetic job', () => {
  assert.match(workflow, /branches: \[codex\/torchiko-one-click-staging\]/u)
  assert.match(workflow, /synthetic-dry-run:\n    if: github\.event_name == 'push' \|\| inputs\.mode == 'dry-run'/u)
  assert.match(workflow, /staging-preflight:\n    if: github\.event_name == 'workflow_dispatch' && inputs\.mode == 'staging'/u)
})

test('hosted approval waits for preflight and is never requested by synthetic push', () => {
  assert.match(workflow, /staging-release:\n    if: github\.event_name == 'workflow_dispatch' && inputs\.mode == 'staging'\n    needs: \[staging-preflight\]\n    runs-on: ubuntu-latest\n    environment: staging/u)
  assert.match(workflow, /Block before requesting an environment approval/u)
  assert.match(workflow, /Hosted staging release is held/u)
  assert.match(workflow, /writer drain, exact target baseline, preserve-existing incident-stop reconciliation, and safe Railway deployment route/u)
})

test('synthetic job checks out the exact SHA and runs every staging-release test', () => {
  assert.match(workflow, /node-version: 22\n          package-manager-cache: false/u)
  assert.match(restore, /node-version: 22\n          package-manager-cache: false/u)
  assert.match(workflow, /REQUESTED_SHA: \$\{\{ github\.event_name == 'push' && github\.sha \|\| inputs\.release_sha \}\}/u)
  assert.ok(workflow.includes('[[ "$REQUESTED_SHA" =~ ^[0-9a-f]{40}$ ]]'))
  assert.ok(workflow.includes('test "$REQUESTED_SHA" = "$(git rev-parse HEAD)"'))
  assert.match(workflow, /node --test scripts\/staging-release\/\*\.test\.mjs/u)
  assert.match(workflow, /Run staging-release unit and workflow policy tests\n        env:\n          STAGING_RELEASE_TMP: \$\{\{ runner\.temp \}\}/u)
  assert.doesNotMatch(workflow, /^      STAGING_RELEASE_TMP:/mu, 'runner.temp is unavailable in job-level env')
  assert.match(workflow, /Prove GitHub masks a synthetic log sentinel[\s\S]*?sentinel='packet10-mask-sentinel-not-a-secret'[\s\S]*?echo "::add-mask::\$sentinel"[\s\S]*?echo "\$sentinel"/u)
})

test('synthetic hosted rehearsal runs with its explicit synthetic gate and is attested', () => {
  const validateIndex = workflow.indexOf('Validate synthetic evidence')
  const rehearsalIndex = workflow.indexOf('Run synthetic hosted rehearsal')
  const evidenceAttestIndex = workflow.indexOf('Sign evidence provenance with GitHub OIDC')
  const rehearsalAttestIndex = workflow.indexOf('Sign rehearsal evidence provenance with GitHub OIDC')
  assert.ok(validateIndex < rehearsalIndex && rehearsalIndex < evidenceAttestIndex)
  assert.match(workflow, /Run synthetic hosted rehearsal\n        env:\n          STAGING_SYNTHETIC_REHEARSAL: '1'\n          RELEASE_SHA: \$\{\{ github\.sha \}\}\n        run: \|\n          node scripts\/staging-release\/synthetic-hosted-rehearsal\.mjs \\\n            --synthetic-evidence "\$RUNNER_TEMP\/staging-release\/evidence\.json" \\\n            --release-sha "\$RELEASE_SHA" \\\n            --output "\$RUNNER_TEMP\/staging-release\/rehearsal-evidence\.json"/u)
  assert.ok(rehearsalIndex < rehearsalAttestIndex)
  assert.match(workflow, /Sign rehearsal evidence provenance with GitHub OIDC\n        uses: actions\/attest@[0-9a-f]{40}[\s\S]*?subject-path: \$\{\{ runner\.temp \}\}\/staging-release\/rehearsal-evidence\.json/u)
  assert.ok(workflow.includes('staging-release/rehearsal-evidence.json'))
  assert.doesNotMatch(workflow.slice(rehearsalIndex, evidenceAttestIndex), /STAGING_DATABASE_URL|RAILWAY_TOKEN/u)
  assert.doesNotMatch(workflow.slice(workflow.indexOf('Run synthetic hosted rehearsal'), workflow.indexOf('Sign rehearsal evidence provenance')), /DATABASE_URL|RESTORE_DATABASE_URL/u, 'rehearsal must not inherit disposable database URLs')
  assert.doesNotMatch(workflow, /^      (?:DATABASE_URL|RESTORE_DATABASE_URL):/mu, 'disposable database URLs must not be job-level environment')
  const syntheticSourceUrl = 'postgresql://postgres:synthetic-password@127.0.0.1:5432/pathfinder_disposable_source'
  const syntheticRestoreUrl = 'postgresql://postgres:synthetic-password@127.0.0.1:5433/pathfinder_disposable_restore'
  assert.match(workflow, new RegExp(`Mask synthetic connection strings and passphrase\\n        env:\\n          DATABASE_URL: ${syntheticSourceUrl.replaceAll('.', '\\.')}\\n          RESTORE_DATABASE_URL: ${syntheticRestoreUrl.replaceAll('.', '\\.')}\\n`, 'u'))
  assert.match(workflow, new RegExp(`Backup and verify disposable restore\\n        env:\\n          DATABASE_URL: ${syntheticSourceUrl.replaceAll('.', '\\.')}\\n          RESTORE_DATABASE_URL: ${syntheticRestoreUrl.replaceAll('.', '\\.')}\\n          STAGING_BACKUP_PASSPHRASE: synthetic-disposable-passphrase-for-ci-only`, 'u'))
  assert.match(workflow, /staging-preflight:\n    if: github\.event_name == 'workflow_dispatch' && inputs\.mode == 'staging'[\s\S]*?Block before requesting an environment approval[\s\S]*?exit 1/u)
  assert.match(workflow, /staging-release:\n    if: github\.event_name == 'workflow_dispatch' && inputs\.mode == 'staging'\n    needs: \[staging-preflight\][\s\S]*?environment: staging/u)
})

test('synthetic job uses disposable Postgres, masks credentials, and keeps artifacts briefly', () => {
  assert.equal((workflow.match(/image: postgres:17/gu) ?? []).length, 2)
  assert.match(workflow, /::add-mask::\$DATABASE_URL/u)
  assert.match(workflow, /::add-mask::\$RESTORE_DATABASE_URL/u)
  assert.match(workflow, /passphrase='synthetic-disposable-'\n          passphrase\+='passphrase-for-ci-only'\n          echo "::add-mask::\$passphrase"/u)
  assert.doesNotMatch(workflow, /^      STAGING_BACKUP_PASSPHRASE:/mu, 'passphrase must be masked before entering a step environment')
  assert.match(workflow, /Backup and verify disposable restore\n        env:\n          DATABASE_URL: postgresql:\/\/postgres:synthetic-password@127\.0\.0\.1:5432\/pathfinder_disposable_source\n          RESTORE_DATABASE_URL: postgresql:\/\/postgres:synthetic-password@127\.0\.0\.1:5433\/pathfinder_disposable_restore\n          STAGING_BACKUP_PASSPHRASE: synthetic-disposable-passphrase-for-ci-only/u)
  assert.ok(workflow.indexOf('Mask synthetic connection strings and passphrase') < workflow.indexOf('Backup and verify disposable restore'))
  assert.match(workflow, /retention-days: 2/u)
  assert.match(workflow, /if-no-files-found: error/u)
  assert.match(workflow, /uses: actions\/attest@[0-9a-f]{40}/u)
  assert.match(workflow, /synthetic-dry-run:[\s\S]*?permissions:\n      contents: read\n      id-token: write\n      attestations: write/u)
  assert.doesNotMatch(workflow, /^  id-token: write|^  attestations: write/mu)
  assert.match(workflow, /subject-path: \$\{\{ runner\.temp \}\}\/staging-release\/evidence\.json/u)
  assert.match(workflow, /name: staging-synthetic-\$\{\{ github\.sha \}\}/u)
  for (const artifact of ['backup.enc', 'backup-manifest.json', 'restore-proof.json', 'evidence.json']) {
    assert.ok(workflow.includes(`staging-release/${artifact}`), `synthetic artifact must include ${artifact}`)
  }
})

test('restore workflow only targets a new synthetic disposable database', () => {
  assert.match(restore, /options: \[synthetic\]/u)
  assert.match(restore, /image: postgres:17/u)
  assert.match(restore, /RESTORE_DATABASE_URL: postgresql:\/\/postgres:synthetic-password@127\.0\.0\.1:5433\/pathfinder_disposable_restore/u)
  assert.match(restore, /attestations: read/u)
  assert.doesNotMatch(restore, /STAGING_DATABASE_URL|RAILWAY_TOKEN/u)
  assert.match(restore, /::add-mask::\$RESTORE_DATABASE_URL/u)
  assert.match(restore, /passphrase='synthetic-disposable-'\n          passphrase\+='passphrase-for-ci-only'\n          echo "::add-mask::\$passphrase"/u)
  assert.doesNotMatch(restore, /^      STAGING_BACKUP_PASSPHRASE:/mu)
  assert.match(restore, /Verify evidence and restore only into new disposable service container\n        env:\n          RELEASE_SHA: \$\{\{ inputs\.release_sha \}\}\n          STAGING_BACKUP_PASSPHRASE: synthetic-disposable-passphrase-for-ci-only/u)
  assert.ok(restore.indexOf('Mask synthetic restore connection and passphrase') < restore.indexOf('Verify evidence and restore only into new disposable service container'))
  assert.match(restore, /name: staging-synthetic-\$\{\{ inputs\.release_sha \}\}/u)
  assert.match(restore, /run-id: \$\{\{ inputs\.source_run_id \}\}/u)
  assert.match(restore, /gh attestation verify[\s\S]*?--repo "\$GITHUB_REPOSITORY"[\s\S]*?--signer-workflow "\$GITHUB_REPOSITORY\/\.github\/workflows\/staging-release\.yml"[\s\S]*?--source-ref refs\/heads\/master[\s\S]*?--source-digest "\$RELEASE_SHA"/u)
  assert.match(restore, /Verify source run belongs to the trusted release workflow[\s\S]*?verify-source-run\.mjs "\$SOURCE_RUN_ID" "\$RELEASE_SHA"/u)
  assert.ok(restore.indexOf('verify-source-run.mjs') < restore.indexOf('actions/download-artifact@'))
  assert.match(restore, /restore\.mjs --input-dir "\$RUNNER_TEMP\/staging-restore" --require-evidence/u)
  assert.ok(restore.indexOf('gh attestation verify') < restore.indexOf('--verify'), 'GitHub provenance must verify before evidence and archive restore')
  assert.ok(restore.indexOf('--verify') < restore.indexOf('restore.mjs --input-dir'), 'evidence must verify before the archive is restored')
  assert.match(restore, /name: staging-restore-proof-\$\{\{ inputs\.release_sha \}\}/u)
})
