import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync } from 'node:crypto'
import { Readable } from 'node:stream'
import { encryptArchive, decryptArchive, encryptArchiveStream, decryptArchiveStream } from './archive.mjs'

const passphrase = 'synthetic-disposable-passphrase-for-ci-only'
test('encrypted archive decrypts only with its passphrase and intact bytes', () => {
  const plain = Buffer.from('synthetic pg_dump bytes')
  const result = encryptArchive(plain, passphrase, { mode: 'synthetic-disposable' })
  assert.notDeepEqual(result.encrypted, plain)
  assert.deepEqual(decryptArchive(result.encrypted, passphrase, result), plain)
  assert.throws(() => decryptArchive(result.encrypted, passphrase, { ...result, mode: 'hosted' }), /synthetic-passphrase-forbidden/u)
  assert.throws(() => decryptArchive(result.encrypted, `${passphrase}-wrong`, result))
  assert.throws(() => decryptArchive(result.encrypted, passphrase, { ...result, authenticatedMetadata: { altered: true } }))
  assert.throws(() => decryptArchive(result.encrypted, passphrase, { ...result, encryption: { ...result.encryption, iv: '00' } }), /invalid-archive-metadata/u)
  const tampered = Buffer.from(result.encrypted)
  tampered[0] ^= 1
  assert.throws(() => decryptArchive(tampered, passphrase, result), /archive-hash-mismatch/u)
})

test('one-shot passphrase encryption requires synthetic mode', () => {
  assert.throws(() => encryptArchive(Buffer.from('data'), passphrase), /synthetic-passphrase-forbidden/u)
  assert.throws(() => encryptArchive(Buffer.from('data'), passphrase, { mode: 'hosted' }), /synthetic-passphrase-forbidden/u)
})

test('streaming X25519 encryption keeps the private key out of the backup side', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  const plaintext = Buffer.from('synthetic hosted-ready dump')
  const chunks = []
  const result = await encryptArchiveStream(Readable.from([plaintext]), async (chunk) => chunks.push(Buffer.from(chunk)), publicKey, { schemaVersion: 1, source: { database: 'synthetic' } })
  const encrypted = Buffer.concat(chunks)
  assert.equal(result.encryption.algorithm, 'x25519-aes-256-gcm')
  assert.equal(result.archiveSha256.length, 64)
  assert.equal(Object.hasOwn(result, 'privateKey'), false)
  const recovered = []
  const transaction = {
    staged: [],
    async write(chunk) { this.staged.push(Buffer.from(chunk)) },
    async commit() { recovered.push(...this.staged); this.staged = [] },
    async abort() { this.staged = [] },
  }
  await decryptArchiveStream(Readable.from([encrypted]), transaction, privateKey, result)
  assert.deepEqual(Buffer.concat(recovered), plaintext)
})

test('streaming decrypt aborts staged plaintext when the GCM tag is tampered', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  const chunks = []
  const result = await encryptArchiveStream(Readable.from([Buffer.from('synthetic authenticated text')]), (chunk) => chunks.push(Buffer.from(chunk)), publicKey, { mode: 'synthetic-proof' })
  const changedTag = Buffer.from(result.encryption.tag, 'base64')
  changedTag[0] ^= 1
  const tamperedManifest = { ...result, encryption: { ...result.encryption, tag: changedTag.toString('base64') } }
  const committed = []
  let aborted = false
  const transaction = {
    staged: [],
    async write(chunk) { this.staged.push(Buffer.from(chunk)) },
    async commit() { committed.push(...this.staged) },
    async abort() { aborted = true; this.staged = [] },
  }
  await assert.rejects(decryptArchiveStream(Readable.from(chunks), transaction, privateKey, tamperedManifest), /archive-authentication-failed/u)
  assert.equal(aborted, true)
  assert.deepEqual(committed, [])
  assert.deepEqual(transaction.staged, [])
})

test('streaming decrypt refuses a missing manifest digest before committing plaintext', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  const chunks = []
  const result = await encryptArchiveStream(Readable.from([Buffer.from('synthetic bytes')]),
    (chunk) => chunks.push(Buffer.from(chunk)), publicKey, { mode: 'synthetic-proof' })
  let committed = false
  const transaction = {
    async write() {},
    async commit() { committed = true },
    async abort() {},
  }
  await assert.rejects(decryptArchiveStream(Readable.from(chunks), transaction, privateKey,
    { ...result, archiveSha256: undefined }), /archive-hash-mismatch/u)
  assert.equal(committed, false)
})

test('streaming synthetic encryption accepts a dump larger than the former 64 MiB cap', async () => {
  const chunk = Buffer.alloc(1024 * 1024, 0x5a)
  const chunks = []
  const input = Readable.from((async function * () { for (let i = 0; i < 65; i++) yield chunk })())
  const result = await encryptArchiveStream(input, async (bytes) => chunks.push(Buffer.from(bytes)), { passphrase, mode: 'synthetic-disposable' }, { source: 'large-synthetic-fixture' })
  assert.equal(result.plaintextBytes, 65 * 1024 * 1024)
  assert.equal(result.archiveSha256.length, 64)
  assert.ok(chunks.reduce((size, bytes) => size + bytes.length, 0) > 64 * 1024 * 1024)
})

test('streaming encryption refuses a passphrase outside the synthetic mode', async () => {
  await assert.rejects(
    encryptArchiveStream(Readable.from([Buffer.from('synthetic fixture')]), () => {}, { passphrase, mode: 'hosted' }),
    /synthetic-passphrase-forbidden/u,
  )
})

test('streaming decrypt refuses synthetic passphrase under a hosted manifest', async () => {
  const chunks = []
  const result = await encryptArchiveStream(Readable.from([Buffer.from('synthetic fixture')]),
    (chunk) => chunks.push(Buffer.from(chunk)), { passphrase, mode: 'synthetic-disposable' },
    { mode: 'synthetic-disposable' })
  const transaction = { async write() {}, async commit() {}, async abort() {} }
  await assert.rejects(decryptArchiveStream(Readable.from(chunks), transaction, passphrase,
    { ...result, mode: 'hosted' }), /synthetic-passphrase-forbidden/u)
})
