import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const listSource = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')
const detailSource = readFileSync(new URL('./[reportId]/page.tsx', import.meta.url), 'utf8')

describe('internal weekly report operations surface', () => {
  it('uses bounded cursor pagination while retaining the selected range', () => {
    expect(listSource).toContain('limit: 25')
    expect(listSource).toContain('cursorWeekStart')
    expect(listSource).toContain('cursorId')
    expect(listSource).toContain('Older reports')
    expect(listSource).toContain('Back to newest')
    expect(listSource).toContain('weekStart: toInputDate(weekStartDate)')
    expect(listSource).toContain('weekEnd: toInputDate(weekEndDate)')
    expect(listSource).toContain('aria-labelledby="report-history-heading"')
    expect(listSource).toContain('overflow-x-auto')
    expect(listSource).toContain('resolveAdminReportRouteInput(query)')
    expect(listSource).toContain('role="alert"')
  })

  it('recovers failed reports with a new generation request instead of mutating evidence', () => {
    expect(detailSource).toContain("report.status === 'FAILED'")
    expect(detailSource).toContain('<AdminGenerateWeeklyReportButton')
    expect(detailSource).toContain('The failed report remains')
    expect(detailSource).toContain('retrySeed={`failed-report:${report.id}`}')
    expect(detailSource).not.toMatch(/retryWeeklyReport|updateWeeklyReport.*FAILED/)
  })
})
