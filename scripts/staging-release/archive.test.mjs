import assert from 'node:assert/strict'
import test from 'node:test'
import { encryptArchive, decryptArchive } from './archive.mjs'

const passphrase = 'synthetic-disposable-passphrase-for-ci-only'
test('encrypted archive decrypts only with its passphrase and intact bytes', () => {
  const plain = Buffer.from('synthetic pg_dump bytes')
  const result = encryptArchive(plain, passphrase)
  assert.notDeepEqual(result.encrypted, plain)
  assert.deepEqual(decryptArchive(result.encrypted, passphrase, result), plain)
  assert.throws(() => decryptArchive(result.encrypted, `${passphrase}-wrong`, result))
  assert.throws(() => decryptArchive(result.encrypted, passphrase, { ...result, authenticatedMetadata: { altered: true } }))
  assert.throws(() => decryptArchive(result.encrypted, passphrase, { ...result, encryption: { ...result.encryption, iv: '00' } }), /invalid-archive-metadata/u)
  const tampered = Buffer.from(result.encrypted)
  tampered[0] ^= 1
  assert.throws(() => decryptArchive(tampered, passphrase, result), /archive-hash-mismatch/u)
})
