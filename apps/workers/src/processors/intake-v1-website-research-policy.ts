import { INTAKE_V1_PROCESSING_POLICY_VERSION } from '@pathfinder/db'

/**
 * Server-owned limits for the canonical V1 WEBSITE_RESEARCH dispatch. These
 * are not customer input and the worker refuses a dispatch from another policy
 * version before it opens the website runtime.
 */
export const INTAKE_V1_WEBSITE_RESEARCH_POLICY = Object.freeze({
  version: INTAKE_V1_PROCESSING_POLICY_VERSION,
  maxPages: 4,
  maxDepth: 1,
  maxBytesPerPage: 1_000_000,
  maxDurationMs: 30_000,
  maxCostUnits: 8,
  userAgent: 'TorchikoIntakeV1Research/1.0',
})

export function intakeV1WebsiteResearchActor(dispatchId: string): string {
  return `intake-v1-website-research:${dispatchId}`
}
