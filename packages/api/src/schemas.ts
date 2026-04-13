/**
 * Client-safe schema exports — no server-only imports.
 * Import from '@pathfinder/api/schemas' in Client Components.
 */
export { CreateVenueInput, UpdateVenueInput } from './schemas/venue'
export { CreatePlaceInput, PlaceInput, UpdatePlaceInput } from './schemas/place'
export {
  CreateOperationalUpdateInputBase,
  CreateOperationalUpdateInput,
  DeactivateOperationalUpdateInput,
  OperationalUpdateSeverityInput,
} from './schemas/operational-update'
