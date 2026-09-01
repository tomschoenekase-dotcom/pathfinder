import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { REQUIRED_CHECKS, validatePhysicalEvidencePackage } from './validate-lib.mjs'

const pngA = Buffer.from('89504e470d0a1a0a0000000d4948445201', 'hex')
const pngB = Buffer.from('89504e470d0a1a0a0000000d4948445202', 'hex')
const directory = path.dirname(fileURLToPath(import.meta.url))

async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'torchiko-physical-evidence-'))
  await Promise.all([
    writeFile(path.join(root, 'ios.png'), pngA),
    writeFile(path.join(root, 'android.png'), pngB),
  ])
  return root
}

function checks(evidenceKey) {
  return REQUIRED_CHECKS.map((id) => ({
    id,
    outcome: 'PASS',
    notes: `Observed ${id.toLowerCase().replaceAll('_', ' ')} on physical hardware.`,
    evidenceKeys: [evidenceKey],
  }))
}

function fixture() {
  return {
    schemaVersion: 1,
    packageId: 'physical-launch-review-v1',
    physical: true,
    syntheticVenue: true,
    customerData: false,
    targetEnvironment: 'railway-staging',
    release: {
      revision: 'a3e66de5a1231aca6df5d150ca7bcd81831dd784',
      origin: 'https://staging.example.test',
    },
    scopes: ['VIS-01', 'VIS-03', 'A11Y-01', 'PHY-01'],
    review: {
      status: 'COMPLETE',
      reviewerReference: 'physical-review-log-1',
      reviewedAt: '2026-09-01T13:00:00Z',
    },
    evidence: [
      {
        stableKey: 'ios-session-capture',
        sessionStableKey: 'ios-session',
        localPath: 'ios.png',
        mimeType: 'image/png',
        byteSize: pngA.length,
        sha256: createHash('sha256').update(pngA).digest('hex'),
        capturedAt: '2026-09-01T12:10:00Z',
        description: 'Physical iPhone session evidence against the synthetic staging venue.',
      },
      {
        stableKey: 'android-session-capture',
        sessionStableKey: 'android-session',
        localPath: 'android.png',
        mimeType: 'image/png',
        byteSize: pngB.length,
        sha256: createHash('sha256').update(pngB).digest('hex'),
        capturedAt: '2026-09-01T12:20:00Z',
        description: 'Physical Android session evidence against the synthetic staging venue.',
      },
    ],
    sessions: [
      {
        stableKey: 'ios-session',
        platform: 'IOS',
        physicalDevice: true,
        observedAt: '2026-09-01T12:10:00Z',
        operatorReference: 'operator-log-ios-1',
        device: {
          manufacturer: 'Apple',
          model: 'iPhone test device',
          osName: 'iOS',
          osVersion: 'test-version',
        },
        browser: { name: 'Safari', version: 'test-version' },
        network: {
          profile: 'REAL_WEAK_OR_VARIABLE',
          method: 'Observed on a bounded real cellular session.',
          evidenceReference: 'ios-network-log-1',
          measurements: {
            downlinkKbps: 1200,
            latencyMs: 180,
            packetLossPercent: 2,
            measuredAt: '2026-09-01T12:10:00Z',
          },
        },
        checks: checks('ios-session-capture'),
      },
      {
        stableKey: 'android-session',
        platform: 'ANDROID',
        physicalDevice: true,
        observedAt: '2026-09-01T12:20:00Z',
        operatorReference: 'operator-log-android-1',
        device: {
          manufacturer: 'Android OEM',
          model: 'Android test device',
          osName: 'Android',
          osVersion: 'test-version',
        },
        browser: { name: 'Chrome', version: 'test-version' },
        network: {
          profile: 'CONTROLLED_WEAK_NETWORK',
          method: 'Observed through a documented device-level weak-network setup.',
          evidenceReference: 'android-network-log-1',
          measurements: {
            downlinkKbps: 900,
            latencyMs: 250,
            packetLossPercent: 4,
            measuredAt: '2026-09-01T12:20:00Z',
          },
        },
        checks: checks('android-session-capture'),
      },
    ],
  }
}

test('accepts two complete reviewed physical-device sessions and returns a path-free receipt', async () => {
  const root = await workspace()
  const receipt = await validatePhysicalEvidencePackage(fixture(), { packageDirectory: root })
  assert.deepEqual(receipt.platforms, ['IOS', 'ANDROID'])
  assert.deepEqual(receipt.scopes, ['VIS-01', 'VIS-03', 'A11Y-01', 'PHY-01'])
  assert.equal(receipt.evidence.length, 2)
  assert.equal('localPath' in receipt.evidence[0], false)
  assert.match(receipt.packageSha256, /^[a-f0-9]{64}$/)
})

test('receipt digest is stable across package property order', async () => {
  const root = await workspace()
  const value = fixture()
  const reordered = Object.fromEntries(Object.entries(value).reverse())
  const first = await validatePhysicalEvidencePackage(value, { packageDirectory: root })
  const second = await validatePhysicalEvidencePackage(reordered, { packageDirectory: root })
  assert.equal(first.packageSha256, second.packageSha256)
})

test('rejects pending review and non-physical declarations', async () => {
  const root = await workspace()
  const pending = fixture()
  pending.review.status = 'PENDING'
  await assert.rejects(
    () => validatePhysicalEvidencePackage(pending, { packageDirectory: root }),
    /must be COMPLETE/,
  )
  const simulated = fixture()
  simulated.sessions[0].physicalDevice = false
  await assert.rejects(
    () => validatePhysicalEvidencePackage(simulated, { packageDirectory: root }),
    /physicalDevice: true/,
  )
})

