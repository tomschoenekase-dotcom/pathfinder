import { resolveReleaseRevision } from '@pathfinder/config/release-identity'
import {
  captureFounderAbsenceObservation,
  readFounderAbsenceCurrentReadiness,
} from '@pathfinder/api/founder-absence-observation'

const OBSERVATION_INTERVAL_MS = 30 * 60 * 1_000
export async function captureCurrentFounderAbsenceObservation(now = new Date()) {
  const readiness = await readFounderAbsenceCurrentReadiness(now)
  const observation = await captureFounderAbsenceObservation({
    readiness,
    releaseSha: resolveReleaseRevision(process.env),
    now,
  })
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
  const timer = setInterval(() => {
    void captureCurrentFounderAbsenceObservation().catch(() =>
      process.stderr.write(
        `${JSON.stringify({
          action: 'workers.founder-absence-observation.failed',
          errorCode: 'observation-capture-failed',
        })}\n`,
      ),
    )
  }, OBSERVATION_INTERVAL_MS)
  timer.unref()
  return {
    enabled: true as const,
    intervalMs: OBSERVATION_INTERVAL_MS,
    shutdown: async () => clearInterval(timer),
  }
}
