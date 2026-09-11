import { inspectImportedSkin } from './compatibility'
import {
  createCharacterExportArtifact,
  fingerprintFactoryRequest,
  sanitizeImportedSource,
} from './artifact'
import type { CharacterSpec, FactoryJobRequest, FactoryJobResult } from './types'

export interface CharacterFactoryStore {
  getCharacter(id: string): Promise<CharacterSpec | undefined>
  createCharacter(spec: CharacterSpec): Promise<boolean>
  compareAndSwapCharacter(spec: CharacterSpec, expectedRevision: number): Promise<boolean>
  getResult(requestId: string): Promise<FactoryJobResult | undefined>
  putResultIfAbsent(result: FactoryJobResult): Promise<FactoryJobResult>
}

export class MemoryCharacterFactoryStore implements CharacterFactoryStore {
  readonly characters = new Map<string, CharacterSpec>()
  readonly results = new Map<string, FactoryJobResult>()
  async getCharacter(id: string) {
    return this.characters.get(id)
  }
  async createCharacter(spec: CharacterSpec) {
    if (this.characters.has(spec.characterId)) return false
    this.characters.set(spec.characterId, spec)
    return true
  }
  async compareAndSwapCharacter(spec: CharacterSpec, expectedRevision: number) {
    if (this.characters.get(spec.characterId)?.revision !== expectedRevision) return false
    this.characters.set(spec.characterId, spec)
    return true
  }
  async getResult(id: string) {
    return this.results.get(id)
  }
  async putResultIfAbsent(result: FactoryJobResult) {
    const existing = this.results.get(result.requestId)
    if (existing) return existing
    this.results.set(result.requestId, result)
    return result
  }
}

export class CharacterFactoryEngine {
  private readonly cancelled = new Set<string>()
  private readonly active = new Map<string, Promise<FactoryJobResult>>()
  constructor(private readonly store: CharacterFactoryStore) {}

  cancel(requestId: string): void {
    this.cancelled.add(requestId)
  }

  async run(request: FactoryJobRequest): Promise<FactoryJobResult> {
    const requestFingerprint = fingerprintFactoryRequest(request.action)
    const completed = await this.store.getResult(request.requestId)
    if (completed) {
      if (completed.requestFingerprint && completed.requestFingerprint !== requestFingerprint) {
        return {
          requestId: request.requestId,
          requestFingerprint,
          status: 'failed',
          error: {
            code: 'DUPLICATE_REQUEST_MISMATCH',
            message: 'Request ID is already bound to another action.',
          },
        }
      }
      return completed
    }
    const running = this.active.get(request.requestId)
    if (running) return running
    const execution = this.execute(request, requestFingerprint).finally(() =>
      this.active.delete(request.requestId),
    )
    this.active.set(request.requestId, execution)
    return execution
  }

  private async finish(result: FactoryJobResult): Promise<FactoryJobResult> {
    return this.store.putResultIfAbsent(result)
  }

  private async execute(
    request: FactoryJobRequest,
    requestFingerprint: string,
  ): Promise<FactoryJobResult> {
    if (this.cancelled.has(request.requestId))
      return this.finish({ requestId: request.requestId, requestFingerprint, status: 'cancelled' })
    const action = request.action
    try {
      if (action.type === 'create-from-import') {
        const current = await this.store.getCharacter(action.spec.characterId)
        if (current)
          throw new FactoryError('CHARACTER_EXISTS', 'Use revise for an existing character.')
        const report = inspectImportedSkin(action.spec, action.svg)
        const spec = {
          ...action.spec,
          source: sanitizeImportedSource(action.spec.source),
          status: report.compatible ? ('candidate' as const) : ('invalid' as const),
        }
        if (this.cancelled.has(request.requestId))
          return this.finish({
            requestId: request.requestId,
            requestFingerprint,
            status: 'cancelled',
          })
        if (!(await this.store.createCharacter(spec)))
          throw new FactoryError('CHARACTER_EXISTS', 'Use revise for an existing character.')
        return this.finish({
          requestId: request.requestId,
          requestFingerprint,
          status: report.compatible ? 'succeeded' : 'failed',
          characterVersion: spec.version,
          output: report,
          ...(report.compatible
            ? {}
            : {
                error: {
                  code: 'VALIDATION_FAILED',
                  message: 'Imported skin failed compatibility checks.',
                },
              }),
        })
      }
      const current = await this.store.getCharacter(action.characterId)
      if (!current) throw new FactoryError('CHARACTER_NOT_FOUND', action.characterId)
      if (action.type === 'revise') {
        if (current.version !== action.baseVersion)
          throw new FactoryError(
            'LATE_RESULT_FENCED',
            `Expected version ${action.baseVersion}; found ${current.version}.`,
          )
        const revised = {
          ...current,
          version: current.version + 1,
          revision: current.revision + 1,
          ...(action.protectedTraits ? { protectedTraits: action.protectedTraits } : {}),
          status: 'candidate' as const,
        }
        if (this.cancelled.has(request.requestId))
          return this.finish({
            requestId: request.requestId,
            requestFingerprint,
            status: 'cancelled',
          })
        if (!(await this.store.compareAndSwapCharacter(revised, current.revision)))
          throw new FactoryError(
            'LATE_RESULT_FENCED',
            'Character changed while this revision was running.',
          )
        return this.finish({
          requestId: request.requestId,
          requestFingerprint,
          status: 'succeeded',
          characterVersion: revised.version,
          output: revised,
        })
      }
      if (action.type === 'preview')
        return this.finish({
          requestId: request.requestId,
          requestFingerprint,
          status: 'succeeded',
          characterVersion: current.version,
          output: {
            characterId: current.characterId,
            version: current.version,
            rigFamily: current.rigFamily,
            state: action.state,
            slotMap: current.slotMap,
          },
        })
      if (action.type === 'validate')
        return this.finish({
          requestId: request.requestId,
          requestFingerprint,
          status: current.status === 'invalid' ? 'failed' : 'succeeded',
          characterVersion: current.version,
          output: { valid: current.status !== 'invalid', protectedTraits: current.protectedTraits },
        })
      if (action.type === 'export') {
        if (current.status === 'invalid')
          throw new FactoryError('INVALID_CHARACTER', 'Invalid candidates cannot be exported.')
        const artifact = await createCharacterExportArtifact(current)
        const exported = {
          ...current,
          revision: current.revision + 1,
          source: sanitizeImportedSource(current.source),
          status: 'exported' as const,
        }
        if (!(await this.store.compareAndSwapCharacter(exported, current.revision)))
          throw new FactoryError(
            'LATE_RESULT_FENCED',
            'Character changed while this export was running.',
          )
        return this.finish({
          requestId: request.requestId,
          requestFingerprint,
          status: 'succeeded',
          characterVersion: exported.version,
          output: artifact,
        })
      }
      return this.finish({
        requestId: request.requestId,
        requestFingerprint,
        status: 'succeeded',
        characterVersion: current.version,
        output: current,
      })
    } catch (error) {
      const failure =
        error instanceof FactoryError
          ? error
          : new FactoryError(
              'UNEXPECTED_FACTORY_ERROR',
              error instanceof Error ? error.message : 'Unknown failure',
            )
      return this.finish({
        requestId: request.requestId,
        requestFingerprint,
        status: 'failed',
        error: { code: failure.code, message: failure.message },
      })
    }
  }
}

class FactoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}
