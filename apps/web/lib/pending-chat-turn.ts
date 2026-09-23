import { ChatSendInput } from '@pathfinder/api/schemas'
import type { inferRouterInputs } from '@trpc/server'
import type { AppRouter } from '@pathfinder/api'

export type RecoverableChatInput = inferRouterInputs<AppRouter>['chat']['send'] & {
  operationId: string
}
type Scope = { venueId: string; anonymousToken: string; secondLayerKey?: string }
const MAX_RECOVERY_CHARACTERS = 16_384

function key(scope: Scope): string {
  return `torchiko:visitor-turn:${scope.venueId}:${scope.anonymousToken}`
}

/** One exact, unconfirmed request in this tab. Not a visitor profile or a send queue. */
export function rememberPendingChatTurn(input: RecoverableChatInput): boolean {
  try {
    const serialized = JSON.stringify({ version: 1, input })
    if (serialized.length > MAX_RECOVERY_CHARACTERS) return false
    window.sessionStorage.setItem(key(input), serialized)
    return true
  } catch {
    // The current page retains its in-memory request even when tab storage is denied.
    return false
  }
}

export function readPendingChatTurn(
  scope: Scope,
): { kind: 'found'; input: RecoverableChatInput } | { kind: 'empty' | 'unavailable' | 'invalid' } {
  let serialized: string | null
  try {
    serialized = window.sessionStorage.getItem(key(scope))
  } catch {
    return { kind: 'unavailable' }
  }
  if (serialized === null) return { kind: 'empty' }
  if (serialized.length > MAX_RECOVERY_CHARACTERS) return { kind: 'invalid' }
  try {
    const saved = JSON.parse(serialized) as { version?: unknown; input?: unknown }
    const parsed = ChatSendInput.safeParse(saved.input)
    if (
      saved.version !== 1 ||
      !parsed.success ||
      !parsed.data.operationId ||
      parsed.data.venueId !== scope.venueId ||
      parsed.data.anonymousToken !== scope.anonymousToken ||
      parsed.data.secondLayerKey !== scope.secondLayerKey
    )
      return { kind: 'invalid' }
    // Validate with the existing API schema, but preserve the original frozen payload,
    // including omitted fields. Retrying must not apply new defaults or preferences.
    return { kind: 'found', input: saved.input as RecoverableChatInput }
  } catch {
    return { kind: 'invalid' }
  }
}

export function forgetPendingChatTurn(input: RecoverableChatInput): void {
  try {
    const saved = readPendingChatTurn(input)
    if (saved.kind === 'found' && saved.input.operationId === input.operationId)
      window.sessionStorage.removeItem(key(input))
  } catch {
    // Never turn a storage failure into a duplicate send or a failed successful answer.
  }
}
