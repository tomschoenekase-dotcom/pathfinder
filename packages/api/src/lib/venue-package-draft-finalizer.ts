import type { TRPCContext } from '../context'
import type { VenuePackageStoredPreview } from '../schemas/venue-package'

type DbClient = TRPCContext['db']

export type VenuePackageDraftFinalizer = (input: {
  tx: DbClient
  packageId: string
  tenantId: string
  venueId: string
  status: string
  createdBy: string
  preview: VenuePackageStoredPreview
  replayed: boolean
}) => Promise<unknown>

export class VenuePackageDraftFinalizerError extends Error {
  constructor(readonly cause: unknown) {
    super('Venue-package DRAFT attachment finalization failed')
    this.name = 'VenuePackageDraftFinalizerError'
  }
}
