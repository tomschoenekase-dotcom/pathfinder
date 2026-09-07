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
export type RigFamily = 'morph-v1' | 'compact-creature-v1' | 'humanoid-v1'

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

export interface CharacterSpec {
  schemaVersion: 1
  characterId: string
  version: number
  displayName: string
  rigFamily: RigFamily
  source: ImportedSource
  masterReference: string
  protectedTraits: readonly string[]
  slotMap: Readonly<Record<string, string>>
  supportedStates: readonly FactoryState[]
  status: 'candidate' | 'invalid' | 'exported'
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
  status: FactoryJobStatus
  characterVersion?: number
  output?: unknown
  error?: { code: string; message: string }
}
