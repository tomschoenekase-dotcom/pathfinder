import { getVenuePackageSemanticCoverage } from '@pathfinder/db'

import {
  buildIncompleteSemanticScan,
  VENUE_PACKAGE_SEMANTIC_PROFILES,
  venuePackageSemanticInputs,
} from '../../lib/venue-package-semantic-analysis'
import type { VenuePackagePayload } from '../../schemas/venue-package'
import type { PackageIssue } from './package-issues'

/**
 * The import's duplicate scan compares a package with the venue's existing records by their search
 * embeddings, and refuses the whole package (SEMANTIC_SCAN_INCOMPLETE) when any existing record of a
 * scanned kind has none. Records from a previous import have none until the venue embedding refresh
 * runs. This reads the same coverage, read-only, so venues.check_package predicts that refusal.
 */
export async function packageEmbeddingReadiness(
  database: unknown,
  params: { tenantId: string; venueId: string; payload: VenuePackagePayload },
): Promise<PackageIssue[]> {
  const inputs = venuePackageSemanticInputs(params.payload)
  if (inputs.places.length === 0 && inputs.knowledgeEntries.length === 0) return []
  const payload = params.payload
  const coverage = await getVenuePackageSemanticCoverage(database as never, {
    tenantId: params.tenantId,
    venueId: params.venueId,
    placeProfile: VENUE_PACKAGE_SEMANTIC_PROFILES.places,
    knowledgeProfile: VENUE_PACKAGE_SEMANTIC_PROFILES.knowledgeEntries,
    scanPlaces: inputs.places.length > 0,
    scanKnowledgeEntries: inputs.knowledgeEntries.length > 0,
    ...(payload.schemaVersion === 3
      ? {
          excludedPlaceIds: [...payload.places.update, ...payload.places.delete].map(
            (operation) => operation.id,
          ),
          excludedKnowledgeEntryIds: [
            ...payload.knowledgeEntries.update,
            ...payload.knowledgeEntries.delete,
          ].map((operation) => operation.id),
        }
      : {}),
  })
  return buildIncompleteSemanticScan({ payload, coverage }).errors.map((error) => ({
    code: error.code,
    path: error.path,
    message: `Existing ${error.path === 'places' ? 'places' : 'topics'} have no current search embeddings, so the import's duplicate scan would refuse this package and change nothing. ${error.message}`,
    fix: 'Records from an earlier import get embeddings only when the venue embedding refresh runs (an operator step in the Torchiko runbook; there is no MCP tool for it). Ask the operator to run it for this venue, then check again. Nothing is wrong with the package itself.',
  }))
}
