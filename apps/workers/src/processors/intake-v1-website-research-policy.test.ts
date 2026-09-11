import { describe, expect, it } from 'vitest'

import {
  INTAKE_V1_WEBSITE_RESEARCH_POLICY,
  intakeV1WebsiteResearchActor,
} from './intake-v1-website-research-policy'

describe('V1 website research worker policy', () => {
  it('uses one fixed bounded server policy without customer-supplied values', () => {
    expect(INTAKE_V1_WEBSITE_RESEARCH_POLICY).toEqual({
      version: 'intake-v1-processing-v1',
      maxPages: 4,
      maxDepth: 1,
      maxBytesPerPage: 1_000_000,
      maxDurationMs: 30_000,
      maxCostUnits: 8,
      userAgent: 'TorchikoIntakeV1Research/1.0',
    })
  })

  it('binds the service actor to the durable dispatch identity', () => {
    expect(intakeV1WebsiteResearchActor('dispatch_1')).toBe('intake-v1-website-research:dispatch_1')
  })
})
