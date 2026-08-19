import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { syncCharacterAssets } from './sync-character-assets.mjs'
import { repositoryRoot, verifyCharacterAssets } from './verify-character-assets.mjs'

test('canonical development character assets validate and sync to both app targets', async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'torchiko-character-assets-'))
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }))
  const dashboardTarget = path.join(temporaryRoot, 'dashboard-public')
  const webTarget = path.join(temporaryRoot, 'web-public')

  const packs = await verifyCharacterAssets(repositoryRoot)
  assert.equal(packs.length, 1)
  assert.equal(packs[0].manifest.publishable, false)
  assert.equal(packs[0].manifest.artStatus, 'placeholder')

  const copied = await syncCharacterAssets({
    root: repositoryRoot,
    targetRoots: [dashboardTarget, webTarget],
  })
  assert.equal(copied.length, packs[0].files.length * 2)

  const copiedManifest = JSON.parse(
    await readFile(
      path.join(webTarget, 'characters', 'tochi', 'v0-development', 'manifest.json'),
      'utf8',
    ),
  )
  assert.equal(copiedManifest.assetPackId, 'tochi-dev-v0')
})

test('verification rejects changed bytes instead of silently syncing drift', async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'torchiko-character-drift-'))
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }))

  await cp(
    path.join(repositoryRoot, 'assets', 'characters'),
    path.join(temporaryRoot, 'assets', 'characters'),
    { recursive: true },
  )
  const copiedBody = path.join(
    temporaryRoot,
    'assets',
    'characters',
    'tochi',
    'v0-development',
    'body.svg',
  )
  await writeFile(copiedBody, '<svg/>', 'utf8')

  await assert.rejects(
    async () => verifyCharacterAssets(temporaryRoot),
    /Byte size mismatch for body\.svg/,
  )
})
