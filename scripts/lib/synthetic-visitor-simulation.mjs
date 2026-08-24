const MODES = new Set(['bot', 'voice'])

export function classifySyntheticOperationalUpdate(update, instant) {
  const current = instant.getTime()
  const startsAt = new Date(update?.startsAt)
  const expiresAt = new Date(update?.expiresAt)
  if (
    Number.isNaN(current) ||
    !['DRAFT', 'PUBLISHED'].includes(update?.status) ||
    typeof update?.isActive !== 'boolean' ||
    Number.isNaN(startsAt.getTime()) ||
    Number.isNaN(expiresAt.getTime()) ||
    startsAt.getTime() >= expiresAt.getTime()
  )
    throw new Error('simulation-update-invalid')
  let lifecycle
  if (update.status === 'DRAFT') lifecycle = 'DRAFT'
  else if (!update.isActive) lifecycle = 'INACTIVE'
  else if (expiresAt.getTime() <= current) lifecycle = 'EXPIRED'
  else if (startsAt.getTime() > current) lifecycle = 'SCHEDULED'
  else lifecycle = 'LIVE'
  return {
    id: update.id,
    title: update.title,
    lifecycle,
    guestVisibleNow: lifecycle === 'LIVE',
    startsAt: update.startsAt,
    expiresAt: update.expiresAt,
  }
}

export function buildSyntheticVisitorSimulation(scenario, instantValue, requestedMode) {
  const instant = new Date(instantValue)
  if (Number.isNaN(instant.getTime())) throw new Error('simulation-instant-invalid')
  if (!MODES.has(requestedMode)) throw new Error('simulation-mode-invalid')

  const configured = scenario.visitorConfiguration
  if (
    typeof configured?.botMode !== 'boolean' ||
    typeof configured?.voiceMode !== 'boolean' ||
    !MODES.has(configured?.defaultMode) ||
    configured?.[`${configured.defaultMode}Mode`] !== true
  )
    throw new Error('simulation-configuration-invalid')
  if (!Array.isArray(scenario.operationalUpdates) || scenario.operationalUpdates.length === 0)
    throw new Error('simulation-updates-required')
  const requestedEnabled = configured[`${requestedMode}Mode`] === true
  const effectiveMode = requestedEnabled ? requestedMode : configured.defaultMode
  const updates = scenario.operationalUpdates.map((update) =>
    classifySyntheticOperationalUpdate(update, instant),
  )

  return {
    schemaVersion: 1,
    synthetic: true,
    scenarioId: scenario.id,
    instant: instant.toISOString(),
    venue: scenario.venue,
    clientConfiguration: {
      configured: {
        botMode: configured.botMode,
        voiceMode: configured.voiceMode,
        defaultMode: configured.defaultMode,
      },
      requestedMode,
      effectiveMode,
      fallback: effectiveMode !== requestedMode,
      reason: requestedEnabled ? 'requested-mode-enabled' : 'requested-mode-disabled-in-fixture',
      liveEntitlementEvaluated: false,
    },
    operationalUpdates: {
      all: updates,
      visible: updates.filter((update) => update.guestVisibleNow),
    },
    providerDispatch: false,
    limitations: [
      'Fixture configuration is synthetic and does not prove a live tenant entitlement or environment flag.',
      'Update classification is inspect-only and does not schedule, publish, expire, or mutate an update.',
    ],
  }
}