test('rejects missing platform coverage and incomplete checks', async () => {
  const root = await workspace()
  const duplicate = fixture()
  duplicate.sessions[1].platform = 'IOS'
  duplicate.sessions[1].device.osName = 'iOS'
  await assert.rejects(
    () => validatePhysicalEvidencePackage(duplicate, { packageDirectory: root }),
    /unique IOS/,
  )
  const incomplete = fixture()
  incomplete.sessions[0].checks.pop()
  await assert.rejects(
    () => validatePhysicalEvidencePackage(incomplete, { packageDirectory: root }),
    /every required physical check/,
  )
})

test('rejects failed checks and cross-session evidence references', async () => {
  const root = await workspace()
  const failed = fixture()
  failed.sessions[0].checks[0].outcome = 'FAIL'
  await assert.rejects(
    () => validatePhysicalEvidencePackage(failed, { packageDirectory: root }),
    /must be PASS/,
  )
  const crossed = fixture()
  crossed.sessions[0].checks[0].evidenceKeys = ['android-session-capture']
  await assert.rejects(
    () => validatePhysicalEvidencePackage(crossed, { packageDirectory: root }),
    /invalid or duplicate evidence/,
  )
})

test('rejects absent, unbounded, or stale network measurements', async () => {
  const root = await workspace()
  const absent = fixture()
  delete absent.sessions[0].network.measurements
  await assert.rejects(
    () => validatePhysicalEvidencePackage(absent, { packageDirectory: root }),
    /measurements must be an object/,
  )
  const unbounded = fixture()
  unbounded.sessions[0].network.measurements.downlinkKbps = 100_000
  await assert.rejects(
    () => validatePhysicalEvidencePackage(unbounded, { packageDirectory: root }),
    /outside bounded weak-network ranges/,
  )
  const stale = fixture()
  stale.sessions[0].network.measurements.measuredAt = '2026-08-31T12:10:00Z'
  await assert.rejects(
    () => validatePhysicalEvidencePackage(stale, { packageDirectory: root }),
    /within six hours/,
  )
})

test('rejects customer identifiers, scope drift, and unsafe origins', async () => {
  const root = await workspace()
  const identified = fixture()
  identified.customer_id = 'do-not-retain'
  await assert.rejects(
    () => validatePhysicalEvidencePackage(identified, { packageDirectory: root }),
    /is forbidden/,
  )
  const scoped = fixture()
  scoped.scopes.pop()
  await assert.rejects(
    () => validatePhysicalEvidencePackage(scoped, { packageDirectory: root }),
    /must include/,
  )
  const unsafe = fixture()
  unsafe.release.origin = 'https://user:pass@example.test/path?secret=yes'
  await assert.rejects(
    () => validatePhysicalEvidencePackage(unsafe, { packageDirectory: root }),
    /credential-free HTTPS origin/,
  )
  const malformed = fixture()
  malformed.release.origin = 'not-an-origin'
  await assert.rejects(
    () => validatePhysicalEvidencePackage(malformed, { packageDirectory: root }),
    /credential-free HTTPS origin/,
  )
})

test('rejects evidence hash, signature, path, and time drift', async () => {
  const root = await workspace()
  const hash = fixture()
  hash.evidence[0].sha256 = '0'.repeat(64)
  await assert.rejects(
    () => validatePhysicalEvidencePackage(hash, { packageDirectory: root }),
    /hash drift/,
  )
  const mime = fixture()
  mime.evidence[0].mimeType = 'video/mp4'
  await assert.rejects(
    () => validatePhysicalEvidencePackage(mime, { packageDirectory: root }),
    /signature/,
  )
  const escaped = fixture()
  escaped.evidence[0].localPath = '../ios.png'
  await assert.rejects(
    () => validatePhysicalEvidencePackage(escaped, { packageDirectory: root }),
    /remain inside/,
  )
  const late = fixture()
  late.review.reviewedAt = '2026-09-01T12:00:00Z'
  await assert.rejects(
    () => validatePhysicalEvidencePackage(late, { packageDirectory: root }),
    /at or after/,
  )
  const reused = fixture()
  reused.evidence[0].capturedAt = '2026-08-31T12:10:00Z'
  await assert.rejects(
    () => validatePhysicalEvidencePackage(reused, { packageDirectory: root }),
    /within six hours/,
  )
})

test('checked-in pending template cannot pass validation', async () => {
  const templatePath = path.join(directory, 'template.pending.json')
  const template = JSON.parse(await readFile(templatePath, 'utf8'))
  assert.deepEqual(
    template.sessions.map((session) => session.platform),
    ['IOS', 'ANDROID'],
  )
  assert.deepEqual(
    template.sessions[0].checks.map((check) => check.id),
    REQUIRED_CHECKS,
  )
  assert.deepEqual(
    template.sessions[1].checks.map((check) => check.id),
    REQUIRED_CHECKS,
  )
  const result = spawnSync(process.execPath, [path.join(directory, 'validate.mjs'), templatePath], {
    encoding: 'utf8',
    shell: false,
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Physical evidence package rejected:/)
  assert.equal(result.stdout, '')
})

test('CLI help is bounded and successful', () => {
  const result = spawnSync(process.execPath, [path.join(directory, 'validate.mjs'), '--help'], {
    encoding: 'utf8',
    shell: false,
  })
  assert.equal(result.status, 0)
  assert.match(result.stderr, /^Usage: pnpm physical-evidence:validate/)
})
