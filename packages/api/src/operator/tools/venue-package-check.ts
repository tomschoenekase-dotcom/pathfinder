import { parseChatAppearance } from '@pathfinder/contracts/chat-appearance'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'

import { buildVenuePackagePreview } from '../../lib/venue-package-core'
import { VenuePackagePayload } from '../../schemas/venue-package'
import { assertVenueInGrant } from '../grants'
import {
  counts,
  guideQualityFindings,
  resolvePackageAttachment,
} from '../kinds/venues-package-import'
import type { OperatorReadTool } from '../registry'

const SHOWN = 40

type SetupReader = {
  venue: {
    findFirst(args: unknown): Promise<{ guideMode: string | null; chatAppearance: unknown } | null>
  }
  place: { count(args: unknown): Promise<number> }
}

/**
 * Venue settings that change answers as much as the records do: without a time zone the guide gets
 * only a UTC date (no weekday or local time, and tomorrow's date in the venue's evening), and a
 * location-aware guide with no places adds a rule limiting suggestions to three.
 */
export async function venueSetupFindings(
  database: unknown,
  params: { tenantId: string; venueId: string; placesAfterImport: number },
): Promise<Issue[]> {
  const reader = database as SetupReader
  const venue = await reader.venue.findFirst({
    where: { id: params.venueId, tenantId: params.tenantId },
    select: { guideMode: true, chatAppearance: true },
  })
  if (!venue) return []
  const findings: Issue[] = []
  if (!parseChatAppearance(venue.chatAppearance).timeZone)
    findings.push({
      code: 'VENUE_SETUP_TIME_ZONE',
      path: 'chatAppearance.timeZone',
      message:
        'The venue has no time zone, so the guide gets only the UTC date: no weekday or local time, and the next day in the venue evening. Hours and open-now answers will be unreliable. Set chatAppearance.timeZone (an IANA zone such as America/New_York) with appearance.propose_update.',
    })
  if ((venue.guideMode ?? 'location_aware') === 'location_aware' && params.placesAfterImport === 0)
    findings.push({
      code: 'VENUE_SETUP_GUIDE_MODE',
      path: 'guideMode',
      message:
        'The venue is location-aware but has no places, so the guide is told to suggest at most three options even when a visitor asks for every one. Use guideMode non_location for a guide without mapped places.',
    })
  return findings
}
type Issue = { code: string; path: string; message: string }
const trim = ({ code, path, message }: Issue): Issue => ({
  code: code.slice(0, 80),
  path: path.slice(0, 300),
  message: message.slice(0, 600),
})

/**
 * Runs the import's deterministic checks on a package without saving a draft or calling a model:
 * the plan, validation errors and guide-quality findings. Agents fix and re-check until ready,
 * so the one import that follows lands cleanly.
 */
export const venuesCheckPackage: OperatorReadTool = {
  name: 'venues.check_package',
  capability: 'venues:read',
  async handler(raw, context) {
    const resolved = await resolvePackageAttachment(raw, context, 'venues:read')
    const input = OPERATOR_MCP_INPUTS['venues.check_package'].parse(resolved)
    await assertVenueInGrant(context.grant, input.tenantId, input.venueId, context.database)
    const parsed = VenuePackagePayload.safeParse(input.payload)
    if (!parsed.success) {
      const errors = parsed.error.issues.map((issue) =>
        trim({ code: 'INVALID_PACKAGE', path: issue.path.join('.'), message: issue.message }),
      )
      return {
        venueId: input.venueId,
        importable: false,
        ready: false,
        plan: null,
        errors: errors.slice(0, SHOWN),
        errorCount: errors.length,
        guideQuality: { total: 0, shown: [], next: 'Fix the package shape first.' },
        otherWarnings: [],
        otherWarningCount: 0,
        note: 'The package does not match the venue-package schema; nothing was checked further.',
      }
    }
    const preview = await buildVenuePackagePreview(
      context.database as never,
      input.tenantId,
      input.venueId,
      parsed.data,
    )
    const { errors, warnings } = preview.report
    const quality = guideQualityFindings(warnings)
    const plan = counts(parsed.data)
    const activePlaces = await (context.database as unknown as SetupReader).place.count({
      where: { tenantId: input.tenantId, venueId: input.venueId, isActive: true },
    })
    const venueSetup = await venueSetupFindings(context.database, {
      tenantId: input.tenantId,
      venueId: input.venueId,
      placesAfterImport: Math.max(0, activePlaces + plan.places.create - plan.places.remove),
    })
    const other = warnings.filter((warning) => !warning.code.startsWith('GUIDE_QUALITY_'))
    return {
      venueId: input.venueId,
      importable: errors.length === 0,
      ready: errors.length === 0 && quality.total === 0,
      plan,
      errors: errors.slice(0, SHOWN).map(trim),
      errorCount: errors.length,
      guideQuality: {
        total: quality.total,
        shown: quality.shown.map(trim),
        next:
          quality.total === 0
            ? 'Every record meets the writing guide.'
            : 'Rewrite the named records to the operator manual standard ("Writing guide records") and check again.',
      },
      otherWarnings: other.slice(0, SHOWN).map(trim),
      otherWarningCount: other.length,
      // Settings, not package content: they never change ready, but fix them before testing answers.
      venueSetup,
      note: 'Nothing was saved. The import also runs a semantic duplicate scan, which can add warnings; warnings never block an import.',
    }
  },
}
