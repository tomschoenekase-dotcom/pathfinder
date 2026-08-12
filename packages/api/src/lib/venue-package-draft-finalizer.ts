import { AsyncLocalStorage } from 'node:async_hooks'

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

type Store = { finalizer: VenuePackageDraftFinalizer; attachment?: unknown }
const storage = new AsyncLocalStorage<Store>()

export class VenuePackageDraftFinalizerError extends Error {
  constructor(readonly cause: unknown) {
    super('Venue-package DRAFT attachment finalization failed')
    this.name = 'VenuePackageDraftFinalizerError'
  }
}

export async function withVenuePackageDraftFinalizer<T>(
  finalizer: VenuePackageDraftFinalizer,
  operation: () => Promise<T>,
): Promise<{ value: T; attachment: unknown }> {
  const store: Store = { finalizer }
  const value = await storage.run(store, operation)
  return { value, attachment: store.attachment }
}

export async function runVenuePackageDraftFinalizer(
  input: Parameters<VenuePackageDraftFinalizer>[0],
) {
  const store = storage.getStore()
  if (!store) return
  try {
    store.attachment = await store.finalizer(input)
  } catch (error) {
    throw new VenuePackageDraftFinalizerError(error)
  }
}
