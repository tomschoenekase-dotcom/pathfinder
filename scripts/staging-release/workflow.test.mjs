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
  assert.match(workflow, /REQUESTED_SHA: \$\{\{ github\.event_name == 'push' && github\.sha \|\| inputs\.release_sha \}\}/u)
  assert.ok(workflow.includes('[[ "$REQUESTED_SHA" =~ ^[0-9a-f]{40}$ ]]'))
  assert.ok(workflow.includes('test "$REQUESTED_SHA" = "$(git rev-parse HEAD)"'))
  assert.match(workflow, /node --test scripts\/staging-release\/\*\.test\.mjs/u)
  assert.match(workflow, /Run staging-release unit and workflow policy tests\n        env:\n          STAGING_RELEASE_TMP: \$\{\{ runner\.temp \}\}/u)
  assert.doesNotMatch(workflow, /^      STAGING_RELEASE_TMP:/mu, 'runner.temp is unavailable in job-level env')
  assert.match(workflow, /Prove GitHub masks a synthetic log sentinel[\s\S]*?sentinel='packet10-mask-sentinel-not-a-secret'[\s\S]*?echo "::add-mask::\$sentinel"[\s\S]*?echo "\$sentinel"/u)
})

test('synthetic job uses disposable Postgres, masks credentials, and keeps artifacts briefly', () => {
  assert.equal((workflow.match(/image: postgres:17/gu) ?? []).length, 2)
  assert.match(workflow, /::add-mask::\$DATABASE_URL/u)
  assert.match(workflow, /::add-mask::\$RESTORE_DATABASE_URL/u)
  assert.match(workflow, /::add-mask::\$STAGING_BACKUP_PASSPHRASE/u)
  assert.match(workflow, /retention-days: 2/u)
  assert.match(workflow, /if-no-files-found: error/u)
  assert.match(workflow, /uses: actions\/attest@[0-9a-f]{40}/u)
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
  assert.match(restore, /::add-mask::\$STAGING_BACKUP_PASSPHRASE/u)
  assert.match(restore, /name: staging-synthetic-\$\{\{ inputs\.release_sha \}\}/u)
  assert.match(restore, /run-id: \$\{\{ inputs\.source_run_id \}\}/u)
  assert.match(restore, /gh attestation verify[\s\S]*?--repo "\$GITHUB_REPOSITORY"[\s\S]*?--signer-workflow "\$GITHUB_REPOSITORY\/\.github\/workflows\/staging-release\.yml"[\s\S]*?--source-ref refs\/heads\/codex\/torchiko-one-click-staging[\s\S]*?--source-digest "\$RELEASE_SHA"/u)
  assert.ok(restore.indexOf('gh attestation verify') < restore.indexOf('--verify'), 'GitHub provenance must verify before evidence and archive restore')
  assert.ok(restore.indexOf('--verify') < restore.indexOf('restore.mjs --input-dir'), 'evidence must verify before the archive is restored')
  assert.match(restore, /name: staging-restore-proof-\$\{\{ inputs\.release_sha \}\}/u)
})
