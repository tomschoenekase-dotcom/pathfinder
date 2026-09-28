import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { db } from './client'

export type PartnerApiCredentialEnvironment = 'dev' | 'test' | 'live'
export type PartnerApiCapability =
  | 'clients:read'
  | 'venues:read'
  | 'approved-content:read'
  | 'configuration:read'
  | 'readiness:read'
  | 'updates:read'

export type PartnerApiCredentialRecord = Readonly<{
  id: string
  publicId: string
  secretHmac: string
  environment: string
  tenantId: string
  clientId: string
  venueIds: string[]
  capabilities: string[]
  label: string
  createdByUserId: string
  createdAt: Date
  lastUsedAt: Date | null
  expiresAt: Date | null
  revokedAt: Date | null
  revokedReason: string | null
  rotatedFromId: string | null
}>

export type PartnerApiCredentialMetadata = Omit<PartnerApiCredentialRecord, 'secretHmac'>

export type PartnerApiCredentialScope = Readonly<{
  credentialId: string
  publicId: string
  tenantId: string
  clientId: string
  venueIds: string[]
  capabilities: PartnerApiCapability[]
}>

export type PartnerApiCredentialRepository = Readonly<{
  create: (
    data: Omit<
      PartnerApiCredentialRecord,
      'id' | 'createdAt' | 'lastUsedAt' | 'revokedAt' | 'revokedReason'
    >,
  ) => Promise<PartnerApiCredentialRecord>
  findByPublicId: (publicId: string) => Promise<PartnerApiCredentialRecord | null>
  findById: (id: string, tenantId: string) => Promise<PartnerApiCredentialRecord | null>
  listByTenant: (tenantId: string) => Promise<PartnerApiCredentialRecord[]>
  venueIdsBelongToTenant: (tenantId: string, venueIds: readonly string[]) => Promise<boolean>
  update: (
    id: string,
    tenantId: string,
    data: Partial<Pick<PartnerApiCredentialRecord, 'lastUsedAt' | 'revokedAt' | 'revokedReason'>>,
  ) => Promise<PartnerApiCredentialRecord>
}>

export type CreatePartnerApiCredentialInput = Readonly<{
  tenantId: string
  clientId: string
  venueIds: readonly string[]
  capabilities: readonly PartnerApiCapability[]
  label: string
  createdByUserId: string
  expiresAt?: Date | null
}>

export class PartnerApiCredentialConfigurationError extends Error {
  constructor() {
    super('Partner API credential service is not configured.')
    this.name = 'PartnerApiCredentialConfigurationError'
  }
}

export class PartnerApiCredentialInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PartnerApiCredentialInputError'
  }
}

export class PartnerApiCredentialNotFoundError extends Error {
  constructor() {
    super('Partner API credential was not found.')
    this.name = 'PartnerApiCredentialNotFoundError'
  }
}

const allowedCapabilities = new Set<PartnerApiCapability>([
  'clients:read',
  'venues:read',
  'approved-content:read',
  'configuration:read',
  'readiness:read',
  'updates:read',
])
const tokenPattern = /^tk_(dev|test|live)_([A-Za-z0-9_-]{16})_([A-Za-z0-9_-]{43})$/
const dummyDigest = Buffer.alloc(32)

function hmac(secret: string, pepper: string): Buffer {
  return createHmac('sha256', pepper).update(secret, 'utf8').digest()
}

function recordDigest(value: string): Buffer {
  if (!/^[a-f0-9]{64}$/i.test(value)) return Buffer.alloc(32)
  return Buffer.from(value, 'hex')
}

function equalDigest(candidate: Buffer, stored: Buffer): boolean {
  return candidate.length === stored.length && timingSafeEqual(candidate, stored)
}

function safeScope(record: PartnerApiCredentialRecord): PartnerApiCredentialScope {
  return {
    credentialId: record.id,
    publicId: record.publicId,
    tenantId: record.tenantId,
    clientId: record.clientId,
    venueIds: [...record.venueIds],
    capabilities: record.capabilities as PartnerApiCapability[],
  }
}

