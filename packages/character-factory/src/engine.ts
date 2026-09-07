import { inspectImportedSkin } from './compatibility'
import type { CharacterSpec, FactoryJobRequest, FactoryJobResult } from './types'

export interface CharacterFactoryStore {
  getCharacter(id: string): Promise<CharacterSpec | undefined>
  putCharacter(spec: CharacterSpec): Promise<void>
  getResult(requestId: string): Promise<FactoryJobResult | undefined>
  putResult(result: FactoryJobResult): Promise<void>
}

export class MemoryCharacterFactoryStore implements CharacterFactoryStore {
  readonly characters = new Map<string, CharacterSpec>()
  readonly results = new Map<string, FactoryJobResult>()
  async getCharacter(id: string) {
    return this.characters.get(id)
  }
  async putCharacter(spec: CharacterSpec) {
    this.characters.set(spec.characterId, spec)
  }
  async getResult(id: string) {
    return this.results.get(id)
  }
  async putResult(result: FactoryJobResult) {
    this.results.set(result.requestId, result)
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
    const completed = await this.store.getResult(request.requestId)
    if (completed) return completed
    const running = this.active.get(request.requestId)
    if (running) return running
    const execution = this.execute(request).finally(() => this.active.delete(request.requestId))
    this.active.set(request.requestId, execution)
    return execution
  }

  private async finish(result: FactoryJobResult): Promise<FactoryJobResult> {
    await this.store.putResult(result)
    return result
  }

  private async execute(request: FactoryJobRequest): Promise<FactoryJobResult> {
    if (this.cancelled.has(request.requestId))
      return this.finish({ requestId: request.requestId, status: 'cancelled' })
    const action = request.action
    try {
      if (action.type === 'create-from-import') {
        const current = await this.store.getCharacter(action.spec.characterId)
        if (current)
          throw new FactoryError('CHARACTER_EXISTS', 'Use revise for an existing character.')
        const report = inspectImportedSkin(action.spec, action.svg)
        const spec = {
          ...action.spec,
          status: report.compatible ? ('candidate' as const) : ('invalid' as const),
        }
        if (this.cancelled.has(request.requestId))
          return this.finish({ requestId: request.requestId, status: 'cancelled' })
        await this.store.putCharacter(spec)
        return this.finish({
          requestId: request.requestId,
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
          ...(action.protectedTraits ? { protectedTraits: action.protectedTraits } : {}),
          status: 'candidate' as const,
        }
        if (this.cancelled.has(request.requestId))
          return this.finish({ requestId: request.requestId, status: 'cancelled' })
        await this.store.putCharacter(revised)
        return this.finish({
          requestId: request.requestId,
          status: 'succeeded',
          characterVersion: revised.version,
          output: revised,
        })
      }
      if (action.type === 'preview')
        return this.finish({
          requestId: request.requestId,
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
          status: current.status === 'invalid' ? 'failed' : 'succeeded',
          characterVersion: current.version,
          output: { valid: current.status !== 'invalid', protectedTraits: current.protectedTraits },
        })
      if (action.type === 'export') {
        if (current.status === 'invalid')
          throw new FactoryError('INVALID_CHARACTER', 'Invalid candidates cannot be exported.')
        const exported = { ...current, status: 'exported' as const }
        await this.store.putCharacter(exported)
        return this.finish({
          requestId: request.requestId,
          status: 'succeeded',
          characterVersion: exported.version,
          output: JSON.stringify(exported),
        })
      }
      return this.finish({
        requestId: request.requestId,
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
