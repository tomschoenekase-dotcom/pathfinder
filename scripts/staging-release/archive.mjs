import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, scryptSync } from 'node:crypto'

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function key(passphrase, salt) {
  if (typeof passphrase !== 'string' || passphrase.length < 20) throw new Error('backup-passphrase-required')
  return scryptSync(passphrase, salt, 32)
}

export function encryptArchive(plaintext, passphrase, authenticatedMetadata = {}) {
  if (authenticatedMetadata?.mode !== 'synthetic-disposable') throw new Error('synthetic-passphrase-forbidden')
  const salt = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(passphrase, salt), iv)
  cipher.setAAD(Buffer.from(JSON.stringify(authenticatedMetadata)))
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    encrypted,
    encryption: { algorithm: 'aes-256-gcm', salt: salt.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex') },
    authenticatedMetadata,
    archiveSha256: sha256(encrypted),
  }
}

export function decryptArchive(encrypted, passphrase, manifest) {
  if (!Buffer.isBuffer(encrypted)) throw new Error('invalid-archive-bytes')
  if (manifest?.encryption?.algorithm !== 'aes-256-gcm') throw new Error('unsupported-archive-encryption')
  if (manifest?.authenticatedMetadata?.mode !== 'synthetic-disposable' ||
      (manifest.mode !== undefined && manifest.mode !== 'synthetic-disposable')) throw new Error('synthetic-passphrase-forbidden')
  if (typeof manifest.archiveSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(manifest.archiveSha256) || sha256(encrypted) !== manifest.archiveSha256) throw new Error('archive-hash-mismatch')
  const { salt, iv, tag } = manifest.encryption
  if (typeof salt !== 'string' || !/^[0-9a-f]{64}$/u.test(salt) || typeof iv !== 'string' || !/^[0-9a-f]{24}$/u.test(iv) || typeof tag !== 'string' || !/^[0-9a-f]{32}$/u.test(tag)) throw new Error('invalid-archive-metadata')
  const decipher = createDecipheriv('aes-256-gcm', key(passphrase, Buffer.from(salt, 'hex')), Buffer.from(iv, 'hex'))
  decipher.setAAD(Buffer.from(JSON.stringify(manifest.authenticatedMetadata ?? {})))
  decipher.setAuthTag(Buffer.from(tag, 'hex'))
  return Buffer.concat([decipher.update(encrypted), decipher.final()])
}

function writeChunk(destination, chunk) {
  if (typeof destination === 'function') return Promise.resolve(destination(chunk))
  return new Promise((resolve, reject) => {
    if (destination.destroyed) return reject(new Error('archive-output-failed'))
    destination.write(chunk, (error) => error ? reject(new Error('archive-output-failed')) : resolve())
  })
}

function streamKey(config) {
  if (config && typeof config === 'object' && ('passphrase' in config || config.mode !== undefined)) {
    if (config.mode !== 'synthetic-disposable') throw new Error('synthetic-passphrase-forbidden')
    if (typeof config.passphrase !== 'string' || config.passphrase.length < 20) throw new Error('backup-passphrase-required')
    const salt = randomBytes(32)
    return { key: key(config.passphrase, salt), encryption: { algorithm: 'aes-256-gcm', salt: salt.toString('hex'), iv: randomBytes(12).toString('hex') } }
  }
  let publicKey
  try {
    const input = config?.publicKey ?? config
    publicKey = input?.type === 'public' ? input : createPublicKey(input)
  } catch { throw new Error('invalid-backup-public-key') }
  if (publicKey.asymmetricKeyType !== 'x25519') throw new Error('invalid-backup-public-key')
  const ephemeral = generateKeyPairSync('x25519')
  const salt = randomBytes(32)
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey })
  const derived = Buffer.from(hkdfSync('sha256', shared, salt, Buffer.from('pathfinder-staging-archive-v1'), 32))
  shared.fill(0)
  return {
    key: derived,
    encryption: {
      algorithm: 'x25519-aes-256-gcm',
      ephemeralPublicKey: ephemeral.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      salt: salt.toString('base64'),
      iv: randomBytes(12).toString('base64'),
    },
  }
}

