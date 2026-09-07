export const FACTORY_STATES = [
  'idle',
  'attention',
  'listening',
  'thinking',
  'speaking',
  'happy',
  'sad',
  'success',
  'error',
  'reaction',
] as const

export type FactoryState = (typeof FACTORY_STATES)[number]
export type BuiltinRigFamily = 'morph-v1' | 'compact-creature-v1' | 'humanoid-v1'
export type RigFamily = BuiltinRigFamily | `custom:${string}`

export interface SemanticRigCapabilities {
  schemaVersion: 1
  familyId: RigFamily
  anatomyClass: 'creature' | 'humanoid' | 'morph' | 'object' | 'custom'
  requiredSlots: readonly string[]
  stateControls: Readonly<Partial<Record<FactoryState, readonly string[]>>>
}

export interface ImportedSource {
  kind: 'imported'
  sourceUrl: string
  sourceRevision: string
  license: string
  attribution: string
  importedAt: string
  sha256: string
  mediaType: 'image/svg+xml' | 'image/png'
  byteLength: number
}

export const CANONICAL_CHARACTER_STATUSES = [
  'requested',
  'generating',
  'candidate',
  'invalid',
  'exported',
  'active',
  'archived',
] as const
export type CanonicalCharacterStatus = (typeof CANONICAL_CHARACTER_STATUSES)[number]

export interface CharacterSpec {
  schemaVersion: 1
  characterId: string
  version: number
  revision: number
  displayName: string
  rigFamily: RigFamily
  rigCapabilities?: SemanticRigCapabilities
  source: ImportedSource
  masterReference: string
  protectedTraits: readonly string[]
  slotMap: Readonly<Record<string, string>>
  supportedStates: readonly FactoryState[]
  status: CanonicalCharacterStatus
}

export interface CompatibilityFinding {
  code: string
  severity: 'info' | 'warning' | 'error'
  detail: string
}

export interface CompatibilityReport {
  fixtureId: string
  compatible: boolean
  rigFamily: RigFamily
  stateCoverage: readonly FactoryState[]
  unsuitableStates: readonly FactoryState[]
  requiredManualCleanup: readonly string[]
  findings: readonly CompatibilityFinding[]
}

export type FactoryAction =
  | { type: 'create-from-import'; spec: CharacterSpec; svg: string }
  | {
      type: 'revise'
      characterId: string
      baseVersion: number
      protectedTraits?: readonly string[]
    }
  | { type: 'inspect'; characterId: string }
  | { type: 'preview'; characterId: string; state: FactoryState }
  | { type: 'validate'; characterId: string }
  | { type: 'export'; characterId: string }

export interface FactoryJobRequest {
  requestId: string
  action: FactoryAction
}

export type FactoryJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface FactoryJobResult {
  requestId: string
  requestFingerprint?: string
  status: FactoryJobStatus
  characterVersion?: number
  output?: unknown
  error?: { code: string; message: string }
}

export interface CharacterExportArtifact {
  mediaType: 'application/vnd.pathfinder.character+json'
  schemaVersion: 1
  characterId: string
  characterVersion: number
  sha256: string
  byteLength: number
  bytes: Uint8Array
}

export interface CharacterBundleAssetInput {
  path: string
  mediaType: 'image/svg+xml' | 'image/png'
  bytes: Uint8Array
  role: 'master' | 'slot' | 'fallback' | 'rig-source'
  slot?: string
}
