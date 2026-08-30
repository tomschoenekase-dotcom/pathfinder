import { ExternalCredentialVerificationError, verifyAgentBridgeCredential } from '@pathfinder/db'

import {
  allowAgentBridgeHttpAttempt,
  handleAgentBridgeHttpRequestCore,
  type AgentBridgeHttpRegistry,
} from './http-core'
import { createAgentBridgeRegistry } from './registry'

type Registry = ReturnType<typeof createAgentBridgeRegistry>

/** Bounded HTTP composition for a user-controlled bridge runner. Authentication
 * occurs before request-body parsing and all errors are non-secret shaped. */
export function handleAgentBridgeHttpRequest(
  request: Request,
  rawScope: unknown,
  dependencies: {
    verify?: typeof verifyAgentBridgeCredential
    registry?: Registry
    allowAttempt?: (key: string) => boolean
  } = {},
): Promise<Response> {
  return handleAgentBridgeHttpRequestCore(request, rawScope, {
    verify: dependencies.verify ?? verifyAgentBridgeCredential,
    registry: (dependencies.registry ?? createAgentBridgeRegistry()) as AgentBridgeHttpRegistry,
    isAuthenticationError: (error) => error instanceof ExternalCredentialVerificationError,
    allowAttempt: dependencies.allowAttempt ?? allowAgentBridgeHttpAttempt,
  })
}