function privateStreamKey(privateKeyInput, encryption) {
  if (encryption?.algorithm === 'aes-256-gcm') {
    const salt = Buffer.from(encryption.salt ?? '', 'hex')
    if (salt.length !== 32) throw new Error('invalid-archive-metadata')
    return key(privateKeyInput, salt)
  }
  if (encryption?.algorithm !== 'x25519-aes-256-gcm') throw new Error('unsupported-archive-encryption')
  let privateKey
  try { privateKey = privateKeyInput?.type === 'private' ? privateKeyInput : createPrivateKey(privateKeyInput) } catch { throw new Error('invalid-backup-private-key') }
  if (privateKey.asymmetricKeyType !== 'x25519') throw new Error('invalid-backup-private-key')
  let ephemeralPublicKey, salt
  try {
    ephemeralPublicKey = createPublicKey({ key: Buffer.from(encryption.ephemeralPublicKey, 'base64'), type: 'spki', format: 'der' })
    salt = Buffer.from(encryption.salt, 'base64')
    if (salt.length !== 32) throw new Error()
  } catch { throw new Error('invalid-archive-metadata') }
  const shared = diffieHellman({ privateKey, publicKey: ephemeralPublicKey })
  const derived = Buffer.from(hkdfSync('sha256', shared, salt, Buffer.from('pathfinder-staging-archive-v1'), 32))
  shared.fill(0)
  return derived
}

function encryptionIv(encryption) {
  const iv = Buffer.from(encryption.iv ?? '', encryption.algorithm === 'aes-256-gcm' ? 'hex' : 'base64')
  if (iv.length !== 12) throw new Error('invalid-archive-metadata')
  return iv
}

export async function encryptArchiveStream(readable, destination, keyConfig, authenticatedMetadata = {}) {
  let material
  try { material = streamKey(keyConfig) } catch (error) { throw error }
  const encryption = material.encryption
  const cipher = createCipheriv('aes-256-gcm', material.key, encryptionIv(encryption))
  cipher.setAAD(Buffer.from(JSON.stringify(authenticatedMetadata)))
  const hash = createHash('sha256')
  let plaintextBytes = 0
  try {
    for await (const chunk of readable) {
      const bytes = Buffer.from(chunk)
      plaintextBytes += bytes.length
      const encrypted = cipher.update(bytes)
      if (encrypted.length) { hash.update(encrypted); await writeChunk(destination, encrypted) }
    }
    const final = cipher.final()
    if (final.length) { hash.update(final); await writeChunk(destination, final) }
    encryption.tag = cipher.getAuthTag().toString(encryption.algorithm === 'aes-256-gcm' ? 'hex' : 'base64')
    return { encryption, authenticatedMetadata, archiveSha256: hash.digest('hex'), plaintextBytes }
  } catch (error) {
    if (['postgres-client-start-failed', 'postgres-client-failed', 'backup-output-write-failed'].includes(error?.message)
      || error?.message?.startsWith('archive-') || error?.message?.startsWith('invalid-') || error?.message?.startsWith('synthetic-')) throw error
    throw new Error('archive-encryption-failed')
  } finally { material.key.fill(0) }
}

export async function decryptArchiveStream(readable, destination, privateKeyInput, manifest) {
  if (!destination || typeof destination.write !== 'function' || typeof destination.commit !== 'function' || typeof destination.abort !== 'function') {
    throw new Error('archive-output-transaction-required')
  }
  if (typeof manifest?.archiveSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(manifest.archiveSha256)) {
    throw new Error('archive-hash-mismatch')
  }
  const encryption = manifest?.encryption
  if (encryption?.algorithm === 'aes-256-gcm' &&
      (manifest?.authenticatedMetadata?.mode !== 'synthetic-disposable' ||
       (manifest.mode !== undefined && manifest.mode !== 'synthetic-disposable'))) {
    throw new Error('synthetic-passphrase-forbidden')
  }
  const derived = privateStreamKey(privateKeyInput, encryption)
  const iv = encryptionIv(encryption)
  const decipher = createDecipheriv('aes-256-gcm', derived, iv)
  decipher.setAAD(Buffer.from(JSON.stringify(manifest.authenticatedMetadata ?? {})))
  let tag
  try {
    tag = Buffer.from(encryption.tag ?? '', encryption.algorithm === 'aes-256-gcm' ? 'hex' : 'base64')
    if (tag.length !== 16) throw new Error('invalid-archive-metadata')
    decipher.setAuthTag(tag)
    const hash = createHash('sha256')
    for await (const chunk of readable) {
      const bytes = Buffer.from(chunk)
      hash.update(bytes)
      const plain = decipher.update(bytes)
      if (plain.length) await destination.write(plain)
    }
    if (hash.digest('hex') !== manifest.archiveSha256) throw new Error('archive-hash-mismatch')
    const final = decipher.final()
    if (final.length) await destination.write(final)
    await destination.commit()
  } catch (error) {
    try { await destination.abort() } catch {}
    if (error?.message?.startsWith('archive-') || error?.message?.startsWith('invalid-') || error?.message?.startsWith('unsupported-')) throw error
    throw new Error('archive-authentication-failed')
  } finally { derived.fill(0) }
}
