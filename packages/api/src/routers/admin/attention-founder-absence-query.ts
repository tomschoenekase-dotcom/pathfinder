import {
  applyFounderAbsenceObservationHistory,
  listFounderAbsenceObservations,
} from '../../founder-absence-observation'
import { deriveFounderAbsenceReadiness } from './attention-founder-absence'

export async function readFounderAbsenceReadinessWithHistory(
  input: Parameters<typeof deriveFounderAbsenceReadiness>[0],
  now: Date,
) {
  const current = deriveFounderAbsenceReadiness(input)
  const observations = await listFounderAbsenceObservations()
  return applyFounderAbsenceObservationHistory(current, observations, now)
}