function safeMetadata(record: PartnerApiCredentialRecord): PartnerApiCredentialMetadata {
  return {
    id: record.id,
    publicId: record.publicId,
    environment: record.environment,
    tenantId: record.tenantId,
    clientId: record.clientId,
    venueIds: [...record.venueIds],
    capabilities: [...record.capabilities],
    label: record.label,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    revokedReason: record.revokedReason,
    rotatedFromId: record.rotatedFromId,
  }
}

function validateCreateInput(input: CreatePartnerApiCredentialInput): void {
  for (const [name, value] of Object.entries({
    tenantId: input.tenantId,
    clientId: input.clientId,
    createdByUserId: input.createdByUserId,
  })) {
    if (!value.trim() || value.length > 191)
      throw new PartnerApiCredentialInputError(`Invalid ${name}.`)
  }
  if (input.clientId !== input.tenantId)
    throw new PartnerApiCredentialInputError('Client must match tenant scope.')
  if (!input.label.trim() || input.label.length > 120)
    throw new PartnerApiCredentialInputError('Label must be between 1 and 120 characters.')
  if (input.venueIds.length > 500 || input.venueIds.some((id) => !id.trim() || id.length > 120))
    throw new PartnerApiCredentialInputError('Venue scope is invalid.')
  if (new Set(input.venueIds).size !== input.venueIds.length)
    throw new PartnerApiCredentialInputError('Venue scope must be unique.')
  if (input.capabilities.length > allowedCapabilities.size || input.capabilities.length === 0)
    throw new PartnerApiCredentialInputError('At least one valid capability is required.')
  if (input.capabilities.some((capability) => !allowedCapabilities.has(capability)))
    throw new PartnerApiCredentialInputError('Capability is invalid.')
  if (new Set(input.capabilities).size !== input.capabilities.length)
    throw new PartnerApiCredentialInputError('Capabilities must be unique.')
  if (
    input.expiresAt &&
    (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt <= new Date())
  )
    throw new PartnerApiCredentialInputError('Expiry must be a future date.')
}

