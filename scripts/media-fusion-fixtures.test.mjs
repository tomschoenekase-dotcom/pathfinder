import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = path.join(repositoryRoot, 'scripts', 'fixtures', 'media-fusion-v1')
const manifestPaths = ['development', 'holdout'].map((split) =>
  path.join(fixtureRoot, split, 'manifest.json'),
)
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

async function manifests() {
  return Promise.all(
    manifestPaths.map(async (manifestPath) => JSON.parse(await readFile(manifestPath, 'utf8'))),
  )
}

function validateRegion(region, label) {
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.equal(Number.isFinite(region[key]), true, `${label} ${key} must be finite`)
  }
  assert(region.x >= 0 && region.y >= 0, `${label} origin must be non-negative`)
  assert(region.width > 0 && region.height > 0, `${label} size must be positive`)
  assert(region.x + region.width <= 1, `${label} exceeds normalized width`)
  assert(region.y + region.height <= 1, `${label} exceeds normalized height`)
}

test('pins separate, synthetic, provider-dark development and holdout manifests', async () => {
  const [development, holdout] = await manifests()
  assert.equal(development.split, 'development')
  assert.equal(holdout.split, 'holdout')
  for (const manifest of [development, holdout]) {
    assert.equal(manifest.schemaVersion, 1)
    assert.equal(manifest.suiteId, 'media-fusion-v1')
    assert.equal(manifest.synthetic, true)
    assert.equal(manifest.providerStatus, 'NOT_RUN')
    assert.match(manifest.providerStatusMeaning, /No model or external provider/u)
    assert.equal(manifest.generator.version, 'media-fusion-fixture-generator/1.0.0')
    assert.equal(manifest.generator.seed, 1007)
    assert.equal(manifest.generator.command, 'python scripts/generate-media-fusion-fixtures.py')
    assert.deepEqual(manifest.measurementBoundary.doesNotProve, [
      'model vision, OCR, or extraction accuracy',
      'provider cost, latency, or repeatability',
      'complete video-frame coverage',
    ])
    assert.equal(manifest.cases.length, 2)
  }
  assert(development.cases.every((item) => item.caseId.startsWith('mf-d')))
  assert(holdout.cases.every((item) => item.caseId.startsWith('mf-h')))
  const developmentIds = new Set(development.cases.map((item) => item.caseId))
  assert.equal(
    holdout.cases.some((item) => developmentIds.has(item.caseId)),
    false,
  )
})

test('resolves every source byte to its pinned hash, type metadata, and modest suite cap', async () => {
  const all = await manifests()
  const seenPaths = new Set()
  let totalBytes = 0
  for (const manifest of all) {
    for (const fixtureCase of manifest.cases) {
      for (const asset of fixtureCase.assets) {
        assert.equal(asset.synthetic, true)
        assert.match(asset.rights, /self-created synthetic fixture/u)
        assert.match(asset.sha256, /^[0-9a-f]{64}$/u)
        assert.equal(seenPaths.has(asset.path), false, `duplicate source path ${asset.path}`)
        seenPaths.add(asset.path)
        assert.equal(asset.path, `${manifest.split}/sources/${path.basename(asset.path)}`)
        const absolutePath = path.resolve(fixtureRoot, ...asset.path.split('/'))
        assert(absolutePath.startsWith(`${path.resolve(fixtureRoot)}${path.sep}`))
        const bytes = await readFile(absolutePath)
        const details = await stat(absolutePath)
        assert.equal(details.size, asset.bytes, `${asset.path} byte count drifted`)
        assert.equal(sha256(bytes), asset.sha256, `${asset.path} hash drifted`)
        assert(asset.bytes > 0 && asset.bytes <= 2 * 1024 * 1024)
        totalBytes += asset.bytes
        if (asset.mediaType === 'IMAGE') {
          assert.equal(asset.format, 'png')
          assert.deepEqual([...bytes.subarray(1, 4)], [0x50, 0x4e, 0x47])
          assert(asset.width > 0 && asset.width <= 4096)
          assert(asset.height > 0 && asset.height <= 4096)
        } else if (asset.mediaType === 'DOCUMENT') {
          assert.equal(asset.format, 'pdf')
          assert.equal(bytes.subarray(0, 5).toString(), '%PDF-')
          assert(Number.isInteger(asset.pages) && asset.pages >= 1 && asset.pages <= 100_000)
        } else {
          assert.equal(asset.mediaType, 'VIDEO')
          assert.equal(asset.format, 'mp4')
          assert.equal(bytes.subarray(4, 8).toString(), 'ftyp')
          assert.equal(asset.hasAudio, false)
          assert(asset.durationSeconds > 0 && asset.durationSeconds <= 900)
        }
      }
    }
  }
  assert(totalBytes < 10 * 1024 * 1024, 'media fusion fixture sources exceed the 10 MiB cap')
  assert.equal(seenPaths.size, 11)
})

