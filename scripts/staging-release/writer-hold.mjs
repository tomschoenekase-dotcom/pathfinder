import { STAGING_RELEASE_TARGET } from '../lib/staging-release-admission.mjs'

/** Validate a provider readback. This does not acquire a hold or grant migration authority. */
export function assertWriterHold(receipt, now = Date.now()) {
  const fail = () => { throw new Error('writer-hold-unverified') }
  if (!Number.isFinite(now) || receipt?.projectId !== STAGING_RELEASE_TARGET.projectId ||
      receipt?.environmentId !== STAGING_RELEASE_TARGET.environmentId ||
      receipt?.maintenance?.enabled !== true || receipt.maintenance.ingressPaused !== true) fail()
  const releaseAt = Date.parse(receipt.maintenance.automaticReleaseAt)
  if (!Number.isFinite(releaseAt) || releaseAt <= now || releaseAt > now + 10 * 60_000) fail()
  const expectedServices = Object.keys(STAGING_RELEASE_TARGET.services).sort()
  if (!receipt?.services ||
      JSON.stringify(Object.keys(receipt.services).sort()) !== JSON.stringify(expectedServices)) fail()
  for (const name of expectedServices) {
    if (receipt?.services?.[name] !== 0) fail()
  }
  if (!Array.isArray(receipt.samples) || receipt.samples.length !== 2) fail()
  const [earlier, later] = receipt.samples
  const firstAt = Date.parse(earlier?.at)
  const secondAt = Date.parse(later?.at)
  if (!Number.isFinite(firstAt) || !Number.isFinite(secondAt) || secondAt - firstAt < 30_000 ||
      secondAt - firstAt > 120_000 || secondAt > now || now - secondAt > 60_000) fail()
  for (const key of ['queueRows', 'auditRows']) {
    if (!Number.isSafeInteger(earlier[key]) || earlier[key] < 0 || later[key] !== earlier[key]) fail()
  }
  return { ok: true, automaticReleaseAt: receipt.maintenance.automaticReleaseAt }
}