export function createPartnerApiCredentialService(
  options: Readonly<{
    repository: PartnerApiCredentialRepository
    pepper: string | undefined
    environment: PartnerApiCredentialEnvironment
  }>,
): Readonly<{
  create: (
    input: CreatePartnerApiCredentialInput,
  ) => Promise<{ credential: PartnerApiCredentialMetadata; token: string }>
  rotate: (
    input: Readonly<{ id: string; tenantId: string; createdByUserId: string; expiresAt?: Date }>,
  ) => Promise<{ credential: PartnerApiCredentialMetadata; token: string }>
  revoke: (
    input: Readonly<{ id: string; tenantId: string; reason: string }>,
    now?: Date,
  ) => Promise<PartnerApiCredentialMetadata>
  verify: (token: string, now?: Date) => Promise<PartnerApiCredentialScope | null>
  list: (tenantId: string) => Promise<PartnerApiCredentialMetadata[]>
}> {
  const { repository, pepper, environment } = options
  if (
    !pepper ||
    Buffer.byteLength(pepper, 'utf8') < 32 ||
    !['dev', 'test', 'live'].includes(environment)
  ) {
    throw new PartnerApiCredentialConfigurationError()
  }
  const activePepper = pepper

  async function mint(input: CreatePartnerApiCredentialInput, rotatedFromId: string | null) {
    validateCreateInput(input)
    if (!(await repository.venueIdsBelongToTenant(input.tenantId, input.venueIds))) {
      throw new PartnerApiCredentialInputError('Venue scope must belong to the client tenant.')
    }
    const publicId = randomBytes(12).toString('base64url')
    const secret = randomBytes(32).toString('base64url')
    const token = `tk_${environment}_${publicId}_${secret}`
    const credential = await repository.create({
      publicId,
      secretHmac: hmac(secret, activePepper).toString('hex'),
      environment,
      tenantId: input.tenantId,
      clientId: input.clientId,
      venueIds: [...input.venueIds],
      capabilities: [...input.capabilities],
      label: input.label.trim(),
      createdByUserId: input.createdByUserId,
      expiresAt: input.expiresAt ?? null,
      rotatedFromId,
    })
    return { credential: safeMetadata(credential), token }
  }

  return {
    create: (input) => mint(input, null),
    async rotate({ id, tenantId, createdByUserId, expiresAt }) {
      const existing = await repository.findById(id, tenantId)
      if (!existing) throw new PartnerApiCredentialNotFoundError()
      if (existing.revokedAt || (existing.expiresAt && existing.expiresAt <= new Date())) {
        throw new PartnerApiCredentialInputError('Only active credentials may be rotated.')
      }
      return mint(
        {
          tenantId: existing.tenantId,
          clientId: existing.clientId,
          venueIds: existing.venueIds,
          capabilities: existing.capabilities as PartnerApiCapability[],
          label: existing.label,
          createdByUserId,
          expiresAt: expiresAt ?? existing.expiresAt,
        },
        existing.id,
      )
    },
    async revoke({ id, tenantId, reason }, now = new Date()) {
      if (!reason.trim() || reason.length > 500)
        throw new PartnerApiCredentialInputError(
          'Revocation reason must be between 1 and 500 characters.',
        )
      const existing = await repository.findById(id, tenantId)
      if (!existing) throw new PartnerApiCredentialNotFoundError()
      if (existing.revokedAt) return safeMetadata(existing)
      return safeMetadata(
        await repository.update(id, tenantId, { revokedAt: now, revokedReason: reason.trim() }),
      )
    },
    async verify(token, now = new Date()) {
      const match = tokenPattern.exec(token)
      const publicId = match?.[2] ?? ''
      const secret = match?.[3] ?? ''
      const candidate = hmac(secret, activePepper)
      const record =
        match && match[1] === environment ? await repository.findByPublicId(publicId) : null
      const stored = record ? recordDigest(record.secretHmac) : dummyDigest
      const validSecret = equalDigest(candidate, stored)
      if (!match || match[1] !== environment || !record || !validSecret) return null
      if (
        record.environment !== environment ||
        record.clientId !== record.tenantId ||
        record.capabilities.length === 0 ||
        record.capabilities.some(
          (capability) => !allowedCapabilities.has(capability as PartnerApiCapability),
        ) ||
        new Set(record.capabilities).size !== record.capabilities.length ||
        record.venueIds.length > 500 ||
        new Set(record.venueIds).size !== record.venueIds.length ||
        record.revokedAt ||
        (record.expiresAt && record.expiresAt <= now)
      )
        return null
      if (!(await repository.venueIdsBelongToTenant(record.tenantId, record.venueIds))) return null
      await repository.update(record.id, record.tenantId, { lastUsedAt: now })
      return safeScope(record)
    },
    async list(tenantId) {
      return (await repository.listByTenant(tenantId)).map(safeMetadata)
    },
  }
}

const prismaPartnerApiCredentialRepository: PartnerApiCredentialRepository = {
  async create(data) {
    return db.partnerApiCredential.create({ data })
  },
  async findByPublicId(publicId) {
    return db.partnerApiCredential.findUnique({ where: { publicId } })
  },
  async findById(id, tenantId) {
    return db.partnerApiCredential.findFirst({ where: { id, tenantId } })
  },
  async listByTenant(tenantId) {
    return db.partnerApiCredential.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } })
  },
  async venueIdsBelongToTenant(tenantId, venueIds) {
    if (venueIds.length === 0) return true
    const matchingVenueCount = await db.venue.count({
      where: { tenantId, id: { in: [...venueIds] } },
    })
    return matchingVenueCount === venueIds.length
  },
  async update(id, tenantId, data) {
    return db.partnerApiCredential.update({ where: { id_tenantId: { id, tenantId } }, data })
  },
}

export function createDatabasePartnerApiCredentialService(
  options: Readonly<{
    pepper: string | undefined
    environment: PartnerApiCredentialEnvironment
  }>,
) {
  return createPartnerApiCredentialService({
    ...options,
    repository: prismaPartnerApiCredentialRepository,
  })
}
