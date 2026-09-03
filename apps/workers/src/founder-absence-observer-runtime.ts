import { resolveReleaseRevision } from '@pathfinder/config/release-identity'
import {
  captureFounderAbsenceObservation,
  readFounderAbsenceCurrentReadiness,
} from '@pathfinder/api/founder-absence-observation'

const OBSERVATION_INTERVAL_MS = 30 * 60 * 1_000

function reportFounderAbsenceObservationFailure() {
  try {
    process.stderr.write(
      `${JSON.stringify({
        action: 'workers.founder-absence-observation.failed',
        errorCode: 'observation-capture-failed',
      })}\n`,
    )
  } catch {
    // Keep the observer failure path contained even when diagnostics are unavailable.
  }
}

export async function captureCurrentFounderAbsenceObservation(now = new Date()) {
  const runtimeRevision = resolveReleaseRevision(process.env)
  const readiness = await readFounderAbsenceCurrentReadiness(now)
  const observation = await captureFounderAbsenceObservation({
    readiness,
    releaseSha: runtimeRevision,
    now,
  })
  process.stdout.write(
    `${JSON.stringify({
      action: 'workers.release-identity.admitted',
      revision: runtimeRevision,
    })}\n`,
  )
  process.stdout.write(
    `${JSON.stringify({
      action: 'workers.founder-absence-observation.retained',
      observedOn: observation.observedOn.toISOString().slice(0, 10),
      releaseSha: observation.releaseSha,
      evidenceComplete: observation.evidenceComplete,
    })}\n`,
  )
  return observation
}

export async function startFounderAbsenceObserver() {
  await captureCurrentFounderAbsenceObservation()
  let inFlightCapture: Promise<void> | undefined

  const captureNextObservation = () => {
    if (inFlightCapture) return inFlightCapture

    const execution = captureCurrentFounderAbsenceObservation()
      .then(() => undefined)
      .catch(() => reportFounderAbsenceObservationFailure())
      .finally(() => {
        if (inFlightCapture === execution) inFlightCapture = undefined
      })
    inFlightCapture = execution
    return execution
  }

  const timer = setInterval(() => {
    void captureNextObservation()
  }, OBSERVATION_INTERVAL_MS)
  timer.unref()
  return {
    enabled: true as const,
    intervalMs: OBSERVATION_INTERVAL_MS,
    shutdown: async () => {
      clearInterval(timer)
      await inFlightCapture
    },
  }
}
