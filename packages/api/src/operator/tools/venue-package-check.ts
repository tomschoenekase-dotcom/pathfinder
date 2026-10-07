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
    const other = warnings.filter((warning) => !warning.code.startsWith('GUIDE_QUALITY_'))
    return {
      venueId: input.venueId,
      importable: errors.length === 0,
      ready: errors.length === 0 && quality.total === 0,
      plan: counts(parsed.data),
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
      note: 'Nothing was saved. The import also runs a semantic duplicate scan, which can add warnings; warnings never block an import.',
    }
  },
}