test('keeps expected observations and relations inside their exact source and locator bounds', async () => {
  for (const manifest of await manifests()) {
    for (const fixtureCase of manifest.cases) {
      const assets = new Map(fixtureCase.assets.map((asset) => [asset.path, asset]))
      assert(
        fixtureCase.expected.observations.length > 0 &&
          fixtureCase.expected.observations.length <= 500,
      )
      assert.equal(
        new Set(fixtureCase.expected.observations.map((item) => item.observationId)).size,
        fixtureCase.expected.observations.length,
      )
      for (const observation of fixtureCase.expected.observations) {
        const asset = assets.get(observation.evidence.source)
        assert(asset, `${fixtureCase.caseId} observation source is outside its case`)
        const locator = observation.evidence.locator
        if (locator.type === 'image_region') {
          assert.equal(asset.mediaType, 'IMAGE')
          validateRegion(locator, `${fixtureCase.caseId}/${observation.observationId}`)
        } else if (locator.type === 'document_page') {
          assert.equal(asset.mediaType, 'DOCUMENT')
          assert(Number.isInteger(locator.page) && locator.page >= 1 && locator.page <= asset.pages)
        } else if (locator.type === 'video_interval') {
          assert.equal(asset.mediaType, 'VIDEO')
          assert(locator.startSeconds >= 0)
          assert(locator.endSeconds >= locator.startSeconds)
          assert(locator.endSeconds <= asset.durationSeconds)
        } else {
          assert.equal(locator.type, 'whole_source')
        }
      }
      const candidates = new Set(fixtureCase.expected.entities.candidateIds)
      assert.equal(candidates.size, fixtureCase.expected.entities.candidateIds.length)
      assert.equal(fixtureCase.expected.entities.automaticMerge, false)
      for (const relation of fixtureCase.expected.relations) {
        assert(candidates.has(relation.fromCandidateId))
        assert(candidates.has(relation.toCandidateId))
        assert.notEqual(relation.fromCandidateId, relation.toCandidateId)
      }
      assert.equal(
        fixtureCase.expected.evidence.expectedLocatorCount,
        fixtureCase.expected.observations.length,
      )
      assert.equal(fixtureCase.expected.evidence.staleGenerationAccepted, false)
      assert.equal(fixtureCase.expected.evidence.allSourceHashesRequired, true)
      assert(['NO_HOLDS', 'HELD'].includes(fixtureCase.expected.temporal.outcome))
      assert.equal(fixtureCase.expected.privacy.privateEvidenceOnly, true)
      assert.deepEqual(fixtureCase.expected.privacy.publicAssetPaths, [])
    }
  }
})

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const target = path.join(directory, entry.name)
        return entry.isDirectory() ? sourceFiles(target) : [target]
      }),
    )
  ).flat()
}

test('does not import holdout expectations into production prompt or runtime source', async () => {
  const [, holdout] = await manifests()
  const forbidden = [
    'scripts/fixtures/media-fusion-v1/holdout',
    ...holdout.cases.map((item) => item.caseId),
  ]
  const roots = [
    path.join(repositoryRoot, 'packages', 'ai', 'src'),
    path.join(repositoryRoot, 'packages', 'api', 'src'),
    path.join(repositoryRoot, 'apps', 'workers', 'src'),
  ]
  for (const root of roots) {
    for (const file of await sourceFiles(root)) {
      if (/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file) || !/\.[cm]?[jt]sx?$/u.test(file)) continue
      const content = await readFile(file, 'utf8')
      for (const marker of forbidden) {
        assert.equal(
          content.includes(marker),
          false,
          `${path.relative(repositoryRoot, file)} imports holdout marker ${marker}`,
        )
      }
    }
  }
})
