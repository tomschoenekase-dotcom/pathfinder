import { argon2Verify } from 'hash-wasm'
import { z } from 'zod'

import { McpCapability, VerifiedMcpCredentialScope } from '@pathfinder/contracts/mcp-v0'

import { db } from '../client'

const plaintextSchema = z.string().regex(/^pf_mcp_[A-Za-z0-9_-]{43}$/u)

export type ExternalCredentialVerificationClient = Pick<typeof db, 'externalAccessCredential'>

export class ExternalCredentialVerificationError extends Error {
  constructor(readonly code: 'INVALID' | 'INACTIVE') {
    super('Machine credential is invalid or inactive')
    this.name = 'ExternalCredentialVerificationError'
  }
}

/** Verifies a plaintext machine credential against one exact tenant/venue.
 * The plaintext and hash never leave this server-only boundary. */
export async function verifyAgentBridgeCredential(
  input: { tenantId: string; venueId: string; plaintext: string },
  client: ExternalCredentialVerificationClient = db,
): Promise<z.infer<typeof VerifiedMcpCredentialScope>> {
  const scope = z
    .object({
      tenantId: z.string().trim().min(1).max(191),
      venueId: z.string().trim().min(1).max(191),
      plaintext: plaintextSchema,
    })
    .safeParse(input)
  if (!scope.success) throw new ExternalCredentialVerificationError('INVALID')
  const prefix = scope.data.plaintext.slice(0, 20)
  const credential = await client.externalAccessCredential.findFirst({
    where: {
      tenantId: scope.data.tenantId,
      clientId: scope.data.tenantId,
      venueId: scope.data.venueId,
      kind: 'MCP',
      secretPrefix: prefix,
      enabled: true,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      capabilities: { has: 'agent-runs:execute' },
    },
    select: {
      id: true,
      tenantId: true,
      clientId: true,
      venueId: true,
      capabilities: true,
      secretHash: true,
    },
  })
  if (!credential || credential.venueId !== scope.data.venueId)
    throw new ExternalCredentialVerificationError('INACTIVE')
  let valid = false
  try {
    valid = await argon2Verify({ password: scope.data.plaintext, hash: credential.secretHash })
  } catch {
    valid = false
  }
  if (!valid) throw new ExternalCredentialVerificationError('INVALID')
  const capabilities = z.array(McpCapability).parse(credential.capabilities)
  return VerifiedMcpCredentialScope.parse({
    credentialId: credential.id,
    tenantId: credential.tenantId,
    clientId: credential.clientId,
    venueIds: [scope.data.venueId],
    capabilities,
  })
}
