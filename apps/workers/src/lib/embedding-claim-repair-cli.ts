import { AI_EMBEDDING_MODEL_KEYS, getAiEmbeddingProfile } from '@pathfinder/ai'
import { repairCompleteClaimMissingVector } from '@pathfinder/db'

export type EmbeddingClaimRepairCommand = {
  tenantId: string
  venueId: string
  entityType: 'PLACE' | 'KNOWLEDGE_ENTRY'
  entityId: string
  actorId: string
  dispatcherDisabledAsserted: true
}

const ALLOWED_ARGUMENTS = new Set([
  '--repair-reason',
  '--tenant-id',
  '--venue-id',
  '--entity-type',
  '--entity-id',
  '--confirm-entity-id',
  '--confirm-dispatcher-disabled',
  '--actor-id',
])

function readArguments(argv: string[]): Map<string, string> {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Expected --name value arguments; invalid token ${key ?? '<missing>'}`)
    }
    if (values.has(key)) throw new Error(`Duplicate argument ${key}`)
    if (!ALLOWED_ARGUMENTS.has(key)) throw new Error(`Unknown argument ${key}`)
    values.set(key, value)
  }
  return values
}

export function parseEmbeddingClaimRepairArgs(
  argv: string[],
  environment: NodeJS.ProcessEnv,
): EmbeddingClaimRepairCommand {
  const args = readArguments(argv)
  if (environment.RAILWAY_ENVIRONMENT !== 'staging') {
    throw new Error('Claim repair requires RAILWAY_ENVIRONMENT=staging')
  }
  if (environment.EMBEDDING_DISPATCH_ENABLED !== 'false') {
    throw new Error('Claim repair requires explicit EMBEDDING_DISPATCH_ENABLED=false')
  }
  if (args.get('--repair-reason') !== 'complete-claim-missing-vector-invariant-breach') {
    throw new Error('Claim repair requires the exact supported --repair-reason')
  }
  const tenantId = args.get('--tenant-id')
  const venueId = args.get('--venue-id')
  const entityType = args.get('--entity-type')
  const entityId = args.get('--entity-id')
  const actorId = args.get('--actor-id')
  if (!tenantId || !venueId || !entityId || !actorId) {
    throw new Error('Claim repair requires tenant, venue, entity, and operator-asserted actor ID')
  }
  if (entityType !== 'PLACE' && entityType !== 'KNOWLEDGE_ENTRY') {
    throw new Error('Claim repair requires --entity-type PLACE or KNOWLEDGE_ENTRY')
  }
  if (args.get('--confirm-entity-id') !== entityId) {
    throw new Error('--confirm-entity-id must exactly match --entity-id')
  }
  if (args.get('--confirm-dispatcher-disabled') !== 'true') {
    throw new Error('Claim repair requires --confirm-dispatcher-disabled true')
  }
  return {
    tenantId,
    venueId,
    entityType,
    entityId,
    actorId,
    dispatcherDisabledAsserted: true,
  }
}

export async function runEmbeddingClaimRepairCommand(command: EmbeddingClaimRepairCommand) {
  if (process.env.RAILWAY_ENVIRONMENT !== 'staging') {
    throw new Error('Claim repair execution requires RAILWAY_ENVIRONMENT=staging')
  }
  if (process.env.EMBEDDING_DISPATCH_ENABLED !== 'false') {
    throw new Error('Claim repair execution requires EMBEDDING_DISPATCH_ENABLED=false')
  }
  const expectedProfile = getAiEmbeddingProfile(
    command.entityType === 'PLACE'
      ? AI_EMBEDDING_MODEL_KEYS.PLACE_CONTENT
      : AI_EMBEDDING_MODEL_KEYS.KNOWLEDGE_CONTENT,
  )
  const result = await repairCompleteClaimMissingVector({ ...command, expectedProfile })
  return {
    mode: 'complete-claim-missing-vector-repair' as const,
    result,
    dispatcherDisablement: {
      localProcessEnvDisabled: true,
      operatorAssertedWorkerDisabled: command.dispatcherDisabledAsserted,
      independentlyVerified: false,
    },
  }
}
