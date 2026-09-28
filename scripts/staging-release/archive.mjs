import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from 'node:crypto'

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function key(passphrase, salt) {
  if (typeof passphrase !== 'string' || passphrase.length < 20) throw new Error('backup-passphrase-required')
  return scryptSync(passphrase, salt, 32)
}

export function encryptArchive(plaintext, passphrase, authenticatedMetadata = {}) {
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
  if (typeof manifest.archiveSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(manifest.archiveSha256) || sha256(encrypted) !== manifest.archiveSha256) throw new Error('archive-hash-mismatch')
  const { salt, iv, tag } = manifest.encryption
  if (typeof salt !== 'string' || !/^[0-9a-f]{64}$/u.test(salt) || typeof iv !== 'string' || !/^[0-9a-f]{24}$/u.test(iv) || typeof tag !== 'string' || !/^[0-9a-f]{32}$/u.test(tag)) throw new Error('invalid-archive-metadata')
  const decipher = createDecipheriv('aes-256-gcm', key(passphrase, Buffer.from(salt, 'hex')), Buffer.from(iv, 'hex'))
  decipher.setAAD(Buffer.from(JSON.stringify(manifest.authenticatedMetadata ?? {})))
  decipher.setAuthTag(Buffer.from(tag, 'hex'))
  return Buffer.concat([decipher.update(encrypted), decipher.final()])
}
