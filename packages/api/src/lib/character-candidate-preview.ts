import { createHash } from 'node:crypto'

import type { CharacterSpec } from '@pathfinder/character-factory'

import type { CharacterArtifactReference } from './character-artifact-storage'

const MAX_MASTER_BYTES = 2_000_000

type VerifiedBundle = {
  reference: CharacterArtifactReference
  spec: CharacterSpec
  bytes: Uint8Array
}

export type CharacterCandidateArtifactReader = {
  getVerified(input: {
    tenantId: string
    venueId: string
    reference: unknown
    expectedSpec: CharacterSpec
  }): Promise<VerifiedBundle>
}

export type CharacterCandidateMasterPreview = {
  mediaType: 'image/png' | 'image/svg+xml'
  bytesBase64: string
  sha256: string
}

export class CharacterCandidatePreviewError extends Error {}

function base64Bytes(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !value)
    throw new CharacterCandidatePreviewError('Missing asset bytes.')
  try {
    return Uint8Array.from(globalThis.atob(value), (character) => character.charCodeAt(0))
  } catch {
    throw new CharacterCandidatePreviewError('Master asset bytes are not base64.')
  }
}

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

function encodeBase64(bytes: Uint8Array) {
  let binary = ''
  for (const value of bytes) binary += String.fromCharCode(value)
  return globalThis.btoa(binary)
}

/** Reads a scope- and version-verified portable bundle; it never fetches arbitrary asset URLs. */
export async function readCharacterCandidateMasterPreview(input: {
  tenantId: string
  venueId: string
  artifactReference: unknown
  expectedSpec: CharacterSpec
  reader: CharacterCandidateArtifactReader
}): Promise<CharacterCandidateMasterPreview> {
  const verified = await input.reader.getVerified({
    tenantId: input.tenantId,
    venueId: input.venueId,
    reference: input.artifactReference,
    expectedSpec: input.expectedSpec,
  })
  if (
    verified.spec.characterId !== input.expectedSpec.characterId ||
    verified.spec.version !== input.expectedSpec.version ||
    verified.spec.masterReference !== input.expectedSpec.masterReference
  )
    throw new CharacterCandidatePreviewError(
      'Verified bundle does not match the expected character.',
    )

  let decoded: unknown
  try {
    decoded = JSON.parse(new TextDecoder().decode(verified.bytes))
  } catch {
    throw new CharacterCandidatePreviewError('Verified bundle is not readable.')
  }
  const assets =
    decoded && typeof decoded === 'object' && !Array.isArray(decoded) && 'assets' in decoded
      ? (decoded as { assets?: unknown }).assets
      : undefined
  if (!Array.isArray(assets))
    throw new CharacterCandidatePreviewError('Verified bundle has no assets.')
  const master = assets.find(
    (asset): asset is Record<string, unknown> =>
      Boolean(asset) &&
      typeof asset === 'object' &&
      !Array.isArray(asset) &&
      asset.path === verified.spec.masterReference &&
      asset.role === 'master',
  )
  if (!master) throw new CharacterCandidatePreviewError('Verified bundle has no master asset.')
  if (master.mediaType !== 'image/png' && master.mediaType !== 'image/svg+xml')
    throw new CharacterCandidatePreviewError('Master asset media type is unsupported.')
  const bytes = base64Bytes(master.bytesBase64)
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MASTER_BYTES)
    throw new CharacterCandidatePreviewError('Master asset exceeds the preview byte limit.')
  const digest = sha256(bytes)
  if (
    master.mediaType !== verified.spec.source.mediaType ||
    digest !== verified.spec.source.sha256 ||
    bytes.byteLength !== verified.spec.source.byteLength ||
    master.sha256 !== digest
  )
    throw new CharacterCandidatePreviewError('Master asset does not match source provenance.')
  return { mediaType: master.mediaType, bytesBase64: encodeBase64(bytes), sha256: digest }
}
