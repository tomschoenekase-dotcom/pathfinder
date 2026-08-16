import { createHash } from 'node:crypto'

export const DEFAULT_WEEKLY_REPORT_TITLE = 'Torchico Weekly Report'
export const LEGACY_DEFAULT_WEEKLY_REPORT_TITLE = 'PathFinder Weekly Report'

type AnswerAnalysisIdentity = {
  kind: 'ANSWER_ANALYSIS'
  venueId: string
  rangeStart: Date
  rangeEnd: Date
}

type WeeklyReportIdentity = {
  kind: 'WEEKLY_REPORT'
  venueId: string
  rangeStart: Date
  rangeEnd: Date
  title?: string
}

export type GenerationRequestIdentity = AnswerAnalysisIdentity | WeeklyReportIdentity

export function effectiveWeeklyReportTitle(title?: string): string {
  const trimmed = title?.trim()
  return trimmed ? trimmed : DEFAULT_WEEKLY_REPORT_TITLE
}

export function generationRequestHash(identity: GenerationRequestIdentity): string {
  const canonical =
    identity.kind === 'ANSWER_ANALYSIS'
      ? [
          'pathfinder-generation-request-v1',
          identity.kind,
          identity.venueId,
          identity.rangeStart.toISOString(),
          identity.rangeEnd.toISOString(),
        ]
      : [
          'pathfinder-generation-request-v1',
          identity.kind,
          identity.venueId,
          identity.rangeStart.toISOString(),
          identity.rangeEnd.toISOString(),
          effectiveWeeklyReportTitle(identity.title),
        ]

  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}
